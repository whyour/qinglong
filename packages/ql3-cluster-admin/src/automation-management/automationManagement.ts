/** Automation-management application service boundary. */
import {
  InvalidTaskDefinitionError,
  TaskDefinitionConflictError,
  TaskDefinitionUnavailableError,
  assertTaskDefinitionIdentifier,
  assertTaskDefinitionPageSize,
  normalizeAppendTaskDefinitionRevisionCommand,
  normalizeTaskDefinitionCursor,
  type AppendTaskDefinitionRevisionCommand,
  type TaskDefinitionCursor,
  type TaskDefinitionPage,
  type TaskDefinitionRecord,
} from '@qinglong/runtime-core/task-definition';
import {
  InvalidTaskDefinitionAdministrationReadError,
  InvalidTaskDefinitionAdministrationMutationError,
  TaskDefinitionAdministrationAuthorizationFenceConflictError,
  TaskDefinitionAdministrationMutationConflictError,
  TaskDefinitionAdministrationReadConflictError,
  type TaskDefinitionAdministrationRepository,
  type TaskDefinitionAdministrationSource,
} from '@qinglong/runtime-core/task-definition-administration';
import {
  InvalidTriggerError,
  TriggerConflictError,
  TriggerUnavailableError,
  assertTriggerIdentifier,
  assertTriggerPageSize,
  normalizeAppendTriggerRevisionCommand,
  normalizeTriggerCursor,
  type AppendTriggerRevisionCommand,
  type TriggerCursor,
  type TriggerPage,
  type TriggerRecord,
} from '@qinglong/runtime-core/trigger';
import {
  InvalidTriggerAdministrationReadError,
  InvalidTriggerAdministrationMutationError,
  TriggerAdministrationAuthorizationFenceConflictError,
  TriggerAdministrationMutationConflictError,
  TriggerAdministrationReadConflictError,
  type TriggerAdministrationRepository,
  type TriggerAdministrationSource,
} from '@qinglong/runtime-core/trigger-administration';
import type { ProjectPermission } from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUDIT_EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRONG_USER_ASSURANCES = new Set(['multi_factor', 'hardware']);

export interface ClusterAutomationManagementPolicy {
  authorize(
    principal: Readonly<SecurityPrincipal>,
    projectId: string,
    permission: ProjectPermission,
  ): Promise<Readonly<SecurityPolicyDecision>>;
}

export interface ClusterAutomationManagementService {
  publishTask(request: Readonly<{
    requestId: string;
    command: AppendTaskDefinitionRevisionCommand;
    principal: SecurityPrincipal;
  }>): Promise<Readonly<{
    status: 'created' | 'updated' | 'existing';
    definition: TaskDefinitionRecord;
  }>>;
  publishTrigger(request: Readonly<{
    requestId: string;
    command: AppendTriggerRevisionCommand;
    principal: SecurityPrincipal;
  }>): Promise<Readonly<{
    status: 'created' | 'updated' | 'existing';
    trigger: TriggerRecord;
  }>>;
  inspectTask(request: Readonly<{
    requestId: string;
    auditEventId: string;
    projectId: string;
    taskId: string;
    principal: SecurityPrincipal;
  }>): Promise<TaskDefinitionRecord | null>;
  listTasks(request: Readonly<{
    requestId: string;
    auditEventId: string;
    projectId: string;
    limit: number;
    after?: TaskDefinitionCursor;
    principal: SecurityPrincipal;
  }>): Promise<TaskDefinitionPage>;
  inspectTrigger(request: Readonly<{
    requestId: string;
    auditEventId: string;
    projectId: string;
    triggerId: string;
    principal: SecurityPrincipal;
  }>): Promise<TriggerRecord | null>;
  listTriggers(request: Readonly<{
    requestId: string;
    auditEventId: string;
    projectId: string;
    limit: number;
    after?: TriggerCursor;
    principal: SecurityPrincipal;
  }>): Promise<TriggerPage>;
}

export interface ClusterAutomationManagementOptions {
  readonly policy: ClusterAutomationManagementPolicy;
  readonly taskDefinitions: TaskDefinitionAdministrationRepository &
    TaskDefinitionAdministrationSource;
  readonly triggers: TriggerAdministrationRepository &
    TriggerAdministrationSource;
  readonly now?: () => number;
}

export class ClusterAutomationManagementRequestError extends TypeError {
  readonly code = 'CLUSTER_AUTOMATION_MANAGEMENT_REQUEST_INVALID';

  constructor() {
    super('Cluster automation management request is invalid');
    this.name = 'ClusterAutomationManagementRequestError';
  }
}

export class ClusterAutomationManagementAuthorizationError extends Error {
  readonly code = 'CLUSTER_AUTOMATION_MANAGEMENT_FORBIDDEN';

  constructor() {
    super('Cluster automation management is forbidden');
    this.name = 'ClusterAutomationManagementAuthorizationError';
  }
}

export class ClusterAutomationManagementConflictError extends Error {
  readonly code = 'CLUSTER_AUTOMATION_MANAGEMENT_CONFLICT';

  constructor() {
    super('Cluster automation management conflicts with durable state');
    this.name = 'ClusterAutomationManagementConflictError';
  }
}

export class ClusterAutomationManagementUnavailableError extends Error {
  readonly code = 'CLUSTER_AUTOMATION_MANAGEMENT_UNAVAILABLE';

  constructor() {
    super('Cluster automation management is unavailable');
    this.name = 'ClusterAutomationManagementUnavailableError';
  }
}

function exactRequest(value: unknown): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, 'requestId') ||
    !Object.hasOwn(value, 'command') ||
    !Object.hasOwn(value, 'principal') ||
    typeof (value as { requestId?: unknown }).requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test((value as { requestId: string }).requestId)
  ) {
    throw new ClusterAutomationManagementRequestError();
  }
}

function mapMutationError(error: unknown): never {
  if (
    error instanceof InvalidTaskDefinitionError ||
    error instanceof InvalidTaskDefinitionAdministrationMutationError ||
    error instanceof InvalidTriggerError ||
    error instanceof InvalidTriggerAdministrationMutationError
  ) {
    throw new ClusterAutomationManagementRequestError();
  }
  if (
    error instanceof TaskDefinitionConflictError ||
    error instanceof TaskDefinitionAdministrationAuthorizationFenceConflictError ||
    error instanceof TaskDefinitionAdministrationMutationConflictError ||
    error instanceof TriggerConflictError ||
    error instanceof TriggerAdministrationAuthorizationFenceConflictError ||
    error instanceof TriggerAdministrationMutationConflictError
  ) {
    throw new ClusterAutomationManagementConflictError();
  }
  if (
    error instanceof TaskDefinitionUnavailableError ||
    error instanceof TriggerUnavailableError
  ) {
    throw new ClusterAutomationManagementUnavailableError();
  }
  throw new ClusterAutomationManagementUnavailableError();
}

function mapReadError(error: unknown): never {
  if (
    error instanceof InvalidTaskDefinitionError ||
    error instanceof InvalidTaskDefinitionAdministrationReadError ||
    error instanceof InvalidTriggerError ||
    error instanceof InvalidTriggerAdministrationReadError
  ) {
    throw new ClusterAutomationManagementRequestError();
  }
  if (
    error instanceof TaskDefinitionAdministrationAuthorizationFenceConflictError ||
    error instanceof TaskDefinitionAdministrationReadConflictError ||
    error instanceof TriggerAdministrationAuthorizationFenceConflictError ||
    error instanceof TriggerAdministrationReadConflictError
  ) {
    throw new ClusterAutomationManagementConflictError();
  }
  throw new ClusterAutomationManagementUnavailableError();
}

function exactReadBase(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClusterAutomationManagementRequestError();
  }
  const keys = Object.keys(value);
  if (
    !required.every((key) => keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key)) ||
    typeof (value as { requestId?: unknown }).requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test((value as { requestId: string }).requestId) ||
    typeof (value as { auditEventId?: unknown }).auditEventId !== 'string' ||
    !AUDIT_EVENT_ID_PATTERN.test(
      (value as { auditEventId: string }).auditEventId,
    )
  ) {
    throw new ClusterAutomationManagementRequestError();
  }
}

function readAudit(
  request: Readonly<{
    requestId: string;
    auditEventId: string;
    projectId: string;
  }>,
  operationId: 'task.read' | 'trigger.read',
  authority: Readonly<{
    principal: Readonly<SecurityPrincipal>;
    decision: Readonly<SecurityPolicyDecision>;
    observedAtMs: number;
  }>,
) {
  return Object.freeze({
    eventId: request.auditEventId,
    requestId: request.requestId,
    operationId,
    projectId: request.projectId,
    subject: authority.principal.subject,
    authenticationId: authority.principal.authenticationId,
    outcome: 'allowed' as const,
    reasons: authority.decision.reasons,
    fence: authority.decision.fence,
    occurredAtMs: authority.observedAtMs,
  });
}

export function createClusterAutomationManagementService(
  options: ClusterAutomationManagementOptions,
): Readonly<ClusterAutomationManagementService> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        key !== 'policy' &&
        key !== 'taskDefinitions' &&
        key !== 'triggers' &&
        key !== 'now',
    ) ||
    !options.policy ||
    typeof options.policy.authorize !== 'function' ||
    !options.taskDefinitions ||
    typeof options.taskDefinitions.appendAuthorizedTaskDefinitionRevision !==
      'function' ||
    typeof options.taskDefinitions.findAuthorizedCurrentTaskDefinition !==
      'function' ||
    typeof options.taskDefinitions.listAuthorizedTaskDefinitions !==
      'function' ||
    !options.triggers ||
    typeof options.triggers.appendAuthorizedTriggerRevision !== 'function' ||
    typeof options.triggers.findAuthorizedCurrentTrigger !== 'function' ||
    typeof options.triggers.listAuthorizedTriggers !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new TypeError('Cluster automation management options are invalid');
  }
  const now = options.now ?? Date.now;

  const authorize = async (
    principalValue: SecurityPrincipal,
    projectId: string,
    permission: ProjectPermission,
  ) => {
    const observedAtMs = now();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new ClusterAutomationManagementUnavailableError();
    }
    let principal: Readonly<SecurityPrincipal>;
    try {
      principal = normalizeSecurityPrincipal(principalValue, observedAtMs);
    } catch {
      throw new ClusterAutomationManagementAuthorizationError();
    }
    if (
      principal.subject.type !== 'user' ||
      !STRONG_USER_ASSURANCES.has(principal.assurance)
    ) {
      throw new ClusterAutomationManagementAuthorizationError();
    }
    let decision: Readonly<SecurityPolicyDecision>;
    try {
      decision = await options.policy.authorize(
        principal,
        projectId,
        permission,
      );
    } catch {
      throw new ClusterAutomationManagementUnavailableError();
    }
    if (
      decision.effect !== 'allow' ||
      decision.fence === null ||
      decision.fence.bindingVersion === null
    ) {
      throw new ClusterAutomationManagementAuthorizationError();
    }
    return Object.freeze({ principal, decision, observedAtMs });
  };

  return Object.freeze({
    async publishTask(
      request: Parameters<ClusterAutomationManagementService['publishTask']>[0],
    ) {
      exactRequest(request);
      let command: Readonly<AppendTaskDefinitionRevisionCommand>;
      try {
        command = normalizeAppendTaskDefinitionRevisionCommand(request.command);
      } catch (error) {
        return mapMutationError(error);
      }
      const operation =
        command.expectedRevision === null ? 'task.create' : 'task.update';
      const authority = await authorize(
        request.principal,
        command.projectId,
        operation,
      );
      try {
        return await options.taskDefinitions.appendAuthorizedTaskDefinitionRevision(
          {
            command,
            actor: authority.principal.subject,
            fence: authority.decision.fence!,
            audit: {
              eventId: command.mutationId,
              requestId: request.requestId,
              operationId: operation,
              projectId: command.projectId,
              subject: authority.principal.subject,
              authenticationId: authority.principal.authenticationId,
              outcome: 'allowed',
              reasons: authority.decision.reasons,
              fence: authority.decision.fence,
              occurredAtMs: authority.observedAtMs,
            },
          },
        );
      } catch (error) {
        return mapMutationError(error);
      }
    },

    async publishTrigger(
      request: Parameters<ClusterAutomationManagementService['publishTrigger']>[0],
    ) {
      exactRequest(request);
      let command: Readonly<AppendTriggerRevisionCommand>;
      try {
        command = normalizeAppendTriggerRevisionCommand(request.command);
      } catch (error) {
        return mapMutationError(error);
      }
      const operation =
        command.expectedRevision === null
          ? 'trigger.create'
          : 'trigger.update';
      const authority = await authorize(
        request.principal,
        command.projectId,
        operation,
      );
      try {
        return await options.triggers.appendAuthorizedTriggerRevision({
          command,
          actor: authority.principal.subject,
          fence: authority.decision.fence!,
          audit: {
            eventId: command.mutationId,
            requestId: request.requestId,
            operationId: operation,
            projectId: command.projectId,
            subject: authority.principal.subject,
            authenticationId: authority.principal.authenticationId,
            outcome: 'allowed',
            reasons: authority.decision.reasons,
            fence: authority.decision.fence,
            occurredAtMs: authority.observedAtMs,
          },
        });
      } catch (error) {
        return mapMutationError(error);
      }
    },

    async inspectTask(
      request: Parameters<ClusterAutomationManagementService['inspectTask']>[0],
    ) {
      exactReadBase(request, [
        'auditEventId',
        'principal',
        'projectId',
        'requestId',
        'taskId',
      ]);
      try {
        assertTaskDefinitionIdentifier(request.projectId, 'projectId');
        assertTaskDefinitionIdentifier(request.taskId, 'taskId');
      } catch {
        throw new ClusterAutomationManagementRequestError();
      }
      const authority = await authorize(
        request.principal,
        request.projectId,
        'task.read',
      );
      try {
        return await options.taskDefinitions.findAuthorizedCurrentTaskDefinition(
          {
            projectId: request.projectId,
            taskId: request.taskId,
            actor: authority.principal.subject,
            fence: authority.decision.fence!,
            audit: readAudit(request, 'task.read', authority),
          },
        );
      } catch (error) {
        return mapReadError(error);
      }
    },

    async listTasks(
      request: Parameters<ClusterAutomationManagementService['listTasks']>[0],
    ) {
      exactReadBase(
        request,
        [
          'auditEventId',
          'limit',
          'principal',
          'projectId',
          'requestId',
        ],
        ['after'],
      );
      let after: TaskDefinitionCursor | undefined;
      try {
        assertTaskDefinitionIdentifier(request.projectId, 'projectId');
        assertTaskDefinitionPageSize(request.limit);
        after = Object.hasOwn(request, 'after')
          ? normalizeTaskDefinitionCursor(request.after as TaskDefinitionCursor)
          : undefined;
      } catch {
        throw new ClusterAutomationManagementRequestError();
      }
      const authority = await authorize(
        request.principal,
        request.projectId,
        'task.read',
      );
      try {
        return await options.taskDefinitions.listAuthorizedTaskDefinitions({
          projectId: request.projectId,
          limit: request.limit,
          ...(after ? { after } : {}),
          actor: authority.principal.subject,
          fence: authority.decision.fence!,
          audit: readAudit(request, 'task.read', authority),
        });
      } catch (error) {
        return mapReadError(error);
      }
    },

    async inspectTrigger(
      request: Parameters<
        ClusterAutomationManagementService['inspectTrigger']
      >[0],
    ) {
      exactReadBase(request, [
        'auditEventId',
        'principal',
        'projectId',
        'requestId',
        'triggerId',
      ]);
      try {
        assertTriggerIdentifier(request.projectId, 'projectId');
        assertTriggerIdentifier(request.triggerId, 'triggerId');
      } catch {
        throw new ClusterAutomationManagementRequestError();
      }
      const authority = await authorize(
        request.principal,
        request.projectId,
        'trigger.read',
      );
      try {
        return await options.triggers.findAuthorizedCurrentTrigger({
          projectId: request.projectId,
          triggerId: request.triggerId,
          actor: authority.principal.subject,
          fence: authority.decision.fence!,
          audit: readAudit(request, 'trigger.read', authority),
        });
      } catch (error) {
        return mapReadError(error);
      }
    },

    async listTriggers(
      request: Parameters<
        ClusterAutomationManagementService['listTriggers']
      >[0],
    ) {
      exactReadBase(
        request,
        [
          'auditEventId',
          'limit',
          'principal',
          'projectId',
          'requestId',
        ],
        ['after'],
      );
      let after: TriggerCursor | undefined;
      try {
        assertTriggerIdentifier(request.projectId, 'projectId');
        assertTriggerPageSize(request.limit);
        after = Object.hasOwn(request, 'after')
          ? normalizeTriggerCursor(request.after as TriggerCursor)
          : undefined;
      } catch {
        throw new ClusterAutomationManagementRequestError();
      }
      const authority = await authorize(
        request.principal,
        request.projectId,
        'trigger.read',
      );
      try {
        return await options.triggers.listAuthorizedTriggers({
          projectId: request.projectId,
          limit: request.limit,
          ...(after ? { after } : {}),
          actor: authority.principal.subject,
          fence: authority.decision.fence!,
          audit: readAudit(request, 'trigger.read', authority),
        });
      } catch (error) {
        return mapReadError(error);
      }
    },
  });
}
