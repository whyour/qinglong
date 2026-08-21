import path from 'node:path';

import { currentIdentity } from '../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../foundation/error';
import type { LocalReconciliationReviewOptions } from './contract';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PATH_BYTES = 4_096;
export const MAX_LOCAL_RECONCILIATION_REVIEW_AUTHORIZATION_LIFETIME_MS =
  30 * 60 * 1_000;

export interface LocalReconciliationReviewCommitOptions
  extends LocalReconciliationReviewOptions {
  readonly targetDatabasePath: string;
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly issuerKeyringPath: string;
  readonly busyTimeoutMs?: number;
}

export interface LocalReconciliationReviewCommitCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.review.commit';
  readonly options: Readonly<LocalReconciliationReviewCommitOptions>;
  readonly request: Readonly<{
    reviewId: string;
    expectedPreparationDigest: string;
    expectedHeadDigest: string;
    decisionFilePath: string;
    committedAtMs: number;
    authorizationLifetimeMs: number;
  }>;
}

export interface LocalReconciliationReviewVerifyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.review.verify';
  readonly options: Readonly<
    LocalReconciliationReviewOptions & { readonly issuerKeyringPath: string }
  >;
  readonly request: Readonly<{
    reviewId: string;
    expectedReviewDigest: string;
  }>;
}

export interface LocalReconciliationReviewTerminalResult {
  readonly schemaVersion: 1;
  readonly operation:
    | 'local.deployment.reconciliation.review.commit'
    | 'local.deployment.reconciliation.review.verify';
  readonly status: 'prepared' | 'existing' | 'verified';
  readonly state: 'reconciliation_reviewed';
  readonly reviewId: string;
  readonly reviewDigest: string;
  readonly authorizationDigest: string;
  readonly decisionSetDigest: string;
  readonly decisionCount: number;
  readonly instanceHeadDigest: string;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(message);
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

function safePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    value.includes('//') ||
    !SAFE_PATH_PATTERN.test(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    configurationError(`${label} must be a safe non-root absolute path`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    configurationError(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function reviewId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    configurationError('reviewId must be a UUID v4');
  }
  return value;
}

function descendant(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    configurationError(`${label} must be a descendant of deploymentRoot`);
  }
}

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function roots(
  value: Record<string, unknown>,
): Readonly<LocalReconciliationReviewOptions> {
  const identity = currentIdentity();
  if (
    typeof value.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== value.allowRootService
  ) {
    configurationError('reconciliation review command identity is invalid');
  }
  const selected = [
    safePath(value.deploymentRoot, 'deploymentRoot'),
    safePath(value.captureRoot, 'captureRoot'),
    safePath(value.planRoot, 'planRoot'),
    safePath(value.reviewRoot, 'reviewRoot'),
  ];
  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      if (
        overlaps(selected[left]!, selected[right]!) ||
        overlaps(selected[right]!, selected[left]!)
      ) {
        configurationError(
          'deployment, capture, plan and review roots must not overlap',
        );
      }
    }
  }
  return Object.freeze({
    deploymentRoot: selected[0]!,
    captureRoot: selected[1]!,
    planRoot: selected[2]!,
    reviewRoot: selected[3]!,
    allowRootService: value.allowRootService,
  });
}

export function normalizeLocalReconciliationReviewCommitCommand(
  value: unknown,
): Readonly<LocalReconciliationReviewCommitCommand> {
  const command = object(value, 'reconciliation review commit command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.reconciliation.review.commit'
  ) {
    configurationError('reconciliation review commit command is invalid');
  }
  const options = object(command.options, 'options');
  const hasBusyTimeout = Object.hasOwn(options, 'busyTimeoutMs');
  exact(
    options,
    [
      'allowRootService',
      'captureRoot',
      'credentialFilePath',
      'deploymentRoot',
      'issuerKeyringPath',
      'ownerPepperKeyringDirectory',
      'planRoot',
      'reviewRoot',
      'targetDatabasePath',
      ...(hasBusyTimeout ? ['busyTimeoutMs'] : []),
    ],
    'options',
  );
  const normalizedRoots = roots(options);
  const targetDatabasePath = safePath(
    options.targetDatabasePath,
    'targetDatabasePath',
  );
  const ownerPepperKeyringDirectory = safePath(
    options.ownerPepperKeyringDirectory,
    'ownerPepperKeyringDirectory',
  );
  const credentialFilePath = safePath(
    options.credentialFilePath,
    'credentialFilePath',
  );
  const issuerKeyringPath = safePath(
    options.issuerKeyringPath,
    'issuerKeyringPath',
  );
  for (const [label, selected] of [
    ['ownerPepperKeyringDirectory', ownerPepperKeyringDirectory],
    ['credentialFilePath', credentialFilePath],
    ['issuerKeyringPath', issuerKeyringPath],
  ] as const) {
    descendant(normalizedRoots.deploymentRoot, selected, label);
  }
  if (
    options.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.busyTimeoutMs) ||
      (options.busyTimeoutMs as number) < 100 ||
      (options.busyTimeoutMs as number) > 30_000)
  ) {
    configurationError('busyTimeoutMs is invalid');
  }
  const request = object(command.request, 'request');
  exact(
    request,
    [
      'authorizationLifetimeMs',
      'committedAtMs',
      'decisionFilePath',
      'expectedHeadDigest',
      'expectedPreparationDigest',
      'reviewId',
    ],
    'request',
  );
  const decisionFilePath = safePath(
    request.decisionFilePath,
    'decisionFilePath',
  );
  if (
    [
      normalizedRoots.deploymentRoot,
      normalizedRoots.captureRoot,
      normalizedRoots.planRoot,
      normalizedRoots.reviewRoot,
    ].some(
      (root) =>
        overlaps(root, decisionFilePath) || overlaps(decisionFilePath, root),
    ) ||
    !Number.isSafeInteger(request.committedAtMs) ||
    (request.committedAtMs as number) < 0 ||
    !Number.isSafeInteger(request.authorizationLifetimeMs) ||
    (request.authorizationLifetimeMs as number) < 1 ||
    (request.authorizationLifetimeMs as number) >
      MAX_LOCAL_RECONCILIATION_REVIEW_AUTHORIZATION_LIFETIME_MS
  ) {
    configurationError('reconciliation review commit request is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.reconciliation.review.commit' as const,
    options: Object.freeze({
      ...normalizedRoots,
      targetDatabasePath,
      ownerPepperKeyringDirectory,
      credentialFilePath,
      issuerKeyringPath,
      ...(options.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: options.busyTimeoutMs as number }),
    }),
    request: Object.freeze({
      reviewId: reviewId(request.reviewId),
      expectedPreparationDigest: digest(
        request.expectedPreparationDigest,
        'expectedPreparationDigest',
      ),
      expectedHeadDigest: digest(
        request.expectedHeadDigest,
        'expectedHeadDigest',
      ),
      decisionFilePath,
      committedAtMs: request.committedAtMs as number,
      authorizationLifetimeMs: request.authorizationLifetimeMs as number,
    }),
  });
}

export function normalizeLocalReconciliationReviewVerifyCommand(
  value: unknown,
): Readonly<LocalReconciliationReviewVerifyCommand> {
  const command = object(value, 'reconciliation review verify command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.reconciliation.review.verify'
  ) {
    configurationError('reconciliation review verify command is invalid');
  }
  const options = object(command.options, 'options');
  exact(
    options,
    [
      'allowRootService',
      'captureRoot',
      'deploymentRoot',
      'issuerKeyringPath',
      'planRoot',
      'reviewRoot',
    ],
    'options',
  );
  const normalizedRoots = roots(options);
  const issuerKeyringPath = safePath(
    options.issuerKeyringPath,
    'issuerKeyringPath',
  );
  descendant(
    normalizedRoots.deploymentRoot,
    issuerKeyringPath,
    'issuerKeyringPath',
  );
  const request = object(command.request, 'request');
  exact(request, ['expectedReviewDigest', 'reviewId'], 'request');
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.reconciliation.review.verify' as const,
    options: Object.freeze({ ...normalizedRoots, issuerKeyringPath }),
    request: Object.freeze({
      reviewId: reviewId(request.reviewId),
      expectedReviewDigest: digest(
        request.expectedReviewDigest,
        'expectedReviewDigest',
      ),
    }),
  });
}
