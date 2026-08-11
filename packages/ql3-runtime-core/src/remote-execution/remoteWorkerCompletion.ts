import { assertRunDispatchId, digestRunDispatchLeaseToken } from '../run/runDispatchLease';
import { assertWorkerId, assertWorkerSessionId } from '../worker/workerSession';

export const REMOTE_WORKER_ARTIFACT_UPLOAD_SCHEMA =
  'qinglong/remote-worker-artifact-upload@v1';
export const REMOTE_WORKER_COMPLETION_SCHEMA =
  'qinglong/remote-worker-completion@v1';
export const REMOTE_WORKER_ARTIFACT_CONTENT_TYPE =
  'application/vnd.qinglong.worker-artifact';
export const MAX_REMOTE_WORKER_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_REMOTE_WORKER_ARTIFACT_HEADER_BYTES = 4 * 1024;
export const MAX_REMOTE_WORKER_ARTIFACT_RESPONSE_BYTES = 4 * 1024;
export const MAX_REMOTE_WORKER_COMPLETION_REQUEST_BYTES = 16 * 1024;
export const MAX_REMOTE_WORKER_COMPLETION_RESPONSE_BYTES = 4 * 1024;

const SHA256 = /^[a-f0-9]{64}$/;
const LOG_ARTIFACT_ID = /^wlog-[a-f0-9]{30}$/;
const UPLOAD_STATUSES = new Set(['stored', 'already_stored']);
const COMPLETION_STATUSES = new Set([
  'applied',
  'already_completed',
  'already_terminal',
]);

export interface RemoteWorkerExecutionFence {
  readonly workerId: string;
  readonly workerSessionId: string;
  readonly workerGeneration: number;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly offerId: string;
  readonly leaseGeneration: number;
  readonly leaseToken: string;
  readonly expectedLeaseVersion: number;
}

export interface RemoteWorkerArtifactUploadCommand
  extends RemoteWorkerExecutionFence {
  readonly logArtifactId: string;
  readonly byteLength: number;
  readonly truncated?: boolean;
}

export type RemoteWorkerArtifactUploadRequestHeader = Readonly<
  Omit<
    RemoteWorkerArtifactUploadCommand,
    'workerId' | 'workerSessionId' | 'truncated'
  > & {
    readonly schema: typeof REMOTE_WORKER_ARTIFACT_UPLOAD_SCHEMA;
    readonly truncated: boolean | null;
  }
>;

export interface RemoteWorkerArtifactReceipt {
  readonly status: 'stored' | 'already_stored';
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly logArtifactId: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly truncated?: boolean;
}

export type RemoteWorkerArtifactUploadResponseBody = Readonly<
  Omit<RemoteWorkerArtifactReceipt, 'truncated'> & {
    readonly schema: typeof REMOTE_WORKER_ARTIFACT_UPLOAD_SCHEMA;
    readonly truncated: boolean | null;
  }
>;

export interface RemoteWorkerCompletionCommand
  extends RemoteWorkerExecutionFence {
  readonly callbackSequence: number;
  readonly callbackTokenDigest: string;
  readonly result: Readonly<{
    readonly outcome: 'succeeded' | 'failed';
    readonly startedAtMs: number;
    readonly finishedAtMs: number;
    readonly exitCode: number;
  }>;
  readonly artifact: Readonly<{
    readonly logArtifactId: string;
    readonly byteLength: number;
    readonly sha256: string;
    readonly truncated?: boolean;
  }>;
}

export type RemoteWorkerCompletionRequestBody = Readonly<
  Omit<
    RemoteWorkerCompletionCommand,
    'workerId' | 'workerSessionId' | 'artifact'
  > & {
    readonly schema: typeof REMOTE_WORKER_COMPLETION_SCHEMA;
    readonly artifact: Readonly<
      Omit<RemoteWorkerCompletionCommand['artifact'], 'truncated'> & {
        readonly truncated: boolean | null;
      }
    >;
  }
>;

export interface RemoteWorkerCompletionResult {
  readonly status: 'applied' | 'already_completed' | 'already_terminal';
  readonly runId: string;
  readonly attemptId: string;
  readonly callbackSequence: number;
}

export type RemoteWorkerCompletionResponseBody = Readonly<
  RemoteWorkerCompletionResult & {
    readonly schema: typeof REMOTE_WORKER_COMPLETION_SCHEMA;
  }
>;

export interface RemoteWorkerArtifactUploadAuthorityRepository {
  authorizeArtifactUpload(
    command: RemoteWorkerArtifactUploadCommand,
  ): Promise<void>;
}

export interface RemoteWorkerCompletionRepository {
  complete(
    command: RemoteWorkerCompletionCommand & Readonly<{
      attemptEventId: string;
      runEventId: string;
    }>,
  ): Promise<Readonly<RemoteWorkerCompletionResult>>;
}

export class InvalidRemoteWorkerCompletionError extends TypeError {
  readonly code = 'REMOTE_WORKER_COMPLETION_INVALID';

  constructor(message: string) {
    super(`Remote Worker completion is invalid: ${message}`);
    this.name = 'InvalidRemoteWorkerCompletionError';
  }
}

export class RemoteWorkerCompletionFenceRejectedError extends Error {
  readonly code = 'REMOTE_WORKER_COMPLETION_FENCED';

  constructor(
    readonly attemptId: string,
    readonly reason:
      | 'missing'
      | 'worker_unavailable'
      | 'authority_mismatch'
      | 'lease_expired'
      | 'state_mismatch'
      | 'replay_mismatch',
  ) {
    super(`Remote Worker completion is fenced: ${reason}`);
    this.name = 'RemoteWorkerCompletionFenceRejectedError';
  }
}

export class RemoteWorkerCompletionUnavailableError extends Error {
  readonly code = 'REMOTE_WORKER_COMPLETION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Remote Worker completion is unavailable', options);
    this.name = 'RemoteWorkerCompletionUnavailableError';
  }
}

function invalid(message: string): never {
  throw new InvalidRemoteWorkerCompletionError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  ) invalid(`${label} shape is invalid`);
}

function identifier(label: string, value: unknown, maximum = 128): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) return invalid(`${label} is invalid`);
  return value;
}

function integer(
  label: string,
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) return invalid(`${label} is invalid`);
  return value as number;
}

function nullableBoolean(
  label: string,
  value: unknown,
): boolean | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'boolean') return invalid(`${label} is invalid`);
  return value;
}

function fence(
  value: Record<string, unknown>,
): Readonly<RemoteWorkerExecutionFence> {
  try {
    assertWorkerId(value.workerId as string);
    assertWorkerSessionId(value.workerSessionId as string);
    assertRunDispatchId('runId', value.runId as string);
    assertRunDispatchId('attemptId', value.attemptId as string);
    assertRunDispatchId('offerId', value.offerId as string);
    digestRunDispatchLeaseToken(value.leaseToken as string);
  } catch {
    return invalid('execution authority is invalid');
  }
  return Object.freeze({
    workerId: value.workerId as string,
    workerSessionId: value.workerSessionId as string,
    workerGeneration: integer(
      'workerGeneration', value.workerGeneration, 1, 2_147_483_647,
    ),
    projectId: identifier('projectId', value.projectId),
    runId: value.runId as string,
    attemptId: value.attemptId as string,
    offerId: value.offerId as string,
    leaseGeneration: integer(
      'leaseGeneration', value.leaseGeneration, 1, 2_147_483_647,
    ),
    leaseToken: value.leaseToken as string,
    expectedLeaseVersion: integer(
      'expectedLeaseVersion', value.expectedLeaseVersion, 0, 2_147_483_647,
    ),
  });
}

const FENCE_KEYS = [
  'workerId', 'workerSessionId', 'workerGeneration', 'projectId', 'runId',
  'attemptId', 'offerId', 'leaseGeneration', 'leaseToken',
  'expectedLeaseVersion',
] as const;

export function normalizeRemoteWorkerArtifactUploadCommand(
  value: RemoteWorkerArtifactUploadCommand,
): Readonly<RemoteWorkerArtifactUploadCommand> {
  const command = object(value, 'Artifact upload command');
  const required = [...FENCE_KEYS, 'logArtifactId', 'byteLength'];
  const keys = Object.keys(command);
  if (
    required.some((key) => !Object.hasOwn(command, key)) ||
    keys.some((key) => ![...required, 'truncated'].includes(key))
  ) return invalid('Artifact upload command shape is invalid');
  const authority = fence(command);
  const logArtifactId = identifier('logArtifactId', command.logArtifactId, 36);
  if (!LOG_ARTIFACT_ID.test(logArtifactId)) {
    return invalid('logArtifactId is invalid');
  }
  if (
    command.truncated !== undefined &&
    typeof command.truncated !== 'boolean'
  ) return invalid('truncated is invalid');
  return Object.freeze({
    ...authority,
    logArtifactId,
    byteLength: integer(
      'byteLength', command.byteLength, 0, MAX_REMOTE_WORKER_ARTIFACT_BYTES,
    ),
    ...(command.truncated === undefined
      ? {}
      : { truncated: command.truncated as boolean }),
  });
}

export function createRemoteWorkerArtifactUploadRequestHeader(
  command: RemoteWorkerArtifactUploadCommand,
): RemoteWorkerArtifactUploadRequestHeader {
  const value = normalizeRemoteWorkerArtifactUploadCommand(command);
  const { workerId: _workerId, workerSessionId: _sessionId, ...body } = value;
  return Object.freeze({
    schema: REMOTE_WORKER_ARTIFACT_UPLOAD_SCHEMA,
    ...body,
    truncated: value.truncated ?? null,
  });
}

export function createRemoteWorkerArtifactUploadPreamble(
  command: RemoteWorkerArtifactUploadCommand,
): Buffer {
  const serialized = Buffer.from(JSON.stringify(
    createRemoteWorkerArtifactUploadRequestHeader(command),
  ), 'utf8');
  if (
    serialized.byteLength < 2 ||
    serialized.byteLength > MAX_REMOTE_WORKER_ARTIFACT_HEADER_BYTES
  ) {
    serialized.fill(0);
    return invalid('Artifact upload header exceeds its byte limit');
  }
  const result = Buffer.allocUnsafe(4 + serialized.byteLength);
  result.writeUInt32BE(serialized.byteLength, 0);
  serialized.copy(result, 4);
  serialized.fill(0);
  return result;
}

export function parseRemoteWorkerArtifactUploadHeader(
  serialized: Uint8Array | string,
  pathAuthority: Readonly<{ workerId: string; workerSessionId: string }>,
): Readonly<RemoteWorkerArtifactUploadCommand> {
  const bytes = typeof serialized === 'string'
    ? Buffer.from(serialized, 'utf8')
    : Buffer.from(serialized);
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > MAX_REMOTE_WORKER_ARTIFACT_HEADER_BYTES
  ) return invalid('Artifact upload header byte size is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return invalid('Artifact upload header is not valid JSON');
  }
  const header = object(parsed, 'Artifact upload header');
  exactKeys(header, [
    'schema', 'workerGeneration', 'projectId', 'runId', 'attemptId',
    'offerId', 'leaseGeneration', 'leaseToken', 'expectedLeaseVersion',
    'logArtifactId', 'byteLength', 'truncated',
  ], 'Artifact upload header');
  if (header.schema !== REMOTE_WORKER_ARTIFACT_UPLOAD_SCHEMA) {
    return invalid('Artifact upload schema is invalid');
  }
  return normalizeRemoteWorkerArtifactUploadCommand({
    workerId: pathAuthority.workerId,
    workerSessionId: pathAuthority.workerSessionId,
    workerGeneration: header.workerGeneration as number,
    projectId: header.projectId as string,
    runId: header.runId as string,
    attemptId: header.attemptId as string,
    offerId: header.offerId as string,
    leaseGeneration: header.leaseGeneration as number,
    leaseToken: header.leaseToken as string,
    expectedLeaseVersion: header.expectedLeaseVersion as number,
    logArtifactId: header.logArtifactId as string,
    byteLength: header.byteLength as number,
    ...(nullableBoolean('truncated', header.truncated) === undefined
      ? {}
      : { truncated: header.truncated as boolean }),
  });
}

export function normalizeRemoteWorkerArtifactReceipt(
  value: RemoteWorkerArtifactReceipt,
): Readonly<RemoteWorkerArtifactReceipt> {
  const receipt = object(value, 'Artifact receipt');
  const required = [
    'status', 'projectId', 'runId', 'attemptId', 'logArtifactId',
    'byteLength', 'sha256',
  ];
  const keys = Object.keys(receipt);
  if (
    required.some((key) => !Object.hasOwn(receipt, key)) ||
    keys.some((key) => ![...required, 'truncated'].includes(key)) ||
    typeof receipt.status !== 'string' ||
    !UPLOAD_STATUSES.has(receipt.status)
  ) return invalid('Artifact receipt shape is invalid');
  try {
    assertRunDispatchId('runId', receipt.runId as string);
    assertRunDispatchId('attemptId', receipt.attemptId as string);
  } catch {
    return invalid('Artifact receipt authority is invalid');
  }
  const logArtifactId = identifier('logArtifactId', receipt.logArtifactId, 36);
  if (!LOG_ARTIFACT_ID.test(logArtifactId)) {
    return invalid('Artifact receipt identity is invalid');
  }
  const sha256 = identifier('sha256', receipt.sha256, 64);
  if (!SHA256.test(sha256)) return invalid('Artifact receipt digest is invalid');
  if (
    receipt.truncated !== undefined &&
    typeof receipt.truncated !== 'boolean'
  ) return invalid('Artifact receipt truncation is invalid');
  return Object.freeze({
    status: receipt.status as RemoteWorkerArtifactReceipt['status'],
    projectId: identifier('projectId', receipt.projectId),
    runId: receipt.runId as string,
    attemptId: receipt.attemptId as string,
    logArtifactId,
    byteLength: integer(
      'byteLength', receipt.byteLength, 0, MAX_REMOTE_WORKER_ARTIFACT_BYTES,
    ),
    sha256,
    ...(receipt.truncated === undefined
      ? {}
      : { truncated: receipt.truncated as boolean }),
  });
}

export function createRemoteWorkerArtifactUploadResponseBody(
  receipt: RemoteWorkerArtifactReceipt,
): RemoteWorkerArtifactUploadResponseBody {
  const value = normalizeRemoteWorkerArtifactReceipt(receipt);
  return Object.freeze({
    schema: REMOTE_WORKER_ARTIFACT_UPLOAD_SCHEMA,
    ...value,
    truncated: value.truncated ?? null,
  });
}

export function parseRemoteWorkerArtifactUploadResponse(
  serialized: Uint8Array | string,
): Readonly<RemoteWorkerArtifactReceipt> {
  const bytes = typeof serialized === 'string'
    ? Buffer.from(serialized, 'utf8')
    : Buffer.from(serialized);
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > MAX_REMOTE_WORKER_ARTIFACT_RESPONSE_BYTES
  ) return invalid('Artifact response byte size is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return invalid('Artifact response is not valid JSON');
  }
  const response = object(parsed, 'Artifact response');
  exactKeys(response, [
    'schema', 'status', 'projectId', 'runId', 'attemptId', 'logArtifactId',
    'byteLength', 'sha256', 'truncated',
  ], 'Artifact response');
  if (response.schema !== REMOTE_WORKER_ARTIFACT_UPLOAD_SCHEMA) {
    return invalid('Artifact response schema is invalid');
  }
  const truncated = nullableBoolean('truncated', response.truncated);
  return normalizeRemoteWorkerArtifactReceipt({
    status: response.status as RemoteWorkerArtifactReceipt['status'],
    projectId: response.projectId as string,
    runId: response.runId as string,
    attemptId: response.attemptId as string,
    logArtifactId: response.logArtifactId as string,
    byteLength: response.byteLength as number,
    sha256: response.sha256 as string,
    ...(truncated === undefined ? {} : { truncated }),
  });
}

export function normalizeRemoteWorkerCompletionCommand(
  value: RemoteWorkerCompletionCommand,
): Readonly<RemoteWorkerCompletionCommand> {
  const command = object(value, 'completion command');
  exactKeys(command, [
    ...FENCE_KEYS, 'callbackSequence', 'callbackTokenDigest', 'result',
    'artifact',
  ], 'completion command');
  const authority = fence(command);
  const result = object(command.result, 'completion result');
  exactKeys(result, [
    'outcome', 'startedAtMs', 'finishedAtMs', 'exitCode',
  ], 'completion result');
  if (
    result.outcome !== 'succeeded' &&
    result.outcome !== 'failed'
  ) return invalid('completion outcome is invalid');
  const startedAtMs = integer('startedAtMs', result.startedAtMs);
  const finishedAtMs = integer('finishedAtMs', result.finishedAtMs);
  const exitCode = integer('exitCode', result.exitCode, 0, 255);
  if (
    finishedAtMs < startedAtMs ||
    (result.outcome === 'succeeded') !== (exitCode === 0)
  ) return invalid('completion result is inconsistent');
  const artifact = object(command.artifact, 'completion Artifact');
  const requiredArtifact = ['logArtifactId', 'byteLength', 'sha256'];
  const artifactKeys = Object.keys(artifact);
  if (
    requiredArtifact.some((key) => !Object.hasOwn(artifact, key)) ||
    artifactKeys.some((key) => ![...requiredArtifact, 'truncated'].includes(key))
  ) return invalid('completion Artifact shape is invalid');
  const logArtifactId = identifier('logArtifactId', artifact.logArtifactId, 36);
  const sha256 = identifier('sha256', artifact.sha256, 64);
  const callbackTokenDigest = identifier(
    'callbackTokenDigest', command.callbackTokenDigest, 64,
  );
  if (
    !LOG_ARTIFACT_ID.test(logArtifactId) ||
    !SHA256.test(sha256) ||
    !SHA256.test(callbackTokenDigest) ||
    (artifact.truncated !== undefined &&
      typeof artifact.truncated !== 'boolean')
  ) return invalid('completion evidence is invalid');
  return Object.freeze({
    ...authority,
    callbackSequence: integer(
      'callbackSequence', command.callbackSequence, 1, 2_147_483_647,
    ),
    callbackTokenDigest,
    result: Object.freeze({
      outcome: result.outcome as 'succeeded' | 'failed',
      startedAtMs,
      finishedAtMs,
      exitCode,
    }),
    artifact: Object.freeze({
      logArtifactId,
      byteLength: integer(
        'byteLength', artifact.byteLength, 0, MAX_REMOTE_WORKER_ARTIFACT_BYTES,
      ),
      sha256,
      ...(artifact.truncated === undefined
        ? {}
        : { truncated: artifact.truncated as boolean }),
    }),
  });
}

export function createRemoteWorkerCompletionRequestBody(
  command: RemoteWorkerCompletionCommand,
): RemoteWorkerCompletionRequestBody {
  const value = normalizeRemoteWorkerCompletionCommand(command);
  const { workerId: _workerId, workerSessionId: _sessionId, ...body } = value;
  return Object.freeze({
    schema: REMOTE_WORKER_COMPLETION_SCHEMA,
    ...body,
    artifact: Object.freeze({
      ...value.artifact,
      truncated: value.artifact.truncated ?? null,
    }),
  });
}

export function parseRemoteWorkerCompletionRequestBody(
  value: unknown,
  pathAuthority: Readonly<{ workerId: string; workerSessionId: string }>,
): Readonly<RemoteWorkerCompletionCommand> {
  const body = object(value, 'completion request');
  exactKeys(body, [
    'schema', 'workerGeneration', 'projectId', 'runId', 'attemptId',
    'offerId', 'leaseGeneration', 'leaseToken', 'expectedLeaseVersion',
    'callbackSequence', 'callbackTokenDigest', 'result', 'artifact',
  ], 'completion request');
  if (body.schema !== REMOTE_WORKER_COMPLETION_SCHEMA) {
    return invalid('completion schema is invalid');
  }
  const artifact = object(body.artifact, 'completion Artifact');
  exactKeys(artifact, [
    'logArtifactId', 'byteLength', 'sha256', 'truncated',
  ], 'completion Artifact');
  const truncated = nullableBoolean('truncated', artifact.truncated);
  return normalizeRemoteWorkerCompletionCommand({
    workerId: pathAuthority.workerId,
    workerSessionId: pathAuthority.workerSessionId,
    workerGeneration: body.workerGeneration as number,
    projectId: body.projectId as string,
    runId: body.runId as string,
    attemptId: body.attemptId as string,
    offerId: body.offerId as string,
    leaseGeneration: body.leaseGeneration as number,
    leaseToken: body.leaseToken as string,
    expectedLeaseVersion: body.expectedLeaseVersion as number,
    callbackSequence: body.callbackSequence as number,
    callbackTokenDigest: body.callbackTokenDigest as string,
    result: body.result as RemoteWorkerCompletionCommand['result'],
    artifact: {
      logArtifactId: artifact.logArtifactId as string,
      byteLength: artifact.byteLength as number,
      sha256: artifact.sha256 as string,
      ...(truncated === undefined ? {} : { truncated }),
    },
  });
}

export function normalizeRemoteWorkerCompletionResult(
  value: RemoteWorkerCompletionResult,
): Readonly<RemoteWorkerCompletionResult> {
  const result = object(value, 'completion response');
  exactKeys(result, [
    'status', 'runId', 'attemptId', 'callbackSequence',
  ], 'completion response');
  if (
    typeof result.status !== 'string' ||
    !COMPLETION_STATUSES.has(result.status)
  ) return invalid('completion response status is invalid');
  try {
    assertRunDispatchId('runId', result.runId as string);
    assertRunDispatchId('attemptId', result.attemptId as string);
  } catch {
    return invalid('completion response authority is invalid');
  }
  return Object.freeze({
    status: result.status as RemoteWorkerCompletionResult['status'],
    runId: result.runId as string,
    attemptId: result.attemptId as string,
    callbackSequence: integer(
      'callbackSequence', result.callbackSequence, 1, 2_147_483_647,
    ),
  });
}

export function createRemoteWorkerCompletionResponseBody(
  value: RemoteWorkerCompletionResult,
): RemoteWorkerCompletionResponseBody {
  return Object.freeze({
    schema: REMOTE_WORKER_COMPLETION_SCHEMA,
    ...normalizeRemoteWorkerCompletionResult(value),
  });
}

export function parseRemoteWorkerCompletionResponse(
  serialized: Uint8Array | string,
): Readonly<RemoteWorkerCompletionResult> {
  const bytes = typeof serialized === 'string'
    ? Buffer.from(serialized, 'utf8')
    : Buffer.from(serialized);
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > MAX_REMOTE_WORKER_COMPLETION_RESPONSE_BYTES
  ) return invalid('completion response byte size is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return invalid('completion response is not valid JSON');
  }
  const response = object(parsed, 'completion response envelope');
  exactKeys(response, [
    'schema', 'status', 'runId', 'attemptId', 'callbackSequence',
  ], 'completion response envelope');
  if (response.schema !== REMOTE_WORKER_COMPLETION_SCHEMA) {
    return invalid('completion response schema is invalid');
  }
  return normalizeRemoteWorkerCompletionResult({
    status: response.status as RemoteWorkerCompletionResult['status'],
    runId: response.runId as string,
    attemptId: response.attemptId as string,
    callbackSequence: response.callbackSequence as number,
  });
}
