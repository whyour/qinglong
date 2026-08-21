import { createHash } from 'node:crypto';

import {
  createLocalDataDirectoryAdoptionReceipt,
  createLocalDataDirectoryAdoptionSecretItem,
  createLocalDataDirectorySourceNameDigest,
  openLocalSqliteDataDirectoryAdoptionDatabase,
  type LocalDataDirectoryAdoptionRecord,
  type LocalDataDirectoryAdoptionSecretPublication,
  type LocalDataDirectoryAppliedModel,
} from '@qinglong/local-sqlite/data-directory-adoption';
import {
  encryptLocalSecretEnvelope,
  ownedLocalSecretKeyMaterial,
} from '@qinglong/local-secret';
import {
  LOCAL_SECRET_ALGORITHM,
  assertLocalSecretName,
  assertLocalSecretPlaintext,
  assertLocalSecretProjectId,
  type LocalSecretKeyProvider,
} from '@qinglong/runtime-core/local-secret';
import {
  ProjectPolicyEngine,
  ProjectPolicyUnavailableError,
} from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VALUE_FILE_PATTERN = /^secret-values\/[0-9a-f]{64}\.json$/;
const STRONG_USER_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);

export interface PreparedLocalDataDirectoryAdoptionSecret {
  readonly kind: 'environment' | 'ssh_private_key';
  readonly sourceName: string;
  readonly targetName: string;
  readonly expectedCurrentVersion: 0;
  readonly valueFile: string;
  readonly valueDigest: string;
  readonly plaintext: string;
}

export interface PreparedLocalDataDirectoryAdoptionModel {
  readonly model: Readonly<LocalDataDirectoryAppliedModel>;
  readonly secrets: readonly Readonly<PreparedLocalDataDirectoryAdoptionSecret>[];
}

export interface ApplyReviewedLocalDataDirectoryAdoptionOptions {
  readonly databasePath: string;
  readonly profile: 'edge' | 'standalone';
  readonly projectId: string;
  readonly mutationId: string;
  readonly failureAuditEventId: string;
  readonly requestId: string;
  readonly sourceStageManifestDigest: string;
  readonly transformationDigest: string;
  readonly modelDigest: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly keyProvider: LocalSecretKeyProvider;
  readonly observedAtMs: number;
  readonly busyTimeoutMs?: number;
  readonly loadPreparedModel: () =>
    | Readonly<PreparedLocalDataDirectoryAdoptionModel>
    | Promise<Readonly<PreparedLocalDataDirectoryAdoptionModel>>;
  readonly confirmAuthenticationAuthority: () => void | Promise<void>;
  readonly confirmPreparedAuthority: () => void | Promise<void>;
}

export interface ApplyReviewedLocalDataDirectoryAdoptionResult {
  readonly status: 'inserted' | 'existing';
  readonly adoption: Readonly<LocalDataDirectoryAdoptionRecord>;
}

export class LocalDataDirectoryAdoptionApplicationConfigurationError extends TypeError {
  readonly code = 'LOCAL_DATA_DIRECTORY_ADOPTION_APPLICATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local data directory adoption application is invalid: ${message}`);
    this.name = 'LocalDataDirectoryAdoptionApplicationConfigurationError';
  }
}

export class LocalDataDirectoryAdoptionApplicationAuthenticationError extends Error {
  readonly code =
    'LOCAL_DATA_DIRECTORY_ADOPTION_APPLICATION_AUTHENTICATION_REQUIRED';

  constructor() {
    super(
      'Local data directory adoption application requires a strong principal',
    );
    this.name = 'LocalDataDirectoryAdoptionApplicationAuthenticationError';
  }
}

export class LocalDataDirectoryAdoptionApplicationAuthorizationError extends Error {
  readonly code = 'LOCAL_DATA_DIRECTORY_ADOPTION_APPLICATION_FORBIDDEN';

  constructor() {
    super('Local data directory adoption application is not authorized');
    this.name = 'LocalDataDirectoryAdoptionApplicationAuthorizationError';
  }
}

export class LocalDataDirectoryAdoptionApplicationUnavailableError extends Error {
  readonly code = 'LOCAL_DATA_DIRECTORY_ADOPTION_APPLICATION_UNAVAILABLE';

  constructor(readonly cause?: unknown) {
    super('Local data directory adoption application is unavailable');
    this.name = 'LocalDataDirectoryAdoptionApplicationUnavailableError';
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

function assertOptions(
  options: ApplyReviewedLocalDataDirectoryAdoptionOptions,
): void {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !UUID_V4_PATTERN.test(options.mutationId) ||
    !UUID_V4_PATTERN.test(options.failureAuditEventId) ||
    options.failureAuditEventId === options.mutationId ||
    !REQUEST_ID_PATTERN.test(options.requestId) ||
    (options.profile !== 'edge' && options.profile !== 'standalone') ||
    ![
      options.sourceStageManifestDigest,
      options.transformationDigest,
      options.modelDigest,
    ].every((digest) => DIGEST_PATTERN.test(digest)) ||
    !Number.isSafeInteger(options.observedAtMs) ||
    options.observedAtMs < 0 ||
    typeof options.loadPreparedModel !== 'function' ||
    typeof options.confirmAuthenticationAuthority !== 'function' ||
    typeof options.confirmPreparedAuthority !== 'function' ||
    !options.keyProvider ||
    typeof options.keyProvider.active !== 'function' ||
    typeof options.keyProvider.resolve !== 'function' ||
    (options.busyTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.busyTimeoutMs) ||
        options.busyTimeoutMs < 100 ||
        options.busyTimeoutMs > 30_000))
  ) {
    throw new LocalDataDirectoryAdoptionApplicationConfigurationError(
      'options are invalid',
    );
  }
  try {
    assertLocalSecretProjectId(options.projectId);
  } catch (error) {
    throw new LocalDataDirectoryAdoptionApplicationConfigurationError(
      'projectId is invalid',
      error,
    );
  }
}

function strongPrincipal(
  value: Readonly<SecurityPrincipal>,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(value, nowMs);
  } catch {
    throw new LocalDataDirectoryAdoptionApplicationAuthenticationError();
  }
  const human =
    principal.subject.type === 'user' &&
    STRONG_USER_ASSURANCES.has(principal.assurance);
  const system =
    principal.subject.type === 'system' && principal.assurance === 'service';
  if (!human && !system) {
    throw new LocalDataDirectoryAdoptionApplicationAuthenticationError();
  }
  return principal;
}

function auditRecord(options: {
  readonly eventId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly principal: Readonly<SecurityPrincipal> | null;
  readonly operationId: string;
  readonly outcome: SecurityAuditRecord['outcome'];
  readonly reasons: readonly string[];
  readonly decision: Readonly<SecurityPolicyDecision> | null;
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
    fence: options.decision?.fence ?? null,
    occurredAtMs: options.occurredAtMs,
  });
}

function deterministicMutationId(
  batchMutationId: string,
  identity: string,
): string {
  const bytes = createHash('sha256')
    .update('qinglong3.legacy-data-directory-secret-mutation.v1\0')
    .update(batchMutationId)
    .update('\0')
    .update(identity)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertPreparedModel(
  value: Readonly<PreparedLocalDataDirectoryAdoptionModel>,
  profile: 'edge' | 'standalone',
): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['model', 'secrets']) ||
    !Array.isArray(value.secrets) ||
    value.secrets.length > (profile === 'edge' ? 128 : 512)
  ) {
    throw new LocalDataDirectoryAdoptionApplicationConfigurationError(
      'prepared model shape is invalid',
    );
  }
  const targets = new Set<string>();
  for (const entry of value.secrets) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !exactKeys(entry, [
        'expectedCurrentVersion',
        'kind',
        'plaintext',
        'sourceName',
        'targetName',
        'valueDigest',
        'valueFile',
      ]) ||
      (entry.kind !== 'environment' && entry.kind !== 'ssh_private_key') ||
      typeof entry.sourceName !== 'string' ||
      entry.sourceName.length < 1 ||
      entry.sourceName.includes('\0') ||
      entry.expectedCurrentVersion !== 0 ||
      !VALUE_FILE_PATTERN.test(entry.valueFile) ||
      !DIGEST_PATTERN.test(entry.valueDigest) ||
      createHash('sha256').update(entry.plaintext, 'utf8').digest('hex') !==
        entry.valueDigest ||
      targets.has(entry.targetName)
    ) {
      throw new LocalDataDirectoryAdoptionApplicationConfigurationError(
        'prepared Secret entry is invalid',
      );
    }
    try {
      assertLocalSecretName(entry.targetName);
      assertLocalSecretPlaintext(entry.plaintext);
    } catch (error) {
      throw new LocalDataDirectoryAdoptionApplicationConfigurationError(
        'prepared Secret value is invalid',
        error,
      );
    }
    targets.add(entry.targetName);
  }
}

function sameExpected(
  record: Readonly<LocalDataDirectoryAdoptionRecord>,
  options: Readonly<ApplyReviewedLocalDataDirectoryAdoptionOptions>,
): boolean {
  return (
    record.mutationId === options.mutationId &&
    record.projectId === options.projectId &&
    record.profile === options.profile &&
    record.sourceStageManifestDigest === options.sourceStageManifestDigest &&
    record.transformationDigest === options.transformationDigest &&
    record.modelDigest === options.modelDigest
  );
}

export async function applyReviewedLocalDataDirectoryAdoption(
  options: Readonly<ApplyReviewedLocalDataDirectoryAdoptionOptions>,
): Promise<Readonly<ApplyReviewedLocalDataDirectoryAdoptionResult>> {
  assertOptions(options);
  const database = await openLocalSqliteDataDirectoryAdoptionDatabase({
    databasePath: options.databasePath,
    profile: options.profile,
    ...(options.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: options.busyTimeoutMs }),
  });
  try {
    let principal: Readonly<SecurityPrincipal>;
    try {
      principal = strongPrincipal(options.principal, options.observedAtMs);
      await options.confirmAuthenticationAuthority();
    } catch (error) {
      try {
        await database.securityAudit.record(
          auditRecord({
            eventId: options.failureAuditEventId,
            requestId: options.requestId,
            projectId: options.projectId,
            principal: null,
            operationId: 'legacy-data.apply',
            outcome: 'authentication_rejected',
            reasons: ['strong_authentication_required'],
            decision: null,
            occurredAtMs: options.observedAtMs,
          }),
        );
      } catch {
        throw new LocalDataDirectoryAdoptionApplicationUnavailableError();
      }
      throw error;
    }

    const policy = new ProjectPolicyEngine(database.projectPolicy);
    let decision: Readonly<SecurityPolicyDecision>;
    try {
      decision = await policy.authorize(
        principal,
        options.projectId,
        'secret.manage',
      );
    } catch (error) {
      if (!(error instanceof ProjectPolicyUnavailableError)) {
        throw new LocalDataDirectoryAdoptionApplicationUnavailableError(error);
      }
      try {
        await database.securityAudit.record(
          auditRecord({
            eventId: options.failureAuditEventId,
            requestId: options.requestId,
            projectId: options.projectId,
            principal,
            operationId: 'legacy-data.apply',
            outcome: 'authorization_unavailable',
            reasons: ['policy_unavailable'],
            decision: null,
            occurredAtMs: options.observedAtMs,
          }),
        );
      } catch {
        throw new LocalDataDirectoryAdoptionApplicationUnavailableError();
      }
      throw new LocalDataDirectoryAdoptionApplicationUnavailableError();
    }
    if (decision.effect !== 'allow') {
      try {
        await database.securityAudit.record(
          auditRecord({
            eventId: options.failureAuditEventId,
            requestId: options.requestId,
            projectId: options.projectId,
            principal,
            operationId: 'legacy-data.apply',
            outcome:
              decision.effect === 'require_approval'
                ? 'approval_required'
                : 'denied',
            reasons: decision.reasons,
            decision,
            occurredAtMs: options.observedAtMs,
          }),
        );
      } catch {
        throw new LocalDataDirectoryAdoptionApplicationUnavailableError();
      }
      throw new LocalDataDirectoryAdoptionApplicationAuthorizationError();
    }
    if (!decision.fence || decision.fence.bindingVersion === null) {
      throw new LocalDataDirectoryAdoptionApplicationUnavailableError();
    }

    const existing = await database.publisher.resolve(options.mutationId);
    if (existing) {
      if (!sameExpected(existing, options)) {
        throw new LocalDataDirectoryAdoptionApplicationConfigurationError(
          'mutation replay does not match the committed adoption',
        );
      }
      await options.confirmAuthenticationAuthority();
      return Object.freeze({ status: 'existing', adoption: existing });
    }

    const prepared = await options.loadPreparedModel();
    assertPreparedModel(prepared, options.profile);
    const material = ownedLocalSecretKeyMaterial(
      await options.keyProvider.active(),
    );
    const publications: LocalDataDirectoryAdoptionSecretPublication[] = [];
    try {
      for (const [index, secret] of prepared.secrets.entries()) {
        const ordinal = index + 1;
        const secretMutationId = deterministicMutationId(
          options.mutationId,
          `${secret.kind}\0${secret.targetName}`,
        );
        const envelope = encryptLocalSecretEnvelope(
          {
            projectId: options.projectId,
            name: secret.targetName,
            version: 1,
            mutationId: secretMutationId,
            keyId: material.keyId,
            algorithm: LOCAL_SECRET_ALGORITHM,
            createdAtMs: options.observedAtMs,
          },
          secret.plaintext,
          material.key,
        );
        const item = createLocalDataDirectoryAdoptionSecretItem({
          projectId: options.projectId,
          ordinal,
          kind: secret.kind,
          sourceNameDigest: createLocalDataDirectorySourceNameDigest(
            secret.kind,
            secret.sourceName,
          ),
          secretName: secret.targetName,
          secretMutationId,
          valueFile: secret.valueFile,
          valueDigest: secret.valueDigest,
        });
        publications.push(
          Object.freeze({
            ordinal,
            kind: secret.kind,
            sourceNameDigest: item.sourceNameDigest,
            valueFile: secret.valueFile,
            valueDigest: secret.valueDigest,
            envelope,
            secretRef: item.secretRef,
            itemDigest: item.itemDigest,
            audit: auditRecord({
              eventId: secretMutationId,
              requestId: options.requestId,
              projectId: options.projectId,
              principal,
              operationId: 'secret.create',
              outcome: 'allowed',
              reasons: decision.reasons,
              decision,
              occurredAtMs: options.observedAtMs,
            }),
          }),
        );
      }
    } finally {
      material.key.fill(0);
    }
    const receipt = createLocalDataDirectoryAdoptionReceipt({
      mutationId: options.mutationId,
      projectId: options.projectId,
      profile: options.profile,
      sourceStageManifestDigest: options.sourceStageManifestDigest,
      transformationDigest: options.transformationDigest,
      modelDigest: options.modelDigest,
      secrets: publications.map(({ envelope, ...item }) =>
        Object.freeze({
          ordinal: item.ordinal,
          kind: item.kind,
          sourceNameDigest: item.sourceNameDigest,
          secretName: envelope.name,
          secretVersion: 1 as const,
          secretMutationId: envelope.mutationId,
          valueFile: item.valueFile,
          valueDigest: item.valueDigest,
          secretRef: item.secretRef,
          itemDigest: item.itemDigest,
        }),
      ),
      committedAtMs: options.observedAtMs,
    });
    const applied = await database.publisher.publish({
      mutationId: options.mutationId,
      projectId: options.projectId,
      profile: options.profile,
      sourceStageManifestDigest: options.sourceStageManifestDigest,
      transformationDigest: options.transformationDigest,
      modelDigest: options.modelDigest,
      model: prepared.model,
      subject: principal.subject,
      fence: decision.fence,
      audit: auditRecord({
        eventId: options.mutationId,
        requestId: options.requestId,
        projectId: options.projectId,
        principal,
        operationId: 'legacy-data.apply',
        outcome: 'allowed',
        reasons: decision.reasons,
        decision,
        occurredAtMs: options.observedAtMs,
      }),
      secrets: Object.freeze(publications),
      receipt,
      async confirmExternalAuthority() {
        await options.confirmPreparedAuthority();
        await options.confirmAuthenticationAuthority();
      },
    });
    return Object.freeze(applied);
  } finally {
    await database.close();
  }
}
