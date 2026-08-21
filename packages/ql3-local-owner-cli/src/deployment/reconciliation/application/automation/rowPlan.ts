import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import {
  visitLegacyCrontabAdoptionInspections,
  type LegacyCrontabAdoptionInspection,
} from '@qinglong/local-admin/adoption-inspection';

import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import { cutoverDigest } from '../../../cutover/targetEvidence';

const HEADER_KIND = 'qinglong3-local-reconciliation-automation-plan-header';
const ROW_KIND = 'qinglong3-local-reconciliation-automation-plan-row';
const FOOTER_KIND = 'qinglong3-local-reconciliation-automation-plan-footer';
const RECEIPT_SCHEMA =
  'qinglong3-local-reconciliation-automation-plan-receipt';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_LINE_BYTES = 64 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;
export const MAX_EDGE_LOCAL_RECONCILIATION_AUTOMATION_PLAN_BYTES =
  8 * 1024 * 1024;
export const MAX_STANDALONE_LOCAL_RECONCILIATION_AUTOMATION_PLAN_BYTES =
  32 * 1024 * 1024;

export type LocalReconciliationAutomationRowRequirement =
  | 'review_adopt'
  | 'review_skip_conflict'
  | 'manual_required';

export interface LocalReconciliationAutomationPlanHeader {
  readonly schemaVersion: 1;
  readonly kind: typeof HEADER_KIND;
  readonly automationId: string;
  readonly applicationId: string;
  readonly applicationPlanDigest: string;
  readonly reviewDigest: string;
  readonly reviewAuthorizationDigest: string;
  readonly reviewDecisionSetDigest: string;
  readonly reviewDecisionFileDigest: string;
  readonly bundleDigest: string;
  readonly bundleFingerprintDigest: string;
  readonly profile: 'edge' | 'standalone';
  readonly projectId: string;
  readonly legacyTimezone: string | null;
  readonly tableDisposition: 'adopt_legacy' | 'retain_both';
  readonly preparedHeadDigest: string;
  readonly preparedAtMs: number;
  readonly headerDigest: string;
}

export interface LocalReconciliationAutomationPlanRow {
  readonly schemaVersion: 1;
  readonly kind: typeof ROW_KIND;
  readonly rowOrdinal: number;
  readonly sourceDigest: string;
  readonly classification:
    | 'lossless'
    | 'requires_shell_compatibility'
    | 'requires_manual_action'
    | 'malformed';
  readonly reasons: readonly string[];
  readonly proposedTaskId: string | null;
  readonly enabled: boolean | null;
  readonly triggerCount: number;
  readonly candidateDigest: string | null;
  readonly target:
    | Readonly<{ state: 'absent' }>
    | Readonly<{
        state: 'occupied';
        revision: number;
        contentDigest: string;
      }>;
  readonly requirement: LocalReconciliationAutomationRowRequirement;
  readonly rowPlanDigest: string;
}

export interface LocalReconciliationAutomationPlanSummary {
  readonly rowCount: number;
  readonly eligibleCount: number;
  readonly shellCompatibilityCount: number;
  readonly manualCount: number;
  readonly conflictCount: number;
  readonly triggerCount: number;
  readonly outcome: 'ready' | 'manual_required' | 'no_effect';
}

export interface LocalReconciliationAutomationPlanFooter
  extends LocalReconciliationAutomationPlanSummary {
  readonly schemaVersion: 1;
  readonly kind: typeof FOOTER_KIND;
  readonly automationId: string;
  readonly legacyInventoryDigest: string;
  readonly rowSetDigest: string;
  readonly automationPlanDigest: string;
}

export interface LocalReconciliationAutomationPlanReceipt
  extends LocalReconciliationAutomationPlanSummary {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_automation_planned';
  readonly automationId: string;
  readonly applicationId: string;
  readonly applicationPlanDigest: string;
  readonly preparedHeadDigest: string;
  readonly legacyInventoryDigest: string;
  readonly rowSetDigest: string;
  readonly automationPlanDigest: string;
  readonly planFileBytes: number;
  readonly planFileDigest: string;
  readonly preparedAtMs: number;
  readonly receiptDigest: string;
}

export interface WriteLocalReconciliationAutomationPlanOptions {
  readonly descriptor: number;
  readonly maxBytes: number;
  readonly header: Omit<LocalReconciliationAutomationPlanHeader, 'headerDigest'>;
  readonly legacy: DatabaseSync;
  readonly target: DatabaseSync;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation automation row plan ${message}`,
    { cause },
  );
}

function exact(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    configurationError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    configurationError(`${label} shape is invalid`);
  }
  return record;
}

function line(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.byteLength < 3 || bytes.byteLength > MAX_LINE_BYTES + 1) {
    bytes.fill(0);
    configurationError('record exceeds its line bound');
  }
  return bytes;
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = fs.writeSync(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
    );
    if (written < 1) configurationError('write stalled');
    offset += written;
  }
}

function targetTask(
  target: DatabaseSync,
  projectId: string,
  taskId: string,
):
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'occupied'; revision: number; contentDigest: string }> {
  const row = target
    .prepare(
      `SELECT d."current_revision" AS revision,
              r."content_digest" AS contentDigest
       FROM "QingLong3TaskDefinitions" d
       JOIN "QingLong3TaskDefinitionRevisions" r
         ON r."project_id" = d."project_id"
        AND r."task_id" = d."task_id"
        AND r."revision" = d."current_revision"
       WHERE d."project_id" = ? AND d."task_id" = ? LIMIT 1`,
    )
    .get(projectId, taskId) as
    | { readonly revision?: unknown; readonly contentDigest?: unknown }
    | undefined;
  if (!row) return Object.freeze({ state: 'absent' as const });
  if (
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    typeof row.contentDigest !== 'string' ||
    !DIGEST_PATTERN.test(row.contentDigest)
  ) {
    configurationError('target task projection drifted');
  }
  return Object.freeze({
    state: 'occupied' as const,
    revision: row.revision as number,
    contentDigest: row.contentDigest,
  });
}

function row(
  inspection: Readonly<LegacyCrontabAdoptionInspection>,
  target: DatabaseSync,
  projectId: string,
): Readonly<LocalReconciliationAutomationPlanRow> {
  const diagnostic = inspection.diagnostic;
  const selectedTarget =
    diagnostic.taskId === null
      ? Object.freeze({ state: 'absent' as const })
      : targetTask(target, projectId, diagnostic.taskId);
  const candidateDigest = inspection.candidate
    ? cutoverDigest({
        projectId,
        sourceDigest: inspection.candidate.sourceDigest,
        task: inspection.candidate.task,
        triggers: inspection.candidate.triggers,
      })
    : null;
  const requirement: LocalReconciliationAutomationRowRequirement =
    !inspection.candidate
      ? 'manual_required'
      : selectedTarget.state === 'occupied'
        ? 'review_skip_conflict'
        : 'review_adopt';
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: ROW_KIND,
    rowOrdinal: diagnostic.rowOrdinal,
    sourceDigest: diagnostic.sourceDigest,
    classification: diagnostic.classification,
    reasons: diagnostic.reasons,
    proposedTaskId: diagnostic.taskId,
    enabled: diagnostic.enabled,
    triggerCount: diagnostic.triggerCount,
    candidateDigest,
    target: selectedTarget,
    requirement,
  });
  return Object.freeze({ ...payload, rowPlanDigest: cutoverDigest(payload) });
}

export function writeLocalReconciliationAutomationPlan(
  options: Readonly<WriteLocalReconciliationAutomationPlanOptions>,
): Readonly<{
  header: Readonly<LocalReconciliationAutomationPlanHeader>;
  footer: Readonly<LocalReconciliationAutomationPlanFooter>;
  fileBytes: number;
  fileDigest: string;
}> {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < MAX_LINE_BYTES
  ) {
    configurationError('byte budget is invalid');
  }
  const header = Object.freeze({
    ...options.header,
    headerDigest: cutoverDigest(options.header),
  });
  const fileHash = createHash('sha256');
  const rowHash = createHash('sha256').update(
    'qinglong3.local-reconciliation-automation-row-set.v1\0',
  );
  let fileBytes = 0;
  const append = (value: unknown, includeInRows = false): void => {
    const bytes = line(value);
    try {
      if (fileBytes + bytes.byteLength > options.maxBytes) {
        configurationError('exceeds profile byte budget');
      }
      writeAll(options.descriptor, bytes);
      fileHash.update(bytes);
      if (includeInRows) rowHash.update(bytes);
      fileBytes += bytes.byteLength;
    } finally {
      bytes.fill(0);
    }
  };
  append(header);
  let eligibleCount = 0;
  let shellCompatibilityCount = 0;
  let manualCount = 0;
  let conflictCount = 0;
  let triggerCount = 0;
  const inventory = visitLegacyCrontabAdoptionInspections(
    options.legacy,
    header.legacyTimezone,
    (inspection) => {
      const selected = row(inspection, options.target, header.projectId);
      if (selected.requirement === 'review_adopt') eligibleCount += 1;
      if (selected.classification === 'requires_shell_compatibility') {
        shellCompatibilityCount += 1;
      }
      if (selected.requirement === 'manual_required') manualCount += 1;
      if (selected.requirement === 'review_skip_conflict') conflictCount += 1;
      triggerCount += selected.triggerCount;
      append(selected, true);
    },
  );
  const summary: LocalReconciliationAutomationPlanSummary = Object.freeze({
    rowCount: inventory.rowCount,
    eligibleCount,
    shellCompatibilityCount,
    manualCount,
    conflictCount,
    triggerCount,
    outcome:
      inventory.rowCount === 0
        ? ('no_effect' as const)
        : manualCount > 0 || conflictCount > 0
          ? ('manual_required' as const)
          : ('ready' as const),
  });
  const footerPayload = Object.freeze({
    schemaVersion: 1 as const,
    kind: FOOTER_KIND,
    automationId: header.automationId,
    ...summary,
    legacyInventoryDigest: inventory.inventoryDigest,
    rowSetDigest: rowHash.digest('hex'),
  });
  const footer = Object.freeze({
    ...footerPayload,
    automationPlanDigest: cutoverDigest({
      headerDigest: header.headerDigest,
      ...footerPayload,
    }),
  });
  append(footer);
  return Object.freeze({
    header,
    footer,
    fileBytes,
    fileDigest: fileHash.digest('hex'),
  });
}

export function buildLocalReconciliationAutomationPlanReceipt(
  header: Readonly<LocalReconciliationAutomationPlanHeader>,
  footer: Readonly<LocalReconciliationAutomationPlanFooter>,
  planFileBytes: number,
  planFileDigest: string,
): Readonly<LocalReconciliationAutomationPlanReceipt> {
  const payload = Object.freeze({
    schema: RECEIPT_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_automation_planned' as const,
    automationId: header.automationId,
    applicationId: header.applicationId,
    applicationPlanDigest: header.applicationPlanDigest,
    preparedHeadDigest: header.preparedHeadDigest,
    legacyInventoryDigest: footer.legacyInventoryDigest,
    rowSetDigest: footer.rowSetDigest,
    automationPlanDigest: footer.automationPlanDigest,
    planFileBytes,
    planFileDigest,
    rowCount: footer.rowCount,
    eligibleCount: footer.eligibleCount,
    shellCompatibilityCount: footer.shellCompatibilityCount,
    manualCount: footer.manualCount,
    conflictCount: footer.conflictCount,
    triggerCount: footer.triggerCount,
    outcome: footer.outcome,
    preparedAtMs: header.preparedAtMs,
  });
  return Object.freeze({ ...payload, receiptDigest: cutoverDigest(payload) });
}

export function normalizeLocalReconciliationAutomationPlanReceipt(
  value: unknown,
): Readonly<LocalReconciliationAutomationPlanReceipt> {
  const receipt = exact(
    value,
    [
      'applicationId',
      'applicationPlanDigest',
      'automationId',
      'automationPlanDigest',
      'conflictCount',
      'eligibleCount',
      'legacyInventoryDigest',
      'manualCount',
      'outcome',
      'planFileBytes',
      'planFileDigest',
      'preparedHeadDigest',
      'preparedAtMs',
      'receiptDigest',
      'rowCount',
      'rowSetDigest',
      'schema',
      'schemaVersion',
      'shellCompatibilityCount',
      'state',
      'triggerCount',
    ],
    'receipt',
  );
  const { receiptDigest, ...payload } = receipt;
  const counts = [
    receipt.rowCount,
    receipt.eligibleCount,
    receipt.shellCompatibilityCount,
    receipt.manualCount,
    receipt.conflictCount,
    receipt.triggerCount,
    receipt.planFileBytes,
    receipt.preparedAtMs,
  ];
  if (
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.schemaVersion !== 1 ||
    receipt.state !== 'reconciliation_automation_planned' ||
    typeof receipt.automationId !== 'string' ||
    !UUID_V4_PATTERN.test(receipt.automationId) ||
    typeof receipt.applicationId !== 'string' ||
    !UUID_V4_PATTERN.test(receipt.applicationId) ||
    !counts.every((count) => Number.isSafeInteger(count) && (count as number) >= 0) ||
    !['ready', 'manual_required', 'no_effect'].includes(
      receipt.outcome as string,
    ) ||
    [
      receipt.applicationPlanDigest,
      receipt.preparedHeadDigest,
      receipt.legacyInventoryDigest,
      receipt.rowSetDigest,
      receipt.automationPlanDigest,
      receipt.planFileDigest,
      receiptDigest,
    ].some(
      (candidate) =>
        typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate),
    ) ||
    cutoverDigest(payload) !== receiptDigest
  ) {
    configurationError('receipt drifted');
  }
  return Object.freeze(
    receipt,
  ) as unknown as Readonly<LocalReconciliationAutomationPlanReceipt>;
}

export function hashLocalReconciliationAutomationPlanFile(
  descriptor: number,
  expectedBytes: number,
): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let offset = 0;
  while (offset < expectedBytes) {
    const count = fs.readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.byteLength, expectedBytes - offset),
      offset,
    );
    if (count < 1) configurationError('plan file read stalled');
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  return hash.digest('hex');
}
