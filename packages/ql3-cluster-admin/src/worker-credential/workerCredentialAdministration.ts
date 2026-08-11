/** Worker credential administration application boundary. */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  WorkerCredentialMutationConflictError,
  normalizeWorkerCredentialId,
  normalizeWorkerCredentialMutationId,
  type AppendWorkerCredentialResult,
  type WorkerCredentialAdministrationOperation,
  type WorkerCredentialAdministrationRepository,
} from '@qinglong/runtime-core/worker-credential';
import {
  assertWorkerCredentialPepper,
  formatWorkerCredentialToken,
  workerCredentialSecretDigest,
} from '@qinglong/runtime-core/worker-credential-token';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';

const MAX_LIFETIME_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const REVOKED_DIGEST = '0'.repeat(64);
const STRONG = new Set(['multi_factor', 'hardware', 'local_console']);
const SAFE_WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface WorkerCredentialAdministrationRequest {
  readonly mutationId: string;
  readonly requestId: string;
  readonly expectedCurrentVersion: number;
  readonly credentialId: string;
  readonly workerId: string;
  readonly principal: SecurityPrincipal;
}

export interface ActiveWorkerCredentialAdministrationRequest
  extends WorkerCredentialAdministrationRequest {
  readonly notBeforeAtMs: number;
  readonly expiresAtMs: number;
}

export interface WorkerCredentialAdministrationResult
  extends AppendWorkerCredentialResult {
  readonly token: string | null;
}

export interface WorkerCredentialAdministrationService {
  issue(
    request: ActiveWorkerCredentialAdministrationRequest,
  ): Promise<WorkerCredentialAdministrationResult>;
  rotate(
    request: ActiveWorkerCredentialAdministrationRequest,
  ): Promise<WorkerCredentialAdministrationResult>;
  revoke(
    request: WorkerCredentialAdministrationRequest,
  ): Promise<WorkerCredentialAdministrationResult>;
}

export interface WorkerCredentialAdministrationOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly returnToken?: boolean;
}

function exactRequest(
  value: WorkerCredentialAdministrationRequest,
  active: boolean,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Worker credential administration request is invalid');
  }
  const expected = [
    'mutationId',
    'requestId',
    'expectedCurrentVersion',
    'credentialId',
    'workerId',
    'principal',
    ...(active ? ['notBeforeAtMs', 'expiresAtMs'] : []),
  ].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError('Worker credential administration request shape is invalid');
  }
  normalizeWorkerCredentialMutationId(value.mutationId);
  normalizeWorkerCredentialId(value.credentialId);
  if (
    typeof value.requestId !== 'string' ||
    !SAFE_REQUEST_ID.test(value.requestId) ||
    typeof value.workerId !== 'string' ||
    !SAFE_WORKER_ID.test(value.workerId)
  ) {
    throw new TypeError('Worker credential administration request identity is invalid');
  }
}

function principal(value: SecurityPrincipal, nowMs: number) {
  const normalized = normalizeSecurityPrincipal(value, nowMs);
  if (
    !(
      (normalized.subject.type === 'user' && STRONG.has(normalized.assurance)) ||
      (normalized.subject.type === 'system' && normalized.assurance === 'service')
    )
  ) {
    throw new TypeError('Worker credential administration requires a strong principal');
  }
  return normalized;
}

function sameReplay(
  operation: WorkerCredentialAdministrationOperation,
  existing: Awaited<ReturnType<WorkerCredentialAdministrationRepository['resolveMutation']>>,
  request: WorkerCredentialAdministrationRequest | ActiveWorkerCredentialAdministrationRequest,
): boolean {
  if (!existing) return false;
  const active = operation === 'revoke'
    ? null
    : request as ActiveWorkerCredentialAdministrationRequest;
  return (
    existing.mutation.operation === operation &&
    existing.mutation.credentialId === request.credentialId &&
    existing.mutation.expectedPreviousVersion === request.expectedCurrentVersion &&
    existing.credential.workerId === request.workerId &&
    existing.credential.state === (operation === 'revoke' ? 'revoked' : 'active') &&
    (active === null ||
      (existing.credential.notBeforeAtMs === active.notBeforeAtMs &&
       existing.credential.expiresAtMs === active.expiresAtMs)) &&
    existing.audit.requestId === request.requestId &&
    existing.audit.subject?.type === request.principal.subject.type &&
    existing.audit.subject.id === request.principal.subject.id
  );
}

export function createWorkerCredentialAdministrationService(
  repository: WorkerCredentialAdministrationRepository,
  pepper: string,
  options: WorkerCredentialAdministrationOptions = {},
): WorkerCredentialAdministrationService {
  if (
    !repository ||
    typeof repository.resolveMutation !== 'function' ||
    typeof repository.append !== 'function'
  ) {
    throw new TypeError('Worker credential administration repository is invalid');
  }
  assertWorkerCredentialPepper(pepper);
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? nodeRandomBytes;

  const mutate = async (
    operation: WorkerCredentialAdministrationOperation,
    request: WorkerCredentialAdministrationRequest | ActiveWorkerCredentialAdministrationRequest,
  ): Promise<WorkerCredentialAdministrationResult> => {
    exactRequest(request, operation !== 'revoke');
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError('Worker credential administration clock is invalid');
    }
    const actor = principal(request.principal, nowMs);
    if (
      (operation === 'issue' && request.expectedCurrentVersion !== 0) ||
      (operation !== 'issue' &&
        (!Number.isSafeInteger(request.expectedCurrentVersion) ||
          request.expectedCurrentVersion < 1))
    ) {
      throw new RangeError('Worker credential administration operation fence is invalid');
    }
    const existing = await repository.resolveMutation(request.mutationId);
    if (existing) {
      if (!sameReplay(operation, existing, request)) {
        throw new WorkerCredentialMutationConflictError();
      }
      return Object.freeze({
        status: 'existing',
        credential: existing.credential,
        mutation: existing.mutation,
        token: null,
      });
    }
    const active = operation === 'revoke'
      ? null
      : request as ActiveWorkerCredentialAdministrationRequest;
    const notBeforeAtMs = active?.notBeforeAtMs ?? nowMs;
    const expiresAtMs = active?.expiresAtMs ?? Math.max(nowMs + 1, nowMs + 1_000);
    if (
      !Number.isSafeInteger(request.expectedCurrentVersion) ||
      request.expectedCurrentVersion < 0 ||
      !Number.isSafeInteger(notBeforeAtMs) ||
      !Number.isSafeInteger(expiresAtMs) ||
      notBeforeAtMs < 0 ||
      expiresAtMs <= Math.max(nowMs, notBeforeAtMs) ||
      expiresAtMs - notBeforeAtMs > MAX_LIFETIME_MS
    ) {
      throw new RangeError('Worker credential administration lifetime or fence is invalid');
    }
    let secret: Buffer | undefined;
    let secretText: string | undefined;
    try {
      if (operation !== 'revoke') {
        secret = randomBytes(32);
        if (!Buffer.isBuffer(secret) || secret.byteLength !== 32) {
          throw new TypeError('Worker credential administration entropy is invalid');
        }
        secretText = secret.toString('base64url');
      }
      const credential = {
        credentialId: request.credentialId,
        version: request.expectedCurrentVersion + 1,
        state: operation === 'revoke' ? 'revoked' as const : 'active' as const,
        workerId: request.workerId,
        secretDigest: secretText
          ? workerCredentialSecretDigest(pepper, request.credentialId, secretText)
          : REVOKED_DIGEST,
        createdAtMs: nowMs,
        notBeforeAtMs,
        expiresAtMs,
      };
      const result = await repository.append({
        expectedCurrentVersion: request.expectedCurrentVersion,
        credential,
        mutation: {
          mutationId: request.mutationId,
          operation,
          credentialId: request.credentialId,
          credentialVersion: request.expectedCurrentVersion + 1,
          expectedPreviousVersion: request.expectedCurrentVersion,
          changedBy: actor.subject,
          createdAtMs: nowMs,
        },
        audit: {
          eventId: request.mutationId,
          requestId: request.requestId,
          operationId: `worker_credential.${operation}`,
          projectId: null,
          subject: actor.subject,
          authenticationId: actor.authenticationId,
          outcome: 'allowed',
          reasons: ['worker_credential_admin'],
          fence: null,
          occurredAtMs: nowMs,
        },
      });
      return Object.freeze({
        ...result,
        token:
          options.returnToken !== false &&
          result.status === 'created' && secretText
            ? formatWorkerCredentialToken(request.credentialId, secretText)
            : null,
      });
    } finally {
      secret?.fill(0);
      secretText = undefined;
    }
  };

  return Object.freeze({
    issue: (request: ActiveWorkerCredentialAdministrationRequest) =>
      mutate('issue', request),
    rotate: (request: ActiveWorkerCredentialAdministrationRequest) =>
      mutate('rotate', request),
    revoke: (request: WorkerCredentialAdministrationRequest) =>
      mutate('revoke', request),
  });
}
