import { createHash, randomUUID } from 'node:crypto';

import {
  LocalTaskDefinitionAdministrationAuthenticationError,
  LocalTaskDefinitionAdministrationAuthorizationError,
  LocalTaskDefinitionAdministrationConfigurationError,
  LocalTaskDefinitionAdministrationUnavailableError,
  createLocalTaskDefinitionAdministrationService,
} from '@qinglong/local-admin/task-definition-administration';
import {
  ProjectPolicyEngine,
  ProjectPolicyUnavailableError,
  type ProjectPolicyRepository,
} from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPolicyDecision,
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditOutcome,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';
import {
  InvalidTaskDefinitionError,
  TaskDefinitionConflictError,
  TaskDefinitionUnavailableError,
  normalizeAppendTaskDefinitionRevisionCommand,
  type AppendTaskDefinitionRevisionCommand,
  type TaskDefinitionRecord,
  type TaskDefinitionSource,
} from '@qinglong/runtime-core/task-definition';
import {
  TaskDefinitionAdministrationAuthorizationFenceConflictError,
  TaskDefinitionAdministrationMutationConflictError,
  type TaskDefinitionAdministrationRepository,
} from '@qinglong/runtime-core/task-definition-administration';

import type { AuthenticatedLocalApiRequest } from '../authentication/credentialAuthenticator';
import {
  LocalPresenceProofUnavailableError,
  type LocalPresenceBinding,
  type LocalPresenceProofManager,
} from '../authentication/localPresenceProof';
import type { LocalApiResponse } from '../transport/contract';

const BODY_KEYS = Object.freeze([
  'enabled',
  'expectedRevision',
  'kind',
  'labels',
  'mutationId',
  'name',
  'occurredAtMs',
  'spec',
]);
const OPTIONAL_BODY_KEYS = Object.freeze(['description']);

export interface LocalApiTaskPutRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly body: unknown | null;
  readonly presence: string | null;
  readonly authenticated: Readonly<AuthenticatedLocalApiRequest>;
  readonly signal: AbortSignal;
}

export interface LocalApiTaskPutRoute {
  handle(request: Readonly<LocalApiTaskPutRequest>): Promise<LocalApiResponse>;
}

export interface LocalApiTaskPutRouteOptions {
  readonly projectPolicy: ProjectPolicyRepository;
  readonly taskDefinitions: TaskDefinitionSource;
  readonly taskDefinitionAdministrationForCredential: (
    fence: Readonly<AuthenticatedLocalApiRequest['credentialFence']>,
  ) => Promise<TaskDefinitionAdministrationRepository>;
  readonly securityAudit: SecurityAuditSink;
  readonly presenceProof: LocalPresenceProofManager;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
}

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): LocalApiResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function normalizeBody(
  body: unknown | null,
  projectId: string,
  taskId: string,
): Readonly<AppendTaskDefinitionRevisionCommand> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidTaskDefinitionError('HTTP body must be an object');
  }
  const keys = Object.keys(body).sort();
  const allowed = new Set([...BODY_KEYS, ...OPTIONAL_BODY_KEYS]);
  if (
    BODY_KEYS.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new InvalidTaskDefinitionError('HTTP body has an invalid shape');
  }
  return normalizeAppendTaskDefinitionRevisionCommand({
    projectId,
    taskId,
    ...(body as Omit<
      AppendTaskDefinitionRevisionCommand,
      'projectId' | 'taskId'
    >),
  });
}

function requestDigest(
  command: Readonly<AppendTaskDefinitionRevisionCommand>,
): string {
  return createHash('sha256')
    .update('qinglong3.local-api-task-put.v1\0', 'utf8')
    .update(canonicalJson(command), 'utf8')
    .digest('hex');
}

function presenceBinding(
  command: Readonly<AppendTaskDefinitionRevisionCommand>,
  authenticated: Readonly<AuthenticatedLocalApiRequest>,
): Readonly<LocalPresenceBinding> {
  if (
    authenticated.principal.subject.type !== 'user' ||
    authenticated.credentialFence.subjectType !== 'user'
  ) {
    throw new LocalPresenceProofUnavailableError(
      'strong User credential is required',
    );
  }
  return Object.freeze({
    requestDigest: requestDigest(command),
    credentialId: authenticated.credentialFence.credentialId,
    credentialVersion: authenticated.credentialFence.credentialVersion,
    subjectType: 'user',
    subjectId: authenticated.credentialFence.subjectId,
  });
}

function operationId(
  command: Readonly<AppendTaskDefinitionRevisionCommand>,
): 'task.create' | 'task.update' {
  return command.expectedRevision === null ? 'task.create' : 'task.update';
}

function summary(value: Readonly<TaskDefinitionRecord>) {
  return Object.freeze({
    taskId: value.taskId,
    revision: value.revision,
    name: value.name,
    kind: value.kind,
    specSchema: value.spec.schema,
    enabled: value.enabled,
    contentDigest: value.contentDigest,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
  });
}

function timestamp(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalPresenceProofUnavailableError('clock is invalid');
  }
  return value;
}

async function recordAudit(
  audit: SecurityAuditSink,
  values: {
    readonly eventId: string;
    readonly requestId: string;
    readonly operationId: 'task.create' | 'task.update';
    readonly projectId: string;
    readonly authenticated: Readonly<AuthenticatedLocalApiRequest> | null;
    readonly outcome: SecurityAuditOutcome;
    readonly reasons: readonly string[];
    readonly fence: SecurityPolicyDecision['fence'];
    readonly occurredAtMs: number;
  },
): Promise<boolean> {
  try {
    await audit.record(
      normalizeSecurityAuditRecord({
        eventId: values.eventId,
        requestId: values.requestId,
        operationId: values.operationId,
        projectId: values.projectId,
        subject: values.authenticated?.principal.subject ?? null,
        authenticationId:
          values.authenticated?.principal.authenticationId ?? null,
        outcome: values.outcome,
        reasons: values.reasons,
        fence: values.fence,
        occurredAtMs: values.occurredAtMs,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function createLocalApiTaskPutRoute(
  options: Readonly<LocalApiTaskPutRouteOptions>,
): Readonly<LocalApiTaskPutRoute> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.projectPolicy?.resolve !== 'function' ||
    typeof options.taskDefinitions?.findCurrentTaskDefinition !== 'function' ||
    typeof options.taskDefinitions?.findTaskDefinitionRevision !== 'function' ||
    typeof options.taskDefinitions?.listTaskDefinitions !== 'function' ||
    typeof options.taskDefinitionAdministrationForCredential !== 'function' ||
    typeof options.securityAudit?.record !== 'function' ||
    typeof options.presenceProof?.issue !== 'function' ||
    typeof options.presenceProof?.consume !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.randomUuid !== undefined &&
      typeof options.randomUuid !== 'function')
  ) {
    throw new TypeError('Local API Task put route options are invalid');
  }
  const now = options.now ?? Date.now;
  const uuid = options.randomUuid ?? randomUUID;
  const policy = new ProjectPolicyEngine(options.projectPolicy);

  return Object.freeze({
    async handle(request: Readonly<LocalApiTaskPutRequest>) {
      if (request.signal.aborted) {
        return response(503, { code: 'request_unavailable' });
      }
      let command: Readonly<AppendTaskDefinitionRevisionCommand>;
      try {
        command = normalizeBody(
          request.body,
          request.projectId,
          request.taskId,
        );
      } catch (error) {
        return error instanceof InvalidTaskDefinitionError
          ? response(400, { code: 'invalid_task_definition' })
          : response(503, { code: 'task_definition_unavailable' });
      }
      const operation = operationId(command);
      const occurredAtMs = timestamp(now);
      let decision: Readonly<SecurityPolicyDecision>;
      try {
        decision = normalizeSecurityPolicyDecision(
          await policy.authorize(
            request.authenticated.principal,
            request.projectId,
            operation,
          ),
        );
      } catch (error) {
        const audited = await recordAudit(options.securityAudit, {
          eventId: uuid(),
          requestId: request.requestId,
          operationId: operation,
          projectId: request.projectId,
          authenticated: request.authenticated,
          outcome: 'authorization_unavailable',
          reasons: ['policy_unavailable'],
          fence: null,
          occurredAtMs,
        });
        return response(503, {
          code:
            audited && error instanceof ProjectPolicyUnavailableError
              ? 'authorization_unavailable'
              : 'security_audit_unavailable',
        });
      }
      if (decision.effect !== 'allow') {
        const audited = await recordAudit(options.securityAudit, {
          eventId: uuid(),
          requestId: request.requestId,
          operationId: operation,
          projectId: request.projectId,
          authenticated: request.authenticated,
          outcome:
            decision.effect === 'require_approval'
              ? 'approval_required'
              : 'denied',
          reasons: decision.reasons,
          fence: decision.fence,
          occurredAtMs,
        });
        if (!audited) {
          return response(503, { code: 'security_audit_unavailable' });
        }
        return response(403, {
          code:
            decision.effect === 'require_approval'
              ? 'approval_required'
              : 'forbidden',
        });
      }
      let binding: Readonly<LocalPresenceBinding>;
      try {
        binding = presenceBinding(command, request.authenticated);
      } catch {
        return response(401, { code: 'strong_authentication_required' });
      }
      if (!request.presence) {
        let challenge;
        try {
          challenge = options.presenceProof.issue(binding);
        } catch {
          return response(503, { code: 'local_presence_unavailable' });
        }
        const audited = await recordAudit(options.securityAudit, {
          eventId: uuid(),
          requestId: request.requestId,
          operationId: operation,
          projectId: request.projectId,
          authenticated: request.authenticated,
          outcome: 'approval_required',
          reasons: ['local_presence_required'],
          fence: decision.fence,
          occurredAtMs,
        });
        if (!audited) {
          return response(503, { code: 'security_audit_unavailable' });
        }
        return response(428, {
          code: 'local_presence_required',
          authorizationId: challenge.authorizationId,
          requestDigest: challenge.requestDigest,
          expiresAtMs: challenge.expiresAtMs,
          proofFileName: challenge.proofFileName,
        });
      }
      let proof;
      try {
        await request.authenticated.confirm();
        proof = options.presenceProof.consume(request.presence, binding);
      } catch {
        return response(503, { code: 'authentication_unavailable' });
      }
      if (!proof) {
        const audited = await recordAudit(options.securityAudit, {
          eventId: uuid(),
          requestId: request.requestId,
          operationId: operation,
          projectId: request.projectId,
          authenticated: null,
          outcome: 'authentication_rejected',
          reasons: ['local_presence_rejected'],
          fence: null,
          occurredAtMs,
        });
        return audited
          ? response(401, { code: 'local_presence_rejected' })
          : response(503, { code: 'security_audit_unavailable' });
      }
      if (request.signal.aborted) {
        return response(503, { code: 'request_unavailable' });
      }
      let strongPrincipal;
      try {
        strongPrincipal = normalizeSecurityPrincipal(
          {
            subject: request.authenticated.principal.subject,
            authenticationId: `local_presence:${proof.authorizationId}`,
            authenticatedAtMs: proof.authenticatedAtMs,
            expiresAtMs: Math.min(
              proof.expiresAtMs,
              request.authenticated.principal.expiresAtMs,
            ),
            assurance: 'local_console',
          },
          proof.authenticatedAtMs,
        );
      } catch {
        return response(503, { code: 'authentication_unavailable' });
      }
      try {
        const mutations =
          await options.taskDefinitionAdministrationForCredential(
            request.authenticated.credentialFence,
          );
        const service = createLocalTaskDefinitionAdministrationService(
          options.projectPolicy,
          mutations,
          options.taskDefinitions,
          options.securityAudit,
          { now },
        );
        const result = await service.put({
          ...command,
          requestId: request.requestId,
          principal: strongPrincipal,
        });
        return response(result.status === 'created' ? 201 : 200, {
          status: result.status,
          task: summary(result.definition),
        });
      } catch (error) {
        if (
          error instanceof TaskDefinitionConflictError ||
          error instanceof TaskDefinitionAdministrationMutationConflictError ||
          error instanceof
            TaskDefinitionAdministrationAuthorizationFenceConflictError
        ) {
          return response(409, { code: 'task_definition_fence_rejected' });
        }
        if (
          error instanceof LocalTaskDefinitionAdministrationAuthenticationError
        ) {
          return response(401, { code: 'strong_authentication_required' });
        }
        if (
          error instanceof LocalTaskDefinitionAdministrationAuthorizationError
        ) {
          return response(403, { code: 'forbidden' });
        }
        if (
          error instanceof InvalidTaskDefinitionError ||
          error instanceof LocalTaskDefinitionAdministrationConfigurationError
        ) {
          return response(400, { code: 'invalid_task_definition' });
        }
        if (
          error instanceof TaskDefinitionUnavailableError ||
          error instanceof LocalTaskDefinitionAdministrationUnavailableError
        ) {
          return response(503, { code: 'task_definition_unavailable' });
        }
        return response(503, { code: 'task_definition_unavailable' });
      }
    },
  });
}
