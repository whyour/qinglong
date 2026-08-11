import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryable,
} from '@qinglong/runtime-core';

import {
  PluginPackagePromptOutputArtifactUnavailableError,
  normalizePluginPackagePromptOutputArtifactReference,
  pluginPackagePromptOutputArtifactReference,
  type PluginPackagePromptOutputArtifact,
  type PluginPackagePromptOutputArtifactReference,
} from '../pluginPackagePromptOutputArtifact';
import { readPostgresPluginPackagePromptOutputArtifactInTransaction } from './postgresPluginPackagePromptOutputArtifactRepository';
import type {
  PluginPackagePromptOutputArtifactRetentionState,
  PluginPackagePromptOutputArtifactRetentionStateReader,
} from '../pluginPackagePromptOutputRead';
import {
  MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_GC_CANDIDATES,
  createPluginPackagePromptOutputArtifactTombstone,
  exactPluginPackagePromptOutputRetentionPolicy,
  normalizePluginPackagePromptOutputArtifactTombstone,
  type PluginPackagePromptOutputArtifactGarbageCollector,
  type PluginPackagePromptOutputArtifactTombstone,
  type PluginPackagePromptOutputRetentionPolicyResolver,
} from '../pluginPackagePromptOutputRetention';

type Row = Record<string, unknown>;

const RETRYABLE_SQL_STATES = new Set(['40001', '40P01']);
const MAX_TRANSACTION_ATTEMPTS = 3;

export interface PostgresPluginPackagePromptOutputMaintenanceReadinessReport {
  readonly currentUser: string;
  readonly maintenanceAuthority: true;
  readonly artifactDeleteOnly: true;
  readonly tombstoneAppendOnly: true;
  readonly keyRetirementAppendOnly: true;
  readonly keyRotationAppendOnly: true;
  readonly terminalEvidenceReadOnly: true;
}

function unavailable(
  cause?: unknown,
): PluginPackagePromptOutputArtifactUnavailableError {
  return new PluginPackagePromptOutputArtifactUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function sqlState(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  const candidate =
    typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw unavailable();
  }
  return candidate as number;
}

function jsonObject(row: Row, key: string): Record<string, unknown> {
  try {
    const value = row[key];
    const candidate = typeof value === 'string' ? JSON.parse(value) : value;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      throw unavailable();
    }
    return candidate as Record<string, unknown>;
  } catch (cause) {
    throw cause instanceof PluginPackagePromptOutputArtifactUnavailableError
      ? cause
      : unavailable(cause);
  }
}

function parseTombstone(
  row: Row,
): Readonly<PluginPackagePromptOutputArtifactTombstone> {
  try {
    const tombstone = normalizePluginPackagePromptOutputArtifactTombstone(
      jsonObject(
        row,
        'tombstoneJson',
      ) as unknown as PluginPackagePromptOutputArtifactTombstone,
    );
    const reference = tombstone.reference;
    if (
      reference.artifactId !== text(row, 'artifactId') ||
      reference.projectId !== text(row, 'projectId') ||
      reference.runId !== text(row, 'runId') ||
      reference.stepRunId !== text(row, 'stepRunId') ||
      reference.invocationId !== text(row, 'invocationId') ||
      reference.artifactDigest !== text(row, 'artifactDigest') ||
      reference.retentionPolicyDigest !== text(row, 'retentionPolicyDigest') ||
      reference.retentionEligibleAtMs !==
        integer(row, 'retentionEligibleAtMs') ||
      reference.keyId !== text(row, 'keyId') ||
      tombstone.tombstonedAtMs !== integer(row, 'tombstonedAtMs') ||
      tombstone.tombstoneDigest !== text(row, 'tombstoneDigest')
    ) {
      throw unavailable();
    }
    return tombstone;
  } catch (cause) {
    throw cause instanceof PluginPackagePromptOutputArtifactUnavailableError
      ? cause
      : unavailable(cause);
  }
}

export async function readPostgresPluginPackagePromptOutputArtifactTombstoneInTransaction(
  queryable: PostgresQueryable,
  artifactId: string,
): Promise<Readonly<PluginPackagePromptOutputArtifactTombstone> | null> {
  const result = await queryable.query<Row>(
    `SELECT artifact_id AS "artifactId", project_id AS "projectId",
            run_id AS "runId", step_run_id AS "stepRunId",
            invocation_id AS "invocationId",
            artifact_digest AS "artifactDigest",
            retention_policy_digest AS "retentionPolicyDigest",
            retention_eligible_at_ms AS "retentionEligibleAtMs",
            key_id AS "keyId", tombstoned_at_ms AS "tombstonedAtMs",
            tombstone_digest AS "tombstoneDigest",
            tombstone_json AS "tombstoneJson"
       FROM "ql3_ai"."model_invocation_prompt_output_artifact_tombstones"
      WHERE artifact_id = $1
      LIMIT 2`,
    [artifactId],
  );
  if (result.rows.length > 1) throw unavailable();
  return result.rows[0] ? parseTombstone(result.rows[0]) : null;
}

async function databaseNowMs(queryable: PostgresQueryable): Promise<number> {
  const result = await queryable.query<Row>(
    `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
              AS "observedAtMs"`,
  );
  if (result.rows.length !== 1) throw unavailable();
  return integer(result.rows[0]!, 'observedAtMs');
}

async function terminalPromptOutput(
  client: PostgresClient,
  artifact: Readonly<PluginPackagePromptOutputArtifact>,
): Promise<boolean> {
  const result = await client.query<Row>(
    `SELECT run.status AS "runStatus", step.status AS "stepStatus",
            step.output_ref AS "outputRef",
            completion.outcome AS "completionOutcome",
            finalization.run_status AS "finalizationStatus"
       FROM "ql3_ai"."model_invocation_prompt_admissions" AS admission
       JOIN "ql3_ai"."model_invocation_prompt_finalizations" AS finalization
         ON finalization.request_id = admission.request_id
       JOIN "ql3_ai"."model_invocation_completions" AS completion
         ON completion.invocation_id = admission.invocation_id
       JOIN "ql3"."runs" AS run ON run.id = admission.run_id
       JOIN "ql3"."step_runs" AS step
         ON step.run_id = admission.run_id AND step.id = admission.step_run_id
      WHERE admission.invocation_id = $1
      LIMIT 2`,
    [artifact.invocationId],
  );
  const row = result.rows[0];
  return (
    result.rows.length === 1 &&
    row?.runStatus === 'succeeded' &&
    row.stepStatus === 'succeeded' &&
    row.outputRef === artifact.artifactId &&
    row.completionOutcome === 'succeeded' &&
    row.finalizationStatus === 'succeeded'
  );
}

async function insertTombstone(
  client: PostgresClient,
  artifact: Readonly<PluginPackagePromptOutputArtifact>,
  tombstonedAtMs: number,
): Promise<Readonly<PluginPackagePromptOutputArtifactTombstone>> {
  const tombstone = createPluginPackagePromptOutputArtifactTombstone(
    pluginPackagePromptOutputArtifactReference(artifact),
    tombstonedAtMs,
  );
  const reference = tombstone.reference;
  await client.query(
    `INSERT INTO "ql3_ai"."model_invocation_prompt_output_artifact_tombstones" (
       artifact_id, project_id, run_id, step_run_id, invocation_id,
       artifact_digest, retention_policy_digest,
       retention_eligible_at_ms, key_id, tombstoned_at_ms,
       tombstone_digest, tombstone_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
     )`,
    [
      reference.artifactId,
      reference.projectId,
      reference.runId,
      reference.stepRunId,
      reference.invocationId,
      reference.artifactDigest,
      reference.retentionPolicyDigest,
      reference.retentionEligibleAtMs,
      reference.keyId,
      tombstone.tombstonedAtMs,
      tombstone.tombstoneDigest,
      JSON.stringify(tombstone),
    ],
  );
  return tombstone;
}

export async function assertPostgresPluginPackagePromptOutputMaintenanceReady(
  pool: PostgresPool,
): Promise<
  Readonly<PostgresPluginPackagePromptOutputMaintenanceReadinessReport>
> {
  try {
    const result = await pool.query<Row>(
      `SELECT current_user AS "currentUser",
         pg_has_role(current_user, 'ql3_ai_maintenance', 'member') AND
         NOT pg_has_role(current_user, 'ql3_runtime', 'member') AND
         NOT pg_has_role(current_user, 'ql3_admin', 'member')
           AS "maintenanceAuthority",
         has_schema_privilege(current_user, 'ql3_ai', 'USAGE') AND
         NOT has_schema_privilege(current_user, 'ql3_ai', 'CREATE') AND
         has_schema_privilege(current_user, 'ql3', 'USAGE') AND
         NOT has_schema_privilege(current_user, 'ql3', 'CREATE')
           AS "schemaAuthority",
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_artifacts', 'SELECT') AND
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_artifacts', 'DELETE') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_artifacts', 'INSERT') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_artifacts', 'UPDATE')
           AS "artifactDeleteOnly",
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
           'SELECT') AND
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
           'INSERT') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
           'UPDATE') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
           'DELETE')
           AS "tombstoneAppendOnly",
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
           'SELECT') AND
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
           'INSERT') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
           'UPDATE') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
           'DELETE') AND
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_key_retirement_completions',
           'SELECT') AND
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_key_retirement_completions',
           'INSERT') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_key_retirement_completions',
           'UPDATE') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_key_retirement_completions',
           'DELETE') AND
         has_table_privilege('ql3_runtime',
           'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
           'SELECT') AND
         NOT has_table_privilege('ql3_runtime',
           'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
           'INSERT, UPDATE, DELETE') AND
         NOT has_table_privilege('ql3_runtime',
           'ql3_ai.model_invocation_prompt_output_key_retirement_completions',
           'SELECT, INSERT, UPDATE, DELETE')
           AS "keyRetirementAppendOnly",
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_key_rotation_preparations',
           'SELECT') AND
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_key_rotation_preparations',
           'INSERT') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_key_rotation_preparations',
           'UPDATE, DELETE') AND
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_key_rotation_completions',
           'SELECT') AND
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_key_rotation_completions',
           'INSERT') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_output_key_rotation_completions',
           'UPDATE, DELETE') AND
         NOT has_table_privilege('ql3_runtime',
           'ql3_ai.model_invocation_prompt_output_key_rotation_preparations',
           'SELECT, INSERT, UPDATE, DELETE') AND
         NOT has_table_privilege('ql3_runtime',
           'ql3_ai.model_invocation_prompt_output_key_rotation_completions',
           'SELECT, INSERT, UPDATE, DELETE') AND
         NOT has_table_privilege('ql3_admin',
           'ql3_ai.model_invocation_prompt_output_key_rotation_preparations',
           'SELECT, INSERT, UPDATE, DELETE') AND
         NOT has_table_privilege('ql3_admin',
           'ql3_ai.model_invocation_prompt_output_key_rotation_completions',
           'SELECT, INSERT, UPDATE, DELETE') AND
         NOT has_table_privilege('ql3_ai_credential_manager',
           'ql3_ai.model_invocation_prompt_output_key_rotation_preparations',
           'SELECT, INSERT, UPDATE, DELETE') AND
         NOT has_table_privilege('ql3_ai_credential_manager',
           'ql3_ai.model_invocation_prompt_output_key_rotation_completions',
           'SELECT, INSERT, UPDATE, DELETE') AND
         NOT has_table_privilege('ql3_ai_credential_tester',
           'ql3_ai.model_invocation_prompt_output_key_rotation_preparations',
           'SELECT, INSERT, UPDATE, DELETE') AND
         NOT has_table_privilege('ql3_ai_credential_tester',
           'ql3_ai.model_invocation_prompt_output_key_rotation_completions',
           'SELECT, INSERT, UPDATE, DELETE')
           AS "keyRotationAppendOnly",
         has_table_privilege(current_user,
           'ql3_ai.ai_schema_migrations', 'SELECT') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.ai_schema_migrations', 'INSERT') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.ai_schema_migrations', 'UPDATE') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.ai_schema_migrations', 'DELETE') AND
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_completions', 'SELECT') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_completions', 'INSERT') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_completions', 'UPDATE') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_completions', 'DELETE') AND
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_admissions', 'SELECT') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_admissions', 'INSERT') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_admissions', 'UPDATE') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_admissions', 'DELETE') AND
         has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_finalizations', 'SELECT') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_finalizations', 'INSERT') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_finalizations', 'UPDATE') AND
         NOT has_table_privilege(current_user,
           'ql3_ai.model_invocation_prompt_finalizations', 'DELETE') AND
         has_table_privilege(current_user, 'ql3.runs', 'SELECT') AND
         NOT has_table_privilege(current_user, 'ql3.runs', 'INSERT') AND
         NOT has_table_privilege(current_user, 'ql3.runs', 'UPDATE') AND
         NOT has_table_privilege(current_user, 'ql3.runs', 'DELETE') AND
         has_table_privilege(current_user, 'ql3.step_runs', 'SELECT') AND
         NOT has_table_privilege(current_user,
           'ql3.step_runs', 'INSERT') AND
         NOT has_table_privilege(current_user,
           'ql3.step_runs', 'UPDATE') AND
         NOT has_table_privilege(current_user,
           'ql3.step_runs', 'DELETE')
           AS "terminalEvidenceReadOnly"`,
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !row ||
      typeof row.currentUser !== 'string' ||
      row.currentUser.length < 1 ||
      row.maintenanceAuthority !== true ||
      row.schemaAuthority !== true ||
      row.artifactDeleteOnly !== true ||
      row.tombstoneAppendOnly !== true ||
      row.keyRetirementAppendOnly !== true ||
      row.keyRotationAppendOnly !== true ||
      row.terminalEvidenceReadOnly !== true
    ) {
      throw unavailable();
    }
    return Object.freeze({
      currentUser: row.currentUser,
      maintenanceAuthority: true,
      artifactDeleteOnly: true,
      tombstoneAppendOnly: true,
      keyRetirementAppendOnly: true,
      keyRotationAppendOnly: true,
      terminalEvidenceReadOnly: true,
    });
  } catch (cause) {
    throw cause instanceof PluginPackagePromptOutputArtifactUnavailableError
      ? cause
      : unavailable(cause);
  }
}

export class PostgresPluginPackagePromptOutputRetentionRepository
  implements PluginPackagePromptOutputArtifactRetentionStateReader
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool !== 'object' ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw unavailable();
    }
  }

  async inspect(
    request: Readonly<{
      reference: Readonly<PluginPackagePromptOutputArtifactReference>;
      observedAtMs: number;
    }>,
  ): Promise<PluginPackagePromptOutputArtifactRetentionState> {
    const reference = normalizePluginPackagePromptOutputArtifactReference(
      request.reference,
    );
    if (
      !Number.isSafeInteger(request.observedAtMs) ||
      request.observedAtMs < 0
    ) {
      throw unavailable();
    }
    try {
      const tombstone =
        await readPostgresPluginPackagePromptOutputArtifactTombstoneInTransaction(
          this.pool,
          reference.artifactId,
        );
      if (!tombstone) return Object.freeze({ state: 'retained' as const });
      if (JSON.stringify(tombstone.reference) !== JSON.stringify(reference)) {
        throw unavailable();
      }
      return Object.freeze({
        state: 'tombstoned' as const,
        tombstonedAtMs: tombstone.tombstonedAtMs,
        tombstoneDigest: tombstone.tombstoneDigest,
      });
    } catch (cause) {
      throw cause instanceof PluginPackagePromptOutputArtifactUnavailableError
        ? cause
        : unavailable(cause);
    }
  }
}

export class PostgresPluginPackagePromptOutputGarbageCollector
  implements PluginPackagePromptOutputArtifactGarbageCollector
{
  readonly #pool: PostgresPool;
  readonly #policies: PluginPackagePromptOutputRetentionPolicyResolver;
  readonly #limit: number;

  constructor(
    options: Readonly<{
      pool: PostgresPool;
      policies: PluginPackagePromptOutputRetentionPolicyResolver;
      limit?: number;
    }>,
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      !options.pool ||
      typeof options.pool.query !== 'function' ||
      typeof options.pool.connect !== 'function' ||
      !options.policies ||
      typeof options.policies.resolve !== 'function' ||
      (options.limit !== undefined &&
        (!Number.isSafeInteger(options.limit) ||
          options.limit < 1 ||
          options.limit > MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_GC_CANDIDATES))
    ) {
      throw unavailable();
    }
    this.#pool = options.pool;
    this.#policies = options.policies;
    this.#limit = options.limit ?? 32;
  }

  async collect(): Promise<
    Readonly<{
      scanned: number;
      tombstoned: number;
      skipped: number;
      hasMore: boolean;
    }>
  > {
    const nowMs = await databaseNowMs(this.#pool);
    const scan = await this.#pool.query<Row>(
      `SELECT artifact_id AS "artifactId"
         FROM "ql3_ai"."model_invocation_prompt_output_artifacts"
        WHERE retention_eligible_at_ms <= $1
        ORDER BY retention_eligible_at_ms, artifact_id
        LIMIT $2`,
      [nowMs, this.#limit + 1],
    );
    const ids = scan.rows.map((row) => text(row, 'artifactId'));
    const candidates = ids.slice(0, this.#limit);
    let tombstoned = 0;
    let skipped = 0;
    for (const artifactId of candidates) {
      const artifact =
        await readPostgresPluginPackagePromptOutputArtifactInTransaction(
          this.#pool,
          artifactId,
        );
      if (!artifact) {
        skipped += 1;
        continue;
      }
      let policy;
      try {
        policy = await this.#policies.resolve({
          projectId: artifact.projectId,
          revision: artifact.retentionPolicy.revision,
        });
      } catch (cause) {
        throw unavailable(cause);
      }
      if (
        !policy ||
        !exactPluginPackagePromptOutputRetentionPolicy(
          policy,
          artifact.retentionPolicy,
          artifact.retentionPolicyDigest,
        )
      ) {
        skipped += 1;
        continue;
      }
      if (await this.#tombstone(artifact, nowMs)) tombstoned += 1;
      else skipped += 1;
    }
    return Object.freeze({
      scanned: candidates.length,
      tombstoned,
      skipped,
      hasMore: ids.length > this.#limit,
    });
  }

  async #tombstone(
    expected: Readonly<PluginPackagePromptOutputArtifact>,
    nowMs: number,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      const client = await this.#pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
          '15s',
        ]);
        await client.query(`SELECT set_config('lock_timeout', $1, true)`, [
          '5s',
        ]);
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`,
          [expected.artifactId, 0x514c0301],
        );
        const current =
          await readPostgresPluginPackagePromptOutputArtifactInTransaction(
            client,
            expected.artifactId,
          );
        if (
          !current ||
          JSON.stringify(current) !== JSON.stringify(expected) ||
          current.retentionEligibleAtMs > nowMs ||
          !(await terminalPromptOutput(client, current))
        ) {
          await client.query('COMMIT');
          return false;
        }
        const existing =
          await readPostgresPluginPackagePromptOutputArtifactTombstoneInTransaction(
            client,
            current.artifactId,
          );
        if (existing) {
          await client.query('COMMIT');
          return false;
        }
        await insertTombstone(client, current, nowMs);
        const deletion = await client.query(
          `DELETE FROM "ql3_ai"."model_invocation_prompt_output_artifacts"
            WHERE artifact_id = $1 AND artifact_digest = $2`,
          [current.artifactId, current.artifactDigest],
        );
        if (deletion.rowCount !== 1) throw unavailable();
        await client.query('COMMIT');
        return true;
      } catch (cause) {
        try {
          await client.query('ROLLBACK');
        } catch {
          throw unavailable(cause);
        }
        if (
          RETRYABLE_SQL_STATES.has(sqlState(cause) ?? '') &&
          attempt + 1 < MAX_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        throw cause instanceof PluginPackagePromptOutputArtifactUnavailableError
          ? cause
          : unavailable(cause);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }
}
