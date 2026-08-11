import fs from 'node:fs';
import path from 'node:path';

import {
  currentIdentity,
  LocalDeploymentConfigurationError,
  type LocalDeploymentProfile,
} from '../../foundation/contract';

const MAX_PATH_BYTES = 4_096;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CUTOVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}@sha256:[0-9a-f]{64}$/;
const MAX_TARGET_GENERATION = 15;

export type LocalDeploymentTargetRunOperation =
  | 'local.deployment.cutover.target-start'
  | 'local.deployment.cutover.target-restart';

export interface LocalDeploymentTargetRunCommand {
  readonly schemaVersion: 1;
  readonly operation: LocalDeploymentTargetRunOperation;
  readonly options: Readonly<{
    deploymentRoot: string;
    dockerExecutable: string;
    dockerSocketPath: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<{
    cutoverId: string;
    profile: LocalDeploymentProfile;
    instanceId: string;
    activationPath: string;
    legacySourcePath: string;
    targetDatabasePath: string;
    recoveryPath: string;
    manifestPath: string;
    expectedLegacyDatabasePath: string;
    expectedActivationDigest: string;
    expectedLegacyCommitmentDigest: string;
    expectedLegacyContainerId: string;
    expectedTargetContainerId: string;
    expectedTargetImage: string;
    applicationConfigPath: string;
    expectedTargetApplicationConfigPath: string;
    expectedTargetCommitmentPath: string;
    generation: number;
    requestedAtMs: number;
  }>;
}

export interface LocalDeploymentTargetRunResult {
  readonly schemaVersion: 1;
  readonly operation: LocalDeploymentTargetRunOperation;
  readonly status: 'prepared' | 'existing';
  readonly state: 'target_active' | 'manual_required';
  readonly cutoverId: string;
  readonly generation: number;
  readonly recordDigest: string;
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
    throw new LocalDeploymentConfigurationError(
      `${label} must be a supervisor-safe normalized absolute non-root path`,
    );
  }
  return value;
}

function trustedExecutable(value: unknown, uid: number): string {
  const filePath = safeAbsolutePath(value, 'dockerExecutable');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new LocalDeploymentConfigurationError(
      'dockerExecutable is unavailable',
      { cause: error },
    );
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(filePath) !== filePath ||
    (stat.uid !== 0 && stat.uid !== uid) ||
    (stat.mode & 0o022) !== 0 ||
    (stat.mode & 0o111) === 0
  ) {
    throw new LocalDeploymentConfigurationError(
      'dockerExecutable must be a canonical trusted executable',
    );
  }
  return filePath;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new LocalDeploymentConfigurationError(`${label} is invalid`);
  }
  return value as number;
}

export function normalizeLocalDeploymentTargetRunCommand(
  value: unknown,
): Readonly<LocalDeploymentTargetRunCommand> {
  const command = object(value, 'command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (
    command.schemaVersion !== 1 ||
    (command.operation !== 'local.deployment.cutover.target-start' &&
      command.operation !== 'local.deployment.cutover.target-restart')
  ) {
    throw new LocalDeploymentConfigurationError(
      'schemaVersion or operation is invalid',
    );
  }
  const identity = currentIdentity();
  const options = object(command.options, 'options');
  exact(
    options,
    [
      'allowRootService',
      'deploymentRoot',
      'dockerExecutable',
      'dockerSocketPath',
    ],
    'options',
  );
  if (
    typeof options.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== options.allowRootService
  ) {
    throw new LocalDeploymentConfigurationError(
      'allowRootService does not match the current identity',
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
      'expectedLegacyCommitmentDigest',
      'expectedLegacyContainerId',
      'expectedLegacyDatabasePath',
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
      'targetDatabasePath',
    ],
    'request',
  );
  const generation = integer(request.generation, 'generation', 1);
  if (
    typeof request.cutoverId !== 'string' ||
    !CUTOVER_ID_PATTERN.test(request.cutoverId) ||
    (request.profile !== 'edge' && request.profile !== 'standalone') ||
    typeof request.instanceId !== 'string' ||
    !INSTANCE_ID_PATTERN.test(request.instanceId) ||
    typeof request.expectedActivationDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedActivationDigest) ||
    typeof request.expectedLegacyCommitmentDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedLegacyCommitmentDigest) ||
    typeof request.expectedLegacyContainerId !== 'string' ||
    !CONTAINER_ID_PATTERN.test(request.expectedLegacyContainerId) ||
    typeof request.expectedTargetContainerId !== 'string' ||
    !CONTAINER_ID_PATTERN.test(request.expectedTargetContainerId) ||
    request.expectedTargetContainerId === request.expectedLegacyContainerId ||
    typeof request.expectedTargetImage !== 'string' ||
    !IMAGE_DIGEST_PATTERN.test(request.expectedTargetImage) ||
    generation > MAX_TARGET_GENERATION ||
    (command.operation === 'local.deployment.cutover.target-start' &&
      generation !== 1) ||
    (command.operation === 'local.deployment.cutover.target-restart' &&
      generation < 2)
  ) {
    throw new LocalDeploymentConfigurationError(
      'target run request identity is invalid',
    );
  }
  if (
    new Set([
      request.activationPath,
      request.legacySourcePath,
      request.targetDatabasePath,
      request.recoveryPath,
      request.manifestPath,
      request.applicationConfigPath,
    ]).size !== 6
  ) {
    throw new LocalDeploymentConfigurationError(
      'target run authority paths must be distinct',
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    options: Object.freeze({
      deploymentRoot: safeAbsolutePath(
        options.deploymentRoot,
        'deploymentRoot',
      ),
      dockerExecutable: trustedExecutable(
        options.dockerExecutable,
        identity.uid,
      ),
      dockerSocketPath: safeAbsolutePath(
        options.dockerSocketPath,
        'dockerSocketPath',
      ),
      allowRootService: options.allowRootService,
    }),
    request: Object.freeze({
      cutoverId: request.cutoverId,
      profile: request.profile,
      instanceId: request.instanceId,
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
      manifestPath: safeAbsolutePath(request.manifestPath, 'manifestPath'),
      expectedLegacyDatabasePath: safeAbsolutePath(
        request.expectedLegacyDatabasePath,
        'expectedLegacyDatabasePath',
      ),
      expectedActivationDigest: request.expectedActivationDigest,
      expectedLegacyCommitmentDigest: request.expectedLegacyCommitmentDigest,
      expectedLegacyContainerId: request.expectedLegacyContainerId,
      expectedTargetContainerId: request.expectedTargetContainerId,
      expectedTargetImage: request.expectedTargetImage,
      applicationConfigPath: safeAbsolutePath(
        request.applicationConfigPath,
        'applicationConfigPath',
      ),
      expectedTargetApplicationConfigPath: safeAbsolutePath(
        request.expectedTargetApplicationConfigPath,
        'expectedTargetApplicationConfigPath',
      ),
      expectedTargetCommitmentPath: safeAbsolutePath(
        request.expectedTargetCommitmentPath,
        'expectedTargetCommitmentPath',
      ),
      generation,
      requestedAtMs: integer(request.requestedAtMs, 'requestedAtMs', 0),
    }),
  });
}
