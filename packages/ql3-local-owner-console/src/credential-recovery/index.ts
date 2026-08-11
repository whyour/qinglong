import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import {
  REVOKED_API_CREDENTIAL_DIGEST,
  type ApiCredentialMutationRecord,
} from '@qinglong/runtime-core/api-credential-administration';
import {
  assertApiCredentialId,
  assertApiCredentialPepperKeyId,
  type ApiCredentialRecord,
  type ApiCredentialRepository,
} from '@qinglong/runtime-core/api-credential';
import {
  apiCredentialSecretDigest,
  assertApiCredentialPepper,
  formatApiCredentialToken,
} from '@qinglong/runtime-core/api-credential-token';
import {
  LocalOwnerCredentialRecoveryCredentialUnavailableError,
  LocalOwnerCredentialRecoveryInProgressError,
  LocalOwnerCredentialRecoveryMutationConflictError,
  LocalOwnerCredentialRecoveryNotAcknowledgedError,
  type LocalOwnerCredentialRecoveryRecord,
  type LocalOwnerCredentialRecoveryRepository,
} from '@qinglong/runtime-core/local-owner-credential-recovery';
import {
  assertLocalOwnerBootstrapMutationId,
  assertLocalOwnerBootstrapRequestId,
} from '@qinglong/runtime-core/local-owner-bootstrap';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

export const LOCAL_OWNER_CREDENTIAL_RECOVERY_DEFAULT_TTL_MS =
  24 * 60 * 60 * 1000;
export const LOCAL_OWNER_CREDENTIAL_RECOVERY_MIN_TTL_MS = 10 * 60 * 1000;
export const LOCAL_OWNER_CREDENTIAL_RECOVERY_MAX_TTL_MS =
  7 * 24 * 60 * 60 * 1000;

type RandomBytesFactory = (size: number) => Buffer;

export interface LocalOwnerCredentialRecoveryDeliveryRecord {
  readonly kind: 'credential';
  readonly mutationId: string;
  readonly requestId: string;
  readonly subjectId: string;
  readonly credentialId: string;
  readonly secret: string;
  readonly ttlMs: number;
}

export interface LocalOwnerCredentialRecoveryDeliveryAcknowledgement {
  readonly state: 'acknowledged';
  readonly kind: 'credential';
  readonly mutationId: string;
  readonly requestId: string;
  readonly ttlMs: number;
}

export type LocalOwnerCredentialRecoveryDeliveryPreparation =
  | LocalOwnerCredentialRecoveryDeliveryRecord
  | LocalOwnerCredentialRecoveryDeliveryAcknowledgement;

export interface LocalOwnerCredentialRecoverySecretDelivery {
  prepare(
    candidate: Readonly<LocalOwnerCredentialRecoveryDeliveryRecord>,
  ): Promise<Readonly<LocalOwnerCredentialRecoveryDeliveryPreparation>>;
  publish(
    prepared: Readonly<LocalOwnerCredentialRecoveryDeliveryRecord>,
  ): Promise<void>;
}

export interface IssueLocalOwnerCredentialRecoveryRequest {
  readonly mutationId: string;
  readonly requestId: string;
  readonly previousCredentialId: string;
  readonly expectedPreviousVersion: number;
  readonly credentialTtlMs?: number;
}

export interface IssueLocalOwnerCredentialRecoveryResponse {
  readonly status: 'inserted' | 'existing';
  readonly subjectId: string;
  readonly previousCredentialId: string;
  readonly replacementCredentialId: string;
  readonly replacementCredentialToken: string | null;
  readonly expiresAtMs: number;
  readonly state: LocalOwnerCredentialRecoveryRecord['state'];
}

export interface CompleteLocalOwnerCredentialRecoveryRequest {
  readonly issueMutationId: string;
  readonly mutationId: string;
  readonly requestId: string;
}

export interface CompleteLocalOwnerCredentialRecoveryResponse {
  readonly status: 'inserted' | 'existing';
  readonly previousCredentialId: string;
  readonly replacementCredentialId: string;
  readonly state: 'completed';
}

export interface LocalOwnerCredentialRecoveryService {
  issue(
    request: IssueLocalOwnerCredentialRecoveryRequest,
  ): Promise<Readonly<IssueLocalOwnerCredentialRecoveryResponse>>;
  complete(
    request: CompleteLocalOwnerCredentialRecoveryRequest,
  ): Promise<Readonly<CompleteLocalOwnerCredentialRecoveryResponse>>;
}

export interface LocalOwnerCredentialRecoveryServiceOptions {
  readonly now?: () => number;
  readonly randomBytes?: RandomBytesFactory;
  readonly pepperKeyId: string;
  readonly secretDelivery?: LocalOwnerCredentialRecoverySecretDelivery;
}

export class LocalOwnerCredentialRecoveryConfigurationError extends TypeError {
  constructor(message: string) {
    super(
      `Local Owner credential recovery configuration is invalid: ${message}`,
    );
    this.name = 'LocalOwnerCredentialRecoveryConfigurationError';
  }
}

export class LocalOwnerCredentialRecoveryServiceUnavailableError extends Error {
  readonly code = 'LOCAL_OWNER_CREDENTIAL_RECOVERY_SERVICE_UNAVAILABLE';

  constructor() {
    super('Local Owner credential recovery service is unavailable');
    this.name = 'LocalOwnerCredentialRecoveryServiceUnavailableError';
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

function clock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalOwnerCredentialRecoveryConfigurationError(
      'clock is invalid',
    );
  }
  return value;
}

function ttl(value: number | undefined): number {
  const result = value ?? LOCAL_OWNER_CREDENTIAL_RECOVERY_DEFAULT_TTL_MS;
  if (
    !Number.isSafeInteger(result) ||
    result < LOCAL_OWNER_CREDENTIAL_RECOVERY_MIN_TTL_MS ||
    result > LOCAL_OWNER_CREDENTIAL_RECOVERY_MAX_TTL_MS
  ) {
    throw new LocalOwnerCredentialRecoveryConfigurationError(
      'credentialTtlMs is invalid',
    );
  }
  return result;
}

function randomToken(factory: RandomBytesFactory, size: number): string {
  const bytes = factory(size);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== size) {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
    throw new LocalOwnerCredentialRecoveryConfigurationError(
      'randomBytes returned invalid material',
    );
  }
  try {
    return bytes.toString('base64url');
  } finally {
    bytes.fill(0);
  }
}

function issueRequest(request: IssueLocalOwnerCredentialRecoveryRequest): void {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    !exactKeys(request, [
      'mutationId',
      'requestId',
      'previousCredentialId',
      'expectedPreviousVersion',
      ...(request.credentialTtlMs === undefined ? [] : ['credentialTtlMs']),
    ])
  ) {
    throw new LocalOwnerCredentialRecoveryConfigurationError(
      'issue request shape is invalid',
    );
  }
  try {
    assertLocalOwnerBootstrapMutationId(request.mutationId);
    assertLocalOwnerBootstrapRequestId(request.requestId);
    assertApiCredentialId(request.previousCredentialId);
  } catch {
    throw new LocalOwnerCredentialRecoveryConfigurationError(
      'issue request identity is invalid',
    );
  }
  if (
    !Number.isSafeInteger(request.expectedPreviousVersion) ||
    request.expectedPreviousVersion < 1 ||
    request.expectedPreviousVersion >= 2_147_483_647
  ) {
    throw new LocalOwnerCredentialRecoveryConfigurationError(
      'expectedPreviousVersion is invalid',
    );
  }
}

function completeRequest(
  request: CompleteLocalOwnerCredentialRecoveryRequest,
): void {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    !exactKeys(request, ['issueMutationId', 'mutationId', 'requestId'])
  ) {
    throw new LocalOwnerCredentialRecoveryConfigurationError(
      'complete request shape is invalid',
    );
  }
  try {
    assertLocalOwnerBootstrapMutationId(request.issueMutationId);
    assertLocalOwnerBootstrapMutationId(request.mutationId);
    assertLocalOwnerBootstrapRequestId(request.requestId);
  } catch {
    throw new LocalOwnerCredentialRecoveryConfigurationError(
      'complete request identity is invalid',
    );
  }
  if (request.issueMutationId === request.mutationId) {
    throw new LocalOwnerCredentialRecoveryConfigurationError(
      'completion mutation must be distinct',
    );
  }
}

function audit(
  eventId: string,
  requestId: string,
  operation: 'issue' | 'revoke',
  occurredAtMs: number,
): SecurityAuditRecord {
  return Object.freeze({
    eventId,
    requestId,
    operationId: `credential.${operation}`,
    projectId: null,
    subject: Object.freeze({
      type: 'system' as const,
      id: 'owner-credential-recovery',
    }),
    authenticationId: 'local-owner-console',
    outcome: 'allowed' as const,
    reasons: Object.freeze(['credential_recovery']),
    fence: null,
    occurredAtMs,
  });
}

function mutation(
  mutationId: string,
  operation: 'issue' | 'revoke',
  credentialId: string,
  credentialVersion: number,
  expectedPreviousVersion: number,
  createdAtMs: number,
): ApiCredentialMutationRecord {
  return Object.freeze({
    mutationId,
    operation,
    credentialId,
    credentialVersion,
    expectedPreviousVersion,
    changedBy: Object.freeze({
      type: 'system' as const,
      id: 'owner-credential-recovery',
    }),
    createdAtMs,
  });
}

function response(
  status: 'inserted' | 'existing',
  recovery: Readonly<LocalOwnerCredentialRecoveryRecord>,
  token: string | null,
): Readonly<IssueLocalOwnerCredentialRecoveryResponse> {
  return Object.freeze({
    status,
    subjectId: recovery.subjectId,
    previousCredentialId: recovery.previousCredentialId,
    replacementCredentialId: recovery.replacementCredential.credentialId,
    replacementCredentialToken: token,
    expiresAtMs: recovery.replacementCredential.expiresAtMs,
    state: recovery.state,
  });
}

export function createLocalOwnerCredentialRecoveryService(
  repository: LocalOwnerCredentialRecoveryRepository,
  credentials: ApiCredentialRepository,
  pepper: string,
  options: LocalOwnerCredentialRecoveryServiceOptions,
): LocalOwnerCredentialRecoveryService {
  if (
    !repository ||
    typeof repository.resolve !== 'function' ||
    typeof repository.issue !== 'function' ||
    typeof repository.complete !== 'function' ||
    !credentials ||
    typeof credentials.resolve !== 'function' ||
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, [
      'pepperKeyId',
      ...(options.now === undefined ? [] : ['now']),
      ...(options.randomBytes === undefined ? [] : ['randomBytes']),
      ...(options.secretDelivery === undefined ? [] : ['secretDelivery']),
    ]) ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.randomBytes !== undefined &&
      typeof options.randomBytes !== 'function') ||
    (options.secretDelivery !== undefined &&
      (!options.secretDelivery ||
        typeof options.secretDelivery.prepare !== 'function' ||
        typeof options.secretDelivery.publish !== 'function'))
  ) {
    throw new LocalOwnerCredentialRecoveryConfigurationError(
      'service dependencies are invalid',
    );
  }
  try {
    assertApiCredentialPepper(pepper);
    assertApiCredentialPepperKeyId(options.pepperKeyId);
  } catch {
    throw new LocalOwnerCredentialRecoveryConfigurationError(
      'pepper configuration is invalid',
    );
  }
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  const delivery = options.secretDelivery;

  return Object.freeze({
    async issue(request: IssueLocalOwnerCredentialRecoveryRequest) {
      issueRequest(request);
      const lifetimeMs = ttl(request.credentialTtlMs);
      try {
        const existing = await repository.resolve(request.mutationId);
        if (existing && existing.state !== 'issued') {
          if (
            existing.issueRequestId !== request.requestId ||
            existing.previousCredentialId !== request.previousCredentialId ||
            existing.previousCredentialVersion !==
              request.expectedPreviousVersion ||
            existing.replacementCredential.expiresAtMs -
              existing.replacementCredential.notBeforeAtMs !==
              lifetimeMs
          ) {
            throw new LocalOwnerCredentialRecoveryMutationConflictError();
          }
          return response('existing', existing, null);
        }
        const previous = await credentials.resolve(
          request.previousCredentialId,
        );
        if (
          !previous ||
          previous.version !== request.expectedPreviousVersion ||
          previous.state !== 'active' ||
          previous.subject.type !== 'user' ||
          previous.subjectStatus !== 'active'
        ) {
          throw new LocalOwnerCredentialRecoveryServiceUnavailableError();
        }
        const candidate: LocalOwnerCredentialRecoveryDeliveryRecord =
          Object.freeze({
            kind: 'credential',
            mutationId: request.mutationId,
            requestId: request.requestId,
            subjectId: previous.subject.id,
            credentialId: `own_${randomToken(randomBytes, 16)}`,
            secret: randomToken(randomBytes, 32),
            ttlMs: lifetimeMs,
          });
        let prepared = candidate;
        if (delivery) {
          const value = await delivery.prepare(candidate);
          if ('state' in value) {
            const replay = await repository.resolve(request.mutationId);
            if (!replay || replay.state === 'issued') {
              throw new LocalOwnerCredentialRecoveryServiceUnavailableError();
            }
            return response('existing', replay, null);
          }
          if (
            value.kind !== 'credential' ||
            value.mutationId !== request.mutationId ||
            value.requestId !== request.requestId ||
            value.subjectId !== previous.subject.id ||
            value.ttlMs !== lifetimeMs
          ) {
            throw new LocalOwnerCredentialRecoveryServiceUnavailableError();
          }
          prepared = value;
        }
        const issuedAtMs = existing?.issuedAtMs ?? clock(now);
        const expiresAtMs = issuedAtMs + lifetimeMs;
        if (!Number.isSafeInteger(expiresAtMs)) {
          throw new LocalOwnerCredentialRecoveryConfigurationError(
            'credential lifetime is invalid',
          );
        }
        const replacementCredential: ApiCredentialRecord = {
          credentialId: prepared.credentialId,
          version: 1,
          pepperKeyId: options.pepperKeyId,
          state: 'active',
          subject: previous.subject,
          subjectStatus: previous.subjectStatus,
          secretDigest: apiCredentialSecretDigest(
            pepper,
            prepared.credentialId,
            prepared.secret,
          ),
          createdAtMs: issuedAtMs,
          notBeforeAtMs: issuedAtMs,
          expiresAtMs,
        };
        const result = await repository.issue({
          mutationId: request.mutationId,
          requestId: request.requestId,
          previousCredentialId: request.previousCredentialId,
          expectedPreviousVersion: request.expectedPreviousVersion,
          replacementCredential,
          mutation: mutation(
            request.mutationId,
            'issue',
            replacementCredential.credentialId,
            1,
            0,
            issuedAtMs,
          ),
          audit: audit(
            request.mutationId,
            request.requestId,
            'issue',
            issuedAtMs,
          ),
        });
        if (delivery) await delivery.publish(prepared);
        return response(
          result.status,
          result.recovery,
          !delivery && result.status === 'inserted'
            ? formatApiCredentialToken(prepared.credentialId, prepared.secret)
            : null,
        );
      } catch (error) {
        if (
          error instanceof LocalOwnerCredentialRecoveryConfigurationError ||
          error instanceof LocalOwnerCredentialRecoveryInProgressError ||
          error instanceof LocalOwnerCredentialRecoveryMutationConflictError ||
          error instanceof
            LocalOwnerCredentialRecoveryCredentialUnavailableError ||
          error instanceof LocalOwnerCredentialRecoveryServiceUnavailableError
        ) {
          throw error;
        }
        throw new LocalOwnerCredentialRecoveryServiceUnavailableError();
      }
    },

    async complete(request: CompleteLocalOwnerCredentialRecoveryRequest) {
      completeRequest(request);
      try {
        const recovery = await repository.resolve(request.issueMutationId);
        if (!recovery) {
          throw new LocalOwnerCredentialRecoveryServiceUnavailableError();
        }
        if (recovery.state === 'completed') {
          if (
            recovery.completeMutationId !== request.mutationId ||
            recovery.completeRequestId !== request.requestId
          ) {
            throw new LocalOwnerCredentialRecoveryMutationConflictError();
          }
          return Object.freeze({
            status: 'existing' as const,
            previousCredentialId: recovery.previousCredentialId,
            replacementCredentialId:
              recovery.replacementCredential.credentialId,
            state: 'completed' as const,
          });
        }
        const previous = await credentials.resolve(
          recovery.previousCredentialId,
        );
        if (
          !previous ||
          previous.version !== recovery.previousCredentialVersion ||
          previous.state !== 'active' ||
          previous.subject.id !== recovery.subjectId
        ) {
          throw new LocalOwnerCredentialRecoveryServiceUnavailableError();
        }
        const completedAtMs = clock(now);
        const revokedCredential: ApiCredentialRecord = {
          ...previous,
          version: previous.version + 1,
          state: 'revoked',
          secretDigest: REVOKED_API_CREDENTIAL_DIGEST,
          createdAtMs: completedAtMs,
          notBeforeAtMs: completedAtMs,
          expiresAtMs: completedAtMs + 1,
        };
        const result = await repository.complete({
          issueMutationId: request.issueMutationId,
          mutationId: request.mutationId,
          requestId: request.requestId,
          expectedPreviousVersion: previous.version,
          revokedCredential,
          mutation: mutation(
            request.mutationId,
            'revoke',
            previous.credentialId,
            previous.version + 1,
            previous.version,
            completedAtMs,
          ),
          audit: audit(
            request.mutationId,
            request.requestId,
            'revoke',
            completedAtMs,
          ),
        });
        return Object.freeze({
          status: result.status,
          previousCredentialId: result.recovery.previousCredentialId,
          replacementCredentialId:
            result.recovery.replacementCredential.credentialId,
          state: 'completed' as const,
        });
      } catch (error) {
        if (
          error instanceof LocalOwnerCredentialRecoveryConfigurationError ||
          error instanceof LocalOwnerCredentialRecoveryMutationConflictError ||
          error instanceof LocalOwnerCredentialRecoveryNotAcknowledgedError ||
          error instanceof
            LocalOwnerCredentialRecoveryCredentialUnavailableError
        ) {
          throw error;
        }
        throw new LocalOwnerCredentialRecoveryServiceUnavailableError();
      }
    },
  });
}
