import fs from 'node:fs';

import { LocalDeploymentConfigurationError } from '../../foundation/error';
import { cutoverDigest } from '../../cutover/targetEvidence';
import type { LocalReconciliationReviewAuthorizationEvidence } from './authorization';
import type {
  LocalReconciliationReviewDisposition,
  LocalReconciliationReviewReason,
} from './decisionFile';

const REVIEW_SCHEMA = 'qinglong3-local-reconciliation-review';
const RECEIPT_SCHEMA = 'qinglong3-local-reconciliation-review-receipt';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_TERMINAL_BYTES = 64 * 1024;

export interface LocalReconciliationReview {
  readonly schema: typeof REVIEW_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_reviewed';
  readonly reviewId: string;
  readonly profile: 'edge' | 'standalone';
  readonly planDigest: string;
  readonly preparationDigest: string;
  readonly bundleDigest: string;
  readonly bundleFingerprintDigest: string;
  readonly preparedHeadDigest: string;
  readonly authorizationDigest: string;
  readonly decisionFileDigest: string;
  readonly decisionSetDigest: string;
  readonly decisionCount: number;
  readonly dispositionCounts: Readonly<
    Record<LocalReconciliationReviewDisposition, number>
  >;
  readonly reasonCounts: Readonly<
    Record<LocalReconciliationReviewReason, number>
  >;
  readonly reviewerDigest: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly committedAtMs: number;
  readonly reviewDigest: string;
}

export interface LocalReconciliationReviewReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_reviewed';
  readonly reviewId: string;
  readonly planDigest: string;
  readonly preparationDigest: string;
  readonly authorizationDigest: string;
  readonly decisionSetDigest: string;
  readonly decisionCount: number;
  readonly keyId: string;
  readonly reviewDigest: string;
  readonly committedAtMs: number;
  readonly receiptDigest: string;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `terminal reconciliation review ${message}`,
    { cause },
  );
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
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

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    configurationError(`${label} is invalid`);
  }
  return value;
}

function counts(
  value: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, number>> {
  const record = object(value, label);
  exact(record, keys, label);
  if (
    keys.some(
      (key) =>
        !Number.isSafeInteger(record[key]) || (record[key] as number) < 0,
    )
  ) {
    configurationError(`${label} is invalid`);
  }
  return Object.freeze(record as Record<string, number>);
}

export function buildLocalReconciliationReview(
  input: Readonly<{
    authorization: Readonly<LocalReconciliationReviewAuthorizationEvidence>;
    decisionFileDigest: string;
    committedAtMs: number;
  }>,
): Readonly<LocalReconciliationReview> {
  const header = input.authorization.header;
  const reviewerDigest = cutoverDigest({
    subject: header.reviewer.subject,
    authenticationId: header.reviewer.authenticationId,
    authenticatedAtMs: header.reviewer.authenticatedAtMs,
    assurance: header.reviewer.assurance,
  });
  const payload = Object.freeze({
    schema: REVIEW_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_reviewed' as const,
    reviewId: header.reviewId,
    profile: header.profile,
    planDigest: header.planDigest,
    preparationDigest: header.preparationDigest,
    bundleDigest: header.bundleDigest,
    bundleFingerprintDigest: header.bundleFingerprintDigest,
    preparedHeadDigest: header.preparedHeadDigest,
    authorizationDigest: input.authorization.authorizationDigest,
    decisionFileDigest: digest(
      input.decisionFileDigest,
      'decision file digest',
    ),
    decisionSetDigest: input.authorization.decisionSetDigest,
    decisionCount: input.authorization.decisionCount,
    dispositionCounts: input.authorization.dispositionCounts,
    reasonCounts: input.authorization.reasonCounts,
    reviewerDigest,
    issuedAtMs: header.issuedAtMs,
    expiresAtMs: header.expiresAtMs,
    committedAtMs: input.committedAtMs,
  });
  return Object.freeze({ ...payload, reviewDigest: cutoverDigest(payload) });
}

export function buildLocalReconciliationReviewReceipt(
  review: Readonly<LocalReconciliationReview>,
  keyId: string,
): Readonly<LocalReconciliationReviewReceipt> {
  const payload = Object.freeze({
    schema: RECEIPT_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_reviewed' as const,
    reviewId: review.reviewId,
    planDigest: review.planDigest,
    preparationDigest: review.preparationDigest,
    authorizationDigest: review.authorizationDigest,
    decisionSetDigest: review.decisionSetDigest,
    decisionCount: review.decisionCount,
    keyId,
    reviewDigest: review.reviewDigest,
    committedAtMs: review.committedAtMs,
  });
  return Object.freeze({ ...payload, receiptDigest: cutoverDigest(payload) });
}

export function normalizeLocalReconciliationReview(
  value: unknown,
): Readonly<LocalReconciliationReview> {
  const review = object(value, 'review');
  exact(
    review,
    [
      'authorizationDigest',
      'bundleDigest',
      'bundleFingerprintDigest',
      'committedAtMs',
      'decisionCount',
      'decisionFileDigest',
      'decisionSetDigest',
      'dispositionCounts',
      'expiresAtMs',
      'issuedAtMs',
      'planDigest',
      'preparationDigest',
      'preparedHeadDigest',
      'profile',
      'reasonCounts',
      'reviewDigest',
      'reviewId',
      'reviewerDigest',
      'schema',
      'schemaVersion',
      'state',
    ],
    'review',
  );
  const dispositionCounts = counts(
    review.dispositionCounts,
    [
      'adopt_legacy',
      'defer',
      'exclude_legacy',
      'manual_external',
      'retain_both',
      'retain_target',
    ],
    'disposition counts',
  );
  const reasonCounts = counts(
    review.reasonCounts,
    [
      'deferred_review',
      'external_recovery_required',
      'legacy_excluded',
      'prefer_legacy',
      'preserve_both',
      'preserve_target',
    ],
    'reason counts',
  );
  const { reviewDigest, ...rawPayload } = review;
  const payload = Object.freeze({
    ...rawPayload,
    dispositionCounts,
    reasonCounts,
  });
  if (
    review.schema !== REVIEW_SCHEMA ||
    review.schemaVersion !== 1 ||
    review.state !== 'reconciliation_reviewed' ||
    (review.profile !== 'edge' && review.profile !== 'standalone') ||
    !Number.isSafeInteger(review.decisionCount) ||
    (review.decisionCount as number) < 0 ||
    !Number.isSafeInteger(review.issuedAtMs) ||
    !Number.isSafeInteger(review.expiresAtMs) ||
    !Number.isSafeInteger(review.committedAtMs) ||
    (review.expiresAtMs as number) <= (review.issuedAtMs as number) ||
    [
      review.planDigest,
      review.preparationDigest,
      review.bundleDigest,
      review.bundleFingerprintDigest,
      review.preparedHeadDigest,
      review.authorizationDigest,
      review.decisionFileDigest,
      review.decisionSetDigest,
      review.reviewerDigest,
      reviewDigest,
    ].some(
      (selected) =>
        typeof selected !== 'string' || !DIGEST_PATTERN.test(selected),
    ) ||
    cutoverDigest(payload) !== reviewDigest ||
    Object.values(dispositionCounts).reduce(
      (total, count) => total + count,
      0,
    ) !== review.decisionCount ||
    Object.values(reasonCounts).reduce((total, count) => total + count, 0) !==
      review.decisionCount
  ) {
    configurationError('review drifted');
  }
  return Object.freeze({
    ...(review as unknown as LocalReconciliationReview),
    dispositionCounts:
      dispositionCounts as LocalReconciliationReview['dispositionCounts'],
    reasonCounts: reasonCounts as LocalReconciliationReview['reasonCounts'],
  });
}

export function normalizeLocalReconciliationReviewReceipt(
  value: unknown,
): Readonly<LocalReconciliationReviewReceipt> {
  const receipt = object(value, 'receipt');
  exact(
    receipt,
    [
      'authorizationDigest',
      'committedAtMs',
      'decisionCount',
      'decisionSetDigest',
      'keyId',
      'planDigest',
      'preparationDigest',
      'receiptDigest',
      'reviewDigest',
      'reviewId',
      'schema',
      'schemaVersion',
      'state',
    ],
    'receipt',
  );
  const { receiptDigest, ...payload } = receipt;
  if (
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.schemaVersion !== 1 ||
    receipt.state !== 'reconciliation_reviewed' ||
    !Number.isSafeInteger(receipt.decisionCount) ||
    (receipt.decisionCount as number) < 0 ||
    !Number.isSafeInteger(receipt.committedAtMs) ||
    typeof receipt.keyId !== 'string' ||
    receipt.keyId.length < 1 ||
    receipt.keyId.length > 128 ||
    [
      receipt.planDigest,
      receipt.preparationDigest,
      receipt.authorizationDigest,
      receipt.decisionSetDigest,
      receipt.reviewDigest,
      receiptDigest,
    ].some(
      (selected) =>
        typeof selected !== 'string' || !DIGEST_PATTERN.test(selected),
    ) ||
    cutoverDigest(payload) !== receiptDigest
  ) {
    configurationError('receipt drifted');
  }
  return Object.freeze(
    receipt,
  ) as unknown as Readonly<LocalReconciliationReviewReceipt>;
}

export function terminalEvidenceContents(value: unknown): string {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (
    Buffer.byteLength(contents, 'utf8') < 2 ||
    Buffer.byteLength(contents, 'utf8') > MAX_TERMINAL_BYTES
  ) {
    configurationError('evidence exceeds its byte bound');
  }
  return contents;
}

export function readLocalReconciliationReviewTerminalJson(
  filePath: string,
  uid: number,
  allowedModes: readonly number[],
): unknown {
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      !allowedModes.includes(Number(before.mode) & 0o777) ||
      before.nlink !== 1n ||
      before.size < 2n ||
      before.size > BigInt(MAX_TERMINAL_BYTES)
    ) {
      configurationError('evidence identity is invalid');
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      configurationError('evidence changed while opening');
    }
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      configurationError('evidence changed while reading');
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('evidence cannot be read', error);
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
