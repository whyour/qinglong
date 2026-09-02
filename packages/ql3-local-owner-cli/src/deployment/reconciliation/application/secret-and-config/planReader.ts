import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import { cutoverDigest } from '../../../cutover/targetEvidence';
import type {
  LocalReconciliationSecretConfigCandidateRequirement,
  LocalReconciliationSecretConfigPlanHeader,
  LocalReconciliationSecretConfigPlanReceipt,
} from './rowPlan';

const HEADER_KIND = 'qinglong3-local-reconciliation-secret-config-plan-header';
const ROW_KIND = 'qinglong3-local-reconciliation-secret-config-plan-row';
const CANDIDATE_KIND =
  'qinglong3-local-reconciliation-secret-config-plan-candidate';
const FOOTER_KIND = 'qinglong3-local-reconciliation-secret-config-plan-footer';
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

interface FileLine {
  readonly value: Buffer;
  readonly framed: Buffer;
}

export interface LocalReconciliationSecretConfigDecisionRequirement {
  readonly candidateOrdinal: number;
  readonly candidateType: 'active_binding' | 'disabled_preservation';
  readonly candidateDigest: string;
  readonly sourceSetDigest: string;
  readonly proposedSecretName: string;
  readonly requirement: LocalReconciliationSecretConfigCandidateRequirement;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation secret config plan reader ${message}`,
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
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(line),
    ) as unknown;
  } catch (error) {
    return configurationError(`${label} is not UTF-8 JSON`, error);
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
        yield Object.freeze({ value, framed });
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

function candidate(
  value: unknown,
  expectedOrdinal: number,
): Readonly<LocalReconciliationSecretConfigDecisionRequirement> {
  const record = exact(
    value,
    [
      'candidateDigest',
      'candidateOrdinal',
      'candidatePlanDigest',
      'candidateType',
      'kind',
      'proposedSecretName',
      'requirement',
      'schemaVersion',
      'sourceRowCount',
      'sourceSetDigest',
      'target',
    ],
    'candidate',
  );
  const { candidatePlanDigest, ...payload } = record;
  const target = record.target as Record<string, unknown> | undefined;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== CANDIDATE_KIND ||
    record.candidateOrdinal !== expectedOrdinal ||
    (record.candidateType !== 'active_binding' &&
      record.candidateType !== 'disabled_preservation') ||
    typeof record.candidateDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.candidateDigest) ||
    !Number.isSafeInteger(record.sourceRowCount) ||
    (record.sourceRowCount as number) < 1 ||
    typeof record.sourceSetDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.sourceSetDigest) ||
    typeof record.proposedSecretName !== 'string' ||
    record.proposedSecretName.length < 1 ||
    ![
      'review_apply_binding',
      'review_preserve_disabled',
      'review_skip_conflict',
    ].includes(record.requirement as string) ||
    !target ||
    Array.isArray(target) ||
    typeof candidatePlanDigest !== 'string' ||
    !DIGEST_PATTERN.test(candidatePlanDigest) ||
    cutoverDigest(payload) !== candidatePlanDigest
  ) {
    configurationError('candidate binding is invalid');
  }
  const targetKeys = Object.keys(target).sort().join('\0');
  if (
    (target.state === 'absent' && targetKeys !== 'state') ||
    (target.state === 'occupied' &&
      (targetKeys !== ['contentDigest', 'state', 'version'].sort().join('\0') ||
        !Number.isSafeInteger(target.version) ||
        (target.version as number) < 1 ||
        typeof target.contentDigest !== 'string' ||
        !DIGEST_PATTERN.test(target.contentDigest))) ||
    (target.state !== 'absent' && target.state !== 'occupied') ||
    (record.requirement === 'review_skip_conflict' &&
      target.state !== 'occupied') ||
    (record.requirement !== 'review_skip_conflict' &&
      target.state !== 'absent') ||
    (record.requirement === 'review_apply_binding' &&
      record.candidateType !== 'active_binding') ||
    (record.requirement === 'review_preserve_disabled' &&
      record.candidateType !== 'disabled_preservation')
  ) {
    configurationError('candidate target requirement is invalid');
  }
  return Object.freeze({
    candidateOrdinal: record.candidateOrdinal as number,
    candidateType: record.candidateType as
      | 'active_binding'
      | 'disabled_preservation',
    candidateDigest: record.candidateDigest,
    sourceSetDigest: record.sourceSetDigest,
    proposedSecretName: record.proposedSecretName as string,
    requirement:
      record.requirement as LocalReconciliationSecretConfigCandidateRequirement,
  });
}

function header(
  value: unknown,
  receipt: Readonly<LocalReconciliationSecretConfigPlanReceipt>,
): Readonly<LocalReconciliationSecretConfigPlanHeader> {
  const record = exact(
    value,
    [
      'applicationId',
      'applicationPlanDigest',
      'bundleDigest',
      'bundleFingerprintDigest',
      'headerDigest',
      'kind',
      'preparedAtMs',
      'preparedHeadDigest',
      'profile',
      'projectId',
      'reviewAuthorizationDigest',
      'reviewDecisionFileDigest',
      'reviewDecisionSetDigest',
      'reviewDigest',
      'schemaVersion',
      'secretConfigId',
      'tableDisposition',
      'targetSnapshotSha256',
      'unadaptedLegacyConfigCount',
    ],
    'header',
  );
  const { headerDigest, ...payload } = record;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== HEADER_KIND ||
    record.secretConfigId !== receipt.secretConfigId ||
    record.applicationId !== receipt.applicationId ||
    record.applicationPlanDigest !== receipt.applicationPlanDigest ||
    record.preparedHeadDigest !== receipt.preparedHeadDigest ||
    record.preparedAtMs !== receipt.preparedAtMs ||
    (record.profile !== 'edge' && record.profile !== 'standalone') ||
    typeof record.projectId !== 'string' ||
    record.projectId.length < 1 ||
    (record.tableDisposition !== 'absent' &&
      record.tableDisposition !== 'manual_external') ||
    (record.targetSnapshotSha256 !== null &&
      (typeof record.targetSnapshotSha256 !== 'string' ||
        !DIGEST_PATTERN.test(record.targetSnapshotSha256))) ||
    !Number.isSafeInteger(record.unadaptedLegacyConfigCount) ||
    (record.unadaptedLegacyConfigCount as number) < 0 ||
    ![
      record.applicationPlanDigest,
      record.bundleDigest,
      record.bundleFingerprintDigest,
      record.reviewAuthorizationDigest,
      record.reviewDecisionFileDigest,
      record.reviewDecisionSetDigest,
      record.reviewDigest,
      record.preparedHeadDigest,
      headerDigest,
    ].every(
      (selected) =>
        typeof selected === 'string' && DIGEST_PATTERN.test(selected),
    ) ||
    cutoverDigest(payload) !== headerDigest
  ) {
    configurationError('header binding is invalid');
  }
  return record as unknown as Readonly<LocalReconciliationSecretConfigPlanHeader>;
}

export function readLocalReconciliationSecretConfigPlanHeader(
  filePath: string,
  receipt: Readonly<LocalReconciliationSecretConfigPlanReceipt>,
  uid: number,
): Readonly<LocalReconciliationSecretConfigPlanHeader> {
  let descriptor: number | undefined;
  const bytes = Buffer.allocUnsafe(MAX_LINE_BYTES + 1);
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
    const bytesRead = fs.readSync(
      descriptor,
      bytes,
      0,
      Math.min(bytes.length, Number(opened.size)),
      0,
    );
    const newline = bytes.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 2 || newline > MAX_LINE_BYTES) {
      configurationError('header is missing or exceeds its line bound');
    }
    const selected = header(
      parse(bytes.subarray(0, newline), 'header'),
      receipt,
    );
    const after = fs.fstatSync(descriptor, { bigint: true });
    const linked = fs.lstatSync(filePath, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      linked.dev !== opened.dev ||
      linked.ino !== opened.ino ||
      linked.size !== opened.size ||
      linked.mtimeNs !== opened.mtimeNs ||
      linked.ctimeNs !== opened.ctimeNs
    ) {
      configurationError('plan file changed while reading header');
    }
    return selected;
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('plan header cannot be read', error);
  } finally {
    bytes.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function createLocalReconciliationSecretConfigDecisionRequirementFactory(
  filePath: string,
  receipt: Readonly<LocalReconciliationSecretConfigPlanReceipt>,
  uid: number,
): () => Iterable<LocalReconciliationSecretConfigDecisionRequirement> {
  return () =>
    (function* (): Iterable<LocalReconciliationSecretConfigDecisionRequirement> {
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
        const candidateHash = createHash('sha256').update(
          'qinglong3.local-reconciliation-secret-config-candidate-set.v1\0',
        );
        let headerSeen = false;
        let footerSeen = false;
        let candidateCount = 0;
        for (const selected of lines(descriptor, Number(opened.size))) {
          try {
            fileHash.update(selected.framed);
            const value = parse(selected.value, 'record');
            const kind = (value as { readonly kind?: unknown })?.kind;
            if (!headerSeen) {
              header(value, receipt);
              headerSeen = true;
              continue;
            }
            if (footerSeen) configurationError('record follows footer');
            if (kind === ROW_KIND) continue;
            if (kind === CANDIDATE_KIND) {
              const requirement = candidate(value, candidateCount + 1);
              candidateHash.update(selected.framed);
              candidateCount += 1;
              yield requirement;
              continue;
            }
            const footer = exact(
              value,
              [
                'activeGroupCount',
                'activeRowCount',
                'adoptedLegacyTaskCount',
                'adoptedLegacyTriggerCount',
                'adoptionProvenanceTaskCount',
                'adoptionProvenanceTriggerCount',
                'automationAdoptionRecordCount',
                'automationAdoptionProvenanceState',
                'automationAdoptionSetDigest',
                'bindingReadyCount',
                'candidateSetDigest',
                'disabledRowCount',
                'eligibleBindingCount',
                'eligiblePreservationCount',
                'kind',
                'legacyInventoryDigest',
                'manualGroupCount',
                'manualRowCount',
                'outcome',
                'preservationReadyCount',
                'rowCount',
                'rowSetDigest',
                'schemaVersion',
                'secretConfigId',
                'secretConfigPlanDigest',
                'tableState',
                'targetConflictCount',
                'unadaptedLegacyConfigCount',
              ],
              'footer',
            );
            if (
              footer.schemaVersion !== 1 ||
              footer.kind !== FOOTER_KIND ||
              footer.secretConfigId !== receipt.secretConfigId ||
              footer.secretConfigPlanDigest !==
                receipt.secretConfigPlanDigest ||
              footer.candidateSetDigest !== candidateHash.digest('hex') ||
              footer.candidateSetDigest !== receipt.candidateSetDigest ||
              footer.eligibleBindingCount !== receipt.eligibleBindingCount ||
              footer.eligiblePreservationCount !==
                receipt.eligiblePreservationCount ||
              footer.targetConflictCount !== receipt.targetConflictCount ||
              footer.automationAdoptionRecordCount !==
                receipt.automationAdoptionRecordCount ||
              footer.adoptedLegacyTaskCount !==
                receipt.adoptedLegacyTaskCount ||
              footer.adoptedLegacyTriggerCount !==
                receipt.adoptedLegacyTriggerCount ||
              footer.adoptionProvenanceTaskCount !==
                receipt.adoptionProvenanceTaskCount ||
              footer.adoptionProvenanceTriggerCount !==
                receipt.adoptionProvenanceTriggerCount ||
              footer.automationAdoptionProvenanceState !==
                receipt.automationAdoptionProvenanceState ||
              footer.outcome !== receipt.outcome ||
              candidateCount !==
                receipt.eligibleBindingCount +
                  receipt.eligiblePreservationCount +
                  receipt.targetConflictCount
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
          !headerSeen ||
          !footerSeen ||
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
