import type { ApprovedRunCreationPlan } from '../domain/approvedRunAction';
import type { ApprovedActionDispatchExecutionSnapshot } from '../domain/approvedActionDispatchExecution';
import type { RunAttemptRecord, RunRecord } from '../domain/run';

export interface ApprovedRunReference {
  run: Readonly<RunRecord>;
  attempt: Readonly<RunAttemptRecord>;
}

export interface CreateApprovedRunCommand {
  snapshot: Readonly<ApprovedActionDispatchExecutionSnapshot>;
  plan: Readonly<ApprovedRunCreationPlan>;
}

export interface ApprovedRunActionRepository {
  /** Creates the Run aggregate and its bound success receipt atomically. */
  create(
    command: Readonly<CreateApprovedRunCommand>,
  ): Promise<Readonly<ApprovedRunReference>>;
}
