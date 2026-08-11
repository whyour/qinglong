import { normalizeExecutionContext } from '../domain/executionContext';
import type { RunDispatchCandidate } from '../domain/runDispatchCandidate';
import {
  executionSpecFromPinnedTaskRevision,
  type PinnedTaskExecutionRevision,
} from '../domain/taskExecutionRevision';
import type { LocalExecutionContextMaterializer } from '../ports/localExecutionContextMaterializer';
import type {
  LocalRunDispatchPlan,
  LocalRunDispatchPlanSource,
} from '../ports/localRunDispatchPlanSource';
import type { TaskExecutionRevisionSource } from '../ports/taskExecutionRevisionSource';

/** Composes immutable Task facts with fresh Attempt-scoped local capabilities. */
export class PinnedTaskLocalRunDispatchPlanSource
  implements LocalRunDispatchPlanSource
{
  constructor(
    private readonly revisions: TaskExecutionRevisionSource,
    private readonly contexts: LocalExecutionContextMaterializer,
  ) {}

  async prepare(
    candidate: Readonly<RunDispatchCandidate>,
  ): Promise<LocalRunDispatchPlan | null> {
    const revision = await this.revisions.resolve(
      Object.freeze({
        projectId: candidate.projectId,
        taskId: candidate.taskId,
        taskRevision: candidate.taskRevision,
      }),
    );
    if (!revision) return null;
    const executionSpec = executionSpecFromPinnedTaskRevision(
      candidate,
      this.knownRevision(revision),
    );
    const context = await this.contexts.prepare(
      Object.freeze({
        candidate: Object.freeze({ ...candidate }),
        contextRef: revision.contextRef,
      }),
    );
    if (!context) return null;
    let normalizedContext;
    try {
      normalizedContext = normalizeExecutionContext(context.context);
    } catch (error) {
      try {
        await context.dispose?.();
      } catch {
        // Cleanup failure must not replace the validation failure.
      }
      throw error;
    }
    return {
      executionSpec,
      context: normalizedContext,
      ...(context.logArtifactId === undefined
        ? {}
        : { logArtifactId: context.logArtifactId }),
      ...(context.dispose === undefined ? {} : { dispose: context.dispose }),
    };
  }

  private knownRevision(
    revision: PinnedTaskExecutionRevision,
  ): PinnedTaskExecutionRevision {
    return {
      projectId: revision.projectId,
      taskId: revision.taskId,
      taskRevision: revision.taskRevision,
      executorType: revision.executorType,
      execution: revision.execution,
      contextRef: revision.contextRef,
    };
  }
}
