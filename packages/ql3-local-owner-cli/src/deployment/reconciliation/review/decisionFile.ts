import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LocalDeploymentConfigurationError } from '../../foundation/error';
import type { LocalReconciliationDiagnosticFact } from './diagnostics';

const HEADER_KIND = 'qinglong3-local-reconciliation-review-decision-header';
const DECISION_KIND = 'qinglong3-local-reconciliation-review-decision';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_LINE_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
export const MAX_EDGE_LOCAL_RECONCILIATION_REVIEW_DECISION_BYTES =
  8 * 1024 * 1024;
export const MAX_STANDALONE_LOCAL_RECONCILIATION_REVIEW_DECISION_BYTES =
  32 * 1024 * 1024;

export const LOCAL_RECONCILIATION_REVIEW_DISPOSITIONS = Object.freeze([
  'retain_target',
  'adopt_legacy',
  'retain_both',
  'exclude_legacy',
  'defer',
  'manual_external',
] as const);

export type LocalReconciliationReviewDisposition =
  (typeof LOCAL_RECONCILIATION_REVIEW_DISPOSITIONS)[number];

export const LOCAL_RECONCILIATION_REVIEW_REASONS = Object.freeze([
  'preserve_target',
  'prefer_legacy',
  'preserve_both',
  'legacy_excluded',
  'deferred_review',
  'external_recovery_required',
] as const);

export type LocalReconciliationReviewReason =
  (typeof LOCAL_RECONCILIATION_REVIEW_REASONS)[number];

export interface LocalReconciliationReviewDecisionHeader {
  readonly schemaVersion: 1;
  readonly kind: typeof HEADER_KIND;
  readonly diagnosticsContractVersion: 1;
  readonly reviewId: string;
  readonly profile: 'edge' | 'standalone';
  readonly planDigest: string;
  readonly preparationDigest: string;
}

export interface LocalReconciliationReviewDecision {
  readonly schemaVersion: 1;
  readonly kind: typeof DECISION_KIND;
  readonly database: 'legacy' | 'target';
  readonly domain: LocalReconciliationDiagnosticFact['domain'];
  readonly factKind: LocalReconciliationDiagnosticFact['factKind'];
  readonly ordinal: number;
  readonly factDigest: string;
  readonly disposition: LocalReconciliationReviewDisposition;
  readonly reason: LocalReconciliationReviewReason;
}

export interface LocalReconciliationReviewDecisionFileEvidence {
  readonly fileBytes: number;
  readonly fileDigest: string;
  readonly decisionCount: number;
}

export interface LocalReconciliationReviewDecisionCursor {
  readonly header: Readonly<LocalReconciliationReviewDecisionHeader>;
  next(): Readonly<LocalReconciliationReviewDecision> | null;
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
    `reconciliation review decision file ${message}`,
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
  } catch (error) {
    configurationError(`${label} is not valid UTF-8 JSON`, error);
  }
}

function header(
  value: unknown,
  expected: Readonly<{
    reviewId: string;
    profile: 'edge' | 'standalone';
    planDigest: string;
    preparationDigest: string;
  }>,
): Readonly<LocalReconciliationReviewDecisionHeader> {
  const record = exact(
    value,
    [
      'diagnosticsContractVersion',
      'kind',
      'planDigest',
      'preparationDigest',
      'profile',
      'reviewId',
      'schemaVersion',
    ],
    'header',
  );
  if (
    record.schemaVersion !== 1 ||
    record.kind !== HEADER_KIND ||
    record.diagnosticsContractVersion !== 1 ||
    typeof record.reviewId !== 'string' ||
    !UUID_V4_PATTERN.test(record.reviewId) ||
    (record.profile !== 'edge' && record.profile !== 'standalone') ||
    typeof record.planDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.planDigest) ||
    typeof record.preparationDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.preparationDigest) ||
    record.reviewId !== expected.reviewId ||
    record.profile !== expected.profile ||
    record.planDigest !== expected.planDigest ||
    record.preparationDigest !== expected.preparationDigest
  ) {
    configurationError('header binding is invalid');
  }
  return Object.freeze(
    record,
  ) as unknown as Readonly<LocalReconciliationReviewDecisionHeader>;
}

function decision(value: unknown): Readonly<LocalReconciliationReviewDecision> {
  const record = exact(
    value,
    [
      'database',
      'disposition',
      'domain',
      'factDigest',
      'factKind',
      'kind',
      'ordinal',
      'reason',
      'schemaVersion',
    ],
    'decision',
  );
  if (
    record.schemaVersion !== 1 ||
    record.kind !== DECISION_KIND ||
    (record.database !== 'legacy' && record.database !== 'target') ||
    ![
      'schema_lineage',
      'automation',
      'secret_and_config',
      'run_history',
      'plugin_package',
      'ai_and_tool',
      'identity_policy_audit',
      'unknown',
    ].includes(record.domain as string) ||
    (record.factKind !== 'schema_object' && record.factKind !== 'table') ||
    !Number.isSafeInteger(record.ordinal) ||
    (record.ordinal as number) < 1 ||
    (record.ordinal as number) > 4_096 ||
    typeof record.factDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.factDigest) ||
    !LOCAL_RECONCILIATION_REVIEW_DISPOSITIONS.includes(
      record.disposition as LocalReconciliationReviewDisposition,
    ) ||
    !LOCAL_RECONCILIATION_REVIEW_REASONS.includes(
      record.reason as LocalReconciliationReviewReason,
    )
  ) {
    configurationError('decision is invalid');
  }
  const reasonByDisposition: Record<
    LocalReconciliationReviewDisposition,
    LocalReconciliationReviewReason
  > = {
    retain_target: 'preserve_target',
    adopt_legacy: 'prefer_legacy',
    retain_both: 'preserve_both',
    exclude_legacy: 'legacy_excluded',
    defer: 'deferred_review',
    manual_external: 'external_recovery_required',
  };
  if (
    reasonByDisposition[
      record.disposition as LocalReconciliationReviewDisposition
    ] !== record.reason
  ) {
    configurationError('decision reason does not match disposition');
  }
  return Object.freeze(
    record,
  ) as unknown as Readonly<LocalReconciliationReviewDecision>;
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

function assertParent(filePath: string, uid: number): FileIdentity {
  const stat = fs.lstatSync(path.dirname(filePath), { bigint: true });
  const selected = identity(stat);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    selected.uid !== uid ||
    selected.mode !== 0o700 ||
    fs.realpathSync(path.dirname(filePath)) !== path.dirname(filePath)
  ) {
    configurationError('parent must be a canonical current-UID 0700 directory');
  }
  return selected;
}

export function assertLocalReconciliationReviewDecisionMatchesFact(
  selected: Readonly<LocalReconciliationReviewDecision>,
  fact: Readonly<LocalReconciliationDiagnosticFact>,
): void {
  if (
    selected.database !== fact.database ||
    selected.domain !== fact.domain ||
    selected.factKind !== fact.factKind ||
    selected.ordinal !== fact.ordinal ||
    selected.factDigest !== fact.factDigest
  ) {
    configurationError('decision sequence does not match canonical facts');
  }
  if (
    fact.decisionRequirement === 'informational' ||
    (fact.database === 'legacy' && selected.disposition === 'retain_target') ||
    (fact.database === 'target' &&
      (selected.disposition === 'adopt_legacy' ||
        selected.disposition === 'exclude_legacy')) ||
    (fact.decisionRequirement === 'blocked' &&
      selected.disposition !== 'defer' &&
      selected.disposition !== 'manual_external') ||
    (fact.domain === 'run_history' &&
      !['retain_target', 'retain_both', 'defer', 'manual_external'].includes(
        selected.disposition,
      )) ||
    ((fact.domain === 'secret_and_config' ||
      fact.domain === 'identity_policy_audit' ||
      fact.domain === 'unknown') &&
      !['defer', 'manual_external'].includes(selected.disposition))
  ) {
    configurationError(
      'decision disposition is not allowed for canonical fact',
    );
  }
}

export function withLocalReconciliationReviewDecisionFile<T>(
  filePath: string,
  expected: Readonly<{
    reviewId: string;
    profile: 'edge' | 'standalone';
    planDigest: string;
    preparationDigest: string;
  }>,
  consume: (cursor: LocalReconciliationReviewDecisionCursor) => T,
): Readonly<{
  result: T;
  evidence: LocalReconciliationReviewDecisionFileEvidence;
  confirmIdentity(): void;
}> {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid !== process.geteuid?.()) {
    configurationError('requires stable POSIX identity');
  }
  const parent = assertParent(filePath, uid!);
  const beforeStat = fs.lstatSync(filePath, { bigint: true });
  const before = identity(beforeStat);
  const maxBytes =
    expected.profile === 'edge'
      ? MAX_EDGE_LOCAL_RECONCILIATION_REVIEW_DECISION_BYTES
      : MAX_STANDALONE_LOCAL_RECONCILIATION_REVIEW_DECISION_BYTES;
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
    let chunkOffset = 0;
    let chunkLength = 0;
    let bytesRead = 0;
    const lineBuffer = Buffer.allocUnsafe(MAX_LINE_BYTES);
    let lineLength = 0;
    const fileHash = createHash('sha256');
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
          bytesRead += chunkLength;
          fileHash.update(chunk.subarray(0, chunkLength));
        }
        const byte = chunk[chunkOffset++]!;
        if (byte === 0x0a) {
          const line = Buffer.from(lineBuffer.subarray(0, lineLength));
          lineLength = 0;
          return line;
        }
        if (lineLength >= MAX_LINE_BYTES)
          configurationError('line is too large');
        lineBuffer[lineLength] = byte;
        lineLength += 1;
      }
    };
    const first = nextLine();
    if (!first) configurationError('header is absent');
    const normalizedHeader = header(parse(first, 'header'), expected);
    let decisionCount = 0;
    const cursor: LocalReconciliationReviewDecisionCursor = Object.freeze({
      header: normalizedHeader,
      next() {
        const line = nextLine();
        if (line === null) return null;
        decisionCount += 1;
        return decision(parse(line, 'decision'));
      },
    });
    const result = consume(cursor);
    if (cursor.next() !== null) configurationError('contains extra decisions');
    const after = identity(fs.fstatSync(descriptor, { bigint: true }));
    const currentParent = assertParent(filePath, uid!);
    if (
      bytesRead !== Number(before.size) ||
      !same(before, after) ||
      parent.device !== currentParent.device ||
      parent.inode !== currentParent.inode ||
      !same(before, identity(fs.lstatSync(filePath, { bigint: true })))
    ) {
      configurationError('identity changed while reading');
    }
    const confirmIdentity = (): void => {
      const latestParent = assertParent(filePath, uid!);
      if (
        parent.device !== latestParent.device ||
        parent.inode !== latestParent.inode ||
        !same(before, identity(fs.lstatSync(filePath, { bigint: true })))
      ) {
        configurationError('identity changed after reading');
      }
    };
    return Object.freeze({
      result,
      evidence: Object.freeze({
        fileBytes: bytesRead,
        fileDigest: fileHash.digest('hex'),
        decisionCount,
      }),
      confirmIdentity,
    });
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('cannot be read', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
