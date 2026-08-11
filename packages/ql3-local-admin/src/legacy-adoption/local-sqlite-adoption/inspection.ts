import { DatabaseSync } from 'node:sqlite';

import type { LocalSqliteProfile } from '@qinglong/local-sqlite/runtime';
import type { LegacyCrontabAdoptionInventory } from '../legacyCrontabAdoption';
import {
  DIGEST_PATTERN,
  MAX_SCHEMA_OBJECTS,
  LocalSqliteAdoptionError,
  type InspectLegacyCrontabDiagnosticsOptions,
  type InspectLegacySqliteOptions,
  type LegacySqliteAdoptionPlan,
  type LegacySqliteCatalogEvidence,
  type ReviewedLegacyCrontabAdoptionDiagnosticPage,
  type FileIdentity,
} from './contracts';
import {
  assertAbsolutePath,
  assertProfile,
  assertRealParent,
  assertRegularFile,
  fileIdentity,
  sameFileIdentity,
  sha256Text,
} from './filesystem';

type LegacyCrontabAdoptionModule = typeof import('../legacyCrontabAdoption');

export function legacyCrontabAdoptionModule(): LegacyCrontabAdoptionModule {
  return require('../legacyCrontabAdoption') as LegacyCrontabAdoptionModule;
}

const MAX_SCHEMA_SQL_BYTES = 16 * 1024 * 1024;
const LEGACY_SENTINELS = Object.freeze({
  Auths: Object.freeze(['id', 'type', 'info']),
  Crontabs: Object.freeze(['id', 'command', 'schedule']),
  Envs: Object.freeze(['id', 'name', 'value']),
});
const CONFLICTING_QL3_OBJECTS = new Set([
  'QingLong3SchemaCapabilities',
  'QingLong3SchemaMigrations',
  'RunAttempts',
  'RunEvents',
  'RunRetryPolicies',
  'Runs',
]);

type SchemaObjectType = 'index' | 'table' | 'trigger' | 'view';

interface SchemaObjectRow {
  type: unknown;
  name: unknown;
  table_name: unknown;
  sql: unknown;
}

export function isCanonicalLegacyTimezone(value: string): boolean {
  try {
    return (
      legacyCrontabAdoptionModule().normalizeLegacyAdoptionTimezone(value) ===
      value
    );
  } catch {
    return false;
  }
}

function requiredText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1024 ||
    /[\0\r\n]/.test(value)
  ) {
    throw new LocalSqliteAdoptionError(`${label} is invalid`);
  }
  return value;
}

export function catalogEvidence(
  client: DatabaseSync,
): LegacySqliteCatalogEvidence {
  const quickCheck = client.prepare('PRAGMA quick_check(1)').get();
  if (!quickCheck || Object.values(quickCheck)[0] !== 'ok') {
    throw new LocalSqliteAdoptionError('source quick_check failed');
  }
  if (client.prepare('SELECT * FROM pragma_foreign_key_check LIMIT 1').get()) {
    throw new LocalSqliteAdoptionError('source foreign_key_check failed');
  }
  const rows = client
    .prepare(
      `SELECT type, name, tbl_name AS table_name, sql
       FROM sqlite_schema
       WHERE type IN ('table', 'index', 'trigger', 'view')
       ORDER BY type, name`,
    )
    .all() as unknown as SchemaObjectRow[];
  if (rows.length < 1 || rows.length > MAX_SCHEMA_OBJECTS) {
    throw new LocalSqliteAdoptionError(
      'source schema object budget is invalid',
    );
  }
  let sqlBytes = 0;
  const canonicalRows = rows.map((row) => {
    const type = requiredText(
      row.type,
      'schema object type',
    ) as SchemaObjectType;
    if (!['index', 'table', 'trigger', 'view'].includes(type)) {
      throw new LocalSqliteAdoptionError('schema object type is unsupported');
    }
    const name = requiredText(row.name, 'schema object name');
    const tableName = requiredText(row.table_name, 'schema table name');
    if (CONFLICTING_QL3_OBJECTS.has(name)) {
      throw new LocalSqliteAdoptionError(
        `source already contains conflicting 3.0 object ${name}`,
      );
    }
    if (row.sql !== null && typeof row.sql !== 'string') {
      throw new LocalSqliteAdoptionError('schema SQL is invalid');
    }
    const sql = row.sql as string | null;
    sqlBytes += Buffer.byteLength(sql ?? '');
    if (sqlBytes > MAX_SCHEMA_SQL_BYTES) {
      throw new LocalSqliteAdoptionError('source schema SQL budget exceeded');
    }
    return Object.freeze({ type, name, tableName, sql });
  });
  const tableNames = canonicalRows
    .filter(({ type }) => type === 'table')
    .map(({ name }) => name)
    .sort();
  for (const [tableName, requiredColumns] of Object.entries(LEGACY_SENTINELS)) {
    if (!tableNames.includes(tableName)) {
      throw new LocalSqliteAdoptionError(
        `legacy table ${tableName} is missing`,
      );
    }
    const columns = (
      client.prepare(`PRAGMA table_info("${tableName}")`).all() as unknown as {
        name?: unknown;
      }[]
    ).map(({ name }) => requiredText(name, `${tableName} column`));
    for (const column of requiredColumns) {
      if (!columns.includes(column)) {
        throw new LocalSqliteAdoptionError(
          `legacy column ${tableName}.${column} is missing`,
        );
      }
    }
  }
  return Object.freeze({
    digest: sha256Text(JSON.stringify(canonicalRows)),
    objectCount: canonicalRows.length,
    tableNames: Object.freeze(tableNames),
  });
}

export function openLegacySource(sourcePath: string): DatabaseSync {
  const client = new DatabaseSync(sourcePath, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: 5_000,
  });
  try {
    client.enableDefensive(true);
    client.exec('PRAGMA trusted_schema = OFF');
    client.exec('PRAGMA query_only = ON');
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

function planPayload(
  profile: LocalSqliteProfile,
  source: FileIdentity,
  catalog: LegacySqliteCatalogEvidence,
  tasks: LegacyCrontabAdoptionInventory,
): Omit<LegacySqliteAdoptionPlan, 'planDigest'> {
  return Object.freeze({
    schemaVersion: 2 as const,
    kind: 'qinglong3-local-sqlite-adoption-plan' as const,
    profile,
    source,
    catalog,
    tasks,
  });
}

export function inspectLegacySqlitePath(
  options: InspectLegacySqliteOptions,
): LegacySqliteAdoptionPlan {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new LocalSqliteAdoptionError('inspection options are invalid');
  }
  assertProfile(options.profile);
  assertAbsolutePath(options.sourcePath, 'sourcePath');
  assertRealParent(options.sourcePath, 'source');
  assertRegularFile(options.sourcePath, 'source');
  let timezone: string | null;
  try {
    timezone = legacyCrontabAdoptionModule().normalizeLegacyAdoptionTimezone(
      options.legacyTimezone,
    );
  } catch (error) {
    throw new LocalSqliteAdoptionError('legacy timezone is invalid', error);
  }
  const client = openLegacySource(options.sourcePath);
  try {
    const sourceBefore = fileIdentity(options.sourcePath);
    const payload = planPayload(
      options.profile,
      sourceBefore,
      catalogEvidence(client),
      legacyCrontabAdoptionModule().inspectLegacyCrontabInventory(
        client,
        timezone,
      ),
    );
    const sourceAfter = fileIdentity(options.sourcePath);
    if (!sameFileIdentity(sourceBefore, sourceAfter)) {
      throw new LocalSqliteAdoptionError(
        'source changed during task inspection',
      );
    }
    return Object.freeze({
      ...payload,
      planDigest: sha256Text(JSON.stringify(payload)),
    });
  } catch (error) {
    if (error instanceof LocalSqliteAdoptionError) throw error;
    throw new LocalSqliteAdoptionError('source inspection failed', error);
  } finally {
    client.close();
  }
}

export function inspectLegacyCrontabAdoptionDiagnostics(
  options: InspectLegacyCrontabDiagnosticsOptions,
): ReviewedLegacyCrontabAdoptionDiagnosticPage {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new LocalSqliteAdoptionError('diagnostic options are invalid');
  }
  if (!DIGEST_PATTERN.test(options.expectedPlanDigest)) {
    throw new LocalSqliteAdoptionError('expectedPlanDigest is invalid');
  }
  const plan = inspectLegacySqlitePath(options);
  if (plan.planDigest !== options.expectedPlanDigest) {
    throw new LocalSqliteAdoptionError(
      'source no longer matches the reviewed plan',
    );
  }
  const client = openLegacySource(options.sourcePath);
  try {
    const sourceBefore = fileIdentity(options.sourcePath);
    const page =
      legacyCrontabAdoptionModule().inspectLegacyCrontabDiagnosticPage(
        client,
        plan.tasks.timezone,
        {
          ...(options.afterRowOrdinal === undefined
            ? {}
            : { afterRowOrdinal: options.afterRowOrdinal }),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        },
      );
    const sourceAfter = fileIdentity(options.sourcePath);
    if (
      !sameFileIdentity(sourceBefore, sourceAfter) ||
      page.inventory.inventoryDigest !== plan.tasks.inventoryDigest
    ) {
      throw new LocalSqliteAdoptionError(
        'source changed during diagnostic inspection',
      );
    }
    return Object.freeze({
      ...page,
      reviewedPlanDigest: plan.planDigest,
    });
  } catch (error) {
    if (error instanceof LocalSqliteAdoptionError) throw error;
    throw new LocalSqliteAdoptionError('task diagnostics failed', error);
  } finally {
    client.close();
  }
}
