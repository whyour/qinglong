import type { PinnedTaskExecutionRevision } from '../domain/taskExecutionRevision';
import type { TaskExecutionRevisionSource } from './taskExecutionRevisionSource';

export type InsertTaskExecutionRevisionResult = 'inserted' | 'idempotent';

/** Append-only revision store. Existing identities can never be overwritten. */
export interface TaskExecutionRevisionRepository
  extends TaskExecutionRevisionSource {
  insert(
    revision: PinnedTaskExecutionRevision,
    createdAtMs: number,
  ): Promise<InsertTaskExecutionRevisionResult>;
}
