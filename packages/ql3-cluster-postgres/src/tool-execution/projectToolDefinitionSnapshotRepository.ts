import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  InvalidProjectToolDefinitionSnapshotError,
  MAX_PROJECT_TOOL_DEFINITION_SNAPSHOT_JSON_BYTES,
  MAX_PROJECT_TOOL_SNAPSHOT_ACTIVE_PACKAGES,
  ProjectToolDefinitionSnapshotConflictError,
  ProjectToolDefinitionSnapshotUnavailableError,
  assertProjectToolDefinitionSnapshotRecoveryPageSize,
  assertProjectToolDefinitionSnapshotSourcePageSize,
  normalizeProjectToolDefinitionSnapshot,
  normalizeProjectToolDefinitionSnapshotPendingProjectCursor,
  normalizeProjectToolDefinitionSnapshotRecord,
  normalizeProjectToolDefinitionSnapshotSourceCursor,
  projectToolDefinitionActiveVectorDigest,
  type ProjectToolDefinitionSnapshot,
  type ProjectToolDefinitionSnapshotPendingProjectPage,
  type ProjectToolDefinitionSnapshotRecord,
  type ProjectToolDefinitionSnapshotRepository,
  type ProjectToolDefinitionSnapshotSource,
  type ProjectToolDefinitionSnapshotSourcePage,
  type ProjectToolDefinitionSnapshotSourceRepository,
} from '@qinglong/runtime-core/project-tool-definition-snapshot';
import { assertProjectPolicyProjectId } from '@qinglong/runtime-core/project-policy';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

function invalid(message: string): never {
  throw new InvalidProjectToolDefinitionSnapshotError(message);
}

function unavailable(): ProjectToolDefinitionSnapshotUnavailableError {
  return new ProjectToolDefinitionSnapshotUnavailableError();
}

function normalizeProjectId(value: unknown): string {
  try {
    assertProjectPolicyProjectId(value as string);
  } catch {
    return invalid('projectId is invalid');
  }
  return value as string;
}

function serialize(snapshot: Readonly<ProjectToolDefinitionSnapshot>): string {
  const value = JSON.stringify(snapshot);
  if (
    Buffer.byteLength(value, 'utf8') >
    MAX_PROJECT_TOOL_DEFINITION_SNAPSHOT_JSON_BYTES
  ) {
    return invalid('snapshot exceeds the durable JSON budget');
  }
  return value;
}

function same(
  left: readonly Readonly<ProjectToolDefinitionSnapshotSource>[],
  right: readonly Readonly<ProjectToolDefinitionSnapshotSource>[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactOptions(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(`${label} is invalid`);
  }
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== 'string' || !allowed.has(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function sourceFromRow(
  row: Row,
): Readonly<ProjectToolDefinitionSnapshotSource> {
  if (postgresRequiredString(row.activeState, unavailable) !== 'active') {
    throw unavailable();
  }
  return Object.freeze({
    installationId: postgresRequiredString(row.installationId, unavailable),
    packageName: postgresRequiredString(row.packageName, unavailable),
    generation: postgresRequiredInteger(row.generation, unavailable),
    generationDigest: postgresRequiredString(row.generationDigest, unavailable),
    lockDigest: postgresRequiredString(row.lockDigest, unavailable),
    revisionDigest: postgresRequiredString(row.revisionDigest, unavailable),
  });
}

function mappedError(error: unknown): Error {
  if (
    error instanceof InvalidProjectToolDefinitionSnapshotError ||
    error instanceof ProjectToolDefinitionSnapshotConflictError ||
    error instanceof ProjectToolDefinitionSnapshotUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new ProjectToolDefinitionSnapshotConflictError(
      'snapshot identity is already bound',
    );
  }
  return new ProjectToolDefinitionSnapshotUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export class PostgresProjectToolDefinitionSnapshotRepository
  implements
    ProjectToolDefinitionSnapshotRepository,
    ProjectToolDefinitionSnapshotSourceRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL Project Tool Definition snapshot repository options are invalid',
      );
    }
  }

  private async currentSources(
    queryable: Queryable,
    projectId: string,
    lock: boolean,
  ): Promise<readonly Readonly<ProjectToolDefinitionSnapshotSource>[]> {
    const result = await queryable.query<Row>(
      `SELECT
         head.package_name AS "packageName",
         active_install.installation_id AS "installationId",
         active_install.target_generation AS "generation",
         revision.generation_digest AS "generationDigest",
         active_install.lock_digest AS "lockDigest",
         revision.revision_digest AS "revisionDigest",
         active_install.state AS "activeState"
       FROM "ql3"."plugin_package_install_heads" AS head
       JOIN "ql3"."plugin_package_installs" AS head_install
         ON head_install.installation_id = head.installation_id
       LEFT JOIN "ql3"."plugin_package_installs" AS active_install
         ON active_install.project_id = head.project_id
        AND active_install.package_name = head.package_name
        AND active_install.lock_digest = head_install.active_lock_digest
       LEFT JOIN "ql3"."plugin_package_materialized_revisions" AS revision
         ON revision.project_id = active_install.project_id
        AND revision.package_name = active_install.package_name
        AND revision.generation = active_install.target_generation
        AND revision.lock_digest = active_install.lock_digest
       LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
         ON quarantine.project_id = active_install.project_id
        AND quarantine.package_name = active_install.package_name
        AND quarantine.installation_id = active_install.installation_id
        AND quarantine.lock_digest = active_install.lock_digest
       LEFT JOIN "ql3"."plugin_package_lifecycle_heads" AS lifecycle
         ON lifecycle.project_id = active_install.project_id
        AND lifecycle.package_name = active_install.package_name
        AND lifecycle.installation_id = active_install.installation_id
        AND lifecycle.lock_digest = active_install.lock_digest
        AND lifecycle.install_record_digest = active_install.record_digest
       WHERE head.project_id = $1
         AND head_install.active_lock_digest IS NOT NULL
         AND quarantine.event_digest IS NULL
         AND (
           lifecycle.event_digest IS NULL OR lifecycle.disposition = 'active'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM "ql3"."plugin_package_publisher_provenance" AS provenance
           JOIN "ql3"."plugin_package_publisher_revocation_receipts" AS revoked
             ON revoked.publisher = provenance.publisher
            AND revoked.key_id = provenance.key_id
           WHERE provenance.installation_id = active_install.installation_id
             AND provenance.lock_digest = active_install.lock_digest
         )
       ORDER BY head.package_name, active_install.installation_id
       ${lock ? 'FOR SHARE OF head, head_install' : ''}`,
      [projectId],
    );
    if (result.rows.length > MAX_PROJECT_TOOL_SNAPSHOT_ACTIVE_PACKAGES) {
      throw unavailable();
    }
    const sources = result.rows.map(sourceFromRow);
    if (
      sources.some(
        (source, index) =>
          index > 0 && sources[index - 1]!.packageName >= source.packageName,
      )
    ) {
      throw unavailable();
    }
    return Object.freeze(sources);
  }

  private activeVectorDigest(
    projectId: string,
    sources: readonly Readonly<ProjectToolDefinitionSnapshotSource>[],
  ): string {
    try {
      return projectToolDefinitionActiveVectorDigest(projectId, sources);
    } catch {
      throw unavailable();
    }
  }

  private async sourceRows(
    queryable: Queryable,
    projectId: string,
    activeVectorDigest: string,
  ): Promise<readonly Readonly<ProjectToolDefinitionSnapshotSource>[]> {
    const result = await queryable.query<Row>(
      `SELECT
         installation_id AS "installationId",
         package_name AS "packageName",
         generation,
         generation_digest AS "generationDigest",
         lock_digest AS "lockDigest",
         revision_digest AS "revisionDigest"
       FROM "ql3"."project_tool_definition_snapshot_sources"
       WHERE project_id = $1 AND active_vector_digest = $2
       ORDER BY package_name`,
      [projectId, activeVectorDigest],
    );
    return Object.freeze(
      result.rows.map((row) =>
        Object.freeze({
          installationId: postgresRequiredString(
            row.installationId,
            unavailable,
          ),
          packageName: postgresRequiredString(row.packageName, unavailable),
          generation: postgresRequiredInteger(row.generation, unavailable),
          generationDigest: postgresRequiredString(
            row.generationDigest,
            unavailable,
          ),
          lockDigest: postgresRequiredString(row.lockDigest, unavailable),
          revisionDigest: postgresRequiredString(
            row.revisionDigest,
            unavailable,
          ),
        }),
      ),
    );
  }

  private async findStored(
    queryable: Queryable,
    projectId: string,
    activeVectorDigest: string,
  ): Promise<Readonly<ProjectToolDefinitionSnapshotRecord> | null> {
    const result = await queryable.query<Row>(
      `SELECT
         project_id AS "projectId",
         active_vector_digest AS "activeVectorDigest",
         definitions_digest AS "definitionsDigest",
         snapshot_digest AS "snapshotDigest",
         snapshot_json AS "snapshotJson",
         committed_at_ms AS "committedAtMs"
       FROM "ql3"."project_tool_definition_snapshots"
       WHERE project_id = $1 AND active_vector_digest = $2
       LIMIT 2`,
      [projectId, activeVectorDigest],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw unavailable();
    const row = result.rows[0]!;
    try {
      const snapshot = normalizeProjectToolDefinitionSnapshot(
        postgresRequiredJsonObject(
          row.snapshotJson,
          unavailable,
        ) as unknown as ProjectToolDefinitionSnapshot,
      );
      const record = normalizeProjectToolDefinitionSnapshotRecord({
        snapshot,
        committedAtMs: postgresRequiredInteger(row.committedAtMs, unavailable),
      });
      if (
        snapshot.projectId !==
          postgresRequiredString(row.projectId, unavailable) ||
        snapshot.activeVectorDigest !==
          postgresRequiredString(row.activeVectorDigest, unavailable) ||
        snapshot.definitionsDigest !==
          postgresRequiredString(row.definitionsDigest, unavailable) ||
        snapshot.snapshotDigest !==
          postgresRequiredString(row.snapshotDigest, unavailable) ||
        !same(
          snapshot.sources,
          await this.sourceRows(
            queryable,
            snapshot.projectId,
            snapshot.activeVectorDigest,
          ),
        )
      ) {
        throw unavailable();
      }
      return record;
    } catch (error) {
      if (error instanceof ProjectToolDefinitionSnapshotUnavailableError) {
        throw error;
      }
      throw unavailable();
    }
  }

  async findCurrent(
    projectIdValue: string,
  ): Promise<Readonly<ProjectToolDefinitionSnapshotRecord> | null> {
    const projectId = normalizeProjectId(projectIdValue);
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw unavailable();
    }
    let began = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      began = true;
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
        '5000ms',
      ]);
      const sources = await this.currentSources(client, projectId, false);
      const record = await this.findStored(
        client,
        projectId,
        this.activeVectorDigest(projectId, sources),
      );
      if (record && !same(record.snapshot.sources, sources)) {
        throw unavailable();
      }
      await client.query('COMMIT');
      began = false;
      return record;
    } catch (error) {
      if (began) await rollbackPostgresDefinitionTransaction(client);
      throw mappedError(error);
    } finally {
      client.release();
    }
  }

  async listActiveSourcePage(options: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: Readonly<{ readonly packageName: string }>;
  }): Promise<Readonly<ProjectToolDefinitionSnapshotSourcePage>> {
    exactOptions(
      options,
      ['limit', 'projectId'],
      ['after'],
      'snapshot source page options',
    );
    const projectId = normalizeProjectId(options.projectId);
    assertProjectToolDefinitionSnapshotSourcePageSize(options.limit);
    const after =
      options.after === undefined
        ? undefined
        : normalizeProjectToolDefinitionSnapshotSourceCursor(options.after);
    try {
      const result = await this.pool.query<Row>(
        `SELECT
           head.package_name AS "packageName",
           active_install.installation_id AS "installationId",
           active_install.target_generation AS "generation",
           revision.generation_digest AS "generationDigest",
           active_install.lock_digest AS "lockDigest",
           revision.revision_digest AS "revisionDigest",
           active_install.state AS "activeState"
         FROM "ql3"."plugin_package_install_heads" AS head
         JOIN "ql3"."plugin_package_installs" AS head_install
           ON head_install.installation_id = head.installation_id
         LEFT JOIN "ql3"."plugin_package_installs" AS active_install
           ON active_install.project_id = head.project_id
          AND active_install.package_name = head.package_name
          AND active_install.lock_digest = head_install.active_lock_digest
         LEFT JOIN "ql3"."plugin_package_materialized_revisions" AS revision
           ON revision.project_id = active_install.project_id
          AND revision.package_name = active_install.package_name
          AND revision.generation = active_install.target_generation
          AND revision.lock_digest = active_install.lock_digest
         LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
           ON quarantine.project_id = active_install.project_id
          AND quarantine.package_name = active_install.package_name
          AND quarantine.installation_id = active_install.installation_id
          AND quarantine.lock_digest = active_install.lock_digest
         WHERE head.project_id = $1
           AND head_install.active_lock_digest IS NOT NULL
           AND quarantine.event_digest IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM "ql3"."plugin_package_publisher_provenance" AS provenance
             JOIN "ql3"."plugin_package_publisher_revocation_receipts" AS revoked
               ON revoked.publisher = provenance.publisher
              AND revoked.key_id = provenance.key_id
             WHERE provenance.installation_id =
               active_install.installation_id
               AND provenance.lock_digest = active_install.lock_digest
           )
           AND head.package_name > $2
         ORDER BY head.package_name, active_install.installation_id
         LIMIT $3`,
        [projectId, after?.packageName ?? '', options.limit + 1],
      );
      const truncated = result.rows.length > options.limit;
      const sources = Object.freeze(
        result.rows.slice(0, options.limit).map(sourceFromRow),
      );
      if (
        sources.some(
          (source, index) =>
            index > 0 && sources[index - 1]!.packageName >= source.packageName,
        )
      ) {
        throw unavailable();
      }
      const last = sources.at(-1);
      return Object.freeze({
        sources,
        truncated,
        ...(truncated && last
          ? { next: Object.freeze({ packageName: last.packageName }) }
          : {}),
      });
    } catch (error) {
      throw mappedError(error);
    }
  }

  async listPendingProjectPage(options: {
    readonly limit: number;
    readonly after?: Readonly<{ readonly projectId: string }>;
  }): Promise<Readonly<ProjectToolDefinitionSnapshotPendingProjectPage>> {
    exactOptions(
      options,
      ['limit'],
      ['after'],
      'snapshot pending Project page options',
    );
    assertProjectToolDefinitionSnapshotRecoveryPageSize(options.limit);
    const after =
      options.after === undefined
        ? undefined
        : normalizeProjectToolDefinitionSnapshotPendingProjectCursor(
            options.after,
          );
    try {
      const result = await this.pool.query<Row>(
        `WITH active_sources AS (
           SELECT
             head.project_id,
             head.package_name,
             active_install.installation_id,
             active_install.target_generation AS generation,
             revision.generation_digest,
             active_install.lock_digest,
             revision.revision_digest,
             CASE
               WHEN active_install.state = 'active'
                AND active_install.installation_id IS NOT NULL
                AND revision.generation_digest IS NOT NULL
                AND revision.revision_digest IS NOT NULL
               THEN true ELSE false
             END AS valid
           FROM "ql3"."plugin_package_install_heads" AS head
           JOIN "ql3"."plugin_package_installs" AS head_install
             ON head_install.installation_id = head.installation_id
           LEFT JOIN "ql3"."plugin_package_installs" AS active_install
             ON active_install.project_id = head.project_id
            AND active_install.package_name = head.package_name
            AND active_install.lock_digest = head_install.active_lock_digest
           LEFT JOIN "ql3"."plugin_package_materialized_revisions" AS revision
             ON revision.project_id = active_install.project_id
            AND revision.package_name = active_install.package_name
            AND revision.generation = active_install.target_generation
            AND revision.lock_digest = active_install.lock_digest
           LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
             ON quarantine.project_id = active_install.project_id
            AND quarantine.package_name = active_install.package_name
            AND quarantine.installation_id = active_install.installation_id
            AND quarantine.lock_digest = active_install.lock_digest
           WHERE head_install.active_lock_digest IS NOT NULL
             AND quarantine.event_digest IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM "ql3"."plugin_package_publisher_provenance" AS provenance
               JOIN "ql3"."plugin_package_publisher_revocation_receipts" AS revoked
                 ON revoked.publisher = provenance.publisher
                AND revoked.key_id = provenance.key_id
               WHERE provenance.installation_id =
                 active_install.installation_id
                 AND provenance.lock_digest = active_install.lock_digest
             )
         )
         SELECT project.id AS "projectId"
         FROM "ql3"."projects" AS project
         WHERE project.status = 'active'
           AND project.id COLLATE "C" > $1 COLLATE "C"
           AND (
             EXISTS (
               SELECT 1
               FROM active_sources AS active
               WHERE active.project_id = project.id
                 AND active.valid = false
             )
             OR NOT EXISTS (
               SELECT 1
               FROM "ql3"."project_tool_definition_snapshots" AS snapshot
               WHERE snapshot.project_id = project.id
                 AND NOT EXISTS (
                   SELECT 1
                   FROM active_sources AS active
                   WHERE active.project_id = project.id
                     AND active.valid = true
                     AND NOT EXISTS (
                       SELECT 1
                       FROM "ql3"."project_tool_definition_snapshot_sources" AS stored
                       WHERE stored.project_id = snapshot.project_id
                         AND stored.active_vector_digest =
                           snapshot.active_vector_digest
                         AND stored.package_name = active.package_name
                         AND stored.installation_id = active.installation_id
                         AND stored.generation = active.generation
                         AND stored.generation_digest =
                           active.generation_digest
                         AND stored.lock_digest = active.lock_digest
                         AND stored.revision_digest =
                           active.revision_digest
                     )
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM "ql3"."project_tool_definition_snapshot_sources" AS stored
                   WHERE stored.project_id = snapshot.project_id
                     AND stored.active_vector_digest =
                       snapshot.active_vector_digest
                     AND NOT EXISTS (
                       SELECT 1
                       FROM active_sources AS active
                       WHERE active.project_id = project.id
                         AND active.valid = true
                         AND active.package_name = stored.package_name
                         AND active.installation_id =
                           stored.installation_id
                         AND active.generation = stored.generation
                         AND active.generation_digest =
                           stored.generation_digest
                         AND active.lock_digest = stored.lock_digest
                         AND active.revision_digest =
                           stored.revision_digest
                     )
                 )
             )
           )
         ORDER BY project.id COLLATE "C"
         LIMIT $2`,
        [after?.projectId ?? '', options.limit + 1],
      );
      const truncated = result.rows.length > options.limit;
      const projectIds = Object.freeze(
        result.rows
          .slice(0, options.limit)
          .map((row) =>
            normalizeProjectId(
              postgresRequiredString(row.projectId, unavailable),
            ),
          ),
      );
      const last = projectIds.at(-1);
      return Object.freeze({
        projectIds,
        truncated,
        ...(truncated && last
          ? { next: Object.freeze({ projectId: last }) }
          : {}),
      });
    } catch (error) {
      throw mappedError(error);
    }
  }

  async publish(value: Readonly<ProjectToolDefinitionSnapshot>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      record: Readonly<ProjectToolDefinitionSnapshotRecord>;
    }>
  > {
    const snapshot = normalizeProjectToolDefinitionSnapshot(value);
    const snapshotJson = serialize(snapshot);
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch {
        throw unavailable();
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const sources = await this.currentSources(
          client,
          snapshot.projectId,
          true,
        );
        if (
          !same(snapshot.sources, sources) ||
          this.activeVectorDigest(snapshot.projectId, sources) !==
            snapshot.activeVectorDigest
        ) {
          throw new ProjectToolDefinitionSnapshotConflictError(
            'snapshot source vector is not the current active Package vector',
          );
        }
        const inserted = await client.query(
          `INSERT INTO "ql3"."project_tool_definition_snapshots" (
             project_id, active_vector_digest, definitions_digest,
             snapshot_digest, snapshot_json, committed_at_ms
           )
           VALUES ($1, $2, $3, $4, $5::jsonb,
             floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
           ON CONFLICT (project_id, active_vector_digest) DO NOTHING
           RETURNING active_vector_digest`,
          [
            snapshot.projectId,
            snapshot.activeVectorDigest,
            snapshot.definitionsDigest,
            snapshot.snapshotDigest,
            snapshotJson,
          ],
        );
        if (inserted.rows.length === 1 && snapshot.sources.length > 0) {
          await client.query(
            `INSERT INTO "ql3"."project_tool_definition_snapshot_sources" (
               project_id, active_vector_digest, package_name,
               installation_id, generation, generation_digest,
               lock_digest, revision_digest
             )
             SELECT $1, $2, source.package_name, source.installation_id,
                    source.generation, source.generation_digest,
                    source.lock_digest, source.revision_digest
             FROM jsonb_to_recordset($3::jsonb) AS source(
               package_name varchar(63),
               installation_id varchar(128),
               generation integer,
               generation_digest char(64),
               lock_digest char(64),
               revision_digest char(64)
             )`,
            [
              snapshot.projectId,
              snapshot.activeVectorDigest,
              JSON.stringify(
                snapshot.sources.map((source) => ({
                  package_name: source.packageName,
                  installation_id: source.installationId,
                  generation: source.generation,
                  generation_digest: source.generationDigest,
                  lock_digest: source.lockDigest,
                  revision_digest: source.revisionDigest,
                })),
              ),
            ],
          );
        }
        const stored = await this.findStored(
          client,
          snapshot.projectId,
          snapshot.activeVectorDigest,
        );
        if (!stored) throw unavailable();
        if (JSON.stringify(stored.snapshot) !== snapshotJson) {
          throw new ProjectToolDefinitionSnapshotConflictError(
            'active vector is bound to another semantic snapshot',
          );
        }
        await client.query('COMMIT');
        began = false;
        return Object.freeze({
          status: inserted.rows.length === 1 ? 'created' : 'existing',
          record: stored,
        });
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
        throw mappedError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }
}
