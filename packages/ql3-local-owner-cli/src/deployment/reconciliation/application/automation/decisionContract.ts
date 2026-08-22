import path from 'node:path';

import { currentIdentity } from '../../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../../foundation/error';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const MAX_PATH_BYTES = 4_096;
export const MAX_LOCAL_RECONCILIATION_AUTOMATION_DECISION_LIFETIME_MS =
  30 * 60 * 1_000;

export interface LocalReconciliationAutomationDecisionOptions {
  readonly deploymentRoot: string;
  readonly applicationRoot: string;
  readonly automationRoot: string;
  readonly automationDecisionRoot: string;
  readonly allowRootService: boolean;
}

export interface LocalReconciliationAutomationDecisionPrepareCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.automation.decision.prepare';
  readonly options: Readonly<LocalReconciliationAutomationDecisionOptions>;
  readonly request: Readonly<{
    decisionId: string;
    automationId: string;
    expectedAutomationPlanDigest: string;
    expectedHeadDigest: string;
    preparedAtMs: number;
  }>;
}

export interface LocalReconciliationAutomationDecisionCommitOptions
  extends LocalReconciliationAutomationDecisionOptions {
  readonly targetDatabasePath: string;
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

export interface LocalReconciliationAutomationDecisionCommitCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.automation.decision.commit';
  readonly options: Readonly<LocalReconciliationAutomationDecisionCommitOptions>;
  readonly request: Readonly<{
    decisionId: string;
    automationId: string;
    expectedPreparationDigest: string;
    expectedHeadDigest: string;
    decisionFilePath: string;
    committedAtMs: number;
    authorizationLifetimeMs: number;
  }>;
}

export interface LocalReconciliationAutomationDecisionVerifyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.automation.decision.verify';
  readonly options: Readonly<LocalReconciliationAutomationDecisionOptions>;
  readonly request: Readonly<{
    decisionId: string;
    automationId: string;
    expectedDecisionDigest: string;
  }>;
}

export interface LocalReconciliationAutomationDecisionPrepareResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.automation.decision.prepare';
  readonly status: 'prepared' | 'existing';
  readonly state: 'reconciliation_automation_decision_prepared';
  readonly decisionId: string;
  readonly automationId: string;
  readonly preparationDigest: string;
  readonly instanceHeadDigest: string;
}

export interface LocalReconciliationAutomationDecisionTerminalResult {
  readonly schemaVersion: 1;
  readonly operation:
    | 'local.deployment.reconciliation.automation.decision.commit'
    | 'local.deployment.reconciliation.automation.decision.verify';
  readonly status: 'prepared' | 'existing' | 'verified';
  readonly state: 'reconciliation_automation_reviewed';
  readonly decisionId: string;
  readonly automationId: string;
  readonly decisionDigest: string;
  readonly signedDecisionSetDigest: string;
  readonly rowCount: number;
  readonly adoptedCount: number;
  readonly skippedCount: number;
  readonly instanceHeadDigest: string;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation automation decision ${message}`,
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
    configurationError(`${label} must be below deploymentRoot`);
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    configurationError(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function automationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    configurationError('automationId must be a lowercase UUID v4');
  }
  return value;
}

function decisionId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V7_PATTERN.test(value)) {
    configurationError('decisionId must be a lowercase UUID v7');
  }
  return value;
}

function baseOptions(
  value: unknown,
): Readonly<LocalReconciliationAutomationDecisionOptions> {
  const options = object(value, 'options');
  const keys = [
    'allowRootService',
    'applicationRoot',
    'automationDecisionRoot',
    'automationRoot',
    'deploymentRoot',
  ];
  exact(options, keys, 'options');
  const identity = currentIdentity();
  if (
    typeof options.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== options.allowRootService
  ) {
    configurationError('command identity is invalid');
  }
  const roots = keys
    .filter((key) => key !== 'allowRootService')
    .map((key) => safePath(options[key], key));
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (
        overlaps(roots[left]!, roots[right]!) ||
        overlaps(roots[right]!, roots[left]!)
      ) {
        configurationError('authority roots overlap');
      }
    }
  }
  return Object.freeze({
    deploymentRoot: safePath(options.deploymentRoot, 'deploymentRoot'),
    applicationRoot: safePath(options.applicationRoot, 'applicationRoot'),
    automationRoot: safePath(options.automationRoot, 'automationRoot'),
    automationDecisionRoot: safePath(
      options.automationDecisionRoot,
      'automationDecisionRoot',
    ),
    allowRootService: options.allowRootService as boolean,
  });
}

function command(value: unknown, operation: string) {
  const selected = object(value, 'command');
  exact(selected, ['operation', 'options', 'request', 'schemaVersion'], 'command');
  if (selected.schemaVersion !== 1 || selected.operation !== operation) {
    configurationError('command version or operation is invalid');
  }
  return Object.freeze({
    options: selected.options,
    request: object(selected.request, 'request'),
  });
}

export function normalizeLocalReconciliationAutomationDecisionPrepareCommand(
  value: unknown,
): Readonly<LocalReconciliationAutomationDecisionPrepareCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.automation.decision.prepare',
  );
  exact(
    selected.request,
    [
      'automationId',
      'decisionId',
      'expectedAutomationPlanDigest',
      'expectedHeadDigest',
      'preparedAtMs',
    ],
    'request',
  );
  if (
    !Number.isSafeInteger(selected.request.preparedAtMs) ||
    (selected.request.preparedAtMs as number) < 0
  ) {
    configurationError('preparedAtMs is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.decision.prepare',
    options: baseOptions(selected.options),
    request: Object.freeze({
      decisionId: decisionId(selected.request.decisionId),
      automationId: automationId(selected.request.automationId),
      expectedAutomationPlanDigest: digest(
        selected.request.expectedAutomationPlanDigest,
        'expectedAutomationPlanDigest',
      ),
      expectedHeadDigest: digest(
        selected.request.expectedHeadDigest,
        'expectedHeadDigest',
      ),
      preparedAtMs: selected.request.preparedAtMs as number,
    }),
  });
}

export function normalizeLocalReconciliationAutomationDecisionCommitCommand(
  value: unknown,
): Readonly<LocalReconciliationAutomationDecisionCommitCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.automation.decision.commit',
  );
  const options = object(selected.options, 'options');
  const hasBusyTimeout = Object.hasOwn(options, 'busyTimeoutMs');
  exact(
    options,
    [
      'allowRootService',
      'applicationRoot',
      'automationDecisionRoot',
      'automationRoot',
      'credentialFilePath',
      'deploymentRoot',
      'ownerPepperKeyringDirectory',
      'targetDatabasePath',
      ...(hasBusyTimeout ? ['busyTimeoutMs'] : []),
    ],
    'options',
  );
  const base = baseOptions({
    allowRootService: options.allowRootService,
    applicationRoot: options.applicationRoot,
    automationDecisionRoot: options.automationDecisionRoot,
    automationRoot: options.automationRoot,
    deploymentRoot: options.deploymentRoot,
  });
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
  for (const [candidate, label] of [
    [ownerPepperKeyringDirectory, 'ownerPepperKeyringDirectory'],
    [credentialFilePath, 'credentialFilePath'],
  ] as const) {
    descendant(base.deploymentRoot, candidate, label);
  }
  if (
    options.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.busyTimeoutMs) ||
      (options.busyTimeoutMs as number) < 1 ||
      (options.busyTimeoutMs as number) > 60_000)
  ) {
    configurationError('busyTimeoutMs is invalid');
  }
  exact(
    selected.request,
    [
      'authorizationLifetimeMs',
      'automationId',
      'committedAtMs',
      'decisionFilePath',
      'decisionId',
      'expectedHeadDigest',
      'expectedPreparationDigest',
    ],
    'request',
  );
  const decisionFilePath = safePath(
    selected.request.decisionFilePath,
    'decisionFilePath',
  );
  if (
    [
      base.deploymentRoot,
      base.applicationRoot,
      base.automationRoot,
      base.automationDecisionRoot,
    ].some(
      (root) =>
        overlaps(root, decisionFilePath) || overlaps(decisionFilePath, root),
    )
  ) {
    configurationError('decisionFilePath overlaps an authority root');
  }
  if (
    !Number.isSafeInteger(selected.request.committedAtMs) ||
    (selected.request.committedAtMs as number) < 0 ||
    !Number.isSafeInteger(selected.request.authorizationLifetimeMs) ||
    (selected.request.authorizationLifetimeMs as number) < 1 ||
    (selected.request.authorizationLifetimeMs as number) >
      MAX_LOCAL_RECONCILIATION_AUTOMATION_DECISION_LIFETIME_MS
  ) {
    configurationError('decision timestamp or lifetime is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.decision.commit',
    options: Object.freeze({
      ...base,
      targetDatabasePath,
      ownerPepperKeyringDirectory,
      credentialFilePath,
      ...(options.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: options.busyTimeoutMs as number }),
    }),
    request: Object.freeze({
      decisionId: decisionId(selected.request.decisionId),
      automationId: automationId(selected.request.automationId),
      expectedPreparationDigest: digest(
        selected.request.expectedPreparationDigest,
        'expectedPreparationDigest',
      ),
      expectedHeadDigest: digest(
        selected.request.expectedHeadDigest,
        'expectedHeadDigest',
      ),
      decisionFilePath,
      committedAtMs: selected.request.committedAtMs as number,
      authorizationLifetimeMs:
        selected.request.authorizationLifetimeMs as number,
    }),
  });
}

export function normalizeLocalReconciliationAutomationDecisionVerifyCommand(
  value: unknown,
): Readonly<LocalReconciliationAutomationDecisionVerifyCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.automation.decision.verify',
  );
  exact(
    selected.request,
    ['automationId', 'decisionId', 'expectedDecisionDigest'],
    'request',
  );
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.decision.verify',
    options: baseOptions(selected.options),
    request: Object.freeze({
      decisionId: decisionId(selected.request.decisionId),
      automationId: automationId(selected.request.automationId),
      expectedDecisionDigest: digest(
        selected.request.expectedDecisionDigest,
        'expectedDecisionDigest',
      ),
    }),
  });
}
