import {
  APPROVED_RUN_ACTION_TYPE,
  APPROVED_RUN_RECEIPT_RESULT_CODE,
  ApprovedRunActionBindingConflictError,
  InvalidApprovedRunActionError,
  digestApprovedRunCreationPlan,
  normalizeApprovedRunCreationPlan,
  type ApprovedRunCreationPlan,
} from '../domain/approvedRunAction';
import type { ApprovedActionDispatchRecord } from '../domain/approvalRequest';
import type {
  ApprovedActionExecutionContext,
  ApprovedActionExecutionResult,
  ApprovedActionHandler,
  ApprovedActionInspectionResult,
} from '../ports/approvedActionHandler';
import type { ApprovedRunActionPlanResolver } from '../ports/approvedRunActionPlanResolver';
import type { ApprovedRunActionRepository } from '../ports/approvedRunActionRepository';

export class ApprovedRunActionHandler implements ApprovedActionHandler {
  readonly actionType = APPROVED_RUN_ACTION_TYPE;

  constructor(
    private readonly plans: ApprovedRunActionPlanResolver,
    private readonly repository: ApprovedRunActionRepository,
  ) {}

  async inspect(
    dispatch: Readonly<ApprovedActionDispatchRecord>,
  ): Promise<ApprovedActionInspectionResult> {
    if (dispatch.action.actionType !== this.actionType) {
      return { status: 'blocked', resultCode: 'approved_run_type_mismatch' };
    }
    const plan = await this.plans.resolve(dispatch.action.actionRef);
    if (!plan) {
      return { status: 'retry', resultCode: 'approved_run_plan_missing' };
    }
    try {
      const normalized = normalizeApprovedRunCreationPlan(plan);
      if (
        normalized.actionRef !== dispatch.action.actionRef ||
        normalized.projectId !== dispatch.projectId
      ) {
        return {
          status: 'blocked',
          resultCode: 'approved_run_plan_binding_invalid',
        };
      }
      return {
        status: 'ready',
        actionDigest: digestApprovedRunCreationPlan(normalized),
      };
    } catch (error) {
      if (error instanceof InvalidApprovedRunActionError) {
        return { status: 'blocked', resultCode: 'approved_run_plan_invalid' };
      }
      throw error;
    }
  }

  async execute(
    context: Readonly<ApprovedActionExecutionContext>,
  ): Promise<ApprovedActionExecutionResult> {
    if (!this.contextIsBound(context)) {
      return { outcome: 'failed', resultCode: 'approved_run_fence_invalid' };
    }
    const plan = await this.plans.resolve(context.dispatch.action.actionRef);
    if (!plan) {
      return {
        outcome: 'failed',
        resultCode: 'approved_run_plan_disappeared',
      };
    }
    let normalized: Readonly<ApprovedRunCreationPlan>;
    try {
      normalized = normalizeApprovedRunCreationPlan(plan);
    } catch (error) {
      if (error instanceof InvalidApprovedRunActionError) {
        return { outcome: 'failed', resultCode: 'approved_run_plan_changed' };
      }
      throw error;
    }
    if (
      normalized.actionRef !== context.dispatch.action.actionRef ||
      normalized.projectId !== context.dispatch.projectId ||
      digestApprovedRunCreationPlan(normalized) !==
        context.dispatch.action.actionDigest
    ) {
      return { outcome: 'failed', resultCode: 'approved_run_plan_changed' };
    }
    try {
      await this.repository.create({
        snapshot: Object.freeze({
          dispatch: context.dispatch,
          execution: context.execution,
        }),
        plan: normalized,
      });
      return {
        outcome: 'succeeded',
        resultCode: APPROVED_RUN_RECEIPT_RESULT_CODE,
      };
    } catch (error) {
      if (error instanceof ApprovedRunActionBindingConflictError) {
        return {
          outcome: 'failed',
          resultCode: 'approved_run_receipt_conflict',
        };
      }
      throw error;
    }
  }

  private contextIsBound(
    context: Readonly<ApprovedActionExecutionContext>,
  ): boolean {
    return (
      context.dispatch.action.actionType === this.actionType &&
      context.execution.status === 'executing' &&
      context.execution.dispatchId === context.dispatch.id &&
      context.execution.projectId === context.dispatch.projectId &&
      context.execution.startedAtMs !== null &&
      context.execution.leaseOwner === context.fence.owner &&
      context.execution.leaseToken === context.fence.leaseToken &&
      context.execution.version === context.fence.version &&
      context.idempotencyKey === context.dispatch.id
    );
  }
}
