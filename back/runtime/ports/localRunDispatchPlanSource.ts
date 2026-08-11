import type { ExecutionContext, ExecutionSpec } from '../domain/execution';
import type { RunDispatchCandidate } from '../domain/runDispatchCandidate';

export interface LocalRunDispatchPlan {
  executionSpec: ExecutionSpec;
  context: ExecutionContext;
  logArtifactId?: string;
  /** Optional non-blocking cleanup for attempt-scoped local resources. */
  dispose?: () => void | Promise<void>;
}

/**
 * Trusted local materializer. Implementations must resolve the pinned Task
 * revision and create fresh Attempt-scoped output and Secret capabilities.
 */
export interface LocalRunDispatchPlanSource {
  prepare(
    candidate: Readonly<RunDispatchCandidate>,
  ): Promise<LocalRunDispatchPlan | null>;
}
