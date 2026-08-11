import { v7 as uuidV7 } from 'uuid';
import {
  WorkerFenceRejectedError,
  assertWorkerConcurrency,
  assertWorkerId,
  assertWorkerSessionId,
  type WorkerCapabilities,
  type WorkerRecord,
} from '../domain/worker';
import type { WorkerControlPlaneClient } from '../ports/workerControlPlaneClient';

export const MIN_WORKER_HEARTBEAT_INTERVAL_MS = 1_000;
export const MAX_WORKER_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
export const MAX_WORKER_HEARTBEAT_STOP_TIMEOUT_MS = 60_000;

interface ScheduledTimer {
  unref?: () => void;
}

export interface WorkerHeartbeatScheduler {
  setTimeout(callback: () => void, delayMs: number): ScheduledTimer;
  clearTimeout(timer: ScheduledTimer): void;
}

export interface WorkerHeartbeatLifecycleOptions {
  workerId: string;
  capabilities(): WorkerCapabilities | Promise<WorkerCapabilities>;
  maxConcurrentRuns: number;
  availableSlots(): number | Promise<number>;
  heartbeatIntervalMs?: number;
  stopTimeoutMs?: number;
  createSessionId?: () => string;
  scheduler?: WorkerHeartbeatScheduler;
  onSession?: (worker: WorkerRecord) => void;
  onError?: (error: unknown) => void;
  onFenced?: (error: WorkerFenceRejectedError) => void;
}

export type WorkerHeartbeatStopResult =
  | 'drained'
  | 'timed_out'
  | 'disconnect_failed';

const defaultScheduler: WorkerHeartbeatScheduler = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

function assertIntegerBetween(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

export class WorkerHeartbeatLifecycle {
  private readonly workerId: string;
  private readonly maxConcurrentRuns: number;
  private readonly heartbeatIntervalMs: number;
  private readonly stopTimeoutMs: number;
  private readonly capabilitiesProvider: WorkerHeartbeatLifecycleOptions['capabilities'];
  private readonly availableSlotsProvider: WorkerHeartbeatLifecycleOptions['availableSlots'];
  private readonly createSessionId: () => string;
  private readonly scheduler: WorkerHeartbeatScheduler;
  private readonly onSession?: (worker: WorkerRecord) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly onFenced?: (error: WorkerFenceRejectedError) => void;
  private started = false;
  private draining = false;
  private timer?: ScheduledTimer;
  private inFlight?: Promise<void>;
  private session?: WorkerRecord;

  constructor(
    private readonly client: WorkerControlPlaneClient,
    options: WorkerHeartbeatLifecycleOptions,
  ) {
    assertWorkerId(options.workerId);
    assertWorkerConcurrency(options.maxConcurrentRuns, 0);
    this.workerId = options.workerId;
    this.maxConcurrentRuns = options.maxConcurrentRuns;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.capabilitiesProvider = options.capabilities;
    this.availableSlotsProvider = options.availableSlots;
    this.createSessionId = options.createSessionId ?? uuidV7;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onSession = options.onSession;
    this.onError = options.onError;
    this.onFenced = options.onFenced;
    assertIntegerBetween(
      'heartbeatIntervalMs',
      this.heartbeatIntervalMs,
      MIN_WORKER_HEARTBEAT_INTERVAL_MS,
      MAX_WORKER_HEARTBEAT_INTERVAL_MS,
    );
    assertIntegerBetween(
      'stopTimeoutMs',
      this.stopTimeoutMs,
      1,
      MAX_WORKER_HEARTBEAT_STOP_TIMEOUT_MS,
    );
  }

  currentSession(): WorkerRecord | undefined {
    return this.session ? this.cloneRecord(this.session) : undefined;
  }

  async start(): Promise<boolean> {
    if (this.started || this.inFlight) return false;
    this.started = true;
    this.draining = false;
    try {
      const sessionId = this.createSessionId();
      assertWorkerSessionId(sessionId);
      const availableSlots = await this.readAvailableSlots();
      const worker = await this.client.register({
        workerId: this.workerId,
        sessionId,
        capabilities: await this.capabilitiesProvider(),
        maxConcurrentRuns: this.maxConcurrentRuns,
        availableSlots,
      });
      this.acceptSession(worker, sessionId);
      this.schedule();
      return true;
    } catch (error) {
      this.started = false;
      this.notifyError(error);
      throw error;
    }
  }

  async drain(): Promise<WorkerRecord | undefined> {
    if (!this.started || !this.session) return undefined;
    this.draining = true;
    this.clearTimer();
    const precedingOperation = this.inFlight ?? Promise.resolve();
    const drainOperation = precedingOperation.then(async () => {
      const session = this.session;
      if (!this.started || !session) return undefined;
      try {
        const worker = await this.client.drain({
          workerId: this.workerId,
          sessionId: session.sessionId,
          generation: session.generation,
          expectedVersion: session.version,
        });
        this.acceptSession(worker, session.sessionId);
        return this.cloneRecord(worker);
      } catch (error) {
        this.handleOperationError(error);
        throw error;
      }
    });
    const trackedOperation = drainOperation
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.inFlight === trackedOperation) this.inFlight = undefined;
        this.schedule();
      });
    this.inFlight = trackedOperation;
    return drainOperation;
  }

  async stop(): Promise<WorkerHeartbeatStopResult> {
    this.clearTimer();
    const deadline = Date.now() + this.stopTimeoutMs;
    if (!(await this.waitWithin(this.inFlight, deadline))) {
      this.started = false;
      this.clearTimer();
      return 'timed_out';
    }
    this.started = false;
    this.clearTimer();
    const session = this.session;
    if (!session) return 'drained';
    let disconnectFailed = false;
    const disconnected = this.client
      .disconnect({
        workerId: this.workerId,
        sessionId: session.sessionId,
        generation: session.generation,
        expectedVersion: session.version,
      })
      .then((worker) => {
        this.acceptSession(worker, session.sessionId);
      })
      .catch((error) => {
        disconnectFailed = true;
        this.handleOperationError(error);
      });
    if (!(await this.waitWithin(disconnected, deadline))) return 'timed_out';
    return disconnectFailed ? 'disconnect_failed' : 'drained';
  }

  private schedule(): void {
    if (!this.started || this.timer || this.inFlight) return;
    const timer = this.scheduler.setTimeout(() => {
      if (this.timer === timer) this.timer = undefined;
      this.runHeartbeat();
    }, this.heartbeatIntervalMs);
    this.timer = timer;
    timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private runHeartbeat(): void {
    if (!this.started || this.inFlight || !this.session) return;
    const session = this.session;
    const inFlight = this.readAvailableSlots()
      .then((availableSlots) =>
        this.client.heartbeat({
          workerId: this.workerId,
          sessionId: session.sessionId,
          generation: session.generation,
          expectedVersion: session.version,
          availableSlots: this.draining ? 0 : availableSlots,
        }),
      )
      .then((worker) => this.acceptSession(worker, session.sessionId))
      .catch((error) => this.handleOperationError(error))
      .then(() => undefined)
      .finally(() => {
        if (this.inFlight === inFlight) this.inFlight = undefined;
        this.schedule();
      });
    this.inFlight = inFlight;
  }

  private async readAvailableSlots(): Promise<number> {
    const availableSlots = await this.availableSlotsProvider();
    assertWorkerConcurrency(this.maxConcurrentRuns, availableSlots);
    return availableSlots;
  }

  private acceptSession(worker: WorkerRecord, sessionId: string): void {
    if (worker.id !== this.workerId || worker.sessionId !== sessionId) {
      throw new WorkerFenceRejectedError(this.workerId, 'session_mismatch');
    }
    this.session = this.cloneRecord(worker);
    try {
      this.onSession?.(this.cloneRecord(worker));
    } catch (error) {
      this.notifyError(error);
    }
  }

  private handleOperationError(error: unknown): void {
    if (error instanceof WorkerFenceRejectedError) {
      this.started = false;
      this.clearTimer();
      try {
        this.onFenced?.(error);
      } catch (callbackError) {
        this.notifyError(callbackError);
      }
    }
    this.notifyError(error);
  }

  private notifyError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Diagnostics must never create a heartbeat failure loop.
    }
  }

  private async waitWithin(
    promise: Promise<unknown> | undefined,
    deadline: number,
  ): Promise<boolean> {
    if (!promise) return true;
    const remainingMs = Math.max(0, deadline - Date.now());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), remainingMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return completed;
  }

  private cloneRecord(worker: WorkerRecord): WorkerRecord {
    return {
      ...worker,
      capabilities: {
        ...worker.capabilities,
        executors: [...worker.capabilities.executors],
        runtimes: worker.capabilities.runtimes.map((runtime) => ({
          ...runtime,
        })),
        labels: { ...worker.capabilities.labels },
        capacity: {
          ...worker.capabilities.capacity,
          ...(worker.capabilities.capacity.gpu
            ? {
                gpu: worker.capabilities.capacity.gpu.map((gpu) => ({
                  ...gpu,
                })),
              }
            : {}),
        },
        features: [...worker.capabilities.features],
      },
    };
  }
}
