import { digestRunDispatchLeaseToken, assertRunDispatchId } from '../run/runDispatchLease';
import { parseSecretRef } from '../secret/secretReference';
import { assertWorkerId, assertWorkerSessionId } from '../worker/workerSession';

export const REMOTE_SECRET_DELIVERY_SCHEMA =
  'qinglong/remote-secret-delivery@v1';
export const MAX_REMOTE_SECRET_DELIVERY_REFS = 64;
export const MAX_REMOTE_SECRET_DELIVERY_REQUEST_BYTES = 64 * 1024;
export const MAX_REMOTE_SECRET_DELIVERY_RESPONSE_BYTES = 128 * 1024;
export const MAX_REMOTE_SECRET_VALUE_BYTES = 16 * 1024;
export const MAX_REMOTE_SECRET_DELIVERY_TOTAL_VALUE_BYTES = 64 * 1024;

export interface RemoteWorkerSecretDeliveryCommand {
  readonly workerId: string;
  readonly workerSessionId: string;
  readonly workerGeneration: number;
  readonly runId: string;
  readonly attemptId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: string;
  readonly executionDigest: string;
  readonly offerId: string;
  readonly leaseGeneration: number;
  readonly leaseToken: string;
  readonly expectedLeaseVersion: number;
  readonly secretRefs: readonly string[];
}

export type RemoteWorkerSecretDeliveryRequestBody = Readonly<
  Omit<RemoteWorkerSecretDeliveryCommand, 'workerId' | 'workerSessionId'> & {
    readonly schema: typeof REMOTE_SECRET_DELIVERY_SCHEMA;
  }
>;

export interface RemoteWorkerSecretDeliveryAuthority {
  readonly workerId: string;
  readonly workerSessionId: string;
  readonly workerGeneration: number;
  readonly runId: string;
  readonly attemptId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: string;
  readonly executionDigest: string;
  readonly offerId: string;
  readonly leaseGeneration: number;
  readonly leaseVersion: number;
  readonly secretRefs: readonly string[];
}

export interface RemoteWorkerSecretValue {
  readonly secretRef: string;
  readonly value: string;
}

export interface RemoteWorkerSecretResolution {
  readonly values: readonly RemoteWorkerSecretValue[];
  readonly dispose?: () => Promise<void> | void;
}

export interface RemoteWorkerSecretDeliveryAuthorityRepository {
  authorize(
    command: RemoteWorkerSecretDeliveryCommand,
  ): Promise<Readonly<RemoteWorkerSecretDeliveryAuthority>>;
}

export interface RemoteWorkerSecretValueProvider {
  resolve(
    authority: Readonly<RemoteWorkerSecretDeliveryAuthority>,
  ): Promise<Readonly<RemoteWorkerSecretResolution> | undefined>;
}

export interface RemoteWorkerSecretDeliveryResult {
  readonly runId: string;
  readonly attemptId: string;
  readonly offerId: string;
  readonly executionDigest: string;
  readonly values: readonly RemoteWorkerSecretValue[];
  readonly dispose?: () => Promise<void> | void;
}

export type RemoteWorkerSecretDeliveryResponseBody = Readonly<
  Omit<RemoteWorkerSecretDeliveryResult, 'dispose'> & {
    readonly schema: typeof REMOTE_SECRET_DELIVERY_SCHEMA;
  }
>;

export class InvalidRemoteWorkerSecretDeliveryError extends TypeError {
  readonly code = 'REMOTE_SECRET_DELIVERY_INVALID';

  constructor(message: string) {
    super(`Remote Worker Secret delivery is invalid: ${message}`);
    this.name = 'InvalidRemoteWorkerSecretDeliveryError';
  }
}

export class RemoteWorkerSecretDeliveryFenceRejectedError extends Error {
  readonly code = 'REMOTE_SECRET_DELIVERY_FENCED';

  constructor(readonly reason: 'authority_mismatch' | 'secret_scope_mismatch') {
    super(`Remote Worker Secret delivery is fenced: ${reason}`);
    this.name = 'RemoteWorkerSecretDeliveryFenceRejectedError';
  }
}

export class RemoteWorkerSecretDeliveryUnavailableError extends Error {
  readonly code = 'REMOTE_SECRET_DELIVERY_UNAVAILABLE';

  constructor() {
    super('Remote Worker Secret delivery is unavailable');
    this.name = 'RemoteWorkerSecretDeliveryUnavailableError';
  }
}

function invalid(message: string): never {
  throw new InvalidRemoteWorkerSecretDeliveryError(message);
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

function positiveInteger(label: string, value: unknown, minimum = 1): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > 2_147_483_647
  ) return invalid(`${label} is invalid`);
  return value as number;
}

function normalizeSecretRefs(
  value: unknown,
  projectId: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_REMOTE_SECRET_DELIVERY_REFS
  ) return invalid('secretRefs are invalid');
  const seen = new Set<string>();
  const refs = value.map((entry) => {
    if (typeof entry !== 'string' || seen.has(entry)) {
      return invalid('secretRefs are invalid');
    }
    try {
      if (parseSecretRef(entry).projectId !== projectId) {
        return invalid('secretRef project is invalid');
      }
    } catch (error) {
      if (error instanceof InvalidRemoteWorkerSecretDeliveryError) throw error;
      return invalid('secretRef is invalid');
    }
    seen.add(entry);
    return entry;
  });
  return Object.freeze(refs);
}

export function normalizeRemoteWorkerSecretDeliveryCommand(
  value: RemoteWorkerSecretDeliveryCommand,
): Readonly<RemoteWorkerSecretDeliveryCommand> {
  const command = object(value, 'command');
  exactKeys(command, [
    'attemptId', 'executionDigest', 'expectedLeaseVersion', 'leaseGeneration',
    'leaseToken', 'offerId', 'projectId', 'runId', 'secretRefs', 'taskId',
    'taskRevision', 'workerGeneration', 'workerId', 'workerSessionId',
  ], 'command');
  try {
    assertWorkerId(command.workerId as string);
    assertWorkerSessionId(command.workerSessionId as string);
    assertRunDispatchId('runId', command.runId as string);
    assertRunDispatchId('attemptId', command.attemptId as string);
    assertRunDispatchId('offerId', command.offerId as string);
  } catch {
    return invalid('authority identifier is invalid');
  }
  const projectId = identifier('projectId', command.projectId);
  const normalized = Object.freeze({
    workerId: command.workerId as string,
    workerSessionId: command.workerSessionId as string,
    workerGeneration: positiveInteger('workerGeneration', command.workerGeneration),
    runId: command.runId as string,
    attemptId: command.attemptId as string,
    projectId,
    taskId: identifier('taskId', command.taskId),
    taskRevision: identifier('taskRevision', command.taskRevision),
    executionDigest: identifier('executionDigest', command.executionDigest, 64),
    offerId: command.offerId as string,
    leaseGeneration: positiveInteger('leaseGeneration', command.leaseGeneration),
    leaseToken: identifier('leaseToken', command.leaseToken, 128),
    expectedLeaseVersion: positiveInteger(
      'expectedLeaseVersion', command.expectedLeaseVersion, 0,
    ),
    secretRefs: normalizeSecretRefs(command.secretRefs, projectId),
  });
  if (!/^[0-9a-f]{64}$/.test(normalized.executionDigest)) {
    return invalid('executionDigest is invalid');
  }
  try {
    digestRunDispatchLeaseToken(normalized.leaseToken);
  } catch {
    return invalid('leaseToken is invalid');
  }
  return normalized;
}

export function normalizeRemoteWorkerSecretDeliveryAuthority(
  value: RemoteWorkerSecretDeliveryAuthority,
): Readonly<RemoteWorkerSecretDeliveryAuthority> {
  const authority = object(value, 'authority');
  exactKeys(authority, [
    'attemptId', 'executionDigest', 'leaseGeneration', 'leaseVersion',
    'offerId', 'projectId', 'runId', 'secretRefs', 'taskId', 'taskRevision',
    'workerGeneration', 'workerId', 'workerSessionId',
  ], 'authority');
  try {
    assertWorkerId(authority.workerId as string);
    assertWorkerSessionId(authority.workerSessionId as string);
    assertRunDispatchId('runId', authority.runId as string);
    assertRunDispatchId('attemptId', authority.attemptId as string);
    assertRunDispatchId('offerId', authority.offerId as string);
  } catch {
    return invalid('authority identifier is invalid');
  }
  const projectId = identifier('projectId', authority.projectId);
  const normalized = Object.freeze({
    workerId: authority.workerId as string,
    workerSessionId: authority.workerSessionId as string,
    workerGeneration: positiveInteger(
      'workerGeneration', authority.workerGeneration,
    ),
    runId: authority.runId as string,
    attemptId: authority.attemptId as string,
    projectId,
    taskId: identifier('taskId', authority.taskId),
    taskRevision: identifier('taskRevision', authority.taskRevision),
    executionDigest: identifier(
      'executionDigest', authority.executionDigest, 64,
    ),
    offerId: authority.offerId as string,
    leaseGeneration: positiveInteger(
      'leaseGeneration', authority.leaseGeneration,
    ),
    leaseVersion: positiveInteger('leaseVersion', authority.leaseVersion, 0),
    secretRefs: normalizeSecretRefs(authority.secretRefs, projectId),
  });
  if (!/^[0-9a-f]{64}$/.test(normalized.executionDigest)) {
    return invalid('executionDigest is invalid');
  }
  return normalized;
}

export function createRemoteWorkerSecretDeliveryRequestBody(
  command: RemoteWorkerSecretDeliveryCommand,
): RemoteWorkerSecretDeliveryRequestBody {
  const normalized = normalizeRemoteWorkerSecretDeliveryCommand(command);
  const { workerId: _workerId, workerSessionId: _sessionId, ...request } = normalized;
  return Object.freeze({ schema: REMOTE_SECRET_DELIVERY_SCHEMA, ...request });
}

function normalizeValues(
  value: unknown,
  expectedRefs: readonly string[],
): readonly RemoteWorkerSecretValue[] {
  if (!Array.isArray(value) || value.length !== expectedRefs.length) {
    return invalid('Secret values are invalid');
  }
  let totalValueBytes = 0;
  return Object.freeze(value.map((entry, index) => {
    const item = object(entry, `values[${index}]`);
    exactKeys(item, ['secretRef', 'value'], `values[${index}]`);
    if (
      item.secretRef !== expectedRefs[index] ||
      typeof item.value !== 'string' ||
      item.value.includes('\0') ||
      Buffer.byteLength(item.value, 'utf8') > MAX_REMOTE_SECRET_VALUE_BYTES
    ) return invalid(`values[${index}] is invalid`);
    totalValueBytes += Buffer.byteLength(item.value, 'utf8');
    if (totalValueBytes > MAX_REMOTE_SECRET_DELIVERY_TOTAL_VALUE_BYTES) {
      return invalid('Secret value byte budget exceeded');
    }
    return Object.freeze({
      secretRef: item.secretRef as string,
      value: item.value,
    });
  }));
}

export function createRemoteWorkerSecretDeliveryResponseBody(
  result: Readonly<RemoteWorkerSecretDeliveryResult>,
  expectedRefs: readonly string[],
): RemoteWorkerSecretDeliveryResponseBody {
  const value = object(result, 'result');
  const allowed = ['attemptId', 'dispose', 'executionDigest', 'offerId', 'runId', 'values'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    return invalid('result shape is invalid');
  }
  const runId = identifier('runId', value.runId, 36);
  const attemptId = identifier('attemptId', value.attemptId, 36);
  const offerId = identifier('offerId', value.offerId, 128);
  const executionDigest = identifier('executionDigest', value.executionDigest, 64);
  if (!/^[0-9a-f]{64}$/.test(executionDigest)) invalid('executionDigest is invalid');
  return Object.freeze({
    schema: REMOTE_SECRET_DELIVERY_SCHEMA,
    runId,
    attemptId,
    offerId,
    executionDigest,
    values: normalizeValues(value.values, expectedRefs),
  });
}

export function parseRemoteWorkerSecretDeliveryResponse(
  serialized: Uint8Array | string,
  expected: Readonly<{
    runId: string;
    attemptId: string;
    offerId: string;
    executionDigest: string;
    secretRefs: readonly string[];
  }>,
): Readonly<RemoteWorkerSecretDeliveryResult> {
  const bytes = typeof serialized === 'string'
    ? Buffer.from(serialized, 'utf8')
    : Buffer.from(serialized);
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > MAX_REMOTE_SECRET_DELIVERY_RESPONSE_BYTES
  ) return invalid('response byte size is outside the allowed range');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return invalid('response is not valid JSON');
  } finally {
    bytes.fill(0);
  }
  const response = object(parsed, 'response');
  exactKeys(response, [
    'attemptId', 'executionDigest', 'offerId', 'runId', 'schema', 'values',
  ], 'response');
  if (response.schema !== REMOTE_SECRET_DELIVERY_SCHEMA) {
    return invalid('response schema is invalid');
  }
  const result = createRemoteWorkerSecretDeliveryResponseBody({
    runId: response.runId as string,
    attemptId: response.attemptId as string,
    offerId: response.offerId as string,
    executionDigest: response.executionDigest as string,
    values: response.values as readonly RemoteWorkerSecretValue[],
  }, expected.secretRefs);
  if (
    result.runId !== expected.runId ||
    result.attemptId !== expected.attemptId ||
    result.offerId !== expected.offerId ||
    result.executionDigest !== expected.executionDigest
  ) return invalid('response authority does not match request');
  return Object.freeze({
    runId: result.runId,
    attemptId: result.attemptId,
    offerId: result.offerId,
    executionDigest: result.executionDigest,
    values: result.values,
  });
}
