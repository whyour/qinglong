import { normalizeProjectPolicySubject } from '../../../security/project-policy/projectPolicy';
import { normalizeSecurityAuditRecord } from '../../../security/audit/securityAudit';
import { RUN_STATUSES } from '../../../run/run';
import { normalizePluginPackageWorkflowExecutionPlan } from '../pluginPackageWorkflowExecutionPlan';

import {
  PLUGIN_PACKAGE_WORKFLOW_CANCELLATION_STATUSES,
  type AuthorizedPluginPackageWorkflowAdmission,
  type AuthorizedPluginPackageWorkflowCancellation,
  type PluginPackageWorkflowCancellationResult,
} from './contracts';
import { InvalidPluginPackageWorkflowAdministrationMutationError } from './errors';
import {
  exactKeys,
  identifier,
  normalizeFence,
  packageName,
  sameSubject,
} from './support';

export function normalizeAuthorizedPluginPackageWorkflowAdmission(
  value: AuthorizedPluginPackageWorkflowAdmission,
): Readonly<AuthorizedPluginPackageWorkflowAdmission> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['actor', 'audit', 'fence', 'plan'])
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'admission shape is invalid',
    );
  }
  try {
    const plan = normalizePluginPackageWorkflowExecutionPlan(value.plan);
    const actor = normalizeProjectPolicySubject(value.actor);
    const fence = normalizeFence(value.fence);
    const audit = normalizeSecurityAuditRecord(value.audit);
    if (
      audit.operationId !== 'workflow.start' ||
      audit.projectId !== plan.target.projectId ||
      audit.outcome !== 'allowed' ||
      !audit.subject ||
      !sameSubject(audit.subject, actor) ||
      audit.authenticationId === null ||
      audit.occurredAtMs !== plan.plannedAtMs ||
      !audit.fence ||
      audit.fence.projectVersion !== fence.projectVersion ||
      audit.fence.bindingVersion !== fence.bindingVersion
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'audit binding is invalid',
      );
    }
    return Object.freeze({ plan, actor, fence, audit });
  } catch (error) {
    if (
      error instanceof InvalidPluginPackageWorkflowAdministrationMutationError
    ) {
      throw error;
    }
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'admission value is invalid',
    );
  }
}

export function normalizeAuthorizedPluginPackageWorkflowCancellation(
  value: AuthorizedPluginPackageWorkflowCancellation,
): Readonly<AuthorizedPluginPackageWorkflowCancellation> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'actor',
      'audit',
      'fence',
      'mutationId',
      'packageName',
      'projectId',
      'runEventId',
      'runId',
    ])
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'cancellation shape is invalid',
    );
  }
  try {
    const projectId = identifier(value.projectId, 'projectId');
    const normalizedPackageName = packageName(value.packageName);
    const runId = identifier(value.runId, 'runId');
    const mutationId = identifier(value.mutationId, 'mutationId');
    const runEventId = identifier(value.runEventId, 'runEventId');
    const actor = normalizeProjectPolicySubject(value.actor);
    const fence = normalizeFence(value.fence);
    const audit = normalizeSecurityAuditRecord(value.audit);
    if (
      audit.operationId !== 'workflow.cancel' ||
      audit.projectId !== projectId ||
      audit.outcome !== 'allowed' ||
      !audit.subject ||
      !sameSubject(audit.subject, actor) ||
      audit.authenticationId === null ||
      !audit.fence ||
      audit.fence.projectVersion !== fence.projectVersion ||
      audit.fence.bindingVersion !== fence.bindingVersion
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'cancellation audit binding is invalid',
      );
    }
    return Object.freeze({
      projectId,
      packageName: normalizedPackageName,
      runId,
      mutationId,
      runEventId,
      actor,
      fence,
      audit,
    });
  } catch (error) {
    if (
      error instanceof InvalidPluginPackageWorkflowAdministrationMutationError
    ) {
      throw error;
    }
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'cancellation value is invalid',
    );
  }
}

export function normalizePluginPackageWorkflowCancellationResult(
  value: PluginPackageWorkflowCancellationResult,
): Readonly<PluginPackageWorkflowCancellationResult> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'cancellation result is invalid',
    );
  }
  const hasCancellation = value.cancelRequestedAtMs !== undefined;
  if (
    !exactKeys(
      value,
      hasCancellation
        ? [
            'cancelReason',
            'cancelRequestedAtMs',
            'eventSequence',
            'packageName',
            'projectId',
            'runId',
            'runStatus',
            'runVersion',
            'status',
            'workflowId',
          ]
        : [
            'eventSequence',
            'packageName',
            'projectId',
            'runId',
            'runStatus',
            'runVersion',
            'status',
            'workflowId',
          ],
    ) ||
    !PLUGIN_PACKAGE_WORKFLOW_CANCELLATION_STATUSES.includes(value.status) ||
    !RUN_STATUSES.includes(value.runStatus) ||
    !Number.isSafeInteger(value.runVersion) ||
    value.runVersion < 1 ||
    !Number.isSafeInteger(value.eventSequence) ||
    value.eventSequence < 0 ||
    (hasCancellation &&
      (!Number.isSafeInteger(value.cancelRequestedAtMs) ||
        (value.cancelRequestedAtMs as number) < 0 ||
        !['user', 'policy', 'shutdown', 'reconcile', 'timeout'].includes(
          value.cancelReason ?? '',
        ))) ||
    (!hasCancellation && value.cancelReason !== undefined)
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'cancellation result state is invalid',
    );
  }
  return Object.freeze({
    status: value.status,
    projectId: identifier(value.projectId, 'projectId'),
    packageName: packageName(value.packageName),
    workflowId: identifier(value.workflowId, 'workflowId'),
    runId: identifier(value.runId, 'runId'),
    runStatus: value.runStatus,
    runVersion: value.runVersion,
    eventSequence: value.eventSequence,
    ...(hasCancellation
      ? {
          cancelRequestedAtMs: value.cancelRequestedAtMs!,
          cancelReason: value.cancelReason!,
        }
      : {}),
  });
}
