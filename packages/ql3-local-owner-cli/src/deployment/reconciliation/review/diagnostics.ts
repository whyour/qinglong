import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { LocalDeploymentConfigurationError } from '../../foundation/error';
import { validatePrivateDirectory } from '../../foundation/files';
import { cutoverDigest } from '../../cutover/targetEvidence';
import { classifyLocalReconciliationFact } from '../planning/inventory';
import type { LocalReconciliationPlanDomain } from '../planning/contract';
import type {
  LocalReconciliationSealedBundle,
  LocalReconciliationSealedDatabaseKind,
} from '../sealed-bundle/reader';
import type {
  LocalReconciliationDiagnosticFactKind,
  LocalReconciliationReviewDiagnosticsCommand,
} from './contract';

const PAGE_SCHEMA = 'qinglong3-local-reconciliation-diagnostic-page';
const FACT_SCHEMA = 'qinglong3-local-reconciliation-diagnostic-fact';
const MAX_PAGE_BYTES = 256 * 1024;
const MAX_NAME_BYTES = 1_024;

export type LocalReconciliationDiagnosticDecisionRequirement =
  | 'informational'
  | 'required'
  | 'blocked';

export type LocalReconciliationDiagnosticReason =
  | 'catalog_evidence'
  | 'reviewable_fact'
  | 'unknown_schema'
  | 'secret_custody_required'
  | 'historical_preservation_required'
  | 'historical_integrity_required'
  | 'identity_custody_required';

export interface LocalReconciliationDiagnosticFact {
  readonly schema: typeof FACT_SCHEMA;
  readonly schemaVersion: 1;
  readonly ordinal: number;
  readonly database: LocalReconciliationSealedDatabaseKind;
  readonly domain: LocalReconciliationPlanDomain;
  readonly factKind: LocalReconciliationDiagnosticFactKind;
  readonly objectType: string;
  readonly name: string;
  readonly tableName: string;
  readonly rowCount: string | null;
  readonly decisionRequirement: LocalReconciliationDiagnosticDecisionRequirement;
  readonly reason: LocalReconciliationDiagnosticReason;
  readonly factDigest: string;
}

export interface LocalReconciliationDiagnosticPage {
  readonly schema: typeof PAGE_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_review_prepared';
  readonly reviewId: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly preparationDigest: string;
  readonly bundleDigest: string;
  readonly bundleFingerprintDigest: string;
  readonly database: LocalReconciliationSealedDatabaseKind;
  readonly domain: LocalReconciliationPlanDomain;
  readonly factKind: LocalReconciliationDiagnosticFactKind;
  readonly offset: number;
  readonly limit: number;
  readonly recordCount: number;
  readonly complete: boolean;
  readonly nextOffset: number | null;
  readonly records: readonly Readonly<LocalReconciliationDiagnosticFact>[];
  readonly pageDigest: string;
}

export interface BuildLocalReconciliationDiagnosticPageOptions {
  readonly reviewId: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly preparationDigest: string;
  readonly bundle: Readonly<LocalReconciliationSealedBundle>;
  readonly command: Readonly<LocalReconciliationReviewDiagnosticsCommand>;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function quotedIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function targetRunHistoryIsTerminal(client: DatabaseSync): boolean {
  const tables = new Map<string, Set<string>>();
  for (const tableName of ['Runs', 'RunAttempts', 'StepRuns'] as const) {
    const table = client
      .prepare(
        `SELECT 1 AS present
         FROM sqlite_schema
         WHERE type = 'table' AND name = ?
         LIMIT 1`,
      )
      .get(tableName) as { readonly present?: unknown } | undefined;
    if (table?.present !== 1) continue;
    const columns = new Set<string>();
    const rows = client
      .prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid LIMIT 257`)
      .iterate(tableName) as IterableIterator<{ readonly name?: unknown }>;
    let count = 0;
    for (const row of rows) {
      count += 1;
      if (
        count > 256 ||
        typeof row.name !== 'string' ||
        Buffer.byteLength(row.name, 'utf8') > MAX_NAME_BYTES
      ) {
        return false;
      }
      columns.add(row.name);
    }
    tables.set(tableName, columns);
  }
  const runs = tables.get('Runs');
  if (!runs?.has('status') || !runs.has('finished_at_ms')) return false;
  const activeRun = client
    .prepare(
      `SELECT 1 AS present
       FROM "Runs"
       WHERE status NOT IN ('succeeded','failed','cancelled','timed_out')
          OR finished_at_ms IS NULL
       LIMIT 1`,
    )
    .get() as { readonly present?: unknown } | undefined;
  if (activeRun?.present === 1) return false;
  const attempts = tables.get('RunAttempts');
  if (attempts !== undefined) {
    if (!attempts.has('status')) return false;
    const activeAttempt = client
      .prepare(
        `SELECT 1 AS present
         FROM "RunAttempts"
         WHERE status IN ('claimed','starting','running')
         LIMIT 1`,
      )
      .get() as { readonly present?: unknown } | undefined;
    if (activeAttempt?.present === 1) return false;
  }
  const steps = tables.get('StepRuns');
  if (steps !== undefined) {
    if (!steps.has('status') || !steps.has('finished_at_ms')) return false;
    const activeStep = client
      .prepare(
        `SELECT 1 AS present
         FROM "StepRuns"
         WHERE status NOT IN ('succeeded','failed','skipped','cancelled','timed_out')
            OR finished_at_ms IS NULL
         LIMIT 1`,
      )
      .get() as { readonly present?: unknown } | undefined;
    if (activeStep?.present === 1) return false;
  }
  return true;
}

function requirement(
  client: DatabaseSync,
  database: LocalReconciliationSealedDatabaseKind,
  domain: LocalReconciliationPlanDomain,
): Readonly<{
  decisionRequirement: LocalReconciliationDiagnosticDecisionRequirement;
  reason: LocalReconciliationDiagnosticReason;
}> {
  if (domain === 'unknown') {
    return Object.freeze({
      decisionRequirement: 'blocked' as const,
      reason: 'unknown_schema' as const,
    });
  }
  if (domain === 'secret_and_config') {
    return Object.freeze({
      decisionRequirement: 'blocked' as const,
      reason: 'secret_custody_required' as const,
    });
  }
  if (domain === 'run_history') {
    if (database === 'legacy' || targetRunHistoryIsTerminal(client)) {
      return Object.freeze({
        decisionRequirement: 'required' as const,
        reason: 'historical_preservation_required' as const,
      });
    }
    return Object.freeze({
      decisionRequirement: 'blocked' as const,
      reason: 'historical_integrity_required' as const,
    });
  }
  if (domain === 'identity_policy_audit') {
    return Object.freeze({
      decisionRequirement: 'blocked' as const,
      reason: 'identity_custody_required' as const,
    });
  }
  if (domain === 'schema_lineage') {
    return Object.freeze({
      decisionRequirement: 'informational' as const,
      reason: 'catalog_evidence' as const,
    });
  }
  return Object.freeze({
    decisionRequirement: 'required' as const,
    reason: 'reviewable_fact' as const,
  });
}

function rowCount(
  client: DatabaseSync,
  domain: LocalReconciliationPlanDomain,
  tableName: string,
  objectType: string,
): string | null {
  if (domain === 'unknown' || objectType !== 'table') return null;
  const counted = client
    .prepare(
      `SELECT CAST(COUNT(*) AS TEXT) AS countText FROM ${quotedIdentifier(
        tableName,
      )}`,
    )
    .get() as { readonly countText?: unknown } | undefined;
  if (
    typeof counted?.countText !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(counted.countText)
  ) {
    configurationError('diagnostic table row count drifted');
  }
  return counted.countText;
}

function fact(
  ordinal: number,
  database: LocalReconciliationSealedDatabaseKind,
  domain: LocalReconciliationPlanDomain,
  factKind: LocalReconciliationDiagnosticFactKind,
  objectType: string,
  name: string,
  tableName: string,
  count: string | null,
  review: Readonly<{
    decisionRequirement: LocalReconciliationDiagnosticDecisionRequirement;
    reason: LocalReconciliationDiagnosticReason;
  }>,
): Readonly<LocalReconciliationDiagnosticFact> {
  const payload = Object.freeze({
    schema: FACT_SCHEMA,
    schemaVersion: 1 as const,
    ordinal,
    database,
    domain,
    factKind,
    objectType,
    name,
    tableName,
    rowCount: count,
    decisionRequirement: review.decisionRequirement,
    reason: review.reason,
  });
  return Object.freeze({ ...payload, factDigest: cutoverDigest(payload) });
}

function schemaFacts(
  client: DatabaseSync,
  database: LocalReconciliationSealedDatabaseKind,
  domain: LocalReconciliationPlanDomain,
  offset: number,
  limit: number,
): Readonly<{
  records: readonly Readonly<LocalReconciliationDiagnosticFact>[];
  complete: boolean;
}> {
  const review = requirement(client, database, domain);
  const rows = client
    .prepare(
      `SELECT type, name, tbl_name AS tableName
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name
       LIMIT 4097`,
    )
    .iterate() as IterableIterator<{
    readonly type?: unknown;
    readonly name?: unknown;
    readonly tableName?: unknown;
  }>;
  const records: LocalReconciliationDiagnosticFact[] = [];
  let seen = 0;
  let catalog = 0;
  let complete = true;
  for (const row of rows) {
    catalog += 1;
    if (catalog > 4_096)
      configurationError('diagnostic schema budget is exceeded');
    if (
      typeof row.type !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.tableName !== 'string' ||
      Buffer.byteLength(row.name, 'utf8') > MAX_NAME_BYTES ||
      Buffer.byteLength(row.tableName, 'utf8') > MAX_NAME_BYTES
    ) {
      configurationError('diagnostic schema catalog drifted');
    }
    if (classifyLocalReconciliationFact(database, row.tableName) !== domain) {
      continue;
    }
    const ordinal = seen + 1;
    seen += 1;
    if (seen <= offset) continue;
    if (records.length >= limit) {
      complete = false;
      break;
    }
    records.push(
      fact(
        ordinal,
        database,
        domain,
        'schema_object',
        row.type,
        row.name,
        row.tableName,
        null,
        review,
      ),
    );
  }
  return Object.freeze({ records: Object.freeze(records), complete });
}

function tableFacts(
  client: DatabaseSync,
  database: LocalReconciliationSealedDatabaseKind,
  domain: LocalReconciliationPlanDomain,
  offset: number,
  limit: number,
): Readonly<{
  records: readonly Readonly<LocalReconciliationDiagnosticFact>[];
  complete: boolean;
}> {
  const review = requirement(client, database, domain);
  const rows = client
    .prepare(
      `SELECT name, type
       FROM pragma_table_list
       WHERE schema = 'main' AND name NOT LIKE 'sqlite_%'
       ORDER BY name
       LIMIT 513`,
    )
    .iterate() as IterableIterator<{
    readonly name?: unknown;
    readonly type?: unknown;
  }>;
  const records: LocalReconciliationDiagnosticFact[] = [];
  let seen = 0;
  let catalog = 0;
  let complete = true;
  for (const row of rows) {
    catalog += 1;
    if (catalog > 512)
      configurationError('diagnostic table budget is exceeded');
    if (
      typeof row.name !== 'string' ||
      typeof row.type !== 'string' ||
      Buffer.byteLength(row.name, 'utf8') > MAX_NAME_BYTES
    ) {
      configurationError('diagnostic table catalog drifted');
    }
    if (classifyLocalReconciliationFact(database, row.name) !== domain)
      continue;
    const ordinal = seen + 1;
    seen += 1;
    if (seen <= offset) continue;
    if (records.length >= limit) {
      complete = false;
      break;
    }
    records.push(
      fact(
        ordinal,
        database,
        domain,
        'table',
        row.type,
        row.name,
        row.name,
        rowCount(client, domain, row.name, row.type),
        review,
      ),
    );
  }
  return Object.freeze({ records: Object.freeze(records), complete });
}

export function buildLocalReconciliationDiagnosticPage(
  client: DatabaseSync,
  options: Readonly<BuildLocalReconciliationDiagnosticPageOptions>,
): Readonly<LocalReconciliationDiagnosticPage> {
  const request = options.command.request;
  const selected =
    request.factKind === 'schema_object'
      ? schemaFacts(
          client,
          request.database,
          request.domain,
          request.offset,
          request.limit,
        )
      : tableFacts(
          client,
          request.database,
          request.domain,
          request.offset,
          request.limit,
        );
  const nextOffset = selected.complete
    ? null
    : request.offset + selected.records.length;
  const payload = Object.freeze({
    schema: PAGE_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_review_prepared' as const,
    reviewId: options.reviewId,
    planId: options.planId,
    planDigest: options.planDigest,
    preparationDigest: options.preparationDigest,
    bundleDigest: options.bundle.receipt.bundleDigest,
    bundleFingerprintDigest: options.bundle.fingerprintDigest,
    database: request.database,
    domain: request.domain,
    factKind: request.factKind,
    offset: request.offset,
    limit: request.limit,
    recordCount: selected.records.length,
    complete: selected.complete,
    nextOffset,
    records: selected.records,
  });
  const page = Object.freeze({
    ...payload,
    pageDigest: cutoverDigest(payload),
  });
  if (
    Buffer.byteLength(`${JSON.stringify(page, null, 2)}\n`, 'utf8') >
    MAX_PAGE_BYTES
  ) {
    configurationError('diagnostic page exceeds its 256 KiB budget');
  }
  return page;
}

/**
 * Re-derives the complete bounded fact sequence without trusting diagnostic
 * page files. One database descriptor is held by the caller and each query is
 * bounded by the same catalog ceilings as diagnostics.
 */
export function visitLocalReconciliationDiagnosticFacts(
  client: DatabaseSync,
  database: LocalReconciliationSealedDatabaseKind,
  visitor: (fact: Readonly<LocalReconciliationDiagnosticFact>) => void,
): void {
  for (const domain of [
    'schema_lineage',
    'automation',
    'secret_and_config',
    'run_history',
    'plugin_package',
    'ai_and_tool',
    'identity_policy_audit',
    'unknown',
  ] as const satisfies readonly LocalReconciliationPlanDomain[]) {
    for (const factKind of ['schema_object', 'table'] as const) {
      let offset = 0;
      while (true) {
        const selected =
          factKind === 'schema_object'
            ? schemaFacts(client, database, domain, offset, 64)
            : tableFacts(client, database, domain, offset, 64);
        for (const record of selected.records) visitor(record);
        if (selected.complete) break;
        if (selected.records.length < 1) {
          configurationError('diagnostic canonical sequence did not advance');
        }
        offset += selected.records.length;
      }
    }
  }
}

function pageBytes(page: Readonly<LocalReconciliationDiagnosticPage>): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(page, null, 2)}\n`, 'utf8');
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_PAGE_BYTES) {
    configurationError('diagnostic page has an invalid size');
  }
  return bytes;
}

function pageFile(
  filePath: string,
  bytes: Buffer,
  uid: number,
  allowedLinks: readonly number[],
  label: string,
): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    return configurationError(`${label} is unavailable`, error);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o600 ||
    !allowedLinks.includes(stat.nlink) ||
    stat.size !== bytes.byteLength ||
    !fs.readFileSync(filePath).equals(bytes)
  ) {
    configurationError(`${label} identity or content drifted`);
  }
  return stat;
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeStage(stagePath: string, bytes: Buffer, uid: number): void {
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(
      stagePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    fs.fchmodSync(descriptor, 0o600);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1) {
      configurationError('diagnostic page stage identity drifted');
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = fs.writeSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
      );
      if (written < 1) configurationError('diagnostic page write stalled');
      offset += written;
    }
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (created) {
      try {
        fs.unlinkSync(stagePath);
      } catch {
        // A failed cleanup leaves a deterministic fail-closed stage.
      }
    }
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    configurationError('diagnostic page stage cannot be written', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function publishLocalReconciliationDiagnosticPage(
  outputPath: string,
  page: Readonly<LocalReconciliationDiagnosticPage>,
  uid: number,
): 'prepared' | 'existing' {
  const parent = path.dirname(outputPath);
  validatePrivateDirectory(parent, uid, 'diagnosticOutputParent');
  const bytes = pageBytes(page);
  const stagePath = path.join(
    parent,
    `.${path.basename(outputPath)}.ql3-review-page-stage`,
  );
  const existed = fs.existsSync(outputPath);
  if (existed) pageFile(outputPath, bytes, uid, [1, 2], 'diagnostic page');
  if (fs.existsSync(stagePath)) {
    pageFile(stagePath, bytes, uid, [1, 2], 'diagnostic page stage');
  } else if (!existed) {
    writeStage(stagePath, bytes, uid);
  }
  if (!fs.existsSync(outputPath)) {
    try {
      fs.linkSync(stagePath, outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        configurationError('diagnostic page cannot be published', error);
      }
    }
    syncDirectory(parent);
  }
  const target = pageFile(outputPath, bytes, uid, [1, 2], 'diagnostic page');
  if (fs.existsSync(stagePath)) {
    const stage = pageFile(
      stagePath,
      bytes,
      uid,
      [1, 2],
      'diagnostic page stage',
    );
    if (target.dev !== stage.dev || target.ino !== stage.ino) {
      configurationError('diagnostic page stage identity drifted');
    }
    fs.unlinkSync(stagePath);
    syncDirectory(parent);
  }
  pageFile(outputPath, bytes, uid, [1], 'diagnostic page');
  return existed ? 'existing' : 'prepared';
}
