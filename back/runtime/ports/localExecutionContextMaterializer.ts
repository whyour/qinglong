import type { ExecutionContext } from '../domain/execution';
import type { RunDispatchCandidate } from '../domain/runDispatchCandidate';

export interface LocalExecutionContextRequest {
  candidate: Readonly<RunDispatchCandidate>;
  contextRef: string;
}

export interface MaterializedLocalExecutionContext {
  context: ExecutionContext;
  /** Opaque bounded reference persisted on the Attempt before spawn. */
  logArtifactId?: string;
  /** Optional non-blocking cleanup; plaintext capability values must not leak. */
  dispose?: () => void | Promise<void>;
}

export interface LocalExecutionContextMaterializer {
  prepare(
    request: Readonly<LocalExecutionContextRequest>,
  ): Promise<MaterializedLocalExecutionContext | null>;
}
