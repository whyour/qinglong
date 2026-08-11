import type { PostgresPool } from '@qinglong/runtime-core';

import {
  POSTGRES_MODEL_INVOCATION_SCHEMA,
  postgresModelInvocationMigrationDefinition,
} from '../../migration/modelInvocationMigration';
import {
  PostgresPluginPackagePromptApplicationUnavailableError,
  unavailable,
  type PostgresPluginPackagePromptReadinessReport,
} from './contracts';

interface MigrationHistoryRow extends Record<string, unknown> {
  readonly migrationId: unknown;
  readonly streamId: unknown;
  readonly dialect: unknown;
  readonly checksum: unknown;
}

interface AuthorityRow extends Record<string, unknown> {
  readonly currentUser: unknown;
  readonly runtimeAuthority: unknown;
  readonly schemaUsage: unknown;
  readonly invocationAppendOnly: unknown;
  readonly promptAppendOnly: unknown;
  readonly catalogReadable: unknown;
  readonly promptSnapshotExecutable: unknown;
  readonly promptAuthorizationExecutable: unknown;
}


function exactHistory(rows: readonly MigrationHistoryRow[]): boolean {
  const expected = postgresModelInvocationMigrationDefinition.migrations;
  return (
    rows.length === expected.length &&
    rows.every((row, index) => {
      const migration = expected[index];
      return (
        migration !== undefined &&
        row.migrationId === migration.id &&
        row.streamId === postgresModelInvocationMigrationDefinition.id &&
        row.dialect === postgresModelInvocationMigrationDefinition.dialect &&
        row.checksum === migration.checksum
      );
    })
  );
}

/**
 * Read-only fail-closed proof for the independently migrated Cluster AI
 * feature. It must complete before provider credentials become reachable.
 */
export async function assertPostgresPluginPackagePromptApplicationReady(
  pool: PostgresPool,
): Promise<Readonly<PostgresPluginPackagePromptReadinessReport>> {
  try {
    const history = await pool.query<MigrationHistoryRow>(
      `SELECT migration_id AS "migrationId", stream_id AS "streamId",
              dialect, checksum
         FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."ai_schema_migrations"
        ORDER BY migration_id`,
    );
    if (!exactHistory(history.rows)) throw unavailable();
    const authority = await pool.query<AuthorityRow>(
      `SELECT
         current_user AS "currentUser",
         pg_has_role(current_user, 'ql3_runtime', 'member')
           AS "runtimeAuthority",
         has_schema_privilege(
           current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}', 'USAGE'
         ) AS "schemaUsage",
         has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_starts',
           'SELECT,INSERT'
         ) AND NOT has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_starts',
           'UPDATE,DELETE'
         ) AND
         has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_completions',
           'SELECT,INSERT'
         ) AND NOT has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_completions',
           'UPDATE,DELETE'
         ) AND
         has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_resolutions',
           'SELECT,INSERT'
         ) AND NOT has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_resolutions',
           'UPDATE,DELETE'
         ) AND
         has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_usage_ledger',
           'SELECT,INSERT'
         ) AND NOT has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_usage_ledger',
           'UPDATE,DELETE'
         ) AND
         has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_quota_reservations',
           'SELECT,INSERT'
         ) AND NOT has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_quota_reservations',
           'UPDATE,DELETE'
         ) AND
         has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_quota_settlements',
           'SELECT,INSERT'
         ) AND NOT has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_quota_settlements',
           'UPDATE,DELETE'
         ) AND
         has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_price_quotes',
           'SELECT,INSERT'
         ) AND NOT has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_price_quotes',
           'UPDATE,DELETE'
         ) AND
         has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_price_settlements',
           'SELECT,INSERT'
         ) AND NOT has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_price_settlements',
           'UPDATE,DELETE'
         ) AS "invocationAppendOnly",
         has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_prompt_admissions',
           'SELECT,INSERT'
         ) AND NOT has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_prompt_admissions',
           'UPDATE,DELETE'
         ) AND
         has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_prompt_finalizations',
           'SELECT,INSERT'
         ) AND NOT has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_prompt_finalizations',
           'UPDATE,DELETE'
         ) AND
         has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_prompt_output_artifacts',
           'SELECT,INSERT'
         ) AND NOT has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_prompt_output_artifacts',
           'UPDATE,DELETE'
         ) AND
         has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_prompt_output_artifact_tombstones',
           'SELECT'
         ) AND NOT has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_prompt_output_artifact_tombstones',
           'INSERT'
         ) AND NOT has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_prompt_output_artifact_tombstones',
           'UPDATE'
         ) AND NOT has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_prompt_output_artifact_tombstones',
           'DELETE'
         ) AS "promptAppendOnly",
         has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_price_catalog_publications',
           'SELECT'
         ) AND
         has_table_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_price_catalog_heads',
           'SELECT'
         ) AS "catalogReadable",
         has_function_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.plugin_package_prompt_admission_snapshot(varchar,varchar,character,varchar,varchar,integer,integer)',
           'EXECUTE'
         ) AS "promptSnapshotExecutable",
         has_function_privilege(
           current_user,
           '${POSTGRES_MODEL_INVOCATION_SCHEMA}.plugin_package_prompt_authorize_admission(varchar,integer,varchar,varchar,varchar,integer,integer,uuid,varchar,bigint,boolean)',
           'EXECUTE'
         ) AS "promptAuthorizationExecutable"`,
    );
    const row = authority.rows[0];
    if (
      authority.rows.length !== 1 ||
      !row ||
      typeof row.currentUser !== 'string' ||
      row.currentUser.length < 1 ||
      row.runtimeAuthority !== true ||
      row.schemaUsage !== true ||
      row.invocationAppendOnly !== true ||
      row.promptAppendOnly !== true ||
      row.catalogReadable !== true ||
      row.promptSnapshotExecutable !== true ||
      row.promptAuthorizationExecutable !== true
    ) {
      throw unavailable();
    }
    return Object.freeze({
      schema: POSTGRES_MODEL_INVOCATION_SCHEMA,
      migrationStreamId: postgresModelInvocationMigrationDefinition.id,
      migrationCount:
        postgresModelInvocationMigrationDefinition.migrations.length,
      currentUser: row.currentUser,
      runtimeAuthority: true,
      appendOnly: true,
    });
  } catch (cause) {
    throw cause instanceof
      PostgresPluginPackagePromptApplicationUnavailableError
      ? cause
      : unavailable(cause);
  }
}
