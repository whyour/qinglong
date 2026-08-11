import { normalizeProjectPolicySubject } from '../../../security/project-policy/projectPolicy';
import { normalizeSecurityAuditRecord } from '../../../security/audit/securityAudit';
import { STEP_RUN_KINDS, STEP_RUN_STATUSES } from '../../../run/stepRun';

import {
  MAX_PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_PAGE_SIZE,
  PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_SCHEMA,
  type AuthorizedPluginPackageWorkflowStepRunList,
  type PluginPackageWorkflowStepRunCursor,
  type PluginPackageWorkflowStepRunListItem,
  type PluginPackageWorkflowStepRunListResult,
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

export function normalizeAuthorizedPluginPackageWorkflowStepRunList(
  value: AuthorizedPluginPackageWorkflowStepRunList,
): Readonly<AuthorizedPluginPackageWorkflowStepRunList> {
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
      'runId',
      'workflowId',
    ])
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'StepRun list shape is invalid',
    );
  }
  try {
    const projectId = identifier(value.projectId, 'projectId');
    const normalizedPackageName = packageName(value.packageName);
    const workflowId = resourceId(value.workflowId, 'workflowId');
    const runId = identifier(value.runId, 'runId');
    if (
      !Number.isSafeInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > MAX_PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_PAGE_SIZE
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'StepRun list limit is invalid',
      );
    }
    let after: Readonly<PluginPackageWorkflowStepRunCursor> | null = null;
    if (value.after !== null) {
      if (
        !value.after ||
        typeof value.after !== 'object' ||
        Array.isArray(value.after) ||
        !exactKeys(value.after, ['id', 'stepKey'])
      ) {
        throw new InvalidPluginPackageWorkflowAdministrationMutationError(
          'StepRun list cursor is invalid',
        );
      }
      after = Object.freeze({
        stepKey: resourceId(value.after.stepKey, 'after.stepKey'),
        id: identifier(value.after.id, 'after.id'),
      });
    }
    const actor = normalizeProjectPolicySubject(value.actor);
    const fence = normalizeFence(value.fence);
    const audit = normalizeSecurityAuditRecord(value.audit);
    if (
      audit.operationId !== 'workflow.step.list' ||
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
        'StepRun list audit binding is invalid',
      );
    }
    return Object.freeze({
      projectId,
      packageName: normalizedPackageName,
      workflowId,
      runId,
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
      'StepRun list value is invalid',
    );
  }
}

const STEP_RUN_RESULT_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function normalizeWorkflowStepRunListItem(
  value: PluginPackageWorkflowStepRunListItem,
): Readonly<PluginPackageWorkflowStepRunListItem> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'attemptCount',
      'createdAtMs',
      'finishedAtMs',
      'id',
      'kind',
      'parentStepRunId',
      'readyAtMs',
      'required',
      'resultCode',
      'startedAtMs',
      'status',
      'stepKey',
      'updatedAtMs',
      'version',
    ]) ||
    !STEP_RUN_KINDS.includes(value.kind) ||
    !STEP_RUN_STATUSES.includes(value.status) ||
    typeof value.required !== 'boolean' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    value.version > 2_147_483_647 ||
    !Number.isSafeInteger(value.attemptCount) ||
    value.attemptCount < 0 ||
    value.attemptCount > 64 ||
    !Number.isSafeInteger(value.createdAtMs) ||
    value.createdAtMs < 0 ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'StepRun list item is invalid',
    );
  }
  const id = identifier(value.id, 'StepRun id');
  const parentStepRunId =
    value.parentStepRunId === null
      ? null
      : identifier(value.parentStepRunId, 'parent StepRun id');
  if (parentStepRunId === id) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'StepRun list parent is invalid',
    );
  }
  const stepKey = resourceId(value.stepKey, 'StepRun stepKey');
  const readyAtMs = nullableTimestamp(value.readyAtMs);
  const startedAtMs = nullableTimestamp(value.startedAtMs);
  const finishedAtMs = nullableTimestamp(value.finishedAtMs);
  const resultCode = value.resultCode;
  if (
    (resultCode !== null &&
      (typeof resultCode !== 'string' ||
        !STEP_RUN_RESULT_CODE.test(resultCode))) ||
    (readyAtMs !== null &&
      (readyAtMs < value.createdAtMs || readyAtMs > value.updatedAtMs)) ||
    (startedAtMs !== null &&
      (readyAtMs === null ||
        startedAtMs < readyAtMs ||
        startedAtMs > value.updatedAtMs)) ||
    (finishedAtMs !== null &&
      (finishedAtMs < value.createdAtMs ||
        finishedAtMs > value.updatedAtMs ||
        (readyAtMs !== null && finishedAtMs < readyAtMs) ||
        (startedAtMs !== null && finishedAtMs < startedAtMs))) ||
    (value.status === 'pending' &&
      (readyAtMs !== null || startedAtMs !== null || finishedAtMs !== null)) ||
    ((value.status === 'ready' || value.status === 'waiting_approval') &&
      (readyAtMs === null || startedAtMs !== null || finishedAtMs !== null)) ||
    ((value.status === 'running' || value.status === 'lost') &&
      (readyAtMs === null || startedAtMs === null || finishedAtMs !== null)) ||
    (['succeeded', 'failed', 'skipped', 'cancelled', 'timed_out'].includes(
      value.status,
    ) &&
      finishedAtMs === null) ||
    (value.status === 'succeeded' && resultCode !== null) ||
    (['failed', 'skipped', 'cancelled', 'timed_out', 'lost'].includes(
      value.status,
    ) &&
      resultCode === null) ||
    (['pending', 'ready', 'waiting_approval', 'running'].includes(
      value.status,
    ) &&
      resultCode !== null)
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'StepRun list item state is invalid',
    );
  }
  return Object.freeze({
    id,
    parentStepRunId,
    stepKey,
    kind: value.kind,
    required: value.required,
    status: value.status,
    version: value.version,
    attemptCount: value.attemptCount,
    readyAtMs,
    startedAtMs,
    finishedAtMs,
    resultCode,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
  });
}

export function normalizePluginPackageWorkflowStepRunListResult(
  value: PluginPackageWorkflowStepRunListResult,
): Readonly<PluginPackageWorkflowStepRunListResult> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'found',
      'next',
      'packageName',
      'projectId',
      'runId',
      'schema',
      'stepRuns',
      'truncated',
      'workflowId',
    ]) ||
    value.schema !== PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_SCHEMA ||
    typeof value.found !== 'boolean' ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.stepRuns) ||
    value.stepRuns.length > MAX_PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_PAGE_SIZE
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'StepRun list result shape is invalid',
    );
  }
  const projectId = identifier(value.projectId, 'projectId');
  const normalizedPackageName = packageName(value.packageName);
  const workflowId = resourceId(value.workflowId, 'workflowId');
  const runId = identifier(value.runId, 'runId');
  if (!value.found) {
    if (value.stepRuns.length !== 0 || value.truncated || value.next !== null) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'missing StepRun list result is invalid',
      );
    }
    return Object.freeze({
      schema: PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_SCHEMA,
      found: false,
      projectId,
      packageName: normalizedPackageName,
      workflowId,
      runId,
      stepRuns: Object.freeze([]),
      truncated: false,
      next: null,
    });
  }
  const stepRuns = value.stepRuns.map(normalizeWorkflowStepRunListItem);
  const identities = new Set<string>();
  for (let index = 0; index < stepRuns.length; index += 1) {
    const item = stepRuns[index]!;
    if (identities.has(item.id) || identities.has(`step:${item.stepKey}`)) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'StepRun list identities are duplicated',
      );
    }
    identities.add(item.id);
    identities.add(`step:${item.stepKey}`);
    const previous = stepRuns[index - 1];
    if (
      previous &&
      (previous.stepKey > item.stepKey ||
        (previous.stepKey === item.stepKey && previous.id >= item.id))
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'StepRun list order is invalid',
      );
    }
  }
  let next: Readonly<PluginPackageWorkflowStepRunCursor> | null = null;
  if (value.truncated) {
    const last = stepRuns.at(-1);
    if (
      !last ||
      !value.next ||
      typeof value.next !== 'object' ||
      Array.isArray(value.next) ||
      !exactKeys(value.next, ['id', 'stepKey']) ||
      value.next.id !== last.id ||
      value.next.stepKey !== last.stepKey
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'StepRun list continuation is invalid',
      );
    }
    next = Object.freeze({ id: last.id, stepKey: last.stepKey });
  } else if (value.next !== null) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'StepRun list continuation is unexpected',
    );
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_SCHEMA,
    found: true,
    projectId,
    packageName: normalizedPackageName,
    workflowId,
    runId,
    stepRuns: Object.freeze(stepRuns),
    truncated: value.truncated,
    next,
  });
}
