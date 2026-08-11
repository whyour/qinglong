import { normalizeProjectPolicySubject } from '../../../security/project-policy/projectPolicy';
import { normalizeSecurityAuditRecord } from '../../../security/audit/securityAudit';
import { RUN_CANCELLATION_REASONS, RUN_STATUSES } from '../../../run/run';

import {
  MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_PAGE_SIZE,
  PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_SCHEMA,
  type AuthorizedPluginPackageWorkflowRunList,
  type PluginPackageWorkflowRunListCursor,
  type PluginPackageWorkflowRunListItem,
  type PluginPackageWorkflowRunListResult,
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

function normalizeWorkflowRunListCursor(
  value: PluginPackageWorkflowRunListCursor,
  label: string,
): Readonly<PluginPackageWorkflowRunListCursor> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['admittedAtMs', 'runId']) ||
    !Number.isSafeInteger(value.admittedAtMs) ||
    value.admittedAtMs < 0
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      `${label} is invalid`,
    );
  }
  return Object.freeze({
    admittedAtMs: value.admittedAtMs,
    runId: identifier(value.runId, `${label}.runId`),
  });
}

function workflowRunListPositionBefore(
  left: Readonly<PluginPackageWorkflowRunListCursor>,
  right: Readonly<PluginPackageWorkflowRunListCursor>,
): boolean {
  return (
    left.admittedAtMs < right.admittedAtMs ||
    (left.admittedAtMs === right.admittedAtMs && left.runId < right.runId)
  );
}

export function normalizeAuthorizedPluginPackageWorkflowRunList(
  value: AuthorizedPluginPackageWorkflowRunList,
): Readonly<AuthorizedPluginPackageWorkflowRunList> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'actor',
      'after',
      'audit',
      'fence',
      'limit',
      'packageName',
      'projectId',
      'workflowId',
    ])
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'run list shape is invalid',
    );
  }
  try {
    const projectId = identifier(value.projectId, 'projectId');
    const normalizedPackageName = packageName(value.packageName);
    const workflowId = resourceId(value.workflowId, 'workflowId');
    if (
      !Number.isSafeInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_PAGE_SIZE
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'run list limit is invalid',
      );
    }
    const after =
      value.after === null
        ? null
        : normalizeWorkflowRunListCursor(value.after, 'run list cursor');
    const actor = normalizeProjectPolicySubject(value.actor);
    const fence = normalizeFence(value.fence);
    const audit = normalizeSecurityAuditRecord(value.audit);
    if (
      audit.operationId !== 'workflow.run.list' ||
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
        'run list audit binding is invalid',
      );
    }
    return Object.freeze({
      projectId,
      packageName: normalizedPackageName,
      workflowId,
      limit: value.limit,
      after,
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
      'run list value is invalid',
    );
  }
}

function normalizeWorkflowRunListItem(
  value: PluginPackageWorkflowRunListItem,
): Readonly<PluginPackageWorkflowRunListItem> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'admittedAtMs',
      'cancelReason',
      'cancelRequestedAtMs',
      'eventSequence',
      'finishedAtMs',
      'queuedAtMs',
      'runId',
      'startedAtMs',
      'status',
      'stepCount',
      'version',
    ]) ||
    !RUN_STATUSES.includes(value.status) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !Number.isSafeInteger(value.eventSequence) ||
    value.eventSequence < 0 ||
    !Number.isSafeInteger(value.stepCount) ||
    value.stepCount < 1 ||
    value.stepCount > 128 ||
    !Number.isSafeInteger(value.admittedAtMs) ||
    value.admittedAtMs < 0
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'run list item is invalid',
    );
  }
  const queuedAtMs = nullableTimestamp(value.queuedAtMs);
  const startedAtMs = nullableTimestamp(value.startedAtMs);
  const finishedAtMs = nullableTimestamp(value.finishedAtMs);
  const cancelRequestedAtMs = nullableTimestamp(value.cancelRequestedAtMs);
  if (
    (cancelRequestedAtMs === null) !== (value.cancelReason === null) ||
    (value.cancelReason !== null &&
      !RUN_CANCELLATION_REASONS.includes(value.cancelReason))
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'run list cancellation state is invalid',
    );
  }
  return Object.freeze({
    runId: identifier(value.runId, 'run list runId'),
    status: value.status,
    version: value.version,
    eventSequence: value.eventSequence,
    stepCount: value.stepCount,
    admittedAtMs: value.admittedAtMs,
    queuedAtMs,
    startedAtMs,
    finishedAtMs,
    cancelRequestedAtMs,
    cancelReason: value.cancelReason,
  });
}

export function normalizePluginPackageWorkflowRunListResult(
  value: PluginPackageWorkflowRunListResult,
): Readonly<PluginPackageWorkflowRunListResult> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'after',
      'next',
      'packageName',
      'projectId',
      'runs',
      'schema',
      'truncated',
      'workflowId',
    ]) ||
    value.schema !== PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_SCHEMA ||
    !Array.isArray(value.runs) ||
    value.runs.length > MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_PAGE_SIZE ||
    typeof value.truncated !== 'boolean'
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'run list result shape is invalid',
    );
  }
  const projectId = identifier(value.projectId, 'projectId');
  const normalizedPackageName = packageName(value.packageName);
  const workflowId = resourceId(value.workflowId, 'workflowId');
  const after =
    value.after === null
      ? null
      : normalizeWorkflowRunListCursor(value.after, 'run list result cursor');
  const runs = value.runs.map(normalizeWorkflowRunListItem);
  const ids = new Set<string>();
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!;
    const position = { admittedAtMs: run.admittedAtMs, runId: run.runId };
    if (ids.has(run.runId)) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'run list identities are not unique',
      );
    }
    ids.add(run.runId);
    const previous = index === 0 ? after : runs[index - 1]!;
    if (
      previous !== null &&
      !workflowRunListPositionBefore(position, {
        admittedAtMs: previous.admittedAtMs,
        runId: previous.runId,
      })
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'run list order is invalid',
      );
    }
  }
  const next =
    value.next === null
      ? null
      : normalizeWorkflowRunListCursor(value.next, 'run list next cursor');
  const last = runs.at(-1);
  if (
    (value.truncated &&
      (!last ||
        !next ||
        next.admittedAtMs !== last.admittedAtMs ||
        next.runId !== last.runId)) ||
    (!value.truncated && next !== null)
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'run list continuation is invalid',
    );
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_SCHEMA,
    projectId,
    packageName: normalizedPackageName,
    workflowId,
    after,
    runs: Object.freeze(runs),
    truncated: value.truncated,
    next,
  });
}
