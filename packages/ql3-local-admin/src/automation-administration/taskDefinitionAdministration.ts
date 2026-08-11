import {
  ProjectPolicyEngine,
  ProjectPolicyUnavailableError,
  type ProjectPolicyRepository,
} from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import {
  SecurityAuditUnavailableError,
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';
import {
  assertTaskDefinitionIdentifier,
  assertTaskDefinitionPageSize,
  InvalidTaskDefinitionError,
  normalizeAppendTaskDefinitionRevisionCommand,
  normalizeTaskDefinitionCursor,
  type AppendTaskDefinitionRevisionCommand,
  type TaskDefinitionPage,
  type TaskDefinitionRecord,
  type TaskDefinitionSource,
} from '@qinglong/runtime-core/task-definition';
import type { TaskDefinitionAdministrationRepository } from '@qinglong/runtime-core/task-definition-administration';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STRONG_USER_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);

export interface PutTaskDefinitionRequest
  extends AppendTaskDefinitionRevisionCommand {
  readonly requestId: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectTaskDefinitionRequest {
  readonly projectId: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface ListTaskDefinitionsRequest {
  readonly projectId: string;
  readonly limit: number;
  readonly after?: Readonly<{ readonly taskId: string }>;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface LocalTaskDefinitionAdministrationService {
  put(request: PutTaskDefinitionRequest): Promise<
    Readonly<{
      status: 'created' | 'updated' | 'existing';
      definition: TaskDefinitionRecord;
    }>
  >;
  inspect(
    request: InspectTaskDefinitionRequest,
  ): Promise<Readonly<TaskDefinitionRecord> | null>;
  list(request: ListTaskDefinitionsRequest): Promise<Readonly<TaskDefinitionPage>>;
}

export interface LocalTaskDefinitionAdministrationOptions {
  readonly now?: () => number;
}

export class LocalTaskDefinitionAdministrationConfigurationError extends TypeError {
  readonly code = 'LOCAL_TASK_DEFINITION_ADMINISTRATION_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(`Local TaskDefinition administration configuration is invalid: ${message}`);
    this.name = 'LocalTaskDefinitionAdministrationConfigurationError';
  }
}

export class LocalTaskDefinitionAdministrationAuthenticationError extends Error {
  readonly code = 'LOCAL_TASK_DEFINITION_ADMINISTRATION_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Local TaskDefinition administration requires a strong User');
    this.name = 'LocalTaskDefinitionAdministrationAuthenticationError';
  }
}

export class LocalTaskDefinitionAdministrationAuthorizationError extends Error {
  readonly code = 'LOCAL_TASK_DEFINITION_ADMINISTRATION_FORBIDDEN';

  constructor() {
    super('Local TaskDefinition administration is not authorized');
    this.name = 'LocalTaskDefinitionAdministrationAuthorizationError';
  }
}

export class LocalTaskDefinitionAdministrationUnavailableError extends Error {
  readonly code = 'LOCAL_TASK_DEFINITION_ADMINISTRATION_UNAVAILABLE';

  constructor() {
    super('Local TaskDefinition administration is unavailable');
    this.name = 'LocalTaskDefinitionAdministrationUnavailableError';
  }
}

function exactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function assertRequestIdentity(requestId: string, eventId: string): void {
  if (
    typeof requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(requestId) ||
    typeof eventId !== 'string' ||
    !UUID_V4_PATTERN.test(eventId)
  ) {
    throw new LocalTaskDefinitionAdministrationConfigurationError(
      'request identity is invalid',
    );
  }
}

function clock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalTaskDefinitionAdministrationConfigurationError(
      'clock is invalid',
    );
  }
  return value;
}

function strongUser(
  value: SecurityPrincipal,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  try {
    const principal = normalizeSecurityPrincipal(value, nowMs);
    if (
      principal.subject.type !== 'user' ||
      !STRONG_USER_ASSURANCES.has(principal.assurance)
    ) {
      throw new LocalTaskDefinitionAdministrationAuthenticationError();
    }
    return principal;
  } catch (error) {
    if (error instanceof LocalTaskDefinitionAdministrationAuthenticationError) {
      throw error;
    }
    throw new LocalTaskDefinitionAdministrationAuthenticationError();
  }
}

function auditRecord(options: {
  readonly eventId: string;
  readonly requestId: string;
  readonly operationId: 'task.create' | 'task.update' | 'task.read';
  readonly projectId: string;
  readonly principal: Readonly<SecurityPrincipal> | null;
  readonly outcome: SecurityAuditRecord['outcome'];
  readonly reasons: readonly string[];
  readonly fence: SecurityPolicyDecision['fence'];
  readonly occurredAtMs: number;
}): Readonly<SecurityAuditRecord> {
  return normalizeSecurityAuditRecord({
    eventId: options.eventId,
    requestId: options.requestId,
    operationId: options.operationId,
    projectId: options.projectId,
    subject: options.principal?.subject ?? null,
    authenticationId: options.principal?.authenticationId ?? null,
    outcome: options.outcome,
    reasons: options.reasons,
    fence: options.fence,
    occurredAtMs: options.occurredAtMs,
  });
}

function normalizePutRequest(
  value: PutTaskDefinitionRequest,
): Readonly<{
  requestId: string;
  principal: SecurityPrincipal;
  command: AppendTaskDefinitionRevisionCommand;
}> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(
      value,
      [
        'enabled',
        'expectedRevision',
        'kind',
        'labels',
        'mutationId',
        'name',
        'occurredAtMs',
        'principal',
        'projectId',
        'requestId',
        'spec',
        'taskId',
      ],
      ['description'],
    )
  ) {
    throw new LocalTaskDefinitionAdministrationConfigurationError(
      `put request shape is invalid (${Object.keys(value ?? {}).sort().join(',')})`,
    );
  }
  assertRequestIdentity(value.requestId, value.mutationId);
  try {
    const { principal, requestId, ...definition } = value;
    return Object.freeze({
      requestId,
      principal,
      command: normalizeAppendTaskDefinitionRevisionCommand({
        ...definition,
      }),
    });
  } catch (error) {
    if (error instanceof LocalTaskDefinitionAdministrationConfigurationError) {
      throw error;
    }
    throw new LocalTaskDefinitionAdministrationConfigurationError(
      'put request value is invalid',
    );
  }
}

function normalizeInspectRequest(
  value: InspectTaskDefinitionRequest,
): Readonly<InspectTaskDefinitionRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'auditEventId',
      'principal',
      'projectId',
      'requestId',
      'taskId',
    ])
  ) {
    throw new LocalTaskDefinitionAdministrationConfigurationError(
      'inspect request shape is invalid',
    );
  }
  assertRequestIdentity(value.requestId, value.auditEventId);
  try {
    assertTaskDefinitionIdentifier(value.projectId, 'projectId');
    assertTaskDefinitionIdentifier(value.taskId, 'taskId');
  } catch {
    throw new LocalTaskDefinitionAdministrationConfigurationError(
      'inspect request value is invalid',
    );
  }
  return Object.freeze({ ...value });
}

function normalizeListRequest(
  value: ListTaskDefinitionsRequest,
): Readonly<ListTaskDefinitionsRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(
      value,
      ['auditEventId', 'limit', 'principal', 'projectId', 'requestId'],
      ['after'],
    )
  ) {
    throw new LocalTaskDefinitionAdministrationConfigurationError(
      'list request shape is invalid',
    );
  }
  assertRequestIdentity(value.requestId, value.auditEventId);
  try {
    assertTaskDefinitionIdentifier(value.projectId, 'projectId');
    assertTaskDefinitionPageSize(value.limit);
    return Object.freeze({
      ...value,
      ...(value.after
        ? { after: normalizeTaskDefinitionCursor(value.after) }
        : {}),
    });
  } catch {
    throw new LocalTaskDefinitionAdministrationConfigurationError(
      'list request value is invalid',
    );
  }
}

export function createLocalTaskDefinitionAdministrationService(
  projectPolicy: ProjectPolicyRepository,
  mutations: TaskDefinitionAdministrationRepository,
  source: TaskDefinitionSource,
  audit: SecurityAuditSink,
  options: LocalTaskDefinitionAdministrationOptions = {},
): LocalTaskDefinitionAdministrationService {
  if (
    !projectPolicy ||
    typeof projectPolicy.resolve !== 'function' ||
    !mutations ||
    typeof mutations.appendAuthorizedTaskDefinitionRevision !== 'function' ||
    !source ||
    typeof source.findCurrentTaskDefinition !== 'function' ||
    typeof source.listTaskDefinitions !== 'function' ||
    !audit ||
    typeof audit.record !== 'function' ||
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, options.now === undefined ? [] : ['now']) ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new LocalTaskDefinitionAdministrationConfigurationError(
      'dependencies or options are invalid',
    );
  }
  const policy = new ProjectPolicyEngine(projectPolicy);
  const now = options.now ?? Date.now;

  async function authorize(request: {
    readonly eventId: string;
    readonly requestId: string;
    readonly projectId: string;
    readonly operationId: 'task.create' | 'task.update' | 'task.read';
    readonly permission: 'task.create' | 'task.update' | 'task.read';
    readonly principal: SecurityPrincipal;
    readonly occurredAtMs: number;
  }): Promise<
    Readonly<{
      principal: Readonly<SecurityPrincipal>;
      decision: Readonly<SecurityPolicyDecision>;
    }>
  > {
    let principal: Readonly<SecurityPrincipal>;
    try {
      principal = strongUser(request.principal, request.occurredAtMs);
    } catch (error) {
      try {
        await audit.record(
          auditRecord({
            ...request,
            principal: null,
            outcome: 'authentication_rejected',
            reasons: ['strong_authentication_required'],
            fence: null,
          }),
        );
      } catch {
        throw new LocalTaskDefinitionAdministrationUnavailableError();
      }
      throw error;
    }
    let decision: Readonly<SecurityPolicyDecision>;
    try {
      decision = await policy.authorize(
        principal,
        request.projectId,
        request.permission,
      );
    } catch (error) {
      if (!(error instanceof ProjectPolicyUnavailableError)) {
        throw new LocalTaskDefinitionAdministrationUnavailableError();
      }
      try {
        await audit.record(
          auditRecord({
            ...request,
            principal,
            outcome: 'authorization_unavailable',
            reasons: ['policy_unavailable'],
            fence: null,
          }),
        );
      } catch {
        throw new LocalTaskDefinitionAdministrationUnavailableError();
      }
      throw new LocalTaskDefinitionAdministrationUnavailableError();
    }
    if (decision.effect !== 'allow') {
      try {
        await audit.record(
          auditRecord({
            ...request,
            principal,
            outcome:
              decision.effect === 'require_approval'
                ? 'approval_required'
                : 'denied',
            reasons: decision.reasons,
            fence: decision.fence,
          }),
        );
      } catch {
        throw new LocalTaskDefinitionAdministrationUnavailableError();
      }
      throw new LocalTaskDefinitionAdministrationAuthorizationError();
    }
    if (!decision.fence || decision.fence.bindingVersion === null) {
      throw new LocalTaskDefinitionAdministrationUnavailableError();
    }
    return Object.freeze({ principal, decision });
  }

  return Object.freeze({
    async put(request: PutTaskDefinitionRequest) {
      const occurredAtMs = clock(now);
      const normalized = normalizePutRequest(request);
      if (normalized.command.occurredAtMs > occurredAtMs + 5 * 60_000) {
        throw new LocalTaskDefinitionAdministrationConfigurationError(
          'TaskDefinition occurredAtMs is too far in the future',
        );
      }
      const operationId =
        normalized.command.expectedRevision === null
          ? ('task.create' as const)
          : ('task.update' as const);
      const permission = operationId;
      const authorization = await authorize({
        eventId: normalized.command.mutationId,
        requestId: normalized.requestId,
        projectId: normalized.command.projectId,
        operationId,
        permission,
        principal: normalized.principal,
        occurredAtMs,
      });
      try {
        return await mutations.appendAuthorizedTaskDefinitionRevision({
          command: normalized.command,
          actor: authorization.principal.subject,
          fence: authorization.decision.fence as NonNullable<
            SecurityPolicyDecision['fence']
          >,
          audit: auditRecord({
            eventId: normalized.command.mutationId,
            requestId: normalized.requestId,
            projectId: normalized.command.projectId,
            operationId,
            principal: authorization.principal,
            outcome: 'allowed',
            reasons: authorization.decision.reasons,
            fence: authorization.decision.fence,
            occurredAtMs,
          }),
        });
      } catch (error) {
        if (
          error instanceof InvalidTaskDefinitionError ||
          (error &&
            typeof error === 'object' &&
            'code' in error &&
            typeof error.code === 'string' &&
            (error.code.startsWith('TASK_DEFINITION_') ||
              error.code.startsWith('LOCAL_SQLITE_AUTHENTICATED_')))
        ) {
          throw error;
        }
        throw new LocalTaskDefinitionAdministrationUnavailableError();
      }
    },

    async inspect(request: InspectTaskDefinitionRequest) {
      const normalized = normalizeInspectRequest(request);
      const occurredAtMs = clock(now);
      const authorization = await authorize({
        eventId: normalized.auditEventId,
        requestId: normalized.requestId,
        projectId: normalized.projectId,
        operationId: 'task.read',
        permission: 'task.read',
        principal: normalized.principal,
        occurredAtMs,
      });
      try {
        const definition = await source.findCurrentTaskDefinition(
          normalized.projectId,
          normalized.taskId,
        );
        await audit.record(
          auditRecord({
            eventId: normalized.auditEventId,
            requestId: normalized.requestId,
            projectId: normalized.projectId,
            operationId: 'task.read',
            principal: authorization.principal,
            outcome: 'allowed',
            reasons: authorization.decision.reasons,
            fence: authorization.decision.fence,
            occurredAtMs,
          }),
        );
        return definition;
      } catch (error) {
        if (error instanceof SecurityAuditUnavailableError) {
          throw new LocalTaskDefinitionAdministrationUnavailableError();
        }
        throw error;
      }
    },

    async list(request: ListTaskDefinitionsRequest) {
      const normalized = normalizeListRequest(request);
      const occurredAtMs = clock(now);
      const authorization = await authorize({
        eventId: normalized.auditEventId,
        requestId: normalized.requestId,
        projectId: normalized.projectId,
        operationId: 'task.read',
        permission: 'task.read',
        principal: normalized.principal,
        occurredAtMs,
      });
      try {
        const page = await source.listTaskDefinitions({
          projectId: normalized.projectId,
          limit: normalized.limit,
          ...(normalized.after ? { after: normalized.after } : {}),
        });
        await audit.record(
          auditRecord({
            eventId: normalized.auditEventId,
            requestId: normalized.requestId,
            projectId: normalized.projectId,
            operationId: 'task.read',
            principal: authorization.principal,
            outcome: 'allowed',
            reasons: authorization.decision.reasons,
            fence: authorization.decision.fence,
            occurredAtMs,
          }),
        );
        return page;
      } catch (error) {
        if (error instanceof SecurityAuditUnavailableError) {
          throw new LocalTaskDefinitionAdministrationUnavailableError();
        }
        throw error;
      }
    },
  });
}
