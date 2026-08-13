// Cluster Plugin Package Secret binding Approved Action boundary.
import type {
  ApprovedActionHandler,
  ApprovedActionHandlerExecutionContext,
  ApprovedActionHandlerInspection,
  ApprovedActionHandlerResult,
} from '@qinglong/runtime-core/approved-action-dispatcher';
import {
  InvalidPluginPackageSecretBindingApprovalPlanError,
  PLUGIN_PACKAGE_SECRET_BINDING_ACTION_TYPE,
  createPluginPackageSecretBindingFromApprovalPlan,
  normalizePluginPackageSecretBindingApprovalPlan,
  pluginPackageSecretBindingApprovedAction,
  type PluginPackageSecretBindingApprovalPlanRepository,
} from '@qinglong/runtime-core/plugin-package-secret-binding-approval-plan';
import {
  PluginPackageSecretBindingConflictError,
  type PluginPackageSecretBindingRepository,
} from '@qinglong/runtime-core/plugin-package-secret-binding';

import type { PluginPackageSecretExistenceInspector } from './projectedSecretExistenceInspector';

export class ClusterPluginPackageSecretBindingApprovedActionHandler
  implements ApprovedActionHandler
{
  readonly actionType = PLUGIN_PACKAGE_SECRET_BINDING_ACTION_TYPE;

  constructor(
    readonly plans: Pick<
      PluginPackageSecretBindingApprovalPlanRepository,
      'findByActionRef'
    >,
    readonly bindings: PluginPackageSecretBindingRepository,
    readonly secrets: PluginPackageSecretExistenceInspector,
  ) {
    if (
      !plans ||
      typeof plans.findByActionRef !== 'function' ||
      !bindings ||
      typeof bindings.find !== 'function' ||
      typeof bindings.publish !== 'function' ||
      !secrets ||
      typeof secrets.assertExists !== 'function'
    ) {
      throw new TypeError(
        'Secret binding Approved Action authority is invalid',
      );
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
        resultCode: 'package_secret_binding_plan_unavailable',
      });
    }
    if (!plan) {
      return Object.freeze({
        status: 'blocked',
        resultCode: 'package_secret_binding_plan_missing',
      });
    }
    try {
      const normalized = normalizePluginPackageSecretBindingApprovalPlan(plan);
      if (
        JSON.stringify(dispatch.action) !==
          JSON.stringify(pluginPackageSecretBindingApprovedAction(normalized)) ||
        dispatch.projectId !== normalized.bindingPlan.target.projectId ||
        dispatch.requestedBy.type !== normalized.requestedBy.type ||
        dispatch.requestedBy.id !== normalized.requestedBy.id ||
        dispatch.createdAtMs > normalized.expiresAtMs
      ) {
        throw new Error('dispatch does not match Secret binding plan');
      }
      const secretRefs = normalized.bindingPlan.entries.flatMap((entry) =>
        entry.secretRef === null ? [] : [entry.secretRef],
      );
      if (secretRefs.length > 0) {
        await this.secrets.assertExists(secretRefs);
      }
      return Object.freeze({
        status: 'ready',
        actionDigest: normalized.approvalPlanDigest,
      });
    } catch {
      return Object.freeze({
        status: 'blocked',
        resultCode: 'package_secret_binding_plan_rejected',
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
        resultCode: 'package_secret_binding_execution_rejected',
      });
    }
    const plan = await this.plans.findByActionRef(
      context.dispatch.action.actionRef,
    );
    if (!plan) {
      return Object.freeze({
        outcome: 'failed',
        resultCode: 'package_secret_binding_plan_missing',
      });
    }
    const inspection = await this.inspect(context.dispatch);
    if (inspection.status !== 'ready') {
      return Object.freeze({
        outcome: 'failed',
        resultCode: 'package_secret_binding_plan_rejected',
      });
    }
    let binding;
    try {
      binding = createPluginPackageSecretBindingFromApprovalPlan(
        plan,
        startedAtMs,
      );
      const result = await this.bindings.publish(binding);
      return Object.freeze({
        outcome: 'succeeded',
        resultCode:
          result.status === 'created'
            ? 'package_secret_binding_published'
            : 'package_secret_binding_existing',
        resultDigest: result.binding.bindingDigest,
      });
    } catch (error) {
      if (error instanceof PluginPackageSecretBindingConflictError) {
        return Object.freeze({
          outcome: 'failed',
          resultCode: 'package_secret_binding_conflict',
        });
      }
      if (error instanceof InvalidPluginPackageSecretBindingApprovalPlanError) {
        return Object.freeze({
          outcome: 'failed',
          resultCode: 'package_secret_binding_plan_rejected',
        });
      }
      const existing = await this.bindings.find(
        plan.bindingPlan.target.generationDigest,
      );
      if (!existing || !binding || existing.bindingDigest !== binding.bindingDigest) {
        throw error;
      }
      return Object.freeze({
        outcome: 'succeeded',
        resultCode: 'package_secret_binding_existing',
        resultDigest: existing.bindingDigest,
      });
    }
  }
}
