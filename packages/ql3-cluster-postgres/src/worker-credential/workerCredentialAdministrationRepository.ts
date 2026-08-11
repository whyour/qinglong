// PostgreSQL Worker Credential administration persistence is owned by this domain.
import {
  WorkerCredentialMutationConflictError,
  WorkerCredentialUnavailableError,
  WorkerCredentialVersionConflictError,
  normalizeAppendWorkerCredentialCommand,
  normalizeWorkerCredentialMutationId,
  normalizeWorkerCredentialRecord,
  type AppendWorkerCredentialCommand,
  type AppendWorkerCredentialResult,
  type ResolvedWorkerCredentialMutation,
  type WorkerCredentialAdministrationRepository,
  type WorkerCredentialMutationRecord,
  type WorkerCredentialRecord,
} from '@qinglong/runtime-core/worker-credential';
import {
  WorkerCredentialDeliveryConflictError,
  WorkerCredentialDeliveryUnavailableError,
  MAX_WORKER_CREDENTIAL_STAGE_DISCARD_PAGE_SIZE,
  normalizeCommitWorkerCredentialDeliveryCommand,
  normalizeMarkWorkerCredentialStageDiscardedCommand,
  normalizePublishWorkerCredentialDeliveryCommand,
  normalizeRevokePreviousWorkerCredentialDeliveryCommand,
  normalizeWorkerCredentialDeliveryIntent,
  normalizeWorkerCredentialDeliveryRecoveryPage,
  normalizeWorkerCredentialDeliveryRecord,
  normalizeWorkerCredentialStageDiscardRecord,
  normalizeWorkerCredentialStageDiscardRecoveryPage,
  MAX_WORKER_CREDENTIAL_DELIVERY_RECOVERY_PAGE_SIZE,
  type CommitWorkerCredentialDeliveryCommand,
  type MarkWorkerCredentialStageDiscardedCommand,
  type PublishWorkerCredentialDeliveryCommand,
  type RevokePreviousWorkerCredentialDeliveryCommand,
  type ResolvedWorkerCredentialDelivery,
  type WorkerCredentialDeliveryAdministrationRepository,
  type WorkerCredentialDeliveryIntent,
  type WorkerCredentialDeliveryRecoveryPage,
  type WorkerCredentialDeliveryRecord,
  type WorkerCredentialStageDiscardRecord,
  type WorkerCredentialStageDiscardRecoveryPage,
} from '@qinglong/runtime-core/worker-credential-delivery';
import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  ADMINISTRATION_AUDIT_SELECT,
  auditFromRow,
  configureAdministrationTransaction,
  insertAdministrationAudit,
  requiredInteger,
  requiredString,
  retryableAdministrationError,
  rollbackAdministrationTransaction,
  sameAdministrationReplayAudit,
  type AdministrationAuditRow,
} from '../repository/administrationSupport';

interface Row extends AdministrationAuditRow {
  mutationId: unknown;
  operation: unknown;
  credentialId: unknown;
  credentialVersion: unknown;
  expectedPreviousVersion: unknown;
  workerId: unknown;
  state: unknown;
  secretDigest: unknown;
  notBeforeAtMs: unknown;
  expiresAtMs: unknown;
  changedByType: unknown;
  changedById: unknown;
  createdAtMs: unknown;
}

interface DeliveryRow extends Record<string, unknown> {
  deliveryId: unknown;
  version: unknown;
  state: unknown;
  workerId: unknown;
  credentialId: unknown;
  credentialVersion: unknown;
  previousCredentialId: unknown;
  secretDigest: unknown;
  tokenDigest: unknown;
  deploymentTargetDigest: unknown;
  deploymentGeneration: unknown;
  stagedAtMs: unknown;
  credentialCommittedAtMs: unknown;
  publishedAtMs: unknown;
  publicationDigest: unknown;
  observedAtMs: unknown;
  observedSessionId: unknown;
  observedSessionVersion: unknown;
  previousRevokedAtMs: unknown;
}

interface RecoveryRow extends DeliveryRow {
  observedAtMs: unknown;
}

interface StageDiscardRow extends Record<string, unknown> {
  deliveryId: unknown;
  version: unknown;
  state: unknown;
  workerId: unknown;
  credentialId: unknown;
  credentialVersion: unknown;
  previousCredentialId: unknown;
  secretDigest: unknown;
  tokenDigest: unknown;
  deploymentTargetDigest: unknown;
  deploymentGeneration: unknown;
  stagedAtMs: unknown;
  authorizedAtMs: unknown;
  discardedAtMs: unknown;
}

interface StageDiscardRecoveryRow extends StageDiscardRow {
  observedAtMs: unknown;
}

const MUTATION_SELECT = `
  SELECT mutation.mutation_id AS "mutationId", mutation.operation,
         mutation.credential_id AS "credentialId",
         mutation.credential_version AS "credentialVersion",
         mutation.expected_previous_version AS "expectedPreviousVersion",
         mutation.changed_by_type AS "changedByType",
         mutation.changed_by_id AS "changedById",
         mutation.created_at_ms AS "createdAtMs",
         credential.state, credential.worker_id AS "workerId",
         credential.secret_digest AS "secretDigest",
         credential.not_before_at_ms AS "notBeforeAtMs",
         credential.expires_at_ms AS "expiresAtMs",
         ${ADMINISTRATION_AUDIT_SELECT}
  FROM "ql3"."worker_credential_mutations" AS mutation
  JOIN "ql3"."worker_credentials" AS credential
    ON credential.credential_id = mutation.credential_id
   AND credential.version = mutation.credential_version
  JOIN "ql3"."security_audit_events" AS audit
    ON audit.event_id = mutation.audit_event_id
  WHERE mutation.mutation_id = $1
  LIMIT 2
`.trim();

const DELIVERY_SELECT = `
  SELECT delivery_id AS "deliveryId", version, state,
         worker_id AS "workerId", credential_id AS "credentialId",
         credential_version AS "credentialVersion",
         previous_credential_id AS "previousCredentialId",
         secret_digest AS "secretDigest", token_digest AS "tokenDigest",
         deployment_target_digest AS "deploymentTargetDigest",
         deployment_generation AS "deploymentGeneration",
         staged_at_ms AS "stagedAtMs",
         credential_committed_at_ms AS "credentialCommittedAtMs",
         published_at_ms AS "publishedAtMs",
         publication_digest AS "publicationDigest",
         observed_at_ms AS "observedAtMs",
         observed_session_id AS "observedSessionId",
         observed_session_version AS "observedSessionVersion",
         previous_revoked_at_ms AS "previousRevokedAtMs"
  FROM "ql3"."worker_credential_deliveries"
  WHERE delivery_id = $1
  ORDER BY version ASC
  LIMIT 5
`.trim();

const STAGE_DISCARD_SELECT = `
  SELECT delivery_id AS "deliveryId", version, state,
         worker_id AS "workerId", credential_id AS "credentialId",
         credential_version AS "credentialVersion",
         previous_credential_id AS "previousCredentialId",
         secret_digest AS "secretDigest", token_digest AS "tokenDigest",
         deployment_target_digest AS "deploymentTargetDigest",
         deployment_generation AS "deploymentGeneration",
         staged_at_ms AS "stagedAtMs", authorized_at_ms AS "authorizedAtMs",
         discarded_at_ms AS "discardedAtMs"
  FROM "ql3"."worker_credential_stage_discards"
  WHERE delivery_id = $1
  ORDER BY version ASC
  LIMIT 3
`.trim();

function nullableString(row: Record<string, unknown>, key: string): string | null {
  return row[key] === null ? null : requiredString(row, key);
}

function nullableInteger(row: Record<string, unknown>, key: string): number | null {
  return row[key] === null ? null : requiredInteger(row, key);
}

function deliveryFromRow(row: DeliveryRow): Readonly<WorkerCredentialDeliveryRecord> {
  return normalizeWorkerCredentialDeliveryRecord({
    deliveryId: requiredString(row, 'deliveryId'),
    version: requiredInteger(row, 'version'),
    state: requiredString(row, 'state') as WorkerCredentialDeliveryRecord['state'],
    workerId: requiredString(row, 'workerId'),
    credentialId: requiredString(row, 'credentialId'),
    credentialVersion: requiredInteger(row, 'credentialVersion'),
    previousCredentialId: nullableString(row, 'previousCredentialId'),
    secretDigest: requiredString(row, 'secretDigest'),
    tokenDigest: requiredString(row, 'tokenDigest'),
    deploymentTargetDigest: requiredString(row, 'deploymentTargetDigest'),
    deploymentGeneration: requiredString(row, 'deploymentGeneration'),
    stagedAtMs: requiredInteger(row, 'stagedAtMs'),
    credentialCommittedAtMs: requiredInteger(row, 'credentialCommittedAtMs'),
    publishedAtMs: nullableInteger(row, 'publishedAtMs'),
    publicationDigest: nullableString(row, 'publicationDigest'),
    observedAtMs: nullableInteger(row, 'observedAtMs'),
    observedSessionId: nullableString(row, 'observedSessionId'),
    observedSessionVersion: nullableInteger(row, 'observedSessionVersion'),
    previousRevokedAtMs: nullableInteger(row, 'previousRevokedAtMs'),
  });
}

function stageDiscardFromRow(
  row: StageDiscardRow,
): Readonly<WorkerCredentialStageDiscardRecord> {
  return normalizeWorkerCredentialStageDiscardRecord({
    deliveryId: requiredString(row, 'deliveryId'),
    version: requiredInteger(row, 'version'),
    state: requiredString(row, 'state') as WorkerCredentialStageDiscardRecord['state'],
    workerId: requiredString(row, 'workerId'),
    credentialId: requiredString(row, 'credentialId'),
    credentialVersion: requiredInteger(row, 'credentialVersion'),
    previousCredentialId: nullableString(row, 'previousCredentialId'),
    secretDigest: requiredString(row, 'secretDigest'),
    tokenDigest: requiredString(row, 'tokenDigest'),
    deploymentTargetDigest: requiredString(row, 'deploymentTargetDigest'),
    deploymentGeneration: requiredString(row, 'deploymentGeneration'),
    stagedAtMs: requiredInteger(row, 'stagedAtMs'),
    authorizedAtMs: requiredInteger(row, 'authorizedAtMs'),
    discardedAtMs: nullableInteger(row, 'discardedAtMs'),
  });
}

function sameStageDiscardIntent(
  existing: Readonly<WorkerCredentialStageDiscardRecord>,
  intent: Readonly<WorkerCredentialDeliveryIntent>,
): boolean {
  return (
    existing.deliveryId === intent.deliveryId &&
    existing.workerId === intent.workerId &&
    existing.credentialId === intent.credentialId &&
    existing.credentialVersion === intent.credentialVersion &&
    existing.previousCredentialId === intent.previousCredentialId &&
    existing.secretDigest === intent.secretDigest &&
    existing.tokenDigest === intent.tokenDigest &&
    existing.deploymentTargetDigest === intent.deploymentTargetDigest &&
    existing.deploymentGeneration === intent.deploymentGeneration &&
    existing.stagedAtMs === intent.stagedAtMs
  );
}

async function resolveStageDiscard(
  queryable: Pick<PostgresClient | PostgresPool, 'query'>,
  deliveryId: string,
): Promise<Readonly<WorkerCredentialStageDiscardRecord> | null> {
  const result = await queryable.query<StageDiscardRow>(
    STAGE_DISCARD_SELECT,
    [deliveryId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length > 2) {
    throw new WorkerCredentialDeliveryConflictError();
  }
  const records = result.rows.map(stageDiscardFromRow);
  for (let index = 0; index < records.length; index += 1) {
    const current = records[index]!;
    if (
      current.version !== index + 1 ||
      (index > 0 &&
        (!sameStageDiscardIntent(current, records[index - 1]!) ||
          current.authorizedAtMs !== records[index - 1]!.authorizedAtMs))
    ) {
      throw new WorkerCredentialDeliveryConflictError();
    }
  }
  return records.at(-1)!;
}

async function insertStageDiscard(
  client: PostgresClient,
  record: Readonly<WorkerCredentialStageDiscardRecord>,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3"."worker_credential_stage_discards" (
       delivery_id, version, state, worker_id, credential_id,
       credential_version, previous_credential_id, secret_digest,
       token_digest, deployment_target_digest, deployment_generation,
       staged_at_ms, authorized_at_ms, discarded_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13, $14
     )`,
    [
      record.deliveryId, record.version, record.state, record.workerId,
      record.credentialId, record.credentialVersion,
      record.previousCredentialId, record.secretDigest, record.tokenDigest,
      record.deploymentTargetDigest, record.deploymentGeneration,
      record.stagedAtMs, record.authorizedAtMs, record.discardedAtMs,
    ],
  );
}

async function resolveDelivery(
  queryable: Pick<PostgresClient | PostgresPool, 'query'>,
  deliveryId: string,
): Promise<Readonly<WorkerCredentialDeliveryRecord> | null> {
  const result = await queryable.query<DeliveryRow>(DELIVERY_SELECT, [deliveryId]);
  if (result.rows.length === 0) return null;
  if (result.rows.length > 4) {
    throw new WorkerCredentialDeliveryConflictError();
  }
  const records = result.rows.map(deliveryFromRow);
  for (let index = 0; index < records.length; index += 1) {
    const current = records[index]!;
    if (current.version !== index + 1) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    const previous = records[index - 1];
    if (!previous) continue;
    if (!sameCommittedDelivery(current, previous)) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    if (
      current.version >= 3 &&
      (current.publishedAtMs !== previous.publishedAtMs ||
        current.publicationDigest !== previous.publicationDigest)
    ) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    if (
      current.version >= 4 &&
      (current.observedAtMs !== previous.observedAtMs ||
        current.observedSessionId !== previous.observedSessionId ||
        current.observedSessionVersion !== previous.observedSessionVersion)
    ) {
      throw new WorkerCredentialDeliveryConflictError();
    }
  }
  return records.at(-1)!;
}

function sameCommittedDelivery(
  existing: Readonly<WorkerCredentialDeliveryRecord>,
  requested: Readonly<WorkerCredentialDeliveryRecord>,
): boolean {
  return (
    existing.deliveryId === requested.deliveryId &&
    existing.workerId === requested.workerId &&
    existing.credentialId === requested.credentialId &&
    existing.credentialVersion === requested.credentialVersion &&
    existing.previousCredentialId === requested.previousCredentialId &&
    existing.secretDigest === requested.secretDigest &&
    existing.tokenDigest === requested.tokenDigest &&
    existing.deploymentTargetDigest === requested.deploymentTargetDigest &&
    existing.deploymentGeneration === requested.deploymentGeneration &&
    existing.stagedAtMs === requested.stagedAtMs &&
    existing.credentialCommittedAtMs === requested.credentialCommittedAtMs
  );
}

async function insertDelivery(
  client: PostgresClient,
  delivery: Readonly<WorkerCredentialDeliveryRecord>,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3"."worker_credential_deliveries" (
       delivery_id, version, state, worker_id, credential_id,
       credential_version, previous_credential_id, secret_digest,
       token_digest, deployment_target_digest, deployment_generation,
       staged_at_ms, credential_committed_at_ms, published_at_ms,
       publication_digest, observed_at_ms, observed_session_id,
       observed_session_version, previous_revoked_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19
     )`,
    [
      delivery.deliveryId, delivery.version, delivery.state,
      delivery.workerId, delivery.credentialId, delivery.credentialVersion,
      delivery.previousCredentialId, delivery.secretDigest,
      delivery.tokenDigest, delivery.deploymentTargetDigest,
      delivery.deploymentGeneration, delivery.stagedAtMs,
      delivery.credentialCommittedAtMs, delivery.publishedAtMs,
      delivery.publicationDigest, delivery.observedAtMs,
      delivery.observedSessionId, delivery.observedSessionVersion,
      delivery.previousRevokedAtMs,
    ],
  );
}

function resolved(row: Row): ResolvedWorkerCredentialMutation {
  const mutation: WorkerCredentialMutationRecord = {
    mutationId: requiredString(row, 'mutationId'),
    operation: requiredString(row, 'operation') as WorkerCredentialMutationRecord['operation'],
    credentialId: requiredString(row, 'credentialId'),
    credentialVersion: requiredInteger(row, 'credentialVersion'),
    expectedPreviousVersion: requiredInteger(row, 'expectedPreviousVersion'),
    changedBy: {
      type: requiredString(row, 'changedByType') as WorkerCredentialMutationRecord['changedBy']['type'],
      id: requiredString(row, 'changedById'),
    },
    createdAtMs: requiredInteger(row, 'createdAtMs'),
  };
  const credential = normalizeWorkerCredentialRecord({
    credentialId: mutation.credentialId,
    version: mutation.credentialVersion,
    state: requiredString(row, 'state') as WorkerCredentialRecord['state'],
    workerId: requiredString(row, 'workerId'),
    secretDigest: requiredString(row, 'secretDigest'),
    createdAtMs: mutation.createdAtMs,
    notBeforeAtMs: requiredInteger(row, 'notBeforeAtMs'),
    expiresAtMs: requiredInteger(row, 'expiresAtMs'),
  });
  return Object.freeze({ credential, mutation: Object.freeze(mutation), audit: auditFromRow(row) });
}

function semanticReplay(
  existing: ResolvedWorkerCredentialMutation,
  command: Readonly<AppendWorkerCredentialCommand>,
): boolean {
  const { secretDigest: _existingDigest, createdAtMs: _existingCreated, ...existingCredential } = existing.credential;
  const { secretDigest: _commandDigest, createdAtMs: _commandCreated, ...commandCredential } = command.credential;
  const { createdAtMs: _existingMutationCreated, ...existingMutation } = existing.mutation;
  const { createdAtMs: _commandMutationCreated, ...commandMutation } = command.mutation;
  return (
    JSON.stringify(existingCredential) === JSON.stringify(commandCredential) &&
    JSON.stringify(existingMutation) === JSON.stringify(commandMutation) &&
    sameAdministrationReplayAudit(existing.audit, command.audit)
  );
}

async function resolveMutation(
  queryable: Pick<PostgresClient | PostgresPool, 'query'>,
  mutationId: string,
): Promise<ResolvedWorkerCredentialMutation | null> {
  const result = await queryable.query<Row>(MUTATION_SELECT, [mutationId]);
  if (result.rows.length > 1) throw new WorkerCredentialUnavailableError();
  return result.rows[0] ? resolved(result.rows[0]) : null;
}

export class PostgresWorkerCredentialAdministrationRepository
  implements
    WorkerCredentialAdministrationRepository,
    WorkerCredentialDeliveryAdministrationRepository
{
  constructor(private readonly pool: PostgresPool) {}

  async resolveMutation(
    requestedMutationId: string,
  ): Promise<ResolvedWorkerCredentialMutation | null> {
    const mutationId = normalizeWorkerCredentialMutationId(requestedMutationId);
    try {
      return await resolveMutation(this.pool, mutationId);
    } catch (error) {
      if (error instanceof WorkerCredentialMutationConflictError) throw error;
      throw new WorkerCredentialUnavailableError();
    }
  }

  async resolveDelivery(
    requestedDeliveryId: string,
  ): Promise<Readonly<WorkerCredentialDeliveryRecord> | null> {
    const deliveryId = normalizeWorkerCredentialMutationId(requestedDeliveryId);
    try {
      return await resolveDelivery(this.pool, deliveryId);
    } catch (error) {
      if (error instanceof WorkerCredentialDeliveryConflictError) throw error;
      throw new WorkerCredentialDeliveryUnavailableError();
    }
  }

  async resolveDelivered(
    requestedDeliveryId: string,
  ): Promise<ResolvedWorkerCredentialDelivery | null> {
    const deliveryId = normalizeWorkerCredentialMutationId(requestedDeliveryId);
    try {
      const mutation = await resolveMutation(this.pool, deliveryId);
      const delivery = await resolveDelivery(this.pool, deliveryId);
      if (!delivery) return null;
      if (
        !mutation ||
        delivery.deliveryId !== mutation.mutation.mutationId ||
        delivery.credentialId !== mutation.credential.credentialId ||
        delivery.credentialVersion !== mutation.credential.version ||
        delivery.workerId !== mutation.credential.workerId ||
        delivery.secretDigest !== mutation.credential.secretDigest
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      return Object.freeze({ ...mutation, delivery });
    } catch (error) {
      if (error instanceof WorkerCredentialDeliveryConflictError) throw error;
      throw new WorkerCredentialDeliveryUnavailableError();
    }
  }

  async resolveStageDiscard(
    requestedDeliveryId: string,
  ): Promise<Readonly<WorkerCredentialStageDiscardRecord> | null> {
    const deliveryId = normalizeWorkerCredentialMutationId(requestedDeliveryId);
    try {
      return await resolveStageDiscard(this.pool, deliveryId);
    } catch (error) {
      if (error instanceof WorkerCredentialDeliveryConflictError) throw error;
      throw new WorkerCredentialDeliveryUnavailableError();
    }
  }

  async authorizeStageDiscard(
    input: WorkerCredentialDeliveryIntent,
  ): Promise<Readonly<WorkerCredentialStageDiscardRecord>> {
    const intent = normalizeWorkerCredentialDeliveryIntent(input);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client = await this.pool.connect();
      let began = false;
      try {
        await configureAdministrationTransaction(client);
        began = true;
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`ql3-worker-credential-delivery:${intent.deliveryId}`],
        );
        const existing = await resolveStageDiscard(client, intent.deliveryId);
        if (existing) {
          if (!sameStageDiscardIntent(existing, intent)) {
            throw new WorkerCredentialDeliveryConflictError();
          }
          await client.query('COMMIT');
          began = false;
          return existing;
        }
        const authority = await client.query<Record<string, unknown>>(
          `SELECT
             floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
               AS "authorizedAtMs",
             EXISTS (
               SELECT 1 FROM "ql3"."worker_credential_mutations"
               WHERE mutation_id = $1
             ) AS "mutationExists",
             EXISTS (
               SELECT 1 FROM "ql3"."worker_credential_deliveries"
               WHERE delivery_id = $1
             ) AS "deliveryExists"`,
          [intent.deliveryId],
        );
        const row = authority.rows[0];
        if (
          authority.rows.length !== 1 ||
          !row ||
          typeof row.mutationExists !== 'boolean' ||
          typeof row.deliveryExists !== 'boolean'
        ) {
          throw new WorkerCredentialDeliveryConflictError();
        }
        if (row.mutationExists || row.deliveryExists) {
          throw new WorkerCredentialDeliveryConflictError();
        }
        const record = normalizeWorkerCredentialStageDiscardRecord({
          ...intent,
          version: 1,
          state: 'discard_authorized',
          authorizedAtMs: requiredInteger(row, 'authorizedAtMs'),
          discardedAtMs: null,
        });
        await insertStageDiscard(client, record);
        await client.query('COMMIT');
        began = false;
        return record;
      } catch (error) {
        if (began) await rollbackAdministrationTransaction(client);
        if (
          error instanceof WorkerCredentialDeliveryConflictError ||
          error instanceof WorkerCredentialDeliveryUnavailableError
        ) throw error;
        if (attempt < 2 && retryableAdministrationError(error)) continue;
        throw new WorkerCredentialDeliveryUnavailableError();
      } finally {
        client.release();
      }
    }
    throw new WorkerCredentialDeliveryUnavailableError();
  }

  async markStageDiscarded(
    input: MarkWorkerCredentialStageDiscardedCommand,
  ): Promise<Readonly<WorkerCredentialStageDiscardRecord>> {
    const command = normalizeMarkWorkerCredentialStageDiscardedCommand(input);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client = await this.pool.connect();
      let began = false;
      try {
        await configureAdministrationTransaction(client);
        began = true;
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`ql3-worker-credential-delivery:${command.deliveryId}`],
        );
        const existing = await resolveStageDiscard(client, command.deliveryId);
        if (!existing) throw new WorkerCredentialDeliveryConflictError();
        if (existing.state === 'discarded') {
          await client.query('COMMIT');
          began = false;
          return existing;
        }
        if (existing.version !== command.expectedVersion) {
          throw new WorkerCredentialDeliveryConflictError();
        }
        const clock = await client.query<Record<string, unknown>>(
          `SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
             AS "discardedAtMs"`,
        );
        if (clock.rows.length !== 1 || !clock.rows[0]) {
          throw new WorkerCredentialDeliveryConflictError();
        }
        const discarded = normalizeWorkerCredentialStageDiscardRecord({
          ...existing,
          version: 2,
          state: 'discarded',
          discardedAtMs: requiredInteger(clock.rows[0], 'discardedAtMs'),
        });
        await insertStageDiscard(client, discarded);
        await client.query('COMMIT');
        began = false;
        return discarded;
      } catch (error) {
        if (began) await rollbackAdministrationTransaction(client);
        if (
          error instanceof WorkerCredentialDeliveryConflictError ||
          error instanceof WorkerCredentialDeliveryUnavailableError
        ) throw error;
        if (attempt < 2 && retryableAdministrationError(error)) continue;
        throw new WorkerCredentialDeliveryUnavailableError();
      } finally {
        client.release();
      }
    }
    throw new WorkerCredentialDeliveryUnavailableError();
  }

  async listStageDiscardRecoveryPage(
    options: Readonly<{
      afterDeliveryId?: string;
      limit?: number;
    }> = {},
  ): Promise<Readonly<WorkerCredentialStageDiscardRecoveryPage>> {
    const limit = options.limit ?? 16;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_WORKER_CREDENTIAL_STAGE_DISCARD_PAGE_SIZE
    ) {
      throw new RangeError('Worker credential stage discard recovery limit is invalid');
    }
    const afterDeliveryId = options.afterDeliveryId === undefined
      ? null
      : normalizeWorkerCredentialMutationId(options.afterDeliveryId);
    try {
      const result = await this.pool.query<StageDiscardRecoveryRow>(
        `WITH observation AS (
           SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
             AS observed_at_ms
         ), latest AS (
           SELECT DISTINCT ON (delivery_id) *
           FROM "ql3"."worker_credential_stage_discards"
           WHERE ($1::varchar IS NULL OR delivery_id > $1)
           ORDER BY delivery_id ASC, version DESC
         ), recoverable AS (
           SELECT * FROM latest
           WHERE state = 'discard_authorized'
           ORDER BY delivery_id ASC
           LIMIT $2
         )
         SELECT observation.observed_at_ms AS "observedAtMs",
                recoverable.delivery_id AS "deliveryId",
                recoverable.version, recoverable.state,
                recoverable.worker_id AS "workerId",
                recoverable.credential_id AS "credentialId",
                recoverable.credential_version AS "credentialVersion",
                recoverable.previous_credential_id AS "previousCredentialId",
                recoverable.secret_digest AS "secretDigest",
                recoverable.token_digest AS "tokenDigest",
                recoverable.deployment_target_digest AS "deploymentTargetDigest",
                recoverable.deployment_generation AS "deploymentGeneration",
                recoverable.staged_at_ms AS "stagedAtMs",
                recoverable.authorized_at_ms AS "authorizedAtMs",
                recoverable.discarded_at_ms AS "discardedAtMs"
         FROM observation LEFT JOIN recoverable ON TRUE
         ORDER BY recoverable.delivery_id ASC`,
        [afterDeliveryId, limit + 1],
      );
      if (result.rows.length < 1 || result.rows.length > limit + 1) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      const observedAtMs = requiredInteger(result.rows[0]!, 'observedAtMs');
      const records = result.rows[0]!.deliveryId === null
        ? []
        : result.rows.map(stageDiscardFromRow);
      const discards = records.slice(0, limit);
      const truncated = records.length > limit;
      return normalizeWorkerCredentialStageDiscardRecoveryPage({
        observedAtMs,
        discards,
        truncated,
        ...(truncated
          ? { nextCursor: discards.at(-1)!.deliveryId }
          : {}),
      });
    } catch (error) {
      if (
        error instanceof RangeError ||
        error instanceof WorkerCredentialDeliveryConflictError
      ) throw error;
      throw new WorkerCredentialDeliveryUnavailableError();
    }
  }

  async listRecoveryPage(
    options: Readonly<{
      afterDeliveryId?: string;
      limit?: number;
    }> = {},
  ): Promise<Readonly<WorkerCredentialDeliveryRecoveryPage>> {
    const limit = options.limit ?? 16;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_WORKER_CREDENTIAL_DELIVERY_RECOVERY_PAGE_SIZE
    ) {
      throw new RangeError('Worker credential delivery recovery limit is invalid');
    }
    const afterDeliveryId = options.afterDeliveryId === undefined
      ? null
      : normalizeWorkerCredentialMutationId(options.afterDeliveryId);
    try {
      const result = await this.pool.query<RecoveryRow>(
        `WITH observation AS (
           SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
             AS observed_at_ms
         ), latest AS (
           SELECT DISTINCT ON (delivery_id) *
           FROM "ql3"."worker_credential_deliveries"
           WHERE ($1::varchar IS NULL OR delivery_id > $1)
           ORDER BY delivery_id ASC, version DESC
         ), recoverable AS (
           SELECT * FROM latest
           WHERE state IN ('credential_committed', 'published')
              OR (state = 'observed' AND previous_credential_id IS NOT NULL)
           ORDER BY delivery_id ASC
           LIMIT $2
         )
         SELECT observation.observed_at_ms AS "observedAtMs",
                recoverable.delivery_id AS "deliveryId",
                recoverable.version, recoverable.state,
                recoverable.worker_id AS "workerId",
                recoverable.credential_id AS "credentialId",
                recoverable.credential_version AS "credentialVersion",
                recoverable.previous_credential_id AS "previousCredentialId",
                recoverable.secret_digest AS "secretDigest",
                recoverable.token_digest AS "tokenDigest",
                recoverable.deployment_target_digest AS "deploymentTargetDigest",
                recoverable.deployment_generation AS "deploymentGeneration",
                recoverable.staged_at_ms AS "stagedAtMs",
                recoverable.credential_committed_at_ms AS "credentialCommittedAtMs",
                recoverable.published_at_ms AS "publishedAtMs",
                recoverable.publication_digest AS "publicationDigest",
                recoverable.observed_at_ms AS "observedAtMsDelivery",
                recoverable.observed_session_id AS "observedSessionId",
                recoverable.observed_session_version AS "observedSessionVersion",
                recoverable.previous_revoked_at_ms AS "previousRevokedAtMs"
         FROM observation LEFT JOIN recoverable ON TRUE
         ORDER BY recoverable.delivery_id ASC`,
        [afterDeliveryId, limit + 1],
      );
      if (result.rows.length < 1 || result.rows.length > limit + 1) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      const observedAtMs = requiredInteger(result.rows[0]!, 'observedAtMs');
      const records = result.rows[0]!.deliveryId === null
        ? []
        : result.rows.map((row) => deliveryFromRow({
            ...row,
            observedAtMs: row.observedAtMsDelivery,
          }));
      const deliveries = records.slice(0, limit);
      const truncated = records.length > limit;
      return normalizeWorkerCredentialDeliveryRecoveryPage({
        observedAtMs,
        deliveries,
        truncated,
        ...(truncated
          ? { nextCursor: deliveries.at(-1)!.deliveryId }
          : {}),
      });
    } catch (error) {
      if (
        error instanceof RangeError ||
        error instanceof WorkerCredentialDeliveryConflictError
      ) throw error;
      throw new WorkerCredentialDeliveryUnavailableError();
    }
  }

  async revokePreviousDelivered(
    input: RevokePreviousWorkerCredentialDeliveryCommand,
  ): Promise<AppendWorkerCredentialResult> {
    const command = normalizeRevokePreviousWorkerCredentialDeliveryCommand(input);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client = await this.pool.connect();
      let began = false;
      try {
        await configureAdministrationTransaction(client);
        began = true;
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`ql3-worker-credential:${command.credential.credential.credentialId}`],
        );
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`ql3-worker-credential-delivery:${command.delivery.deliveryId}`],
        );
        const replay = await resolveMutation(
          client,
          command.credential.mutation.mutationId,
        );
        const existing = await resolveDelivery(client, command.delivery.deliveryId);
        if (!existing) throw new WorkerCredentialDeliveryConflictError();
        if (replay) {
          if (
            !semanticReplay(replay, command.credential) ||
            existing.state !== 'previous_revoked' ||
            !sameCommittedDelivery(existing, command.delivery) ||
            existing.previousRevokedAtMs !== command.delivery.previousRevokedAtMs
          ) {
            throw new WorkerCredentialDeliveryConflictError();
          }
          await client.query('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing',
            credential: replay.credential,
            mutation: replay.mutation,
          });
        }
        if (
          existing.state !== 'observed' ||
          existing.version !== 3 ||
          !sameCommittedDelivery(existing, command.delivery) ||
          existing.publishedAtMs !== command.delivery.publishedAtMs ||
          existing.publicationDigest !== command.delivery.publicationDigest ||
          existing.observedAtMs !== command.delivery.observedAtMs ||
          existing.observedSessionId !== command.delivery.observedSessionId ||
          existing.observedSessionVersion !== command.delivery.observedSessionVersion
        ) {
          throw new WorkerCredentialDeliveryConflictError();
        }
        const current = await client.query<Record<string, unknown>>(
          `SELECT version, state, worker_id AS "workerId"
           FROM "ql3"."worker_credentials"
           WHERE credential_id = $1
           ORDER BY version DESC LIMIT 1 FOR UPDATE`,
          [command.credential.credential.credentialId],
        );
        if (
          current.rows.length !== 1 ||
          requiredInteger(current.rows[0]!, 'version') !== 1 ||
          requiredString(current.rows[0]!, 'state') !== 'active' ||
          requiredString(current.rows[0]!, 'workerId') !== existing.workerId
        ) {
          throw new WorkerCredentialVersionConflictError();
        }
        await insertAdministrationAudit(client, command.credential.audit);
        await client.query(
          `INSERT INTO "ql3"."worker_credentials" (
             credential_id, version, state, worker_id, secret_digest,
             created_at_ms, not_before_at_ms, expires_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            command.credential.credential.credentialId,
            command.credential.credential.version,
            command.credential.credential.state,
            command.credential.credential.workerId,
            command.credential.credential.secretDigest,
            command.credential.credential.createdAtMs,
            command.credential.credential.notBeforeAtMs,
            command.credential.credential.expiresAtMs,
          ],
        );
        await client.query(
          `INSERT INTO "ql3"."worker_credential_mutations" (
             mutation_id, operation, credential_id, credential_version,
             expected_previous_version, changed_by_type, changed_by_id,
             audit_event_id, created_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            command.credential.mutation.mutationId,
            command.credential.mutation.operation,
            command.credential.mutation.credentialId,
            command.credential.mutation.credentialVersion,
            command.credential.mutation.expectedPreviousVersion,
            command.credential.mutation.changedBy.type,
            command.credential.mutation.changedBy.id,
            command.credential.mutation.mutationId,
            command.credential.mutation.createdAtMs,
          ],
        );
        await insertDelivery(client, command.delivery);
        await client.query('COMMIT');
        began = false;
        return Object.freeze({
          status: 'created',
          credential: command.credential.credential,
          mutation: command.credential.mutation,
        });
      } catch (error) {
        if (began) await rollbackAdministrationTransaction(client);
        if (
          error instanceof WorkerCredentialVersionConflictError ||
          error instanceof WorkerCredentialMutationConflictError ||
          error instanceof WorkerCredentialDeliveryConflictError ||
          error instanceof WorkerCredentialDeliveryUnavailableError
        ) throw error;
        if (attempt < 2 && retryableAdministrationError(error)) continue;
        throw new WorkerCredentialDeliveryUnavailableError();
      } finally {
        client.release();
      }
    }
    throw new WorkerCredentialDeliveryUnavailableError();
  }

  private async appendCommand(
    command: Readonly<AppendWorkerCredentialCommand>,
    delivery: Readonly<WorkerCredentialDeliveryRecord> | null,
  ): Promise<AppendWorkerCredentialResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client = await this.pool.connect();
      let began = false;
      try {
        await configureAdministrationTransaction(client);
        began = true;
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`ql3-worker-credential:${command.credential.credentialId}`],
        );
        if (delivery) {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [`ql3-worker-credential-delivery:${delivery.deliveryId}`],
          );
          if (await resolveStageDiscard(client, delivery.deliveryId)) {
            throw new WorkerCredentialDeliveryConflictError();
          }
        }
        const replay = await resolveMutation(client, command.mutation.mutationId);
        const existingDelivery = delivery
          ? await resolveDelivery(client, delivery.deliveryId)
          : null;
        if (replay) {
          if (!semanticReplay(replay, command)) {
            throw new WorkerCredentialMutationConflictError();
          }
          if (
            delivery &&
            (!existingDelivery ||
              !sameCommittedDelivery(existingDelivery, delivery))
          ) {
            throw new WorkerCredentialDeliveryConflictError();
          }
          await client.query('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing',
            credential: replay.credential,
            mutation: replay.mutation,
          });
        }
        if (existingDelivery) {
          throw new WorkerCredentialDeliveryConflictError();
        }
        const current = await client.query<Record<string, unknown>>(
          `SELECT version, worker_id AS "workerId"
           FROM "ql3"."worker_credentials"
           WHERE credential_id = $1 ORDER BY version DESC LIMIT 1`,
          [command.credential.credentialId],
        );
        const currentVersion = current.rows[0]
          ? requiredInteger(current.rows[0], 'version')
          : 0;
        if (currentVersion !== command.expectedCurrentVersion) {
          throw new WorkerCredentialVersionConflictError();
        }
        if (
          current.rows[0] &&
          requiredString(current.rows[0], 'workerId') !== command.credential.workerId
        ) {
          throw new WorkerCredentialMutationConflictError();
        }
        await insertAdministrationAudit(client, command.audit);
        await client.query(
          `INSERT INTO "ql3"."worker_credentials" (
             credential_id, version, state, worker_id, secret_digest,
             created_at_ms, not_before_at_ms, expires_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            command.credential.credentialId, command.credential.version,
            command.credential.state, command.credential.workerId,
            command.credential.secretDigest, command.credential.createdAtMs,
            command.credential.notBeforeAtMs, command.credential.expiresAtMs,
          ],
        );
        await client.query(
          `INSERT INTO "ql3"."worker_credential_mutations" (
             mutation_id, operation, credential_id, credential_version,
             expected_previous_version, changed_by_type, changed_by_id,
             audit_event_id, created_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            command.mutation.mutationId, command.mutation.operation,
            command.mutation.credentialId, command.mutation.credentialVersion,
            command.mutation.expectedPreviousVersion,
            command.mutation.changedBy.type, command.mutation.changedBy.id,
            command.mutation.mutationId, command.mutation.createdAtMs,
          ],
        );
        if (delivery) await insertDelivery(client, delivery);
        await client.query('COMMIT');
        began = false;
        return Object.freeze({ status: 'created', credential: command.credential, mutation: command.mutation });
      } catch (error) {
        if (began) await rollbackAdministrationTransaction(client);
        if (
          error instanceof WorkerCredentialVersionConflictError ||
          error instanceof WorkerCredentialMutationConflictError ||
          error instanceof WorkerCredentialUnavailableError ||
          error instanceof WorkerCredentialDeliveryConflictError ||
          error instanceof WorkerCredentialDeliveryUnavailableError
        ) throw error;
        if (attempt < 2 && retryableAdministrationError(error)) continue;
        throw delivery
          ? new WorkerCredentialDeliveryUnavailableError()
          : new WorkerCredentialUnavailableError();
      } finally {
        client.release();
      }
    }
    throw delivery
      ? new WorkerCredentialDeliveryUnavailableError()
      : new WorkerCredentialUnavailableError();
  }

  async append(
    input: AppendWorkerCredentialCommand,
  ): Promise<AppendWorkerCredentialResult> {
    return this.appendCommand(normalizeAppendWorkerCredentialCommand(input), null);
  }

  async commitDelivered(
    input: CommitWorkerCredentialDeliveryCommand,
  ): Promise<AppendWorkerCredentialResult> {
    const command = normalizeCommitWorkerCredentialDeliveryCommand(input);
    return this.appendCommand(command.credential, command.delivery);
  }

  async markPublished(
    input: PublishWorkerCredentialDeliveryCommand,
  ): Promise<Readonly<WorkerCredentialDeliveryRecord>> {
    const command = normalizePublishWorkerCredentialDeliveryCommand(input);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client = await this.pool.connect();
      let began = false;
      try {
        await configureAdministrationTransaction(client);
        began = true;
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`ql3-worker-credential-delivery:${command.deliveryId}`],
        );
        const existing = await resolveDelivery(client, command.deliveryId);
        if (!existing) throw new WorkerCredentialDeliveryConflictError();
        if (existing.state !== 'credential_committed') {
          if (
            existing.version >= 2 &&
            existing.publicationDigest === command.publicationDigest
          ) {
            await client.query('COMMIT');
            began = false;
            return existing;
          }
          throw new WorkerCredentialDeliveryConflictError();
        }
        if (
          existing.version !== command.expectedVersion ||
          command.publishedAtMs < existing.credentialCommittedAtMs
        ) {
          throw new WorkerCredentialDeliveryConflictError();
        }
        const published = normalizeWorkerCredentialDeliveryRecord({
          ...existing,
          version: 2,
          state: 'published',
          publishedAtMs: command.publishedAtMs,
          publicationDigest: command.publicationDigest,
        });
        await insertDelivery(client, published);
        await client.query('COMMIT');
        began = false;
        return published;
      } catch (error) {
        if (began) await rollbackAdministrationTransaction(client);
        if (
          error instanceof WorkerCredentialDeliveryConflictError ||
          error instanceof WorkerCredentialDeliveryUnavailableError
        ) throw error;
        if (attempt < 2 && retryableAdministrationError(error)) continue;
        throw new WorkerCredentialDeliveryUnavailableError();
      } finally {
        client.release();
      }
    }
    throw new WorkerCredentialDeliveryUnavailableError();
  }
}
