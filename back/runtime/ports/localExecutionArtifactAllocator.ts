import type { ExecutionOutputSink } from '../domain/execution';
import type { RunDispatchCandidate } from '../domain/runDispatchCandidate';

export interface PreparedLocalExecutionArtifact {
  logArtifactId: string;
  output: ExecutionOutputSink;
  dispose(): void | Promise<void>;
}

export interface LocalExecutionArtifactAllocator {
  prepare(
    candidate: Readonly<RunDispatchCandidate>,
  ): Promise<PreparedLocalExecutionArtifact>;
}
