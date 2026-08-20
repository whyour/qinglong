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
const LEGACY_VERSION_PATTERN =
  /^2\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface LocalDeploymentLegacyReadinessCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.cutover.legacy-readiness-probe';
  readonly options: Readonly<{
    deploymentRoot: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<{
    cutoverId: string;
    profile: LocalDeploymentProfile;
    instanceId: string;
    generation: number;
    expectedActivationDigest: string;
    expectedInstanceHeadDigest: string;
    expectedLegacyRunningRecordDigest: string;
    legacyHttpPort: number;
    expectedLegacyVersion: string;
    requestedAtMs: number;
  }>;
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

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new LocalDeploymentConfigurationError(`${label} is invalid`);
  }
  return value as number;
}

export function normalizeLocalDeploymentLegacyReadinessCommand(
  value: unknown,
): Readonly<LocalDeploymentLegacyReadinessCommand> {
  const command = object(value, 'command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.cutover.legacy-readiness-probe'
  ) {
    throw new LocalDeploymentConfigurationError(
      'legacy readiness schemaVersion or operation is invalid',
    );
  }
  const identity = currentIdentity();
  const options = object(command.options, 'options');
  exact(options, ['allowRootService', 'deploymentRoot'], 'options');
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
      'cutoverId',
      'expectedActivationDigest',
      'expectedInstanceHeadDigest',
      'expectedLegacyRunningRecordDigest',
      'expectedLegacyVersion',
      'generation',
      'instanceId',
      'legacyHttpPort',
      'profile',
      'requestedAtMs',
    ],
    'request',
  );
  if (
    typeof request.cutoverId !== 'string' ||
    !CUTOVER_ID_PATTERN.test(request.cutoverId) ||
    (request.profile !== 'edge' && request.profile !== 'standalone') ||
    typeof request.instanceId !== 'string' ||
    !INSTANCE_ID_PATTERN.test(request.instanceId) ||
    typeof request.expectedActivationDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedActivationDigest) ||
    typeof request.expectedInstanceHeadDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedInstanceHeadDigest) ||
    typeof request.expectedLegacyRunningRecordDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedLegacyRunningRecordDigest) ||
    typeof request.expectedLegacyVersion !== 'string' ||
    !LEGACY_VERSION_PATTERN.test(request.expectedLegacyVersion)
  ) {
    throw new LocalDeploymentConfigurationError(
      'legacy readiness request identity is invalid',
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.cutover.legacy-readiness-probe' as const,
    options: Object.freeze({
      deploymentRoot: safeAbsolutePath(
        options.deploymentRoot,
        'deploymentRoot',
      ),
      allowRootService: options.allowRootService,
    }),
    request: Object.freeze({
      cutoverId: request.cutoverId,
      profile: request.profile,
      instanceId: request.instanceId,
      generation: integer(request.generation, 1, 15, 'generation'),
      expectedActivationDigest: request.expectedActivationDigest,
      expectedInstanceHeadDigest: request.expectedInstanceHeadDigest,
      expectedLegacyRunningRecordDigest:
        request.expectedLegacyRunningRecordDigest,
      legacyHttpPort: integer(
        request.legacyHttpPort,
        1,
        65_535,
        'legacyHttpPort',
      ),
      expectedLegacyVersion: request.expectedLegacyVersion,
      requestedAtMs: integer(
        request.requestedAtMs,
        0,
        Number.MAX_SAFE_INTEGER,
        'requestedAtMs',
      ),
    }),
  });
}
