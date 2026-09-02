import path from 'node:path';

import { currentIdentity } from '../../../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../../../foundation/error';

const DIGEST = /^[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/@-]+$/;
const SAFE_ID = /^[A-Za-z0-9._:@-]{1,256}$/;

export interface LocalReconciliationSecretConfigApplyOptions {
  readonly deploymentRoot: string;
  readonly applicationRoot: string;
  readonly secretConfigRoot: string;
  readonly secretConfigDecisionRoot: string;
  readonly secretConfigApplyRoot: string;
  readonly targetDatabasePath: string;
  readonly secretKeyringPath: string;
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly allowRootService: boolean;
  readonly busyTimeoutMs?: number;
}

export interface LocalReconciliationSecretConfigApplyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.secret-config.apply';
  readonly options: Readonly<LocalReconciliationSecretConfigApplyOptions>;
  readonly request: Readonly<{
    decisionId: string;
    secretConfigId: string;
    expectedDecisionDigest: string;
    expectedHeadDigest: string;
    mutationId: string;
    requestId: string;
    appliedAtMs: number;
  }>;
}

export interface LocalReconciliationSecretConfigApplyVerifyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.secret-config.apply.verify';
  readonly options: Readonly<LocalReconciliationSecretConfigApplyOptions>;
  readonly request: Readonly<{
    decisionId: string;
    secretConfigId: string;
    expectedApplyDigest: string;
  }>;
}

export interface LocalReconciliationSecretConfigApplyRollbackCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.secret-config.apply.rollback';
  readonly options: Readonly<LocalReconciliationSecretConfigApplyOptions>;
  readonly request: Readonly<{
    decisionId: string;
    secretConfigId: string;
    expectedApplyDigest: string;
    expectedHeadDigest: string;
    rolledBackAtMs: number;
  }>;
}

export interface LocalReconciliationSecretConfigApplyResult {
  readonly schemaVersion: 1;
  readonly operation:
    | LocalReconciliationSecretConfigApplyCommand['operation']
    | LocalReconciliationSecretConfigApplyVerifyCommand['operation']
    | LocalReconciliationSecretConfigApplyRollbackCommand['operation'];
  readonly status: 'applied' | 'existing' | 'verified' | 'rolled_back';
  readonly state:
    | 'reconciliation_secret_config_applied'
    | 'reconciliation_secret_config_rolled_back';
  readonly decisionId: string;
  readonly secretConfigId: string;
  readonly applyDigest: string;
  readonly publicationDigest: string;
  readonly activeBindingCount: number;
  readonly disabledPreservationCount: number;
  readonly updatedTaskCount: number;
  readonly updatedTriggerCount: number;
  readonly backupSha256: string;
  readonly instanceHeadDigest: string;
}

function fail(message: string): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation secret config apply ${message}`,
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
    Buffer.byteLength(value, 'utf8') > 4096
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

function normalizeOptions(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigApplyOptions> {
  const selected = record(value, 'options');
  const hasBusyTimeout = Object.hasOwn(selected, 'busyTimeoutMs');
  exact(
    selected,
    [
      'allowRootService',
      'applicationRoot',
      'credentialFilePath',
      'deploymentRoot',
      'ownerPepperKeyringDirectory',
      'secretConfigApplyRoot',
      'secretConfigDecisionRoot',
      'secretConfigRoot',
      'secretKeyringPath',
      'targetDatabasePath',
      ...(hasBusyTimeout ? ['busyTimeoutMs'] : []),
    ],
    'options',
  );
  const identity = currentIdentity();
  if (
    typeof selected.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== selected.allowRootService
  ) {
    fail('command identity is invalid');
  }
  const normalized = {
    deploymentRoot: safePath(selected.deploymentRoot, 'deploymentRoot'),
    applicationRoot: safePath(selected.applicationRoot, 'applicationRoot'),
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
    secretKeyringPath: safePath(
      selected.secretKeyringPath,
      'secretKeyringPath',
    ),
    ownerPepperKeyringDirectory: safePath(
      selected.ownerPepperKeyringDirectory,
      'ownerPepperKeyringDirectory',
    ),
    credentialFilePath: safePath(
      selected.credentialFilePath,
      'credentialFilePath',
    ),
  };
  const roots = [
    normalized.deploymentRoot,
    normalized.applicationRoot,
    normalized.secretConfigRoot,
    normalized.secretConfigDecisionRoot,
    normalized.secretConfigApplyRoot,
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
  for (const candidate of [
    normalized.secretKeyringPath,
    normalized.ownerPepperKeyringDirectory,
    normalized.credentialFilePath,
  ]) {
    const relative = path.relative(normalized.deploymentRoot, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      fail('authentication or Secret material must be below deploymentRoot');
    }
  }
  const targetRelative = path.relative(
    normalized.deploymentRoot,
    normalized.targetDatabasePath,
  );
  if (
    !targetRelative ||
    targetRelative.startsWith('..') ||
    path.isAbsolute(targetRelative)
  ) {
    fail('targetDatabasePath must be below deploymentRoot');
  }
  if (
    roots
      .slice(1)
      .some(
        (root) =>
          overlaps(root, normalized.targetDatabasePath) ||
          overlaps(normalized.targetDatabasePath, root),
      )
  ) {
    fail('targetDatabasePath overlaps an authority root');
  }
  if (
    selected.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(selected.busyTimeoutMs) ||
      (selected.busyTimeoutMs as number) < 1 ||
      (selected.busyTimeoutMs as number) > 60_000)
  ) {
    fail('busyTimeoutMs is invalid');
  }
  return Object.freeze({
    ...normalized,
    allowRootService: selected.allowRootService as boolean,
    ...(selected.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: selected.busyTimeoutMs as number }),
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
  return {
    options: normalizeOptions(selected.options),
    request: record(selected.request, 'request'),
  } as const;
}

function id(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  return id(value, DIGEST, label);
}

export function normalizeLocalReconciliationSecretConfigApplyCommand(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigApplyCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.secret-config.apply',
  );
  exact(
    selected.request,
    [
      'appliedAtMs',
      'decisionId',
      'expectedDecisionDigest',
      'expectedHeadDigest',
      'mutationId',
      'requestId',
      'secretConfigId',
    ],
    'request',
  );
  if (
    !Number.isSafeInteger(selected.request.appliedAtMs) ||
    (selected.request.appliedAtMs as number) < 0 ||
    typeof selected.request.requestId !== 'string' ||
    !SAFE_ID.test(selected.request.requestId)
  ) {
    fail('apply request timestamp or requestId is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.apply',
    options: selected.options,
    request: Object.freeze({
      decisionId: id(selected.request.decisionId, UUID_V7, 'decisionId'),
      secretConfigId: id(
        selected.request.secretConfigId,
        UUID_V4,
        'secretConfigId',
      ),
      expectedDecisionDigest: digest(
        selected.request.expectedDecisionDigest,
        'expectedDecisionDigest',
      ),
      expectedHeadDigest: digest(
        selected.request.expectedHeadDigest,
        'expectedHeadDigest',
      ),
      mutationId: id(selected.request.mutationId, UUID_V4, 'mutationId'),
      requestId: selected.request.requestId,
      appliedAtMs: selected.request.appliedAtMs as number,
    }),
  });
}

export function normalizeLocalReconciliationSecretConfigApplyVerifyCommand(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigApplyVerifyCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.secret-config.apply.verify',
  );
  exact(
    selected.request,
    ['decisionId', 'expectedApplyDigest', 'secretConfigId'],
    'request',
  );
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.apply.verify',
    options: selected.options,
    request: Object.freeze({
      decisionId: id(selected.request.decisionId, UUID_V7, 'decisionId'),
      secretConfigId: id(
        selected.request.secretConfigId,
        UUID_V4,
        'secretConfigId',
      ),
      expectedApplyDigest: digest(
        selected.request.expectedApplyDigest,
        'expectedApplyDigest',
      ),
    }),
  });
}

export function normalizeLocalReconciliationSecretConfigApplyRollbackCommand(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigApplyRollbackCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.secret-config.apply.rollback',
  );
  exact(
    selected.request,
    [
      'decisionId',
      'expectedApplyDigest',
      'expectedHeadDigest',
      'rolledBackAtMs',
      'secretConfigId',
    ],
    'request',
  );
  if (
    !Number.isSafeInteger(selected.request.rolledBackAtMs) ||
    (selected.request.rolledBackAtMs as number) < 0
  ) {
    fail('rolledBackAtMs is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.apply.rollback',
    options: selected.options,
    request: Object.freeze({
      decisionId: id(selected.request.decisionId, UUID_V7, 'decisionId'),
      secretConfigId: id(
        selected.request.secretConfigId,
        UUID_V4,
        'secretConfigId',
      ),
      expectedApplyDigest: digest(
        selected.request.expectedApplyDigest,
        'expectedApplyDigest',
      ),
      expectedHeadDigest: digest(
        selected.request.expectedHeadDigest,
        'expectedHeadDigest',
      ),
      rolledBackAtMs: selected.request.rolledBackAtMs as number,
    }),
  });
}
