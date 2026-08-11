import { normalizeProjectPolicySubject } from '../../../security/project-policy/projectPolicy';
import { normalizeSecurityAuditRecord } from '../../../security/audit/securityAudit';
import { RUN_CANCELLATION_REASONS, RUN_STATUSES } from '../../../run/run';
import { STEP_RUN_STATUSES, type StepRunStatus } from '../../../run/stepRun';

import {
  PLUGIN_PACKAGE_WORKFLOW_RUN_INSPECTION_SCHEMA,
  type AuthorizedPluginPackageWorkflowRunInspection,
  type PluginPackageWorkflowRunInspectionResult,
} from './contracts';
import { InvalidPluginPackageWorkflowAdministrationMutationError } from './errors';
import {
  exactKeys,
  identifier,
  normalizeFence,
  nullableTimestamp,
  packageName,
  resourceId,
  sameSubject,
} from './support';

export function normalizeAuthorizedPluginPackageWorkflowRunInspection(
  value: AuthorizedPluginPackageWorkflowRunInspection,
): Readonly<AuthorizedPluginPackageWorkflowRunInspection> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'actor',
      'audit',
      'fence',
      'packageName',
      'projectId',
      'runId',
      'workflowId',
    ])
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'run inspection shape is invalid',
    );
  }
  try {
    const projectId = identifier(value.projectId, 'projectId');
    const normalizedPackageName = packageName(value.packageName);
    const workflowId = resourceId(value.workflowId, 'workflowId');
    const runId = identifier(value.runId, 'runId');
    const actor = normalizeProjectPolicySubject(value.actor);
    const fence = normalizeFence(value.fence);
    const audit = normalizeSecurityAuditRecord(value.audit);
    if (
      audit.operationId !== 'workflow.run.read' ||
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
        'run inspection audit binding is invalid',
      );
    }
    return Object.freeze({
      projectId,
      packageName: normalizedPackageName,
      workflowId,
      runId,
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
      'run inspection value is invalid',
    );
  }
}

export function normalizePluginPackageWorkflowRunInspectionResult(
  value: PluginPackageWorkflowRunInspectionResult,
): Readonly<PluginPackageWorkflowRunInspectionResult> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'found',
      'packageName',
      'projectId',
      'run',
      'runId',
      'schema',
      'stepCount',
      'stepStatusCounts',
      'workflowId',
    ]) ||
    value.schema !== PLUGIN_PACKAGE_WORKFLOW_RUN_INSPECTION_SCHEMA ||
    typeof value.found !== 'boolean'
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'run inspection result shape is invalid',
    );
  }
  const projectId = identifier(value.projectId, 'projectId');
  const normalizedPackageName = packageName(value.packageName);
  const workflowId = resourceId(value.workflowId, 'workflowId');
  const runId = identifier(value.runId, 'runId');
  if (!value.found) {
    if (
      value.run !== null ||
      value.stepCount !== null ||
      value.stepStatusCounts !== null
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'missing run inspection result is invalid',
      );
    }
    return Object.freeze({
      schema: PLUGIN_PACKAGE_WORKFLOW_RUN_INSPECTION_SCHEMA,
      found: false,
      projectId,
      packageName: normalizedPackageName,
      workflowId,
      runId,
      run: null,
      stepCount: null,
      stepStatusCounts: null,
    });
  }
  if (
    !value.run ||
    typeof value.run !== 'object' ||
    Array.isArray(value.run) ||
    !exactKeys(value.run, [
      'cancelReason',
      'cancelRequestedAtMs',
      'createdAtMs',
      'eventSequence',
      'finishedAtMs',
      'queuedAtMs',
      'startedAtMs',
      'status',
      'version',
    ]) ||
    !RUN_STATUSES.includes(value.run.status) ||
    !Number.isSafeInteger(value.run.version) ||
    value.run.version < 1 ||
    !Number.isSafeInteger(value.run.eventSequence) ||
    value.run.eventSequence < 0 ||
    !Number.isSafeInteger(value.run.createdAtMs) ||
    value.run.createdAtMs < 0 ||
    !Number.isSafeInteger(value.stepCount) ||
    (value.stepCount as number) < 1 ||
    (value.stepCount as number) > 128 ||
    !value.stepStatusCounts ||
    typeof value.stepStatusCounts !== 'object' ||
    Array.isArray(value.stepStatusCounts) ||
    !exactKeys(value.stepStatusCounts, STEP_RUN_STATUSES)
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'found run inspection result is invalid',
    );
  }
  const queuedAtMs = nullableTimestamp(value.run.queuedAtMs);
  const startedAtMs = nullableTimestamp(value.run.startedAtMs);
  const finishedAtMs = nullableTimestamp(value.run.finishedAtMs);
  const cancelRequestedAtMs = nullableTimestamp(value.run.cancelRequestedAtMs);
  const cancelReason = value.run.cancelReason;
  if (
    (cancelRequestedAtMs === null) !== (cancelReason === null) ||
    (cancelReason !== null && !RUN_CANCELLATION_REASONS.includes(cancelReason))
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'run inspection cancellation state is invalid',
    );
  }
  const counts = Object.fromEntries(
    STEP_RUN_STATUSES.map((status) => {
      const count = value.stepStatusCounts![status];
      if (!Number.isSafeInteger(count) || count < 0 || count > 128) {
        throw new InvalidPluginPackageWorkflowAdministrationMutationError(
          'run inspection StepRun counts are invalid',
        );
      }
      return [status, count];
    }),
  ) as Record<StepRunStatus, number>;
  if (
    Object.values(counts).reduce((total, count) => total + count, 0) !==
    value.stepCount
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'run inspection StepRun count is inconsistent',
    );
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_WORKFLOW_RUN_INSPECTION_SCHEMA,
    found: true,
    projectId,
    packageName: normalizedPackageName,
    workflowId,
    runId,
    run: Object.freeze({
      status: value.run.status,
      version: value.run.version,
      eventSequence: value.run.eventSequence,
      createdAtMs: value.run.createdAtMs,
      queuedAtMs,
      startedAtMs,
      finishedAtMs,
      cancelRequestedAtMs,
      cancelReason,
    }),
    stepCount: value.stepCount,
    stepStatusCounts: Object.freeze(counts),
  });
}
