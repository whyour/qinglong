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

export interface LocalReconciliationCompletionSecretConfigOptions {
  readonly secretConfigRoot: string;
  readonly secretConfigDecisionRoot: string;
  readonly secretConfigApplyRoot: string;
  readonly targetDatabasePath: string;
}

export interface LocalReconciliationCompletionOptions {
  readonly deploymentRoot: string;
  readonly applicationRoot: string;
  readonly completionRoot: string;
  readonly automation: Readonly<LocalReconciliationCompletionAutomationOptions> | null;
  readonly secretConfig: Readonly<LocalReconciliationCompletionSecretConfigOptions> | null;
  readonly runHistory: Readonly<LocalReconciliationCompletionRunHistoryOptions> | null;
  readonly allowRootService: boolean;
}

export interface LocalReconciliationCompletionRunHistoryOptions {
  readonly runHistoryRoot: string;
  readonly decisionFilePath: string;
}

export interface LocalReconciliationCompletionAutomationBinding {
  readonly automationId: string;
  readonly decisionId: string;
  readonly expectedApplyDigest: string;
}

export interface LocalReconciliationCompletionSecretConfigBinding {
  readonly secretConfigId: string;
  readonly decisionId: string;
  readonly expectedApplyDigest: string;
}

export interface LocalReconciliationCompletionRunHistoryBinding {
  readonly preservationId: string;
  readonly expectedPreservationDigest: string;
}

export interface LocalReconciliationCompleteCommand {
  readonly schemaVersion: 1 | 2 | 3;
  readonly operation: 'local.deployment.reconciliation.complete';
  readonly options: Readonly<LocalReconciliationCompletionOptions>;
  readonly request: Readonly<{
    completionId: string;
    applicationId: string;
    expectedApplicationPlanDigest: string;
    expectedHeadDigest: string;
    automation: Readonly<LocalReconciliationCompletionAutomationBinding> | null;
    secretConfig: Readonly<LocalReconciliationCompletionSecretConfigBinding> | null;
    runHistory: Readonly<LocalReconciliationCompletionRunHistoryBinding> | null;
    completedAtMs: number;
  }>;
}

export interface LocalReconciliationCompletionVerifyCommand {
  readonly schemaVersion: 1 | 2 | 3;
  readonly operation: 'local.deployment.reconciliation.complete.verify';
  readonly options: Readonly<LocalReconciliationCompletionOptions>;
  readonly request: Readonly<{
    completionId: string;
    applicationId: string;
    expectedCompletionDigest: string;
    automation: Readonly<LocalReconciliationCompletionAutomationBinding> | null;
    secretConfig: Readonly<LocalReconciliationCompletionSecretConfigBinding> | null;
    runHistory: Readonly<LocalReconciliationCompletionRunHistoryBinding> | null;
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
  readonly adapterCount: 0 | 1 | 2 | 3;
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

function normalizeSecretConfigOptions(
  value: unknown,
): Readonly<LocalReconciliationCompletionSecretConfigOptions> | null {
  if (value === null) return null;
  const selected = record(value, 'secret config options');
  exact(
    selected,
    [
      'secretConfigApplyRoot',
      'secretConfigDecisionRoot',
      'secretConfigRoot',
      'targetDatabasePath',
    ],
    'secret config options',
  );
  return Object.freeze({
    secretConfigRoot: safePath(selected.secretConfigRoot, 'secretConfigRoot'),
    secretConfigDecisionRoot: safePath(
      selected.secretConfigDecisionRoot,
      'secretConfigDecisionRoot',
    ),
    secretConfigApplyRoot: safePath(
      selected.secretConfigApplyRoot,
      'secretConfigApplyRoot',
    ),
    targetDatabasePath: safePath(
      selected.targetDatabasePath,
      'targetDatabasePath',
    ),
  });
}

function normalizeOptions(
  value: unknown,
  schemaVersion: 1 | 2 | 3,
): Readonly<LocalReconciliationCompletionOptions> {
  const selected = record(value, 'options');
  exact(
    selected,
    schemaVersion === 1
      ? [
          'allowRootService',
          'applicationRoot',
          'automation',
          'completionRoot',
          'deploymentRoot',
        ]
      : schemaVersion === 2
      ? [
          'allowRootService',
          'applicationRoot',
          'automation',
          'completionRoot',
          'deploymentRoot',
          'runHistory',
        ]
      : [
          'allowRootService',
          'applicationRoot',
          'automation',
          'completionRoot',
          'deploymentRoot',
          'runHistory',
          'secretConfig',
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
  const secretConfig =
    schemaVersion === 3
      ? normalizeSecretConfigOptions(selected.secretConfig)
      : null;
  const runHistory =
    schemaVersion === 1
      ? null
      : schemaVersion === 3 && selected.runHistory === null
      ? null
      : normalizeRunHistoryOptions(selected.runHistory);
  const normalized = Object.freeze({
    deploymentRoot: safePath(selected.deploymentRoot, 'deploymentRoot'),
    applicationRoot: safePath(selected.applicationRoot, 'applicationRoot'),
    completionRoot: safePath(selected.completionRoot, 'completionRoot'),
    automation,
    secretConfig,
    runHistory,
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
    ...(secretConfig === null
      ? []
      : [
          secretConfig.secretConfigRoot,
          secretConfig.secretConfigDecisionRoot,
          secretConfig.secretConfigApplyRoot,
        ]),
    ...(runHistory === null ? [] : [runHistory.runHistoryRoot]),
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
  if (
    secretConfig !== null &&
    roots.some(
      (root) =>
        overlaps(root, secretConfig.targetDatabasePath) ||
        overlaps(secretConfig.targetDatabasePath, root),
    )
  ) {
    fail('targetDatabasePath overlaps an authority root');
  }
  if (
    automation !== null &&
    secretConfig !== null &&
    automation.targetDatabasePath !== secretConfig.targetDatabasePath
  ) {
    fail('adapter targetDatabasePath values differ');
  }
  if (
    runHistory !== null &&
    roots.some(
      (root) =>
        overlaps(root, runHistory.decisionFilePath) ||
        overlaps(runHistory.decisionFilePath, root),
    )
  ) {
    fail('decisionFilePath overlaps an authority root');
  }
  return normalized;
}

function normalizeRunHistoryOptions(
  value: unknown,
): Readonly<LocalReconciliationCompletionRunHistoryOptions> {
  const selected = record(value, 'run history options');
  exact(
    selected,
    ['decisionFilePath', 'runHistoryRoot'],
    'run history options',
  );
  return Object.freeze({
    runHistoryRoot: safePath(selected.runHistoryRoot, 'runHistoryRoot'),
    decisionFilePath: safePath(selected.decisionFilePath, 'decisionFilePath'),
  });
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

function normalizeSecretConfigBinding(
  value: unknown,
): Readonly<LocalReconciliationCompletionSecretConfigBinding> | null {
  if (value === null) return null;
  const selected = record(value, 'secret config binding');
  exact(
    selected,
    ['decisionId', 'expectedApplyDigest', 'secretConfigId'],
    'secret config binding',
  );
  return Object.freeze({
    secretConfigId: identifier(
      selected.secretConfigId,
      UUID_V4,
      'secretConfigId',
    ),
    decisionId: identifier(selected.decisionId, UUID_V7, 'decisionId'),
    expectedApplyDigest: digest(
      selected.expectedApplyDigest,
      'expectedApplyDigest',
    ),
  });
}

function normalizeRunHistoryBinding(
  value: unknown,
): Readonly<LocalReconciliationCompletionRunHistoryBinding> {
  const selected = record(value, 'run history binding');
  exact(
    selected,
    ['expectedPreservationDigest', 'preservationId'],
    'run history binding',
  );
  return Object.freeze({
    preservationId: identifier(
      selected.preservationId,
      UUID_V4,
      'preservationId',
    ),
    expectedPreservationDigest: digest(
      selected.expectedPreservationDigest,
      'expectedPreservationDigest',
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
  if (
    (selected.schemaVersion !== 1 &&
      selected.schemaVersion !== 2 &&
      selected.schemaVersion !== 3) ||
    selected.operation !== operation
  ) {
    fail('command version or operation is invalid');
  }
  return Object.freeze({
    schemaVersion: selected.schemaVersion,
    options: normalizeOptions(selected.options, selected.schemaVersion),
    request: record(selected.request, 'request'),
  });
}

export function normalizeLocalReconciliationCompleteCommand(
  value: unknown,
): Readonly<LocalReconciliationCompleteCommand> {
  const selected = command(value, 'local.deployment.reconciliation.complete');
  exact(
    selected.request,
    selected.schemaVersion === 1
      ? [
          'applicationId',
          'automation',
          'completedAtMs',
          'completionId',
          'expectedApplicationPlanDigest',
          'expectedHeadDigest',
        ]
      : selected.schemaVersion === 2
      ? [
          'applicationId',
          'automation',
          'completedAtMs',
          'completionId',
          'expectedApplicationPlanDigest',
          'expectedHeadDigest',
          'runHistory',
        ]
      : [
          'applicationId',
          'automation',
          'completedAtMs',
          'completionId',
          'expectedApplicationPlanDigest',
          'expectedHeadDigest',
          'runHistory',
          'secretConfig',
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
    schemaVersion: selected.schemaVersion,
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
      secretConfig:
        selected.schemaVersion === 3
          ? normalizeSecretConfigBinding(selected.request.secretConfig)
          : null,
      runHistory:
        selected.schemaVersion === 1
          ? null
          : selected.schemaVersion === 3 && selected.request.runHistory === null
          ? null
          : normalizeRunHistoryBinding(selected.request.runHistory),
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
    selected.schemaVersion === 1
      ? [
          'applicationId',
          'automation',
          'completionId',
          'expectedCompletionDigest',
        ]
      : selected.schemaVersion === 2
      ? [
          'applicationId',
          'automation',
          'completionId',
          'expectedCompletionDigest',
          'runHistory',
        ]
      : [
          'applicationId',
          'automation',
          'completionId',
          'expectedCompletionDigest',
          'runHistory',
          'secretConfig',
        ],
    'request',
  );
  return Object.freeze({
    schemaVersion: selected.schemaVersion,
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
      secretConfig:
        selected.schemaVersion === 3
          ? normalizeSecretConfigBinding(selected.request.secretConfig)
          : null,
      runHistory:
        selected.schemaVersion === 1
          ? null
          : selected.schemaVersion === 3 && selected.request.runHistory === null
          ? null
          : normalizeRunHistoryBinding(selected.request.runHistory),
    }),
  });
}
