import { createHash, randomUUID } from 'node:crypto';

import {
  LocalTriggerAdministrationAuthenticationError,
  LocalTriggerAdministrationAuthorizationError,
  LocalTriggerAdministrationConfigurationError,
  LocalTriggerAdministrationUnavailableError,
  createLocalTriggerAdministrationService,
} from '@qinglong/local-admin/trigger-administration';
import {
  ProjectPolicyEngine,
  ProjectPolicyUnavailableError,
  type ProjectPolicyRepository,
} from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPolicyDecision,
  type SecurityPolicyDecision,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditOutcome,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';
import {
  InvalidTriggerError,
  InvalidTriggerSpecSemanticError,
  TriggerConflictError,
  TriggerUnavailableError,
  UnsupportedTriggerSpecError,
  normalizeAppendTriggerRevisionCommand,
  type AppendTriggerRevisionCommand,
  type TriggerRecord,
  type TriggerSource,
} from '@qinglong/runtime-core/trigger';
import {
  TriggerAdministrationAuthorizationFenceConflictError,
  TriggerAdministrationMutationConflictError,
  type TriggerAdministrationRepository,
} from '@qinglong/runtime-core/trigger-administration';

import type { AuthenticatedLocalApiRequest } from '../authentication/credentialAuthenticator';
import {
  LocalPresenceProofUnavailableError,
  type LocalPresenceBinding,
  type LocalPresenceProofManager,
} from '../authentication/localPresenceProof';
import { strongLocalConsolePrincipal } from '../authentication/strongLocalPrincipal';
import type { LocalApiResponse } from '../transport/contract';

const BODY_KEYS = Object.freeze([
  'enabled',
  'expectedRevision',
  'mutationId',
  'occurredAtMs',
  'spec',
  'taskContentDigest',
  'taskId',
  'taskRevision',
]);

export interface LocalApiTriggerPutRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly triggerId: string;
  readonly body: unknown | null;
  readonly presence: string | null;
  readonly authenticated: Readonly<AuthenticatedLocalApiRequest>;
  readonly signal: AbortSignal;
}

export interface LocalApiTriggerPutRoute {
  handle(
    request: Readonly<LocalApiTriggerPutRequest>,
  ): Promise<LocalApiResponse>;
}

export interface LocalApiTriggerPutRouteOptions {
  readonly projectPolicy: ProjectPolicyRepository;
  readonly triggers: TriggerSource;
  readonly triggerAdministrationForCredential: (
    fence: Readonly<AuthenticatedLocalApiRequest['credentialFence']>,
  ) => Promise<TriggerAdministrationRepository>;
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
  triggerId: string,
): Readonly<AppendTriggerRevisionCommand> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidTriggerError('HTTP body must be an object');
  }
  const keys = Object.keys(body).sort();
  if (
    BODY_KEYS.some((key) => !keys.includes(key)) ||
    keys.some((key) => !BODY_KEYS.includes(key))
  ) {
    throw new InvalidTriggerError('HTTP body has an invalid shape');
  }
  return normalizeAppendTriggerRevisionCommand({
    projectId,
    triggerId,
    ...(body as Omit<AppendTriggerRevisionCommand, 'projectId' | 'triggerId'>),
  });
}

function operationId(
  command: Readonly<AppendTriggerRevisionCommand>,
): 'trigger.create' | 'trigger.update' {
  return command.expectedRevision === null
    ? 'trigger.create'
    : 'trigger.update';
}

function requestDigest(
  command: Readonly<AppendTriggerRevisionCommand>,
): string {
  return createHash('sha256')
    .update('qinglong3.local-api-trigger-put.v1\0', 'utf8')
    .update(canonicalJson(command), 'utf8')
    .digest('hex');
}

function presenceBinding(
  command: Readonly<AppendTriggerRevisionCommand>,
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
    readonly operationId: 'trigger.create' | 'trigger.update';
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

function summary(trigger: Readonly<TriggerRecord>) {
  return Object.freeze({
    triggerId: trigger.triggerId,
    revision: trigger.revision,
    taskId: trigger.taskId,
    taskRevision: trigger.taskRevision,
    taskContentDigest: trigger.taskContentDigest,
    spec: trigger.spec,
    enabled: trigger.enabled,
    contentDigest: trigger.contentDigest,
    createdAtMs: trigger.createdAtMs,
    updatedAtMs: trigger.updatedAtMs,
  });
}

function isCredentialFenceConflict(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('LOCAL_SQLITE_AUTHENTICATED_')
  );
}

export function createLocalApiTriggerPutRoute(
  options: Readonly<LocalApiTriggerPutRouteOptions>,
): Readonly<LocalApiTriggerPutRoute> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.projectPolicy?.resolve !== 'function' ||
    typeof options.triggers?.findCurrentTrigger !== 'function' ||
    typeof options.triggers?.listTriggers !== 'function' ||
    typeof options.triggerAdministrationForCredential !== 'function' ||
    typeof options.securityAudit?.record !== 'function' ||
    typeof options.presenceProof?.issue !== 'function' ||
    typeof options.presenceProof?.consume !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.randomUuid !== undefined &&
      typeof options.randomUuid !== 'function')
  ) {
    throw new TypeError('Local API Trigger put route options are invalid');
  }
  const now = options.now ?? Date.now;
  const uuid = options.randomUuid ?? randomUUID;
  const policy = new ProjectPolicyEngine(options.projectPolicy);

  return Object.freeze({
    async handle(request: Readonly<LocalApiTriggerPutRequest>) {
      if (request.signal.aborted) {
        return response(503, { code: 'request_unavailable' });
      }
      let command: Readonly<AppendTriggerRevisionCommand>;
      try {
        command = normalizeBody(
          request.body,
          request.projectId,
          request.triggerId,
        );
      } catch (error) {
        return error instanceof InvalidTriggerError
          ? response(400, { code: 'invalid_trigger' })
          : response(503, { code: 'trigger_unavailable' });
      }
      const operation = operationId(command);
      let occurredAtMs: number;
      try {
        occurredAtMs = timestamp(now);
      } catch {
        return response(503, { code: 'local_presence_unavailable' });
      }
      let decision: Readonly<SecurityPolicyDecision>;
      try {
        decision = normalizeSecurityPolicyDecision(
          await policy.authorize(
            request.authenticated.principal,
            request.projectId,
            'task.update',
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
        strongPrincipal = strongLocalConsolePrincipal(
          request.authenticated,
          proof,
        );
      } catch {
        return response(503, { code: 'authentication_unavailable' });
      }
      try {
        const mutations = await options.triggerAdministrationForCredential(
          request.authenticated.credentialFence,
        );
        const service = createLocalTriggerAdministrationService(
          options.projectPolicy,
          mutations,
          options.triggers,
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
          trigger: summary(result.trigger),
        });
      } catch (error) {
        if (
          error instanceof TriggerConflictError ||
          error instanceof TriggerAdministrationMutationConflictError ||
          error instanceof
            TriggerAdministrationAuthorizationFenceConflictError ||
          isCredentialFenceConflict(error)
        ) {
          return response(409, { code: 'trigger_fence_rejected' });
        }
        if (error instanceof LocalTriggerAdministrationAuthenticationError) {
          return response(401, { code: 'strong_authentication_required' });
        }
        if (error instanceof LocalTriggerAdministrationAuthorizationError) {
          return response(403, { code: 'forbidden' });
        }
        if (
          error instanceof InvalidTriggerError ||
          error instanceof InvalidTriggerSpecSemanticError ||
          error instanceof UnsupportedTriggerSpecError ||
          error instanceof LocalTriggerAdministrationConfigurationError
        ) {
          return response(400, { code: 'invalid_trigger' });
        }
        if (
          error instanceof TriggerUnavailableError ||
          error instanceof LocalTriggerAdministrationUnavailableError
        ) {
          return response(503, { code: 'trigger_unavailable' });
        }
        return response(503, { code: 'trigger_unavailable' });
      }
    },
  });
}
