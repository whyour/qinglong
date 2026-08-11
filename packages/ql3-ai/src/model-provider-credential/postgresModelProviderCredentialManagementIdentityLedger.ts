import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';

import {
  POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID,
  POSTGRES_MODEL_INVOCATION_SCHEMA,
  postgresModelInvocationMigrationDefinition,
} from '../migration/modelInvocationMigration';

const AUTHORITY = 'model-provider-credential-management';
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

type Row = Record<string, unknown>;

export interface ModelProviderCredentialManagementIdentityKeysetSnapshot {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly digest: string;
  readonly issuer: string;
  readonly audience: string;
  readonly activeKeyIds: readonly string[];
  readonly revokedKeyIds: readonly string[];
}

export interface PostgresModelProviderCredentialManagerReadinessReport {
  readonly ready: true;
  readonly currentUser: string;
  readonly migrationIds: readonly string[];
  readonly writablePrimary: true;
  readonly managerAuthority: true;
  readonly leastPrivilege: true;
}

export class PostgresModelProviderCredentialManagementIdentityLedgerConflictError extends Error {
  readonly code =
    'POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_IDENTITY_LEDGER_CONFLICT';

  constructor() {
    super(
      'PostgreSQL model provider credential management identity ledger conflicts',
    );
    this.name =
      'PostgresModelProviderCredentialManagementIdentityLedgerConflictError';
  }
}

export class PostgresModelProviderCredentialManagementIdentityLedgerUnavailableError extends Error {
  readonly code =
    'POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_IDENTITY_LEDGER_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super(
      'PostgreSQL model provider credential management identity ledger is unavailable',
      options,
    );
    this.name =
      'PostgresModelProviderCredentialManagementIdentityLedgerUnavailableError';
  }
}

export class PostgresModelProviderCredentialManagerNotReadyError extends Error {
  readonly code = 'POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGER_NOT_READY';

  constructor(options?: ErrorOptions) {
    super('PostgreSQL model provider credential manager is not ready', options);
    this.name = 'PostgresModelProviderCredentialManagerNotReadyError';
  }
}

function reviewedKeyIds(
  value: readonly string[],
  minimum: number,
  maximum: number,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new TypeError(
      'Model provider credential management identity key ids are invalid',
    );
  }
  const seen = new Set<string>();
  for (const keyId of value) {
    if (
      typeof keyId !== 'string' ||
      !KEY_ID_PATTERN.test(keyId) ||
      seen.has(keyId)
    ) {
      throw new TypeError(
        'Model provider credential management identity key ids are invalid',
      );
    }
    seen.add(keyId);
  }
  return Object.freeze([...value].sort());
}

function reviewedSnapshot(
  value: Readonly<ModelProviderCredentialManagementIdentityKeysetSnapshot>,
): Readonly<ModelProviderCredentialManagementIdentityKeysetSnapshot> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 7 ||
    Object.keys(value).some(
      (key) =>
        ![
          'schemaVersion',
          'generation',
          'digest',
          'issuer',
          'audience',
          'activeKeyIds',
          'revokedKeyIds',
        ].includes(key),
    ) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    typeof value.digest !== 'string' ||
    !DIGEST_PATTERN.test(value.digest) ||
    typeof value.issuer !== 'string' ||
    value.issuer.length < 1 ||
    value.issuer.length > 512 ||
    CONTROL_PATTERN.test(value.issuer) ||
    typeof value.audience !== 'string' ||
    value.audience.length < 1 ||
    value.audience.length > 256 ||
    CONTROL_PATTERN.test(value.audience)
  ) {
    throw new TypeError(
      'Model provider credential management identity snapshot is invalid',
    );
  }
  const activeKeyIds = reviewedKeyIds(value.activeKeyIds, 1, 8);
  const revokedKeyIds = reviewedKeyIds(value.revokedKeyIds, 0, 64);
  if (activeKeyIds.some((keyId) => revokedKeyIds.includes(keyId))) {
    throw new TypeError(
      'Model provider credential management identity snapshot is invalid',
    );
  }
  return Object.freeze({ ...value, activeKeyIds, revokedKeyIds });
}

function integer(row: Row, name: string): number {
  const value = Number(row[name]);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`invalid ${name}`);
  return value;
}

function text(row: Row, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') throw new Error(`invalid ${name}`);
  return value;
}

function textArray(row: Row, name: string): readonly string[] {
  const value = row[name];
  if (
    !Array.isArray(value) ||
    value.some((candidate) => typeof candidate !== 'string')
  ) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function includesAll(
  candidate: readonly string[],
  required: readonly string[],
): boolean {
  const values = new Set(candidate);
  return required.every((value) => values.has(value));
}

async function rollback(client: PostgresClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

export class PostgresModelProviderCredentialManagementIdentityLedgerRepository {
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError(
        'PostgreSQL model provider credential management identity pool is invalid',
      );
    }
  }

  async observe(
    value: Readonly<ModelProviderCredentialManagementIdentityKeysetSnapshot>,
  ): Promise<void> {
    const candidate = reviewedSnapshot(value);
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new PostgresModelProviderCredentialManagementIdentityLedgerUnavailableError(
        {
          cause: error,
        },
      );
    }
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_management_identity_keyset_ledger" (
           authority, generation, digest, issuer, audience,
           active_key_ids, revoked_key_ids, updated_at_ms
         ) VALUES (
           $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb,
           floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
         ) ON CONFLICT (authority) DO NOTHING`,
        [
          AUTHORITY,
          candidate.generation,
          candidate.digest,
          candidate.issuer,
          candidate.audience,
          JSON.stringify(candidate.activeKeyIds),
          JSON.stringify(candidate.revokedKeyIds),
        ],
      );
      const selected = await client.query<Row>(
        `SELECT generation, digest, issuer, audience,
                active_key_ids AS "activeKeyIds",
                revoked_key_ids AS "revokedKeyIds"
           FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_management_identity_keyset_ledger"
          WHERE authority = $1
          FOR UPDATE`,
        [AUTHORITY],
      );
      if (selected.rows.length !== 1)
        throw new Error('identity ledger row is missing');
      const current = selected.rows[0]!;
      const generation = integer(current, 'generation');
      const digest = text(current, 'digest');
      const issuer = text(current, 'issuer');
      const audience = text(current, 'audience');
      const activeKeyIds = textArray(current, 'activeKeyIds');
      const revokedKeyIds = textArray(current, 'revokedKeyIds');
      const exact =
        generation === candidate.generation &&
        digest === candidate.digest &&
        issuer === candidate.issuer &&
        audience === candidate.audience &&
        sameArray(activeKeyIds, candidate.activeKeyIds) &&
        sameArray(revokedKeyIds, candidate.revokedKeyIds);
      if (!exact) {
        const retained = [
          ...candidate.activeKeyIds,
          ...candidate.revokedKeyIds,
        ];
        if (
          candidate.generation <= generation ||
          candidate.issuer !== issuer ||
          candidate.audience !== audience ||
          !includesAll(candidate.revokedKeyIds, revokedKeyIds) ||
          !includesAll(retained, activeKeyIds)
        ) {
          throw new PostgresModelProviderCredentialManagementIdentityLedgerConflictError();
        }
        await client.query(
          `UPDATE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_management_identity_keyset_ledger"
              SET generation = $2,
                  digest = $3,
                  active_key_ids = $4::jsonb,
                  revoked_key_ids = $5::jsonb,
                  updated_at_ms =
                    floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
            WHERE authority = $1`,
          [
            AUTHORITY,
            candidate.generation,
            candidate.digest,
            JSON.stringify(candidate.activeKeyIds),
            JSON.stringify(candidate.revokedKeyIds),
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      if (
        error instanceof
        PostgresModelProviderCredentialManagementIdentityLedgerConflictError
      ) {
        throw error;
      }
      throw new PostgresModelProviderCredentialManagementIdentityLedgerUnavailableError(
        {
          cause: error,
        },
      );
    } finally {
      client.release();
    }
  }
}

export async function assertPostgresModelProviderCredentialManagerReady(
  pool: PostgresPool,
): Promise<Readonly<PostgresModelProviderCredentialManagerReadinessReport>> {
  if (!pool || typeof pool.query !== 'function') {
    throw new PostgresModelProviderCredentialManagerNotReadyError();
  }
  try {
    const history = await pool.query<Row>(
      `SELECT migration_id AS "migrationId", stream_id AS "streamId",
              dialect, checksum
         FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."ai_schema_migrations"
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
         pg_has_role(current_user, 'ql3_ai_credential_manager', 'member') AND
         NOT pg_has_role(current_user, 'ql3_ai_credential_tester', 'member') AND
         NOT pg_has_role(current_user, 'ql3_ai_maintenance', 'member') AND
         NOT pg_has_role(current_user, 'ql3_runtime', 'member') AND
         NOT pg_has_role(current_user, 'ql3_admin', 'member')
           AS "managerAuthority",
         has_schema_privilege(current_user, 'ql3', 'USAGE') AND
         NOT has_schema_privilege(current_user, 'ql3', 'CREATE') AND
         has_schema_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}', 'USAGE') AND
         NOT has_schema_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}', 'CREATE') AND
         has_table_privilege(current_user, 'ql3.projects', 'SELECT') AND
         NOT has_table_privilege(current_user, 'ql3.projects', 'INSERT,UPDATE,DELETE') AND
         has_table_privilege(current_user, 'ql3.project_role_bindings', 'SELECT') AND
         NOT has_table_privilege(current_user, 'ql3.project_role_bindings', 'INSERT,UPDATE,DELETE') AND
         has_table_privilege(current_user, 'ql3.security_audit_events', 'SELECT,INSERT') AND
         NOT has_table_privilege(current_user, 'ql3.security_audit_events', 'UPDATE,DELETE') AND
         has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.ai_schema_migrations', 'SELECT') AND
         NOT has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.ai_schema_migrations', 'INSERT,UPDATE,DELETE') AND
         has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_bindings', 'SELECT,INSERT') AND
         NOT has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_bindings', 'UPDATE,DELETE') AND
         has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_transitions', 'SELECT,INSERT') AND
         NOT has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_transitions', 'UPDATE,DELETE') AND
         has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_audits', 'SELECT') AND
         NOT has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_audits', 'INSERT,UPDATE,DELETE') AND
         has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_management_identity_keyset_ledger', 'SELECT,INSERT,UPDATE') AND
         NOT has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_management_identity_keyset_ledger', 'DELETE') AND
         has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_test_plans', 'SELECT,INSERT') AND
         NOT has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_test_plans', 'UPDATE,DELETE') AND
         has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_test_quota_buckets', 'SELECT,INSERT,UPDATE') AND
         NOT has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_test_quota_buckets', 'DELETE') AND
         has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_test_executions', 'SELECT') AND
         NOT has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_test_executions', 'INSERT,UPDATE,DELETE') AND
         has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_test_results', 'SELECT') AND
         NOT has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_provider_credential_test_results', 'INSERT,UPDATE,DELETE') AND
         NOT has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_prompt_output_artifacts', 'SELECT,INSERT,UPDATE,DELETE') AND
         NOT has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_invocation_prompt_output_key_retirement_preparations', 'SELECT,INSERT,UPDATE,DELETE') AND
         NOT has_table_privilege(current_user, '${POSTGRES_MODEL_INVOCATION_SCHEMA}.model_price_catalog_publications', 'SELECT,INSERT,UPDATE,DELETE')
           AS "leastPrivilege"`,
    );
    const row = facts.rows[0];
    if (
      facts.rows.length !== 1 ||
      typeof row?.currentUser !== 'string' ||
      row.writablePrimary !== true ||
      row.managerAuthority !== true ||
      row.leastPrivilege !== true
    ) {
      throw new Error('manager authority is invalid');
    }
    return Object.freeze({
      ready: true as const,
      currentUser: row.currentUser,
      migrationIds: Object.freeze(expected.map(({ id }) => id)),
      writablePrimary: true as const,
      managerAuthority: true as const,
      leastPrivilege: true as const,
    });
  } catch (error) {
    if (error instanceof PostgresModelProviderCredentialManagerNotReadyError) {
      throw error;
    }
    throw new PostgresModelProviderCredentialManagerNotReadyError({
      cause: error,
    });
  }
}
