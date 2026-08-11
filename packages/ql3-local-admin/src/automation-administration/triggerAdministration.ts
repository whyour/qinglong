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
  assertTriggerIdentifier,
  assertTriggerPageSize,
  InvalidTriggerError,
  normalizeAppendTriggerRevisionCommand,
  normalizeTriggerCursor,
  type AppendTriggerRevisionCommand,
  type TriggerPage,
  type TriggerRecord,
  type TriggerSource,
} from '@qinglong/runtime-core/trigger';
import type { TriggerAdministrationRepository } from '@qinglong/runtime-core/trigger-administration';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STRONG_USER_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);

export interface PutTriggerRequest extends AppendTriggerRevisionCommand {
  readonly requestId: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectTriggerRequest {
  readonly projectId: string;
  readonly triggerId: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface ListTriggersRequest {
  readonly projectId: string;
  readonly limit: number;
  readonly after?: Readonly<{ readonly triggerId: string }>;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface LocalTriggerAdministrationService {
  put(request: PutTriggerRequest): Promise<
    Readonly<{
      status: 'created' | 'updated' | 'existing';
      trigger: TriggerRecord;
    }>
  >;
  inspect(
    request: InspectTriggerRequest,
  ): Promise<Readonly<TriggerRecord> | null>;
  list(request: ListTriggersRequest): Promise<Readonly<TriggerPage>>;
}

export interface LocalTriggerAdministrationOptions {
  readonly now?: () => number;
}

export class LocalTriggerAdministrationConfigurationError extends TypeError {
  readonly code = 'LOCAL_TRIGGER_ADMINISTRATION_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(`Local Trigger administration configuration is invalid: ${message}`);
    this.name = 'LocalTriggerAdministrationConfigurationError';
  }
}

export class LocalTriggerAdministrationAuthenticationError extends Error {
  readonly code = 'LOCAL_TRIGGER_ADMINISTRATION_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Local Trigger administration requires a strong User');
    this.name = 'LocalTriggerAdministrationAuthenticationError';
  }
}

export class LocalTriggerAdministrationAuthorizationError extends Error {
  readonly code = 'LOCAL_TRIGGER_ADMINISTRATION_FORBIDDEN';

  constructor() {
    super('Local Trigger administration is not authorized');
    this.name = 'LocalTriggerAdministrationAuthorizationError';
  }
}

export class LocalTriggerAdministrationUnavailableError extends Error {
  readonly code = 'LOCAL_TRIGGER_ADMINISTRATION_UNAVAILABLE';

  constructor() {
    super('Local Trigger administration is unavailable');
    this.name = 'LocalTriggerAdministrationUnavailableError';
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
    throw new LocalTriggerAdministrationConfigurationError(
      'request identity is invalid',
    );
  }
}

function clock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalTriggerAdministrationConfigurationError('clock is invalid');
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
      throw new LocalTriggerAdministrationAuthenticationError();
    }
    return principal;
  } catch (error) {
    if (error instanceof LocalTriggerAdministrationAuthenticationError) {
      throw error;
    }
    throw new LocalTriggerAdministrationAuthenticationError();
  }
}

function auditRecord(options: {
  readonly eventId: string;
  readonly requestId: string;
  readonly operationId: 'trigger.create' | 'trigger.update' | 'trigger.read';
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

function normalizePutRequest(value: PutTriggerRequest): Readonly<{
  requestId: string;
  principal: SecurityPrincipal;
  command: AppendTriggerRevisionCommand;
}> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'enabled',
      'expectedRevision',
      'mutationId',
      'occurredAtMs',
      'principal',
      'projectId',
      'requestId',
      'spec',
      'taskContentDigest',
      'taskId',
      'taskRevision',
      'triggerId',
    ])
  ) {
    throw new LocalTriggerAdministrationConfigurationError(
      'put request shape is invalid',
    );
  }
  assertRequestIdentity(value.requestId, value.mutationId);
  try {
    const { principal, requestId, ...trigger } = value;
    return Object.freeze({
      requestId,
      principal,
      command: normalizeAppendTriggerRevisionCommand(trigger),
    });
  } catch (error) {
    if (error instanceof LocalTriggerAdministrationConfigurationError) {
      throw error;
    }
    throw new LocalTriggerAdministrationConfigurationError(
      'put request value is invalid',
    );
  }
}

function normalizeInspectRequest(
  value: InspectTriggerRequest,
): Readonly<InspectTriggerRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'auditEventId',
      'principal',
      'projectId',
      'requestId',
      'triggerId',
    ])
  ) {
    throw new LocalTriggerAdministrationConfigurationError(
      'inspect request shape is invalid',
    );
  }
  assertRequestIdentity(value.requestId, value.auditEventId);
  try {
    assertTriggerIdentifier(value.projectId, 'projectId');
    assertTriggerIdentifier(value.triggerId, 'triggerId');
  } catch {
    throw new LocalTriggerAdministrationConfigurationError(
      'inspect request value is invalid',
    );
  }
  return Object.freeze({ ...value });
}

function normalizeListRequest(
  value: ListTriggersRequest,
): Readonly<ListTriggersRequest> {
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
    throw new LocalTriggerAdministrationConfigurationError(
      'list request shape is invalid',
    );
  }
  assertRequestIdentity(value.requestId, value.auditEventId);
  try {
    assertTriggerIdentifier(value.projectId, 'projectId');
    assertTriggerPageSize(value.limit);
    return Object.freeze({
      ...value,
      ...(value.after ? { after: normalizeTriggerCursor(value.after) } : {}),
    });
  } catch {
    throw new LocalTriggerAdministrationConfigurationError(
      'list request value is invalid',
    );
  }
}

export function createLocalTriggerAdministrationService(
  projectPolicy: ProjectPolicyRepository,
  mutations: TriggerAdministrationRepository,
  source: TriggerSource,
  audit: SecurityAuditSink,
  options: LocalTriggerAdministrationOptions = {},
): LocalTriggerAdministrationService {
  if (
    !projectPolicy ||
    typeof projectPolicy.resolve !== 'function' ||
    !mutations ||
    typeof mutations.appendAuthorizedTriggerRevision !== 'function' ||
    !source ||
    typeof source.findCurrentTrigger !== 'function' ||
    typeof source.listTriggers !== 'function' ||
    !audit ||
    typeof audit.record !== 'function' ||
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, options.now === undefined ? [] : ['now']) ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new LocalTriggerAdministrationConfigurationError(
      'dependencies or options are invalid',
    );
  }
  const policy = new ProjectPolicyEngine(projectPolicy);
  const now = options.now ?? Date.now;

  async function authorize(request: {
    readonly eventId: string;
    readonly requestId: string;
    readonly projectId: string;
    readonly operationId: 'trigger.create' | 'trigger.update' | 'trigger.read';
    readonly permission: 'task.update' | 'task.read';
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
        throw new LocalTriggerAdministrationUnavailableError();
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
        throw new LocalTriggerAdministrationUnavailableError();
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
        throw new LocalTriggerAdministrationUnavailableError();
      }
      throw new LocalTriggerAdministrationUnavailableError();
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
        throw new LocalTriggerAdministrationUnavailableError();
      }
      throw new LocalTriggerAdministrationAuthorizationError();
    }
    if (!decision.fence || decision.fence.bindingVersion === null) {
      throw new LocalTriggerAdministrationUnavailableError();
    }
    return Object.freeze({ principal, decision });
  }

  return Object.freeze({
    async put(request: PutTriggerRequest) {
      const occurredAtMs = clock(now);
      const normalized = normalizePutRequest(request);
      if (normalized.command.occurredAtMs > occurredAtMs + 5 * 60_000) {
        throw new LocalTriggerAdministrationConfigurationError(
          'Trigger occurredAtMs is too far in the future',
        );
      }
      const operationId =
        normalized.command.expectedRevision === null
          ? ('trigger.create' as const)
          : ('trigger.update' as const);
      const authorization = await authorize({
        eventId: normalized.command.mutationId,
        requestId: normalized.requestId,
        projectId: normalized.command.projectId,
        operationId,
        permission: 'task.update',
        principal: normalized.principal,
        occurredAtMs,
      });
      try {
        return await mutations.appendAuthorizedTriggerRevision({
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
          error instanceof InvalidTriggerError ||
          (error &&
            typeof error === 'object' &&
            'code' in error &&
            typeof error.code === 'string' &&
            (error.code.startsWith('TRIGGER_') ||
              error.code.startsWith('LOCAL_SQLITE_AUTHENTICATED_')))
        ) {
          throw error;
        }
        throw new LocalTriggerAdministrationUnavailableError();
      }
    },

    async inspect(request: InspectTriggerRequest) {
      const normalized = normalizeInspectRequest(request);
      const occurredAtMs = clock(now);
      const authorization = await authorize({
        eventId: normalized.auditEventId,
        requestId: normalized.requestId,
        projectId: normalized.projectId,
        operationId: 'trigger.read',
        permission: 'task.read',
        principal: normalized.principal,
        occurredAtMs,
      });
      try {
        const trigger = await source.findCurrentTrigger(
          normalized.projectId,
          normalized.triggerId,
        );
        await audit.record(
          auditRecord({
            eventId: normalized.auditEventId,
            requestId: normalized.requestId,
            projectId: normalized.projectId,
            operationId: 'trigger.read',
            principal: authorization.principal,
            outcome: 'allowed',
            reasons: authorization.decision.reasons,
            fence: authorization.decision.fence,
            occurredAtMs,
          }),
        );
        return trigger;
      } catch (error) {
        if (error instanceof SecurityAuditUnavailableError) {
          throw new LocalTriggerAdministrationUnavailableError();
        }
        throw error;
      }
    },

    async list(request: ListTriggersRequest) {
      const normalized = normalizeListRequest(request);
      const occurredAtMs = clock(now);
      const authorization = await authorize({
        eventId: normalized.auditEventId,
        requestId: normalized.requestId,
        projectId: normalized.projectId,
        operationId: 'trigger.read',
        permission: 'task.read',
        principal: normalized.principal,
        occurredAtMs,
      });
      try {
        const page = await source.listTriggers({
          projectId: normalized.projectId,
          limit: normalized.limit,
          ...(normalized.after ? { after: normalized.after } : {}),
        });
        await audit.record(
          auditRecord({
            eventId: normalized.auditEventId,
            requestId: normalized.requestId,
            projectId: normalized.projectId,
            operationId: 'trigger.read',
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
          throw new LocalTriggerAdministrationUnavailableError();
        }
        throw error;
      }
    },
  });
}
