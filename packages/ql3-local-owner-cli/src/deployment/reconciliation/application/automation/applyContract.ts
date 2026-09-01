import path from 'node:path';

import { currentIdentity } from '../../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../../foundation/error';

const DIGEST = /^[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/@-]+$/;
const SAFE_ID = /^[A-Za-z0-9._:@-]{1,256}$/;

export interface LocalReconciliationAutomationApplyOptions {
  readonly deploymentRoot: string;
  readonly applicationRoot: string;
  readonly automationRoot: string;
  readonly automationDecisionRoot: string;
  readonly automationApplyRoot: string;
  readonly targetDatabasePath: string;
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly allowRootService: boolean;
  readonly busyTimeoutMs?: number;
}

export interface LocalReconciliationAutomationApplyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.automation.apply';
  readonly options: Readonly<LocalReconciliationAutomationApplyOptions>;
  readonly request: Readonly<{
    decisionId: string;
    automationId: string;
    expectedDecisionDigest: string;
    expectedHeadDigest: string;
    mutationId: string;
    requestId: string;
    appliedAtMs: number;
  }>;
}

export interface LocalReconciliationAutomationApplyVerifyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.automation.apply.verify';
  readonly options: Readonly<LocalReconciliationAutomationApplyOptions>;
  readonly request: Readonly<{
    decisionId: string;
    automationId: string;
    expectedApplyDigest: string;
  }>;
}

export interface LocalReconciliationAutomationApplyRollbackCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.automation.apply.rollback';
  readonly options: Readonly<LocalReconciliationAutomationApplyOptions>;
  readonly request: Readonly<{
    decisionId: string;
    automationId: string;
    expectedApplyDigest: string;
    expectedHeadDigest: string;
    rolledBackAtMs: number;
  }>;
}

export interface LocalReconciliationAutomationApplyResult {
  readonly schemaVersion: 1;
  readonly operation:
    | LocalReconciliationAutomationApplyCommand['operation']
    | LocalReconciliationAutomationApplyVerifyCommand['operation']
    | LocalReconciliationAutomationApplyRollbackCommand['operation'];
  readonly status: 'applied' | 'existing' | 'verified' | 'rolled_back';
  readonly state:
    | 'reconciliation_automation_applied'
    | 'reconciliation_automation_rolled_back';
  readonly decisionId: string;
  readonly automationId: string;
  readonly applyDigest: string;
  readonly publicationDigest: string;
  readonly adoptedTaskCount: number;
  readonly adoptedTriggerCount: number;
  readonly backupSha256: string;
  readonly instanceHeadDigest: string;
}

function fail(message: string): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation automation apply ${message}`,
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
    actual.some((key, i) => key !== expected[i])
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
  )
    fail(`${label} must be a safe non-root absolute path`);
  return value;
}

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function options(
  value: unknown,
): Readonly<LocalReconciliationAutomationApplyOptions> {
  const selected = record(value, 'options');
  const hasBusyTimeout = Object.hasOwn(selected, 'busyTimeoutMs');
  exact(
    selected,
    [
      'allowRootService',
      'applicationRoot',
      'automationApplyRoot',
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
  const identity = currentIdentity();
  if (
    typeof selected.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== selected.allowRootService
  )
    fail('command identity is invalid');
  const normalized = {
    deploymentRoot: safePath(selected.deploymentRoot, 'deploymentRoot'),
    applicationRoot: safePath(selected.applicationRoot, 'applicationRoot'),
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
    normalized.automationRoot,
    normalized.automationDecisionRoot,
    normalized.automationApplyRoot,
  ];
  for (let i = 0; i < roots.length; i += 1) {
    for (let j = i + 1; j < roots.length; j += 1) {
      if (overlaps(roots[i]!, roots[j]!) || overlaps(roots[j]!, roots[i]!)) {
        fail('authority roots overlap');
      }
    }
  }
  for (const candidate of [
    normalized.ownerPepperKeyringDirectory,
    normalized.credentialFilePath,
  ]) {
    const relative = path.relative(normalized.deploymentRoot, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      fail('authentication material must be below deploymentRoot');
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
  if (selected.schemaVersion !== 1 || selected.operation !== operation)
    fail('command version or operation is invalid');
  return {
    options: options(selected.options),
    request: record(selected.request, 'request'),
  } as const;
}

function id(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value))
    fail(`${label} is invalid`);
  return value;
}

function digest(value: unknown, label: string): string {
  return id(value, DIGEST, label);
}

export function normalizeLocalReconciliationAutomationApplyCommand(
  value: unknown,
): Readonly<LocalReconciliationAutomationApplyCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.automation.apply',
  );
  exact(
    selected.request,
    [
      'appliedAtMs',
      'automationId',
      'decisionId',
      'expectedDecisionDigest',
      'expectedHeadDigest',
      'mutationId',
      'requestId',
    ],
    'request',
  );
  if (
    !Number.isSafeInteger(selected.request.appliedAtMs) ||
    (selected.request.appliedAtMs as number) < 0 ||
    typeof selected.request.requestId !== 'string' ||
    !SAFE_ID.test(selected.request.requestId)
  )
    fail('apply request timestamp or requestId is invalid');
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.apply',
    options: selected.options,
    request: Object.freeze({
      decisionId: id(selected.request.decisionId, UUID_V7, 'decisionId'),
      automationId: id(selected.request.automationId, UUID_V4, 'automationId'),
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

export function normalizeLocalReconciliationAutomationApplyVerifyCommand(
  value: unknown,
): Readonly<LocalReconciliationAutomationApplyVerifyCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.automation.apply.verify',
  );
  exact(
    selected.request,
    ['automationId', 'decisionId', 'expectedApplyDigest'],
    'request',
  );
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.apply.verify',
    options: selected.options,
    request: Object.freeze({
      decisionId: id(selected.request.decisionId, UUID_V7, 'decisionId'),
      automationId: id(selected.request.automationId, UUID_V4, 'automationId'),
      expectedApplyDigest: digest(
        selected.request.expectedApplyDigest,
        'expectedApplyDigest',
      ),
    }),
  });
}

export function normalizeLocalReconciliationAutomationApplyRollbackCommand(
  value: unknown,
): Readonly<LocalReconciliationAutomationApplyRollbackCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.automation.apply.rollback',
  );
  exact(
    selected.request,
    [
      'automationId',
      'decisionId',
      'expectedApplyDigest',
      'expectedHeadDigest',
      'rolledBackAtMs',
    ],
    'request',
  );
  if (
    !Number.isSafeInteger(selected.request.rolledBackAtMs) ||
    (selected.request.rolledBackAtMs as number) < 0
  )
    fail('rolledBackAtMs is invalid');
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.apply.rollback',
    options: selected.options,
    request: Object.freeze({
      decisionId: id(selected.request.decisionId, UUID_V7, 'decisionId'),
      automationId: id(selected.request.automationId, UUID_V4, 'automationId'),
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
