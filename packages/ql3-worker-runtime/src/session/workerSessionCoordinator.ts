// Session ownership: coordinate registration, heartbeat, drain, and lease fencing.
import { randomBytes } from 'node:crypto';
import {
  assertWorkerConcurrency,
  assertWorkerId,
  assertWorkerSessionLeaseDuration,
  type WorkerSessionStatus,
} from '@qinglong/runtime-core/worker-session';
import {
  canonicalRemoteWorkerCapabilities,
  type RemoteWorkerCapabilities,
} from '@qinglong/runtime-core/remote-dispatch';
import type { WorkerRemoteExecutionSession } from '../remote-execution/executionInboxProcessor';
import {
  WorkerSessionHttpsClient,
  WorkerSessionHttpsClientError,
} from './workerSessionHttpsClient';

export const MIN_WORKER_PRODUCT_HEARTBEAT_INTERVAL_MS = 5_000;
export const MAX_WORKER_PRODUCT_HEARTBEAT_INTERVAL_MS = 5 * 60_000;

export interface WorkerSessionCoordinatorOptions {
  readonly client: WorkerSessionHttpsClient;
  readonly workerId: string;
  readonly capabilities: RemoteWorkerCapabilities;
  readonly maxConcurrentRuns: number;
  readonly availableSlots: () => number | Promise<number>;
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly now?: () => number;
  readonly createSessionId?: (nowMs: number) => string;
}

export interface WorkerSessionCoordinatorRecord
  extends WorkerRemoteExecutionSession {
  readonly version: number;
  readonly nextHeartbeatAtMs: number;
}

export type WorkerSessionCoordinatorTickResult = Readonly<
  | { status: 'inactive' | 'not_due' | 'lease_expired' }
  | { status: 'heartbeat'; session: WorkerSessionCoordinatorRecord }
>;

export class WorkerSessionCoordinatorError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'already_registered'
      | 'inactive'
      | 'lease_expired'
      | 'invalid_capacity'
      | 'response_invalid',
    options?: ErrorOptions,
  ) {
    super(`Worker Session coordinator failed: ${reason}`, options);
    this.name = 'WorkerSessionCoordinatorError';
  }
}

function safeNow(provider: () => number): number {
  const value = provider();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkerSessionCoordinatorError('invalid_configuration');
  }
  return value;
}

function uuidV7(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 0xffffffffffff) {
    throw new WorkerSessionCoordinatorError('invalid_configuration');
  }
  const bytes = randomBytes(16);
  let timestamp = nowMs;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  bytes.fill(0);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function executionStatus(
  status: WorkerSessionStatus,
): WorkerRemoteExecutionSession['status'] {
  if (status === 'online') return 'available';
  return status;
}

export class WorkerSessionCoordinator {
  private readonly client: WorkerSessionHttpsClient;
  private readonly workerId: string;
  private readonly capabilitiesJson: string;
  private readonly capabilitiesHash: string;
  private readonly maxConcurrentRuns: number;
  private readonly availableSlotsProvider: () => number | Promise<number>;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly nowProvider: () => number;
  private readonly createSessionId: (nowMs: number) => string;
  private session?: WorkerSessionCoordinatorRecord;
  private blocked = false;
  private operation?: Promise<unknown>;

  constructor(options: WorkerSessionCoordinatorOptions) {
    if (
      !options ||
      !(options.client instanceof WorkerSessionHttpsClient) ||
      typeof options.availableSlots !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      (options.createSessionId !== undefined &&
        typeof options.createSessionId !== 'function')
    ) throw new WorkerSessionCoordinatorError('invalid_configuration');
    try {
      assertWorkerId(options.workerId);
      assertWorkerConcurrency(options.maxConcurrentRuns, 0);
    } catch (error) {
      throw new WorkerSessionCoordinatorError(
        'invalid_configuration', { cause: error },
      );
    }
    const leaseDurationMs = options.leaseDurationMs ?? 45_000;
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    try {
      assertWorkerSessionLeaseDuration(leaseDurationMs);
    } catch (error) {
      throw new WorkerSessionCoordinatorError(
        'invalid_configuration', { cause: error },
      );
    }
    if (
      !Number.isSafeInteger(heartbeatIntervalMs) ||
      heartbeatIntervalMs < MIN_WORKER_PRODUCT_HEARTBEAT_INTERVAL_MS ||
      heartbeatIntervalMs > MAX_WORKER_PRODUCT_HEARTBEAT_INTERVAL_MS ||
      heartbeatIntervalMs * 2 > leaseDurationMs
    ) throw new WorkerSessionCoordinatorError('invalid_configuration');
    let canonical;
    try {
      canonical = canonicalRemoteWorkerCapabilities(options.capabilities);
    } catch (error) {
      throw new WorkerSessionCoordinatorError(
        'invalid_configuration', { cause: error },
      );
    }
    this.client = options.client;
    this.workerId = options.workerId;
    this.capabilitiesJson = canonical.json;
    this.capabilitiesHash = canonical.hash;
    this.maxConcurrentRuns = options.maxConcurrentRuns;
    this.availableSlotsProvider = options.availableSlots;
    this.leaseDurationMs = leaseDurationMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.nowProvider = options.now ?? Date.now;
    this.createSessionId = options.createSessionId ?? uuidV7;
  }

  current(): WorkerRemoteExecutionSession | undefined {
    const session = this.session;
    if (
      !session ||
      this.blocked ||
      session.leaseExpiresAtMs <= safeNow(this.nowProvider)
    ) {
      return undefined;
    }
    return Object.freeze({
      workerId: session.workerId,
      sessionId: session.sessionId,
      generation: session.generation,
      status: session.status,
      leaseExpiresAtMs: session.leaseExpiresAtMs,
    });
  }

  currentRecord(): WorkerSessionCoordinatorRecord | undefined {
    return this.session ? Object.freeze({ ...this.session }) : undefined;
  }

  /**
   * Removes the Session from execution admission without destroying its
   * durable identity. A later authenticated exchange is the only operation
   * that can clear this transport fence.
   */
  failClosed(): void {
    this.blocked = true;
  }

  register(): Promise<WorkerSessionCoordinatorRecord> {
    return this.serial(async () => {
      if (this.session) {
        throw new WorkerSessionCoordinatorError('already_registered');
      }
      const now = safeNow(this.nowProvider);
      const sessionId = this.createSessionId(now);
      const availableSlots = await this.readAvailableSlots();
      const response = await this.exchange(() => this.client.register({
        workerId: this.workerId,
        sessionId,
        capabilitiesJson: this.capabilitiesJson,
        capabilitiesHash: this.capabilitiesHash,
        maxConcurrentRuns: this.maxConcurrentRuns,
        availableSlots,
        leaseDurationMs: this.leaseDurationMs,
      }));
      if (response.leaseExpiresAtMs <= now) {
        throw new WorkerSessionCoordinatorError('response_invalid');
      }
      return this.accept(response, now);
    });
  }

  tick(): Promise<WorkerSessionCoordinatorTickResult> {
    return this.serial(async () => {
      const session = this.session;
      if (!session) return Object.freeze({ status: 'inactive' as const });
      const now = safeNow(this.nowProvider);
      if (session.leaseExpiresAtMs <= now) {
        return Object.freeze({ status: 'lease_expired' as const });
      }
      if (now < session.nextHeartbeatAtMs) {
        return Object.freeze({ status: 'not_due' as const });
      }
      const availableSlots = session.status === 'available'
        ? await this.readAvailableSlots()
        : 0;
      const response = await this.exchange(() => this.client.heartbeat({
        workerId: session.workerId,
        sessionId: session.sessionId,
        generation: session.generation,
        expectedVersion: session.version,
        availableSlots,
        leaseDurationMs: this.leaseDurationMs,
      }));
      return Object.freeze({
        status: 'heartbeat' as const,
        session: this.accept(response, now),
      });
    });
  }

  beginDrain(): Promise<void> {
    return this.serial(async () => {
      const session = this.requireLiveSession();
      if (session.status === 'draining') return;
      if (session.status === 'offline') return;
      const now = safeNow(this.nowProvider);
      const response = await this.exchange(() => this.client.transition({
        workerId: session.workerId,
        sessionId: session.sessionId,
        generation: session.generation,
        expectedVersion: session.version,
        status: 'draining',
      }));
      this.accept(response, now);
    });
  }

  disconnect(): Promise<void> {
    return this.serial(async () => {
      const session = this.requireLiveSession();
      if (session.status === 'offline') return;
      if (session.status !== 'draining') {
        throw new WorkerSessionCoordinatorError('inactive');
      }
      const now = safeNow(this.nowProvider);
      const response = await this.exchange(() => this.client.transition({
        workerId: session.workerId,
        sessionId: session.sessionId,
        generation: session.generation,
        expectedVersion: session.version,
        status: 'offline',
      }));
      this.accept(response, now);
    });
  }

  private accept(
    response: Readonly<{
      workerId: string;
      sessionId: string;
      generation: number;
      version: number;
      status: WorkerSessionStatus;
      leaseExpiresAtMs: number;
    }>,
    now: number,
  ): WorkerSessionCoordinatorRecord {
    const previous = this.session;
    if (
      response.workerId !== this.workerId ||
      (previous !== undefined &&
        (response.sessionId !== previous.sessionId ||
          response.generation !== previous.generation ||
          response.version !== previous.version + 1)) ||
      response.leaseExpiresAtMs < now
    ) throw new WorkerSessionCoordinatorError('response_invalid');
    const record = Object.freeze({
      workerId: response.workerId,
      sessionId: response.sessionId,
      generation: response.generation,
      version: response.version,
      status: executionStatus(response.status),
      leaseExpiresAtMs: response.leaseExpiresAtMs,
      nextHeartbeatAtMs: now + this.heartbeatIntervalMs,
    });
    this.session = record;
    return record;
  }

  private requireLiveSession(): WorkerSessionCoordinatorRecord {
    const session = this.session;
    if (!session) throw new WorkerSessionCoordinatorError('inactive');
    if (session.leaseExpiresAtMs <= safeNow(this.nowProvider)) {
      throw new WorkerSessionCoordinatorError('lease_expired');
    }
    return session;
  }

  private async readAvailableSlots(): Promise<number> {
    const availableSlots = await this.availableSlotsProvider();
    try {
      assertWorkerConcurrency(this.maxConcurrentRuns, availableSlots);
    } catch (error) {
      throw new WorkerSessionCoordinatorError(
        'invalid_capacity', { cause: error },
      );
    }
    return availableSlots;
  }

  private async exchange<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      this.blocked = false;
      return result;
    } catch (error) {
      if (
        error instanceof WorkerSessionHttpsClientError &&
        (error.reason === 'credential_rejected' ||
          error.reason === 'session_fenced')
      ) this.blocked = true;
      throw error;
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const current = (this.operation ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.operation = current;
    return current.finally(() => {
      if (this.operation === current) this.operation = undefined;
    });
  }
}
