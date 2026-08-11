import {
  ClusterPluginPackageManagementClientRequestError,
  executeClusterAuthenticatedManagementClient,
  type ClusterAuthenticatedManagementClientResult,
  type ClusterPluginPackageManagementClientConnectionOptions,
  type ClusterPluginPackageManagementClientPaths,
} from '../management-support/pluginPackageManagementClient';
import {
  normalizeClusterAutomationManagementCommand,
  type ClusterAutomationManagementCommand,
  type ClusterAutomationManagementTransportResult,
} from './automationManagementTransport';

const MANAGEMENT_PATH = '/api/v3/automations/management';
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type ClusterAutomationManagementClientPaths =
  ClusterPluginPackageManagementClientPaths;
export type ClusterAutomationManagementClientConnectionOptions =
  ClusterPluginPackageManagementClientConnectionOptions;
export type ClusterAutomationManagementClientResult =
  ClusterAuthenticatedManagementClientResult<ClusterAutomationManagementTransportResult>;

function invalid(): never {
  throw new ClusterPluginPackageManagementClientRequestError();
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
  return record;
}

function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    CONTROL_PATTERN.test(value)
  ) {
    invalid();
  }
  return value;
}

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) invalid();
  return value;
}

function taskResultSummary(
  value: unknown,
  projectId: string,
  taskId?: string,
): Record<string, unknown> {
  const task = exactRecord(value, [
    'projectId',
    'taskId',
    'revision',
    'kind',
    'enabled',
    'contentDigest',
    'updatedAtMs',
  ]);
  if (
    identifier(task.projectId) !== projectId ||
    (taskId !== undefined && identifier(task.taskId) !== taskId) ||
    identifier(task.kind).length > 64 ||
    typeof task.enabled !== 'boolean' ||
    !Number.isSafeInteger(task.updatedAtMs) ||
    (task.updatedAtMs as number) < 0
  ) {
    invalid();
  }
  identifier(task.taskId);
  positiveRevision(task.revision);
  digest(task.contentDigest);
  return task;
}

function triggerResultSummary(
  value: unknown,
  projectId: string,
  triggerId?: string,
): Record<string, unknown> {
  const trigger = exactRecord(value, [
    'projectId',
    'triggerId',
    'revision',
    'taskId',
    'taskRevision',
    'taskContentDigest',
    'enabled',
    'contentDigest',
    'updatedAtMs',
  ]);
  if (
    identifier(trigger.projectId) !== projectId ||
    (triggerId !== undefined && identifier(trigger.triggerId) !== triggerId) ||
    typeof trigger.enabled !== 'boolean' ||
    !Number.isSafeInteger(trigger.updatedAtMs) ||
    (trigger.updatedAtMs as number) < 0
  ) {
    invalid();
  }
  identifier(trigger.triggerId);
  identifier(trigger.taskId);
  positiveRevision(trigger.revision);
  positiveRevision(trigger.taskRevision);
  digest(trigger.taskContentDigest);
  digest(trigger.contentDigest);
  return trigger;
}

function validateListPage(
  envelope: Record<string, unknown>,
  itemsKey: 'tasks' | 'triggers',
  limit: number,
  afterId: string | undefined,
  idKey: 'taskId' | 'triggerId',
  validateItem: (value: unknown) => Record<string, unknown>,
): void {
  if (
    !Array.isArray(envelope[itemsKey]) ||
    (envelope[itemsKey] as unknown[]).length > limit ||
    typeof envelope.truncated !== 'boolean'
  ) {
    invalid();
  }
  let previous = afterId;
  for (const itemValue of envelope[itemsKey] as unknown[]) {
    const item = validateItem(itemValue);
    const current = identifier(item[idKey]);
    if (previous !== undefined && current <= previous) invalid();
    previous = current;
  }
  if (envelope.truncated) {
    const next = exactRecord(envelope.next, [idKey]);
    const nextId = identifier(next[idKey]);
    if (previous === undefined || nextId !== previous) invalid();
  } else if (envelope.next !== null) {
    invalid();
  }
}

export function validateClusterAutomationManagementClientResult(
  value: unknown,
  command: Readonly<ClusterAutomationManagementCommand>,
): Readonly<ClusterAutomationManagementTransportResult> {
  const operation = command.operation;
  if (operation === 'task.inspect') {
    const envelope = exactRecord(value, [
      'schemaVersion',
      'operation',
      'status',
      'task',
    ]);
    if (
      envelope.schemaVersion !== 1 ||
      envelope.operation !== operation ||
      !['found', 'absent'].includes(String(envelope.status)) ||
      (envelope.status === 'absent') !== (envelope.task === null)
    ) {
      invalid();
    }
    if (envelope.task !== null) {
      taskResultSummary(
        envelope.task,
        command.request.projectId,
        command.request.taskId,
      );
    }
    return Object.freeze(
      envelope as unknown as ClusterAutomationManagementTransportResult,
    );
  }
  if (operation === 'trigger.inspect') {
    const envelope = exactRecord(value, [
      'schemaVersion',
      'operation',
      'status',
      'trigger',
    ]);
    if (
      envelope.schemaVersion !== 1 ||
      envelope.operation !== operation ||
      !['found', 'absent'].includes(String(envelope.status)) ||
      (envelope.status === 'absent') !== (envelope.trigger === null)
    ) {
      invalid();
    }
    if (envelope.trigger !== null) {
      triggerResultSummary(
        envelope.trigger,
        command.request.projectId,
        command.request.triggerId,
      );
    }
    return Object.freeze(
      envelope as unknown as ClusterAutomationManagementTransportResult,
    );
  }
  if (operation === 'task.list') {
    const envelope = exactRecord(value, [
      'schemaVersion',
      'operation',
      'tasks',
      'truncated',
      'next',
    ]);
    if (envelope.schemaVersion !== 1 || envelope.operation !== operation) {
      invalid();
    }
    validateListPage(
      envelope,
      'tasks',
      command.request.limit,
      command.request.after?.taskId,
      'taskId',
      (item) => taskResultSummary(item, command.request.projectId),
    );
    return Object.freeze(
      envelope as unknown as ClusterAutomationManagementTransportResult,
    );
  }
  if (operation === 'trigger.list') {
    const envelope = exactRecord(value, [
      'schemaVersion',
      'operation',
      'triggers',
      'truncated',
      'next',
    ]);
    if (envelope.schemaVersion !== 1 || envelope.operation !== operation) {
      invalid();
    }
    validateListPage(
      envelope,
      'triggers',
      command.request.limit,
      command.request.after?.triggerId,
      'triggerId',
      (item) => triggerResultSummary(item, command.request.projectId),
    );
    return Object.freeze(
      envelope as unknown as ClusterAutomationManagementTransportResult,
    );
  }
  const envelope = exactRecord(
    value,
    operation === 'task.publish'
      ? ['schemaVersion', 'operation', 'status', 'task']
      : ['schemaVersion', 'operation', 'status', 'trigger'],
  );
  if (
    envelope.schemaVersion !== 1 ||
    envelope.operation !== operation ||
    !['created', 'updated', 'existing'].includes(String(envelope.status))
  ) {
    invalid();
  }
  if (command.operation === 'task.publish') {
    const requested = command.request.command;
    taskResultSummary(envelope.task, requested.projectId, requested.taskId);
  } else {
    const requested = command.request.command;
    const trigger = triggerResultSummary(
      envelope.trigger,
      requested.projectId,
      requested.triggerId,
    );
    if (
      identifier(trigger.taskId) !== requested.taskId ||
      positiveRevision(trigger.taskRevision) !== requested.taskRevision ||
      digest(trigger.taskContentDigest) !== requested.taskContentDigest
    ) {
      invalid();
    }
  }
  return Object.freeze(
    envelope as unknown as ClusterAutomationManagementTransportResult,
  );
}

const PROTOCOL = Object.freeze({
  managementPath: MANAGEMENT_PATH,
  clientCertificate: 'required' as const,
  normalizeCommand: normalizeClusterAutomationManagementCommand,
  validateResult: validateClusterAutomationManagementClientResult,
});

export async function executeClusterAutomationManagementClient(
  paths: ClusterAutomationManagementClientPaths,
  connectionOptions?: ClusterAutomationManagementClientConnectionOptions,
): Promise<Readonly<ClusterAutomationManagementClientResult>> {
  return executeClusterAuthenticatedManagementClient(
    paths,
    PROTOCOL,
    connectionOptions,
  );
}
