import {
  assertWorkerCapabilitiesSnapshot,
  assertWorkerConcurrency,
  assertWorkerId,
  assertWorkerSessionId,
  assertWorkerSessionLeaseDuration,
  assertWorkerSessionRecord,
  MAX_WORKER_CONCURRENT_RUNS,
  type HeartbeatWorkerSessionCommand,
  type RegisterWorkerSessionCommand,
  type RegisterWorkerSessionResult,
  type TransitionWorkerSessionCommand,
  type WorkerSessionRecord,
  type WorkerSessionStatus,
} from './workerSession';

export const WORKER_SESSION_REGISTER_SCHEMA =
  'qinglong/worker-session-register@v1';
export const WORKER_SESSION_HEARTBEAT_SCHEMA =
  'qinglong/worker-session-heartbeat@v1';
export const WORKER_SESSION_TRANSITION_SCHEMA =
  'qinglong/worker-session-transition@v1';
export const MAX_WORKER_SESSION_REGISTER_REQUEST_BYTES = 20 * 1024;
export const MAX_WORKER_SESSION_REQUEST_BYTES = 4 * 1024;
export const MAX_WORKER_SESSION_RESPONSE_BYTES = 4 * 1024;

export interface WorkerSessionPathAuthority {
  readonly workerId: string;
  readonly sessionId: string;
}

export type WorkerSessionRegisterRequestBody = Readonly<{
  readonly schema: typeof WORKER_SESSION_REGISTER_SCHEMA;
  readonly capabilitiesJson: string;
  readonly capabilitiesHash: string;
  readonly maxConcurrentRuns: number;
  readonly availableSlots: number;
  readonly leaseDurationMs: number;
}>;

export type WorkerSessionHeartbeatRequestBody = Readonly<{
  readonly schema: typeof WORKER_SESSION_HEARTBEAT_SCHEMA;
  readonly generation: number;
  readonly expectedVersion: number;
  readonly availableSlots: number;
  readonly leaseDurationMs: number;
}>;

export type WorkerSessionTransitionRequestBody = Readonly<{
  readonly schema: typeof WORKER_SESSION_TRANSITION_SCHEMA;
  readonly generation: number;
  readonly expectedVersion: number;
  readonly status: 'draining' | 'offline';
}>;

export interface WorkerSessionWireProjection {
  readonly workerId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly version: number;
  readonly status: WorkerSessionStatus;
  readonly leaseExpiresAtMs: number;
}

export type WorkerSessionRegisterResponseBody = Readonly<
  WorkerSessionWireProjection & {
    readonly schema: typeof WORKER_SESSION_REGISTER_SCHEMA;
    readonly replacedSession: boolean;
  }
>;

export type WorkerSessionHeartbeatResponseBody = Readonly<
  WorkerSessionWireProjection & {
    readonly schema: typeof WORKER_SESSION_HEARTBEAT_SCHEMA;
  }
>;

export type WorkerSessionTransitionResponseBody = Readonly<
  WorkerSessionWireProjection & {
    readonly schema: typeof WORKER_SESSION_TRANSITION_SCHEMA;
  }
>;

export class InvalidWorkerSessionTransportError extends TypeError {
  readonly code = 'WORKER_SESSION_TRANSPORT_INVALID';

  constructor(message: string) {
    super(`Worker Session transport is invalid: ${message}`);
    this.name = 'InvalidWorkerSessionTransportError';
  }
}

function invalid(message: string): never {
  throw new InvalidWorkerSessionTransportError(message);
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

function integer(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function authority(value: WorkerSessionPathAuthority): WorkerSessionPathAuthority {
  try {
    assertWorkerId(value?.workerId);
    assertWorkerSessionId(value?.sessionId);
  } catch {
    return invalid('path authority is invalid');
  }
  return Object.freeze({
    workerId: value.workerId,
    sessionId: value.sessionId,
  });
}

function validateRegister(
  command: RegisterWorkerSessionCommand,
): Readonly<RegisterWorkerSessionCommand> {
  try {
    assertWorkerId(command?.workerId);
    assertWorkerSessionId(command?.sessionId);
    assertWorkerCapabilitiesSnapshot(
      command?.capabilitiesJson,
      command?.capabilitiesHash,
    );
    assertWorkerConcurrency(
      command?.maxConcurrentRuns,
      command?.availableSlots,
    );
    assertWorkerSessionLeaseDuration(command?.leaseDurationMs);
  } catch {
    return invalid('register command is invalid');
  }
  return Object.freeze({ ...command });
}

function validateHeartbeat(
  command: HeartbeatWorkerSessionCommand,
): Readonly<HeartbeatWorkerSessionCommand> {
  try {
    assertWorkerId(command?.workerId);
    assertWorkerSessionId(command?.sessionId);
    assertWorkerSessionLeaseDuration(command?.leaseDurationMs);
  } catch {
    return invalid('heartbeat command is invalid');
  }
  integer(command.generation, 'generation', 1);
  integer(command.expectedVersion, 'expectedVersion');
  integer(
    command.availableSlots,
    'availableSlots',
    0,
    MAX_WORKER_CONCURRENT_RUNS,
  );
  return Object.freeze({ ...command });
}

function validateTransition(
  command: TransitionWorkerSessionCommand,
): Readonly<TransitionWorkerSessionCommand> {
  try {
    assertWorkerId(command?.workerId);
    assertWorkerSessionId(command?.sessionId);
  } catch {
    return invalid('transition command is invalid');
  }
  integer(command.generation, 'generation', 1);
  integer(command.expectedVersion, 'expectedVersion');
  if (command.status !== 'draining' && command.status !== 'offline') {
    return invalid('transition status is invalid');
  }
  return Object.freeze({ ...command });
}

export function createWorkerSessionRegisterRequestBody(
  value: RegisterWorkerSessionCommand,
): WorkerSessionRegisterRequestBody {
  const command = validateRegister(value);
  return Object.freeze({
    schema: WORKER_SESSION_REGISTER_SCHEMA,
    capabilitiesJson: command.capabilitiesJson,
    capabilitiesHash: command.capabilitiesHash,
    maxConcurrentRuns: command.maxConcurrentRuns,
    availableSlots: command.availableSlots,
    leaseDurationMs: command.leaseDurationMs,
  });
}

export function parseWorkerSessionRegisterRequestBody(
  value: unknown,
  path: WorkerSessionPathAuthority,
): Readonly<RegisterWorkerSessionCommand> {
  const body = object(value, 'register request');
  exactKeys(body, [
    'schema', 'capabilitiesJson', 'capabilitiesHash', 'maxConcurrentRuns',
    'availableSlots', 'leaseDurationMs',
  ], 'register request');
  if (body.schema !== WORKER_SESSION_REGISTER_SCHEMA) {
    return invalid('register schema is invalid');
  }
  const resolved = authority(path);
  return validateRegister({
    ...resolved,
    capabilitiesJson: body.capabilitiesJson as string,
    capabilitiesHash: body.capabilitiesHash as string,
    maxConcurrentRuns: body.maxConcurrentRuns as number,
    availableSlots: body.availableSlots as number,
    leaseDurationMs: body.leaseDurationMs as number,
  });
}

export function createWorkerSessionHeartbeatRequestBody(
  value: HeartbeatWorkerSessionCommand,
): WorkerSessionHeartbeatRequestBody {
  const command = validateHeartbeat(value);
  return Object.freeze({
    schema: WORKER_SESSION_HEARTBEAT_SCHEMA,
    generation: command.generation,
    expectedVersion: command.expectedVersion,
    availableSlots: command.availableSlots,
    leaseDurationMs: command.leaseDurationMs,
  });
}

export function parseWorkerSessionHeartbeatRequestBody(
  value: unknown,
  path: WorkerSessionPathAuthority,
): Readonly<HeartbeatWorkerSessionCommand> {
  const body = object(value, 'heartbeat request');
  exactKeys(body, [
    'schema', 'generation', 'expectedVersion', 'availableSlots',
    'leaseDurationMs',
  ], 'heartbeat request');
  if (body.schema !== WORKER_SESSION_HEARTBEAT_SCHEMA) {
    return invalid('heartbeat schema is invalid');
  }
  return validateHeartbeat({
    ...authority(path),
    generation: body.generation as number,
    expectedVersion: body.expectedVersion as number,
    availableSlots: body.availableSlots as number,
    leaseDurationMs: body.leaseDurationMs as number,
  });
}

export function createWorkerSessionTransitionRequestBody(
  value: TransitionWorkerSessionCommand,
): WorkerSessionTransitionRequestBody {
  const command = validateTransition(value);
  return Object.freeze({
    schema: WORKER_SESSION_TRANSITION_SCHEMA,
    generation: command.generation,
    expectedVersion: command.expectedVersion,
    status: command.status,
  });
}

export function parseWorkerSessionTransitionRequestBody(
  value: unknown,
  path: WorkerSessionPathAuthority,
): Readonly<TransitionWorkerSessionCommand> {
  const body = object(value, 'transition request');
  exactKeys(body, [
    'schema', 'generation', 'expectedVersion', 'status',
  ], 'transition request');
  if (body.schema !== WORKER_SESSION_TRANSITION_SCHEMA) {
    return invalid('transition schema is invalid');
  }
  return validateTransition({
    ...authority(path),
    generation: body.generation as number,
    expectedVersion: body.expectedVersion as number,
    status: body.status as 'draining' | 'offline',
  });
}

function projection(record: WorkerSessionRecord): WorkerSessionWireProjection {
  try {
    assertWorkerSessionRecord(record);
  } catch {
    return invalid('Session record is invalid');
  }
  return Object.freeze({
    workerId: record.workerId,
    sessionId: record.sessionId,
    generation: record.generation,
    version: record.version,
    status: record.status,
    leaseExpiresAtMs: record.leaseExpiresAtMs,
  });
}

export function createWorkerSessionRegisterResponseBody(
  value: RegisterWorkerSessionResult,
): WorkerSessionRegisterResponseBody {
  if (typeof value?.replacedSession !== 'boolean') {
    return invalid('register result is invalid');
  }
  return Object.freeze({
    schema: WORKER_SESSION_REGISTER_SCHEMA,
    ...projection(value.worker),
    replacedSession: value.replacedSession,
  });
}

export function createWorkerSessionHeartbeatResponseBody(
  value: WorkerSessionRecord,
): WorkerSessionHeartbeatResponseBody {
  return Object.freeze({
    schema: WORKER_SESSION_HEARTBEAT_SCHEMA,
    ...projection(value),
  });
}

export function createWorkerSessionTransitionResponseBody(
  value: WorkerSessionRecord,
): WorkerSessionTransitionResponseBody {
  return Object.freeze({
    schema: WORKER_SESSION_TRANSITION_SCHEMA,
    ...projection(value),
  });
}

function parseProjection(
  value: unknown,
  schema: string,
  includeReplacement: boolean,
): WorkerSessionWireProjection & { readonly replacedSession?: boolean } {
  const body = object(value, 'Session response');
  exactKeys(body, [
    'schema', 'workerId', 'sessionId', 'generation', 'version', 'status',
    'leaseExpiresAtMs', ...(includeReplacement ? ['replacedSession'] : []),
  ], 'Session response');
  if (body.schema !== schema) return invalid('response schema is invalid');
  try {
    assertWorkerId(body.workerId as string);
    assertWorkerSessionId(body.sessionId as string);
  } catch {
    return invalid('response authority is invalid');
  }
  if (!['online', 'draining', 'offline'].includes(body.status as string)) {
    return invalid('response status is invalid');
  }
  if (includeReplacement && typeof body.replacedSession !== 'boolean') {
    return invalid('replacement fact is invalid');
  }
  return Object.freeze({
    workerId: body.workerId as string,
    sessionId: body.sessionId as string,
    generation: integer(body.generation, 'generation', 1),
    version: integer(body.version, 'version'),
    status: body.status as WorkerSessionStatus,
    leaseExpiresAtMs: integer(body.leaseExpiresAtMs, 'leaseExpiresAtMs'),
    ...(includeReplacement
      ? { replacedSession: body.replacedSession as boolean }
      : {}),
  });
}

export function parseWorkerSessionRegisterResponseBody(
  value: unknown,
): WorkerSessionRegisterResponseBody {
  const result = parseProjection(value, WORKER_SESSION_REGISTER_SCHEMA, true);
  return Object.freeze({
    schema: WORKER_SESSION_REGISTER_SCHEMA,
    ...result,
    replacedSession: result.replacedSession!,
  });
}

export function parseWorkerSessionHeartbeatResponseBody(
  value: unknown,
): WorkerSessionHeartbeatResponseBody {
  return Object.freeze({
    schema: WORKER_SESSION_HEARTBEAT_SCHEMA,
    ...parseProjection(value, WORKER_SESSION_HEARTBEAT_SCHEMA, false),
  });
}

export function parseWorkerSessionTransitionResponseBody(
  value: unknown,
): WorkerSessionTransitionResponseBody {
  return Object.freeze({
    schema: WORKER_SESSION_TRANSITION_SCHEMA,
    ...parseProjection(value, WORKER_SESSION_TRANSITION_SCHEMA, false),
  });
}
