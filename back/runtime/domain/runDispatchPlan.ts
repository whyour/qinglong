import type { ExecutionSpec } from './execution';
import { cloneExecutionSpec } from './executionSpec';
import type { RunDispatchCandidate } from './runDispatchCandidate';

/** Normalizes a trusted plan and binds it to one persisted candidate identity. */
export function executionSpecForRunDispatchCandidate(
  candidate: RunDispatchCandidate,
  value: ExecutionSpec,
): ExecutionSpec {
  const executionSpec = cloneExecutionSpec(value);
  if (
    executionSpec.runId !== candidate.runId ||
    executionSpec.attemptId !== candidate.attemptId ||
    executionSpec.projectId !== candidate.projectId ||
    executionSpec.taskId !== candidate.taskId ||
    executionSpec.taskRevision !== candidate.taskRevision
  ) {
    throw new TypeError(
      'ExecutionSpec identity does not match its dispatch candidate',
    );
  }
  return executionSpec;
}
