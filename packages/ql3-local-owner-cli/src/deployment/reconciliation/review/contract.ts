import path from 'node:path';

import { currentIdentity } from '../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../foundation/error';
import {
  LOCAL_RECONCILIATION_PLAN_DOMAINS,
  type LocalReconciliationPlanDomain,
} from '../planning/contract';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PATH_BYTES = 4_096;

export const LOCAL_RECONCILIATION_DIAGNOSTIC_FACT_KINDS = Object.freeze([
  'schema_object',
  'table',
] as const);

export type LocalReconciliationDiagnosticFactKind =
  (typeof LOCAL_RECONCILIATION_DIAGNOSTIC_FACT_KINDS)[number];

export interface LocalReconciliationReviewOptions {
  readonly deploymentRoot: string;
  readonly captureRoot: string;
  readonly planRoot: string;
  readonly reviewRoot: string;
  readonly allowRootService: boolean;
}

export interface LocalReconciliationReviewPrepareCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.review.prepare';
  readonly options: Readonly<LocalReconciliationReviewOptions>;
  readonly request: Readonly<{
    reviewId: string;
    planId: string;
    expectedPlanDigest: string;
    expectedHeadDigest: string;
    preparedAtMs: number;
  }>;
}

export interface LocalReconciliationReviewDiagnosticsCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.review.diagnostics';
  readonly options: Readonly<LocalReconciliationReviewOptions>;
  readonly request: Readonly<{
    reviewId: string;
    expectedPreparationDigest: string;
    database: 'legacy' | 'target';
    domain: LocalReconciliationPlanDomain;
    factKind: LocalReconciliationDiagnosticFactKind;
    offset: number;
    limit: number;
    outputPath: string;
  }>;
}

export interface LocalReconciliationReviewPrepareResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.review.prepare';
  readonly status: 'prepared' | 'existing';
  readonly state: 'reconciliation_review_prepared';
  readonly reviewId: string;
  readonly preparationDigest: string;
  readonly instanceHeadDigest: string;
}

export interface LocalReconciliationReviewDiagnosticsResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.review.diagnostics';
  readonly status: 'prepared' | 'existing';
  readonly state: 'reconciliation_review_prepared';
  readonly reviewId: string;
  readonly pageDigest: string;
  readonly recordCount: number;
  readonly complete: boolean;
  readonly nextOffset: number | null;
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

function normalizeOptions(value: unknown): Readonly<LocalReconciliationReviewOptions> {
  const options = object(value, 'options');
  exact(
    options,
    [
      'allowRootService',
      'captureRoot',
      'deploymentRoot',
      'planRoot',
      'reviewRoot',
    ],
    'options',
  );
  const identity = currentIdentity();
  if (
    typeof options.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== options.allowRootService
  ) {
    configurationError('reconciliation review command identity is invalid');
  }
  const roots = [
    safeAbsolutePath(options.deploymentRoot, 'deploymentRoot'),
    safeAbsolutePath(options.captureRoot, 'captureRoot'),
    safeAbsolutePath(options.planRoot, 'planRoot'),
    safeAbsolutePath(options.reviewRoot, 'reviewRoot'),
  ];
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (overlaps(roots[left]!, roots[right]!) || overlaps(roots[right]!, roots[left]!)) {
        configurationError('deployment, capture, plan and review roots must not overlap');
      }
    }
  }
  return Object.freeze({
    deploymentRoot: roots[0]!,
    captureRoot: roots[1]!,
    planRoot: roots[2]!,
    reviewRoot: roots[3]!,
    allowRootService: options.allowRootService,
  });
}

function normalizeCommand(
  value: unknown,
  operation:
    | 'local.deployment.reconciliation.review.prepare'
    | 'local.deployment.reconciliation.review.diagnostics',
): Readonly<{
  options: Readonly<LocalReconciliationReviewOptions>;
  request: Record<string, unknown>;
}> {
  const command = object(value, 'reconciliation review command');
  exact(command, ['operation', 'options', 'request', 'schemaVersion'], 'command');
  if (command.schemaVersion !== 1 || command.operation !== operation) {
    configurationError('reconciliation review command is invalid');
  }
  return Object.freeze({
    options: normalizeOptions(command.options),
    request: object(command.request, 'request'),
  });
}

export function normalizeLocalReconciliationReviewPrepareCommand(
  value: unknown,
): Readonly<LocalReconciliationReviewPrepareCommand> {
  const command = normalizeCommand(
    value,
    'local.deployment.reconciliation.review.prepare',
  );
  exact(
    command.request,
    [
      'expectedHeadDigest',
      'expectedPlanDigest',
      'planId',
      'preparedAtMs',
      'reviewId',
    ],
    'request',
  );
  if (
    !Number.isSafeInteger(command.request.preparedAtMs) ||
    (command.request.preparedAtMs as number) < 0
  ) {
    configurationError('reconciliation review prepare command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.reconciliation.review.prepare' as const,
    options: command.options,
    request: Object.freeze({
      reviewId: identifier(command.request.reviewId, 'reviewId'),
      planId: identifier(command.request.planId, 'planId'),
      expectedPlanDigest: digest(
        command.request.expectedPlanDigest,
        'expectedPlanDigest',
      ),
      expectedHeadDigest: digest(
        command.request.expectedHeadDigest,
        'expectedHeadDigest',
      ),
      preparedAtMs: command.request.preparedAtMs as number,
    }),
  });
}

export function normalizeLocalReconciliationReviewDiagnosticsCommand(
  value: unknown,
): Readonly<LocalReconciliationReviewDiagnosticsCommand> {
  const command = normalizeCommand(
    value,
    'local.deployment.reconciliation.review.diagnostics',
  );
  exact(
    command.request,
    [
      'database',
      'domain',
      'expectedPreparationDigest',
      'factKind',
      'limit',
      'offset',
      'outputPath',
      'reviewId',
    ],
    'request',
  );
  if (
    (command.request.database !== 'legacy' &&
      command.request.database !== 'target') ||
    !LOCAL_RECONCILIATION_PLAN_DOMAINS.includes(
      command.request.domain as LocalReconciliationPlanDomain,
    ) ||
    !LOCAL_RECONCILIATION_DIAGNOSTIC_FACT_KINDS.includes(
      command.request.factKind as LocalReconciliationDiagnosticFactKind,
    ) ||
    !Number.isSafeInteger(command.request.offset) ||
    (command.request.offset as number) < 0 ||
    (command.request.offset as number) > 4_096 ||
    !Number.isSafeInteger(command.request.limit) ||
    (command.request.limit as number) < 1 ||
    (command.request.limit as number) > 64
  ) {
    configurationError('reconciliation review diagnostics command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.reconciliation.review.diagnostics' as const,
    options: command.options,
    request: Object.freeze({
      reviewId: identifier(command.request.reviewId, 'reviewId'),
      expectedPreparationDigest: digest(
        command.request.expectedPreparationDigest,
        'expectedPreparationDigest',
      ),
      database: command.request.database,
      domain: command.request.domain as LocalReconciliationPlanDomain,
      factKind:
        command.request.factKind as LocalReconciliationDiagnosticFactKind,
      offset: command.request.offset as number,
      limit: command.request.limit as number,
      outputPath: safeAbsolutePath(command.request.outputPath, 'outputPath'),
    }),
  });
}
