import path from 'node:path';

import { currentIdentity } from '../../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../../foundation/error';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const MAX_PATH_BYTES = 4_096;

export interface LocalReconciliationAutomationOptions {
  readonly deploymentRoot: string;
  readonly applicationRoot: string;
  readonly automationRoot: string;
  readonly allowRootService: boolean;
}

export interface LocalReconciliationAutomationPlanCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.automation.plan';
  readonly options: Readonly<LocalReconciliationAutomationOptions>;
  readonly request: Readonly<{
    automationId: string;
    applicationId: string;
    expectedApplicationPlanDigest: string;
    expectedHeadDigest: string;
    decisionFilePath: string;
    projectId: string;
    legacyTimezone: string | null;
    preparedAtMs: number;
  }>;
}

export interface LocalReconciliationAutomationVerifyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.automation.verify';
  readonly options: Readonly<LocalReconciliationAutomationOptions>;
  readonly request: Readonly<{
    automationId: string;
    expectedAutomationPlanDigest: string;
  }>;
}

export interface LocalReconciliationAutomationPlanResult {
  readonly schemaVersion: 1;
  readonly operation:
    | 'local.deployment.reconciliation.automation.plan'
    | 'local.deployment.reconciliation.automation.verify';
  readonly status: 'prepared' | 'existing' | 'verified';
  readonly state: 'reconciliation_automation_planned';
  readonly automationId: string;
  readonly automationPlanDigest: string;
  readonly outcome: 'ready' | 'manual_required' | 'no_effect';
  readonly rowCount: number;
  readonly eligibleCount: number;
  readonly conflictCount: number;
  readonly instanceHeadDigest: string;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation automation ${message}`,
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

function timezone(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    value.includes('\0')
  ) {
    configurationError('legacyTimezone is invalid');
  }
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    return configurationError('legacyTimezone is unsupported');
  }
}

function normalizeOptions(
  value: unknown,
): Readonly<LocalReconciliationAutomationOptions> {
  const options = object(value, 'options');
  exact(
    options,
    [
      'allowRootService',
      'applicationRoot',
      'automationRoot',
      'deploymentRoot',
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
    safePath(options.automationRoot, 'automationRoot'),
  ];
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (
        overlaps(roots[left]!, roots[right]!) ||
        overlaps(roots[right]!, roots[left]!)
      ) {
        configurationError('deployment, application and automation roots overlap');
      }
    }
  }
  return Object.freeze({
    deploymentRoot: roots[0]!,
    applicationRoot: roots[1]!,
    automationRoot: roots[2]!,
    allowRootService: options.allowRootService,
  });
}

function command(
  value: unknown,
  operation:
    | LocalReconciliationAutomationPlanCommand['operation']
    | LocalReconciliationAutomationVerifyCommand['operation'],
): Readonly<{
  options: Readonly<LocalReconciliationAutomationOptions>;
  request: Record<string, unknown>;
}> {
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
    options: normalizeOptions(selected.options),
    request: object(selected.request, 'request'),
  });
}

export function normalizeLocalReconciliationAutomationPlanCommand(
  value: unknown,
): Readonly<LocalReconciliationAutomationPlanCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.automation.plan',
  );
  exact(
    selected.request,
    [
      'applicationId',
      'automationId',
      'decisionFilePath',
      'expectedApplicationPlanDigest',
      'expectedHeadDigest',
      'legacyTimezone',
      'preparedAtMs',
      'projectId',
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
      selected.options.automationRoot,
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
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.plan',
    options: selected.options,
    request: Object.freeze({
      automationId: identifier(selected.request.automationId, 'automationId'),
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
      legacyTimezone: timezone(selected.request.legacyTimezone),
      preparedAtMs: selected.request.preparedAtMs as number,
    }),
  });
}

export function normalizeLocalReconciliationAutomationVerifyCommand(
  value: unknown,
): Readonly<LocalReconciliationAutomationVerifyCommand> {
  const selected = command(
    value,
    'local.deployment.reconciliation.automation.verify',
  );
  exact(
    selected.request,
    ['automationId', 'expectedAutomationPlanDigest'],
    'request',
  );
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.verify',
    options: selected.options,
    request: Object.freeze({
      automationId: identifier(selected.request.automationId, 'automationId'),
      expectedAutomationPlanDigest: digest(
        selected.request.expectedAutomationPlanDigest,
        'expectedAutomationPlanDigest',
      ),
    }),
  });
}
