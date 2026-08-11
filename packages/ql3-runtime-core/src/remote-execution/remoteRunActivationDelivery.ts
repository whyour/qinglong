import { RUN_ATTEMPT_STATUSES, RUN_STATUSES } from '../run/run';
import type {
  RemoteRunActivationResult,
  RemoteRunActivationSnapshot,
  RemoteRunActivationStatus,
} from './remoteRunActivation';
import { assertRunDispatchId } from '../run/runDispatchLease';

export const REMOTE_RUN_ACTIVATION_DELIVERY_SCHEMA =
  'qinglong/remote-run-activation@v1';
export const MAX_REMOTE_RUN_ACTIVATION_RESPONSE_BYTES = 16 * 1024;

export type RemoteRunActivationResponseBody = Readonly<{
  schema: typeof REMOTE_RUN_ACTIVATION_DELIVERY_SCHEMA;
  status: RemoteRunActivationStatus;
  snapshot: Readonly<RemoteRunActivationSnapshot>;
}>;

export class InvalidRemoteRunActivationDeliveryError extends TypeError {
  readonly code = 'REMOTE_RUN_ACTIVATION_DELIVERY_INVALID';

  constructor(message: string) {
    super(`Remote Run activation delivery is invalid: ${message}`);
    this.name = 'InvalidRemoteRunActivationDeliveryError';
  }
}

const ACTIVATION_STATUSES = new Set<RemoteRunActivationStatus>([
  'applied',
  'already_starting',
  'already_running',
  'already_terminal',
]);
const REQUIRED_SNAPSHOT_KEYS = [
  'runId',
  'attemptId',
  'runStatus',
  'attemptStatus',
  'leaseVersion',
  'leaseGeneration',
  'callbackSequence',
] as const;
const OPTIONAL_SNAPSHOT_KEYS = [
  'deadlineAtMs',
  'startedAtMs',
  'finishedAtMs',
  'executorHandle',
  'logArtifactId',
  'errorCode',
] as const;
const SNAPSHOT_KEYS = new Set<string>([
  ...REQUIRED_SNAPSHOT_KEYS,
  ...OPTIONAL_SNAPSHOT_KEYS,
]);

function invalid(message: string): never {
  throw new InvalidRemoteRunActivationDeliveryError(message);
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
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function boundedId(label: string, value: unknown, maximum: number): string {
  if (typeof value !== 'string') return invalid(`${label} is invalid`);
  try {
    assertRunDispatchId(label, value);
  } catch {
    return invalid(`${label} is invalid`);
  }
  if (value.length > maximum) return invalid(`${label} is invalid`);
  return value;
}

function boundedInteger(
  label: string,
  value: unknown,
  maximum = 2_147_483_647,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function boundedText(label: string, value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function normalizeSnapshot(value: unknown): Readonly<RemoteRunActivationSnapshot> {
  const snapshot = object(value, 'snapshot');
  const keys = Object.keys(snapshot);
  if (
    REQUIRED_SNAPSHOT_KEYS.some((key) => !Object.hasOwn(snapshot, key)) ||
    keys.some((key) => !SNAPSHOT_KEYS.has(key))
  ) {
    return invalid('snapshot shape is invalid');
  }
  if (
    typeof snapshot.runStatus !== 'string' ||
    !RUN_STATUSES.includes(snapshot.runStatus as never) ||
    typeof snapshot.attemptStatus !== 'string' ||
    !RUN_ATTEMPT_STATUSES.includes(snapshot.attemptStatus as never)
  ) {
    return invalid('snapshot status is invalid');
  }
  const normalized: RemoteRunActivationSnapshot = {
    runId: boundedId('runId', snapshot.runId, 36),
    attemptId: boundedId('attemptId', snapshot.attemptId, 36),
    runStatus: snapshot.runStatus as RemoteRunActivationSnapshot['runStatus'],
    attemptStatus:
      snapshot.attemptStatus as RemoteRunActivationSnapshot['attemptStatus'],
    leaseVersion: boundedInteger('leaseVersion', snapshot.leaseVersion),
    leaseGeneration: boundedInteger(
      'leaseGeneration',
      snapshot.leaseGeneration,
    ),
    callbackSequence: boundedInteger(
      'callbackSequence',
      snapshot.callbackSequence,
    ),
    ...(snapshot.deadlineAtMs === undefined
      ? {}
      : { deadlineAtMs: boundedInteger('deadlineAtMs', snapshot.deadlineAtMs, Number.MAX_SAFE_INTEGER) }),
    ...(snapshot.startedAtMs === undefined
      ? {}
      : { startedAtMs: boundedInteger('startedAtMs', snapshot.startedAtMs, Number.MAX_SAFE_INTEGER) }),
    ...(snapshot.finishedAtMs === undefined
      ? {}
      : { finishedAtMs: boundedInteger('finishedAtMs', snapshot.finishedAtMs, Number.MAX_SAFE_INTEGER) }),
    ...(snapshot.executorHandle === undefined
      ? {}
      : { executorHandle: boundedText('executorHandle', snapshot.executorHandle, 512) }),
    ...(snapshot.logArtifactId === undefined
      ? {}
      : { logArtifactId: boundedId('logArtifactId', snapshot.logArtifactId, 36) }),
    ...(snapshot.errorCode === undefined
      ? {}
      : { errorCode: boundedText('errorCode', snapshot.errorCode, 128) }),
  };
  return Object.freeze(normalized);
}

function normalizeResult(value: unknown): Readonly<RemoteRunActivationResult> {
  const result = object(value, 'result');
  exactKeys(result, ['status', 'snapshot'], 'result');
  if (
    typeof result.status !== 'string' ||
    !ACTIVATION_STATUSES.has(result.status as RemoteRunActivationStatus)
  ) {
    return invalid('status is invalid');
  }
  const normalized = Object.freeze({
    status: result.status as RemoteRunActivationStatus,
    snapshot: normalizeSnapshot(result.snapshot),
  });
  const snapshot = normalized.snapshot;
  const starting = snapshot.runStatus === 'dispatching' &&
    snapshot.attemptStatus === 'starting' &&
    snapshot.executorHandle === undefined &&
    snapshot.startedAtMs === undefined &&
    snapshot.finishedAtMs === undefined &&
    snapshot.errorCode === undefined;
  const running = snapshot.runStatus === 'running' &&
    snapshot.attemptStatus === 'running' &&
    snapshot.executorHandle !== undefined &&
    snapshot.startedAtMs !== undefined &&
    snapshot.finishedAtMs === undefined &&
    snapshot.errorCode === undefined;
  const terminalStatus = snapshot.runStatus === snapshot.attemptStatus &&
    ['failed', 'cancelled', 'timed_out'].includes(snapshot.runStatus);
  const terminal = terminalStatus &&
    snapshot.executorHandle === undefined &&
    snapshot.startedAtMs === undefined &&
    snapshot.finishedAtMs !== undefined &&
    snapshot.errorCode !== undefined;
  if (!starting && !running && !terminal) {
    return invalid('snapshot state is invalid');
  }
  if (
    (normalized.status === 'already_starting' && !starting) ||
    (normalized.status === 'already_running' && !running) ||
    (normalized.status === 'already_terminal' && !terminal)
  ) {
    return invalid('status and snapshot state disagree');
  }
  return normalized;
}

export function createRemoteRunActivationResponseBody(
  result: Readonly<RemoteRunActivationResult>,
): RemoteRunActivationResponseBody {
  const normalized = normalizeResult(result);
  return Object.freeze({
    schema: REMOTE_RUN_ACTIVATION_DELIVERY_SCHEMA,
    status: normalized.status,
    snapshot: normalized.snapshot,
  });
}

export function parseRemoteRunActivationResponse(
  serialized: Uint8Array | string,
): Readonly<RemoteRunActivationResult> {
  const bytes = typeof serialized === 'string'
    ? Buffer.from(serialized, 'utf8')
    : Buffer.from(serialized);
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > MAX_REMOTE_RUN_ACTIVATION_RESPONSE_BYTES
  ) {
    return invalid('response byte size is outside the allowed range');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return invalid('response is not valid JSON');
  }
  const response = object(parsed, 'response');
  exactKeys(response, ['schema', 'status', 'snapshot'], 'response');
  if (response.schema !== REMOTE_RUN_ACTIVATION_DELIVERY_SCHEMA) {
    return invalid('response schema is invalid');
  }
  return normalizeResult({
    status: response.status,
    snapshot: response.snapshot,
  });
}
