import type { WorkerRecord, WorkerStatus } from '../domain/worker';

export const MAX_AVAILABLE_WORKER_PAGE_SIZE = 64;

export interface RegisterWorkerSessionCommand {
  workerId: string;
  sessionId: string;
  capabilitiesJson: string;
  capabilitiesHash: string;
  maxConcurrentRuns: number;
  availableSlots: number;
  registeredAtMs: number;
  leaseExpiresAtMs: number;
}

export interface RegisterWorkerSessionResult {
  worker: WorkerRecord;
  replacedSession: boolean;
}

export interface HeartbeatWorkerSessionCommand {
  workerId: string;
  sessionId: string;
  generation: number;
  expectedVersion: number;
  availableSlots: number;
  heartbeatAtMs: number;
  leaseExpiresAtMs: number;
}

export interface TransitionWorkerSessionCommand {
  workerId: string;
  sessionId: string;
  generation: number;
  expectedVersion: number;
  status: Extract<WorkerStatus, 'draining' | 'offline'>;
  transitionedAtMs: number;
}

export interface AvailableWorkerPage {
  workers: readonly WorkerRecord[];
  truncated: boolean;
  nextCursor?: string;
}

export interface WorkerRegistryRepository {
  findById(workerId: string): Promise<WorkerRecord | null>;
  register(
    command: RegisterWorkerSessionCommand,
  ): Promise<RegisterWorkerSessionResult>;
  heartbeat(command: HeartbeatWorkerSessionCommand): Promise<WorkerRecord>;
  transition(command: TransitionWorkerSessionCommand): Promise<WorkerRecord>;
  listAvailable(options: {
    observedAtMs: number;
    afterWorkerId?: string;
    limit?: number;
  }): Promise<AvailableWorkerPage>;
}
