import type {
  ApprovedActionHandler,
  ApprovedActionHandlerExecutionContext,
  ApprovedActionHandlerInspection,
  ApprovedActionHandlerResult,
} from '@qinglong/runtime-core/approved-action-dispatcher';
import {
  InvalidPluginPackageSecretBindingTransitionApprovalPlanError,
  PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_ACTION_TYPE,
  normalizePluginPackageSecretBindingTransitionApprovalPlan,
  pluginPackageSecretBindingTransitionApprovedAction,
  type PluginPackageSecretBindingTransitionApprovalPlanRepository,
} from '@qinglong/runtime-core/plugin-package-secret-binding-transition-approval-plan';
import {
  PluginPackageSecretBindingConflictError,
} from '@qinglong/runtime-core/plugin-package-secret-binding';
import type {
  ApplyPostgresPluginPackageSecretBindingTransitionInput,
  ApplyPostgresPluginPackageSecretBindingTransitionResult,
} from '@qinglong/cluster-postgres/package-executor';

import type { PluginPackageSecretExistenceInspector } from './projectedSecretExistenceInspector';

export interface ClusterPluginPackageSecretBindingTransitionExecutionPort {
  apply(
    input: Readonly<ApplyPostgresPluginPackageSecretBindingTransitionInput>,
  ): Promise<Readonly<ApplyPostgresPluginPackageSecretBindingTransitionResult>>;
}

export class ClusterPluginPackageSecretBindingTransitionApprovedActionHandler
  implements ApprovedActionHandler
{
  readonly actionType = PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_ACTION_TYPE;

  constructor(
    readonly plans: Pick<
      PluginPackageSecretBindingTransitionApprovalPlanRepository,
      'findByActionRef'
    >,
    readonly transitions: ClusterPluginPackageSecretBindingTransitionExecutionPort,
    readonly secrets: PluginPackageSecretExistenceInspector,
  ) {
    if (
      !plans ||
      typeof plans.findByActionRef !== 'function' ||
      !transitions ||
      typeof transitions.apply !== 'function' ||
      !secrets ||
      typeof secrets.assertExists !== 'function'
    ) {
      throw new TypeError('Secret transition Approved Action authority is invalid');
    }
  }

  async inspect(
    dispatch: ApprovedActionHandlerExecutionContext['dispatch'],
  ): Promise<ApprovedActionHandlerInspection> {
    let plan;
    try {
      plan = await this.plans.findByActionRef(dispatch.action.actionRef);
    } catch {
      return Object.freeze({
        status: 'retry',
        resultCode: 'package_secret_transition_plan_unavailable',
      });
    }
    if (!plan) {
      return Object.freeze({
        status: 'blocked',
        resultCode: 'package_secret_transition_plan_missing',
      });
    }
    try {
      const normalized =
        normalizePluginPackageSecretBindingTransitionApprovalPlan(plan);
      if (
        JSON.stringify(dispatch.action) !==
          JSON.stringify(
            pluginPackageSecretBindingTransitionApprovedAction(normalized),
          ) ||
        dispatch.projectId !== normalized.transitionPlan.nextTarget.projectId ||
        dispatch.requestedBy.type !== normalized.requestedBy.type ||
        dispatch.requestedBy.id !== normalized.requestedBy.id ||
        dispatch.createdAtMs > normalized.expiresAtMs
      ) {
        throw new Error('dispatch does not match transition plan');
      }
      const secretRefs =
        normalized.transitionPlan.nextBindingPlan?.entries.flatMap((entry) =>
          entry.secretRef === null ? [] : [entry.secretRef],
        ) ?? [];
      if (secretRefs.length > 0) await this.secrets.assertExists(secretRefs);
      return Object.freeze({
        status: 'ready',
        actionDigest: normalized.approvalPlanDigest,
      });
    } catch {
      return Object.freeze({
        status: 'blocked',
        resultCode: 'package_secret_transition_plan_rejected',
      });
    }
  }

  async execute(
    context: Readonly<ApprovedActionHandlerExecutionContext>,
  ): Promise<Readonly<ApprovedActionHandlerResult>> {
    const startedAtMs = context.execution.startedAtMs;
    if (
      context.execution.status !== 'executing' ||
      startedAtMs === null ||
      context.execution.leaseOwner !== context.fence.owner ||
      context.execution.leaseToken !== context.fence.leaseToken ||
      context.execution.version !== context.fence.version
    ) {
      return Object.freeze({
        outcome: 'failed',
        resultCode: 'package_secret_transition_execution_rejected',
      });
    }
    const plan = await this.plans.findByActionRef(
      context.dispatch.action.actionRef,
    );
    if (!plan) {
      return Object.freeze({
        outcome: 'failed',
        resultCode: 'package_secret_transition_plan_missing',
      });
    }
    const inspection = await this.inspect(context.dispatch);
    if (inspection.status !== 'ready' || startedAtMs > plan.expiresAtMs) {
      return Object.freeze({
        outcome: 'failed',
        resultCode: 'package_secret_transition_plan_rejected',
      });
    }
    try {
      const result = await this.transitions.apply({
        transitionPlan: plan.transitionPlan,
        evidenceDigest: plan.approvalPlanDigest,
        committedAtMs: startedAtMs,
      });
      return Object.freeze({
        outcome: 'succeeded',
        resultCode:
          result.status === 'created'
            ? 'package_secret_transition_committed'
            : 'package_secret_transition_existing',
        resultDigest: result.receipt.receiptDigest,
      });
    } catch (error) {
      if (error instanceof PluginPackageSecretBindingConflictError) {
        return Object.freeze({
          outcome: 'failed',
          resultCode: 'package_secret_transition_conflict',
        });
      }
      if (
        error instanceof
        InvalidPluginPackageSecretBindingTransitionApprovalPlanError
      ) {
        return Object.freeze({
          outcome: 'failed',
          resultCode: 'package_secret_transition_plan_rejected',
        });
      }
      throw error;
    }
  }
}
