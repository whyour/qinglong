import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import type { LocalReconciliationSecretConfigDecisionRequirement } from './planReader';

const HEADER_KIND =
  'qinglong3-local-reconciliation-secret-config-decision-header';
const DECISION_KIND = 'qinglong3-local-reconciliation-secret-config-decision';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_LINE_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
export const MAX_EDGE_LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_BYTES =
  1 * 1024 * 1024;
export const MAX_STANDALONE_LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_BYTES =
  4 * 1024 * 1024;

export const LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_DISPOSITIONS =
  Object.freeze(['apply_active_binding', 'preserve_disabled', 'skip'] as const);
export type LocalReconciliationSecretConfigDecisionDisposition =
  (typeof LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_DISPOSITIONS)[number];

export const LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_REASONS =
  Object.freeze([
    'reviewed_active_binding',
    'reviewed_disabled_preservation',
    'operator_excluded',
    'target_conflict',
    'security_review_required',
  ] as const);
export type LocalReconciliationSecretConfigDecisionReason =
  (typeof LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_REASONS)[number];

export interface LocalReconciliationSecretConfigDecisionHeader {
  readonly schemaVersion: 1;
  readonly kind: typeof HEADER_KIND;
  readonly decisionContractVersion: 1;
  readonly decisionId: string;
  readonly profile: 'edge' | 'standalone';
  readonly secretConfigPlanDigest: string;
  readonly preparationDigest: string;
}

export interface LocalReconciliationSecretConfigDecision {
  readonly schemaVersion: 1;
  readonly kind: typeof DECISION_KIND;
  readonly candidateOrdinal: number;
  readonly candidateDigest: string;
  readonly disposition: LocalReconciliationSecretConfigDecisionDisposition;
  readonly reason: LocalReconciliationSecretConfigDecisionReason;
}

export interface LocalReconciliationSecretConfigDecisionFileEvidence {
  readonly fileBytes: number;
  readonly fileDigest: string;
  readonly decisionCount: number;
}

export interface LocalReconciliationSecretConfigDecisionCursor {
  readonly header: Readonly<LocalReconciliationSecretConfigDecisionHeader>;
  next(): Readonly<LocalReconciliationSecretConfigDecision> | null;
}

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNs: bigint;
  readonly changedAtNs: bigint;
  readonly uid: number;
  readonly mode: number;
  readonly links: bigint;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation secret config decision file ${message}`,
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
  if (line.byteLength < 2 || line.byteLength > MAX_LINE_BYTES) {
    configurationError(`${label} line bound is invalid`);
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(line),
    ) as unknown;
  } catch (error) {
    return configurationError(`${label} is not UTF-8 JSON`, error);
  }
}

function header(
  value: unknown,
  expected: Readonly<{
    decisionId: string;
    profile: 'edge' | 'standalone';
    secretConfigPlanDigest: string;
    preparationDigest: string;
  }>,
): Readonly<LocalReconciliationSecretConfigDecisionHeader> {
  const record = exact(
    value,
    [
      'decisionContractVersion',
      'decisionId',
      'kind',
      'preparationDigest',
      'profile',
      'schemaVersion',
      'secretConfigPlanDigest',
    ],
    'header',
  );
  if (
    record.schemaVersion !== 1 ||
    record.kind !== HEADER_KIND ||
    record.decisionContractVersion !== 1 ||
    typeof record.decisionId !== 'string' ||
    !UUID_V7_PATTERN.test(record.decisionId) ||
    (record.profile !== 'edge' && record.profile !== 'standalone') ||
    typeof record.secretConfigPlanDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.secretConfigPlanDigest) ||
    typeof record.preparationDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.preparationDigest) ||
    record.decisionId !== expected.decisionId ||
    record.profile !== expected.profile ||
    record.secretConfigPlanDigest !== expected.secretConfigPlanDigest ||
    record.preparationDigest !== expected.preparationDigest
  ) {
    configurationError('header binding is invalid');
  }
  return Object.freeze(
    record,
  ) as unknown as Readonly<LocalReconciliationSecretConfigDecisionHeader>;
}

function decision(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigDecision> {
  const record = exact(
    value,
    [
      'candidateDigest',
      'candidateOrdinal',
      'disposition',
      'kind',
      'reason',
      'schemaVersion',
    ],
    'decision',
  );
  if (
    record.schemaVersion !== 1 ||
    record.kind !== DECISION_KIND ||
    !Number.isSafeInteger(record.candidateOrdinal) ||
    (record.candidateOrdinal as number) < 1 ||
    typeof record.candidateDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.candidateDigest) ||
    !LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_DISPOSITIONS.includes(
      record.disposition as LocalReconciliationSecretConfigDecisionDisposition,
    ) ||
    !LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_REASONS.includes(
      record.reason as LocalReconciliationSecretConfigDecisionReason,
    )
  ) {
    configurationError('decision is invalid');
  }
  const allowed: Record<
    LocalReconciliationSecretConfigDecisionDisposition,
    readonly LocalReconciliationSecretConfigDecisionReason[]
  > = {
    apply_active_binding: ['reviewed_active_binding'],
    preserve_disabled: ['reviewed_disabled_preservation'],
    skip: ['operator_excluded', 'target_conflict', 'security_review_required'],
  };
  if (
    !allowed[
      record.disposition as LocalReconciliationSecretConfigDecisionDisposition
    ].includes(record.reason as LocalReconciliationSecretConfigDecisionReason)
  ) {
    configurationError('decision reason does not match disposition');
  }
  return Object.freeze(
    record,
  ) as unknown as Readonly<LocalReconciliationSecretConfigDecision>;
}

export function normalizeLocalReconciliationSecretConfigDecision(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigDecision> {
  return decision(value);
}

export function assertLocalReconciliationSecretConfigDecisionMatchesRequirement(
  selected: Readonly<LocalReconciliationSecretConfigDecision>,
  requirement: Readonly<LocalReconciliationSecretConfigDecisionRequirement>,
): void {
  if (
    selected.candidateOrdinal !== requirement.candidateOrdinal ||
    selected.candidateDigest !== requirement.candidateDigest
  ) {
    configurationError('decision sequence does not match canonical candidates');
  }
  if (
    (requirement.requirement === 'review_apply_binding' &&
      selected.disposition !== 'apply_active_binding' &&
      selected.disposition !== 'skip') ||
    (requirement.requirement === 'review_preserve_disabled' &&
      selected.disposition !== 'preserve_disabled' &&
      selected.disposition !== 'skip') ||
    (requirement.requirement === 'review_skip_conflict' &&
      (selected.disposition !== 'skip' ||
        !['target_conflict', 'security_review_required'].includes(
          selected.reason,
        )))
  ) {
    configurationError('decision is not allowed for canonical candidate');
  }
}

function identity(stat: fs.BigIntStats): FileIdentity {
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAtNs: stat.mtimeNs,
    changedAtNs: stat.ctimeNs,
    uid: Number(stat.uid),
    mode: Number(stat.mode) & 0o777,
    links: stat.nlink,
  });
}

function same(left: FileIdentity, right: FileIdentity): boolean {
  return Object.keys(left).every(
    (key) =>
      left[key as keyof FileIdentity] === right[key as keyof FileIdentity],
  );
}

export function withLocalReconciliationSecretConfigDecisionFile<T>(
  filePath: string,
  expected: Readonly<{
    decisionId: string;
    profile: 'edge' | 'standalone';
    secretConfigPlanDigest: string;
    preparationDigest: string;
  }>,
  consume: (cursor: LocalReconciliationSecretConfigDecisionCursor) => T,
): Readonly<{
  result: T;
  evidence: Readonly<LocalReconciliationSecretConfigDecisionFileEvidence>;
  confirmIdentity(): void;
}> {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid !== process.geteuid?.()) {
    configurationError('requires stable POSIX identity');
  }
  const parentPath = path.dirname(filePath);
  const parentBefore = identity(fs.lstatSync(parentPath, { bigint: true }));
  if (
    parentBefore.uid !== uid ||
    parentBefore.mode !== 0o700 ||
    fs.realpathSync(parentPath) !== parentPath
  ) {
    configurationError('parent must be a canonical current-UID 0700 directory');
  }
  const beforeStat = fs.lstatSync(filePath, { bigint: true });
  const before = identity(beforeStat);
  const maxBytes =
    expected.profile === 'edge'
      ? MAX_EDGE_LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_BYTES
      : MAX_STANDALONE_LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_BYTES;
  if (
    !beforeStat.isFile() ||
    beforeStat.isSymbolicLink() ||
    before.uid !== uid ||
    before.mode !== 0o600 ||
    before.links !== 1n ||
    before.size < 2n ||
    before.size > BigInt(maxBytes)
  ) {
    configurationError('identity or size is invalid');
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = identity(fs.fstatSync(descriptor, { bigint: true }));
    if (!same(before, opened)) configurationError('changed while opening');
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const lineBuffer = Buffer.allocUnsafe(MAX_LINE_BYTES);
    const fileHash = createHash('sha256');
    let chunkOffset = 0;
    let chunkLength = 0;
    let lineLength = 0;
    let fileBytes = 0;
    let decisionCount = 0;
    let ended = false;
    const nextLine = (): Buffer | null => {
      while (true) {
        if (chunkOffset >= chunkLength) {
          chunkLength = fs.readSync(
            descriptor!,
            chunk,
            0,
            chunk.byteLength,
            null,
          );
          chunkOffset = 0;
          if (chunkLength === 0) {
            if (lineLength !== 0) configurationError('must end with newline');
            return null;
          }
          fileBytes += chunkLength;
          fileHash.update(chunk.subarray(0, chunkLength));
        }
        const byte = chunk[chunkOffset++]!;
        if (byte === 0x0a) {
          const line = Buffer.from(lineBuffer.subarray(0, lineLength));
          lineLength = 0;
          return line;
        }
        if (lineLength >= MAX_LINE_BYTES) {
          configurationError('line is too large');
        }
        lineBuffer[lineLength] = byte;
        lineLength += 1;
      }
    };
    const first = nextLine();
    if (!first) configurationError('header is missing');
    let parsedHeader: Readonly<LocalReconciliationSecretConfigDecisionHeader>;
    try {
      parsedHeader = header(parse(first, 'header'), expected);
    } finally {
      first.fill(0);
    }
    const cursor: LocalReconciliationSecretConfigDecisionCursor = Object.freeze(
      {
        header: parsedHeader,
        next(): Readonly<LocalReconciliationSecretConfigDecision> | null {
          if (ended) return null;
          const line = nextLine();
          if (!line) {
            ended = true;
            return null;
          }
          try {
            const selected = decision(parse(line, 'decision'));
            decisionCount += 1;
            return selected;
          } finally {
            line.fill(0);
          }
        },
      },
    );
    const result = consume(cursor);
    if (cursor.next() !== null) {
      configurationError('decision consumer did not consume the full file');
    }
    const after = identity(fs.fstatSync(descriptor, { bigint: true }));
    const parentAfter = identity(fs.lstatSync(parentPath, { bigint: true }));
    const current = identity(fs.lstatSync(filePath, { bigint: true }));
    if (
      !same(before, after) ||
      !same(before, current) ||
      !same(parentBefore, parentAfter) ||
      fileBytes !== Number(before.size)
    ) {
      configurationError('identity changed while reading');
    }
    const evidence = Object.freeze({
      fileBytes,
      fileDigest: fileHash.digest('hex'),
      decisionCount,
    });
    return Object.freeze({
      result,
      evidence,
      confirmIdentity(): void {
        const parentCurrent = identity(
          fs.lstatSync(parentPath, { bigint: true }),
        );
        const fileCurrent = identity(fs.lstatSync(filePath, { bigint: true }));
        if (!same(parentBefore, parentCurrent) || !same(before, fileCurrent)) {
          configurationError('identity changed after reading');
        }
      },
    });
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('cannot be read', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
