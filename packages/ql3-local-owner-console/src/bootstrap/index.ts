import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import {
  LEGACY_API_CREDENTIAL_PEPPER_KEY_ID,
  assertApiCredentialPepperKeyId,
  type ApiCredentialRepository,
} from '@qinglong/runtime-core/api-credential';
import {
  apiCredentialSecretDigest,
  assertApiCredentialPepper,
  assertApiCredentialSecret,
  formatApiCredentialToken,
} from '@qinglong/runtime-core/api-credential-token';
import {
  LOCAL_OWNER_BOOTSTRAP_CHALLENGE_ID_BYTES,
  LOCAL_OWNER_BOOTSTRAP_DEFAULT_TTL_MS,
  LOCAL_OWNER_BOOTSTRAP_SYSTEM_SUBJECT,
  LOCAL_OWNER_BOOTSTRAP_TOKEN_BYTES,
  LocalOwnerBootstrapClaimRejectedError,
  LocalOwnerBootstrapMutationConflictError,
  LocalOwnerBootstrapUnavailableError,
  assertLocalOwnerBootstrapChallengeId,
  assertLocalOwnerBootstrapMutationId,
  assertLocalOwnerBootstrapRequestId,
  assertLocalOwnerBootstrapToken,
  assertLocalOwnerBootstrapTtl,
  localOwnerBootstrapTokenDigest,
  type ClaimLocalOwnerResult,
  type LocalOwnerBootstrapRepository,
} from '@qinglong/runtime-core/local-owner-bootstrap';
import { assertProjectPolicyProjectId } from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditOutcome,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';
import {
  LocalIdentityAuthenticationUnavailableError,
  createLocalIdentityAuthenticator,
} from '../authentication/identityAuthentication';

export const LOCAL_IDENTITY_BOOTSTRAP_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const LOCAL_IDENTITY_BOOTSTRAP_MIN_TTL_MS = 10 * 60 * 1000;
export const LOCAL_IDENTITY_BOOTSTRAP_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type RandomBytesFactory = (size: number) => Buffer;

export interface LocalIdentityCredentialDeliveryRecord {
  readonly kind: 'credential';
  readonly mutationId: string;
  readonly requestId: string;
  readonly subjectId: string;
  readonly credentialId: string;
  readonly secret: string;
  readonly ttlMs: number;
}

export interface LocalOwnerChallengeDeliveryRecord {
  readonly kind: 'challenge';
  readonly projectId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly challengeId: string;
  readonly secret: string;
  readonly ttlMs: number;
}

export type LocalOwnerBootstrapSecretDeliveryRecord =
  | LocalIdentityCredentialDeliveryRecord
  | LocalOwnerChallengeDeliveryRecord;

export interface LocalIdentityCredentialDeliveryAcknowledgement {
  readonly state: 'acknowledged';
  readonly kind: 'credential';
  readonly mutationId: string;
  readonly requestId: string;
  readonly ttlMs: number;
}

export interface LocalOwnerChallengeDeliveryAcknowledgement {
  readonly state: 'acknowledged';
  readonly kind: 'challenge';
  readonly projectId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly ttlMs: number;
}

export type LocalOwnerBootstrapSecretDeliveryAcknowledgement =
  | LocalIdentityCredentialDeliveryAcknowledgement
  | LocalOwnerChallengeDeliveryAcknowledgement;

export type LocalOwnerBootstrapSecretDeliveryPreparation =
  | LocalOwnerBootstrapSecretDeliveryRecord
  | LocalOwnerBootstrapSecretDeliveryAcknowledgement;

export interface LocalOwnerBootstrapSecretDelivery {
  prepare(
    candidate: Readonly<LocalOwnerBootstrapSecretDeliveryRecord>,
  ): Promise<Readonly<LocalOwnerBootstrapSecretDeliveryPreparation>>;
  publish(
    prepared: Readonly<LocalOwnerBootstrapSecretDeliveryRecord>,
  ): Promise<void>;
}

export interface ProvisionLocalIdentityRequest {
  readonly mutationId: string;
  readonly requestId: string;
  readonly credentialTtlMs?: number;
}

export interface ProvisionLocalIdentityResponse {
  readonly status: 'inserted' | 'existing';
  readonly subjectId: string;
  readonly credentialId: string;
  readonly credentialToken: string | null;
  readonly expiresAtMs: number;
}

export interface IssueLocalOwnerBootstrapRequest {
  readonly projectId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly ttlMs?: number;
}

export interface IssueLocalOwnerBootstrapResponse {
  readonly status: 'inserted' | 'existing';
  readonly challengeId: string;
  readonly challengeToken: string | null;
  readonly expiresAtMs: number;
}

export interface ClaimLocalOwnerRequest {
  readonly projectId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly challengeId: string;
  readonly challengeToken: string;
  readonly credentialToken: string;
}

export interface LocalOwnerBootstrapService {
  provision(
    request: ProvisionLocalIdentityRequest,
  ): Promise<Readonly<ProvisionLocalIdentityResponse>>;
  issue(
    request: IssueLocalOwnerBootstrapRequest,
  ): Promise<Readonly<IssueLocalOwnerBootstrapResponse>>;
  claim(request: ClaimLocalOwnerRequest): Promise<ClaimLocalOwnerResult>;
}

export interface LocalOwnerBootstrapServiceOptions {
  readonly now?: () => number;
  readonly pepperKeyId?: string;
  readonly randomBytes?: RandomBytesFactory;
  readonly secretDelivery?: LocalOwnerBootstrapSecretDelivery;
}

export class LocalOwnerBootstrapConfigurationError extends TypeError {
  constructor(message: string) {
    super(`Local Owner bootstrap configuration is invalid: ${message}`);
    this.name = 'LocalOwnerBootstrapConfigurationError';
  }
}

export class LocalOwnerBootstrapRejectedError extends Error {
  readonly code = 'LOCAL_OWNER_BOOTSTRAP_REJECTED';

  constructor() {
    super('Local Owner bootstrap request was rejected');
    this.name = 'LocalOwnerBootstrapRejectedError';
  }
}

export class LocalOwnerBootstrapServiceUnavailableError extends Error {
  readonly code = 'LOCAL_OWNER_BOOTSTRAP_SERVICE_UNAVAILABLE';

  constructor() {
    super('Local Owner bootstrap service is unavailable');
    this.name = 'LocalOwnerBootstrapServiceUnavailableError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function currentTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalOwnerBootstrapConfigurationError('clock is invalid');
  }
  return value;
}

function lifetime(nowMs: number, ttlMs: number): number {
  const value = nowMs + ttlMs;
  if (!Number.isSafeInteger(value)) {
    throw new LocalOwnerBootstrapConfigurationError('lifetime is invalid');
  }
  return value;
}

function credentialTtl(value: number | undefined): number {
  const resolved = value ?? LOCAL_IDENTITY_BOOTSTRAP_DEFAULT_TTL_MS;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < LOCAL_IDENTITY_BOOTSTRAP_MIN_TTL_MS ||
    resolved > LOCAL_IDENTITY_BOOTSTRAP_MAX_TTL_MS
  ) {
    throw new LocalOwnerBootstrapConfigurationError(
      'credentialTtlMs is invalid',
    );
  }
  return resolved;
}

function localConsoleIssuer(
  value: SecurityPrincipal,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  try {
    const principal = normalizeSecurityPrincipal(value, nowMs);
    if (
      principal.subject.type !== LOCAL_OWNER_BOOTSTRAP_SYSTEM_SUBJECT.type ||
      principal.subject.id !== LOCAL_OWNER_BOOTSTRAP_SYSTEM_SUBJECT.id ||
      principal.assurance !== 'local_console'
    ) {
      throw new Error('issuer mismatch');
    }
    return principal;
  } catch {
    throw new LocalOwnerBootstrapConfigurationError('issuer is invalid');
  }
}

function randomToken(factory: RandomBytesFactory, size: number): string {
  let material: Buffer;
  try {
    material = factory(size);
  } catch {
    throw new LocalOwnerBootstrapServiceUnavailableError();
  }
  if (!Buffer.isBuffer(material) || material.byteLength !== size) {
    throw new LocalOwnerBootstrapConfigurationError(
      'randomBytes result is invalid',
    );
  }
  try {
    return material.toString('base64url');
  } finally {
    material.fill(0);
  }
}

export function normalizeLocalOwnerBootstrapSecretDeliveryRecord(
  raw: unknown,
): Readonly<LocalOwnerBootstrapSecretDeliveryRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LocalOwnerBootstrapServiceUnavailableError();
  }
  const value = raw as LocalOwnerBootstrapSecretDeliveryRecord;
  try {
    assertLocalOwnerBootstrapMutationId(value.mutationId);
    assertLocalOwnerBootstrapRequestId(value.requestId);
  } catch {
    throw new LocalOwnerBootstrapServiceUnavailableError();
  }
  if (value.kind === 'credential') {
    if (
      !exactKeys(value, [
        'kind',
        'mutationId',
        'requestId',
        'subjectId',
        'credentialId',
        'secret',
        'ttlMs',
      ]) ||
      !/^usr_[A-Za-z0-9_-]{22}$/.test(value.subjectId) ||
      !/^own_[A-Za-z0-9_-]{22}$/.test(value.credentialId)
    ) {
      throw new LocalOwnerBootstrapServiceUnavailableError();
    }
    try {
      assertApiCredentialSecret(value.secret);
      credentialTtl(value.ttlMs);
    } catch {
      throw new LocalOwnerBootstrapServiceUnavailableError();
    }
    return Object.freeze({ ...value });
  }
  if (
    value.kind !== 'challenge' ||
    !exactKeys(value, [
      'kind',
      'projectId',
      'mutationId',
      'requestId',
      'challengeId',
      'secret',
      'ttlMs',
    ])
  ) {
    throw new LocalOwnerBootstrapServiceUnavailableError();
  }
  try {
    assertProjectPolicyProjectId(value.projectId);
    assertLocalOwnerBootstrapChallengeId(value.challengeId);
    assertLocalOwnerBootstrapToken(value.secret);
    assertLocalOwnerBootstrapTtl(value.ttlMs);
  } catch {
    throw new LocalOwnerBootstrapServiceUnavailableError();
  }
  return Object.freeze({ ...value });
}

export function normalizeLocalOwnerBootstrapSecretDeliveryPreparation(
  raw: unknown,
): Readonly<LocalOwnerBootstrapSecretDeliveryPreparation> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'state' in raw) {
    const value = raw as LocalOwnerBootstrapSecretDeliveryAcknowledgement;
    try {
      assertLocalOwnerBootstrapMutationId(value.mutationId);
      assertLocalOwnerBootstrapRequestId(value.requestId);
    } catch {
      throw new LocalOwnerBootstrapServiceUnavailableError();
    }
    if (value.kind === 'credential') {
      if (
        !exactKeys(value, [
          'state',
          'kind',
          'mutationId',
          'requestId',
          'ttlMs',
        ]) ||
        value.state !== 'acknowledged'
      ) {
        throw new LocalOwnerBootstrapServiceUnavailableError();
      }
      try {
        credentialTtl(value.ttlMs);
      } catch {
        throw new LocalOwnerBootstrapServiceUnavailableError();
      }
      return Object.freeze({ ...value });
    }
    if (
      value.kind !== 'challenge' ||
      value.state !== 'acknowledged' ||
      !exactKeys(value, [
        'state',
        'kind',
        'projectId',
        'mutationId',
        'requestId',
        'ttlMs',
      ])
    ) {
      throw new LocalOwnerBootstrapServiceUnavailableError();
    }
    try {
      assertProjectPolicyProjectId(value.projectId);
      assertLocalOwnerBootstrapTtl(value.ttlMs);
    } catch {
      throw new LocalOwnerBootstrapServiceUnavailableError();
    }
    return Object.freeze({ ...value });
  }
  return normalizeLocalOwnerBootstrapSecretDeliveryRecord(raw);
}

function credentialDeliveryRecord(
  raw: LocalOwnerBootstrapSecretDeliveryPreparation,
  expected: Pick<
    LocalIdentityCredentialDeliveryRecord,
    'mutationId' | 'requestId' | 'ttlMs'
  >,
): Readonly<LocalIdentityCredentialDeliveryRecord> {
  const value = normalizeLocalOwnerBootstrapSecretDeliveryPreparation(raw);
  if (
    'state' in value ||
    value.kind !== 'credential' ||
    value.mutationId !== expected.mutationId ||
    value.requestId !== expected.requestId ||
    value.ttlMs !== expected.ttlMs
  ) {
    throw new LocalOwnerBootstrapServiceUnavailableError();
  }
  return Object.freeze({ ...value });
}

function challengeDeliveryRecord(
  raw: LocalOwnerBootstrapSecretDeliveryPreparation,
  expected: Pick<
    LocalOwnerChallengeDeliveryRecord,
    'projectId' | 'mutationId' | 'requestId' | 'ttlMs'
  >,
): Readonly<LocalOwnerChallengeDeliveryRecord> {
  const value = normalizeLocalOwnerBootstrapSecretDeliveryPreparation(raw);
  if (
    'state' in value ||
    value.kind !== 'challenge' ||
    value.projectId !== expected.projectId ||
    value.mutationId !== expected.mutationId ||
    value.requestId !== expected.requestId ||
    value.ttlMs !== expected.ttlMs
  ) {
    throw new LocalOwnerBootstrapServiceUnavailableError();
  }
  return Object.freeze({ ...value });
}

function audit(value: SecurityAuditRecord): Readonly<SecurityAuditRecord> {
  return normalizeSecurityAuditRecord(value);
}

function failureAudit(options: {
  request: ClaimLocalOwnerRequest;
  occurredAtMs: number;
  outcome: SecurityAuditOutcome;
  reason: string;
  principal?: Readonly<SecurityPrincipal>;
  projectVersion?: number;
}): Readonly<SecurityAuditRecord> {
  return audit({
    eventId: options.request.mutationId,
    requestId: options.request.requestId,
    operationId: 'project.owner_bootstrap_claim',
    projectId: options.request.projectId,
    subject: options.principal?.subject ?? null,
    authenticationId: options.principal?.authenticationId ?? null,
    outcome: options.outcome,
    reasons: [options.reason],
    fence:
      options.projectVersion === undefined
        ? null
        : { projectVersion: options.projectVersion, bindingVersion: null },
    occurredAtMs: options.occurredAtMs,
  });
}

function assertProvisionRequest(request: ProvisionLocalIdentityRequest): void {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    !exactKeys(
      request,
      request.credentialTtlMs === undefined
        ? ['mutationId', 'requestId']
        : ['mutationId', 'requestId', 'credentialTtlMs'],
    )
  ) {
    throw new LocalOwnerBootstrapConfigurationError(
      'provision request shape is invalid',
    );
  }
  try {
    assertLocalOwnerBootstrapMutationId(request.mutationId);
    assertLocalOwnerBootstrapRequestId(request.requestId);
  } catch {
    throw new LocalOwnerBootstrapConfigurationError(
      'provision request identity is invalid',
    );
  }
  credentialTtl(request.credentialTtlMs);
}

function assertIssueRequest(request: IssueLocalOwnerBootstrapRequest): void {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    !exactKeys(
      request,
      request.ttlMs === undefined
        ? ['projectId', 'mutationId', 'requestId']
        : ['projectId', 'mutationId', 'requestId', 'ttlMs'],
    )
  ) {
    throw new LocalOwnerBootstrapConfigurationError(
      'issue request shape is invalid',
    );
  }
  try {
    assertProjectPolicyProjectId(request.projectId);
    assertLocalOwnerBootstrapMutationId(request.mutationId);
    assertLocalOwnerBootstrapRequestId(request.requestId);
    assertLocalOwnerBootstrapTtl(
      request.ttlMs ?? LOCAL_OWNER_BOOTSTRAP_DEFAULT_TTL_MS,
    );
  } catch {
    throw new LocalOwnerBootstrapConfigurationError(
      'issue request value is invalid',
    );
  }
}

function assertClaimRequest(request: ClaimLocalOwnerRequest): void {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    !exactKeys(request, [
      'projectId',
      'mutationId',
      'requestId',
      'challengeId',
      'challengeToken',
      'credentialToken',
    ])
  ) {
    throw new LocalOwnerBootstrapConfigurationError(
      'claim request shape is invalid',
    );
  }
  try {
    assertProjectPolicyProjectId(request.projectId);
    assertLocalOwnerBootstrapMutationId(request.mutationId);
    assertLocalOwnerBootstrapRequestId(request.requestId);
    assertLocalOwnerBootstrapChallengeId(request.challengeId);
    assertLocalOwnerBootstrapToken(request.challengeToken);
  } catch {
    throw new LocalOwnerBootstrapConfigurationError(
      'claim request value is invalid',
    );
  }
  if (
    typeof request.credentialToken !== 'string' ||
    request.credentialToken.length > 256
  ) {
    throw new LocalOwnerBootstrapConfigurationError(
      'credentialToken is invalid',
    );
  }
}

function sameAuthority(
  left: Readonly<SecurityPrincipal>,
  right: Readonly<SecurityPrincipal>,
): boolean {
  return (
    left.subject.type === right.subject.type &&
    left.subject.id === right.subject.id &&
    left.authenticationId === right.authenticationId &&
    left.assurance === right.assurance
  );
}

export function createLocalOwnerBootstrapService(
  repository: LocalOwnerBootstrapRepository,
  apiCredentials: ApiCredentialRepository,
  pepper: string,
  authority: SecurityPrincipal,
  options: LocalOwnerBootstrapServiceOptions = {},
): LocalOwnerBootstrapService {
  if (
    !repository ||
    typeof repository.resolveProjectVersion !== 'function' ||
    typeof repository.resolveProvisioning !== 'function' ||
    typeof repository.resolveIssuedChallenge !== 'function' ||
    typeof repository.provision !== 'function' ||
    typeof repository.issue !== 'function' ||
    typeof repository.claim !== 'function' ||
    typeof repository.recordAudit !== 'function'
  ) {
    throw new LocalOwnerBootstrapConfigurationError('repository is invalid');
  }
  if (!apiCredentials || typeof apiCredentials.resolve !== 'function') {
    throw new LocalOwnerBootstrapConfigurationError(
      'API credential repository is invalid',
    );
  }
  try {
    assertApiCredentialPepper(pepper);
  } catch {
    throw new LocalOwnerBootstrapConfigurationError('pepper is invalid');
  }
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, [
      ...(options.now === undefined ? [] : ['now']),
      ...(options.pepperKeyId === undefined ? [] : ['pepperKeyId']),
      ...(options.randomBytes === undefined ? [] : ['randomBytes']),
      ...(options.secretDelivery === undefined ? [] : ['secretDelivery']),
    ]) ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.randomBytes !== undefined &&
      typeof options.randomBytes !== 'function') ||
    (options.secretDelivery !== undefined &&
      (!options.secretDelivery ||
        typeof options.secretDelivery !== 'object' ||
        typeof options.secretDelivery.prepare !== 'function' ||
        typeof options.secretDelivery.publish !== 'function'))
  ) {
    throw new LocalOwnerBootstrapConfigurationError('options are invalid');
  }
  const pepperKeyId =
    options.pepperKeyId ?? LEGACY_API_CREDENTIAL_PEPPER_KEY_ID;
  try {
    assertApiCredentialPepperKeyId(pepperKeyId);
  } catch {
    throw new LocalOwnerBootstrapConfigurationError('pepperKeyId is invalid');
  }
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  const secretDelivery = options.secretDelivery;
  const authenticator = createLocalIdentityAuthenticator(
    apiCredentials,
    pepper,
    { now, pepperKeyId },
  );

  async function recordFailure(record: Readonly<SecurityAuditRecord>) {
    try {
      await repository.recordAudit(record);
    } catch {
      throw new LocalOwnerBootstrapServiceUnavailableError();
    }
  }

  return Object.freeze({
    async provision(request: ProvisionLocalIdentityRequest) {
      assertProvisionRequest(request);
      const nowMs = currentTime(now);
      const issuer = localConsoleIssuer(authority, nowMs);
      const ttlMs = credentialTtl(request.credentialTtlMs);
      try {
        const acknowledged = await repository.resolveDeliveryAcknowledgement(
          request.mutationId,
        );
        if (acknowledged) {
          if (
            acknowledged.kind !== 'credential' ||
            acknowledged.requestId !== request.requestId ||
            acknowledged.ttlMs !== ttlMs
          ) {
            throw new LocalOwnerBootstrapMutationConflictError();
          }
          const replay = await repository.resolveProvisioning(
            request.mutationId,
          );
          if (!replay) throw new LocalOwnerBootstrapServiceUnavailableError();
          if (
            replay.requestId !== request.requestId ||
            replay.identity.subject.id !== acknowledged.subjectId ||
            replay.credential.credentialId !== acknowledged.credentialId ||
            replay.credential.pepperKeyId !== pepperKeyId ||
            replay.credential.secretDigest !== acknowledged.factDigest ||
            !sameAuthority(replay.issuer, issuer) ||
            replay.credential.expiresAtMs - replay.credential.notBeforeAtMs !==
              ttlMs
          ) {
            throw new LocalOwnerBootstrapMutationConflictError();
          }
          return Object.freeze({
            status: 'existing' as const,
            subjectId: replay.identity.subject.id,
            credentialId: replay.credential.credentialId,
            credentialToken: null,
            expiresAtMs: replay.credential.expiresAtMs,
          });
        }
      } catch (error) {
        if (
          error instanceof LocalOwnerBootstrapMutationConflictError ||
          error instanceof LocalOwnerBootstrapServiceUnavailableError
        ) {
          throw error;
        }
        throw new LocalOwnerBootstrapServiceUnavailableError();
      }
      const candidate: Readonly<LocalIdentityCredentialDeliveryRecord> =
        Object.freeze({
          kind: 'credential',
          mutationId: request.mutationId,
          requestId: request.requestId,
          subjectId: `usr_${randomToken(randomBytes, 16)}`,
          credentialId: `own_${randomToken(randomBytes, 16)}`,
          secret: randomToken(randomBytes, 32),
          ttlMs,
        });
      let prepared = candidate;
      if (secretDelivery) {
        try {
          const preparation =
            normalizeLocalOwnerBootstrapSecretDeliveryPreparation(
              await secretDelivery.prepare(candidate),
            );
          if ('state' in preparation && preparation.state === 'acknowledged') {
            if (
              preparation.kind !== 'credential' ||
              preparation.mutationId !== request.mutationId ||
              preparation.requestId !== request.requestId ||
              preparation.ttlMs !== ttlMs
            ) {
              throw new LocalOwnerBootstrapServiceUnavailableError();
            }
            const replay = await repository.resolveProvisioning(
              request.mutationId,
            );
            if (!replay) throw new LocalOwnerBootstrapServiceUnavailableError();
            if (
              replay.requestId !== request.requestId ||
              replay.credential.pepperKeyId !== pepperKeyId ||
              !sameAuthority(replay.issuer, issuer) ||
              replay.credential.expiresAtMs -
                replay.credential.notBeforeAtMs !==
                ttlMs
            ) {
              throw new LocalOwnerBootstrapMutationConflictError();
            }
            return Object.freeze({
              status: 'existing' as const,
              subjectId: replay.identity.subject.id,
              credentialId: replay.credential.credentialId,
              credentialToken: null,
              expiresAtMs: replay.credential.expiresAtMs,
            });
          }
          prepared = credentialDeliveryRecord(preparation, candidate);
        } catch (error) {
          if (
            error instanceof LocalOwnerBootstrapServiceUnavailableError ||
            error instanceof LocalOwnerBootstrapMutationConflictError
          )
            throw error;
          throw new LocalOwnerBootstrapServiceUnavailableError();
        }
      }
      const { subjectId, credentialId, secret } = prepared;
      const secretDigest = apiCredentialSecretDigest(
        pepper,
        credentialId,
        secret,
      );
      const expiresAtMs = lifetime(nowMs, ttlMs);
      const result = await repository.provision({
        mutationId: request.mutationId,
        requestId: request.requestId,
        identity: {
          subject: { type: 'user', id: subjectId },
          status: 'active',
          version: 1,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        },
        credential: {
          credentialId,
          version: 1,
          pepperKeyId,
          state: 'active',
          subject: { type: 'user', id: subjectId },
          subjectStatus: 'active',
          secretDigest,
          createdAtMs: nowMs,
          notBeforeAtMs: nowMs,
          expiresAtMs,
        },
        issuer,
        audit: audit({
          eventId: request.mutationId,
          requestId: request.requestId,
          operationId: 'identity.bootstrap_provision',
          projectId: null,
          subject: issuer.subject,
          authenticationId: issuer.authenticationId,
          outcome: 'allowed',
          reasons: ['local_console_provisioning'],
          fence: null,
          occurredAtMs: nowMs,
        }),
        createdAtMs: nowMs,
      });
      if (secretDelivery) {
        if (
          result.provisioning.identity.subject.id !== subjectId ||
          result.provisioning.credential.credentialId !== credentialId ||
          result.provisioning.credential.secretDigest !== secretDigest ||
          result.provisioning.credential.expiresAtMs -
            result.provisioning.credential.notBeforeAtMs !==
            ttlMs
        ) {
          throw new LocalOwnerBootstrapServiceUnavailableError();
        }
        try {
          await secretDelivery.publish(prepared);
        } catch {
          throw new LocalOwnerBootstrapServiceUnavailableError();
        }
      }
      return Object.freeze({
        status: result.status,
        subjectId: result.provisioning.identity.subject.id,
        credentialId: result.provisioning.credential.credentialId,
        credentialToken:
          !secretDelivery && result.status === 'inserted'
            ? formatApiCredentialToken(credentialId, secret)
            : null,
        expiresAtMs: result.provisioning.credential.expiresAtMs,
      });
    },

    async issue(request: IssueLocalOwnerBootstrapRequest) {
      assertIssueRequest(request);
      const nowMs = currentTime(now);
      const issuer = localConsoleIssuer(authority, nowMs);
      const ttlMs = request.ttlMs ?? LOCAL_OWNER_BOOTSTRAP_DEFAULT_TTL_MS;
      try {
        const acknowledged = await repository.resolveDeliveryAcknowledgement(
          request.mutationId,
        );
        if (acknowledged) {
          if (
            acknowledged.kind !== 'challenge' ||
            acknowledged.projectId !== request.projectId ||
            acknowledged.requestId !== request.requestId ||
            acknowledged.ttlMs !== ttlMs
          ) {
            throw new LocalOwnerBootstrapMutationConflictError();
          }
          const replay = await repository.resolveIssuedChallenge(
            request.mutationId,
          );
          if (!replay) throw new LocalOwnerBootstrapServiceUnavailableError();
          if (
            replay.projectId !== request.projectId ||
            replay.issueRequestId !== request.requestId ||
            replay.challengeId !== acknowledged.challengeId ||
            replay.tokenDigest !== acknowledged.factDigest ||
            !sameAuthority(replay.issuer, issuer) ||
            replay.expiresAtMs - replay.issuedAtMs !== ttlMs
          ) {
            throw new LocalOwnerBootstrapMutationConflictError();
          }
          return Object.freeze({
            status: 'existing' as const,
            challengeId: replay.challengeId,
            challengeToken: null,
            expiresAtMs: replay.expiresAtMs,
          });
        }
      } catch (error) {
        if (
          error instanceof LocalOwnerBootstrapMutationConflictError ||
          error instanceof LocalOwnerBootstrapServiceUnavailableError
        ) {
          throw error;
        }
        throw new LocalOwnerBootstrapServiceUnavailableError();
      }
      const candidate: Readonly<LocalOwnerChallengeDeliveryRecord> =
        Object.freeze({
          kind: 'challenge',
          projectId: request.projectId,
          mutationId: request.mutationId,
          requestId: request.requestId,
          challengeId: randomToken(
            randomBytes,
            LOCAL_OWNER_BOOTSTRAP_CHALLENGE_ID_BYTES,
          ),
          secret: randomToken(randomBytes, LOCAL_OWNER_BOOTSTRAP_TOKEN_BYTES),
          ttlMs,
        });
      let prepared = candidate;
      if (secretDelivery) {
        try {
          const preparation =
            normalizeLocalOwnerBootstrapSecretDeliveryPreparation(
              await secretDelivery.prepare(candidate),
            );
          if ('state' in preparation && preparation.state === 'acknowledged') {
            if (
              preparation.kind !== 'challenge' ||
              preparation.projectId !== request.projectId ||
              preparation.mutationId !== request.mutationId ||
              preparation.requestId !== request.requestId ||
              preparation.ttlMs !== ttlMs
            ) {
              throw new LocalOwnerBootstrapServiceUnavailableError();
            }
            const replay = await repository.resolveIssuedChallenge(
              request.mutationId,
            );
            if (!replay) throw new LocalOwnerBootstrapServiceUnavailableError();
            if (
              replay.projectId !== request.projectId ||
              replay.issueRequestId !== request.requestId ||
              !sameAuthority(replay.issuer, issuer) ||
              replay.expiresAtMs - replay.issuedAtMs !== ttlMs
            ) {
              throw new LocalOwnerBootstrapMutationConflictError();
            }
            return Object.freeze({
              status: 'existing' as const,
              challengeId: replay.challengeId,
              challengeToken: null,
              expiresAtMs: replay.expiresAtMs,
            });
          }
          prepared = challengeDeliveryRecord(preparation, candidate);
        } catch (error) {
          if (
            error instanceof LocalOwnerBootstrapServiceUnavailableError ||
            error instanceof LocalOwnerBootstrapMutationConflictError
          )
            throw error;
          throw new LocalOwnerBootstrapServiceUnavailableError();
        }
      }
      const challengeId = prepared.challengeId;
      const challengeToken = prepared.secret;
      const expiresAtMs = lifetime(nowMs, ttlMs);
      const result = await repository.issue({
        projectId: request.projectId,
        mutationId: request.mutationId,
        requestId: request.requestId,
        challengeId,
        tokenDigest: localOwnerBootstrapTokenDigest(
          request.projectId,
          challengeId,
          challengeToken,
        ),
        issuer,
        issuedAtMs: nowMs,
        expiresAtMs,
        audit: audit({
          eventId: request.mutationId,
          requestId: request.requestId,
          operationId: 'project.owner_bootstrap_issue',
          projectId: request.projectId,
          subject: issuer.subject,
          authenticationId: issuer.authenticationId,
          outcome: 'allowed',
          reasons: ['local_console_challenge'],
          fence: null,
          occurredAtMs: nowMs,
        }),
      });
      if (secretDelivery) {
        if (
          result.challenge.projectId !== request.projectId ||
          result.challenge.challengeId !== challengeId ||
          result.challenge.tokenDigest !==
            localOwnerBootstrapTokenDigest(
              request.projectId,
              challengeId,
              challengeToken,
            ) ||
          result.challenge.expiresAtMs - result.challenge.issuedAtMs !== ttlMs
        ) {
          throw new LocalOwnerBootstrapServiceUnavailableError();
        }
        try {
          await secretDelivery.publish(prepared);
        } catch {
          throw new LocalOwnerBootstrapServiceUnavailableError();
        }
      }
      return Object.freeze({
        status: result.status,
        challengeId: result.challenge.challengeId,
        challengeToken:
          !secretDelivery && result.status === 'inserted'
            ? challengeToken
            : null,
        expiresAtMs: result.challenge.expiresAtMs,
      });
    },

    async claim(request: ClaimLocalOwnerRequest) {
      assertClaimRequest(request);
      let authentication;
      try {
        authentication = await authenticator.authenticateCredential(
          request.credentialToken,
        );
      } catch (error) {
        const occurredAtMs = currentTime(now);
        await recordFailure(
          failureAudit({
            request,
            occurredAtMs,
            outcome: 'authentication_unavailable',
            reason: 'credential_unavailable',
          }),
        );
        if (error instanceof LocalIdentityAuthenticationUnavailableError) {
          throw new LocalOwnerBootstrapServiceUnavailableError();
        }
        throw new LocalOwnerBootstrapServiceUnavailableError();
      }
      if (!authentication) {
        await recordFailure(
          failureAudit({
            request,
            occurredAtMs: currentTime(now),
            outcome: 'authentication_rejected',
            reason: 'credential_rejected',
          }),
        );
        throw new LocalOwnerBootstrapRejectedError();
      }
      const claimedAtMs = authentication.principal.authenticatedAtMs;
      let projectVersion: number | null;
      try {
        projectVersion = await repository.resolveProjectVersion(
          request.projectId,
        );
      } catch {
        await recordFailure(
          failureAudit({
            request,
            occurredAtMs: claimedAtMs,
            outcome: 'authorization_unavailable',
            reason: 'project_unavailable',
            principal: authentication.principal,
          }),
        );
        throw new LocalOwnerBootstrapServiceUnavailableError();
      }
      if (projectVersion === null) {
        await recordFailure(
          failureAudit({
            request,
            occurredAtMs: claimedAtMs,
            outcome: 'denied',
            reason: 'owner_bootstrap_rejected',
            principal: authentication.principal,
          }),
        );
        throw new LocalOwnerBootstrapRejectedError();
      }
      try {
        return await repository.claim({
          projectId: request.projectId,
          mutationId: request.mutationId,
          requestId: request.requestId,
          challengeId: request.challengeId,
          tokenDigest: localOwnerBootstrapTokenDigest(
            request.projectId,
            request.challengeId,
            request.challengeToken,
          ),
          principal: authentication.principal,
          credentialId: authentication.credentialId,
          credentialVersion: authentication.credentialVersion,
          claimedAtMs,
          audit: audit({
            eventId: request.mutationId,
            requestId: request.requestId,
            operationId: 'project.owner_bootstrap_claim',
            projectId: request.projectId,
            subject: authentication.principal.subject,
            authenticationId: authentication.principal.authenticationId,
            outcome: 'allowed',
            reasons: ['owner_bootstrap_claim'],
            fence: { projectVersion, bindingVersion: 1 },
            occurredAtMs: claimedAtMs,
          }),
        });
      } catch (error) {
        if (error instanceof LocalOwnerBootstrapMutationConflictError) {
          throw error;
        }
        const unavailable =
          error instanceof LocalOwnerBootstrapUnavailableError;
        await recordFailure(
          failureAudit({
            request,
            occurredAtMs: claimedAtMs,
            outcome: unavailable ? 'authorization_unavailable' : 'denied',
            reason: unavailable
              ? 'owner_bootstrap_unavailable'
              : 'owner_bootstrap_rejected',
            principal: authentication.principal,
            projectVersion,
          }),
        );
        if (unavailable) {
          throw new LocalOwnerBootstrapServiceUnavailableError();
        }
        if (error instanceof LocalOwnerBootstrapClaimRejectedError) {
          throw new LocalOwnerBootstrapRejectedError();
        }
        throw new LocalOwnerBootstrapRejectedError();
      }
    },
  });
}
