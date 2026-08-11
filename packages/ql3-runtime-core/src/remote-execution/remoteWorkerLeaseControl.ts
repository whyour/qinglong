import {
  assertRunDispatchId,
  assertRunDispatchLeaseDuration,
  assertRunDispatchLeaseFence,
  type RunDispatchLeaseFenceReason,
} from '../run/runDispatchLease';
import { assertWorkerId, assertWorkerSessionId } from '../worker/workerSession';

export const REMOTE_WORKER_LEASE_CONTROL_SCHEMA =
  'qinglong/remote-worker-lease-control@v1';
export const MAX_REMOTE_WORKER_LEASE_CONTROL_REQUEST_BYTES = 8 * 1024;
export const MAX_REMOTE_WORKER_LEASE_CONTROL_RESPONSE_BYTES = 4 * 1024;

export const REMOTE_WORKER_STOP_REASONS = [
  'user', 'policy', 'shutdown', 'reconcile', 'timeout',
] as const;
export type RemoteWorkerStopReason =
  (typeof REMOTE_WORKER_STOP_REASONS)[number];

export const REMOTE_WORKER_TERMINAL_STATUSES = [
  'succeeded', 'failed', 'cancelled', 'timed_out', 'lost',
] as const;
export type RemoteWorkerTerminalStatus =
  (typeof REMOTE_WORKER_TERMINAL_STATUSES)[number];

export interface RemoteWorkerLeaseControlCommand {
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

export type RemoteWorkerLeaseControlRequestBody = Readonly<
  Omit<RemoteWorkerLeaseControlCommand, 'workerId' | 'workerSessionId'> & {
    readonly schema: typeof REMOTE_WORKER_LEASE_CONTROL_SCHEMA;
  }
>;

export type RemoteWorkerLeaseControlResult = Readonly<{
  readonly status: 'renewed' | 'stop_requested' | 'terminal';
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly offerId: string;
  readonly leaseGeneration: number;
  readonly leaseVersion?: number;
  readonly renewedAtMs?: number;
  readonly expiresAtMs?: number;
  readonly stop?: Readonly<{
    readonly reason: RemoteWorkerStopReason;
    readonly requestedAtMs: number;
  }>;
  readonly terminalStatus?: RemoteWorkerTerminalStatus;
}>;

export type RemoteWorkerLeaseControlResponseBody = Readonly<{
  readonly schema: typeof REMOTE_WORKER_LEASE_CONTROL_SCHEMA;
  readonly status: RemoteWorkerLeaseControlResult['status'];
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly offerId: string;
  readonly leaseGeneration: number;
  readonly leaseVersion: number | null;
  readonly renewedAtMs: number | null;
  readonly expiresAtMs: number | null;
  readonly stop: Readonly<{
    readonly reason: RemoteWorkerStopReason;
    readonly requestedAtMs: number;
  }> | null;
  readonly terminalStatus: RemoteWorkerTerminalStatus | null;
}>;

export interface RemoteWorkerLeaseControlRepository {
  control(
    command: RemoteWorkerLeaseControlCommand & Readonly<{
      leaseDurationMs: number;
      timeoutEventId: string;
    }>,
  ): Promise<Readonly<RemoteWorkerLeaseControlResult>>;
}

export class InvalidRemoteWorkerLeaseControlError extends TypeError {
  readonly code = 'REMOTE_WORKER_LEASE_CONTROL_INVALID';

  constructor(message: string) {
    super(`Remote Worker lease control is invalid: ${message}`);
    this.name = 'InvalidRemoteWorkerLeaseControlError';
  }
}

export class RemoteWorkerLeaseControlFenceRejectedError extends Error {
  readonly code = 'REMOTE_WORKER_LEASE_CONTROL_FENCED';

  constructor(
    readonly attemptId: string,
    readonly reason:
      | RunDispatchLeaseFenceReason
      | 'project_mismatch'
      | 'execution_owner_mismatch'
      | 'executor_mismatch'
      | 'offer_mismatch'
      | 'state_mismatch',
  ) {
    super(`Remote Worker lease control is fenced: ${reason}`);
    this.name = 'RemoteWorkerLeaseControlFenceRejectedError';
  }
}

export class RemoteWorkerLeaseControlUnavailableError extends Error {
  readonly code = 'REMOTE_WORKER_LEASE_CONTROL_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Remote Worker lease control is unavailable', options);
    this.name = 'RemoteWorkerLeaseControlUnavailableError';
  }
}

function invalid(message: string): never {
  throw new InvalidRemoteWorkerLeaseControlError(message);
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
  ) return invalid(`${label} shape is invalid`);
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

function identifier(label: string, value: unknown, maximum = 128): string {
  if (
    typeof value !== 'string' || value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) return invalid(`${label} is invalid`);
  return value;
}

export function normalizeRemoteWorkerLeaseControlCommand(
  value: RemoteWorkerLeaseControlCommand,
): Readonly<RemoteWorkerLeaseControlCommand> {
  const command = object(value, 'lease control command');
  exactKeys(command, [
    'workerId', 'workerSessionId', 'workerGeneration', 'projectId', 'runId',
    'attemptId', 'offerId', 'leaseGeneration', 'leaseToken',
    'expectedLeaseVersion',
  ], 'lease control command');
  try {
    assertWorkerId(command.workerId as string);
    assertWorkerSessionId(command.workerSessionId as string);
    assertRunDispatchId('runId', command.runId as string);
    assertRunDispatchId('attemptId', command.attemptId as string);
    assertRunDispatchId('offerId', command.offerId as string);
    assertRunDispatchLeaseFence({
      workerId: command.workerId as string,
      workerSessionId: command.workerSessionId as string,
      workerGeneration: command.workerGeneration as number,
      leaseGeneration: command.leaseGeneration as number,
      leaseToken: command.leaseToken as string,
      expectedVersion: command.expectedLeaseVersion as number,
    });
  } catch {
    return invalid('lease control authority is invalid');
  }
  return Object.freeze({
    workerId: command.workerId as string,
    workerSessionId: command.workerSessionId as string,
    workerGeneration: integer(
      'workerGeneration', command.workerGeneration, 1, 2_147_483_647,
    ),
    projectId: identifier('projectId', command.projectId),
    runId: command.runId as string,
    attemptId: command.attemptId as string,
    offerId: command.offerId as string,
    leaseGeneration: integer(
      'leaseGeneration', command.leaseGeneration, 1, 2_147_483_647,
    ),
    leaseToken: command.leaseToken as string,
    expectedLeaseVersion: integer(
      'expectedLeaseVersion', command.expectedLeaseVersion,
      0, 2_147_483_647,
    ),
  });
}

export function createRemoteWorkerLeaseControlRequestBody(
  value: RemoteWorkerLeaseControlCommand,
): RemoteWorkerLeaseControlRequestBody {
  const command = normalizeRemoteWorkerLeaseControlCommand(value);
  const { workerId: _workerId, workerSessionId: _sessionId, ...body } = command;
  return Object.freeze({ schema: REMOTE_WORKER_LEASE_CONTROL_SCHEMA, ...body });
}

export function parseRemoteWorkerLeaseControlRequestBody(
  value: unknown,
  pathAuthority: Readonly<{ workerId: string; workerSessionId: string }>,
): Readonly<RemoteWorkerLeaseControlCommand> {
  const body = object(value, 'lease control request');
  exactKeys(body, [
    'schema', 'workerGeneration', 'projectId', 'runId', 'attemptId',
    'offerId', 'leaseGeneration', 'leaseToken', 'expectedLeaseVersion',
  ], 'lease control request');
  if (body.schema !== REMOTE_WORKER_LEASE_CONTROL_SCHEMA) {
    return invalid('lease control schema is invalid');
  }
  return normalizeRemoteWorkerLeaseControlCommand({
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
  });
}

export function normalizeRemoteWorkerLeaseControlResult(
  value: RemoteWorkerLeaseControlResult,
): Readonly<RemoteWorkerLeaseControlResult> {
  const result = object(value, 'lease control result');
  const allowed = [
    'status', 'projectId', 'runId', 'attemptId', 'offerId', 'leaseGeneration',
    'leaseVersion', 'renewedAtMs', 'expiresAtMs', 'stop', 'terminalStatus',
  ];
  if (Object.keys(result).some((key) => !allowed.includes(key))) {
    return invalid('lease control result shape is invalid');
  }
  for (const key of [
    'status', 'projectId', 'runId', 'attemptId', 'offerId', 'leaseGeneration',
  ]) {
    if (!Object.hasOwn(result, key)) {
      return invalid('lease control result is incomplete');
    }
  }
  const status = result.status;
  if (!['renewed', 'stop_requested', 'terminal'].includes(String(status))) {
    return invalid('lease control result status is invalid');
  }
  try {
    assertRunDispatchId('runId', result.runId as string);
    assertRunDispatchId('attemptId', result.attemptId as string);
    assertRunDispatchId('offerId', result.offerId as string);
  } catch {
    return invalid('lease control result authority is invalid');
  }
  const common = {
    projectId: identifier('projectId', result.projectId),
    runId: result.runId as string,
    attemptId: result.attemptId as string,
    offerId: result.offerId as string,
    leaseGeneration: integer(
      'leaseGeneration', result.leaseGeneration, 1, 2_147_483_647,
    ),
  };
  if (status === 'terminal') {
    if (
      result.leaseVersion !== undefined || result.renewedAtMs !== undefined ||
      result.expiresAtMs !== undefined || result.stop !== undefined ||
      typeof result.terminalStatus !== 'string' ||
      !REMOTE_WORKER_TERMINAL_STATUSES.includes(
        result.terminalStatus as RemoteWorkerTerminalStatus,
      )
    ) return invalid('terminal lease control result is invalid');
    return Object.freeze({
      status: 'terminal' as const,
      ...common,
      terminalStatus: result.terminalStatus as RemoteWorkerTerminalStatus,
    });
  }
  if (
    result.terminalStatus !== undefined || result.leaseVersion === undefined ||
    result.renewedAtMs === undefined || result.expiresAtMs === undefined
  ) return invalid('renewed lease control result is invalid');
  const leaseVersion = integer(
    'leaseVersion', result.leaseVersion, 1, 2_147_483_647,
  );
  const renewedAtMs = integer('renewedAtMs', result.renewedAtMs);
  const expiresAtMs = integer('expiresAtMs', result.expiresAtMs);
  if (expiresAtMs <= renewedAtMs) return invalid('lease expiry is invalid');
  if (status === 'renewed') {
    if (result.stop !== undefined) return invalid('renewed control is invalid');
    return Object.freeze({
      status: 'renewed' as const,
      ...common,
      leaseVersion,
      renewedAtMs,
      expiresAtMs,
    });
  }
  const stop = object(result.stop, 'stop control');
  exactKeys(stop, ['reason', 'requestedAtMs'], 'stop control');
  if (
    typeof stop.reason !== 'string' ||
    !REMOTE_WORKER_STOP_REASONS.includes(stop.reason as RemoteWorkerStopReason)
  ) return invalid('stop reason is invalid');
  return Object.freeze({
    status: 'stop_requested' as const,
    ...common,
    leaseVersion,
    renewedAtMs,
    expiresAtMs,
    stop: Object.freeze({
      reason: stop.reason as RemoteWorkerStopReason,
      requestedAtMs: integer('requestedAtMs', stop.requestedAtMs),
    }),
  });
}

export function createRemoteWorkerLeaseControlResponseBody(
  value: RemoteWorkerLeaseControlResult,
): RemoteWorkerLeaseControlResponseBody {
  const result = normalizeRemoteWorkerLeaseControlResult(value);
  return Object.freeze({
    schema: REMOTE_WORKER_LEASE_CONTROL_SCHEMA,
    status: result.status,
    projectId: result.projectId,
    runId: result.runId,
    attemptId: result.attemptId,
    offerId: result.offerId,
    leaseGeneration: result.leaseGeneration,
    leaseVersion: result.leaseVersion ?? null,
    renewedAtMs: result.renewedAtMs ?? null,
    expiresAtMs: result.expiresAtMs ?? null,
    stop: result.stop ?? null,
    terminalStatus: result.terminalStatus ?? null,
  });
}

export function parseRemoteWorkerLeaseControlResponse(
  serialized: Uint8Array | string,
): Readonly<RemoteWorkerLeaseControlResult> {
  const bytes = typeof serialized === 'string'
    ? Buffer.from(serialized, 'utf8')
    : Buffer.from(serialized);
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > MAX_REMOTE_WORKER_LEASE_CONTROL_RESPONSE_BYTES
  ) return invalid('lease control response byte size is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return invalid('lease control response is not valid JSON');
  }
  const response = object(parsed, 'lease control response');
  exactKeys(response, [
    'schema', 'status', 'projectId', 'runId', 'attemptId', 'offerId',
    'leaseGeneration', 'leaseVersion', 'renewedAtMs', 'expiresAtMs', 'stop',
    'terminalStatus',
  ], 'lease control response');
  if (response.schema !== REMOTE_WORKER_LEASE_CONTROL_SCHEMA) {
    return invalid('lease control response schema is invalid');
  }
  return normalizeRemoteWorkerLeaseControlResult({
    status: response.status as RemoteWorkerLeaseControlResult['status'],
    projectId: response.projectId as string,
    runId: response.runId as string,
    attemptId: response.attemptId as string,
    offerId: response.offerId as string,
    leaseGeneration: response.leaseGeneration as number,
    ...(response.leaseVersion === null
      ? {}
      : { leaseVersion: response.leaseVersion as number }),
    ...(response.renewedAtMs === null
      ? {}
      : { renewedAtMs: response.renewedAtMs as number }),
    ...(response.expiresAtMs === null
      ? {}
      : { expiresAtMs: response.expiresAtMs as number }),
    ...(response.stop === null
      ? {}
      : { stop: response.stop as NonNullable<RemoteWorkerLeaseControlResult['stop']> }),
    ...(response.terminalStatus === null
      ? {}
      : { terminalStatus: response.terminalStatus as RemoteWorkerTerminalStatus }),
  });
}

export function assertRemoteWorkerLeaseControlDuration(value: number): void {
  try {
    assertRunDispatchLeaseDuration(value);
  } catch {
    invalid('lease duration is invalid');
  }
}
