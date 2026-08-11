import { normalizeProjectPolicySubject } from '../../../security/project-policy/projectPolicy';
import { normalizeSecurityAuditRecord } from '../../../security/audit/securityAudit';

import {
  MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_PAGE_SIZE,
  PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_SCHEMA,
  type AuthorizedPluginPackageWorkflowRunEventList,
  type PluginPackageWorkflowRunEventListItem,
  type PluginPackageWorkflowRunEventListResult,
} from './contracts';
import { InvalidPluginPackageWorkflowAdministrationMutationError } from './errors';
import {
  exactKeys,
  identifier,
  normalizeFence,
  packageName,
  resourceId,
  sameSubject,
} from './support';

export function normalizeAuthorizedPluginPackageWorkflowRunEventList(
  value: AuthorizedPluginPackageWorkflowRunEventList,
): Readonly<AuthorizedPluginPackageWorkflowRunEventList> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'actor',
      'afterSequence',
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
      'RunEvent list shape is invalid',
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
      value.limit > MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_PAGE_SIZE ||
      !Number.isSafeInteger(value.afterSequence) ||
      value.afterSequence < 0
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'RunEvent list page is invalid',
      );
    }
    const actor = normalizeProjectPolicySubject(value.actor);
    const fence = normalizeFence(value.fence);
    const audit = normalizeSecurityAuditRecord(value.audit);
    if (
      audit.operationId !== 'workflow.event.list' ||
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
        'RunEvent list audit binding is invalid',
      );
    }
    return Object.freeze({
      projectId,
      packageName: normalizedPackageName,
      workflowId,
      runId,
      limit: value.limit,
      afterSequence: value.afterSequence,
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
      'RunEvent list value is invalid',
    );
  }
}

const RUN_EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,127}$/;

function normalizeWorkflowRunEventListItem(
  value: PluginPackageWorkflowRunEventListItem,
): Readonly<PluginPackageWorkflowRunEventListItem> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['createdAtMs', 'id', 'sequence', 'stepRunId', 'type']) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    typeof value.type !== 'string' ||
    !RUN_EVENT_TYPE.test(value.type) ||
    !Number.isSafeInteger(value.createdAtMs) ||
    value.createdAtMs < 0
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'RunEvent list item is invalid',
    );
  }
  return Object.freeze({
    id: identifier(value.id, 'RunEvent id'),
    sequence: value.sequence,
    type: value.type,
    stepRunId:
      value.stepRunId === null
        ? null
        : identifier(value.stepRunId, 'RunEvent StepRun id'),
    createdAtMs: value.createdAtMs,
  });
}

export function normalizePluginPackageWorkflowRunEventListResult(
  value: PluginPackageWorkflowRunEventListResult,
): Readonly<PluginPackageWorkflowRunEventListResult> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'afterSequence',
      'events',
      'found',
      'headSequence',
      'nextAfterSequence',
      'packageName',
      'projectId',
      'runId',
      'schema',
      'truncated',
      'workflowId',
    ]) ||
    value.schema !== PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_SCHEMA ||
    typeof value.found !== 'boolean' ||
    typeof value.truncated !== 'boolean' ||
    !Number.isSafeInteger(value.afterSequence) ||
    value.afterSequence < 0 ||
    !Array.isArray(value.events) ||
    value.events.length > MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_PAGE_SIZE
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'RunEvent list result shape is invalid',
    );
  }
  const projectId = identifier(value.projectId, 'projectId');
  const normalizedPackageName = packageName(value.packageName);
  const workflowId = resourceId(value.workflowId, 'workflowId');
  const runId = identifier(value.runId, 'runId');
  if (!value.found) {
    if (
      value.headSequence !== null ||
      value.events.length !== 0 ||
      value.truncated ||
      value.nextAfterSequence !== null
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'missing RunEvent list result is invalid',
      );
    }
    return Object.freeze({
      schema: PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_SCHEMA,
      found: false,
      projectId,
      packageName: normalizedPackageName,
      workflowId,
      runId,
      afterSequence: value.afterSequence,
      headSequence: null,
      events: Object.freeze([]),
      truncated: false,
      nextAfterSequence: null,
    });
  }
  if (
    !Number.isSafeInteger(value.headSequence) ||
    (value.headSequence as number) < 0 ||
    value.afterSequence > (value.headSequence as number)
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'RunEvent list head is invalid',
    );
  }
  const headSequence = value.headSequence as number;
  const events = value.events.map(normalizeWorkflowRunEventListItem);
  const ids = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (
      ids.has(event.id) ||
      event.sequence !== value.afterSequence + index + 1 ||
      event.sequence > headSequence
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'RunEvent list sequence is invalid',
      );
    }
    ids.add(event.id);
  }
  const lastSequence = events.at(-1)?.sequence ?? value.afterSequence;
  let nextAfterSequence: number | null = null;
  if (value.truncated) {
    if (
      events.length === 0 ||
      lastSequence >= headSequence ||
      value.nextAfterSequence !== lastSequence
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'RunEvent list continuation is invalid',
      );
    }
    nextAfterSequence = lastSequence;
  } else if (
    value.nextAfterSequence !== null ||
    lastSequence !== headSequence
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'RunEvent list terminal page is invalid',
    );
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_SCHEMA,
    found: true,
    projectId,
    packageName: normalizedPackageName,
    workflowId,
    runId,
    afterSequence: value.afterSequence,
    headSequence,
    events: Object.freeze(events),
    truncated: value.truncated,
    nextAfterSequence,
  });
}
