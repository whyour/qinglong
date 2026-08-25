// Security Administration owns identity and API credential mutations.
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  REVOKED_API_CREDENTIAL_DIGEST,
  ApiCredentialAdministrationMutationConflictError,
  type ApiCredentialAdministrationRepository,
  type AppendApiCredentialResult,
  type ResolvedApiCredentialMutation,
} from '@qinglong/runtime-core/api-credential-administration';
import {
  apiCredentialSecretDigest,
  assertApiCredentialPepper,
  formatApiCredentialToken,
} from '@qinglong/runtime-core/api-credential-token';
import {
  assertApiCredentialPepperKeyId,
  type ApiCredentialRecord,
  LEGACY_API_CREDENTIAL_PEPPER_KEY_ID,
} from '@qinglong/runtime-core/api-credential';
import type { ApiCredentialPepperKey } from '@qinglong/runtime-core/api-credential-pepper-keyring';
import {
  type AppendIdentitySubjectResult,
  IdentityAdministrationMutationConflictError,
  type IdentityAdministrationOperation,
  type IdentityAdministrationRepository,
  type ResolvedIdentitySubjectMutation,
} from '@qinglong/runtime-core/identity-administration';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
  type SecuritySubject,
} from '@qinglong/runtime-core/security';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

const MAX_CREDENTIAL_LIFETIME_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const STRONG_USER_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);

export interface ClusterAdministrationOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface IdentityAdministrationRequest {
  readonly mutationId: string;
  readonly requestId: string;
  readonly expectedCurrentVersion: number;
  readonly subject: SecuritySubject;
  readonly principal: SecurityPrincipal;
}

export interface CredentialAdministrationRequest {
  readonly mutationId: string;
  readonly requestId: string;
  readonly expectedCurrentVersion: number;
  readonly credentialId: string;
  readonly subject: SecuritySubject;
  readonly principal: SecurityPrincipal;
}

export interface ActiveCredentialAdministrationRequest
  extends CredentialAdministrationRequest {
  readonly notBeforeAtMs: number;
  readonly expiresAtMs: number;
}

export interface CredentialAdministrationResult
  extends AppendApiCredentialResult {
  readonly token: string | null;
}

export interface ClusterAdministrationService {
  registerIdentity(
    request: IdentityAdministrationRequest,
  ): Promise<AppendIdentitySubjectResult>;
  enableIdentity(
    request: IdentityAdministrationRequest,
  ): Promise<AppendIdentitySubjectResult>;
  disableIdentity(
    request: IdentityAdministrationRequest,
  ): Promise<AppendIdentitySubjectResult>;
  issueCredential(
    request: ActiveCredentialAdministrationRequest,
  ): Promise<CredentialAdministrationResult>;
  rotateCredential(
    request: ActiveCredentialAdministrationRequest,
  ): Promise<CredentialAdministrationResult>;
  revokeCredential(
    request: CredentialAdministrationRequest,
  ): Promise<CredentialAdministrationResult>;
}

export class ClusterAdministrationConfigurationError extends TypeError {
  constructor(message: string) {
    super(`Cluster administration configuration is invalid: ${message}`);
    this.name = 'ClusterAdministrationConfigurationError';
  }
}

export class ClusterAdministrationAuthenticationError extends Error {
  readonly code = 'CLUSTER_ADMINISTRATION_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Cluster administration requires a strong principal');
    this.name = 'ClusterAdministrationAuthenticationError';
  }
}

export class ClusterAdministrationSubjectUnavailableError extends Error {
  readonly code = 'CLUSTER_ADMINISTRATION_SUBJECT_UNAVAILABLE';

  constructor() {
    super('Cluster administration subject is unavailable');
    this.name = 'ClusterAdministrationSubjectUnavailableError';
  }
}

function exactObject(value: unknown, name: string): asserts value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClusterAdministrationConfigurationError(`${name} is invalid`);
  }
}

function exactKeys(
  value: object,
  name: string,
  allowed: ReadonlySet<string>,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ClusterAdministrationConfigurationError(
      `${name} shape is invalid`,
    );
  }
}

const IDENTITY_REQUEST_KEYS = new Set([
  'mutationId',
  'requestId',
  'expectedCurrentVersion',
  'subject',
  'principal',
]);
const CREDENTIAL_REQUEST_KEYS = new Set([
  ...IDENTITY_REQUEST_KEYS,
  'credentialId',
]);
const ACTIVE_CREDENTIAL_REQUEST_KEYS = new Set([
  ...CREDENTIAL_REQUEST_KEYS,
  'notBeforeAtMs',
  'expiresAtMs',
]);

function administrationPrincipal(
  principal: SecurityPrincipal,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  let normalized: Readonly<SecurityPrincipal>;
  try {
    normalized = normalizeSecurityPrincipal(principal, nowMs);
  } catch {
    throw new ClusterAdministrationAuthenticationError();
  }
  const human =
    normalized.subject.type === 'user' &&
    STRONG_USER_ASSURANCES.has(normalized.assurance);
  const system =
    normalized.subject.type === 'system' && normalized.assurance === 'service';
  if (!human && !system) {
    throw new ClusterAdministrationAuthenticationError();
  }
  return normalized;
}

function audit(
  mutationId: string,
  requestId: string,
  operationId: string,
  principal: Readonly<SecurityPrincipal>,
  reason: 'identity_admin' | 'credential_admin',
  nowMs: number,
): SecurityAuditRecord {
  return {
    eventId: mutationId,
    requestId,
    operationId,
    projectId: null,
    subject: principal.subject,
    authenticationId: principal.authenticationId,
    outcome: 'allowed',
    reasons: [reason],
    fence: null,
    occurredAtMs: nowMs,
  };
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function sameReplayAudit(
  stored: Readonly<SecurityAuditRecord>,
  expected: Readonly<SecurityAuditRecord>,
): boolean {
  const { occurredAtMs: _storedOccurredAtMs, ...storedSemantic } = stored;
  const { occurredAtMs: _expectedOccurredAtMs, ...expectedSemantic } = expected;
  return JSON.stringify(storedSemantic) === JSON.stringify(expectedSemantic);
}

function sameIdentityReplay(
  stored: ResolvedIdentitySubjectMutation,
  operation: IdentityAdministrationOperation,
  request: IdentityAdministrationRequest,
  principal: Readonly<SecurityPrincipal>,
  nowMs: number,
): boolean {
  return (
    stored.mutation.operation === operation &&
    sameSubject(stored.mutation.subject, request.subject) &&
    stored.mutation.subjectVersion === request.expectedCurrentVersion + 1 &&
    stored.mutation.expectedPreviousVersion ===
      request.expectedCurrentVersion &&
    stored.mutation.status ===
      (operation === 'disable' ? 'disabled' : 'active') &&
    sameSubject(stored.mutation.changedBy, principal.subject) &&
    sameReplayAudit(
      stored.audit,
      audit(
        request.mutationId,
        request.requestId,
        `identity.${operation}`,
        principal,
        'identity_admin',
        nowMs,
      ),
    )
  );
}

function sameCredentialReplay(
  stored: ResolvedApiCredentialMutation,
  operation: 'issue' | 'rotate' | 'revoke',
  request:
    | ActiveCredentialAdministrationRequest
    | CredentialAdministrationRequest,
  principal: Readonly<SecurityPrincipal>,
  nowMs: number,
): boolean {
  const active =
    operation === 'revoke'
      ? null
      : (request as ActiveCredentialAdministrationRequest);
  return (
    stored.mutation.operation === operation &&
    stored.mutation.credentialId === request.credentialId &&
    stored.mutation.credentialVersion === request.expectedCurrentVersion + 1 &&
    stored.mutation.expectedPreviousVersion ===
      request.expectedCurrentVersion &&
    sameSubject(stored.mutation.changedBy, principal.subject) &&
    stored.credential.state ===
      (operation === 'revoke' ? 'revoked' : 'active') &&
    sameSubject(stored.credential.subject, request.subject) &&
    (active === null ||
      (stored.credential.notBeforeAtMs === active.notBeforeAtMs &&
        stored.credential.expiresAtMs === active.expiresAtMs)) &&
    sameReplayAudit(
      stored.audit,
      audit(
        request.mutationId,
        request.requestId,
        `credential.${operation}`,
        principal,
        'credential_admin',
        nowMs,
      ),
    )
  );
}

export function createClusterAdministrationService(
  identities: IdentityAdministrationRepository,
  credentials: ApiCredentialAdministrationRepository,
  activePepperKeyValue: Readonly<ApiCredentialPepperKey> | string,
  options: ClusterAdministrationOptions = {},
): ClusterAdministrationService {
  if (
    !identities ||
    typeof identities.resolve !== 'function' ||
    typeof identities.resolveMutation !== 'function' ||
    typeof identities.append !== 'function'
  ) {
    throw new ClusterAdministrationConfigurationError(
      'identity repository is invalid',
    );
  }
  if (
    !credentials ||
    typeof credentials.resolveMutation !== 'function' ||
    typeof credentials.append !== 'function'
  ) {
    throw new ClusterAdministrationConfigurationError(
      'credential repository is invalid',
    );
  }
  const activePepperKey =
    typeof activePepperKeyValue === 'string'
      ? Object.freeze({
          pepperKeyId: LEGACY_API_CREDENTIAL_PEPPER_KEY_ID,
          pepper: activePepperKeyValue,
        })
      : activePepperKeyValue;
  try {
    if (
      !activePepperKey ||
      typeof activePepperKey !== 'object' ||
      Array.isArray(activePepperKey) ||
      Object.keys(activePepperKey).sort().join(',') !== 'pepper,pepperKeyId'
    ) {
      throw new TypeError();
    }
    assertApiCredentialPepper(activePepperKey.pepper);
    assertApiCredentialPepperKeyId(activePepperKey.pepperKeyId);
  } catch {
    throw new ClusterAdministrationConfigurationError(
      'active pepper key is invalid',
    );
  }
  exactObject(options, 'options');
  const optionKeys = Object.keys(options);
  if (optionKeys.some((key) => key !== 'now' && key !== 'randomBytes')) {
    throw new ClusterAdministrationConfigurationError(
      'options shape is invalid',
    );
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new ClusterAdministrationConfigurationError('now is invalid');
  }
  if (
    options.randomBytes !== undefined &&
    typeof options.randomBytes !== 'function'
  ) {
    throw new ClusterAdministrationConfigurationError('randomBytes is invalid');
  }
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? nodeRandomBytes;

  const mutateIdentity = async (
    operation: IdentityAdministrationOperation,
    request: IdentityAdministrationRequest,
  ): Promise<AppendIdentitySubjectResult> => {
    exactObject(request, 'identity request');
    exactKeys(request, 'identity request', IDENTITY_REQUEST_KEYS);
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new ClusterAdministrationConfigurationError('clock is invalid');
    }
    const principal = administrationPrincipal(request.principal, nowMs);
    const existing = await identities.resolveMutation(request.mutationId);
    if (existing) {
      if (!sameIdentityReplay(existing, operation, request, principal, nowMs)) {
        throw new IdentityAdministrationMutationConflictError();
      }
      return Object.freeze({
        status: 'existing',
        identity: existing.identity,
        mutation: existing.mutation,
      });
    }
    return identities.append({
      expectedCurrentVersion: request.expectedCurrentVersion,
      mutation: {
        mutationId: request.mutationId,
        operation,
        subject: request.subject,
        subjectVersion: request.expectedCurrentVersion + 1,
        expectedPreviousVersion: request.expectedCurrentVersion,
        status: operation === 'disable' ? 'disabled' : 'active',
        changedBy: principal.subject,
        createdAtMs: nowMs,
      },
      audit: audit(
        request.mutationId,
        request.requestId,
        `identity.${operation}`,
        principal,
        'identity_admin',
        nowMs,
      ),
    });
  };

  const mutateCredential = async (
    operation: 'issue' | 'rotate' | 'revoke',
    request:
      | ActiveCredentialAdministrationRequest
      | CredentialAdministrationRequest,
  ): Promise<CredentialAdministrationResult> => {
    exactObject(request, 'credential request');
    exactKeys(
      request,
      'credential request',
      operation === 'revoke'
        ? CREDENTIAL_REQUEST_KEYS
        : ACTIVE_CREDENTIAL_REQUEST_KEYS,
    );
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new ClusterAdministrationConfigurationError('clock is invalid');
    }
    const principal = administrationPrincipal(request.principal, nowMs);
    const existing = await credentials.resolveMutation(request.mutationId);
    if (existing) {
      if (
        !sameCredentialReplay(existing, operation, request, principal, nowMs)
      ) {
        throw new ApiCredentialAdministrationMutationConflictError();
      }
      return Object.freeze({
        status: 'existing',
        credential: existing.credential,
        mutation: existing.mutation,
        token: null,
      });
    }
    const identity = await identities.resolve(request.subject);
    if (!identity || (operation !== 'revoke' && identity.status !== 'active')) {
      throw new ClusterAdministrationSubjectUnavailableError();
    }

    let secret: Buffer | undefined;
    let secretBase64Url: string | null = null;
    let secretDigest = REVOKED_API_CREDENTIAL_DIGEST;
    let notBeforeAtMs = nowMs;
    let expiresAtMs = nowMs + 1;
    if (operation !== 'revoke') {
      const activeRequest = request as ActiveCredentialAdministrationRequest;
      notBeforeAtMs = activeRequest.notBeforeAtMs;
      expiresAtMs = activeRequest.expiresAtMs;
      if (
        !Number.isSafeInteger(notBeforeAtMs) ||
        notBeforeAtMs < nowMs ||
        !Number.isSafeInteger(expiresAtMs) ||
        expiresAtMs <= notBeforeAtMs ||
        expiresAtMs - nowMs > MAX_CREDENTIAL_LIFETIME_MS
      ) {
        throw new ClusterAdministrationConfigurationError(
          'credential lifetime is invalid',
        );
      }
      secret = randomBytes(32);
      if (!Buffer.isBuffer(secret) || secret.byteLength !== 32) {
        if (Buffer.isBuffer(secret)) secret.fill(0);
        throw new ClusterAdministrationConfigurationError(
          'randomBytes returned invalid secret material',
        );
      }
      try {
        secretBase64Url = secret.toString('base64url');
        secretDigest = apiCredentialSecretDigest(
          activePepperKey.pepper,
          request.credentialId,
          secretBase64Url,
        );
      } finally {
        secret.fill(0);
      }
    }

    const credential: ApiCredentialRecord = {
      credentialId: request.credentialId,
      version: request.expectedCurrentVersion + 1,
      pepperKeyId: activePepperKey.pepperKeyId,
      state: operation === 'revoke' ? 'revoked' : 'active',
      subject: request.subject,
      subjectStatus: identity.status,
      secretDigest,
      createdAtMs: nowMs,
      notBeforeAtMs,
      expiresAtMs,
    };
    const result = await credentials.append({
      expectedCurrentVersion: request.expectedCurrentVersion,
      credential,
      mutation: {
        mutationId: request.mutationId,
        operation,
        credentialId: request.credentialId,
        credentialVersion: request.expectedCurrentVersion + 1,
        expectedPreviousVersion: request.expectedCurrentVersion,
        changedBy: principal.subject,
        createdAtMs: nowMs,
      },
      audit: audit(
        request.mutationId,
        request.requestId,
        `credential.${operation}`,
        principal,
        'credential_admin',
        nowMs,
      ),
    });
    return Object.freeze({
      ...result,
      token:
        result.status === 'inserted' && secretBase64Url
          ? formatApiCredentialToken(request.credentialId, secretBase64Url)
          : null,
    });
  };

  return Object.freeze({
    registerIdentity: (request: IdentityAdministrationRequest) =>
      mutateIdentity('register', request),
    enableIdentity: (request: IdentityAdministrationRequest) =>
      mutateIdentity('enable', request),
    disableIdentity: (request: IdentityAdministrationRequest) =>
      mutateIdentity('disable', request),
    issueCredential: (request: ActiveCredentialAdministrationRequest) =>
      mutateCredential('issue', request),
    rotateCredential: (request: ActiveCredentialAdministrationRequest) =>
      mutateCredential('rotate', request),
    revokeCredential: (request: CredentialAdministrationRequest) =>
      mutateCredential('revoke', request),
  });
}
