import type { PinnedTaskExecutionRevision } from '../domain/taskExecutionRevision';

export interface TaskExecutionRevisionRequest {
  projectId: string;
  taskId: string;
  taskRevision: string;
}

/** Reads an immutable revision; implementations must not fall back to latest. */
export interface TaskExecutionRevisionSource {
  resolve(
    request: Readonly<TaskExecutionRevisionRequest>,
  ): Promise<PinnedTaskExecutionRevision | null>;
}
