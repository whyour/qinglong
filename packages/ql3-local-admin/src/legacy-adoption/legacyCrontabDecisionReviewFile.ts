// Legacy Adoption owns the private streaming review-file boundary.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_LEGACY_CRONTAB_ROWS } from './legacyCrontabAdoption';
import {
  parseLegacyCrontabAdoptionDecision,
  type LegacyCrontabAdoptionDecision,
} from './legacyCrontabDecisionReceipt';

export const MAX_LEGACY_CRONTAB_DECISION_REVIEW_FILE_BYTES = 32 * 1024 * 1024;

const MAX_PATH_BYTES = 4096;
const MAX_LINE_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface ReviewFileHeader {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-crontab-decision-review-file-header';
  readonly decisionId: string;
  readonly profile: 'edge' | 'standalone';
  readonly planDigest: string;
  readonly inventoryDigest: string;
}

interface FileLine {
  readonly start: number;
  readonly end: number;
  readonly value: Buffer;
  readonly framed: Buffer;
}

interface PrivatePathIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNs: bigint;
  readonly changedAtNs: bigint;
}

interface PrivateParentIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: number;
}

export interface OpenLegacyCrontabAdoptionDecisionReviewFileOptions {
  readonly filePath: string;
  readonly expectedDecisionId: string;
  readonly expectedProfile: 'edge' | 'standalone';
  readonly expectedPlanDigest: string;
  readonly expectedInventoryDigest: string;
}

export interface LegacyCrontabAdoptionDecisionReviewFileEvidence {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-crontab-decision-review-file';
  readonly decisionId: string;
  readonly profile: 'edge' | 'standalone';
  readonly planDigest: string;
  readonly inventoryDigest: string;
  readonly decisionCount: number;
  readonly fileBytes: number;
  readonly fileDigest: string;
}

export interface LegacyCrontabAdoptionDecisionReviewFileScope {
  readonly evidence: LegacyCrontabAdoptionDecisionReviewFileEvidence;
  readonly decisions: Iterable<LegacyCrontabAdoptionDecision>;
  confirmIdentity(): void;
}

export class LegacyCrontabAdoptionDecisionReviewFileError extends Error {
  readonly code = 'LEGACY_CRONTAB_DECISION_REVIEW_FILE_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Legacy Crontab decision review file is invalid: ${message}`);
    this.name = 'LegacyCrontabAdoptionDecisionReviewFileError';
  }
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LegacyCrontabAdoptionDecisionReviewFileError(
      `${label} must be an object`,
    );
  }
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new LegacyCrontabAdoptionDecisionReviewFileError(
      `${label} shape is invalid`,
    );
  }
}

function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    process.getuid() !== process.geteuid()
  ) {
    throw new LegacyCrontabAdoptionDecisionReviewFileError(
      'real and effective POSIX users must match',
    );
  }
  return process.getuid();
}

function reviewPath(value: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LegacyCrontabAdoptionDecisionReviewFileError(
      'path must be normalized, bounded, absolute and non-root',
    );
  }
  return value;
}

function privateParent(filePath: string, uid: number): PrivateParentIdentity {
  const parentPath = path.dirname(filePath);
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(parentPath, { bigint: true });
  } catch (error) {
    throw new LegacyCrontabAdoptionDecisionReviewFileError(
      'private parent directory is unavailable',
      error,
    );
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    (Number(stat.mode) & 0o777) !== 0o700
  ) {
    throw new LegacyCrontabAdoptionDecisionReviewFileError(
      'parent must be an owner-only real directory',
    );
  }
  return Object.freeze({
    path: parentPath,
    device: stat.dev,
    inode: stat.ino,
    uid,
  });
}

function openedIdentity(stat: fs.BigIntStats): PrivatePathIdentity {
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAtNs: stat.mtimeNs,
    changedAtNs: stat.ctimeNs,
  });
}

function sameFile(
  stat: fs.BigIntStats,
  expected: PrivatePathIdentity,
): boolean {
  return (
    stat.dev === expected.device &&
    stat.ino === expected.inode &&
    stat.size === expected.size &&
    stat.mtimeNs === expected.modifiedAtNs &&
    stat.ctimeNs === expected.changedAtNs
  );
}

function parseJsonLine(line: Buffer, label: string): unknown {
  if (line.length < 2 || line.length > MAX_LINE_BYTES) {
    throw new LegacyCrontabAdoptionDecisionReviewFileError(
      `${label} exceeds its line bound`,
    );
  }
  try {
    return JSON.parse(line.toString('utf8')) as unknown;
  } catch (error) {
    throw new LegacyCrontabAdoptionDecisionReviewFileError(
      `${label} is not valid JSON`,
      error,
    );
  }
}

function* readLines(
  descriptor: number,
  start: number,
  end: number,
): Iterable<FileLine> {
  let position = start;
  let pending = Buffer.alloc(0);
  let pendingStart = start;
  try {
    while (position < end) {
      const chunk = Buffer.allocUnsafe(
        Math.min(READ_CHUNK_BYTES, end - position),
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
        throw new LegacyCrontabAdoptionDecisionReviewFileError(
          'file ended unexpectedly',
        );
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
        const lineLength = newline - cursor;
        if (lineLength < 1 || lineLength > MAX_LINE_BYTES) {
          material.fill(0);
          throw new LegacyCrontabAdoptionDecisionReviewFileError(
            'file contains an invalid line',
          );
        }
        yield Object.freeze({
          start: pendingStart + cursor,
          end: pendingStart + newline + 1,
          value: Buffer.from(material.subarray(cursor, newline)),
          framed: Buffer.from(material.subarray(cursor, newline + 1)),
        });
        cursor = newline + 1;
      }
      const next = Buffer.from(material.subarray(cursor));
      pendingStart += cursor;
      material.fill(0);
      pending = next;
      if (pending.length > MAX_LINE_BYTES) {
        throw new LegacyCrontabAdoptionDecisionReviewFileError(
          'file contains an overlong line',
        );
      }
    }
    if (pending.length !== 0) {
      throw new LegacyCrontabAdoptionDecisionReviewFileError(
        'file must end with a newline',
      );
    }
  } finally {
    pending.fill(0);
  }
}

function parseHeader(value: unknown): ReviewFileHeader {
  exactKeys(
    value,
    [
      'decisionId',
      'inventoryDigest',
      'kind',
      'planDigest',
      'profile',
      'schemaVersion',
    ],
    'header record',
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'qinglong3-legacy-crontab-decision-review-file-header' ||
    typeof value.decisionId !== 'string' ||
    !UUID_V7_PATTERN.test(value.decisionId) ||
    (value.profile !== 'edge' && value.profile !== 'standalone') ||
    typeof value.planDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.planDigest) ||
    typeof value.inventoryDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.inventoryDigest)
  ) {
    throw new LegacyCrontabAdoptionDecisionReviewFileError(
      'header content is invalid',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'qinglong3-legacy-crontab-decision-review-file-header',
    decisionId: value.decisionId,
    profile: value.profile,
    planDigest: value.planDigest,
    inventoryDigest: value.inventoryDigest,
  });
}

function parseDecision(value: unknown): LegacyCrontabAdoptionDecision {
  exactKeys(value, ['decision', 'kind', 'schemaVersion'], 'decision record');
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'qinglong3-legacy-crontab-decision-review-file-row'
  ) {
    throw new LegacyCrontabAdoptionDecisionReviewFileError(
      'decision record version or kind is invalid',
    );
  }
  try {
    return parseLegacyCrontabAdoptionDecision(value.decision);
  } catch (error) {
    throw new LegacyCrontabAdoptionDecisionReviewFileError(
      'decision record content is invalid',
      error,
    );
  }
}

function digestDescriptor(descriptor: number, size: number): string {
  const hash = createHash('sha256');
  let position = 0;
  while (position < size) {
    const chunk = Buffer.allocUnsafe(
      Math.min(READ_CHUNK_BYTES, size - position),
    );
    try {
      const bytesRead = fs.readSync(
        descriptor,
        chunk,
        0,
        chunk.length,
        position,
      );
      if (bytesRead < 1) {
        throw new LegacyCrontabAdoptionDecisionReviewFileError(
          'file ended while confirming its digest',
        );
      }
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    } finally {
      chunk.fill(0);
    }
  }
  return hash.digest('hex');
}

export async function withPrivateLegacyCrontabAdoptionDecisionReviewFile<T>(
  options: OpenLegacyCrontabAdoptionDecisionReviewFileOptions,
  consumer: (
    scope: LegacyCrontabAdoptionDecisionReviewFileScope,
  ) => T | Promise<T>,
): Promise<T> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).sort().join('\0') !==
      [
        'expectedDecisionId',
        'expectedInventoryDigest',
        'expectedPlanDigest',
        'expectedProfile',
        'filePath',
      ]
        .sort()
        .join('\0') ||
    typeof consumer !== 'function'
  ) {
    throw new LegacyCrontabAdoptionDecisionReviewFileError(
      'open options are invalid',
    );
  }
  const filePath = reviewPath(options.filePath);
  const uid = currentUid();
  const parent = privateParent(filePath, uid);
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      (Number(before.mode) & 0o777) !== 0o600 ||
      before.size < 1n ||
      before.size > BigInt(MAX_LEGACY_CRONTAB_DECISION_REVIEW_FILE_BYTES)
    ) {
      throw new LegacyCrontabAdoptionDecisionReviewFileError(
        'file must be a bounded owner-only regular file',
      );
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const identity = openedIdentity(opened);
    if (!opened.isFile() || !sameFile(before, identity)) {
      throw new LegacyCrontabAdoptionDecisionReviewFileError(
        'file identity changed while opening',
      );
    }
    const size = Number(opened.size);
    const fileHash = createHash('sha256');
    let header: ReviewFileHeader | undefined;
    let decisionStart = -1;
    let decisionCount = 0;
    for (const line of readLines(descriptor, 0, size)) {
      try {
        fileHash.update(line.framed);
        const value = parseJsonLine(line.value, 'review record');
        if (!header) {
          header = parseHeader(value);
          decisionStart = line.end;
          continue;
        }
        if (decisionCount >= MAX_LEGACY_CRONTAB_ROWS) {
          throw new LegacyCrontabAdoptionDecisionReviewFileError(
            'decision row count exceeds its hard bound',
          );
        }
        parseDecision(value);
        decisionCount += 1;
      } finally {
        line.value.fill(0);
        line.framed.fill(0);
      }
    }
    if (!header || decisionStart < 0) {
      throw new LegacyCrontabAdoptionDecisionReviewFileError(
        'header record is missing',
      );
    }
    if (
      header.decisionId !== options.expectedDecisionId ||
      header.profile !== options.expectedProfile ||
      header.planDigest !== options.expectedPlanDigest ||
      header.inventoryDigest !== options.expectedInventoryDigest
    ) {
      throw new LegacyCrontabAdoptionDecisionReviewFileError(
        'header does not match the reviewed source',
      );
    }
    const fileDigest = fileHash.digest('hex');
    const confirmIdentity = (): void => {
      const afterOpen = fs.fstatSync(descriptor!, { bigint: true });
      const afterPath = fs.lstatSync(filePath, { bigint: true });
      const afterParent = privateParent(filePath, uid);
      if (
        !sameFile(afterOpen, identity) ||
        !sameFile(afterPath, identity) ||
        Number(afterPath.uid) !== uid ||
        (Number(afterPath.mode) & 0o777) !== 0o600 ||
        afterParent.path !== parent.path ||
        afterParent.device !== parent.device ||
        afterParent.inode !== parent.inode ||
        afterParent.uid !== parent.uid ||
        digestDescriptor(descriptor!, size) !== fileDigest
      ) {
        throw new LegacyCrontabAdoptionDecisionReviewFileError(
          'file identity or content changed during review',
        );
      }
    };
    const decisions = Object.freeze({
      *[Symbol.iterator](): Iterator<LegacyCrontabAdoptionDecision> {
        for (const line of readLines(descriptor!, decisionStart, size)) {
          try {
            yield parseDecision(parseJsonLine(line.value, 'decision record'));
          } finally {
            line.value.fill(0);
            line.framed.fill(0);
          }
        }
      },
    });
    const evidence = Object.freeze({
      schemaVersion: 1 as const,
      kind: 'qinglong3-legacy-crontab-decision-review-file' as const,
      decisionId: header.decisionId,
      profile: header.profile,
      planDigest: header.planDigest,
      inventoryDigest: header.inventoryDigest,
      decisionCount,
      fileBytes: size,
      fileDigest,
    });
    const result = await consumer(
      Object.freeze({ evidence, decisions, confirmIdentity }),
    );
    confirmIdentity();
    return result;
  } catch (error) {
    if (error instanceof LegacyCrontabAdoptionDecisionReviewFileError) {
      throw error;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
