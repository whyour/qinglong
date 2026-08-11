import type { PostgresPool } from '@qinglong/runtime-core';

import {
  POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID,
  postgresModelInvocationMigrationDefinition,
} from '../../migration/modelInvocationMigration';
import {
  PostgresModelProviderCredentialTesterNotReadyError,
  type PostgresModelProviderCredentialTesterReadinessReport,
} from './contracts';
import type { Row } from './common';

export async function assertPostgresModelProviderCredentialTesterReady(
  pool: PostgresPool,
): Promise<Readonly<PostgresModelProviderCredentialTesterReadinessReport>> {
  if (!pool || typeof pool.query !== 'function') {
    throw new PostgresModelProviderCredentialTesterNotReadyError();
  }
  try {
    const history = await pool.query<Row>(
      `SELECT migration_id AS "migrationId", stream_id AS "streamId",
              dialect, checksum
         FROM "ql3_ai"."ai_schema_migrations"
        ORDER BY migration_id`,
    );
    const expected = postgresModelInvocationMigrationDefinition.migrations;
    if (
      history.rows.length !== expected.length ||
      history.rows.some(
        (row, index) =>
          row.migrationId !== expected[index]!.id ||
          row.streamId !== POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID ||
          row.dialect !== 'postgresql' ||
          row.checksum !== expected[index]!.checksum,
      )
    ) {
      throw new Error('migration history is invalid');
    }
    const facts = await pool.query<Row>(
      `SELECT current_user AS "currentUser",
         (NOT pg_is_in_recovery()) AND
         current_setting('transaction_read_only') = 'off'
           AS "writablePrimary",
         pg_has_role(current_user, 'ql3_ai_credential_tester', 'member') AND
         NOT pg_has_role(current_user, 'ql3_ai_credential_manager', 'member') AND
         NOT pg_has_role(current_user, 'ql3_ai_maintenance', 'member') AND
         NOT pg_has_role(current_user, 'ql3_runtime', 'member') AND
         NOT pg_has_role(current_user, 'ql3_admin', 'member')
           AS "testerAuthority",
         has_schema_privilege(current_user, 'ql3_ai', 'USAGE') AND
         NOT has_schema_privilege(current_user, 'ql3_ai', 'CREATE') AND
         has_table_privilege(current_user, 'ql3_ai.ai_schema_migrations', 'SELECT') AND
         NOT has_table_privilege(current_user, 'ql3_ai.ai_schema_migrations', 'INSERT,UPDATE,DELETE') AND
         has_table_privilege(current_user, 'ql3_ai.model_provider_credential_bindings', 'SELECT') AND
         NOT has_table_privilege(current_user, 'ql3_ai.model_provider_credential_bindings', 'INSERT,UPDATE,DELETE') AND
         has_table_privilege(current_user, 'ql3_ai.model_provider_credential_transitions', 'SELECT') AND
         NOT has_table_privilege(current_user, 'ql3_ai.model_provider_credential_transitions', 'INSERT,UPDATE,DELETE') AND
         has_table_privilege(current_user, 'ql3_ai.model_provider_credential_audits', 'SELECT,INSERT') AND
         NOT has_table_privilege(current_user, 'ql3_ai.model_provider_credential_audits', 'UPDATE,DELETE') AND
         has_table_privilege(current_user, 'ql3_ai.model_provider_credential_test_plans', 'SELECT') AND
         NOT has_table_privilege(current_user, 'ql3_ai.model_provider_credential_test_plans', 'INSERT,UPDATE,DELETE') AND
         has_table_privilege(current_user, 'ql3_ai.model_provider_credential_test_executions', 'SELECT,INSERT') AND
         NOT has_table_privilege(current_user, 'ql3_ai.model_provider_credential_test_executions', 'UPDATE,DELETE') AND
         has_table_privilege(current_user, 'ql3_ai.model_provider_credential_test_results', 'SELECT,INSERT') AND
         NOT has_table_privilege(current_user, 'ql3_ai.model_provider_credential_test_results', 'UPDATE,DELETE') AND
         NOT has_table_privilege(current_user, 'ql3_ai.model_provider_credential_test_quota_buckets', 'SELECT,INSERT,UPDATE,DELETE') AND
         NOT has_schema_privilege(current_user, 'ql3', 'USAGE') AND
         NOT has_table_privilege(
           current_user,
           (
             SELECT relation.oid
               FROM pg_catalog.pg_class AS relation
               JOIN pg_catalog.pg_namespace AS namespace
                 ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = 'ql3'
                AND relation.relname = 'security_audit_events'
           ),
           'SELECT,INSERT,UPDATE,DELETE'
         ) AND
         NOT has_table_privilege(current_user, 'ql3_ai.model_invocation_prompt_output_artifacts', 'SELECT,INSERT,UPDATE,DELETE')
           AS "leastPrivilege"`,
    );
    const row = facts.rows[0];
    if (
      facts.rows.length !== 1 ||
      typeof row?.currentUser !== 'string' ||
      row.writablePrimary !== true ||
      row.testerAuthority !== true ||
      row.leastPrivilege !== true
    ) {
      throw new Error('tester authority is invalid');
    }
    return Object.freeze({
      ready: true as const,
      currentUser: row.currentUser,
      migrationIds: Object.freeze(expected.map(({ id }) => id)),
      writablePrimary: true as const,
      testerAuthority: true as const,
      leastPrivilege: true as const,
    });
  } catch (error) {
    throw new PostgresModelProviderCredentialTesterNotReadyError({
      cause: error instanceof Error ? error : undefined,
    });
  }
}
