/** Recoverable Worker credential delivery application boundary. */
import {
  createHash,
  randomBytes as nodeRandomBytes,
} from 'node:crypto';
import {
  normalizeWorkerCredentialId,
  normalizeWorkerCredentialMutationId,
  type AppendWorkerCredentialCommand,
} from '@qinglong/runtime-core/worker-credential';
import {
  WorkerCredentialDeliveryConflictError,
  WorkerCredentialDeliveryUnavailableError,
  MAX_WORKER_CREDENTIAL_STAGE_DISCARD_PAGE_SIZE,
  normalizeCommitWorkerCredentialDeliveryCommand,
  normalizeRevokePreviousWorkerCredentialDeliveryCommand,
  normalizeWorkerCredentialDeliveryIntent,
  normalizeWorkerCredentialDeliveryRecoveryPage,
  normalizeWorkerCredentialDeliveryRecord,
  normalizeWorkerCredentialStageDiscardRecord,
  normalizeWorkerCredentialStageDiscardRecoveryPage,
  workerCredentialDeliveryTokenDigest,
  type ResolvedWorkerCredentialDelivery,
  type WorkerCredentialDeliveryAdministrationRepository,
  type WorkerCredentialDeliveryIntent,
  type WorkerCredentialDeliveryRecoveryPage,
  type WorkerCredentialDeliveryRecord,
  type WorkerCredentialStageDiscardRecord,
  type WorkerCredentialStageDiscardRecoveryPage,
} from '@qinglong/runtime-core/worker-credential-delivery';
import {
  formatWorkerCredentialToken,
} from '@qinglong/runtime-core/worker-credential-token';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import {
  createWorkerCredentialAdministrationService,
  type ActiveWorkerCredentialAdministrationRequest,
} from './workerCredentialAdministration';

const MAX_LIFETIME_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const STRONG = new Set(['multi_factor', 'hardware', 'local_console']);
const SAFE_WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface RecoverableWorkerCredentialIssueRequest
  extends ActiveWorkerCredentialAdministrationRequest {
  readonly previousCredentialId: string | null;
  readonly deploymentTargetDigest: string;
  readonly deploymentGeneration: string;
}

export interface WorkerCredentialStagedSecretAdapter {
  inspect(
    deliveryId: string,
  ): Promise<Readonly<WorkerCredentialDeliveryIntent> | null>;
  stage(
    delivery: Readonly<WorkerCredentialDeliveryIntent>,
    token: Buffer,
  ): Promise<void>;
  publish(
    delivery: Readonly<WorkerCredentialDeliveryRecord>,
  ): Promise<Readonly<{ publicationDigest: string }>>;
  discard(delivery: Readonly<WorkerCredentialDeliveryIntent>): Promise<void>;
}

export interface WorkerCredentialStagedSecretPage {
  readonly stages: readonly Readonly<WorkerCredentialDeliveryIntent>[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface WorkerCredentialStagedSecretInventoryAdapter
  extends WorkerCredentialStagedSecretAdapter {
  listStaged(options?: Readonly<{
    afterDeliveryId?: string;
    limit?: number;
  }>): Promise<Readonly<WorkerCredentialStagedSecretPage>>;
}

export interface WorkerCredentialStageCleanupPageResult {
  readonly outcomes: readonly Readonly<{
    deliveryId: string;
    result: 'discarded' | 'already_discarded';
  }>[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface WorkerCredentialStageCleanupRecoveryResult
  extends WorkerCredentialStageCleanupPageResult {
  readonly observedAtMs: number;
}

export interface WorkerCredentialStageCleanupService {
  cleanupInventoryPage(options?: Readonly<{
    afterDeliveryId?: string;
    limit?: number;
  }>): Promise<Readonly<WorkerCredentialStageCleanupPageResult>>;
  recoverAuthorizedPage(options?: Readonly<{
    afterDeliveryId?: string;
    limit?: number;
  }>): Promise<Readonly<WorkerCredentialStageCleanupRecoveryResult>>;
}

export interface RecoverableWorkerCredentialIssueResult {
  readonly status:
    | 'published'
    | 'existing'
    | 'orphaned_stage_discarded';
  readonly delivery: Readonly<WorkerCredentialDeliveryRecord> | null;
}

export interface RecoverableWorkerCredentialIssuer {
  issue(
    request: RecoverableWorkerCredentialIssueRequest,
  ): Promise<RecoverableWorkerCredentialIssueResult>;
}

export interface RecoverableWorkerCredentialIssuerOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface WorkerCredentialDeliveryRecoveryResult {
  readonly observedAtMs: number;
  readonly outcomes: readonly Readonly<{
    deliveryId: string;
    state: WorkerCredentialDeliveryRecord['state'];
    result: 'published' | 'waiting_observation' | 'previous_revoked';
  }>[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface WorkerCredentialDeliveryRecoveryService {
  recoverPage(options?: Readonly<{
    afterDeliveryId?: string;
    limit?: number;
  }>): Promise<Readonly<WorkerCredentialDeliveryRecoveryResult>>;
}

function exactRequest(value: RecoverableWorkerCredentialIssueRequest): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Recoverable Worker credential issue request is invalid');
  }
  const expected = [
    'mutationId',
    'requestId',
    'expectedCurrentVersion',
    'credentialId',
    'workerId',
    'principal',
    'notBeforeAtMs',
    'expiresAtMs',
    'previousCredentialId',
    'deploymentTargetDigest',
    'deploymentGeneration',
  ].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(
      'Recoverable Worker credential issue request shape is invalid',
    );
  }
}

function validateRequest(
  request: RecoverableWorkerCredentialIssueRequest,
  nowMs: number,
): void {
  exactRequest(request);
  normalizeWorkerCredentialMutationId(request.mutationId);
  normalizeWorkerCredentialId(request.credentialId);
  if (request.previousCredentialId !== null) {
    normalizeWorkerCredentialId(request.previousCredentialId);
  }
  if (
    request.expectedCurrentVersion !== 0 ||
    request.previousCredentialId === request.credentialId ||
    typeof request.workerId !== 'string' ||
    !SAFE_WORKER_ID.test(request.workerId) ||
    typeof request.requestId !== 'string' ||
    !SAFE_REQUEST_ID.test(request.requestId) ||
    typeof request.deploymentTargetDigest !== 'string' ||
    !SHA256.test(request.deploymentTargetDigest) ||
    typeof request.deploymentGeneration !== 'string' ||
    !SAFE_GENERATION.test(request.deploymentGeneration)
  ) {
    throw new TypeError('Recoverable Worker credential issue identity is invalid');
  }
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(request.notBeforeAtMs) ||
    request.notBeforeAtMs < 0 ||
    !Number.isSafeInteger(request.expiresAtMs) ||
    request.expiresAtMs <= Math.max(nowMs, request.notBeforeAtMs) ||
    request.expiresAtMs - request.notBeforeAtMs > MAX_LIFETIME_MS
  ) {
    throw new RangeError('Recoverable Worker credential issue lifetime is invalid');
  }
  const actor = normalizeSecurityPrincipal(request.principal, nowMs);
  if (
    !(
      (actor.subject.type === 'user' && STRONG.has(actor.assurance)) ||
      (actor.subject.type === 'system' && actor.assurance === 'service')
    )
  ) {
    throw new TypeError(
      'Recoverable Worker credential issue requires a strong principal',
    );
  }
}

function requestForAdministration(
  request: RecoverableWorkerCredentialIssueRequest,
): ActiveWorkerCredentialAdministrationRequest {
  return {
    mutationId: request.mutationId,
    requestId: request.requestId,
    expectedCurrentVersion: request.expectedCurrentVersion,
    credentialId: request.credentialId,
    workerId: request.workerId,
    principal: request.principal,
    notBeforeAtMs: request.notBeforeAtMs,
    expiresAtMs: request.expiresAtMs,
  };
}

function sameRequest(
  resolved: ResolvedWorkerCredentialDelivery,
  request: RecoverableWorkerCredentialIssueRequest,
): boolean {
  const { delivery, credential, mutation, audit } = resolved;
  return (
    delivery.deliveryId === request.mutationId &&
    delivery.credentialId === request.credentialId &&
    delivery.previousCredentialId === request.previousCredentialId &&
    delivery.workerId === request.workerId &&
    delivery.deploymentTargetDigest === request.deploymentTargetDigest &&
    delivery.deploymentGeneration === request.deploymentGeneration &&
    credential.notBeforeAtMs === request.notBeforeAtMs &&
    credential.expiresAtMs === request.expiresAtMs &&
    mutation.operation === 'issue' &&
    mutation.expectedPreviousVersion === 0 &&
    audit.requestId === request.requestId &&
    audit.subject?.type === request.principal.subject.type &&
    audit.subject.id === request.principal.subject.id
  );
}

function sameStage(
  delivery: Readonly<WorkerCredentialDeliveryIntent>,
  staged: Readonly<WorkerCredentialDeliveryIntent>,
): boolean {
  return (
    delivery.deliveryId === staged.deliveryId &&
    delivery.workerId === staged.workerId &&
    delivery.credentialId === staged.credentialId &&
    delivery.credentialVersion === staged.credentialVersion &&
    delivery.previousCredentialId === staged.previousCredentialId &&
    delivery.secretDigest === staged.secretDigest &&
    delivery.tokenDigest === staged.tokenDigest &&
    delivery.deploymentTargetDigest === staged.deploymentTargetDigest &&
    delivery.deploymentGeneration === staged.deploymentGeneration &&
    delivery.stagedAtMs === staged.stagedAtMs
  );
}

function mapDeliveryAdapterError(error: unknown): never {
  if (error instanceof WorkerCredentialDeliveryConflictError) throw error;
  throw new WorkerCredentialDeliveryUnavailableError();
}

function deliveryIntent(
  command: Readonly<AppendWorkerCredentialCommand>,
  request: RecoverableWorkerCredentialIssueRequest,
  digest: string,
): Readonly<WorkerCredentialDeliveryIntent> {
  return normalizeWorkerCredentialDeliveryIntent({
    deliveryId: command.mutation.mutationId,
    workerId: command.credential.workerId,
    credentialId: command.credential.credentialId,
    credentialVersion: command.credential.version,
    previousCredentialId: request.previousCredentialId,
    secretDigest: command.credential.secretDigest,
    tokenDigest: digest,
    deploymentTargetDigest: request.deploymentTargetDigest,
    deploymentGeneration: request.deploymentGeneration,
    stagedAtMs: command.credential.createdAtMs,
  });
}

function committedDelivery(
  intent: Readonly<WorkerCredentialDeliveryIntent>,
  credentialCommittedAtMs: number,
): Readonly<WorkerCredentialDeliveryRecord> {
  return normalizeWorkerCredentialDeliveryRecord({
    ...intent,
    version: 1,
    state: 'credential_committed',
    credentialCommittedAtMs,
    publishedAtMs: null,
    publicationDigest: null,
    observedAtMs: null,
    observedSessionId: null,
    observedSessionVersion: null,
    previousRevokedAtMs: null,
  });
}

export function createRecoverableWorkerCredentialIssuer(
  authority: WorkerCredentialDeliveryAdministrationRepository,
  deliveryAdapter: WorkerCredentialStagedSecretAdapter,
  pepper: string,
  options: RecoverableWorkerCredentialIssuerOptions = {},
): RecoverableWorkerCredentialIssuer {
  if (
    !authority ||
    typeof authority.resolveMutation !== 'function' ||
    typeof authority.resolveDelivered !== 'function' ||
    typeof authority.commitDelivered !== 'function' ||
    typeof authority.markPublished !== 'function' ||
    typeof authority.authorizeStageDiscard !== 'function' ||
    typeof authority.markStageDiscarded !== 'function'
  ) {
    throw new TypeError('Worker credential delivery authority is invalid');
  }
  if (
    !deliveryAdapter ||
    typeof deliveryAdapter.inspect !== 'function' ||
    typeof deliveryAdapter.stage !== 'function' ||
    typeof deliveryAdapter.publish !== 'function' ||
    typeof deliveryAdapter.discard !== 'function'
  ) {
    throw new TypeError('Worker credential delivery adapter is invalid');
  }
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? nodeRandomBytes;

  const publish = async (
    delivery: Readonly<WorkerCredentialDeliveryRecord>,
  ): Promise<Readonly<WorkerCredentialDeliveryRecord>> => {
    if (delivery.state !== 'credential_committed') return delivery;
    let publication: Readonly<{ publicationDigest: string }>;
    try {
      publication = await deliveryAdapter.publish(delivery);
    } catch (error) {
      mapDeliveryAdapterError(error);
    }
    if (
      !publication ||
      typeof publication !== 'object' ||
      Array.isArray(publication) ||
      Object.keys(publication).length !== 1 ||
      typeof publication.publicationDigest !== 'string' ||
      !SHA256.test(publication.publicationDigest)
    ) {
      throw new WorkerCredentialDeliveryUnavailableError();
    }
    const publishedAtMs = now();
    if (
      !Number.isSafeInteger(publishedAtMs) ||
      publishedAtMs < delivery.credentialCommittedAtMs
    ) {
      throw new WorkerCredentialDeliveryUnavailableError();
    }
    try {
      return normalizeWorkerCredentialDeliveryRecord(
        await authority.markPublished({
          deliveryId: delivery.deliveryId,
          expectedVersion: delivery.version,
          publicationDigest: publication.publicationDigest,
          publishedAtMs,
        }),
      );
    } catch (error) {
      if (error instanceof WorkerCredentialDeliveryConflictError) throw error;
      throw new WorkerCredentialDeliveryUnavailableError();
    }
  };

  return Object.freeze({
    async issue(request: RecoverableWorkerCredentialIssueRequest) {
      const operationNowMs = now();
      validateRequest(request, operationNowMs);
      let capturedSecret: Buffer | undefined;
      try {
        let resolved: ResolvedWorkerCredentialDelivery | null;
        try {
          resolved = await authority.resolveDelivered(request.mutationId);
        } catch {
          throw new WorkerCredentialDeliveryUnavailableError();
        }
        if (resolved) {
          if (!sameRequest(resolved, request)) {
            throw new WorkerCredentialDeliveryConflictError();
          }
          let staged: Readonly<WorkerCredentialDeliveryIntent> | null;
          try {
            const inspected = await deliveryAdapter.inspect(request.mutationId);
            staged = inspected
              ? normalizeWorkerCredentialDeliveryIntent(inspected)
              : null;
          } catch (error) {
            mapDeliveryAdapterError(error);
          }
          if (!staged || !sameStage(resolved.delivery, staged)) {
            throw new WorkerCredentialDeliveryConflictError();
          }
          const delivery = await publish(resolved.delivery);
          return Object.freeze({
            status: 'existing' as const,
            delivery,
          });
        }

        let rawMutation;
        let orphanedStage: Readonly<WorkerCredentialDeliveryIntent> | null;
        try {
          rawMutation = await authority.resolveMutation(request.mutationId);
          const inspected = await deliveryAdapter.inspect(request.mutationId);
          orphanedStage = inspected
            ? normalizeWorkerCredentialDeliveryIntent(inspected)
            : null;
        } catch (error) {
          mapDeliveryAdapterError(error);
        }
        if (rawMutation) {
          throw new WorkerCredentialDeliveryConflictError();
        }
        if (orphanedStage) {
          let authorized: Readonly<WorkerCredentialStageDiscardRecord>;
          try {
            authorized = normalizeWorkerCredentialStageDiscardRecord(
              await authority.authorizeStageDiscard(orphanedStage),
            );
          } catch (error) {
            if (error instanceof WorkerCredentialDeliveryConflictError) throw error;
            throw new WorkerCredentialDeliveryUnavailableError();
          }
          if (!sameStage(authorized, orphanedStage)) {
            throw new WorkerCredentialDeliveryConflictError();
          }
          try {
            await deliveryAdapter.discard(orphanedStage);
          } catch (error) {
            mapDeliveryAdapterError(error);
          }
          if (authorized.state === 'discard_authorized') {
            let completed: Readonly<WorkerCredentialStageDiscardRecord>;
            try {
              completed = normalizeWorkerCredentialStageDiscardRecord(
                await authority.markStageDiscarded({
                  deliveryId: authorized.deliveryId,
                  expectedVersion: authorized.version,
                }),
              );
            } catch (error) {
              if (error instanceof WorkerCredentialDeliveryConflictError) throw error;
              throw new WorkerCredentialDeliveryUnavailableError();
            }
            if (
              completed.state !== 'discarded' ||
              completed.authorizedAtMs !== authorized.authorizedAtMs ||
              !sameStage(completed, authorized)
            ) {
              throw new WorkerCredentialDeliveryConflictError();
            }
          }
          return Object.freeze({
            status: 'orphaned_stage_discarded' as const,
            delivery: null,
          });
        }

        const repository = {
          resolveMutation: authority.resolveMutation.bind(authority),
          async append(command: AppendWorkerCredentialCommand) {
            if (!capturedSecret) {
              throw new WorkerCredentialDeliveryUnavailableError();
            }
            let token: Buffer | undefined;
            try {
              const secretText = capturedSecret.toString('base64url');
              token = Buffer.from(
                formatWorkerCredentialToken(
                  command.credential.credentialId,
                  secretText,
                ),
                'utf8',
              );
              const intent = deliveryIntent(
                command,
                request,
                workerCredentialDeliveryTokenDigest(token),
              );
              try {
                await deliveryAdapter.stage(intent, token);
              } catch (error) {
                mapDeliveryAdapterError(error);
              }
              const delivery = committedDelivery(
                intent,
                command.credential.createdAtMs,
              );
              return await authority.commitDelivered(
                normalizeCommitWorkerCredentialDeliveryCommand({
                  credential: command,
                  delivery,
                }),
              );
            } finally {
              token?.fill(0);
              capturedSecret.fill(0);
              capturedSecret = undefined;
            }
          },
        };
        const administration = createWorkerCredentialAdministrationService(
          repository,
          pepper,
          {
            now: () => operationNowMs,
            randomBytes(size) {
              const secret = randomBytes(size);
              if (Buffer.isBuffer(secret)) capturedSecret = Buffer.from(secret);
              return secret;
            },
            returnToken: false,
          },
        );
        await administration.issue(requestForAdministration(request));
        let committed: ResolvedWorkerCredentialDelivery | null;
        try {
          committed = await authority.resolveDelivered(request.mutationId);
        } catch {
          throw new WorkerCredentialDeliveryUnavailableError();
        }
        if (!committed || !sameRequest(committed, request)) {
          throw new WorkerCredentialDeliveryUnavailableError();
        }
        const delivery = await publish(committed.delivery);
        return Object.freeze({ status: 'published' as const, delivery });
      } finally {
        capturedSecret?.fill(0);
      }
    },
  });
}

const REVOKE_MUTATION_DOMAIN = Buffer.from(
  'qinglong/worker-credential-delivery-revoke@v1\0',
  'utf8',
);

function revokeMutationId(deliveryId: string): string {
  const value = createHash('sha256')
    .update(REVOKE_MUTATION_DOMAIN)
    .update(deliveryId, 'utf8')
    .digest();
  value[6] = (value[6]! & 0x0f) | 0x40;
  value[8] = (value[8]! & 0x3f) | 0x80;
  const hex = value.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createWorkerCredentialDeliveryRecoveryService(
  authority: WorkerCredentialDeliveryAdministrationRepository,
  deliveryAdapter: WorkerCredentialStagedSecretAdapter,
  pepper: string,
  principal: SecurityPrincipal,
): WorkerCredentialDeliveryRecoveryService {
  if (
    !authority ||
    typeof authority.resolveMutation !== 'function' ||
    typeof authority.resolveDelivery !== 'function' ||
    typeof authority.markPublished !== 'function' ||
    typeof authority.listRecoveryPage !== 'function' ||
    typeof authority.revokePreviousDelivered !== 'function'
  ) {
    throw new TypeError('Worker credential recovery authority is invalid');
  }
  if (
    !deliveryAdapter ||
    typeof deliveryAdapter.inspect !== 'function' ||
    typeof deliveryAdapter.publish !== 'function'
  ) {
    throw new TypeError('Worker credential recovery adapter is invalid');
  }
  const publish = async (
    delivery: Readonly<WorkerCredentialDeliveryRecord>,
    operationNowMs: number,
  ): Promise<Readonly<WorkerCredentialDeliveryRecord>> => {
    let staged: Readonly<WorkerCredentialDeliveryIntent> | null;
    try {
      const inspected = await deliveryAdapter.inspect(delivery.deliveryId);
      staged = inspected
        ? normalizeWorkerCredentialDeliveryIntent(inspected)
        : null;
    } catch (error) {
      mapDeliveryAdapterError(error);
    }
    if (!staged || !sameStage(delivery, staged)) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    let published: Readonly<{ publicationDigest: string }>;
    try {
      published = await deliveryAdapter.publish(delivery);
    } catch (error) {
      mapDeliveryAdapterError(error);
    }
    if (
      !published ||
      typeof published !== 'object' ||
      Array.isArray(published) ||
      Object.keys(published).length !== 1 ||
      typeof published.publicationDigest !== 'string' ||
      !SHA256.test(published.publicationDigest)
    ) {
      throw new WorkerCredentialDeliveryUnavailableError();
    }
    if (operationNowMs < delivery.credentialCommittedAtMs) {
      throw new WorkerCredentialDeliveryUnavailableError();
    }
    try {
      return normalizeWorkerCredentialDeliveryRecord(
        await authority.markPublished({
          deliveryId: delivery.deliveryId,
          expectedVersion: 1,
          publicationDigest: published.publicationDigest,
          publishedAtMs: operationNowMs,
        }),
      );
    } catch (error) {
      if (error instanceof WorkerCredentialDeliveryConflictError) throw error;
      throw new WorkerCredentialDeliveryUnavailableError();
    }
  };

  const revoke = async (
    delivery: Readonly<WorkerCredentialDeliveryRecord>,
    operationNowMs: number,
  ): Promise<Readonly<WorkerCredentialDeliveryRecord>> => {
    if (delivery.state !== 'observed' || !delivery.previousCredentialId) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    if (operationNowMs < (delivery.observedAtMs ?? 0)) {
      throw new WorkerCredentialDeliveryUnavailableError();
    }
    const repository = {
      resolveMutation: authority.resolveMutation.bind(authority),
      append(command: AppendWorkerCredentialCommand) {
        return authority.revokePreviousDelivered(
          normalizeRevokePreviousWorkerCredentialDeliveryCommand({
            credential: command,
            delivery: normalizeWorkerCredentialDeliveryRecord({
              ...delivery,
              version: 4,
              state: 'previous_revoked',
              previousRevokedAtMs: command.credential.createdAtMs,
            }),
          }),
        );
      },
    };
    const administration = createWorkerCredentialAdministrationService(
      repository,
      pepper,
      { now: () => operationNowMs, returnToken: false },
    );
    await administration.revoke({
      mutationId: revokeMutationId(delivery.deliveryId),
      requestId: `worker-delivery-revoke:${delivery.deliveryId}`,
      expectedCurrentVersion: 1,
      credentialId: delivery.previousCredentialId,
      workerId: delivery.workerId,
      principal,
    });
    let resolved: Readonly<WorkerCredentialDeliveryRecord> | null;
    try {
      resolved = await authority.resolveDelivery(delivery.deliveryId);
    } catch {
      throw new WorkerCredentialDeliveryUnavailableError();
    }
    if (
      !resolved ||
      resolved.state !== 'previous_revoked' ||
      !sameStage(resolved, delivery)
    ) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    return resolved;
  };

  return Object.freeze({
    async recoverPage(
      requested: Readonly<{
        afterDeliveryId?: string;
        limit?: number;
      }> = {},
    ) {
      let page: Readonly<WorkerCredentialDeliveryRecoveryPage>;
      try {
        page = normalizeWorkerCredentialDeliveryRecoveryPage(
          await authority.listRecoveryPage(requested),
        );
      } catch (error) {
        if (error instanceof WorkerCredentialDeliveryConflictError) throw error;
        throw new WorkerCredentialDeliveryUnavailableError();
      }
      const outcomes = [];
      for (const candidate of page.deliveries) {
        const delivery = candidate.state === 'credential_committed'
          ? await publish(candidate, page.observedAtMs)
          : candidate.state === 'observed'
            ? await revoke(candidate, page.observedAtMs)
            : candidate;
        outcomes.push(Object.freeze({
          deliveryId: delivery.deliveryId,
          state: delivery.state,
          result: candidate.state === 'credential_committed'
            ? 'published' as const
            : candidate.state === 'observed'
              ? 'previous_revoked' as const
              : 'waiting_observation' as const,
        }));
      }
      return Object.freeze({
        observedAtMs: page.observedAtMs,
        outcomes: Object.freeze(outcomes),
        truncated: page.truncated,
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
      });
    },
  });
}

function normalizeStagedSecretPage(
  value: WorkerCredentialStagedSecretPage,
): Readonly<WorkerCredentialStagedSecretPage> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerCredentialDeliveryUnavailableError();
  }
  const expected = [
    'stages',
    'truncated',
    ...(value.nextCursor === undefined ? [] : ['nextCursor']),
  ].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    !Array.isArray(value.stages) ||
    value.stages.length > MAX_WORKER_CREDENTIAL_STAGE_DISCARD_PAGE_SIZE ||
    typeof value.truncated !== 'boolean'
  ) {
    throw new WorkerCredentialDeliveryUnavailableError();
  }
  let stages: Readonly<WorkerCredentialDeliveryIntent>[];
  try {
    stages = value.stages.map((stage) =>
      normalizeWorkerCredentialDeliveryIntent(stage));
  } catch {
    throw new WorkerCredentialDeliveryUnavailableError();
  }
  for (let index = 1; index < stages.length; index += 1) {
    if (stages[index - 1]!.deliveryId >= stages[index]!.deliveryId) {
      throw new WorkerCredentialDeliveryUnavailableError();
    }
  }
  const last = stages[stages.length - 1];
  if (
    value.truncated !== (value.nextCursor !== undefined) ||
    (value.nextCursor !== undefined &&
      (!last || value.nextCursor !== last.deliveryId))
  ) {
    throw new WorkerCredentialDeliveryUnavailableError();
  }
  return Object.freeze({
    stages: Object.freeze(stages),
    truncated: value.truncated,
    ...(value.nextCursor === undefined
      ? {}
      : { nextCursor: value.nextCursor }),
  });
}

export function createWorkerCredentialStageCleanupService(
  authority: WorkerCredentialDeliveryAdministrationRepository,
  deliveryAdapter: WorkerCredentialStagedSecretInventoryAdapter,
): WorkerCredentialStageCleanupService {
  if (
    !authority ||
    typeof authority.authorizeStageDiscard !== 'function' ||
    typeof authority.markStageDiscarded !== 'function' ||
    typeof authority.listStageDiscardRecoveryPage !== 'function'
  ) {
    throw new TypeError('Worker credential stage cleanup authority is invalid');
  }
  if (
    !deliveryAdapter ||
    typeof deliveryAdapter.inspect !== 'function' ||
    typeof deliveryAdapter.discard !== 'function' ||
    typeof deliveryAdapter.listStaged !== 'function'
  ) {
    throw new TypeError('Worker credential stage cleanup adapter is invalid');
  }

  const discard = async (
    record: Readonly<WorkerCredentialStageDiscardRecord>,
    staged: Readonly<WorkerCredentialDeliveryIntent> | null,
  ): Promise<'discarded' | 'already_discarded'> => {
    if (!sameStage(record, staged ?? record)) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    if (staged) {
      try {
        await deliveryAdapter.discard(staged);
      } catch (error) {
        mapDeliveryAdapterError(error);
      }
    }
    if (record.state === 'discarded') return 'already_discarded';
    let completed: Readonly<WorkerCredentialStageDiscardRecord>;
    try {
      completed = normalizeWorkerCredentialStageDiscardRecord(
        await authority.markStageDiscarded({
          deliveryId: record.deliveryId,
          expectedVersion: record.version,
        }),
      );
    } catch (error) {
      if (error instanceof WorkerCredentialDeliveryConflictError) throw error;
      throw new WorkerCredentialDeliveryUnavailableError();
    }
    if (
      completed.state !== 'discarded' ||
      completed.authorizedAtMs !== record.authorizedAtMs ||
      !sameStage(completed, record)
    ) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    return 'discarded';
  };

  return Object.freeze({
    async cleanupInventoryPage(
      options: Readonly<{
        afterDeliveryId?: string;
        limit?: number;
      }> = {},
    ) {
      let page: Readonly<WorkerCredentialStagedSecretPage>;
      try {
        page = normalizeStagedSecretPage(
          await deliveryAdapter.listStaged(options),
        );
      } catch (error) {
        mapDeliveryAdapterError(error);
      }
      const outcomes = [];
      for (const staged of page.stages) {
        let authorized: Readonly<WorkerCredentialStageDiscardRecord>;
        try {
          authorized = normalizeWorkerCredentialStageDiscardRecord(
            await authority.authorizeStageDiscard(staged),
          );
        } catch (error) {
          if (error instanceof WorkerCredentialDeliveryConflictError) throw error;
          throw new WorkerCredentialDeliveryUnavailableError();
        }
        if (!sameStage(authorized, staged)) {
          throw new WorkerCredentialDeliveryConflictError();
        }
        outcomes.push(Object.freeze({
          deliveryId: staged.deliveryId,
          result: await discard(authorized, staged),
        }));
      }
      return Object.freeze({
        outcomes: Object.freeze(outcomes),
        truncated: page.truncated,
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
      });
    },

    async recoverAuthorizedPage(
      options: Readonly<{
        afterDeliveryId?: string;
        limit?: number;
      }> = {},
    ) {
      let page: Readonly<WorkerCredentialStageDiscardRecoveryPage>;
      try {
        page = normalizeWorkerCredentialStageDiscardRecoveryPage(
          await authority.listStageDiscardRecoveryPage(options),
        );
      } catch (error) {
        if (error instanceof WorkerCredentialDeliveryConflictError) throw error;
        throw new WorkerCredentialDeliveryUnavailableError();
      }
      const outcomes = [];
      for (const authorized of page.discards) {
        let staged: Readonly<WorkerCredentialDeliveryIntent> | null;
        try {
          const inspected = await deliveryAdapter.inspect(authorized.deliveryId);
          staged = inspected
            ? normalizeWorkerCredentialDeliveryIntent(inspected)
            : null;
        } catch (error) {
          mapDeliveryAdapterError(error);
        }
        if (staged && !sameStage(authorized, staged)) {
          throw new WorkerCredentialDeliveryConflictError();
        }
        outcomes.push(Object.freeze({
          deliveryId: authorized.deliveryId,
          result: await discard(authorized, staged),
        }));
      }
      return Object.freeze({
        observedAtMs: page.observedAtMs,
        outcomes: Object.freeze(outcomes),
        truncated: page.truncated,
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
      });
    },
  });
}
