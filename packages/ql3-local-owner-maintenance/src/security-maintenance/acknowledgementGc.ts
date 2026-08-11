import { FileLocalOwnerBootstrapSecretDelivery } from '@qinglong/local-owner-console/secret-delivery';
import {
  openLocalSqliteAcknowledgementGcDatabase,
  type LocalSqliteAcknowledgementGcDatabase,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '@qinglong/local-sqlite/acknowledgement-gc';
import {
  localOwnerDeliveryAcknowledgementGcRetentionPolicyDigest,
  type LocalOwnerDeliveryAcknowledgementGcRecord,
  type LocalOwnerDeliveryAcknowledgementGcRepository,
  type LocalOwnerDeliveryAcknowledgementGcRetentionPolicy,
} from '@qinglong/runtime-core/local-owner-delivery-acknowledgement-gc';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface CompactLocalOwnerDeliveryAcknowledgementRequest {
  readonly mutationId: string;
  readonly requestId: string;
  readonly acknowledgementMutationId: string;
  readonly expectedKind: 'credential' | 'challenge';
  readonly expectedDeliveryDigest: string;
}

export interface CompactLocalOwnerDeliveryAcknowledgementResult {
  readonly status: 'inserted' | 'existing';
  readonly record: Readonly<LocalOwnerDeliveryAcknowledgementGcRecord>;
}

export interface LocalOwnerDeliveryAcknowledgementGcService {
  compact(
    request: CompactLocalOwnerDeliveryAcknowledgementRequest,
  ): Promise<Readonly<CompactLocalOwnerDeliveryAcknowledgementResult>>;
}

export interface CreateLocalOwnerDeliveryAcknowledgementGcServiceOptions {
  readonly secretDeliveryDirectory: string;
  readonly retentionPolicy: LocalOwnerDeliveryAcknowledgementGcRetentionPolicy;
}

export interface OpenLocalOwnerDeliveryAcknowledgementGcOptions
  extends LocalSqliteDatabaseOptions,
    CreateLocalOwnerDeliveryAcknowledgementGcServiceOptions {}

export interface LocalOwnerDeliveryAcknowledgementGcAuthority
  extends LocalOwnerDeliveryAcknowledgementGcService {
  readonly profile: LocalSqliteProfile;
  close(): Promise<void>;
}

export class LocalOwnerDeliveryAcknowledgementGcConfigurationError extends TypeError {
  readonly code =
    'LOCAL_OWNER_DELIVERY_ACKNOWLEDGEMENT_GC_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(
      `Local Owner delivery acknowledgement GC configuration is invalid: ${message}`,
    );
    this.name = 'LocalOwnerDeliveryAcknowledgementGcConfigurationError';
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
  value: CompactLocalOwnerDeliveryAcknowledgementRequest,
): Readonly<CompactLocalOwnerDeliveryAcknowledgementRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'mutationId',
      'requestId',
      'acknowledgementMutationId',
      'expectedKind',
      'expectedDeliveryDigest',
    ]) ||
    !UUID_V4_PATTERN.test(value.mutationId) ||
    !UUID_V4_PATTERN.test(value.acknowledgementMutationId) ||
    value.mutationId === value.acknowledgementMutationId ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    (value.expectedKind !== 'credential' &&
      value.expectedKind !== 'challenge') ||
    !DIGEST_PATTERN.test(value.expectedDeliveryDigest)
  ) {
    throw new LocalOwnerDeliveryAcknowledgementGcConfigurationError(
      'request shape is invalid',
    );
  }
  return Object.freeze({ ...value });
}

function options(
  value: CreateLocalOwnerDeliveryAcknowledgementGcServiceOptions,
): Readonly<CreateLocalOwnerDeliveryAcknowledgementGcServiceOptions> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['secretDeliveryDirectory', 'retentionPolicy'])
  ) {
    throw new LocalOwnerDeliveryAcknowledgementGcConfigurationError(
      'options shape is invalid',
    );
  }
  try {
    localOwnerDeliveryAcknowledgementGcRetentionPolicyDigest(
      value.retentionPolicy,
    );
  } catch (error) {
    throw new LocalOwnerDeliveryAcknowledgementGcConfigurationError(
      'retentionPolicy is invalid',
      error,
    );
  }
  return Object.freeze({
    secretDeliveryDirectory: value.secretDeliveryDirectory,
    retentionPolicy: Object.freeze({ ...value.retentionPolicy }),
  });
}

function sameExisting(
  record: Readonly<LocalOwnerDeliveryAcknowledgementGcRecord>,
  value: Readonly<CompactLocalOwnerDeliveryAcknowledgementRequest>,
  retentionPolicy: LocalOwnerDeliveryAcknowledgementGcRetentionPolicy,
): boolean {
  return (
    record.mutationId === value.mutationId &&
    record.requestId === value.requestId &&
    record.acknowledgementMutationId === value.acknowledgementMutationId &&
    record.acknowledgementKind === value.expectedKind &&
    record.deliveryDigest === value.expectedDeliveryDigest &&
    record.retentionPolicyDigest ===
      localOwnerDeliveryAcknowledgementGcRetentionPolicyDigest(retentionPolicy)
  );
}

function audit(eventId: string, requestId: string, occurredAtMs: number) {
  return Object.freeze({
    eventId,
    requestId,
    operationId: 'owner.delivery_acknowledgement.gc',
    projectId: null,
    subject: Object.freeze({
      type: 'system' as const,
      id: 'owner-acknowledgement-gc',
    }),
    authenticationId: 'local-owner-console',
    outcome: 'allowed' as const,
    reasons: Object.freeze(['delivery_acknowledgement_gc']),
    fence: null,
    occurredAtMs,
  });
}

export function createLocalOwnerDeliveryAcknowledgementGcService(
  repository: LocalOwnerDeliveryAcknowledgementGcRepository,
  candidateOptions: CreateLocalOwnerDeliveryAcknowledgementGcServiceOptions,
): LocalOwnerDeliveryAcknowledgementGcService {
  if (
    !repository ||
    typeof repository.resolveByAcknowledgement !== 'function' ||
    typeof repository.compact !== 'function'
  ) {
    throw new LocalOwnerDeliveryAcknowledgementGcConfigurationError(
      'repository boundary is invalid',
    );
  }
  const settings = options(candidateOptions);
  const delivery = new FileLocalOwnerBootstrapSecretDelivery(
    settings.secretDeliveryDirectory,
  );
  return Object.freeze({
    async compact(candidate: CompactLocalOwnerDeliveryAcknowledgementRequest) {
      const command = request(candidate);
      const existing = await repository.resolveByAcknowledgement(
        command.acknowledgementMutationId,
      );
      if (existing) {
        if (!sameExisting(existing, command, settings.retentionPolicy)) {
          throw new LocalOwnerDeliveryAcknowledgementGcConfigurationError(
            'request conflicts with the durable GC record',
          );
        }
        return Object.freeze({ status: 'existing' as const, record: existing });
      }
      const evidence = delivery.inspectBridgeClear(
        command.expectedKind,
        command.acknowledgementMutationId,
      );
      return repository.compact({
        ...command,
        bridgeClearEvidence: evidence,
        retentionPolicy: settings.retentionPolicy,
        compactedAtMs: evidence.inspectedAtMs,
        audit: audit(
          command.mutationId,
          command.requestId,
          evidence.inspectedAtMs,
        ),
      });
    },
  });
}

export async function openLocalOwnerDeliveryAcknowledgementGc(
  candidate: OpenLocalOwnerDeliveryAcknowledgementGcOptions,
): Promise<LocalOwnerDeliveryAcknowledgementGcAuthority> {
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    !exactKeys(candidate, [
      'databasePath',
      'profile',
      'secretDeliveryDirectory',
      'retentionPolicy',
      ...(candidate.busyTimeoutMs === undefined ? [] : ['busyTimeoutMs']),
    ])
  ) {
    throw new LocalOwnerDeliveryAcknowledgementGcConfigurationError(
      'open options are invalid',
    );
  }
  const settings = options({
    secretDeliveryDirectory: candidate.secretDeliveryDirectory,
    retentionPolicy: candidate.retentionPolicy,
  });
  const databaseOptions: LocalSqliteDatabaseOptions = {
    databasePath: candidate.databasePath,
    profile: candidate.profile,
    ...(candidate.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: candidate.busyTimeoutMs }),
  };
  let database: LocalSqliteAcknowledgementGcDatabase | null = null;
  try {
    database = await openLocalSqliteAcknowledgementGcDatabase(databaseOptions);
    const service = createLocalOwnerDeliveryAcknowledgementGcService(
      database.acknowledgementGc,
      settings,
    );
    const owned = database;
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: owned.profile,
      compact(request: CompactLocalOwnerDeliveryAcknowledgementRequest) {
        return service.compact(request);
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
