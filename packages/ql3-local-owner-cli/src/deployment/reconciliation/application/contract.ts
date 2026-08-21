import path from 'node:path';

import { currentIdentity } from '../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../foundation/error';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PATH_BYTES = 4_096;

export interface LocalReconciliationApplicationOptions {
  readonly deploymentRoot: string;
  readonly captureRoot: string;
  readonly planRoot: string;
  readonly reviewRoot: string;
  readonly applicationRoot: string;
  readonly issuerKeyringPath: string;
  readonly allowRootService: boolean;
}

export interface LocalReconciliationApplicationPrepareCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.application.prepare';
  readonly options: Readonly<LocalReconciliationApplicationOptions>;
  readonly request: Readonly<{
    applicationId: string;
    reviewId: string;
    expectedReviewDigest: string;
    expectedHeadDigest: string;
    preparedAtMs: number;
  }>;
}

export interface LocalReconciliationApplicationCommitCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.application.commit';
  readonly options: Readonly<LocalReconciliationApplicationOptions>;
  readonly request: Readonly<{
    applicationId: string;
    expectedPreparationDigest: string;
    expectedHeadDigest: string;
    committedAtMs: number;
  }>;
}

export interface LocalReconciliationApplicationVerifyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.application.verify';
  readonly options: Readonly<LocalReconciliationApplicationOptions>;
  readonly request: Readonly<{
    applicationId: string;
    expectedApplicationPlanDigest: string;
  }>;
}

export interface LocalReconciliationApplicationPrepareResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.application.prepare';
  readonly status: 'prepared' | 'existing';
  readonly state: 'reconciliation_application_prepared';
  readonly applicationId: string;
  readonly preparationDigest: string;
  readonly instanceHeadDigest: string;
}

export interface LocalReconciliationApplicationTerminalResult {
  readonly schemaVersion: 1;
  readonly operation:
    | 'local.deployment.reconciliation.application.commit'
    | 'local.deployment.reconciliation.application.verify';
  readonly status: 'prepared' | 'existing' | 'verified';
  readonly state: 'reconciliation_application_planned';
  readonly applicationId: string;
  readonly applicationPlanDigest: string;
  readonly outcome:
    | 'no_effect_ready'
    | 'adapter_required'
    | 'manual_required'
    | 'adapter_and_manual_required';
  readonly domainCount: 8;
  readonly instanceHeadDigest: string;
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

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
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

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    configurationError(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    configurationError(`${label} must be a UUID v4`);
  }
  return value;
}

function normalizeOptions(
  value: unknown,
): Readonly<LocalReconciliationApplicationOptions> {
  const options = object(value, 'options');
  exact(
    options,
    [
      'allowRootService',
      'applicationRoot',
      'captureRoot',
      'deploymentRoot',
      'issuerKeyringPath',
      'planRoot',
      'reviewRoot',
    ],
    'options',
  );
  const identity = currentIdentity();
  if (
    typeof options.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== options.allowRootService
  ) {
    configurationError(
      'reconciliation application command identity is invalid',
    );
  }
  const roots = [
    safePath(options.deploymentRoot, 'deploymentRoot'),
    safePath(options.captureRoot, 'captureRoot'),
    safePath(options.planRoot, 'planRoot'),
    safePath(options.reviewRoot, 'reviewRoot'),
    safePath(options.applicationRoot, 'applicationRoot'),
  ];
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (
        overlaps(roots[left]!, roots[right]!) ||
        overlaps(roots[right]!, roots[left]!)
      ) {
        configurationError(
          'deployment, capture, plan, review and application roots must not overlap',
        );
      }
    }
  }
  const issuerKeyringPath = safePath(
    options.issuerKeyringPath,
    'issuerKeyringPath',
  );
  descendant(roots[0]!, issuerKeyringPath, 'issuerKeyringPath');
  return Object.freeze({
    deploymentRoot: roots[0]!,
    captureRoot: roots[1]!,
    planRoot: roots[2]!,
    reviewRoot: roots[3]!,
    applicationRoot: roots[4]!,
    issuerKeyringPath,
    allowRootService: options.allowRootService,
  });
}

function command(
  value: unknown,
  operation:
    | LocalReconciliationApplicationPrepareCommand['operation']
    | LocalReconciliationApplicationCommitCommand['operation']
    | LocalReconciliationApplicationVerifyCommand['operation'],
): Readonly<{
  options: Readonly<LocalReconciliationApplicationOptions>;
  request: Record<string, unknown>;
}> {
  const selected = object(value, 'reconciliation application command');
  exact(
    selected,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (selected.schemaVersion !== 1 || selected.operation !== operation) {
    configurationError('reconciliation application command is invalid');
  }
  return Object.freeze({
    options: normalizeOptions(selected.options),
    request: object(selected.request, 'request'),
  });
}

export function normalizeLocalReconciliationApplicationPrepareCommand(
  value: unknown,
): Readonly<LocalReconciliationApplicationPrepareCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.application.prepare',
  );
  exact(
    selected.request,
    [
      'applicationId',
      'expectedHeadDigest',
      'expectedReviewDigest',
      'preparedAtMs',
      'reviewId',
    ],
    'request',
  );
  if (
    !Number.isSafeInteger(selected.request.preparedAtMs) ||
    (selected.request.preparedAtMs as number) < 0
  ) {
    configurationError('reconciliation application prepare command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.application.prepare',
    options: selected.options,
    request: Object.freeze({
      applicationId: identifier(
        selected.request.applicationId,
        'applicationId',
      ),
      reviewId: identifier(selected.request.reviewId, 'reviewId'),
      expectedReviewDigest: digest(
        selected.request.expectedReviewDigest,
        'expectedReviewDigest',
      ),
      expectedHeadDigest: digest(
        selected.request.expectedHeadDigest,
        'expectedHeadDigest',
      ),
      preparedAtMs: selected.request.preparedAtMs as number,
    }),
  });
}

export function normalizeLocalReconciliationApplicationCommitCommand(
  value: unknown,
): Readonly<LocalReconciliationApplicationCommitCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.application.commit',
  );
  exact(
    selected.request,
    [
      'applicationId',
      'committedAtMs',
      'expectedHeadDigest',
      'expectedPreparationDigest',
    ],
    'request',
  );
  if (
    !Number.isSafeInteger(selected.request.committedAtMs) ||
    (selected.request.committedAtMs as number) < 0
  ) {
    configurationError('reconciliation application commit command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.application.commit',
    options: selected.options,
    request: Object.freeze({
      applicationId: identifier(
        selected.request.applicationId,
        'applicationId',
      ),
      expectedPreparationDigest: digest(
        selected.request.expectedPreparationDigest,
        'expectedPreparationDigest',
      ),
      expectedHeadDigest: digest(
        selected.request.expectedHeadDigest,
        'expectedHeadDigest',
      ),
      committedAtMs: selected.request.committedAtMs as number,
    }),
  });
}

export function normalizeLocalReconciliationApplicationVerifyCommand(
  value: unknown,
): Readonly<LocalReconciliationApplicationVerifyCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.application.verify',
  );
  exact(
    selected.request,
    ['applicationId', 'expectedApplicationPlanDigest'],
    'request',
  );
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.application.verify',
    options: selected.options,
    request: Object.freeze({
      applicationId: identifier(
        selected.request.applicationId,
        'applicationId',
      ),
      expectedApplicationPlanDigest: digest(
        selected.request.expectedApplicationPlanDigest,
        'expectedApplicationPlanDigest',
      ),
    }),
  });
}
