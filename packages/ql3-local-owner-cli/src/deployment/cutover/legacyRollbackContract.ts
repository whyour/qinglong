import { LocalDeploymentConfigurationError } from '../foundation/contract';
import {
  normalizeLocalDeploymentTargetStopCommand,
  targetStopRunCommand,
  type LocalDeploymentTargetStopCommand,
} from './targetStopContract';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const EMPTY_ROLLBACK_PREPARATION_DIGEST = '0'.repeat(64);

export type LocalDeploymentLegacyRollbackOperation =
  | 'local.deployment.cutover.legacy-rollback-prepare'
  | 'local.deployment.cutover.legacy-rollback-commit';

export interface LocalDeploymentLegacyRollbackCommand {
  readonly schemaVersion: 1;
  readonly operation: LocalDeploymentLegacyRollbackOperation;
  readonly options: LocalDeploymentTargetStopCommand['options'];
  readonly request: LocalDeploymentTargetStopCommand['request'] &
    Readonly<{
      expectedInstanceHeadDigest: string;
      expectedStoppedRecordDigest: string;
      expectedPreparationDigest: string;
      rollbackRequestedAtMs: number;
    }>;
}

export interface LocalDeploymentLegacyRollbackResult {
  readonly schemaVersion: 1;
  readonly operation: LocalDeploymentLegacyRollbackOperation;
  readonly status: 'prepared' | 'existing';
  readonly state: 'rollback_prepared' | 'legacy_running' | 'manual_required';
  readonly cutoverId: string;
  readonly generation: number;
  readonly preparationDigest: string;
  readonly recordDigest: string;
  readonly instanceHeadDigest: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new LocalDeploymentConfigurationError(`${label} must be an object`);
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
    throw new LocalDeploymentConfigurationError(`${label} shape is invalid`);
  }
}

export function normalizeLocalDeploymentLegacyRollbackCommand(
  value: unknown,
): Readonly<LocalDeploymentLegacyRollbackCommand> {
  const command = object(value, 'command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (
    command.schemaVersion !== 1 ||
    (command.operation !== 'local.deployment.cutover.legacy-rollback-prepare' &&
      command.operation !== 'local.deployment.cutover.legacy-rollback-commit')
  ) {
    throw new LocalDeploymentConfigurationError(
      'legacy rollback schemaVersion or operation is invalid',
    );
  }
  const request = object(command.request, 'request');
  exact(
    request,
    [
      'activationPath',
      'applicationConfigPath',
      'cutoverId',
      'expectedActivationDigest',
      'expectedInstanceHeadDigest',
      'expectedLegacyCommitmentDigest',
      'expectedLegacyContainerId',
      'expectedLegacyDatabasePath',
      'expectedPreparationDigest',
      'expectedStoppedRecordDigest',
      'expectedTargetApplicationConfigPath',
      'expectedTargetCommitmentPath',
      'expectedTargetContainerId',
      'expectedTargetImage',
      'generation',
      'instanceId',
      'legacySourcePath',
      'manifestPath',
      'profile',
      'recoveryPath',
      'requestedAtMs',
      'rollbackRequestedAtMs',
      'targetDatabasePath',
    ],
    'request',
  );
  const {
    expectedInstanceHeadDigest,
    expectedStoppedRecordDigest,
    expectedPreparationDigest,
    rollbackRequestedAtMs,
    ...targetRequest
  } = request;
  const normalized = normalizeLocalDeploymentTargetStopCommand({
    schemaVersion: 1,
    operation: 'local.deployment.cutover.target-stop',
    options: command.options,
    request: targetRequest,
  });
  if (
    typeof expectedInstanceHeadDigest !== 'string' ||
    !DIGEST_PATTERN.test(expectedInstanceHeadDigest) ||
    typeof expectedStoppedRecordDigest !== 'string' ||
    !DIGEST_PATTERN.test(expectedStoppedRecordDigest) ||
    typeof expectedPreparationDigest !== 'string' ||
    !DIGEST_PATTERN.test(expectedPreparationDigest) ||
    (command.operation ===
      'local.deployment.cutover.legacy-rollback-commit') ===
      (expectedPreparationDigest === EMPTY_ROLLBACK_PREPARATION_DIGEST) ||
    !Number.isSafeInteger(rollbackRequestedAtMs) ||
    (rollbackRequestedAtMs as number) < 0
  ) {
    throw new LocalDeploymentConfigurationError(
      'legacy rollback request identity is invalid',
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    options: normalized.options,
    request: Object.freeze({
      ...normalized.request,
      expectedInstanceHeadDigest,
      expectedStoppedRecordDigest,
      expectedPreparationDigest,
      rollbackRequestedAtMs: rollbackRequestedAtMs as number,
    }),
  });
}

export function legacyRollbackTargetRunCommand(
  command: Readonly<LocalDeploymentLegacyRollbackCommand>,
) {
  return targetStopRunCommand({
    schemaVersion: 1,
    operation: 'local.deployment.cutover.target-stop',
    options: command.options,
    request: command.request,
  });
}
