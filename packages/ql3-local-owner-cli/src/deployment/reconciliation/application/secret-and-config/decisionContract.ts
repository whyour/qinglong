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
export const MAX_LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_LIFETIME_MS =
  30 * 60 * 1_000;

export interface LocalReconciliationSecretConfigDecisionOptions {
  readonly deploymentRoot: string;
  readonly applicationRoot: string;
  readonly secretConfigRoot: string;
  readonly secretConfigDecisionRoot: string;
  readonly allowRootService: boolean;
}

export interface LocalReconciliationSecretConfigDecisionPrepareCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.secret-config.decision.prepare';
  readonly options: Readonly<LocalReconciliationSecretConfigDecisionOptions>;
  readonly request: Readonly<{
    decisionId: string;
    secretConfigId: string;
    expectedSecretConfigPlanDigest: string;
    expectedHeadDigest: string;
    preparedAtMs: number;
  }>;
}

export interface LocalReconciliationSecretConfigDecisionCommitOptions
  extends LocalReconciliationSecretConfigDecisionOptions {
  readonly targetDatabasePath: string;
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

export interface LocalReconciliationSecretConfigDecisionCommitCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.secret-config.decision.commit';
  readonly options: Readonly<LocalReconciliationSecretConfigDecisionCommitOptions>;
  readonly request: Readonly<{
    decisionId: string;
    secretConfigId: string;
    expectedPreparationDigest: string;
    expectedHeadDigest: string;
    decisionFilePath: string;
    committedAtMs: number;
    authorizationLifetimeMs: number;
  }>;
}

export interface LocalReconciliationSecretConfigDecisionVerifyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.secret-config.decision.verify';
  readonly options: Readonly<LocalReconciliationSecretConfigDecisionOptions>;
  readonly request: Readonly<{
    decisionId: string;
    secretConfigId: string;
    expectedDecisionDigest: string;
  }>;
}

export interface LocalReconciliationSecretConfigDecisionPrepareResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.secret-config.decision.prepare';
  readonly status: 'prepared' | 'existing';
  readonly state: 'reconciliation_secret_config_decision_prepared';
  readonly decisionId: string;
  readonly secretConfigId: string;
  readonly preparationDigest: string;
  readonly instanceHeadDigest: string;
}

export interface LocalReconciliationSecretConfigDecisionTerminalResult {
  readonly schemaVersion: 1;
  readonly operation:
    | 'local.deployment.reconciliation.secret-config.decision.commit'
    | 'local.deployment.reconciliation.secret-config.decision.verify';
  readonly status: 'prepared' | 'existing' | 'verified';
  readonly state: 'reconciliation_secret_config_reviewed';
  readonly decisionId: string;
  readonly secretConfigId: string;
  readonly decisionDigest: string;
  readonly signedDecisionSetDigest: string;
  readonly candidateCount: number;
  readonly applyBindingCount: number;
  readonly preserveDisabledCount: number;
  readonly skippedCount: number;
  readonly outcome: 'ready' | 'manual_required';
  readonly instanceHeadDigest: string;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation secret config decision ${message}`,
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

function secretConfigId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    configurationError('secretConfigId must be a lowercase UUID v4');
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
): Readonly<LocalReconciliationSecretConfigDecisionOptions> {
  const options = object(value, 'options');
  const keys = [
    'allowRootService',
    'applicationRoot',
    'deploymentRoot',
    'secretConfigDecisionRoot',
    'secretConfigRoot',
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
    secretConfigRoot: safePath(options.secretConfigRoot, 'secretConfigRoot'),
    secretConfigDecisionRoot: safePath(
      options.secretConfigDecisionRoot,
      'secretConfigDecisionRoot',
    ),
    allowRootService: options.allowRootService as boolean,
  });
}

function command(value: unknown, operation: string) {
  const selected = object(value, 'command');
  exact(
    selected,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (selected.schemaVersion !== 1 || selected.operation !== operation) {
    configurationError('command version or operation is invalid');
  }
  return Object.freeze({
    options: selected.options,
    request: object(selected.request, 'request'),
  });
}

export function normalizeLocalReconciliationSecretConfigDecisionPrepareCommand(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigDecisionPrepareCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.secret-config.decision.prepare',
  );
  exact(
    selected.request,
    [
      'decisionId',
      'expectedHeadDigest',
      'expectedSecretConfigPlanDigest',
      'preparedAtMs',
      'secretConfigId',
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
    operation: 'local.deployment.reconciliation.secret-config.decision.prepare',
    options: baseOptions(selected.options),
    request: Object.freeze({
      decisionId: decisionId(selected.request.decisionId),
      secretConfigId: secretConfigId(selected.request.secretConfigId),
      expectedSecretConfigPlanDigest: digest(
        selected.request.expectedSecretConfigPlanDigest,
        'expectedSecretConfigPlanDigest',
      ),
      expectedHeadDigest: digest(
        selected.request.expectedHeadDigest,
        'expectedHeadDigest',
      ),
      preparedAtMs: selected.request.preparedAtMs as number,
    }),
  });
}

export function normalizeLocalReconciliationSecretConfigDecisionCommitCommand(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigDecisionCommitCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.secret-config.decision.commit',
  );
  const options = object(selected.options, 'options');
  const hasBusyTimeout = Object.hasOwn(options, 'busyTimeoutMs');
  exact(
    options,
    [
      'allowRootService',
      'applicationRoot',
      'credentialFilePath',
      'deploymentRoot',
      'ownerPepperKeyringDirectory',
      'secretConfigDecisionRoot',
      'secretConfigRoot',
      'targetDatabasePath',
      ...(hasBusyTimeout ? ['busyTimeoutMs'] : []),
    ],
    'options',
  );
  const base = baseOptions({
    allowRootService: options.allowRootService,
    applicationRoot: options.applicationRoot,
    deploymentRoot: options.deploymentRoot,
    secretConfigDecisionRoot: options.secretConfigDecisionRoot,
    secretConfigRoot: options.secretConfigRoot,
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
      'committedAtMs',
      'decisionFilePath',
      'decisionId',
      'expectedHeadDigest',
      'expectedPreparationDigest',
      'secretConfigId',
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
      base.secretConfigRoot,
      base.secretConfigDecisionRoot,
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
      MAX_LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_LIFETIME_MS
  ) {
    configurationError('decision timestamp or lifetime is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.decision.commit',
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
      secretConfigId: secretConfigId(selected.request.secretConfigId),
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
      authorizationLifetimeMs: selected.request
        .authorizationLifetimeMs as number,
    }),
  });
}

export function normalizeLocalReconciliationSecretConfigDecisionVerifyCommand(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigDecisionVerifyCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.secret-config.decision.verify',
  );
  exact(
    selected.request,
    ['decisionId', 'expectedDecisionDigest', 'secretConfigId'],
    'request',
  );
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.decision.verify',
    options: baseOptions(selected.options),
    request: Object.freeze({
      decisionId: decisionId(selected.request.decisionId),
      secretConfigId: secretConfigId(selected.request.secretConfigId),
      expectedDecisionDigest: digest(
        selected.request.expectedDecisionDigest,
        'expectedDecisionDigest',
      ),
    }),
  });
}
