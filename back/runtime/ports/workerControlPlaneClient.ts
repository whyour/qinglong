import type { WorkerCapabilities, WorkerRecord } from '../domain/worker';

export interface RegisterWorkerRequest {
  workerId: string;
  sessionId: string;
  capabilities: WorkerCapabilities;
  maxConcurrentRuns: number;
  availableSlots: number;
}

export interface HeartbeatWorkerRequest {
  workerId: string;
  sessionId: string;
  generation: number;
  expectedVersion: number;
  availableSlots: number;
}

export interface TransitionWorkerRequest {
  workerId: string;
  sessionId: string;
  generation: number;
  expectedVersion: number;
}

export interface WorkerControlPlaneClient {
  register(request: RegisterWorkerRequest): Promise<WorkerRecord>;
  heartbeat(request: HeartbeatWorkerRequest): Promise<WorkerRecord>;
  drain(request: TransitionWorkerRequest): Promise<WorkerRecord>;
  disconnect(request: TransitionWorkerRequest): Promise<WorkerRecord>;
}
