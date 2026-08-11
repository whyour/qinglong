import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  LocalOwnerPepperKeyringFileProvider,
  type LocalOwnerPepperKeyMaterial,
} from '@qinglong/local-owner-console/pepper-custody';
import {
  destroyLocalOwnerPepperKey,
  type DestroyLocalOwnerPepperKeyResult,
} from '@qinglong/local-owner-console/pepper-custody/destructive';
import {
  openLocalSqlitePepperGcDatabase,
  type LocalSqliteDatabaseOptions,
  type LocalSqlitePepperGcDatabase,
  type LocalSqliteProfile,
} from '@qinglong/local-sqlite/pepper-gc';
import { assertApiCredentialPepperKeyId } from '@qinglong/runtime-core/api-credential';
import {
  type LocalOwnerPepperActivationRecord,
  type LocalOwnerPepperKeyRecord,
  type LocalOwnerPepperReferenceRepository,
} from '@qinglong/runtime-core/local-owner-pepper';
import {
  localOwnerPepperMaterialGcRetentionPolicyDigest,
  type LocalOwnerPepperMaterialGcRecord,
  type LocalOwnerPepperMaterialGcRepository,
  type LocalOwnerPepperMaterialGcRetentionPolicy,
} from '@qinglong/runtime-core/local-owner-pepper-material-gc';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type LocalOwnerPepperGcCatalog = Pick<
  LocalOwnerPepperReferenceRepository,
  'resolveKey' | 'resolveActive'
>;

export interface CollectLocalOwnerPepperMaterialRequest {
  readonly prepareMutationId: string;
  readonly prepareRequestId: string;
  readonly completeMutationId: string;
  readonly completeRequestId: string;
  readonly pepperKeyId: string;
}

export interface CollectLocalOwnerPepperMaterialResult {
  readonly status: 'inserted' | 'existing';
  readonly record: Readonly<LocalOwnerPepperMaterialGcRecord>;
  readonly runtimeMaterial: Readonly<DestroyLocalOwnerPepperKeyResult>;
  readonly backupMaterial: Readonly<DestroyLocalOwnerPepperKeyResult>;
}

export interface LocalOwnerPepperMaterialGcService {
  collect(
    request: CollectLocalOwnerPepperMaterialRequest,
  ): Promise<Readonly<CollectLocalOwnerPepperMaterialResult>>;
}

export interface CreateLocalOwnerPepperMaterialGcServiceOptions {
  readonly keyringDirectory: string;
  readonly backupDirectory: string;
  readonly retentionPolicy: LocalOwnerPepperMaterialGcRetentionPolicy;
}

export interface OpenLocalOwnerPepperMaterialGcOptions
  extends LocalSqliteDatabaseOptions,
    CreateLocalOwnerPepperMaterialGcServiceOptions {}

export interface LocalOwnerPepperMaterialGcAuthority
  extends LocalOwnerPepperMaterialGcService {
  readonly profile: LocalSqliteProfile;
  close(): Promise<void>;
}

export class LocalOwnerPepperMaterialGcConfigurationError extends TypeError {
  readonly code = 'LOCAL_OWNER_PEPPER_MATERIAL_GC_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(
      `Local Owner pepper material GC configuration is invalid: ${message}`,
    );
    this.name = 'LocalOwnerPepperMaterialGcConfigurationError';
  }
}

export class LocalOwnerPepperMaterialGcMaterialUnavailableError extends Error {
  readonly code = 'LOCAL_OWNER_PEPPER_MATERIAL_GC_MATERIAL_UNAVAILABLE';

  constructor() {
    super(
      'Local Owner pepper material or its independent backup is unavailable',
    );
    this.name = 'LocalOwnerPepperMaterialGcMaterialUnavailableError';
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

function request(
  value: CollectLocalOwnerPepperMaterialRequest,
): Readonly<CollectLocalOwnerPepperMaterialRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'prepareMutationId',
      'prepareRequestId',
      'completeMutationId',
      'completeRequestId',
      'pepperKeyId',
    ]) ||
    !UUID_V4_PATTERN.test(value.prepareMutationId) ||
    !UUID_V4_PATTERN.test(value.completeMutationId) ||
    value.prepareMutationId === value.completeMutationId ||
    !REQUEST_ID_PATTERN.test(value.prepareRequestId) ||
    !REQUEST_ID_PATTERN.test(value.completeRequestId)
  ) {
    throw new LocalOwnerPepperMaterialGcConfigurationError(
      'request shape is invalid',
    );
  }
  try {
    assertApiCredentialPepperKeyId(value.pepperKeyId);
  } catch {
    throw new LocalOwnerPepperMaterialGcConfigurationError(
      'pepperKeyId is invalid',
    );
  }
  return Object.freeze({ ...value });
}

function currentTime(): number {
  const value = Date.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalOwnerPepperMaterialGcConfigurationError(
      'trusted clock is invalid',
    );
  }
  return value;
}

function options(
  value: CreateLocalOwnerPepperMaterialGcServiceOptions,
): Readonly<CreateLocalOwnerPepperMaterialGcServiceOptions> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'keyringDirectory',
      'backupDirectory',
      'retentionPolicy',
    ]) ||
    typeof value.keyringDirectory !== 'string' ||
    typeof value.backupDirectory !== 'string' ||
    !path.isAbsolute(value.keyringDirectory) ||
    !path.isAbsolute(value.backupDirectory) ||
    path.normalize(value.keyringDirectory) !== value.keyringDirectory ||
    path.normalize(value.backupDirectory) !== value.backupDirectory ||
    value.keyringDirectory === value.backupDirectory
  ) {
    throw new LocalOwnerPepperMaterialGcConfigurationError(
      'options shape is invalid',
    );
  }
  try {
    localOwnerPepperMaterialGcRetentionPolicyDigest(value.retentionPolicy);
  } catch (error) {
    throw new LocalOwnerPepperMaterialGcConfigurationError(
      'retentionPolicy is invalid',
      error,
    );
  }
  return Object.freeze({
    keyringDirectory: value.keyringDirectory,
    backupDirectory: value.backupDirectory,
    retentionPolicy: Object.freeze({ ...value.retentionPolicy }),
  });
}

function audit(
  eventId: string,
  requestId: string,
  operation: 'prepare' | 'complete',
  occurredAtMs: number,
) {
  return Object.freeze({
    eventId,
    requestId,
    operationId: `owner.pepper.material_gc.${operation}`,
    projectId: null,
    subject: Object.freeze({ type: 'system' as const, id: 'owner-pepper-gc' }),
    authenticationId: 'local-owner-console',
    outcome: 'allowed' as const,
    reasons: Object.freeze(['pepper_material_gc']),
    fence: null,
    occurredAtMs,
  });
}

function materialMatches(
  material: Readonly<LocalOwnerPepperKeyMaterial> | null,
  expectedDigest: string | undefined,
): material is Readonly<LocalOwnerPepperKeyMaterial> {
  return (
    !!material && !!expectedDigest && material.summary.digest === expectedDigest
  );
}

async function verifiedActive(
  catalog: LocalOwnerPepperGcCatalog,
  runtime: LocalOwnerPepperKeyringFileProvider,
  backup: LocalOwnerPepperKeyringFileProvider,
): Promise<Readonly<LocalOwnerPepperActivationRecord>> {
  const active = await catalog.resolveActive();
  if (!active) {
    throw new LocalOwnerPepperMaterialGcMaterialUnavailableError();
  }
  const key = await catalog.resolveKey(active.activePepperKeyId);
  if (
    !key ||
    key.state !== 'active' ||
    key.materialDigest !== active.materialDigest ||
    key.backupDigest !== active.backupDigest ||
    !materialMatches(
      runtime.resolve(active.activePepperKeyId),
      active.materialDigest,
    ) ||
    !materialMatches(
      backup.resolve(active.activePepperKeyId),
      active.backupDigest,
    )
  ) {
    throw new LocalOwnerPepperMaterialGcMaterialUnavailableError();
  }
  return active;
}

function verifiedRetired(
  key: Readonly<LocalOwnerPepperKeyRecord> | null,
  runtime: LocalOwnerPepperKeyringFileProvider,
  backup: LocalOwnerPepperKeyringFileProvider,
  pepperKeyId: string,
): Readonly<LocalOwnerPepperKeyRecord> {
  if (
    !key ||
    key.state !== 'retired' ||
    !key.materialDigest ||
    !key.backupDigest ||
    !materialMatches(runtime.resolve(pepperKeyId), key.materialDigest) ||
    !materialMatches(backup.resolve(pepperKeyId), key.backupDigest)
  ) {
    throw new LocalOwnerPepperMaterialGcMaterialUnavailableError();
  }
  return key;
}

function combinedProof(
  runtime: Readonly<DestroyLocalOwnerPepperKeyResult>,
  backup: Readonly<DestroyLocalOwnerPepperKeyResult>,
): string {
  return createHash('sha256')
    .update('qinglong.local-owner-pepper-material-gc-completion.v1\0', 'utf8')
    .update(runtime.destructionProofDigest, 'utf8')
    .update('\0', 'utf8')
    .update(backup.destructionProofDigest, 'utf8')
    .digest('hex');
}

export function createLocalOwnerPepperMaterialGcService(
  repository: LocalOwnerPepperMaterialGcRepository,
  catalog: LocalOwnerPepperGcCatalog,
  candidateOptions: CreateLocalOwnerPepperMaterialGcServiceOptions,
): LocalOwnerPepperMaterialGcService {
  if (
    !repository ||
    typeof repository.resolve !== 'function' ||
    typeof repository.prepare !== 'function' ||
    typeof repository.complete !== 'function' ||
    !catalog ||
    typeof catalog.resolveKey !== 'function' ||
    typeof catalog.resolveActive !== 'function'
  ) {
    throw new LocalOwnerPepperMaterialGcConfigurationError(
      'repository boundary is invalid',
    );
  }
  const settings = options(candidateOptions);
  return Object.freeze({
    async collect(candidate: CollectLocalOwnerPepperMaterialRequest) {
      const command = request(candidate);
      const runtimeProvider = new LocalOwnerPepperKeyringFileProvider(
        settings.keyringDirectory,
      );
      const backupProvider = new LocalOwnerPepperKeyringFileProvider(
        settings.backupDirectory,
      );
      let record = await repository.resolve(command.prepareMutationId);
      if (!record) {
        const target = verifiedRetired(
          await catalog.resolveKey(command.pepperKeyId),
          runtimeProvider,
          backupProvider,
          command.pepperKeyId,
        );
        const active = await verifiedActive(
          catalog,
          runtimeProvider,
          backupProvider,
        );
        const preparedAtMs = currentTime();
        record = (
          await repository.prepare({
            mutationId: command.prepareMutationId,
            requestId: command.prepareRequestId,
            pepperKeyId: command.pepperKeyId,
            expectedMaterialDigest: target.materialDigest!,
            expectedBackupMaterialDigest: target.backupDigest!,
            expectedActivePepperKeyId: active.activePepperKeyId,
            expectedActiveGeneration: active.generation,
            expectedActiveMaterialDigest: active.materialDigest,
            retentionPolicy: settings.retentionPolicy,
            preparedAtMs,
            audit: audit(
              command.prepareMutationId,
              command.prepareRequestId,
              'prepare',
              preparedAtMs,
            ),
          })
        ).record;
      }
      if (
        record.prepareMutationId !== command.prepareMutationId ||
        record.prepareRequestId !== command.prepareRequestId ||
        record.pepperKeyId !== command.pepperKeyId ||
        record.retentionPolicyDigest !==
          localOwnerPepperMaterialGcRetentionPolicyDigest(
            settings.retentionPolicy,
          )
      ) {
        throw new LocalOwnerPepperMaterialGcConfigurationError(
          'request conflicts with the durable GC record',
        );
      }
      await verifiedActive(catalog, runtimeProvider, backupProvider);
      const runtimeMaterial = destroyLocalOwnerPepperKey({
        keyringDirectory: settings.keyringDirectory,
        pepperKeyId: record.pepperKeyId,
        materialRole: 'runtime',
        expectedMaterialDigest: record.materialDigest,
        prepareMutationId: record.prepareMutationId,
      });
      const backupMaterial = destroyLocalOwnerPepperKey({
        keyringDirectory: settings.backupDirectory,
        pepperKeyId: record.pepperKeyId,
        materialRole: 'backup',
        expectedMaterialDigest: record.backupMaterialDigest,
        prepareMutationId: record.prepareMutationId,
      });
      const completedAtMs =
        record.completedAtMs ?? Math.max(currentTime(), record.preparedAtMs);
      const completion = await repository.complete({
        prepareMutationId: record.prepareMutationId,
        mutationId: command.completeMutationId,
        requestId: command.completeRequestId,
        destructionProofDigest: combinedProof(runtimeMaterial, backupMaterial),
        completedAtMs,
        audit: audit(
          command.completeMutationId,
          command.completeRequestId,
          'complete',
          completedAtMs,
        ),
      });
      return Object.freeze({
        status: completion.status,
        record: completion.record,
        runtimeMaterial,
        backupMaterial,
      });
    },
  });
}

export async function openLocalOwnerPepperMaterialGc(
  candidate: OpenLocalOwnerPepperMaterialGcOptions,
): Promise<LocalOwnerPepperMaterialGcAuthority> {
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    !exactKeys(candidate, [
      'databasePath',
      'profile',
      'keyringDirectory',
      'backupDirectory',
      'retentionPolicy',
      ...(candidate.busyTimeoutMs === undefined ? [] : ['busyTimeoutMs']),
    ])
  ) {
    throw new LocalOwnerPepperMaterialGcConfigurationError(
      'open options are invalid',
    );
  }
  const settings = options({
    keyringDirectory: candidate.keyringDirectory,
    backupDirectory: candidate.backupDirectory,
    retentionPolicy: candidate.retentionPolicy,
  });
  const databaseOptions: LocalSqliteDatabaseOptions = {
    databasePath: candidate.databasePath,
    profile: candidate.profile,
    ...(candidate.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: candidate.busyTimeoutMs }),
  };
  let database: LocalSqlitePepperGcDatabase | null = null;
  try {
    database = await openLocalSqlitePepperGcDatabase(databaseOptions);
    const service = createLocalOwnerPepperMaterialGcService(
      database.materialGc,
      database.ownerPepper,
      settings,
    );
    const owned = database;
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: owned.profile,
      collect(request: CollectLocalOwnerPepperMaterialRequest) {
        return service.collect(request);
      },
      close() {
        return (closePromise ??= owned.close());
      },
    });
  } catch (error) {
    await database?.close().catch(() => undefined);
    throw error;
  }
}
