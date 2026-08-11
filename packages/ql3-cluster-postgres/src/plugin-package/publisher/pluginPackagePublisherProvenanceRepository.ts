// PostgreSQL Plugin Package publisher provenance and revocation impact authority.
import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryable,
} from '@qinglong/runtime-core';
import {
  approvedActionDispatchDigest,
  normalizeApprovedActionDispatchRecord,
  type ApprovedActionDispatchRecord,
} from '@qinglong/runtime-core/approved-action';
import {
  InvalidPluginPackageInstallError,
  PluginPackageInstallMutationConflictError,
  PluginPackageInstallTransitionConflictError,
  normalizePluginPackageInstallRecord,
  pluginPackageInstallCommit,
  type PluginPackageInstallCommit,
  type PluginPackageInstallRecord,
} from '@qinglong/runtime-core/plugin-package-install';
import {
  InvalidPluginPackagePublisherProvenanceError,
  MAX_PLUGIN_PACKAGE_PUBLISHER_REVOCATION_IMPACT_ITEMS,
  PluginPackagePublisherProvenanceConflictError,
  PluginPackagePublisherProvenanceUnavailableError,
  createPluginPackagePublisherRevocationImpact,
  normalizePluginPackagePublisherProvenance,
  normalizePluginPackagePublisherRevocationImpact,
  normalizePluginPackagePublisherRevocationReceipt,
  type PluginPackagePublisherProvenance,
  type PluginPackagePublisherRevocationImpact,
  type PluginPackagePublisherRevocationReceipt,
} from '@qinglong/runtime-core/plugin-package-publisher-provenance';
import {
  normalizePluginPackagePublisherRevocationProposal,
  resolvePluginPackagePublisherRevocationProposal,
  type PluginPackagePublisherRevocationProposal,
} from '@qinglong/runtime-core/plugin-package-publisher-revocation-proposal';
import {
  advancePluginPackagePublisherTrustHead,
  createPluginPackagePublisherEffectiveTrustSnapshot,
  normalizePluginPackagePublisherTrustHead,
  normalizePluginPackagePublisherTrustSnapshot,
  pluginPackagePublisherTrustRevokedDigest,
  type PluginPackagePublisherTrustHead,
  type PluginPackagePublisherTrustSnapshot,
} from '@qinglong/runtime-core/plugin-package-publisher-trust';
import type {
  PluginPackageQuarantineTarget,
} from '@qinglong/runtime-core/plugin-package-quarantine';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresQueryable, 'query'>;

export const POSTGRES_PLUGIN_PACKAGE_PROVENANCE_RECOVERY_PAGE_LIMIT = 128;

export interface PluginPackagePublisherProvenanceRecoveryCursor {
  readonly packageName: string;
  readonly installationId: string;
}

export interface PluginPackagePublisherProvenanceRecoveryPage {
  readonly records: readonly Readonly<PluginPackageInstallRecord>[];
  readonly truncated: boolean;
  readonly next?: Readonly<PluginPackagePublisherProvenanceRecoveryCursor>;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SIGNER_ADVISORY_LOCK_SEED = 774635229;
const AUTOMATION_START_SIGNER_ADVISORY_LOCK_SEED = 774635230;

function unavailable(
  cause?: unknown,
): PluginPackagePublisherProvenanceUnavailableError {
  return new PluginPackagePublisherProvenanceUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseRevocationProposal(
  row: Row,
): Readonly<PluginPackagePublisherRevocationProposal> {
  try {
    const proposal = normalizePluginPackagePublisherRevocationProposal(
      postgresRequiredJsonObject(
        row.proposalJson,
        unavailable,
      ) as unknown as PluginPackagePublisherRevocationProposal,
    );
    if (
      proposal.proposalDigest !==
      postgresRequiredString(row.proposalDigest, unavailable)
    ) {
      throw unavailable();
    }
    return proposal;
  } catch (error) {
    if (error instanceof PluginPackagePublisherProvenanceUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

function parseRevocationDispatch(
  row: Row,
): Readonly<ApprovedActionDispatchRecord> {
  try {
    const dispatch = normalizeApprovedActionDispatchRecord(
      postgresRequiredJsonObject(
        row.dispatchJson,
        unavailable,
      ) as unknown as ApprovedActionDispatchRecord,
    );
    if (
      approvedActionDispatchDigest(dispatch) !==
      postgresRequiredString(row.dispatchDigest, unavailable)
    ) {
      throw unavailable();
    }
    return dispatch;
  } catch (error) {
    if (error instanceof PluginPackagePublisherProvenanceUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

function parseTrustHead(
  row: Row,
): Readonly<PluginPackagePublisherTrustHead> {
  try {
    const head = normalizePluginPackagePublisherTrustHead(
      postgresRequiredJsonObject(
        row.headJson,
        unavailable,
      ) as unknown as PluginPackagePublisherTrustHead,
    );
    if (
      head.headDigest !==
      postgresRequiredString(row.headDigest, unavailable)
    ) {
      throw unavailable();
    }
    return head;
  } catch (error) {
    if (error instanceof PluginPackagePublisherProvenanceUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

function parseTrustSnapshot(
  row: Row,
): Readonly<PluginPackagePublisherTrustSnapshot> {
  try {
    const snapshot = normalizePluginPackagePublisherTrustSnapshot(
      postgresRequiredJsonObject(
        row.snapshotJson,
        unavailable,
      ) as unknown as PluginPackagePublisherTrustSnapshot,
    );
    if (
      snapshot.snapshotDigest !==
      postgresRequiredString(row.snapshotDigest, unavailable)
    ) {
      throw unavailable();
    }
    return snapshot;
  } catch (error) {
    if (error instanceof PluginPackagePublisherProvenanceUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackagePublisherProvenanceError ||
    error instanceof PluginPackagePublisherProvenanceConflictError ||
    error instanceof PluginPackagePublisherProvenanceUnavailableError ||
    error instanceof InvalidPluginPackageInstallError ||
    error instanceof PluginPackageInstallMutationConflictError ||
    error instanceof PluginPackageInstallTransitionConflictError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackagePublisherProvenanceConflictError(
      'publisher provenance identity or relation conflicts',
    );
  }
  return unavailable(error);
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidPluginPackagePublisherProvenanceError(
      `${label} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    required.some((key) => !actual.includes(key)) ||
    actual.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new InvalidPluginPackagePublisherProvenanceError(
      `${label} shape is invalid`,
    );
  }
}

function recordJson(row: Row, key: string): Readonly<Record<string, unknown>> {
  return postgresRequiredJsonObject(row[key], unavailable);
}

function text(row: Row, key: string): string {
  return postgresRequiredString(row[key], unavailable);
}

function parseInstall(row: Row): Readonly<PluginPackageInstallRecord> {
  try {
    return normalizePluginPackageInstallRecord(
      recordJson(row, 'recordJson') as unknown as PluginPackageInstallRecord,
    );
  } catch (error) {
    if (error instanceof PluginPackagePublisherProvenanceUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

function parseProvenance(
  row: Row,
): Readonly<PluginPackagePublisherProvenance> {
  try {
    return normalizePluginPackagePublisherProvenance(
      recordJson(row, 'provenanceJson') as unknown as
        PluginPackagePublisherProvenance,
    );
  } catch (error) {
    if (error instanceof PluginPackagePublisherProvenanceUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

function parseImpact(
  row: Row,
): Readonly<PluginPackagePublisherRevocationImpact> {
  try {
    return normalizePluginPackagePublisherRevocationImpact(
      recordJson(row, 'impactJson') as unknown as
        PluginPackagePublisherRevocationImpact,
    );
  } catch (error) {
    if (error instanceof PluginPackagePublisherProvenanceUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

function normalizeStageCommit(
  value: Readonly<PluginPackageInstallCommit>,
): Readonly<PluginPackageInstallCommit> {
  const command = dataRecord(value, 'stage commit');
  exactKeys(
    command,
    [
      'expectedRecordDigest',
      'expectedVersion',
      'installationId',
      'mutationDigest',
      'mutationId',
      'record',
    ],
    [],
    'stage commit',
  );
  const record = normalizePluginPackageInstallRecord(value.record);
  if (
    record.state !== 'staged' ||
    record.stageReceipt === null ||
    value.installationId !== record.installationId ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 1 ||
    value.expectedVersion >= record.version ||
    typeof value.expectedRecordDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.expectedRecordDigest) ||
    value.mutationId !== record.lastMutationId ||
    value.mutationDigest !== record.lastMutationDigest
  ) {
    throw new InvalidPluginPackagePublisherProvenanceError(
      'stage commit identity is invalid',
    );
  }
  return Object.freeze({
    installationId: record.installationId,
    expectedVersion: value.expectedVersion,
    expectedRecordDigest: value.expectedRecordDigest,
    mutationId: record.lastMutationId,
    mutationDigest: record.lastMutationDigest,
    record,
  });
}

function assertProvenanceMatchesRecord(
  provenance: Readonly<PluginPackagePublisherProvenance>,
  record: Readonly<PluginPackageInstallRecord>,
): void {
  if (
    record.stageReceipt === null ||
    provenance.projectId !== record.projectId ||
    provenance.packageName !== record.packageName ||
    provenance.installationId !== record.installationId ||
    provenance.lockDigest !== record.lockDigest ||
    provenance.artifactDigest !== record.stageReceipt.artifactDigest ||
    provenance.manifestDigest !== record.stageReceipt.manifestDigest ||
    provenance.contentDigest !== record.stageReceipt.contentDigest ||
    provenance.stageEvidenceDigest !== record.stageReceipt.evidenceDigest
  ) {
    throw new PluginPackagePublisherProvenanceConflictError(
      'publisher provenance does not match the durable install stage',
    );
  }
}

async function signerLock(
  queryable: Queryable,
  publisher: string,
  keyId: string,
): Promise<void> {
  await queryable.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`,
    [JSON.stringify([publisher, keyId]), SIGNER_ADVISORY_LOCK_SEED],
  );
}

async function automationStartSignerLock(
  queryable: Queryable,
  publisher: string,
  keyId: string,
): Promise<void> {
  await queryable.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`,
    [
      `${Buffer.byteLength(publisher, 'utf8')}:${publisher}` +
        `${Buffer.byteLength(keyId, 'utf8')}:${keyId}`,
      AUTOMATION_START_SIGNER_ADVISORY_LOCK_SEED,
    ],
  );
}

async function currentInstall(
  queryable: Queryable,
  installationId: string,
  forUpdate = false,
): Promise<Readonly<PluginPackageInstallRecord> | null> {
  const result = await queryable.query<Row>(
    `SELECT record_json AS "recordJson"
     FROM "ql3"."plugin_package_installs"
     WHERE installation_id = $1
     LIMIT 2
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [installationId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseInstall(result.rows[0]!);
}

async function storedProvenance(
  queryable: Queryable,
  installationId: string,
): Promise<Readonly<PluginPackagePublisherProvenance> | null> {
  const result = await queryable.query<Row>(
    `SELECT provenance_json AS "provenanceJson"
     FROM "ql3"."plugin_package_publisher_provenance"
     WHERE installation_id = $1
     LIMIT 2`,
    [installationId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseProvenance(result.rows[0]!);
}

async function storedImpactByReceipt(
  queryable: Queryable,
  receiptDigest: string,
): Promise<Readonly<PluginPackagePublisherRevocationImpact> | null> {
  const result = await queryable.query<Row>(
    `SELECT impact_json AS "impactJson"
     FROM "ql3"."plugin_package_publisher_revocation_impacts"
     WHERE revocation_receipt_digest = $1
     LIMIT 2`,
    [receiptDigest],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseImpact(result.rows[0]!);
}

async function assertSignerNotRevoked(
  queryable: Queryable,
  provenance: Readonly<PluginPackagePublisherProvenance>,
): Promise<void> {
  const result = await queryable.query(
    `SELECT 1
     FROM "ql3"."plugin_package_publisher_revocation_receipts"
     WHERE publisher = $1 AND key_id = $2
     LIMIT 1`,
    [provenance.publisher, provenance.keyId],
  );
  if (result.rows.length !== 0) {
    throw new PluginPackagePublisherProvenanceConflictError(
      'publisher key is durably revoked',
    );
  }
}

async function assertSignerInEffectiveTrust(
  queryable: Queryable,
  trustAuthorityId: string,
  provenance: Readonly<PluginPackagePublisherProvenance>,
): Promise<void> {
  if (
    typeof trustAuthorityId !== 'string' ||
    !IDENTIFIER_PATTERN.test(trustAuthorityId)
  ) {
    throw new InvalidPluginPackagePublisherProvenanceError(
      'trustAuthorityId is invalid',
    );
  }
  const result = await queryable.query<Row>(
    `SELECT snapshot.snapshot_json AS "snapshotJson",
            snapshot.snapshot_digest AS "snapshotDigest"
     FROM "ql3"."plugin_package_publisher_trust_heads" AS head
     JOIN "ql3"."plugin_package_publisher_trust_snapshots" AS snapshot
       ON snapshot.snapshot_digest = head.effective_trust_digest
     WHERE head.authority_id = $1
     LIMIT 2`,
    [trustAuthorityId],
  );
  if (result.rows.length !== 1) {
    throw new PluginPackagePublisherProvenanceConflictError(
      'publisher trust authority is unavailable',
    );
  }
  const snapshot = parseTrustSnapshot(result.rows[0]!);
  if (
    !snapshot.keys.some(
      (key) =>
        key.publisher === provenance.publisher &&
        key.keyId === provenance.keyId &&
        key.notBeforeMs === provenance.keyNotBeforeMs &&
        key.notAfterMs === provenance.keyNotAfterMs,
    )
  ) {
    throw new PluginPackagePublisherProvenanceConflictError(
      'publisher signer is not in the effective trust set',
    );
  }
}

async function insertProvenance(
  queryable: Queryable,
  provenance: Readonly<PluginPackagePublisherProvenance>,
): Promise<void> {
  const result = await queryable.query(
    `INSERT INTO "ql3"."plugin_package_publisher_provenance" (
       installation_id, project_id, package_name, lock_digest,
       artifact_digest, manifest_digest, content_digest,
       stage_evidence_digest, publisher, key_id, signature_digest,
       key_not_before_ms, key_not_after_ms, verified_at_ms,
       provenance_digest, provenance_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15, $16::jsonb
     )`,
    [
      provenance.installationId,
      provenance.projectId,
      provenance.packageName,
      provenance.lockDigest,
      provenance.artifactDigest,
      provenance.manifestDigest,
      provenance.contentDigest,
      provenance.stageEvidenceDigest,
      provenance.publisher,
      provenance.keyId,
      provenance.signatureDigest,
      provenance.keyNotBeforeMs,
      provenance.keyNotAfterMs,
      provenance.verifiedAtMs,
      provenance.provenanceDigest,
      JSON.stringify(provenance),
    ],
  );
  if (result.rowCount !== 1) throw unavailable();
}

export class PostgresPluginPackagePublisherProvenanceRepository {
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL Plugin Package publisher provenance pool is invalid',
      );
    }
  }

  async #transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        throw mapStorageError(error);
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const result = await work(client);
        await client.query('COMMIT');
        began = false;
        return result;
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          state &&
          POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) &&
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        throw mapStorageError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }

  async findByInstallation(
    installationId: string,
  ): Promise<Readonly<PluginPackagePublisherProvenance> | null> {
    if (
      typeof installationId !== 'string' ||
      !IDENTIFIER_PATTERN.test(installationId)
    ) {
      throw new InvalidPluginPackagePublisherProvenanceError(
        'installationId is invalid',
      );
    }
    try {
      return await storedProvenance(this.pool, installationId);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  commitStage(
    value: Readonly<PluginPackageInstallCommit>,
    provenanceValue: Readonly<PluginPackagePublisherProvenance>,
    trustAuthorityId: string,
  ): Promise<
    Readonly<{
      status: 'committed' | 'existing';
      record: Readonly<PluginPackageInstallRecord>;
    }>
  > {
    const command = normalizeStageCommit(value);
    const provenance =
      normalizePluginPackagePublisherProvenance(provenanceValue);
    assertProvenanceMatchesRecord(provenance, command.record);
    return this.#transaction(async (client) => {
      await signerLock(client, provenance.publisher, provenance.keyId);
      const replay = await client.query<Row>(
        `SELECT mutation_digest AS "mutationDigest",
                resulting_record_digest AS "resultingRecordDigest"
         FROM "ql3"."plugin_package_install_mutations"
         WHERE installation_id = $1 AND mutation_id = $2
         LIMIT 2`,
        [command.installationId, command.mutationId],
      );
      if (replay.rows.length > 0) {
        if (
          replay.rows.length !== 1 ||
          text(replay.rows[0]!, 'mutationDigest') !==
            command.mutationDigest ||
          text(replay.rows[0]!, 'resultingRecordDigest') !==
            command.record.recordDigest
        ) {
          throw new PluginPackageInstallMutationConflictError();
        }
        const [record, durableProvenance] = await Promise.all([
          currentInstall(client, command.installationId),
          storedProvenance(client, command.installationId),
        ]);
        if (
          !record ||
          !durableProvenance ||
          !same(durableProvenance, provenance)
        ) {
          throw new PluginPackagePublisherProvenanceConflictError(
            'stage replay is missing exact publisher provenance',
          );
        }
        return Object.freeze({
          status: 'existing' as const,
          record,
        });
      }
      const current = await currentInstall(
        client,
        command.installationId,
        true,
      );
      if (!current || current.state !== 'queued') {
        throw new PluginPackageInstallTransitionConflictError();
      }
      const head = await client.query<Row>(
        `SELECT installation_id AS "installationId"
         FROM "ql3"."plugin_package_install_heads"
         WHERE project_id = $1 AND package_name = $2
         LIMIT 2
         FOR UPDATE`,
        [current.projectId, current.packageName],
      );
      if (
        head.rows.length !== 1 ||
        text(head.rows[0]!, 'installationId') !== current.installationId ||
        current.version !== command.expectedVersion ||
        current.recordDigest !== command.expectedRecordDigest ||
        !same(pluginPackageInstallCommit(current, command.record), command)
      ) {
        throw new PluginPackageInstallTransitionConflictError();
      }
      await assertSignerNotRevoked(client, provenance);
      await assertSignerInEffectiveTrust(
        client,
        trustAuthorityId,
        provenance,
      );
      await insertProvenance(client, provenance);
      const record = command.record;
      const updated = await client.query(
        `UPDATE "ql3"."plugin_package_installs"
         SET package_version = $1, operation = $2, lock_digest = $3,
             target_generation = $4, previous_active_lock_digest = $5,
             active_lock_digest = $6, state = $7, version = $8,
             last_mutation_id = $9, last_mutation_digest = $10,
             record_json = $11::jsonb, record_digest = $12,
             updated_at_ms = $13
         WHERE installation_id = $14 AND version = $15
           AND record_digest = $16`,
        [
          record.packageVersion,
          record.operation,
          record.lockDigest,
          record.targetGeneration,
          record.previousActiveLockDigest,
          record.activeLockDigest,
          record.state,
          record.version,
          record.lastMutationId,
          record.lastMutationDigest,
          JSON.stringify(record),
          record.recordDigest,
          record.updatedAtMs,
          record.installationId,
          command.expectedVersion,
          command.expectedRecordDigest,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new PluginPackageInstallTransitionConflictError();
      }
      const mutation = await client.query(
        `INSERT INTO "ql3"."plugin_package_install_mutations" (
           installation_id, mutation_id, mutation_digest,
           resulting_record_digest, occurred_at_ms
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          record.installationId,
          record.lastMutationId,
          record.lastMutationDigest,
          record.recordDigest,
          record.updatedAtMs,
        ],
      );
      if (mutation.rowCount !== 1) throw unavailable();
      return Object.freeze({
        status: 'committed' as const,
        record,
      });
    });
  }

  recordExisting(
    recordValue: Readonly<PluginPackageInstallRecord>,
    provenanceValue: Readonly<PluginPackagePublisherProvenance>,
    trustAuthorityId: string,
  ): Promise<Readonly<{ status: 'created' | 'existing' }>> {
    const record = normalizePluginPackageInstallRecord(recordValue);
    const provenance =
      normalizePluginPackagePublisherProvenance(provenanceValue);
    if (!['staged', 'activating', 'active'].includes(record.state)) {
      throw new InvalidPluginPackagePublisherProvenanceError(
        'only a verified durable stage can be backfilled',
      );
    }
    assertProvenanceMatchesRecord(provenance, record);
    return this.#transaction(async (client) => {
      await signerLock(client, provenance.publisher, provenance.keyId);
      const current = await currentInstall(client, record.installationId, true);
      if (!current || !same(current, record)) {
        throw new PluginPackagePublisherProvenanceConflictError(
          'install changed during publisher provenance backfill',
        );
      }
      const existing = await storedProvenance(client, record.installationId);
      if (existing) {
        if (!same(existing, provenance)) {
          throw new PluginPackagePublisherProvenanceConflictError(
            'publisher provenance already exists with different evidence',
          );
        }
        return Object.freeze({ status: 'existing' as const });
      }
      await assertSignerNotRevoked(client, provenance);
      await assertSignerInEffectiveTrust(
        client,
        trustAuthorityId,
        provenance,
      );
      await insertProvenance(client, provenance);
      return Object.freeze({ status: 'created' as const });
    });
  }

  async listMissingPage(options: {
    readonly limit: number;
    readonly after?: Readonly<PluginPackagePublisherProvenanceRecoveryCursor>;
  }): Promise<Readonly<PluginPackagePublisherProvenanceRecoveryPage>> {
    const value = dataRecord(options, 'provenance recovery page options');
    exactKeys(
      value,
      ['limit'],
      ['after'],
      'provenance recovery page options',
    );
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > POSTGRES_PLUGIN_PACKAGE_PROVENANCE_RECOVERY_PAGE_LIMIT
    ) {
      throw new InvalidPluginPackagePublisherProvenanceError(
        'provenance recovery page limit is invalid',
      );
    }
    const after = options.after;
    if (
      after !== undefined &&
      (!after ||
        typeof after !== 'object' ||
        typeof after.packageName !== 'string' ||
        !PACKAGE_NAME_PATTERN.test(after.packageName) ||
        typeof after.installationId !== 'string' ||
        !IDENTIFIER_PATTERN.test(after.installationId))
    ) {
      throw new InvalidPluginPackagePublisherProvenanceError(
        'provenance recovery cursor is invalid',
      );
    }
    try {
      const result = await this.pool.query<Row>(
        `SELECT install.record_json AS "recordJson"
         FROM "ql3"."plugin_package_install_heads" AS head
         JOIN "ql3"."plugin_package_installs" AS install
           ON install.installation_id = head.installation_id
         LEFT JOIN "ql3"."plugin_package_publisher_provenance" AS provenance
           ON provenance.installation_id = install.installation_id
         WHERE install.state IN ('staged', 'activating', 'active')
           AND provenance.installation_id IS NULL
           AND (
             $1::varchar IS NULL OR
             (install.package_name, install.installation_id) > ($1, $2)
           )
         ORDER BY install.package_name, install.installation_id
         LIMIT $3`,
        [
          after?.packageName ?? null,
          after?.installationId ?? null,
          options.limit + 1,
        ],
      );
      const truncated = result.rows.length > options.limit;
      const records = Object.freeze(
        result.rows.slice(0, options.limit).map(parseInstall),
      );
      const last = records.at(-1);
      return Object.freeze({
        records,
        truncated,
        ...(truncated && last
          ? {
              next: Object.freeze({
                packageName: last.packageName,
                installationId: last.installationId,
              }),
            }
          : {}),
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async assertInstallationNotRevoked(
    installationId: string,
  ): Promise<void> {
    if (
      typeof installationId !== 'string' ||
      !IDENTIFIER_PATTERN.test(installationId)
    ) {
      throw new InvalidPluginPackagePublisherProvenanceError(
        'installationId is invalid',
      );
    }
    try {
      const provenance = await storedProvenance(this.pool, installationId);
      if (!provenance) {
        throw new PluginPackagePublisherProvenanceConflictError(
          'publisher provenance is missing',
        );
      }
      const result = await this.pool.query(
        `SELECT 1
         FROM "ql3"."plugin_package_publisher_revocation_receipts"
         WHERE publisher = $1 AND key_id = $2
         LIMIT 1`,
        [provenance.publisher, provenance.keyId],
      );
      if (result.rows.length !== 0) {
        throw new PluginPackagePublisherProvenanceConflictError(
          'publisher key is durably revoked',
        );
      }
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async listPendingQuarantineTargets(
    impactDigest: string,
    limit: number,
  ): Promise<
    Readonly<{
      targets: readonly Readonly<PluginPackageQuarantineTarget>[];
      truncated: boolean;
    }>
  > {
    if (
      typeof impactDigest !== 'string' ||
      !DIGEST_PATTERN.test(impactDigest) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 128
    ) {
      throw new InvalidPluginPackagePublisherProvenanceError(
        'pending quarantine target query is invalid',
      );
    }
    try {
      const result = await this.pool.query<Row>(
        `SELECT install.record_json AS "recordJson"
         FROM
           "ql3"."plugin_package_publisher_revocation_impact_items" AS item
         JOIN "ql3"."plugin_package_publisher_revocation_impacts" AS impact
           ON impact.impact_digest = item.impact_digest
         JOIN "ql3"."plugin_package_install_heads" AS head
           ON head.project_id = item.project_id
          AND head.package_name = item.package_name
          AND head.installation_id = item.installation_id
         JOIN "ql3"."plugin_package_installs" AS install
           ON install.installation_id = item.installation_id
          AND install.lock_digest = item.lock_digest
         LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
           ON quarantine.project_id = item.project_id
          AND quarantine.package_name = item.package_name
          AND quarantine.installation_id = item.installation_id
          AND quarantine.lock_digest = item.lock_digest
         WHERE item.impact_digest = $1
           AND install.state IN ('staged', 'activating', 'active')
           AND quarantine.event_digest IS NULL
         ORDER BY item.project_id, item.package_name, item.installation_id
         LIMIT $2`,
        [impactDigest, limit + 1],
      );
      const truncated = result.rows.length > limit;
      const targets = Object.freeze(
        result.rows.slice(0, limit).map((row) => {
          const record = parseInstall(row);
          return Object.freeze({
            projectId: record.projectId,
            packageName: record.packageName,
            installationId: record.installationId,
            lockDigest: record.lockDigest,
            installState:
              record.state as PluginPackageQuarantineTarget['installState'],
            installVersion: record.version,
            installRecordDigest: record.recordDigest,
            activeLockDigest: record.activeLockDigest,
          });
        }),
      );
      return Object.freeze({ targets, truncated });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  recordRevocationImpact(
    receiptValue: Readonly<PluginPackagePublisherRevocationReceipt>,
    confirmAuthorization: () => void | Promise<void>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      impact: Readonly<PluginPackagePublisherRevocationImpact>;
    }>
  > {
    const receipt =
      normalizePluginPackagePublisherRevocationReceipt(receiptValue);
    if (typeof confirmAuthorization !== 'function') {
      throw new InvalidPluginPackagePublisherProvenanceError(
        'confirmAuthorization is invalid',
      );
    }
    return this.#transaction(async (client) => {
      await signerLock(client, receipt.publisher, receipt.keyId);
      await automationStartSignerLock(
        client,
        receipt.publisher,
        receipt.keyId,
      );
      await confirmAuthorization();
      const existingReceipt = await client.query<Row>(
        `SELECT receipt_json AS "receiptJson"
         FROM "ql3"."plugin_package_publisher_revocation_receipts"
         WHERE receipt_digest = $1 OR
           (publisher = $2 AND key_id = $3) OR mutation_id = $4
         ORDER BY receipt_digest
         LIMIT 2`,
        [
          receipt.receiptDigest,
          receipt.publisher,
          receipt.keyId,
          receipt.mutationId,
        ],
      );
      if (existingReceipt.rows.length > 0) {
        if (
          existingReceipt.rows.length !== 1 ||
          !same(recordJson(existingReceipt.rows[0]!, 'receiptJson'), receipt)
        ) {
          throw new PluginPackagePublisherProvenanceConflictError(
            'publisher revocation identity was reused',
          );
        }
        const impact = await storedImpactByReceipt(
          client,
          receipt.receiptDigest,
        );
        if (!impact) throw unavailable();
        return Object.freeze({
          status: 'existing' as const,
          impact,
        });
      }
      const authority = await client.query<Row>(
        `SELECT proposal.proposal_json AS "proposalJson",
                proposal.proposal_digest AS "proposalDigest",
                dispatch.dispatch_json AS "dispatchJson",
                dispatch.dispatch_digest AS "dispatchDigest"
         FROM "ql3"."approved_action_dispatches" AS dispatch
         JOIN "ql3"."plugin_package_publisher_revocation_proposals"
           AS proposal
           ON proposal.action_ref = dispatch.action_ref
         WHERE dispatch.dispatch_id = $1
         LIMIT 2`,
        [receipt.mutationId],
      );
      if (authority.rows.length !== 1) {
        throw new PluginPackagePublisherProvenanceConflictError(
          'publisher revocation lacks an approved durable proposal',
        );
      }
      const proposal = parseRevocationProposal(authority.rows[0]!);
      const dispatch = parseRevocationDispatch(authority.rows[0]!);
      let approvedReceipt: Readonly<PluginPackagePublisherRevocationReceipt>;
      try {
        approvedReceipt = resolvePluginPackagePublisherRevocationProposal(
          proposal,
          dispatch,
          receipt.revokedAtMs,
        );
      } catch {
        throw new PluginPackagePublisherProvenanceConflictError(
          'publisher revocation proposal binding is invalid',
        );
      }
      if (!same(approvedReceipt, receipt)) {
        throw new PluginPackagePublisherProvenanceConflictError(
          'publisher revocation receipt differs from approved authority',
        );
      }
      const trust = await client.query<Row>(
        `SELECT head.head_json AS "headJson",
                head.head_digest AS "headDigest",
                snapshot.snapshot_json AS "snapshotJson",
                snapshot.snapshot_digest AS "snapshotDigest"
         FROM "ql3"."plugin_package_publisher_trust_heads" AS head
         JOIN "ql3"."plugin_package_publisher_trust_snapshots" AS snapshot
           ON snapshot.snapshot_digest = head.effective_trust_digest
         WHERE head.authority_id = $1
         LIMIT 2
         FOR UPDATE OF head`,
        [proposal.actionInput.trustAuthorityId],
      );
      if (trust.rows.length !== 1) {
        throw new PluginPackagePublisherProvenanceConflictError(
          'publisher trust authority does not exist',
        );
      }
      const head = parseTrustHead(trust.rows[0]!);
      const effectiveSnapshot = parseTrustSnapshot(trust.rows[0]!);
      if (
        head.generation !== proposal.actionInput.trustGeneration ||
        head.effectiveTrustDigest !==
          proposal.actionInput.previousTrustDigest ||
        effectiveSnapshot.snapshotDigest !==
          head.effectiveTrustDigest ||
        pluginPackagePublisherTrustRevokedDigest(
          effectiveSnapshot,
          receipt.publisher,
          receipt.keyId,
        ) !== receipt.currentTrustDigest
      ) {
        throw new PluginPackagePublisherProvenanceConflictError(
          'publisher trust generation is stale',
        );
      }
      const nextSnapshot =
        createPluginPackagePublisherEffectiveTrustSnapshot(
          effectiveSnapshot,
          [{ publisher: receipt.publisher, keyId: receipt.keyId }],
        );
      const nextHead = advancePluginPackagePublisherTrustHead(
        head,
        nextSnapshot,
        receipt.revokedAtMs,
      );
      const snapshotInsert = await client.query(
        `INSERT INTO "ql3"."plugin_package_publisher_trust_snapshots" (
           snapshot_digest, key_count, observed_by, observed_at_ms,
           snapshot_json
         ) VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (snapshot_digest) DO NOTHING`,
        [
          nextSnapshot.snapshotDigest,
          nextSnapshot.keys.length,
          'cluster-package-executor',
          receipt.revokedAtMs,
          JSON.stringify(nextSnapshot),
        ],
      );
      if (
        snapshotInsert.rowCount !== 0 &&
        snapshotInsert.rowCount !== 1
      ) {
        throw unavailable();
      }
      const headUpdate = await client.query(
        `UPDATE "ql3"."plugin_package_publisher_trust_heads"
         SET generation = $2, effective_trust_digest = $3,
             updated_at_ms = $4, head_digest = $5, head_json = $6::jsonb
         WHERE authority_id = $1 AND generation = $7
           AND effective_trust_digest = $8 AND head_digest = $9`,
        [
          nextHead.authorityId,
          nextHead.generation,
          nextHead.effectiveTrustDigest,
          nextHead.updatedAtMs,
          nextHead.headDigest,
          JSON.stringify(nextHead),
          head.generation,
          head.effectiveTrustDigest,
          head.headDigest,
        ],
      );
      if (headUpdate.rowCount !== 1) {
        throw new PluginPackagePublisherProvenanceConflictError(
          'publisher trust generation changed concurrently',
        );
      }
      const affected = await client.query<Row>(
        `SELECT
           provenance.project_id AS "projectId",
           provenance.package_name AS "packageName",
           provenance.installation_id AS "installationId",
           provenance.lock_digest AS "lockDigest",
           provenance.provenance_digest AS "provenanceDigest"
         FROM "ql3"."plugin_package_publisher_provenance" AS provenance
         JOIN "ql3"."plugin_package_install_heads" AS head
           ON head.project_id = provenance.project_id
          AND head.package_name = provenance.package_name
          AND head.installation_id = provenance.installation_id
         JOIN "ql3"."plugin_package_installs" AS install
           ON install.installation_id = provenance.installation_id
         WHERE provenance.publisher = $1 AND provenance.key_id = $2
           AND install.state IN ('staged', 'activating', 'active')
         ORDER BY provenance.project_id, provenance.package_name,
                  provenance.installation_id, provenance.lock_digest
         LIMIT $3`,
        [
          receipt.publisher,
          receipt.keyId,
          MAX_PLUGIN_PACKAGE_PUBLISHER_REVOCATION_IMPACT_ITEMS + 1,
        ],
      );
      if (
        affected.rows.length >
        MAX_PLUGIN_PACKAGE_PUBLISHER_REVOCATION_IMPACT_ITEMS
      ) {
        throw new PluginPackagePublisherProvenanceConflictError(
          'publisher revocation impact exceeds the bounded Cluster limit',
        );
      }
      const now = await client.query<{ nowMs: unknown }>(
        `SELECT floor(
           extract(epoch FROM clock_timestamp()) * 1000
         )::bigint AS "nowMs"`,
      );
      if (now.rows.length !== 1) throw unavailable();
      const impact = createPluginPackagePublisherRevocationImpact({
        revocationReceiptDigest: receipt.receiptDigest,
        items: affected.rows.map((row) => ({
          projectId: text(row, 'projectId'),
          packageName: text(row, 'packageName'),
          installationId: text(row, 'installationId'),
          lockDigest: text(row, 'lockDigest'),
          provenanceDigest: text(row, 'provenanceDigest'),
        })),
        generatedAtMs: postgresRequiredInteger(now.rows[0]?.nowMs, unavailable),
      });
      const receiptInsert = await client.query(
        `INSERT INTO "ql3"."plugin_package_publisher_revocation_receipts" (
           receipt_digest, mutation_id, publisher, key_id,
           previous_trust_digest, current_trust_digest,
           proposer_type, proposer_id, confirmer_type, confirmer_id,
           authorization_mode, reason_code, revoked_at_ms, receipt_json
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14::jsonb
         )`,
        [
          receipt.receiptDigest,
          receipt.mutationId,
          receipt.publisher,
          receipt.keyId,
          receipt.previousTrustDigest,
          receipt.currentTrustDigest,
          receipt.proposer.type,
          receipt.proposer.id,
          receipt.confirmer.type,
          receipt.confirmer.id,
          receipt.authorizationMode,
          receipt.reasonCode,
          receipt.revokedAtMs,
          JSON.stringify(receipt),
        ],
      );
      if (receiptInsert.rowCount !== 1) throw unavailable();
      const impactInsert = await client.query(
        `INSERT INTO "ql3"."plugin_package_publisher_revocation_impacts" (
           revocation_receipt_digest, impact_digest, item_count,
           generated_at_ms, impact_json
         ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          impact.revocationReceiptDigest,
          impact.impactDigest,
          impact.items.length,
          impact.generatedAtMs,
          JSON.stringify(impact),
        ],
      );
      if (impactInsert.rowCount !== 1) throw unavailable();
      for (const item of impact.items) {
        const itemInsert = await client.query(
          `INSERT INTO
             "ql3"."plugin_package_publisher_revocation_impact_items" (
               impact_digest, provenance_digest, project_id, package_name,
               installation_id, lock_digest
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            impact.impactDigest,
            item.provenanceDigest,
            item.projectId,
            item.packageName,
            item.installationId,
            item.lockDigest,
          ],
        );
        if (itemInsert.rowCount !== 1) throw unavailable();
      }
      return Object.freeze({
        status: 'created' as const,
        impact,
      });
    });
  }
}
