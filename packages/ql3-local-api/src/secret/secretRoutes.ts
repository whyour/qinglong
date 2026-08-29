import { createHash, randomUUID } from 'node:crypto';

import {
  LocalSecretAdministrationAuthenticationError,
  LocalSecretAdministrationAuthorizationError,
  LocalSecretAdministrationConfigurationError,
  LocalSecretAdministrationUnavailableError,
  createLocalSecretAdministrationService,
} from '@qinglong/local-admin/secret-administration';
import {
  LocalSecretMetadataUnavailableError,
  LocalSecretMutationConflictError,
  LocalSecretVersionConflictError,
  assertLocalSecretExpectedVersion,
  assertLocalSecretMutationId,
  assertLocalSecretName,
  assertLocalSecretPlaintext,
  assertLocalSecretProjectId,
  assertLocalSecretVersion,
  createLocalSecretRef,
  type LocalSecretMetadataPage,
  type LocalSecretKeyProvider,
  type LocalSecretMetadataSource,
} from '@qinglong/runtime-core/local-secret';
import {
  LocalSecretAuthorizationFenceConflictError,
  type LocalSecretAdministrationRepository,
} from '@qinglong/runtime-core/local-secret-administration';
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

import type { AuthenticatedLocalApiRequest } from '../authentication/credentialAuthenticator';
import {
  LocalPresenceProofUnavailableError,
  type LocalPresenceBinding,
  type LocalPresenceProofManager,
} from '../authentication/localPresenceProof';
import { strongLocalConsolePrincipal } from '../authentication/strongLocalPrincipal';
import type { LocalApiResponse } from '../transport/contract';

const BODY_KEYS = Object.freeze([
  'expectedCurrentVersion',
  'mutationId',
  'name',
  'plaintext',
]);

export interface LocalApiSecretListRoute {
  handle(request: LocalApiSecretListRequest): Promise<LocalApiResponse>;
}

export interface LocalApiSecretListRequest {
  readonly projectId: string;
  readonly limit: number;
  readonly after?: Readonly<{ readonly name: string }>;
}

export interface LocalApiSecretPutRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly body: unknown | null;
  readonly presence: string | null;
  readonly authenticated: Readonly<AuthenticatedLocalApiRequest>;
  readonly signal: AbortSignal;
}

export interface LocalApiSecretPutRoute {
  handle(
    request: Readonly<LocalApiSecretPutRequest>,
  ): Promise<LocalApiResponse>;
}

export interface LocalApiSecretPutRouteOptions {
  readonly projectPolicy: ProjectPolicyRepository;
  readonly secretAdministrationForCredential: (
    fence: Readonly<AuthenticatedLocalApiRequest['credentialFence']>,
  ) => Promise<LocalSecretAdministrationRepository>;
  readonly securityAudit: SecurityAuditSink;
  readonly secretKeys: LocalSecretKeyProvider;
  readonly presenceProof: LocalPresenceProofManager;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
}

type SecretPutCommand = Readonly<{
  name: string;
  plaintext: string;
  mutationId: string;
  expectedCurrentVersion: number;
}>;

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

function normalizeBody(body: unknown | null): SecretPutCommand {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('Secret body is invalid');
  }
  const keys = Object.keys(body).sort();
  if (
    BODY_KEYS.some((key) => !keys.includes(key)) ||
    keys.some((key) => !BODY_KEYS.includes(key))
  ) {
    throw new TypeError('Secret body shape is invalid');
  }
  const candidate = body as Record<string, unknown>;
  assertLocalSecretName(candidate.name);
  assertLocalSecretPlaintext(candidate.plaintext);
  assertLocalSecretMutationId(candidate.mutationId);
  assertLocalSecretExpectedVersion(candidate.expectedCurrentVersion);
  if (
    typeof candidate.mutationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      candidate.mutationId,
    )
  ) {
    throw new TypeError('Secret mutation identity is invalid');
  }
  return Object.freeze(candidate as SecretPutCommand);
}

function requestDigest(projectId: string, command: SecretPutCommand): string {
  return createHash('sha256')
    .update('qinglong3.local-api-secret-put.v1\0', 'utf8')
    .update(canonicalJson({ projectId, ...command }), 'utf8')
    .digest('hex');
}

function presenceBinding(
  projectId: string,
  command: SecretPutCommand,
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
    requestDigest: requestDigest(projectId, command),
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
    readonly operationId: 'secret.create' | 'secret.rotate';
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

function isCredentialFenceConflict(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('LOCAL_SQLITE_AUTHENTICATED_')
  );
}

function normalizeMetadataPage(
  request: Readonly<LocalApiSecretListRequest>,
  value: unknown,
): Readonly<LocalSecretMetadataPage> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['next', 'secrets', 'truncated'].includes(key),
    )
  ) {
    throw new LocalSecretMetadataUnavailableError();
  }
  const page = value as Readonly<Record<string, unknown>>;
  if (
    !Array.isArray(page.secrets) ||
    page.secrets.length > request.limit ||
    typeof page.truncated !== 'boolean'
  ) {
    throw new LocalSecretMetadataUnavailableError();
  }
  assertLocalSecretProjectId(request.projectId);
  if (request.after) assertLocalSecretName(request.after.name);
  let previous = request.after?.name;
  const secrets = Object.freeze(
    page.secrets.map((candidate) => {
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate) ||
        Object.keys(candidate).sort().join(',') !==
          'createdAtMs,currentVersion,name,projectId'
      ) {
        throw new LocalSecretMetadataUnavailableError();
      }
      const secret = candidate as Readonly<Record<string, unknown>>;
      assertLocalSecretProjectId(secret.projectId);
      assertLocalSecretName(secret.name);
      assertLocalSecretVersion(secret.currentVersion);
      if (
        secret.projectId !== request.projectId ||
        !Number.isSafeInteger(secret.createdAtMs) ||
        (secret.createdAtMs as number) < 0 ||
        (previous !== undefined &&
          Buffer.compare(
            Buffer.from(secret.name as string, 'utf8'),
            Buffer.from(previous, 'utf8'),
          ) <= 0)
      ) {
        throw new LocalSecretMetadataUnavailableError();
      }
      previous = secret.name as string;
      return Object.freeze({
        projectId: secret.projectId as string,
        name: secret.name as string,
        currentVersion: secret.currentVersion as number,
        createdAtMs: secret.createdAtMs as number,
      });
    }),
  );
  const next = page.next;
  if (
    page.truncated === true
      ? !next ||
        typeof next !== 'object' ||
        Array.isArray(next) ||
        Object.keys(next).join('') !== 'name' ||
        (next as Readonly<Record<string, unknown>>).name !== previous
      : next !== undefined
  ) {
    throw new LocalSecretMetadataUnavailableError();
  }
  return Object.freeze({
    secrets,
    truncated: page.truncated,
    ...(page.truncated === true && previous !== undefined
      ? { next: Object.freeze({ name: previous }) }
      : {}),
  });
}

export function createLocalApiSecretListRoute(
  source: LocalSecretMetadataSource,
): Readonly<LocalApiSecretListRoute> {
  if (!source || typeof source.listLocalSecretMetadata !== 'function') {
    throw new TypeError('Local API Secret metadata source is invalid');
  }
  return Object.freeze({
    async handle(request: Readonly<LocalApiSecretListRequest>) {
      try {
        const page = normalizeMetadataPage(
          request,
          await source.listLocalSecretMetadata(request),
        );
        return response(200, {
          secrets: Object.freeze(
            page.secrets.map((secret) =>
              Object.freeze({
                name: secret.name,
                currentVersion: secret.currentVersion,
                secretRef: createLocalSecretRef({
                  projectId: secret.projectId,
                  name: secret.name,
                  version: secret.currentVersion,
                }),
                createdAtMs: secret.createdAtMs,
              }),
            ),
          ),
          truncated: page.truncated,
          ...(page.next
            ? {
                next: Object.freeze({
                  after: Buffer.from(page.next.name, 'utf8').toString(
                    'base64url',
                  ),
                }),
              }
            : {}),
        });
      } catch {
        return response(503, { code: 'secret_query_unavailable' });
      }
    },
  });
}

export function createLocalApiSecretPutRoute(
  options: Readonly<LocalApiSecretPutRouteOptions>,
): Readonly<LocalApiSecretPutRoute> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.projectPolicy?.resolve !== 'function' ||
    typeof options.secretAdministrationForCredential !== 'function' ||
    typeof options.securityAudit?.record !== 'function' ||
    typeof options.secretKeys?.active !== 'function' ||
    typeof options.secretKeys?.resolve !== 'function' ||
    typeof options.presenceProof?.issue !== 'function' ||
    typeof options.presenceProof?.consume !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.randomUuid !== undefined &&
      typeof options.randomUuid !== 'function')
  ) {
    throw new TypeError('Local API Secret put route options are invalid');
  }
  const now = options.now ?? Date.now;
  const uuid = options.randomUuid ?? randomUUID;
  const policy = new ProjectPolicyEngine(options.projectPolicy);

  return Object.freeze({
    async handle(request: Readonly<LocalApiSecretPutRequest>) {
      if (request.signal.aborted) {
        return response(503, { code: 'request_unavailable' });
      }
      let command: SecretPutCommand;
      try {
        command = normalizeBody(request.body);
      } catch {
        return response(400, { code: 'invalid_secret' });
      }
      const operationId =
        command.expectedCurrentVersion === 0
          ? ('secret.create' as const)
          : ('secret.rotate' as const);
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
            'secret.manage',
          ),
        );
      } catch (error) {
        const audited = await recordAudit(options.securityAudit, {
          eventId: uuid(),
          requestId: request.requestId,
          operationId,
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
          operationId,
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
        binding = presenceBinding(
          request.projectId,
          command,
          request.authenticated,
        );
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
          operationId,
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
          operationId,
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
      try {
        const strongPrincipal = strongLocalConsolePrincipal(
          request.authenticated,
          proof,
        );
        const mutations = await options.secretAdministrationForCredential(
          request.authenticated.credentialFence,
        );
        const service = createLocalSecretAdministrationService(
          options.projectPolicy,
          mutations,
          options.securityAudit,
          options.secretKeys,
          { now },
        );
        const result = await service.put({
          projectId: request.projectId,
          name: command.name,
          plaintext: command.plaintext,
          mutationId: command.mutationId,
          requestId: request.requestId,
          expectedCurrentVersion: command.expectedCurrentVersion,
          principal: strongPrincipal,
        });
        return response(
          result.status === 'inserted' && command.expectedCurrentVersion === 0
            ? 201
            : 200,
          {
            status: result.status,
            secret: Object.freeze({
              name: command.name,
              currentVersion: result.version,
              secretRef: result.secretRef,
            }),
          },
        );
      } catch (error) {
        if (
          error instanceof LocalSecretVersionConflictError ||
          error instanceof LocalSecretMutationConflictError ||
          error instanceof LocalSecretAuthorizationFenceConflictError ||
          isCredentialFenceConflict(error)
        ) {
          return response(409, { code: 'secret_fence_rejected' });
        }
        if (error instanceof LocalSecretAdministrationAuthenticationError) {
          return response(401, { code: 'strong_authentication_required' });
        }
        if (error instanceof LocalSecretAdministrationAuthorizationError) {
          return response(403, { code: 'forbidden' });
        }
        if (error instanceof LocalSecretAdministrationConfigurationError) {
          return response(400, { code: 'invalid_secret' });
        }
        if (
          error instanceof LocalSecretAdministrationUnavailableError ||
          error instanceof LocalSecretMetadataUnavailableError
        ) {
          return response(503, { code: 'secret_unavailable' });
        }
        return response(503, { code: 'secret_unavailable' });
      }
    },
  });
}
