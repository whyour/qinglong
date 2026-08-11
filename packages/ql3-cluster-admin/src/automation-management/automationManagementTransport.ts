import {
  assertTaskDefinitionIdentifier,
  assertTaskDefinitionPageSize,
  normalizeTaskDefinitionCursor,
  type AppendTaskDefinitionRevisionCommand,
  type TaskDefinitionRecord,
} from '@qinglong/runtime-core/task-definition';
import {
  assertTriggerIdentifier,
  assertTriggerPageSize,
  normalizeTriggerCursor,
  type AppendTriggerRevisionCommand,
  type TriggerRecord,
} from '@qinglong/runtime-core/trigger';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import type { ClusterAutomationManagementService } from './automationManagement';

const STRONG_CLUSTER_ASSURANCES = new Set(['multi_factor', 'hardware']);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUDIT_EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ClusterAutomationManagementAuthentication {
  authenticate(): Promise<Readonly<SecurityPrincipal> | null>;
}

export type ClusterAutomationManagementCommand =
  | Readonly<{
      schemaVersion: 1;
      operation: 'task.publish';
      request: Readonly<{
        requestId: string;
        command: AppendTaskDefinitionRevisionCommand;
      }>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'trigger.publish';
      request: Readonly<{
        requestId: string;
        command: AppendTriggerRevisionCommand;
      }>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'task.inspect';
      request: Readonly<{
        requestId: string;
        auditEventId: string;
        projectId: string;
        taskId: string;
      }>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'task.list';
      request: Readonly<{
        requestId: string;
        auditEventId: string;
        projectId: string;
        limit: number;
        after?: Readonly<{ taskId: string }>;
      }>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'trigger.inspect';
      request: Readonly<{
        requestId: string;
        auditEventId: string;
        projectId: string;
        triggerId: string;
      }>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'trigger.list';
      request: Readonly<{
        requestId: string;
        auditEventId: string;
        projectId: string;
        limit: number;
        after?: Readonly<{ triggerId: string }>;
      }>;
    }>;

export type ClusterAutomationManagementTransportResult =
  | Readonly<{
      schemaVersion: 1;
      operation: 'task.publish';
      status: 'created' | 'updated' | 'existing';
      task: ReturnType<typeof taskSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'trigger.publish';
      status: 'created' | 'updated' | 'existing';
      trigger: ReturnType<typeof triggerSummary>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'task.inspect';
      status: 'found' | 'absent';
      task: ReturnType<typeof taskSummary> | null;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'task.list';
      tasks: readonly ReturnType<typeof taskSummary>[];
      truncated: boolean;
      next: Readonly<{ taskId: string }> | null;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'trigger.inspect';
      status: 'found' | 'absent';
      trigger: ReturnType<typeof triggerSummary> | null;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'trigger.list';
      triggers: readonly ReturnType<typeof triggerSummary>[];
      truncated: boolean;
      next: Readonly<{ triggerId: string }> | null;
    }>;

export interface ClusterAutomationManagementTransport {
  execute(
    command: unknown,
    authentication: ClusterAutomationManagementAuthentication,
  ): Promise<Readonly<ClusterAutomationManagementTransportResult>>;
}

export class ClusterAutomationManagementTransportConfigurationError extends TypeError {
  readonly code = 'CLUSTER_AUTOMATION_TRANSPORT_CONFIGURATION_INVALID';

  constructor() {
    super('Cluster automation transport configuration is invalid');
    this.name = 'ClusterAutomationManagementTransportConfigurationError';
  }
}

export class ClusterAutomationManagementTransportRequestError extends TypeError {
  readonly code = 'CLUSTER_AUTOMATION_TRANSPORT_REQUEST_INVALID';

  constructor() {
    super('Cluster automation transport request is invalid');
    this.name = 'ClusterAutomationManagementTransportRequestError';
  }
}

export class ClusterAutomationManagementTransportAuthenticationError extends Error {
  readonly code = 'CLUSTER_AUTOMATION_TRANSPORT_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Cluster automation transport requires a strong User principal');
    this.name = 'ClusterAutomationManagementTransportAuthenticationError';
  }
}

export class ClusterAutomationManagementTransportUnavailableError extends Error {
  readonly code = 'CLUSTER_AUTOMATION_TRANSPORT_UNAVAILABLE';

  constructor() {
    super('Cluster automation transport is unavailable');
    this.name = 'ClusterAutomationManagementTransportUnavailableError';
  }
}

function normalizeCommand(value: unknown): ClusterAutomationManagementCommand {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    ![
      'task.publish',
      'trigger.publish',
      'task.inspect',
      'task.list',
      'trigger.inspect',
      'trigger.list',
    ].includes(String((value as { operation?: unknown }).operation)) ||
    !Object.hasOwn(value, 'request') ||
    !(value as { request?: unknown }).request ||
    typeof (value as { request: unknown }).request !== 'object' ||
    Array.isArray((value as { request: unknown }).request) ||
    !Object.hasOwn((value as { request: object }).request, 'requestId')
  ) {
    throw new ClusterAutomationManagementTransportRequestError();
  }
  const operation = (value as { operation: string }).operation;
  const request = (value as { request: Record<string, unknown> }).request;
  const keys = Object.keys(request);
  const required = operation.endsWith('.publish')
    ? ['command', 'requestId']
    : operation.endsWith('.inspect')
      ? [
          'auditEventId',
          operation.startsWith('task.') ? 'taskId' : 'triggerId',
          'projectId',
          'requestId',
        ]
      : ['auditEventId', 'limit', 'projectId', 'requestId'];
  const optional = operation.endsWith('.list') ? ['after'] : [];
  if (
    !required.every((key) => keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new ClusterAutomationManagementTransportRequestError();
  }
  if (
    typeof request.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(request.requestId)
  ) {
    throw new ClusterAutomationManagementTransportRequestError();
  }
  if (!operation.endsWith('.publish')) {
    if (
      typeof request.auditEventId !== 'string' ||
      !AUDIT_EVENT_ID_PATTERN.test(request.auditEventId) ||
      typeof request.projectId !== 'string'
    ) {
      throw new ClusterAutomationManagementTransportRequestError();
    }
    try {
      if (operation.startsWith('task.')) {
        assertTaskDefinitionIdentifier(request.projectId, 'projectId');
        if (operation === 'task.inspect') {
          assertTaskDefinitionIdentifier(request.taskId as string, 'taskId');
        } else {
          assertTaskDefinitionPageSize(request.limit as number);
          if (Object.hasOwn(request, 'after')) {
            normalizeTaskDefinitionCursor(
              request.after as Readonly<{ taskId: string }>,
            );
          }
        }
      } else {
        assertTriggerIdentifier(request.projectId, 'projectId');
        if (operation === 'trigger.inspect') {
          assertTriggerIdentifier(request.triggerId as string, 'triggerId');
        } else {
          assertTriggerPageSize(request.limit as number);
          if (Object.hasOwn(request, 'after')) {
            normalizeTriggerCursor(
              request.after as Readonly<{ triggerId: string }>,
            );
          }
        }
      }
    } catch {
      throw new ClusterAutomationManagementTransportRequestError();
    }
  }
  return value as ClusterAutomationManagementCommand;
}

export function normalizeClusterAutomationManagementCommand(
  value: unknown,
): Readonly<ClusterAutomationManagementCommand> {
  return normalizeCommand(value);
}

function taskSummary(definition: Readonly<TaskDefinitionRecord>) {
  return Object.freeze({
    projectId: definition.projectId,
    taskId: definition.taskId,
    revision: definition.revision,
    kind: definition.kind,
    enabled: definition.enabled,
    contentDigest: definition.contentDigest,
    updatedAtMs: definition.updatedAtMs,
  });
}

function triggerSummary(trigger: Readonly<TriggerRecord>) {
  return Object.freeze({
    projectId: trigger.projectId,
    triggerId: trigger.triggerId,
    revision: trigger.revision,
    taskId: trigger.taskId,
    taskRevision: trigger.taskRevision,
    taskContentDigest: trigger.taskContentDigest,
    enabled: trigger.enabled,
    contentDigest: trigger.contentDigest,
    updatedAtMs: trigger.updatedAtMs,
  });
}

export function createClusterAutomationManagementTransport(options: Readonly<{
  service: ClusterAutomationManagementService;
  now?: () => number;
}>): Readonly<ClusterAutomationManagementTransport> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'service' && key !== 'now') ||
    !options.service ||
    typeof options.service.publishTask !== 'function' ||
    typeof options.service.publishTrigger !== 'function' ||
    typeof options.service.inspectTask !== 'function' ||
    typeof options.service.listTasks !== 'function' ||
    typeof options.service.inspectTrigger !== 'function' ||
    typeof options.service.listTriggers !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new ClusterAutomationManagementTransportConfigurationError();
  }
  const now = options.now ?? Date.now;
  return Object.freeze({
    async execute(
      commandValue: unknown,
      authentication: ClusterAutomationManagementAuthentication,
    ) {
      const command = normalizeCommand(commandValue);
      if (
        !authentication ||
        typeof authentication !== 'object' ||
        Array.isArray(authentication) ||
        Object.keys(authentication).length !== 1 ||
        typeof authentication.authenticate !== 'function'
      ) {
        throw new ClusterAutomationManagementTransportConfigurationError();
      }
      let candidate: Readonly<SecurityPrincipal> | null;
      try {
        candidate = await authentication.authenticate();
      } catch {
        throw new ClusterAutomationManagementTransportUnavailableError();
      }
      let principal: Readonly<SecurityPrincipal>;
      try {
        principal = normalizeSecurityPrincipal(candidate as SecurityPrincipal, now());
      } catch {
        throw new ClusterAutomationManagementTransportAuthenticationError();
      }
      if (
        principal.subject.type !== 'user' ||
        !STRONG_CLUSTER_ASSURANCES.has(principal.assurance)
      ) {
        throw new ClusterAutomationManagementTransportAuthenticationError();
      }
      if (command.operation === 'task.publish') {
        const result = await options.service.publishTask({
          ...command.request,
          principal,
        });
        return Object.freeze({
          schemaVersion: 1 as const,
          operation: command.operation,
          status: result.status,
          task: taskSummary(result.definition),
        });
      }
      if (command.operation === 'trigger.publish') {
        const result = await options.service.publishTrigger({
          ...command.request,
          principal,
        });
        return Object.freeze({
          schemaVersion: 1 as const,
          operation: command.operation,
          status: result.status,
          trigger: triggerSummary(result.trigger),
        });
      }
      if (command.operation === 'task.inspect') {
        const task = await options.service.inspectTask({
          ...command.request,
          principal,
        });
        return Object.freeze({
          schemaVersion: 1 as const,
          operation: command.operation,
          status: task ? ('found' as const) : ('absent' as const),
          task: task ? taskSummary(task) : null,
        });
      }
      if (command.operation === 'task.list') {
        const page = await options.service.listTasks({
          ...command.request,
          principal,
        });
        return Object.freeze({
          schemaVersion: 1 as const,
          operation: command.operation,
          tasks: Object.freeze(page.definitions.map(taskSummary)),
          truncated: page.truncated,
          next: page.next ?? null,
        });
      }
      if (command.operation === 'trigger.inspect') {
        const trigger = await options.service.inspectTrigger({
          ...command.request,
          principal,
        });
        return Object.freeze({
          schemaVersion: 1 as const,
          operation: command.operation,
          status: trigger ? ('found' as const) : ('absent' as const),
          trigger: trigger ? triggerSummary(trigger) : null,
        });
      }
      const page = await options.service.listTriggers({
        ...command.request,
        principal,
      });
      return Object.freeze({
        schemaVersion: 1 as const,
        operation: command.operation,
        triggers: Object.freeze(page.triggers.map(triggerSummary)),
        truncated: page.truncated,
        next: page.next ?? null,
      });
    },
  });
}
