import { createHash } from 'node:crypto';

export const WORKER_SESSION_STATUSES = ['online', 'draining', 'offline'] as const;
export type WorkerSessionStatus = (typeof WORKER_SESSION_STATUSES)[number];

export const MAX_WORKER_ID_LENGTH = 128;
export const MAX_WORKER_CAPABILITIES_BYTES = 16 * 1024;
export const MAX_WORKER_CONCURRENT_RUNS = 1024;
export const MAX_WORKER_SESSION_LEASE_MS = 10 * 60_000;
export const MIN_WORKER_SESSION_LEASE_MS = 5_000;
export const MAX_AVAILABLE_WORKER_PAGE_SIZE = 64;

const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface WorkerSessionRecord {
  readonly workerId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly status: WorkerSessionStatus;
  readonly version: number;
  /** Canonical, bounded JSON. Parsing/placement belongs to the Worker domain. */
  readonly capabilitiesJson: string;
  readonly capabilitiesHash: string;
  readonly maxConcurrentRuns: number;
  readonly availableSlots: number;
  readonly registeredAtMs: number;
  readonly lastHeartbeatAtMs: number;
  readonly leaseExpiresAtMs: number;
  readonly updatedAtMs: number;
}

export class InvalidWorkerSessionValueError extends TypeError {
  constructor(message: string) {
    super(`Worker session value is invalid: ${message}`);
    this.name = 'InvalidWorkerSessionValueError';
  }
}

export type WorkerSessionFenceReason =
  | 'missing'
  | 'session_mismatch'
  | 'generation_mismatch'
  | 'version_mismatch'
  | 'lease_expired'
  | 'offline';

export class WorkerSessionFenceRejectedError extends Error {
  constructor(
    readonly workerId: string,
    readonly reason: WorkerSessionFenceReason,
  ) {
    super(`Worker session ${workerId} was fenced: ${reason}`);
    this.name = 'WorkerSessionFenceRejectedError';
  }
}

export class WorkerSessionConflictError extends Error {
  constructor(readonly workerId: string) {
    super(`Worker session ${workerId} replay conflicts with persisted data`);
    this.name = 'WorkerSessionConflictError';
  }
}

function invalid(message: string): never {
  throw new InvalidWorkerSessionValueError(message);
}

function safeInteger(name: string, value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    invalid(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
}

export function assertWorkerId(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_WORKER_ID_LENGTH ||
    !WORKER_ID_PATTERN.test(value)
  ) {
    invalid('workerId is invalid');
  }
}

export function assertWorkerSessionId(value: string): void {
  if (typeof value !== 'string' || !UUID_V7_PATTERN.test(value)) {
    invalid('sessionId must be a lowercase UUIDv7');
  }
}

export function assertWorkerSessionLeaseDuration(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_WORKER_SESSION_LEASE_MS ||
    value > MAX_WORKER_SESSION_LEASE_MS
  ) {
    invalid(
      `leaseDurationMs must be between ${MIN_WORKER_SESSION_LEASE_MS} and ${MAX_WORKER_SESSION_LEASE_MS}`,
    );
  }
}

export function assertWorkerConcurrency(
  maxConcurrentRuns: number,
  availableSlots: number,
): void {
  if (
    !Number.isSafeInteger(maxConcurrentRuns) ||
    maxConcurrentRuns < 1 ||
    maxConcurrentRuns > MAX_WORKER_CONCURRENT_RUNS ||
    !Number.isSafeInteger(availableSlots) ||
    availableSlots < 0 ||
    availableSlots > maxConcurrentRuns
  ) {
    invalid('Worker concurrency is invalid');
  }
}

export function assertWorkerCapabilitiesSnapshot(
  capabilitiesJson: string,
  capabilitiesHash: string,
): void {
  if (
    typeof capabilitiesJson !== 'string' ||
    Buffer.byteLength(capabilitiesJson, 'utf8') < 2 ||
    Buffer.byteLength(capabilitiesJson, 'utf8') >
      MAX_WORKER_CAPABILITIES_BYTES ||
    !SHA256_PATTERN.test(capabilitiesHash)
  ) {
    invalid('Worker capabilities snapshot is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(capabilitiesJson);
  } catch {
    return invalid('Worker capabilities snapshot is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    invalid('Worker capabilities snapshot must be an object');
  }
  if (
    createHash('sha256').update(capabilitiesJson, 'utf8').digest('hex') !==
    capabilitiesHash
  ) {
    invalid('Worker capabilities hash does not match its canonical JSON');
  }
}

export function assertWorkerSessionRecord(value: WorkerSessionRecord): void {
  assertWorkerId(value.workerId);
  assertWorkerSessionId(value.sessionId);
  safeInteger('generation', value.generation, 1);
  safeInteger('version', value.version);
  if (!WORKER_SESSION_STATUSES.includes(value.status)) invalid('status is invalid');
  assertWorkerCapabilitiesSnapshot(
    value.capabilitiesJson,
    value.capabilitiesHash,
  );
  assertWorkerConcurrency(value.maxConcurrentRuns, value.availableSlots);
  for (const [name, timestamp] of [
    ['registeredAtMs', value.registeredAtMs],
    ['lastHeartbeatAtMs', value.lastHeartbeatAtMs],
    ['leaseExpiresAtMs', value.leaseExpiresAtMs],
    ['updatedAtMs', value.updatedAtMs],
  ] as const) {
    safeInteger(name, timestamp);
  }
  if (
    value.lastHeartbeatAtMs < value.registeredAtMs ||
    (value.status !== 'offline' &&
      value.leaseExpiresAtMs <= value.lastHeartbeatAtMs) ||
    value.updatedAtMs < value.lastHeartbeatAtMs ||
    (value.status !== 'online' && value.availableSlots !== 0)
  ) {
    invalid('timestamps or status capacity are inconsistent');
  }
}

export interface RegisterWorkerSessionCommand {
  readonly workerId: string;
  readonly sessionId: string;
  readonly capabilitiesJson: string;
  readonly capabilitiesHash: string;
  readonly maxConcurrentRuns: number;
  readonly availableSlots: number;
  readonly leaseDurationMs: number;
}

export interface HeartbeatWorkerSessionCommand {
  readonly workerId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly expectedVersion: number;
  readonly availableSlots: number;
  readonly leaseDurationMs: number;
}

export interface TransitionWorkerSessionCommand {
  readonly workerId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly expectedVersion: number;
  readonly status: 'draining' | 'offline';
}

export interface RegisterWorkerSessionResult {
  readonly worker: WorkerSessionRecord;
  readonly replacedSession: boolean;
}

export interface AvailableWorkerSessionPage {
  readonly observedAtMs: number;
  readonly workers: readonly WorkerSessionRecord[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface WorkerSessionRepository {
  findById(workerId: string): Promise<WorkerSessionRecord | null>;
  register(
    command: RegisterWorkerSessionCommand,
  ): Promise<RegisterWorkerSessionResult>;
  heartbeat(command: HeartbeatWorkerSessionCommand): Promise<WorkerSessionRecord>;
  transition(command: TransitionWorkerSessionCommand): Promise<WorkerSessionRecord>;
  listAvailable(options?: Readonly<{
    afterWorkerId?: string;
    limit?: number;
  }>): Promise<AvailableWorkerSessionPage>;
}
