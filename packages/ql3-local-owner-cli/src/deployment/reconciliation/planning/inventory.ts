import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { LocalDeploymentConfigurationError } from '../../foundation/error';
import {
  LOCAL_RECONCILIATION_PLAN_DOMAINS,
  type LocalReconciliationPlanDomain,
} from './contract';
import {
  withLocalReconciliationSealedDatabase,
  type LocalReconciliationSealedBundle,
  type LocalReconciliationSealedBundleReaderDependencies,
  type LocalReconciliationSealedDatabaseKind,
  type LocalReconciliationSealedDatabaseTopology,
} from '../sealed-bundle/reader';

const MAX_SCHEMA_OBJECTS = 4_096;
const MAX_TABLES = 512;

export interface LocalReconciliationDomainInventory {
  readonly domain: LocalReconciliationPlanDomain;
  readonly schemaObjectCount: number;
  readonly tableCount: number;
  readonly rowCount: number;
  readonly rowCountComplete: boolean;
  readonly inventoryDigest: string;
}

export interface LocalReconciliationDatabaseInventory {
  readonly kind: LocalReconciliationSealedDatabaseKind;
  readonly topology: LocalReconciliationSealedDatabaseTopology['mode'];
  readonly baselineState: 'unchanged' | 'changed';
  readonly opened: boolean;
  readonly integrity: 'ok' | 'manual_required';
  readonly foreignKeys: 'ok' | 'manual_required';
  readonly schemaObjectCount: number;
  readonly tableCount: number;
  readonly rowCount: number;
  readonly rowCountComplete: boolean;
  readonly unsupportedObjectCount: number;
  readonly domains: readonly Readonly<LocalReconciliationDomainInventory>[];
  readonly inventoryDigest: string;
}

export interface LocalReconciliationBundleInventory {
  readonly legacy: Readonly<LocalReconciliationDatabaseInventory>;
  readonly target: Readonly<LocalReconciliationDatabaseInventory>;
  readonly inventoryDigest: string;
}

interface MutableDomainInventory {
  schemaObjectCount: number;
  tableCount: number;
  rowCount: number;
  rowCountComplete: boolean;
  factHash: crypto.Hash;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function digest(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function legacyDomain(name: string): LocalReconciliationPlanDomain {
  if (['Crontabs', 'CrontabViews', 'Subscriptions'].includes(name)) {
    return 'automation';
  }
  if (['Envs', 'Configs'].includes(name)) return 'secret_and_config';
  if (['Auths', 'Users'].includes(name)) return 'identity_policy_audit';
  if (['Dependences', 'Dependencies', 'Apps'].includes(name)) {
    return 'plugin_package';
  }
  if (['CrontabStats', 'Logs'].includes(name)) return 'run_history';
  return 'unknown';
}

function targetDomain(name: string): LocalReconciliationPlanDomain {
  if (name === 'QingLong3SchemaCapabilities' || name.includes('Migration')) {
    return 'schema_lineage';
  }
  if (
    name.includes('TaskDefinition') ||
    name.includes('Trigger') ||
    name.includes('Automation')
  ) {
    return 'automation';
  }
  if (name.includes('Secret') || name.includes('DataDirectoryAdoption')) {
    return 'secret_and_config';
  }
  if (
    name === 'Runs' ||
    name.startsWith('Run') ||
    name.startsWith('StepRun') ||
    name.includes('CompletionReceiptJournal')
  ) {
    return 'run_history';
  }
  if (name.includes('PluginPackage') || name.includes('PackageProposal')) {
    return 'plugin_package';
  }
  if (
    name.includes('Tool') ||
    name.includes('Prompt') ||
    name.includes('Provider') ||
    name.includes('Model')
  ) {
    return 'ai_and_tool';
  }
  if (
    name.includes('Project') ||
    name.includes('RoleBinding') ||
    name.includes('Identity') ||
    name.includes('Credential') ||
    name.includes('Pepper') ||
    name.includes('Approval') ||
    name.includes('ApprovedAction') ||
    name.includes('SecurityAudit') ||
    name.includes('LocalOwner')
  ) {
    return 'identity_policy_audit';
  }
  return 'unknown';
}

function classify(
  kind: LocalReconciliationSealedDatabaseKind,
  name: string,
): LocalReconciliationPlanDomain {
  return kind === 'legacy' ? legacyDomain(name) : targetDomain(name);
}

function quotedIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function addCount(
  current: number,
  countText: string,
): Readonly<{ value: number; complete: boolean }> {
  if (!/^(?:0|[1-9][0-9]*)$/.test(countText)) {
    return configurationError('SQLite row count is invalid');
  }
  const count = BigInt(countText);
  const next = BigInt(current) + count;
  if (next > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Object.freeze({ value: Number.MAX_SAFE_INTEGER, complete: false });
  }
  return Object.freeze({ value: Number(next), complete: true });
}

function emptyDomains(): Map<LocalReconciliationPlanDomain, MutableDomainInventory> {
  return new Map(
    LOCAL_RECONCILIATION_PLAN_DOMAINS.map((domain) => [
      domain,
      {
        schemaObjectCount: 0,
        tableCount: 0,
        rowCount: 0,
        rowCountComplete: true,
        factHash: crypto.createHash('sha256'),
      },
    ]),
  );
}

function finalizeDomains(
  domains: Map<LocalReconciliationPlanDomain, MutableDomainInventory>,
): readonly Readonly<LocalReconciliationDomainInventory>[] {
  return Object.freeze(
    LOCAL_RECONCILIATION_PLAN_DOMAINS.map((domain) => {
      const current = domains.get(domain)!;
      const payload = Object.freeze({
        domain,
        schemaObjectCount: current.schemaObjectCount,
        tableCount: current.tableCount,
        rowCount: current.rowCount,
        rowCountComplete: current.rowCountComplete,
        factDigest: current.factHash.digest('hex'),
      });
      return Object.freeze({
        domain,
        schemaObjectCount: current.schemaObjectCount,
        tableCount: current.tableCount,
        rowCount: current.rowCount,
        rowCountComplete: current.rowCountComplete,
        inventoryDigest: digest(payload),
      });
    }),
  );
}

function manualInventory(
  kind: LocalReconciliationSealedDatabaseKind,
  topology: LocalReconciliationSealedDatabaseTopology['mode'],
  baselineState: 'unchanged' | 'changed',
): Readonly<LocalReconciliationDatabaseInventory> {
  const mutableDomains = emptyDomains();
  for (const domain of mutableDomains.values()) {
    domain.rowCountComplete = false;
  }
  const domains = finalizeDomains(mutableDomains);
  const payload = Object.freeze({
    kind,
    topology,
    baselineState,
    opened: false,
    integrity: 'manual_required' as const,
    foreignKeys: 'manual_required' as const,
    schemaObjectCount: 0,
    tableCount: 0,
    rowCount: 0,
    rowCountComplete: false,
    unsupportedObjectCount: 0,
    domains,
  });
  return Object.freeze({ ...payload, inventoryDigest: digest(payload) });
}

function inspectDatabase(
  client: DatabaseSync,
  kind: LocalReconciliationSealedDatabaseKind,
  topology: LocalReconciliationSealedDatabaseTopology['mode'],
  baselineState: 'unchanged' | 'changed',
): Readonly<LocalReconciliationDatabaseInventory> {
  const quick = client.prepare('PRAGMA quick_check(1)').get() as
    | { readonly quick_check?: unknown }
    | undefined;
  const foreignKeyViolation = client.prepare('PRAGMA foreign_key_check').get();
  const schema = client.prepare(
    `SELECT type, name, tbl_name AS tableName
     FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name
     LIMIT ${MAX_SCHEMA_OBJECTS + 1}`,
  );
  const schemaRows = schema.iterate() as IterableIterator<{
    readonly type?: unknown;
    readonly name?: unknown;
    readonly tableName?: unknown;
  }>;
  const tables = client.prepare(
    `SELECT name, type
     FROM pragma_table_list
     WHERE schema = 'main' AND name NOT LIKE 'sqlite_%'
     ORDER BY name
     LIMIT ${MAX_TABLES + 1}`,
  );
  const tableRows = tables.iterate() as IterableIterator<{
    readonly name?: unknown;
    readonly type?: unknown;
  }>;
  const domains = emptyDomains();
  let unsupportedObjectCount = 0;
  let schemaObjectCount = 0;
  for (const row of schemaRows) {
    schemaObjectCount += 1;
    if (schemaObjectCount > MAX_SCHEMA_OBJECTS) {
      configurationError('sealed SQLite schema object budget is exceeded');
    }
    if (
      typeof row.type !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.tableName !== 'string' ||
      Buffer.byteLength(row.name, 'utf8') > 1_024 ||
      Buffer.byteLength(row.tableName, 'utf8') > 1_024
    ) {
      configurationError('sealed SQLite schema catalog drifted');
    }
    const domain = classify(kind, row.tableName);
    const current = domains.get(domain)!;
    current.schemaObjectCount += 1;
    current.factHash.update(
      `${JSON.stringify({
        type: row.type,
        name: row.name,
        tableName: row.tableName,
      })}\n`,
      'utf8',
    );
    if (!['index', 'table', 'trigger', 'view'].includes(row.type)) {
      unsupportedObjectCount += 1;
    }
  }
  let totalRows = 0;
  let totalRowsComplete = true;
  let tableCount = 0;
  for (const row of tableRows) {
    tableCount += 1;
    if (tableCount > MAX_TABLES) {
      configurationError('sealed SQLite table budget is exceeded');
    }
    if (
      typeof row.name !== 'string' ||
      typeof row.type !== 'string' ||
      Buffer.byteLength(row.name, 'utf8') > 1_024
    ) {
      configurationError('sealed SQLite table catalog drifted');
    }
    const domain = classify(kind, row.name);
    const current = domains.get(domain)!;
    current.tableCount += 1;
    if (row.type !== 'table') {
      current.rowCountComplete = false;
      totalRowsComplete = false;
      unsupportedObjectCount += 1;
      current.factHash.update(
        `${JSON.stringify({ table: row.name, tableType: row.type })}\n`,
        'utf8',
      );
      continue;
    }
    if (domain === 'unknown') {
      current.rowCountComplete = false;
      totalRowsComplete = false;
      current.factHash.update(
        `${JSON.stringify({ table: row.name, countSkipped: true })}\n`,
        'utf8',
      );
      continue;
    }
    const counted = client
      .prepare(
        `SELECT CAST(COUNT(*) AS TEXT) AS countText FROM ${quotedIdentifier(
          row.name,
        )}`,
      )
      .get() as { readonly countText?: unknown } | undefined;
    if (typeof counted?.countText !== 'string') {
      configurationError('sealed SQLite table count drifted');
    }
    const domainCount = addCount(current.rowCount, counted.countText);
    current.rowCount = domainCount.value;
    current.rowCountComplete &&= domainCount.complete;
    const totalCount = addCount(totalRows, counted.countText);
    totalRows = totalCount.value;
    totalRowsComplete &&= totalCount.complete;
    current.factHash.update(
      `${JSON.stringify({ table: row.name, countText: counted.countText })}\n`,
      'utf8',
    );
  }
  const finalized = finalizeDomains(domains);
  const payload = Object.freeze({
    kind,
    topology,
    baselineState,
    opened: true,
    integrity:
      quick?.quick_check === 'ok'
        ? ('ok' as const)
        : ('manual_required' as const),
    foreignKeys:
      foreignKeyViolation === undefined
        ? ('ok' as const)
        : ('manual_required' as const),
    schemaObjectCount,
    tableCount,
    rowCount: totalRows,
    rowCountComplete: totalRowsComplete,
    unsupportedObjectCount,
    domains: finalized,
  });
  return Object.freeze({ ...payload, inventoryDigest: digest(payload) });
}

function baselineState(
  bundle: Readonly<LocalReconciliationSealedBundle>,
  kind: LocalReconciliationSealedDatabaseKind,
): 'unchanged' | 'changed' {
  const main = bundle.manifest.assets.find(
    (asset) => asset.logicalName === `${kind}-main`,
  );
  if (main === undefined) configurationError('sealed bundle main asset is absent');
  const baseline =
    kind === 'legacy'
      ? bundle.manifest.legacyBaselineSha256
      : bundle.manifest.targetBaselineSha256;
  const hasSidecar = bundle.manifest.assets.some((asset) =>
    asset.logicalName.startsWith(`${kind}-`) && asset.logicalName !== `${kind}-main`,
  );
  return main.sha256 === baseline && !hasSidecar ? 'unchanged' : 'changed';
}

function databaseInventory(
  bundle: Readonly<LocalReconciliationSealedBundle>,
  kind: LocalReconciliationSealedDatabaseKind,
  uid: number,
  dependencies: LocalReconciliationSealedBundleReaderDependencies,
): Readonly<LocalReconciliationDatabaseInventory> {
  const selected = kind === 'legacy' ? bundle.legacy : bundle.target;
  const baseline = baselineState(bundle, kind);
  if (selected.mode === 'manual_required') {
    return manualInventory(kind, selected.mode, baseline);
  }
  const inspected = withLocalReconciliationSealedDatabase(
    bundle,
    kind,
    uid,
    dependencies,
    (client) => inspectDatabase(client, kind, selected.mode, baseline),
  );
  if (inspected === null) return manualInventory(kind, selected.mode, baseline);
  return inspected;
}

export function inventoryLocalReconciliationSealedBundle(
  bundle: Readonly<LocalReconciliationSealedBundle>,
  uid: number,
  dependencies: LocalReconciliationSealedBundleReaderDependencies = {},
): Readonly<LocalReconciliationBundleInventory> {
  const legacy = databaseInventory(bundle, 'legacy', uid, dependencies);
  const target = databaseInventory(bundle, 'target', uid, dependencies);
  const payload = Object.freeze({
    bundleDigest: bundle.receipt.bundleDigest,
    legacy,
    target,
  });
  return Object.freeze({ legacy, target, inventoryDigest: digest(payload) });
}
