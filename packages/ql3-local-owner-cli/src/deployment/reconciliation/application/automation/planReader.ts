import { createHash } from 'node:crypto';
import fs from 'node:fs';

import type { ReconciliationAutomationDecisionRequirement } from '@qinglong/local-admin/reconciliation-automation-decision';

import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import { cutoverDigest } from '../../../cutover/targetEvidence';
import type {
  LocalReconciliationAutomationPlanHeader,
  LocalReconciliationAutomationPlanReceipt,
  LocalReconciliationAutomationPlanRow,
} from './rowPlan';

const HEADER_KIND = 'qinglong3-local-reconciliation-automation-plan-header';
const ROW_KIND = 'qinglong3-local-reconciliation-automation-plan-row';
const FOOTER_KIND = 'qinglong3-local-reconciliation-automation-plan-footer';
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

interface FileLine {
  readonly value: Buffer;
  readonly framed: Buffer;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation automation plan reader ${message}`,
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

function parse(line: Buffer, label: string): unknown {
  if (line.length < 2 || line.length > MAX_LINE_BYTES) {
    configurationError(`${label} exceeds its line bound`);
  }
  try {
    return JSON.parse(line.toString('utf8')) as unknown;
  } catch (error) {
    return configurationError(`${label} is not JSON`, error);
  }
}

function* lines(descriptor: number, size: number): Iterable<FileLine> {
  let position = 0;
  let pending = Buffer.alloc(0);
  try {
    while (position < size) {
      const chunk = Buffer.allocUnsafe(
        Math.min(READ_CHUNK_BYTES, size - position),
      );
      const bytesRead = fs.readSync(
        descriptor,
        chunk,
        0,
        chunk.length,
        position,
      );
      if (bytesRead < 1) {
        chunk.fill(0);
        configurationError('file ended unexpectedly');
      }
      position += bytesRead;
      const material = pending.length
        ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        : Buffer.from(chunk.subarray(0, bytesRead));
      pending.fill(0);
      chunk.fill(0);
      let cursor = 0;
      for (;;) {
        const newline = material.indexOf(0x0a, cursor);
        if (newline < 0) break;
        const framed = Buffer.from(material.subarray(cursor, newline + 1));
        const value = Buffer.from(material.subarray(cursor, newline));
        cursor = newline + 1;
        yield { value, framed };
      }
      pending = Buffer.from(material.subarray(cursor));
      material.fill(0);
      if (pending.length > MAX_LINE_BYTES) {
        configurationError('record exceeds its line bound');
      }
    }
    if (pending.length !== 0) configurationError('file is not newline framed');
  } finally {
    pending.fill(0);
  }
}

function header(
  value: unknown,
  receipt: Readonly<LocalReconciliationAutomationPlanReceipt>,
): Readonly<LocalReconciliationAutomationPlanHeader> {
  const record = exact(
    value,
    [
      'applicationId',
      'applicationPlanDigest',
      'automationId',
      'bundleDigest',
      'bundleFingerprintDigest',
      'headerDigest',
      'kind',
      'legacyTimezone',
      'preparedAtMs',
      'preparedHeadDigest',
      'profile',
      'projectId',
      'reviewAuthorizationDigest',
      'reviewDecisionFileDigest',
      'reviewDecisionSetDigest',
      'reviewDigest',
      'schemaVersion',
      'tableDisposition',
    ],
    'header',
  );
  const { headerDigest, ...payload } = record;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== HEADER_KIND ||
    typeof headerDigest !== 'string' ||
    !DIGEST_PATTERN.test(headerDigest) ||
    cutoverDigest(payload) !== headerDigest ||
    record.automationId !== receipt.automationId ||
    record.applicationId !== receipt.applicationId ||
    record.applicationPlanDigest !== receipt.applicationPlanDigest ||
    record.preparedHeadDigest !== receipt.preparedHeadDigest ||
    record.preparedAtMs !== receipt.preparedAtMs ||
    (record.profile !== 'edge' && record.profile !== 'standalone') ||
    typeof record.projectId !== 'string' ||
    (record.legacyTimezone !== null &&
      typeof record.legacyTimezone !== 'string') ||
    (record.tableDisposition !== 'adopt_legacy' &&
      record.tableDisposition !== 'retain_both') ||
    ![
      record.reviewDigest,
      record.reviewAuthorizationDigest,
      record.reviewDecisionSetDigest,
      record.reviewDecisionFileDigest,
      record.bundleDigest,
      record.bundleFingerprintDigest,
    ].every(
      (digest) => typeof digest === 'string' && DIGEST_PATTERN.test(digest),
    )
  ) {
    configurationError('header binding is invalid');
  }
  return Object.freeze(record) as unknown as Readonly<LocalReconciliationAutomationPlanHeader>;
}

function planRow(
  value: unknown,
  expectedOrdinal: number,
): Readonly<LocalReconciliationAutomationPlanRow> {
  const record = exact(
    value,
    [
      'candidateDigest',
      'classification',
      'enabled',
      'kind',
      'proposedTaskId',
      'reasons',
      'requirement',
      'rowOrdinal',
      'rowPlanDigest',
      'schemaVersion',
      'sourceDigest',
      'target',
      'triggerCount',
    ],
    'row',
  );
  const { rowPlanDigest, ...payload } = record;
  const target = record.target;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== ROW_KIND ||
    record.rowOrdinal !== expectedOrdinal ||
    typeof record.sourceDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.sourceDigest) ||
    ![
      'lossless',
      'requires_shell_compatibility',
      'requires_manual_action',
      'malformed',
    ].includes(record.classification as string) ||
    !Array.isArray(record.reasons) ||
    record.reasons.some((reason) => typeof reason !== 'string') ||
    (record.proposedTaskId !== null &&
      typeof record.proposedTaskId !== 'string') ||
    (record.enabled !== null && typeof record.enabled !== 'boolean') ||
    !Number.isSafeInteger(record.triggerCount) ||
    (record.triggerCount as number) < 0 ||
    (record.candidateDigest !== null &&
      (typeof record.candidateDigest !== 'string' ||
        !DIGEST_PATTERN.test(record.candidateDigest))) ||
    !target ||
    typeof target !== 'object' ||
    Array.isArray(target) ||
    !['review_adopt', 'review_skip_conflict', 'manual_required'].includes(
      record.requirement as string,
    ) ||
    typeof rowPlanDigest !== 'string' ||
    !DIGEST_PATTERN.test(rowPlanDigest) ||
    cutoverDigest(payload) !== rowPlanDigest
  ) {
    configurationError('row binding is invalid');
  }
  const targetRecord = target as Record<string, unknown>;
  if (
    (targetRecord.state === 'absent' &&
      Object.keys(targetRecord).sort().join('\0') !== 'state') ||
    (targetRecord.state === 'occupied' &&
      (Object.keys(targetRecord).sort().join('\0') !==
        ['contentDigest', 'revision', 'state'].sort().join('\0') ||
        !Number.isSafeInteger(targetRecord.revision) ||
        (targetRecord.revision as number) < 1 ||
        typeof targetRecord.contentDigest !== 'string' ||
        !DIGEST_PATTERN.test(targetRecord.contentDigest))) ||
    (targetRecord.state !== 'absent' && targetRecord.state !== 'occupied') ||
    (record.requirement === 'review_adopt' &&
      targetRecord.state !== 'absent') ||
    (record.requirement === 'review_skip_conflict' &&
      targetRecord.state !== 'occupied') ||
    (record.requirement === 'manual_required' &&
      record.candidateDigest !== null)
  ) {
    configurationError('row target requirement is invalid');
  }
  return Object.freeze(record) as unknown as Readonly<LocalReconciliationAutomationPlanRow>;
}

export function readLocalReconciliationAutomationPlanHeader(
  filePath: string,
  receipt: Readonly<LocalReconciliationAutomationPlanReceipt>,
  uid: number,
): Readonly<LocalReconciliationAutomationPlanHeader> {
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      (Number(before.mode) & 0o777) !== 0o400 ||
      before.nlink !== 1n ||
      before.size !== BigInt(receipt.planFileBytes)
    ) {
      configurationError('plan header file identity is invalid');
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    ) {
      configurationError('plan header file changed while opening');
    }
    const records = lines(descriptor, Number(opened.size))[Symbol.iterator]();
    const selected = records.next();
    if (selected.done) configurationError('plan header is missing');
    try {
      return header(parse(selected.value.value, 'header'), receipt);
    } finally {
      selected.value.value.fill(0);
      selected.value.framed.fill(0);
      records.return?.();
    }
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('plan header cannot be read', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function createLocalReconciliationAutomationRequirementFactory(
  filePath: string,
  receipt: Readonly<LocalReconciliationAutomationPlanReceipt>,
  uid: number,
): () => Iterable<ReconciliationAutomationDecisionRequirement> {
  return () =>
    (function* (): Iterable<ReconciliationAutomationDecisionRequirement> {
      let descriptor: number | undefined;
      try {
        const before = fs.lstatSync(filePath, { bigint: true });
        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          Number(before.uid) !== uid ||
          (Number(before.mode) & 0o777) !== 0o400 ||
          before.nlink !== 1n ||
          before.size !== BigInt(receipt.planFileBytes)
        ) {
          configurationError('plan file identity is invalid');
        }
        descriptor = fs.openSync(
          filePath,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
        );
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== before.size ||
          opened.mtimeNs !== before.mtimeNs ||
          opened.ctimeNs !== before.ctimeNs
        ) {
          configurationError('plan file changed while opening');
        }
        const fileHash = createHash('sha256');
        const rowHash = createHash('sha256').update(
          'qinglong3.local-reconciliation-automation-row-set.v1\0',
        );
        let parsedHeader: Readonly<LocalReconciliationAutomationPlanHeader> | undefined;
        let rowCount = 0;
        let footerSeen = false;
        for (const selected of lines(descriptor, Number(opened.size))) {
          try {
            fileHash.update(selected.framed);
            const value = parse(selected.value, 'record');
            if (!parsedHeader) {
              parsedHeader = header(value, receipt);
              continue;
            }
            const kind = (value as { readonly kind?: unknown })?.kind;
            if (kind === ROW_KIND && !footerSeen) {
              const row = planRow(value, rowCount + 1);
              rowHash.update(selected.framed);
              rowCount += 1;
              yield Object.freeze({
                rowOrdinal: row.rowOrdinal,
                sourceDigest: row.sourceDigest,
                classification: row.classification,
                requirement: row.requirement,
              });
              continue;
            }
            const footer = exact(
              value,
              [
                'automationId',
                'automationPlanDigest',
                'conflictCount',
                'eligibleCount',
                'kind',
                'legacyInventoryDigest',
                'manualCount',
                'outcome',
                'rowCount',
                'rowSetDigest',
                'schemaVersion',
                'shellCompatibilityCount',
                'triggerCount',
              ],
              'footer',
            );
            const { automationPlanDigest, ...footerPayload } = footer;
            if (
              footerSeen ||
              footer.schemaVersion !== 1 ||
              footer.kind !== FOOTER_KIND ||
              footer.automationId !== receipt.automationId ||
              footer.rowCount !== rowCount ||
              footer.rowCount !== receipt.rowCount ||
              footer.legacyInventoryDigest !== receipt.legacyInventoryDigest ||
              footer.rowSetDigest !== rowHash.digest('hex') ||
              footer.eligibleCount !== receipt.eligibleCount ||
              footer.manualCount !== receipt.manualCount ||
              footer.conflictCount !== receipt.conflictCount ||
              footer.shellCompatibilityCount !==
                receipt.shellCompatibilityCount ||
              footer.triggerCount !== receipt.triggerCount ||
              footer.outcome !== receipt.outcome ||
              automationPlanDigest !== receipt.automationPlanDigest ||
              cutoverDigest({
                headerDigest: parsedHeader.headerDigest,
                ...footerPayload,
              }) !== automationPlanDigest
            ) {
              configurationError('footer binding is invalid');
            }
            footerSeen = true;
          } finally {
            selected.value.fill(0);
            selected.framed.fill(0);
          }
        }
        const after = fs.fstatSync(descriptor, { bigint: true });
        if (
          !parsedHeader ||
          !footerSeen ||
          rowCount !== receipt.rowCount ||
          fileHash.digest('hex') !== receipt.planFileDigest ||
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          after.size !== opened.size ||
          after.mtimeNs !== opened.mtimeNs ||
          after.ctimeNs !== opened.ctimeNs
        ) {
          configurationError('plan file content drifted');
        }
      } catch (error) {
        if (error instanceof LocalDeploymentConfigurationError) throw error;
        configurationError('plan file cannot be read', error);
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
    })();
}
