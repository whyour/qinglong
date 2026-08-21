import path from 'node:path';

import { currentIdentity } from '../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../foundation/error';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMEZONE_PATTERN = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;
const MAX_PATH_BYTES = 4_096;
const MAX_TIMEZONE_BYTES = 128;

export const LOCAL_RECONCILIATION_PLAN_DOMAINS = Object.freeze([
  'schema_lineage',
  'automation',
  'secret_and_config',
  'run_history',
  'plugin_package',
  'ai_and_tool',
  'identity_policy_audit',
  'unknown',
] as const);

export type LocalReconciliationPlanDomain =
  (typeof LOCAL_RECONCILIATION_PLAN_DOMAINS)[number];

export type LocalReconciliationPlanDisposition =
  | 'aligned'
  | 'legacy_changed'
  | 'target_changed'
  | 'diverged'
  | 'target_only'
  | 'manual_required'
  | 'unsupported';

export interface LocalReconciliationPlanOptions {
  readonly deploymentRoot: string;
  readonly captureRoot: string;
  readonly planRoot: string;
  readonly allowRootService: boolean;
}

export interface LocalReconciliationPlanPrepareCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.plan.prepare';
  readonly options: Readonly<LocalReconciliationPlanOptions>;
  readonly request: Readonly<{
    planId: string;
    captureId: string;
    expectedBundleDigest: string;
    expectedHeadDigest: string;
    legacyTimezone: string | null;
    preparedAtMs: number;
  }>;
}

export interface LocalReconciliationPlanCommitCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.plan.commit';
  readonly options: Readonly<LocalReconciliationPlanOptions>;
  readonly request: Readonly<{
    planId: string;
    expectedPreparationDigest: string;
    committedAtMs: number;
  }>;
}

export interface LocalReconciliationPlanVerifyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.plan.verify';
  readonly options: Readonly<LocalReconciliationPlanOptions>;
  readonly request: Readonly<{
    planId: string;
    expectedPlanDigest: string;
  }>;
}

export interface LocalReconciliationPlanPrepareResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.plan.prepare';
  readonly status: 'prepared' | 'existing';
  readonly state: 'reconciliation_plan_prepared';
  readonly planId: string;
  readonly preparationDigest: string;
  readonly instanceHeadDigest: string;
}

export interface LocalReconciliationPlanTerminalResult {
  readonly schemaVersion: 1;
  readonly operation:
    | 'local.deployment.reconciliation.plan.commit'
    | 'local.deployment.reconciliation.plan.verify';
  readonly status: 'prepared' | 'existing' | 'verified';
  readonly state: 'reconciliation_planned';
  readonly planId: string;
  readonly planDigest: string;
  readonly outcome: 'review_required' | 'manual_required';
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

function safeAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value ||
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
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

function normalizeOptions(value: unknown): Readonly<LocalReconciliationPlanOptions> {
  const options = object(value, 'options');
  exact(
    options,
    ['allowRootService', 'captureRoot', 'deploymentRoot', 'planRoot'],
    'options',
  );
  const identity = currentIdentity();
  if (
    typeof options.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== options.allowRootService
  ) {
    configurationError('reconciliation plan command identity is invalid');
  }
  const deploymentRoot = safeAbsolutePath(options.deploymentRoot, 'deploymentRoot');
  const captureRoot = safeAbsolutePath(options.captureRoot, 'captureRoot');
  const planRoot = safeAbsolutePath(options.planRoot, 'planRoot');
  if (
    overlaps(deploymentRoot, captureRoot) ||
    overlaps(captureRoot, deploymentRoot) ||
    overlaps(deploymentRoot, planRoot) ||
    overlaps(planRoot, deploymentRoot) ||
    overlaps(captureRoot, planRoot) ||
    overlaps(planRoot, captureRoot)
  ) {
    configurationError('deploymentRoot, captureRoot and planRoot must not overlap');
  }
  return Object.freeze({
    deploymentRoot,
    captureRoot,
    planRoot,
    allowRootService: options.allowRootService,
  });
}

export function normalizeLocalReconciliationPlanPrepareCommand(
  value: unknown,
): Readonly<LocalReconciliationPlanPrepareCommand> {
  const command = object(value, 'reconciliation plan prepare command');
  exact(command, ['operation', 'options', 'request', 'schemaVersion'], 'command');
  const request = object(command.request, 'request');
  exact(
    request,
    [
      'captureId',
      'expectedBundleDigest',
      'expectedHeadDigest',
      'legacyTimezone',
      'planId',
      'preparedAtMs',
    ],
    'request',
  );
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.reconciliation.plan.prepare' ||
    !Number.isSafeInteger(request.preparedAtMs) ||
    (request.preparedAtMs as number) < 0 ||
    (request.legacyTimezone !== null &&
      (typeof request.legacyTimezone !== 'string' ||
        !TIMEZONE_PATTERN.test(request.legacyTimezone) ||
        Buffer.byteLength(request.legacyTimezone, 'utf8') > MAX_TIMEZONE_BYTES))
  ) {
    configurationError('reconciliation plan prepare command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.reconciliation.plan.prepare' as const,
    options: normalizeOptions(command.options),
    request: Object.freeze({
      planId: identifier(request.planId, 'planId'),
      captureId: identifier(request.captureId, 'captureId'),
      expectedBundleDigest: digest(
        request.expectedBundleDigest,
        'expectedBundleDigest',
      ),
      expectedHeadDigest: digest(request.expectedHeadDigest, 'expectedHeadDigest'),
      legacyTimezone: request.legacyTimezone as string | null,
      preparedAtMs: request.preparedAtMs as number,
    }),
  });
}

function normalizeTerminalCommand(
  value: unknown,
  operation:
    | 'local.deployment.reconciliation.plan.commit'
    | 'local.deployment.reconciliation.plan.verify',
): Readonly<{
  command: Record<string, unknown>;
  options: Readonly<LocalReconciliationPlanOptions>;
  request: Record<string, unknown>;
}> {
  const command = object(value, 'reconciliation plan terminal command');
  exact(command, ['operation', 'options', 'request', 'schemaVersion'], 'command');
  if (command.schemaVersion !== 1 || command.operation !== operation) {
    configurationError('reconciliation plan terminal command is invalid');
  }
  return Object.freeze({
    command,
    options: normalizeOptions(command.options),
    request: object(command.request, 'request'),
  });
}

export function normalizeLocalReconciliationPlanCommitCommand(
  value: unknown,
): Readonly<LocalReconciliationPlanCommitCommand> {
  const normalized = normalizeTerminalCommand(
    value,
    'local.deployment.reconciliation.plan.commit',
  );
  exact(
    normalized.request,
    ['committedAtMs', 'expectedPreparationDigest', 'planId'],
    'request',
  );
  if (
    !Number.isSafeInteger(normalized.request.committedAtMs) ||
    (normalized.request.committedAtMs as number) < 0
  ) {
    configurationError('reconciliation plan commit command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.reconciliation.plan.commit' as const,
    options: normalized.options,
    request: Object.freeze({
      planId: identifier(normalized.request.planId, 'planId'),
      expectedPreparationDigest: digest(
        normalized.request.expectedPreparationDigest,
        'expectedPreparationDigest',
      ),
      committedAtMs: normalized.request.committedAtMs as number,
    }),
  });
}

export function normalizeLocalReconciliationPlanVerifyCommand(
  value: unknown,
): Readonly<LocalReconciliationPlanVerifyCommand> {
  const normalized = normalizeTerminalCommand(
    value,
    'local.deployment.reconciliation.plan.verify',
  );
  exact(normalized.request, ['expectedPlanDigest', 'planId'], 'request');
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.reconciliation.plan.verify' as const,
    options: normalized.options,
    request: Object.freeze({
      planId: identifier(normalized.request.planId, 'planId'),
      expectedPlanDigest: digest(
        normalized.request.expectedPlanDigest,
        'expectedPlanDigest',
      ),
    }),
  });
}
