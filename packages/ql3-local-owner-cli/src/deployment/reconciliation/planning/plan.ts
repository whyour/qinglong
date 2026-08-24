import { LocalDeploymentConfigurationError } from '../../foundation/error';
import { cutoverDigest } from '../../cutover/targetEvidence';
import {
  LOCAL_RECONCILIATION_PLAN_DOMAINS,
  type LocalReconciliationPlanDisposition,
  type LocalReconciliationPlanDomain,
} from './contract';
import type { LocalReconciliationBundleInventory } from './inventory';
import type { LocalReconciliationPlanIntent } from './preparation';

const PLAN_SCHEMA = 'qinglong3-local-reconciliation-plan';
const RECEIPT_SCHEMA = 'qinglong3-local-reconciliation-plan-receipt';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMEZONE_PATTERN = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;
const MAX_PLAN_BYTES = 64 * 1024;

export interface LocalReconciliationPlanDomainSummary {
  readonly domain: LocalReconciliationPlanDomain;
  readonly legacySchemaObjects: number;
  readonly targetSchemaObjects: number;
  readonly legacyTables: number;
  readonly targetTables: number;
  readonly legacyRows: number;
  readonly targetRows: number;
  readonly rowCountsComplete: boolean;
  readonly inventoryDigest: string;
  readonly disposition: LocalReconciliationPlanDisposition;
}

export interface LocalReconciliationPlanDatabaseSummary {
  readonly kind: 'legacy' | 'target';
  readonly topology:
    | 'main_only_immutable'
    | 'wal_shm_readonly'
    | 'manual_required';
  readonly baselineState: 'unchanged' | 'changed';
  readonly opened: boolean;
  readonly integrity: 'ok' | 'manual_required';
  readonly foreignKeys: 'ok' | 'manual_required';
  readonly schemaObjectCount: number;
  readonly tableCount: number;
  readonly rowCount: number;
  readonly rowCountComplete: boolean;
  readonly unsupportedObjectCount: number;
  readonly inventoryDigest: string;
}

export interface LocalReconciliationPlan {
  readonly schema: typeof PLAN_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_planned';
  readonly planId: string;
  readonly captureId: string;
  readonly profile: 'edge' | 'standalone';
  readonly preparationDigest: string;
  readonly bundleDigest: string;
  readonly legacyTimezone: string | null;
  readonly committedAtMs: number;
  readonly databases: readonly [
    Readonly<LocalReconciliationPlanDatabaseSummary>,
    Readonly<LocalReconciliationPlanDatabaseSummary>,
  ];
  readonly domains: readonly Readonly<LocalReconciliationPlanDomainSummary>[];
  readonly inventoryDigest: string;
  readonly outcome: 'review_required' | 'manual_required';
  readonly planDigest: string;
}

export interface LocalReconciliationPlanReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_planned';
  readonly planId: string;
  readonly captureId: string;
  readonly preparationDigest: string;
  readonly bundleDigest: string;
  readonly planDigest: string;
  readonly outcome: 'review_required' | 'manual_required';
  readonly domainCount: 8;
  readonly committedAtMs: number;
  readonly receiptDigest: string;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    configurationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    configurationError(`${label} shape is invalid`);
  }
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function summary(
  inventory: LocalReconciliationBundleInventory['legacy'],
): Readonly<LocalReconciliationPlanDatabaseSummary> {
  return Object.freeze({
    kind: inventory.kind,
    topology: inventory.topology,
    baselineState: inventory.baselineState,
    opened: inventory.opened,
    integrity: inventory.integrity,
    foreignKeys: inventory.foreignKeys,
    schemaObjectCount: inventory.schemaObjectCount,
    tableCount: inventory.tableCount,
    rowCount: inventory.rowCount,
    rowCountComplete: inventory.rowCountComplete,
    unsupportedObjectCount: inventory.unsupportedObjectCount,
    inventoryDigest: inventory.inventoryDigest,
  });
}

function domainDisposition(
  domain: LocalReconciliationPlanDomain,
  legacy: LocalReconciliationBundleInventory['legacy']['domains'][number],
  target: LocalReconciliationBundleInventory['target']['domains'][number],
  inventory: Readonly<LocalReconciliationBundleInventory>,
  legacyTimezone: string | null,
): LocalReconciliationPlanDisposition {
  const legacyFacts = legacy.schemaObjectCount + legacy.tableCount;
  const targetFacts = target.schemaObjectCount + target.tableCount;
  if (
    inventory.legacy.topology === 'manual_required' ||
    inventory.target.topology === 'manual_required' ||
    inventory.legacy.integrity !== 'ok' ||
    inventory.target.integrity !== 'ok' ||
    inventory.legacy.foreignKeys !== 'ok' ||
    inventory.target.foreignKeys !== 'ok'
  ) {
    return 'manual_required';
  }
  if (
    domain === 'unknown' &&
    legacy.schemaObjectCount +
      legacy.tableCount +
      target.schemaObjectCount +
      target.tableCount >
      0
  ) {
    return 'manual_required';
  }
  if (
    !legacy.rowCountComplete ||
    !target.rowCountComplete ||
    inventory.legacy.unsupportedObjectCount > 0 ||
    inventory.target.unsupportedObjectCount > 0
  ) {
    return 'unsupported';
  }
  if (domain === 'identity_policy_audit' && legacyFacts > 0) {
    return 'manual_required';
  }
  if (
    (domain === 'secret_and_config' || domain === 'run_history') &&
    legacyFacts + targetFacts > 0
  ) {
    return 'manual_required';
  }
  if (domain === 'automation' && legacyTimezone !== null && targetFacts > 0) {
    return 'manual_required';
  }
  if (legacyFacts === 0 && targetFacts === 0) return 'aligned';
  if (legacyFacts === 0) return 'target_only';
  if (targetFacts === 0) return 'legacy_changed';
  if (
    inventory.legacy.baselineState === 'unchanged' &&
    inventory.target.baselineState === 'unchanged'
  ) {
    return 'aligned';
  }
  if (
    inventory.legacy.baselineState === 'changed' &&
    inventory.target.baselineState === 'unchanged'
  ) {
    return 'legacy_changed';
  }
  if (
    inventory.legacy.baselineState === 'unchanged' &&
    inventory.target.baselineState === 'changed'
  ) {
    return 'target_changed';
  }
  return 'diverged';
}

export function buildLocalReconciliationPlan(
  intent: Readonly<LocalReconciliationPlanIntent>,
  inventory: Readonly<LocalReconciliationBundleInventory>,
  committedAtMs: number,
): Readonly<LocalReconciliationPlan> {
  const domains = Object.freeze(
    LOCAL_RECONCILIATION_PLAN_DOMAINS.map((domain, index) => {
      const legacy = inventory.legacy.domains[index]!;
      const target = inventory.target.domains[index]!;
      if (legacy.domain !== domain || target.domain !== domain) {
        configurationError('reconciliation inventory domain ordering drifted');
      }
      const disposition = domainDisposition(
        domain,
        legacy,
        target,
        inventory,
        intent.command.request.legacyTimezone,
      );
      const inventoryDigest = cutoverDigest({
        domain,
        legacyInventoryDigest: legacy.inventoryDigest,
        targetInventoryDigest: target.inventoryDigest,
      });
      return Object.freeze({
        domain,
        legacySchemaObjects: legacy.schemaObjectCount,
        targetSchemaObjects: target.schemaObjectCount,
        legacyTables: legacy.tableCount,
        targetTables: target.tableCount,
        legacyRows: legacy.rowCount,
        targetRows: target.rowCount,
        rowCountsComplete:
          legacy.rowCountComplete && target.rowCountComplete,
        inventoryDigest,
        disposition,
      });
    }),
  );
  const outcome = domains.some(
    (domain) =>
      domain.disposition === 'manual_required' ||
      domain.disposition === 'unsupported',
  )
    ? ('manual_required' as const)
    : ('review_required' as const);
  const payload = Object.freeze({
    schema: PLAN_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_planned' as const,
    planId: intent.command.request.planId,
    captureId: intent.command.request.captureId,
    profile: intent.profile,
    preparationDigest: intent.preparationDigest,
    bundleDigest: intent.command.request.expectedBundleDigest,
    legacyTimezone: intent.command.request.legacyTimezone,
    committedAtMs,
    databases: Object.freeze([
      summary(inventory.legacy),
      summary(inventory.target),
    ]) as LocalReconciliationPlan['databases'],
    domains,
    inventoryDigest: inventory.inventoryDigest,
    outcome,
  });
  const plan = Object.freeze({ ...payload, planDigest: cutoverDigest(payload) });
  if (Buffer.byteLength(`${JSON.stringify(plan, null, 2)}\n`, 'utf8') > MAX_PLAN_BYTES) {
    configurationError('reconciliation plan exceeds the 64 KiB budget');
  }
  return plan;
}

function normalizeDatabaseSummary(
  value: unknown,
  expectedKind: 'legacy' | 'target',
): Readonly<LocalReconciliationPlanDatabaseSummary> {
  const database = object(value, 'reconciliation plan database summary');
  exact(
    database,
    [
      'baselineState',
      'foreignKeys',
      'integrity',
      'inventoryDigest',
      'kind',
      'opened',
      'rowCount',
      'rowCountComplete',
      'schemaObjectCount',
      'tableCount',
      'topology',
      'unsupportedObjectCount',
    ],
    'reconciliation plan database summary',
  );
  if (
    database.kind !== expectedKind ||
    !['main_only_immutable', 'wal_shm_readonly', 'manual_required'].includes(
      database.topology as string,
    ) ||
    !['unchanged', 'changed'].includes(database.baselineState as string) ||
    typeof database.opened !== 'boolean' ||
    !['ok', 'manual_required'].includes(database.integrity as string) ||
    !['ok', 'manual_required'].includes(database.foreignKeys as string) ||
    !safeCount(database.schemaObjectCount) ||
    !safeCount(database.tableCount) ||
    !safeCount(database.rowCount) ||
    typeof database.rowCountComplete !== 'boolean' ||
    !safeCount(database.unsupportedObjectCount) ||
    typeof database.inventoryDigest !== 'string' ||
    !DIGEST_PATTERN.test(database.inventoryDigest)
  ) {
    configurationError('reconciliation plan database summary drifted');
  }
  if (
    (database.topology === 'manual_required' && database.opened) ||
    (database.topology !== 'manual_required' && !database.opened)
  ) {
    configurationError('reconciliation plan database open evidence drifted');
  }
  return Object.freeze(
    database,
  ) as unknown as Readonly<LocalReconciliationPlanDatabaseSummary>;
}

function normalizeDomainSummary(
  value: unknown,
  expectedDomain: LocalReconciliationPlanDomain,
): Readonly<LocalReconciliationPlanDomainSummary> {
  const domain = object(value, 'reconciliation plan domain summary');
  exact(
    domain,
    [
      'disposition',
      'domain',
      'inventoryDigest',
      'legacyRows',
      'legacySchemaObjects',
      'legacyTables',
      'rowCountsComplete',
      'targetRows',
      'targetSchemaObjects',
      'targetTables',
    ],
    'reconciliation plan domain summary',
  );
  if (
    domain.domain !== expectedDomain ||
    ![
      'aligned',
      'legacy_changed',
      'target_changed',
      'diverged',
      'target_only',
      'manual_required',
      'unsupported',
    ].includes(domain.disposition as string) ||
    !safeCount(domain.legacySchemaObjects) ||
    !safeCount(domain.targetSchemaObjects) ||
    !safeCount(domain.legacyTables) ||
    !safeCount(domain.targetTables) ||
    !safeCount(domain.legacyRows) ||
    !safeCount(domain.targetRows) ||
    typeof domain.rowCountsComplete !== 'boolean' ||
    typeof domain.inventoryDigest !== 'string' ||
    !DIGEST_PATTERN.test(domain.inventoryDigest)
  ) {
    configurationError('reconciliation plan domain summary drifted');
  }
  return Object.freeze(
    domain,
  ) as unknown as Readonly<LocalReconciliationPlanDomainSummary>;
}

export function normalizeLocalReconciliationPlan(
  value: unknown,
): Readonly<LocalReconciliationPlan> {
  const plan = object(value, 'reconciliation plan');
  exact(
    plan,
    [
      'bundleDigest',
      'captureId',
      'committedAtMs',
      'databases',
      'domains',
      'inventoryDigest',
      'legacyTimezone',
      'outcome',
      'planDigest',
      'planId',
      'preparationDigest',
      'profile',
      'schema',
      'schemaVersion',
      'state',
    ],
    'reconciliation plan',
  );
  const rawDatabases = plan.databases;
  const rawDomains = plan.domains;
  if (!Array.isArray(rawDatabases) || !Array.isArray(rawDomains)) {
    configurationError('reconciliation plan summaries must be arrays');
  }
  const databases = Object.freeze([
    normalizeDatabaseSummary(rawDatabases[0], 'legacy'),
    normalizeDatabaseSummary(rawDatabases[1], 'target'),
  ]) as LocalReconciliationPlan['databases'];
  const domains = Object.freeze(
    LOCAL_RECONCILIATION_PLAN_DOMAINS.map((domain, index) =>
      normalizeDomainSummary(rawDomains[index], domain),
    ),
  );
  const { planDigest, ...payload } = plan;
  if (
    plan.schema !== PLAN_SCHEMA ||
    plan.schemaVersion !== 1 ||
    plan.state !== 'reconciliation_planned' ||
    typeof plan.planId !== 'string' ||
    !UUID_V4_PATTERN.test(plan.planId) ||
    typeof plan.captureId !== 'string' ||
    !UUID_V4_PATTERN.test(plan.captureId) ||
    rawDatabases.length !== 2 ||
    rawDomains.length !== 8 ||
    (plan.profile !== 'edge' && plan.profile !== 'standalone') ||
    !Number.isSafeInteger(plan.committedAtMs) ||
    (plan.committedAtMs as number) < 0 ||
    (plan.legacyTimezone !== null &&
      (typeof plan.legacyTimezone !== 'string' ||
        !TIMEZONE_PATTERN.test(plan.legacyTimezone) ||
        Buffer.byteLength(plan.legacyTimezone, 'utf8') > 128)) ||
    (plan.outcome !== 'review_required' && plan.outcome !== 'manual_required') ||
    [
      plan.preparationDigest,
      plan.bundleDigest,
      plan.inventoryDigest,
      planDigest,
    ].some(
      (candidate) =>
        typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate),
    ) ||
    cutoverDigest(payload) !== planDigest
  ) {
    configurationError('reconciliation plan drifted');
  }
  const derivedOutcome = domains.some(
    (domain) =>
      domain.disposition === 'manual_required' ||
      domain.disposition === 'unsupported',
  )
    ? 'manual_required'
    : 'review_required';
  if (plan.outcome !== derivedOutcome) {
    configurationError('reconciliation plan outcome drifted');
  }
  const sum = (values: readonly number[]): bigint =>
    values.reduce((total, value) => total + BigInt(value), 0n);
  if (
    sum(domains.map((domain) => domain.legacySchemaObjects)) !==
      BigInt(databases[0].schemaObjectCount) ||
    sum(domains.map((domain) => domain.targetSchemaObjects)) !==
      BigInt(databases[1].schemaObjectCount) ||
    sum(domains.map((domain) => domain.legacyTables)) !==
      BigInt(databases[0].tableCount) ||
    sum(domains.map((domain) => domain.targetTables)) !==
      BigInt(databases[1].tableCount) ||
    (databases[0].rowCountComplete &&
      sum(domains.map((domain) => domain.legacyRows)) !==
        BigInt(databases[0].rowCount)) ||
    (databases[1].rowCountComplete &&
      sum(domains.map((domain) => domain.targetRows)) !==
        BigInt(databases[1].rowCount)) ||
    (databases[0].rowCountComplete &&
      databases[1].rowCountComplete &&
      domains.some((domain) => !domain.rowCountsComplete))
  ) {
    configurationError('reconciliation plan aggregate summary drifted');
  }
  return Object.freeze({
    ...(plan as unknown as LocalReconciliationPlan),
    databases,
    domains,
  });
}

export function localReconciliationPlanReceipt(
  plan: Readonly<LocalReconciliationPlan>,
): Readonly<LocalReconciliationPlanReceipt> {
  const payload = Object.freeze({
    schema: RECEIPT_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_planned' as const,
    planId: plan.planId,
    captureId: plan.captureId,
    preparationDigest: plan.preparationDigest,
    bundleDigest: plan.bundleDigest,
    planDigest: plan.planDigest,
    outcome: plan.outcome,
    domainCount: 8 as const,
    committedAtMs: plan.committedAtMs,
  });
  return Object.freeze({ ...payload, receiptDigest: cutoverDigest(payload) });
}

export function normalizeLocalReconciliationPlanReceipt(
  value: unknown,
): Readonly<LocalReconciliationPlanReceipt> {
  const receipt = object(value, 'reconciliation plan receipt');
  exact(
    receipt,
    [
      'bundleDigest',
      'captureId',
      'committedAtMs',
      'domainCount',
      'outcome',
      'planDigest',
      'planId',
      'preparationDigest',
      'receiptDigest',
      'schema',
      'schemaVersion',
      'state',
    ],
    'reconciliation plan receipt',
  );
  const { receiptDigest, ...payload } = receipt;
  if (
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.schemaVersion !== 1 ||
    receipt.state !== 'reconciliation_planned' ||
    typeof receipt.planId !== 'string' ||
    !UUID_V4_PATTERN.test(receipt.planId) ||
    typeof receipt.captureId !== 'string' ||
    !UUID_V4_PATTERN.test(receipt.captureId) ||
    receipt.domainCount !== 8 ||
    (receipt.outcome !== 'review_required' &&
      receipt.outcome !== 'manual_required') ||
    !Number.isSafeInteger(receipt.committedAtMs) ||
    (receipt.committedAtMs as number) < 0 ||
    [
      receipt.preparationDigest,
      receipt.bundleDigest,
      receipt.planDigest,
      receiptDigest,
    ].some(
      (candidate) =>
        typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate),
    ) ||
    cutoverDigest(payload) !== receiptDigest
  ) {
    configurationError('reconciliation plan receipt drifted');
  }
  return receipt as unknown as Readonly<LocalReconciliationPlanReceipt>;
}
