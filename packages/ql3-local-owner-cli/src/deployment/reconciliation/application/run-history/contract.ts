import path from 'node:path';

import { currentIdentity } from '../../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../../foundation/error';

const DIGEST = /^[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/@-]+$/;

export interface LocalReconciliationRunHistoryOptions {
  readonly deploymentRoot: string;
  readonly applicationRoot: string;
  readonly runHistoryRoot: string;
  readonly allowRootService: boolean;
}

export interface LocalReconciliationRunHistoryPreserveCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.run-history.preserve';
  readonly options: Readonly<LocalReconciliationRunHistoryOptions>;
  readonly request: Readonly<{
    preservationId: string;
    applicationId: string;
    expectedApplicationPlanDigest: string;
    expectedHeadDigest: string;
    decisionFilePath: string;
    preservedAtMs: number;
  }>;
}

export interface LocalReconciliationRunHistoryVerifyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.run-history.verify';
  readonly options: Readonly<LocalReconciliationRunHistoryOptions>;
  readonly request: Readonly<{
    preservationId: string;
    applicationId: string;
    expectedPreservationDigest: string;
    decisionFilePath: string;
  }>;
}

export interface LocalReconciliationRunHistoryResult {
  readonly schemaVersion: 1;
  readonly operation:
    | LocalReconciliationRunHistoryPreserveCommand['operation']
    | LocalReconciliationRunHistoryVerifyCommand['operation'];
  readonly status: 'preserved' | 'existing' | 'verified';
  readonly state: 'reconciliation_run_history_preserved';
  readonly preservationId: string;
  readonly applicationId: string;
  readonly preservationDigest: string;
  readonly legacyFactCount: number;
  readonly targetFactCount: number;
}

function fail(message: string): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation run history ${message}`,
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
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
    fail(`${label} shape is invalid`);
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
    !SAFE_PATH.test(value) ||
    Buffer.byteLength(value, 'utf8') > 4_096
  ) {
    fail(`${label} must be a safe non-root absolute path`);
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

function identifier(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value))
    fail(`${label} is invalid`);
  return value;
}

function normalizeOptions(
  value: unknown,
): Readonly<LocalReconciliationRunHistoryOptions> {
  const selected = record(value, 'options');
  exact(
    selected,
    ['allowRootService', 'applicationRoot', 'deploymentRoot', 'runHistoryRoot'],
    'options',
  );
  if (
    typeof selected.allowRootService !== 'boolean' ||
    (currentIdentity().uid === 0) !== selected.allowRootService
  ) {
    fail('command identity is invalid');
  }
  const roots = [
    safePath(selected.deploymentRoot, 'deploymentRoot'),
    safePath(selected.applicationRoot, 'applicationRoot'),
    safePath(selected.runHistoryRoot, 'runHistoryRoot'),
  ];
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (
        overlaps(roots[left]!, roots[right]!) ||
        overlaps(roots[right]!, roots[left]!)
      ) {
        fail('authority roots overlap');
      }
    }
  }
  return Object.freeze({
    deploymentRoot: roots[0]!,
    applicationRoot: roots[1]!,
    runHistoryRoot: roots[2]!,
    allowRootService: selected.allowRootService,
  });
}

function command(value: unknown, operation: string) {
  const selected = record(value, 'command');
  exact(
    selected,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (selected.schemaVersion !== 1 || selected.operation !== operation) {
    fail('command version or operation is invalid');
  }
  return Object.freeze({
    options: normalizeOptions(selected.options),
    request: record(selected.request, 'request'),
  });
}

function decisionFilePath(
  value: unknown,
  options: Readonly<LocalReconciliationRunHistoryOptions>,
): string {
  const selected = safePath(value, 'decisionFilePath');
  for (const root of [
    options.deploymentRoot,
    options.applicationRoot,
    options.runHistoryRoot,
  ]) {
    if (overlaps(root, selected) || overlaps(selected, root)) {
      fail('decisionFilePath overlaps an authority root');
    }
  }
  return selected;
}

export function normalizeLocalReconciliationRunHistoryPreserveCommand(
  value: unknown,
): Readonly<LocalReconciliationRunHistoryPreserveCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.run-history.preserve',
  );
  exact(
    selected.request,
    [
      'applicationId',
      'decisionFilePath',
      'expectedApplicationPlanDigest',
      'expectedHeadDigest',
      'preservationId',
      'preservedAtMs',
    ],
    'request',
  );
  if (
    !Number.isSafeInteger(selected.request.preservedAtMs) ||
    (selected.request.preservedAtMs as number) < 0
  ) {
    fail('preservedAtMs is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.run-history.preserve',
    options: selected.options,
    request: Object.freeze({
      preservationId: identifier(
        selected.request.preservationId,
        UUID_V4,
        'preservationId',
      ),
      applicationId: identifier(
        selected.request.applicationId,
        UUID_V4,
        'applicationId',
      ),
      expectedApplicationPlanDigest: identifier(
        selected.request.expectedApplicationPlanDigest,
        DIGEST,
        'expectedApplicationPlanDigest',
      ),
      expectedHeadDigest: identifier(
        selected.request.expectedHeadDigest,
        DIGEST,
        'expectedHeadDigest',
      ),
      decisionFilePath: decisionFilePath(
        selected.request.decisionFilePath,
        selected.options,
      ),
      preservedAtMs: selected.request.preservedAtMs as number,
    }),
  });
}

export function normalizeLocalReconciliationRunHistoryVerifyCommand(
  value: unknown,
): Readonly<LocalReconciliationRunHistoryVerifyCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.run-history.verify',
  );
  exact(
    selected.request,
    [
      'applicationId',
      'decisionFilePath',
      'expectedPreservationDigest',
      'preservationId',
    ],
    'request',
  );
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.run-history.verify',
    options: selected.options,
    request: Object.freeze({
      preservationId: identifier(
        selected.request.preservationId,
        UUID_V4,
        'preservationId',
      ),
      applicationId: identifier(
        selected.request.applicationId,
        UUID_V4,
        'applicationId',
      ),
      expectedPreservationDigest: identifier(
        selected.request.expectedPreservationDigest,
        DIGEST,
        'expectedPreservationDigest',
      ),
      decisionFilePath: decisionFilePath(
        selected.request.decisionFilePath,
        selected.options,
      ),
    }),
  });
}
