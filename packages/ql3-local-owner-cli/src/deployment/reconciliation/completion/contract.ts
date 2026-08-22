import path from 'node:path';

import { currentIdentity } from '../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../foundation/error';

const DIGEST = /^[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/@-]+$/;

export interface LocalReconciliationCompletionAutomationOptions {
  readonly automationRoot: string;
  readonly automationDecisionRoot: string;
  readonly automationApplyRoot: string;
  readonly targetDatabasePath: string;
}

export interface LocalReconciliationCompletionOptions {
  readonly deploymentRoot: string;
  readonly applicationRoot: string;
  readonly completionRoot: string;
  readonly automation: Readonly<LocalReconciliationCompletionAutomationOptions> | null;
  readonly allowRootService: boolean;
}

export interface LocalReconciliationCompletionAutomationBinding {
  readonly automationId: string;
  readonly decisionId: string;
  readonly expectedApplyDigest: string;
}

export interface LocalReconciliationCompleteCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.complete';
  readonly options: Readonly<LocalReconciliationCompletionOptions>;
  readonly request: Readonly<{
    completionId: string;
    applicationId: string;
    expectedApplicationPlanDigest: string;
    expectedHeadDigest: string;
    automation: Readonly<LocalReconciliationCompletionAutomationBinding> | null;
    completedAtMs: number;
  }>;
}

export interface LocalReconciliationCompletionVerifyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.complete.verify';
  readonly options: Readonly<LocalReconciliationCompletionOptions>;
  readonly request: Readonly<{
    completionId: string;
    applicationId: string;
    expectedCompletionDigest: string;
    automation: Readonly<LocalReconciliationCompletionAutomationBinding> | null;
  }>;
}

export interface LocalReconciliationCompletionResult {
  readonly schemaVersion: 1;
  readonly operation:
    | LocalReconciliationCompleteCommand['operation']
    | LocalReconciliationCompletionVerifyCommand['operation'];
  readonly status: 'completed' | 'existing' | 'verified';
  readonly state: 'reconciliation_completed';
  readonly completionId: string;
  readonly applicationId: string;
  readonly completionDigest: string;
  readonly domainCount: 8;
  readonly adapterCount: 0 | 1;
  readonly instanceHeadDigest: string;
}

function fail(message: string): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation completion ${message}`,
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
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  return identifier(value, DIGEST, label);
}

function normalizeAutomationOptions(
  value: unknown,
): Readonly<LocalReconciliationCompletionAutomationOptions> | null {
  if (value === null) return null;
  const selected = record(value, 'automation options');
  exact(
    selected,
    [
      'automationApplyRoot',
      'automationDecisionRoot',
      'automationRoot',
      'targetDatabasePath',
    ],
    'automation options',
  );
  return Object.freeze({
    automationRoot: safePath(selected.automationRoot, 'automationRoot'),
    automationDecisionRoot: safePath(
      selected.automationDecisionRoot,
      'automationDecisionRoot',
    ),
    automationApplyRoot: safePath(
      selected.automationApplyRoot,
      'automationApplyRoot',
    ),
    targetDatabasePath: safePath(
      selected.targetDatabasePath,
      'targetDatabasePath',
    ),
  });
}

function normalizeOptions(
  value: unknown,
): Readonly<LocalReconciliationCompletionOptions> {
  const selected = record(value, 'options');
  exact(
    selected,
    [
      'allowRootService',
      'applicationRoot',
      'automation',
      'completionRoot',
      'deploymentRoot',
    ],
    'options',
  );
  if (
    typeof selected.allowRootService !== 'boolean' ||
    (currentIdentity().uid === 0) !== selected.allowRootService
  ) {
    fail('command identity is invalid');
  }
  const automation = normalizeAutomationOptions(selected.automation);
  const normalized = Object.freeze({
    deploymentRoot: safePath(selected.deploymentRoot, 'deploymentRoot'),
    applicationRoot: safePath(selected.applicationRoot, 'applicationRoot'),
    completionRoot: safePath(selected.completionRoot, 'completionRoot'),
    automation,
    allowRootService: selected.allowRootService,
  }) as Readonly<LocalReconciliationCompletionOptions>;
  const roots = [
    normalized.deploymentRoot,
    normalized.applicationRoot,
    normalized.completionRoot,
    ...(automation === null
      ? []
      : [
          automation.automationRoot,
          automation.automationDecisionRoot,
          automation.automationApplyRoot,
        ]),
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
  if (
    automation !== null &&
    roots.some(
      (root) =>
        overlaps(root, automation.targetDatabasePath) ||
        overlaps(automation.targetDatabasePath, root),
    )
  ) {
    fail('targetDatabasePath overlaps an authority root');
  }
  return normalized;
}

function normalizeAutomationBinding(
  value: unknown,
): Readonly<LocalReconciliationCompletionAutomationBinding> | null {
  if (value === null) return null;
  const selected = record(value, 'automation binding');
  exact(
    selected,
    ['automationId', 'decisionId', 'expectedApplyDigest'],
    'automation binding',
  );
  return Object.freeze({
    automationId: identifier(selected.automationId, UUID_V4, 'automationId'),
    decisionId: identifier(selected.decisionId, UUID_V7, 'decisionId'),
    expectedApplyDigest: digest(
      selected.expectedApplyDigest,
      'expectedApplyDigest',
    ),
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

export function normalizeLocalReconciliationCompleteCommand(
  value: unknown,
): Readonly<LocalReconciliationCompleteCommand> {
  const selected = command(value, 'local.deployment.reconciliation.complete');
  exact(
    selected.request,
    [
      'applicationId',
      'automation',
      'completedAtMs',
      'completionId',
      'expectedApplicationPlanDigest',
      'expectedHeadDigest',
    ],
    'request',
  );
  if (
    !Number.isSafeInteger(selected.request.completedAtMs) ||
    (selected.request.completedAtMs as number) < 0
  ) {
    fail('completedAtMs is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.complete',
    options: selected.options,
    request: Object.freeze({
      completionId: identifier(
        selected.request.completionId,
        UUID_V4,
        'completionId',
      ),
      applicationId: identifier(
        selected.request.applicationId,
        UUID_V4,
        'applicationId',
      ),
      expectedApplicationPlanDigest: digest(
        selected.request.expectedApplicationPlanDigest,
        'expectedApplicationPlanDigest',
      ),
      expectedHeadDigest: digest(
        selected.request.expectedHeadDigest,
        'expectedHeadDigest',
      ),
      automation: normalizeAutomationBinding(selected.request.automation),
      completedAtMs: selected.request.completedAtMs as number,
    }),
  });
}

export function normalizeLocalReconciliationCompletionVerifyCommand(
  value: unknown,
): Readonly<LocalReconciliationCompletionVerifyCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.complete.verify',
  );
  exact(
    selected.request,
    ['applicationId', 'automation', 'completionId', 'expectedCompletionDigest'],
    'request',
  );
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.complete.verify',
    options: selected.options,
    request: Object.freeze({
      completionId: identifier(
        selected.request.completionId,
        UUID_V4,
        'completionId',
      ),
      applicationId: identifier(
        selected.request.applicationId,
        UUID_V4,
        'applicationId',
      ),
      expectedCompletionDigest: digest(
        selected.request.expectedCompletionDigest,
        'expectedCompletionDigest',
      ),
      automation: normalizeAutomationBinding(selected.request.automation),
    }),
  });
}
