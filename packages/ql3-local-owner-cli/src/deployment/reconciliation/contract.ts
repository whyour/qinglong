import path from 'node:path';

import { currentIdentity } from '../foundation/contract';
import { LocalDeploymentConfigurationError } from '../foundation/error';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PATH_BYTES = 4_096;

export type LocalReconciliationStoppedAuthority = 'docker' | 'service-manager';

export interface LocalReconciliationCapturePrepareCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.capture.prepare';
  readonly options: Readonly<{
    deploymentRoot: string;
    captureRoot: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<{
    captureId: string;
    stoppedAuthority: LocalReconciliationStoppedAuthority;
    profile: 'edge' | 'standalone';
    instanceId: string;
    cutoverId: string;
    generation: number;
    applicationConfigPath: string;
    activationPath: string;
    legacySourcePath: string;
    targetDatabasePath: string;
    recoveryPath: string;
    expectedActivationDigest: string;
    expectedHeadDigest: string;
    expectedStoppedRecordDigest: string;
    preparedAtMs: number;
  }>;
}

export interface LocalReconciliationCapturePrepareResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.capture.prepare';
  readonly status: 'prepared' | 'existing';
  readonly state: 'reconciliation_capture_prepared';
  readonly captureId: string;
  readonly preparationDigest: string;
  readonly instanceHeadDigest: string;
}

export interface LocalReconciliationCaptureCommitCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.capture.commit';
  readonly options: LocalReconciliationCapturePrepareCommand['options'];
  readonly request: Readonly<{
    captureId: string;
    expectedPreparationDigest: string;
    committedAtMs: number;
  }>;
}

export interface LocalReconciliationCaptureVerifyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.reconciliation.capture.verify';
  readonly options: LocalReconciliationCapturePrepareCommand['options'];
  readonly request: Readonly<{
    captureId: string;
    expectedBundleDigest: string;
  }>;
}

export interface LocalReconciliationCaptureTerminalResult {
  readonly schemaVersion: 1;
  readonly operation:
    | 'local.deployment.reconciliation.capture.commit'
    | 'local.deployment.reconciliation.capture.verify';
  readonly status: 'prepared' | 'existing' | 'verified';
  readonly state: 'reconciliation_captured';
  readonly captureId: string;
  readonly bundleDigest: string;
  readonly profile: 'edge' | 'standalone';
  readonly assetCount: number;
  readonly totalBytes: number;
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

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    configurationError(`${label} must be a SHA-256 digest`);
  }
  return value;
}

export function normalizeLocalReconciliationCapturePrepareCommand(
  value: unknown,
): Readonly<LocalReconciliationCapturePrepareCommand> {
  const command = object(value, 'reconciliation capture prepare command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  const options = object(command.options, 'options');
  exact(
    options,
    ['allowRootService', 'captureRoot', 'deploymentRoot'],
    'options',
  );
  const request = object(command.request, 'request');
  exact(
    request,
    [
      'activationPath',
      'applicationConfigPath',
      'captureId',
      'cutoverId',
      'expectedActivationDigest',
      'expectedHeadDigest',
      'expectedStoppedRecordDigest',
      'generation',
      'instanceId',
      'legacySourcePath',
      'preparedAtMs',
      'profile',
      'recoveryPath',
      'stoppedAuthority',
      'targetDatabasePath',
    ],
    'request',
  );
  const identity = currentIdentity();
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.reconciliation.capture.prepare' ||
    typeof options.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== options.allowRootService ||
    typeof request.captureId !== 'string' ||
    !UUID_V4_PATTERN.test(request.captureId) ||
    (request.stoppedAuthority !== 'docker' &&
      request.stoppedAuthority !== 'service-manager') ||
    (request.profile !== 'edge' && request.profile !== 'standalone') ||
    typeof request.instanceId !== 'string' ||
    request.instanceId.length < 1 ||
    request.instanceId.length > 128 ||
    typeof request.cutoverId !== 'string' ||
    request.cutoverId.length < 1 ||
    request.cutoverId.length > 128 ||
    !Number.isSafeInteger(request.generation) ||
    (request.generation as number) < 1 ||
    !Number.isSafeInteger(request.preparedAtMs) ||
    (request.preparedAtMs as number) < 0
  ) {
    configurationError('reconciliation capture prepare command is invalid');
  }
  const deploymentRoot = safeAbsolutePath(
    options.deploymentRoot,
    'deploymentRoot',
  );
  const captureRoot = safeAbsolutePath(options.captureRoot, 'captureRoot');
  if (captureRoot === deploymentRoot) {
    configurationError('captureRoot must be distinct from deploymentRoot');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.reconciliation.capture.prepare' as const,
    options: Object.freeze({
      deploymentRoot,
      captureRoot,
      allowRootService: options.allowRootService,
    }),
    request: Object.freeze({
      captureId: request.captureId,
      stoppedAuthority: request.stoppedAuthority,
      profile: request.profile,
      instanceId: request.instanceId,
      cutoverId: request.cutoverId,
      generation: request.generation as number,
      applicationConfigPath: safeAbsolutePath(
        request.applicationConfigPath,
        'applicationConfigPath',
      ),
      activationPath: safeAbsolutePath(
        request.activationPath,
        'activationPath',
      ),
      legacySourcePath: safeAbsolutePath(
        request.legacySourcePath,
        'legacySourcePath',
      ),
      targetDatabasePath: safeAbsolutePath(
        request.targetDatabasePath,
        'targetDatabasePath',
      ),
      recoveryPath: safeAbsolutePath(request.recoveryPath, 'recoveryPath'),
      expectedActivationDigest: digest(
        request.expectedActivationDigest,
        'expectedActivationDigest',
      ),
      expectedHeadDigest: digest(
        request.expectedHeadDigest,
        'expectedHeadDigest',
      ),
      expectedStoppedRecordDigest: digest(
        request.expectedStoppedRecordDigest,
        'expectedStoppedRecordDigest',
      ),
      preparedAtMs: request.preparedAtMs as number,
    }),
  });
}

function normalizeTerminalOptions(value: unknown): Readonly<{
  deploymentRoot: string;
  captureRoot: string;
  allowRootService: boolean;
}> {
  const options = object(value, 'options');
  exact(
    options,
    ['allowRootService', 'captureRoot', 'deploymentRoot'],
    'options',
  );
  const identity = currentIdentity();
  if (
    typeof options.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== options.allowRootService
  ) {
    configurationError('capture command identity is invalid');
  }
  const deploymentRoot = safeAbsolutePath(
    options.deploymentRoot,
    'deploymentRoot',
  );
  const captureRoot = safeAbsolutePath(options.captureRoot, 'captureRoot');
  if (captureRoot === deploymentRoot) {
    configurationError('captureRoot must be distinct from deploymentRoot');
  }
  return Object.freeze({
    deploymentRoot,
    captureRoot,
    allowRootService: options.allowRootService,
  });
}

export function normalizeLocalReconciliationCaptureCommitCommand(
  value: unknown,
): Readonly<LocalReconciliationCaptureCommitCommand> {
  const command = object(value, 'reconciliation capture commit command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  const request = object(command.request, 'request');
  exact(
    request,
    ['captureId', 'committedAtMs', 'expectedPreparationDigest'],
    'request',
  );
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.reconciliation.capture.commit' ||
    typeof request.captureId !== 'string' ||
    !UUID_V4_PATTERN.test(request.captureId) ||
    !Number.isSafeInteger(request.committedAtMs) ||
    (request.committedAtMs as number) < 0
  ) {
    configurationError('reconciliation capture commit command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.reconciliation.capture.commit' as const,
    options: normalizeTerminalOptions(command.options),
    request: Object.freeze({
      captureId: request.captureId,
      expectedPreparationDigest: digest(
        request.expectedPreparationDigest,
        'expectedPreparationDigest',
      ),
      committedAtMs: request.committedAtMs as number,
    }),
  });
}

export function normalizeLocalReconciliationCaptureVerifyCommand(
  value: unknown,
): Readonly<LocalReconciliationCaptureVerifyCommand> {
  const command = object(value, 'reconciliation capture verify command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  const request = object(command.request, 'request');
  exact(request, ['captureId', 'expectedBundleDigest'], 'request');
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.reconciliation.capture.verify' ||
    typeof request.captureId !== 'string' ||
    !UUID_V4_PATTERN.test(request.captureId)
  ) {
    configurationError('reconciliation capture verify command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.reconciliation.capture.verify' as const,
    options: normalizeTerminalOptions(command.options),
    request: Object.freeze({
      captureId: request.captureId,
      expectedBundleDigest: digest(
        request.expectedBundleDigest,
        'expectedBundleDigest',
      ),
    }),
  });
}
