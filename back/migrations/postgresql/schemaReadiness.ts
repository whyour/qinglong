import {
  readPostgresMigrationHistory,
  type PostgresMigrationQueryable,
} from '../adapters/postgresMigrationStreamStore';
import { auditMigrationStreamHistory } from '../core/migrationStream';
import { postgresqlMainMigrationStream } from '.';
import {
  postgresqlControlSchemaContract,
  type PostgresSchemaContract,
} from './schemaContract';

export const POSTGRES_SCHEMA_READINESS_ERROR_CODES = [
  'server_version_unsupported',
  'server_not_writable_primary',
  'migration_history_invalid',
  'capability_invalid',
  'schema_contract_invalid',
  'runtime_role_invalid',
] as const;

export type PostgresSchemaReadinessErrorCode =
  (typeof POSTGRES_SCHEMA_READINESS_ERROR_CODES)[number];

export class PostgresSchemaReadinessError extends Error {
  constructor(
    readonly code: PostgresSchemaReadinessErrorCode,
    readonly facts: readonly string[] = [],
  ) {
    super(`PostgreSQL schema is not ready: ${code}`);
    this.name = 'PostgresSchemaReadinessError';
  }
}

export interface PostgresSchemaReadinessReport {
  readonly ready: true;
  readonly writablePrimary: true;
  readonly serverVersionNum: number;
  readonly serverMajor: number;
  readonly currentUser: string;
  readonly contractName: string;
  readonly contractVersion: number;
  readonly migrationIds: readonly string[];
}

interface ServerRow extends Record<string, unknown> {
  serverVersionNum: unknown;
  currentUser: unknown;
  inRecovery: unknown;
  transactionReadOnly: unknown;
}

interface CapabilityRow extends Record<string, unknown> {
  contractName: unknown;
  contractVersion: unknown;
  migrationId: unknown;
  capabilities: unknown;
}

interface ColumnRow extends Record<string, unknown> {
  tableName: unknown;
  columnName: unknown;
}

interface IndexRow extends Record<string, unknown> {
  indexName: unknown;
}

interface ConstraintRow extends Record<string, unknown> {
  constraintName: unknown;
  constraintType: unknown;
}

interface SchemaPrivilegeRow extends Record<string, unknown> {
  schemaUsage: unknown;
  schemaCreate: unknown;
}

interface TablePrivilegeRow extends Record<string, unknown> {
  tableName: unknown;
  selectAllowed: unknown;
  insertAllowed: unknown;
  updateAllowed: unknown;
  deleteAllowed: unknown;
  isOwner: unknown;
}

const REQUIRED_RUNTIME_PRIVILEGES = Object.freeze({
  schema_migrations: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  schema_capabilities: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  runs: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: false,
  }),
  run_attempts: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: false,
  }),
  run_events: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  run_retry_policies: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: false,
  }),
});

function safeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function exactJsonObject(
  actual: unknown,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    return false;
  }
  const actualObject = actual as Record<string, unknown>;
  const actualKeys = sorted(Object.keys(actualObject));
  const expectedKeys = sorted(Object.keys(expected));
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key, index) =>
        key === expectedKeys[index] && actualObject[key] === expected[key],
    )
  );
}

async function readServer(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract,
): Promise<{
  writablePrimary: true;
  serverVersionNum: number;
  serverMajor: number;
  currentUser: string;
}> {
  const result = await queryable.query<ServerRow>(
    `
SELECT
  current_setting('server_version_num') AS "serverVersionNum",
  current_user AS "currentUser",
  pg_is_in_recovery() AS "inRecovery",
  current_setting('transaction_read_only') AS "transactionReadOnly"
  `.trim(),
  );
  const row = result.rows[0];
  const serverVersionNum = safeInteger(row?.serverVersionNum);
  const currentUser = row?.currentUser;
  const inRecovery = row?.inRecovery;
  const transactionReadOnly = row?.transactionReadOnly;
  const serverMajor =
    serverVersionNum === null ? null : Math.floor(serverVersionNum / 10_000);
  if (
    result.rows.length !== 1 ||
    serverVersionNum === null ||
    serverMajor === null ||
    serverMajor < contract.minimumServerMajor ||
    serverMajor > contract.maximumServerMajor ||
    typeof currentUser !== 'string' ||
    currentUser.length === 0
  ) {
    throw new PostgresSchemaReadinessError('server_version_unsupported', [
      String(serverVersionNum ?? 'invalid'),
    ]);
  }
  if (inRecovery !== false || transactionReadOnly !== 'off') {
    throw new PostgresSchemaReadinessError('server_not_writable_primary', [
      `in-recovery:${String(inRecovery)}`,
      `transaction-read-only:${String(transactionReadOnly)}`,
    ]);
  }
  return {
    writablePrimary: true,
    serverVersionNum,
    serverMajor,
    currentUser,
  };
}

async function assertHistory(
  queryable: PostgresMigrationQueryable,
): Promise<readonly string[]> {
  const history = await readPostgresMigrationHistory(queryable);
  try {
    auditMigrationStreamHistory(history, postgresqlMainMigrationStream);
    return Object.freeze(history.map(({ migrationId }) => migrationId));
  } catch (error) {
    throw new PostgresSchemaReadinessError('migration_history_invalid', [
      error instanceof Error ? error.name : 'UnknownError',
    ]);
  }
}

async function assertCapability(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract,
): Promise<void> {
  const result = await queryable.query<CapabilityRow>(
    `
SELECT
  contract_name AS "contractName",
  contract_version AS "contractVersion",
  migration_id AS "migrationId",
  capabilities
FROM "${contract.schema}"."schema_capabilities"
WHERE contract_name = $1
    `.trim(),
    [contract.contractName],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    row.contractName !== contract.contractName ||
    safeInteger(row.contractVersion) !== contract.contractVersion ||
    row.migrationId !== contract.migrationId ||
    !exactJsonObject(row.capabilities, contract.capabilities)
  ) {
    throw new PostgresSchemaReadinessError('capability_invalid');
  }
}

async function assertSchemaContract(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract,
): Promise<void> {
  const [columnsResult, indexesResult, constraintsResult] = await Promise.all([
    queryable.query<ColumnRow>(
      `
SELECT table_name AS "tableName", column_name AS "columnName"
FROM information_schema.columns
WHERE table_schema = $1
ORDER BY table_name, ordinal_position
      `.trim(),
      [contract.schema],
    ),
    queryable.query<IndexRow>(
      `
SELECT indexname AS "indexName"
FROM pg_indexes
WHERE schemaname = $1
ORDER BY indexname
      `.trim(),
      [contract.schema],
    ),
    queryable.query<ConstraintRow>(
      `
SELECT
  constraints.conname AS "constraintName",
  CASE constraints.contype
    WHEN 'c' THEN 'check'
    WHEN 'f' THEN 'foreign_key'
  END AS "constraintType"
FROM pg_constraint constraints
JOIN pg_class tables ON tables.oid = constraints.conrelid
JOIN pg_namespace schemas ON schemas.oid = tables.relnamespace
WHERE schemas.nspname = $1
  AND constraints.contype IN ('c', 'f')
ORDER BY constraints.contype, constraints.conname
      `.trim(),
      [contract.schema],
    ),
  ]);
  const actualTables = new Map<string, Set<string>>();
  for (const row of columnsResult.rows) {
    if (
      typeof row.tableName !== 'string' ||
      typeof row.columnName !== 'string'
    ) {
      throw new PostgresSchemaReadinessError('schema_contract_invalid');
    }
    const columns = actualTables.get(row.tableName) ?? new Set<string>();
    columns.add(row.columnName);
    actualTables.set(row.tableName, columns);
  }
  const expectedTables = new Map(
    contract.tables.map((table) => [table.name, new Set(table.columns)]),
  );
  const findings: string[] = [];
  for (const [tableName, expectedColumns] of expectedTables) {
    const actualColumns = actualTables.get(tableName);
    if (!actualColumns) {
      findings.push(`missing-table:${tableName}`);
      continue;
    }
    for (const column of expectedColumns) {
      if (!actualColumns.has(column)) {
        findings.push(`missing-column:${tableName}.${column}`);
      }
    }
    for (const column of actualColumns) {
      if (!expectedColumns.has(column)) {
        findings.push(`unknown-column:${tableName}.${column}`);
      }
    }
  }
  for (const tableName of actualTables.keys()) {
    if (!expectedTables.has(tableName))
      findings.push(`unknown-table:${tableName}`);
  }
  const actualIndexes = new Set<string>();
  for (const row of indexesResult.rows) {
    if (typeof row.indexName !== 'string') {
      throw new PostgresSchemaReadinessError('schema_contract_invalid');
    }
    actualIndexes.add(row.indexName);
  }
  const expectedIndexes = new Set(contract.indexes);
  for (const index of expectedIndexes) {
    if (!actualIndexes.has(index)) findings.push(`missing-index:${index}`);
  }
  for (const index of actualIndexes) {
    if (!expectedIndexes.has(index)) findings.push(`unknown-index:${index}`);
  }
  const actualChecks = new Set<string>();
  const actualForeignKeys = new Set<string>();
  for (const row of constraintsResult.rows) {
    if (
      typeof row.constraintName !== 'string' ||
      (row.constraintType !== 'check' && row.constraintType !== 'foreign_key')
    ) {
      throw new PostgresSchemaReadinessError('schema_contract_invalid');
    }
    const target =
      row.constraintType === 'check' ? actualChecks : actualForeignKeys;
    target.add(row.constraintName);
  }
  for (const check of contract.checks) {
    if (!actualChecks.has(check)) findings.push(`missing-check:${check}`);
  }
  for (const check of actualChecks) {
    if (!contract.checks.includes(check))
      findings.push(`unknown-check:${check}`);
  }
  for (const foreignKey of contract.foreignKeys) {
    if (!actualForeignKeys.has(foreignKey)) {
      findings.push(`missing-foreign-key:${foreignKey}`);
    }
  }
  for (const foreignKey of actualForeignKeys) {
    if (!contract.foreignKeys.includes(foreignKey)) {
      findings.push(`unknown-foreign-key:${foreignKey}`);
    }
  }
  if (findings.length > 0) {
    throw new PostgresSchemaReadinessError(
      'schema_contract_invalid',
      sorted(findings),
    );
  }
}

async function assertRuntimeRole(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract,
): Promise<void> {
  const schemaResult = await queryable.query<SchemaPrivilegeRow>(
    `
SELECT
  has_schema_privilege(current_user, $1, 'USAGE') AS "schemaUsage",
  has_schema_privilege(current_user, $1, 'CREATE') AS "schemaCreate"
    `.trim(),
    [contract.schema],
  );
  const schema = schemaResult.rows[0];
  const tableNames = Object.keys(REQUIRED_RUNTIME_PRIVILEGES);
  const tableResult = await queryable.query<TablePrivilegeRow>(
    `
SELECT
  requested.table_name AS "tableName",
  has_table_privilege(current_user, format('%I.%I', $1, requested.table_name), 'SELECT') AS "selectAllowed",
  has_table_privilege(current_user, format('%I.%I', $1, requested.table_name), 'INSERT') AS "insertAllowed",
  has_table_privilege(current_user, format('%I.%I', $1, requested.table_name), 'UPDATE') AS "updateAllowed",
  has_table_privilege(current_user, format('%I.%I', $1, requested.table_name), 'DELETE') AS "deleteAllowed",
  pg_get_userbyid(classes.relowner) = current_user AS "isOwner"
FROM unnest($2::text[]) AS requested(table_name)
JOIN pg_namespace namespaces ON namespaces.nspname = $1
JOIN pg_class classes
  ON classes.relnamespace = namespaces.oid
 AND classes.relname = requested.table_name
ORDER BY requested.table_name
    `.trim(),
    [contract.schema, tableNames],
  );
  const findings: string[] = [];
  if (
    schemaResult.rows.length !== 1 ||
    schema?.schemaUsage !== true ||
    schema?.schemaCreate !== false
  ) {
    findings.push('schema-privileges');
  }
  const privilegesByTable = new Map(
    tableResult.rows.map((row) => [row.tableName, row]),
  );
  for (const tableName of tableNames) {
    const expected =
      REQUIRED_RUNTIME_PRIVILEGES[
        tableName as keyof typeof REQUIRED_RUNTIME_PRIVILEGES
      ];
    const actual = privilegesByTable.get(tableName);
    if (
      !actual ||
      actual.selectAllowed !== expected.select ||
      actual.insertAllowed !== expected.insert ||
      actual.updateAllowed !== expected.update ||
      actual.deleteAllowed !== expected.delete ||
      actual.isOwner !== false
    ) {
      findings.push(`table-privileges:${tableName}`);
    }
  }
  if (privilegesByTable.size !== tableNames.length) {
    findings.push('table-privilege-row-count');
  }
  if (findings.length > 0) {
    throw new PostgresSchemaReadinessError(
      'runtime_role_invalid',
      sorted(findings),
    );
  }
}

export async function assertPostgresSchemaReady(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract = postgresqlControlSchemaContract,
): Promise<PostgresSchemaReadinessReport> {
  const server = await readServer(queryable, contract);
  const migrationIds = await assertHistory(queryable);
  await assertCapability(queryable, contract);
  await assertSchemaContract(queryable, contract);
  await assertRuntimeRole(queryable, contract);
  return Object.freeze({
    ready: true,
    ...server,
    contractName: contract.contractName,
    contractVersion: contract.contractVersion,
    migrationIds,
  });
}
