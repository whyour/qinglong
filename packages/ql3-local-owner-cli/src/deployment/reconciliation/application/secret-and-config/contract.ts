import path from 'node:path';

import { currentIdentity } from '../../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../../foundation/error';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const MAX_PATH_BYTES = 4_096;

export interface LocalReconciliationSecretConfigOptions {
  readonly deploymentRoot: string;
  readonly applicationRoot: string;
  readonly secretConfigRoot: string;
  readonly allowRootService: boolean;
}

export interface LocalReconciliationSecretConfigAutomationOptions
  extends LocalReconciliationSecretConfigOptions {
  readonly automationApplyRoot: string;
}

export interface LocalReconciliationSecretConfigAutomationBinding {
  readonly automationId: string;
  readonly decisionId: string;
  readonly expectedApplyDigest: string;
}

export interface LocalReconciliationSecretConfigPlanCommand {
  readonly schemaVersion: 1 | 2;
  readonly operation: 'local.deployment.reconciliation.secret-config.plan';
  readonly options: Readonly<
    | LocalReconciliationSecretConfigOptions
    | LocalReconciliationSecretConfigAutomationOptions
  >;
  readonly request: Readonly<{
    secretConfigId: string;
    applicationId: string;
    expectedApplicationPlanDigest: string;
    expectedHeadDigest: string;
    decisionFilePath: string;
    projectId: string;
    preparedAtMs: number;
    automation?: Readonly<LocalReconciliationSecretConfigAutomationBinding>;
  }>;
}

export interface LocalReconciliationSecretConfigVerifyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.secret-config.verify';
  readonly options: Readonly<LocalReconciliationSecretConfigOptions>;
  readonly request: Readonly<{
    secretConfigId: string;
    expectedSecretConfigPlanDigest: string;
  }>;
}

export interface LocalReconciliationSecretConfigPlanResult {
  readonly schemaVersion: 1;
  readonly operation:
    | LocalReconciliationSecretConfigPlanCommand['operation']
    | LocalReconciliationSecretConfigVerifyCommand['operation'];
  readonly status: 'prepared' | 'existing' | 'verified';
  readonly state: 'reconciliation_secret_config_planned';
  readonly secretConfigId: string;
  readonly secretConfigPlanDigest: string;
  readonly outcome: 'ready' | 'manual_required' | 'no_effect';
  readonly rowCount: number;
  readonly eligibleBindingCount: number;
  readonly eligiblePreservationCount: number;
  readonly targetConflictCount: number;
  readonly adoptedLegacyTaskCount: number;
  readonly unadaptedLegacyConfigCount: number;
  readonly instanceHeadDigest: string;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation secret config ${message}`,
  );
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

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    configurationError(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    configurationError(`${label} must be a lowercase UUID v4`);
  }
  return value;
}

function projectId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    configurationError('projectId is invalid');
  }
  return value;
}

function normalizeOptions(
  value: unknown,
  schemaVersion: 1 | 2,
): Readonly<
  | LocalReconciliationSecretConfigOptions
  | LocalReconciliationSecretConfigAutomationOptions
> {
  const options = object(value, 'options');
  exact(
    options,
    [
      'allowRootService',
      'applicationRoot',
      ...(schemaVersion === 2 ? ['automationApplyRoot'] : []),
      'deploymentRoot',
      'secretConfigRoot',
    ],
    'options',
  );
  const identity = currentIdentity();
  if (
    typeof options.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== options.allowRootService
  ) {
    configurationError('command identity is invalid');
  }
  const roots = [
    safePath(options.deploymentRoot, 'deploymentRoot'),
    safePath(options.applicationRoot, 'applicationRoot'),
    safePath(options.secretConfigRoot, 'secretConfigRoot'),
    ...(schemaVersion === 2
      ? [safePath(options.automationApplyRoot, 'automationApplyRoot')]
      : []),
  ];
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
    deploymentRoot: roots[0]!,
    applicationRoot: roots[1]!,
    secretConfigRoot: roots[2]!,
    ...(schemaVersion === 2 ? { automationApplyRoot: roots[3]! } : {}),
    allowRootService: options.allowRootService,
  });
}

function command(
  value: unknown,
  operation:
    | LocalReconciliationSecretConfigPlanCommand['operation']
    | LocalReconciliationSecretConfigVerifyCommand['operation'],
): Readonly<{
  schemaVersion: 1 | 2;
  options: Readonly<
    | LocalReconciliationSecretConfigOptions
    | LocalReconciliationSecretConfigAutomationOptions
  >;
  request: Record<string, unknown>;
}> {
  const selected = object(value, 'command');
  exact(
    selected,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  const schemaVersion = selected.schemaVersion;
  if (
    (schemaVersion !== 1 &&
      (schemaVersion !== 2 ||
        operation !== 'local.deployment.reconciliation.secret-config.plan')) ||
    selected.operation !== operation
  ) {
    configurationError('command version or operation is invalid');
  }
  return Object.freeze({
    schemaVersion,
    options: normalizeOptions(selected.options, schemaVersion),
    request: object(selected.request, 'request'),
  });
}

function automationBinding(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigAutomationBinding> {
  const selected = object(value, 'automation binding');
  exact(
    selected,
    ['automationId', 'decisionId', 'expectedApplyDigest'],
    'automation binding',
  );
  return Object.freeze({
    automationId: identifier(selected.automationId, 'automationId'),
    decisionId:
      typeof selected.decisionId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        selected.decisionId,
      )
        ? selected.decisionId
        : configurationError('decisionId is invalid'),
    expectedApplyDigest: digest(
      selected.expectedApplyDigest,
      'expectedApplyDigest',
    ),
  });
}

export function normalizeLocalReconciliationSecretConfigPlanCommand(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigPlanCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.secret-config.plan',
  );
  exact(
    selected.request,
    [
      'applicationId',
      ...(selected.schemaVersion === 2 ? ['automation'] : []),
      'decisionFilePath',
      'expectedApplicationPlanDigest',
      'expectedHeadDigest',
      'preparedAtMs',
      'projectId',
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
      selected.options.deploymentRoot,
      selected.options.applicationRoot,
      selected.options.secretConfigRoot,
    ].some(
      (root) =>
        overlaps(root, decisionFilePath) || overlaps(decisionFilePath, root),
    )
  ) {
    configurationError('decisionFilePath overlaps an authority root');
  }
  if (
    !Number.isSafeInteger(selected.request.preparedAtMs) ||
    (selected.request.preparedAtMs as number) < 0
  ) {
    configurationError('preparedAtMs is invalid');
  }
  return Object.freeze({
    schemaVersion: selected.schemaVersion,
    operation: 'local.deployment.reconciliation.secret-config.plan',
    options: selected.options,
    request: Object.freeze({
      secretConfigId: identifier(
        selected.request.secretConfigId,
        'secretConfigId',
      ),
      applicationId: identifier(
        selected.request.applicationId,
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
      decisionFilePath,
      projectId: projectId(selected.request.projectId),
      preparedAtMs: selected.request.preparedAtMs as number,
      ...(selected.schemaVersion === 2
        ? { automation: automationBinding(selected.request.automation) }
        : {}),
    }),
  });
}

export function normalizeLocalReconciliationSecretConfigVerifyCommand(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigVerifyCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.secret-config.verify',
  );
  exact(
    selected.request,
    ['expectedSecretConfigPlanDigest', 'secretConfigId'],
    'request',
  );
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.verify',
    options: Object.freeze({
      deploymentRoot: selected.options.deploymentRoot,
      applicationRoot: selected.options.applicationRoot,
      secretConfigRoot: selected.options.secretConfigRoot,
      allowRootService: selected.options.allowRootService,
    }),
    request: Object.freeze({
      secretConfigId: identifier(
        selected.request.secretConfigId,
        'secretConfigId',
      ),
      expectedSecretConfigPlanDigest: digest(
        selected.request.expectedSecretConfigPlanDigest,
        'expectedSecretConfigPlanDigest',
      ),
    }),
  });
}
