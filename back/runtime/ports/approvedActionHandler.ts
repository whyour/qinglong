import type { ApprovedActionDispatchExecutionSnapshot } from '../domain/approvedActionDispatchExecution';
import type { ApprovedActionDispatchRecord } from '../domain/approvalRequest';

export type ApprovedActionInspectionResult =
  | { status: 'ready'; actionDigest: string }
  | { status: 'retry'; resultCode: string }
  | { status: 'blocked'; resultCode: string };

export interface ApprovedActionExecutionContext {
  dispatch: Readonly<ApprovedActionDispatchRecord>;
  execution: Readonly<ApprovedActionDispatchExecutionSnapshot['execution']>;
  idempotencyKey: string;
  fence: {
    owner: string;
    leaseToken: string;
    version: number;
  };
}

export interface ApprovedActionExecutionResult {
  outcome: 'succeeded' | 'failed' | 'indeterminate';
  resultCode: string;
}

export interface ApprovedActionHandler {
  readonly actionType: string;

  /** Must not perform the approved external side effect. */
  inspect(
    dispatch: Readonly<ApprovedActionDispatchRecord>,
  ): Promise<ApprovedActionInspectionResult>;

  execute(
    context: Readonly<ApprovedActionExecutionContext>,
  ): Promise<ApprovedActionExecutionResult>;
}
