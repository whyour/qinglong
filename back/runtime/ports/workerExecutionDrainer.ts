export type WorkerExecutionDrainResult = 'drained' | 'timed_out';

export interface WorkerExecutionDrainer {
  drain(): Promise<WorkerExecutionDrainResult>;
}
