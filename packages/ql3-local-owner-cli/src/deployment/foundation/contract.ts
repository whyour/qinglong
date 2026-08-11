import fs from 'node:fs';
import path from 'node:path';

import type { LocalSetupResult } from '../../lifecycle/localSetup';

const MAX_PATH_BYTES = 4_096;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const KEY_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IMAGE_DIGEST_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}@sha256:[0-9a-f]{64}$/;

export type LocalDeploymentProfile = 'edge' | 'standalone';
export type LocalDeploymentServiceKind = 'systemd' | 'openrc' | 'compose';

export interface LocalDeploymentProcessService {
  readonly kind: 'systemd' | 'openrc';
  readonly nodeExecutable: string;
  readonly applicationEntrypoint: string;
  readonly allowRootService: boolean;
}

export interface LocalDeploymentComposeService {
  readonly kind: 'compose';
  readonly image: string;
  readonly allowRootService: boolean;
}

export type LocalDeploymentService =
  | LocalDeploymentProcessService
  | LocalDeploymentComposeService;

export interface LocalDeploymentPrepareCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.prepare';
  readonly options: Readonly<{
    deploymentRoot: string;
    profile: LocalDeploymentProfile;
    instanceId: string;
    busyTimeoutMs?: number;
    service: Readonly<LocalDeploymentService>;
  }>;
  readonly request: Readonly<{
    ownerPepperKeyId: string;
    registerMutationId: string;
    activateMutationId: string;
    registeredAtMs: number;
    activatedAtMs: number;
  }>;
}

export interface LocalDeploymentPrepareResult {
  readonly schemaVersion: 1;
  readonly status: 'prepared' | 'existing';
  readonly profile: LocalDeploymentProfile;
  readonly service: Readonly<{
    kind: LocalDeploymentServiceKind;
    status: 'prepared' | 'existing';
  }>;
  readonly applicationConfiguration: Readonly<{
    schema: 'qinglong/local-application-process@v2';
    status: 'prepared' | 'existing';
  }>;
  readonly directories: Readonly<{
    created: number;
    existing: number;
  }>;
  readonly setup: Readonly<LocalSetupResult>;
}

export interface LocalDeploymentStatusCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.status';
  readonly options: Readonly<{
    deploymentRoot: string;
    allowRootService: boolean;
  }>;
}

export interface LocalDeploymentStatusResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.status';
  readonly status: 'observed';
  readonly observation: 'durable';
  readonly profile: LocalDeploymentProfile;
  readonly applicationConfiguration: Readonly<{
    schema: 'qinglong/local-application-process@v2';
    state: 'present';
  }>;
  readonly runtime: Readonly<{
    health: 'unobserved';
  }>;
  readonly service:
    | Readonly<{
        kind: 'systemd' | 'openrc';
        descriptor: 'present';
      }>
    | Readonly<{
        kind: 'compose';
        descriptor: 'present';
        generation: number;
        rollbackTargetGeneration: number | null;
        transition: 'stable' | 'recovery_required';
        fences: Readonly<{
          revision: 'idle' | 'in_flight';
          rollout: 'idle' | 'in_flight';
          restore: 'idle' | 'in_flight';
          evidenceCollection: 'idle' | 'in_flight';
        }>;
      }>;
}

export interface LocalDeploymentComposeUpgradeCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.compose.upgrade';
  readonly options: Readonly<{
    deploymentRoot: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<{
    expectedGeneration: number;
    image: string;
    mutationId: string;
    changedAtMs: number;
  }>;
}

export interface LocalDeploymentComposeRollbackCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.compose.rollback';
  readonly options: Readonly<{
    deploymentRoot: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<{
    expectedGeneration: number;
    targetGeneration: number;
    mutationId: string;
    changedAtMs: number;
  }>;
}

export type LocalDeploymentComposeRevisionCommand =
  | LocalDeploymentComposeUpgradeCommand
  | LocalDeploymentComposeRollbackCommand;

export interface LocalDeploymentComposeRevisionResult {
  readonly schemaVersion: 1;
  readonly operation:
    | 'local.deployment.compose.upgrade'
    | 'local.deployment.compose.rollback';
  readonly status: 'prepared' | 'existing';
  readonly generation: number;
  readonly service: Readonly<{
    kind: 'compose';
  }>;
}

export interface LocalDeploymentComposePreflightCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.compose.preflight';
  readonly options: Readonly<{
    deploymentRoot: string;
    dockerExecutable: string;
    dockerSocketPath: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<{
    expectedGeneration: number;
  }>;
}

export interface LocalDeploymentComposePreflightResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.compose.preflight';
  readonly status: 'ready';
  readonly generation: number;
  readonly profile: LocalDeploymentProfile;
  readonly sqlite: Readonly<{
    contractVersion: number;
  }>;
  readonly image: Readonly<{
    architecture: 'amd64' | 'arm64';
  }>;
  readonly service: Readonly<{
    kind: 'compose';
  }>;
}

export interface LocalDeploymentComposeApplyCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.compose.apply';
  readonly options: Readonly<{
    deploymentRoot: string;
    dockerExecutable: string;
    dockerSocketPath: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<{
    expectedGeneration: number;
    rolloutId: string;
    startedAtMs: number;
    failureRollbackMutationId: string;
    failureRollbackChangedAtMs: number;
  }>;
}

export interface LocalDeploymentComposeApplyResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.compose.apply';
  readonly status: 'active' | 'rolled_back' | 'failed_stopped';
  readonly attemptedGeneration: number;
  readonly activeGeneration: number | null;
  readonly profile: LocalDeploymentProfile;
  readonly health: Readonly<{
    event: 'active' | 'unavailable';
  }>;
  readonly service: Readonly<{
    kind: 'compose';
  }>;
}

export interface LocalDeploymentComposeRestorePrepareCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.compose.restore.prepare';
  readonly options: Readonly<{
    deploymentRoot: string;
    dockerExecutable: string;
    dockerSocketPath: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<{
    expectedGeneration: number;
    restoreId: string;
    sourceRolloutId: string;
    preparedAtMs: number;
  }>;
}

export interface LocalDeploymentComposeRestoreCommitCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.compose.restore.commit';
  readonly options: Readonly<{
    deploymentRoot: string;
    dockerExecutable: string;
    dockerSocketPath: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<{
    expectedGeneration: number;
    restoreId: string;
    committedAtMs: number;
  }>;
}

export type LocalDeploymentComposeRestoreCommand =
  | LocalDeploymentComposeRestorePrepareCommand
  | LocalDeploymentComposeRestoreCommitCommand;

export interface LocalDeploymentComposeRestoreResult {
  readonly schemaVersion: 1;
  readonly operation:
    | 'local.deployment.compose.restore.prepare'
    | 'local.deployment.compose.restore.commit';
  readonly status: 'prepared' | 'existing' | 'restored';
  readonly generation: number;
  readonly profile: LocalDeploymentProfile;
  readonly sqlite: Readonly<{
    source: 'ready' | 'collected';
    safeguard: 'ready' | 'collected';
  }>;
  readonly service: Readonly<{
    kind: 'compose';
    state: 'stopped' | 'unchanged';
  }>;
}

export interface LocalDeploymentComposeEvidenceCollectionPrepareCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.compose.evidence-collection.prepare';
  readonly options: Readonly<{
    deploymentRoot: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<{
    expectedGeneration: number;
    collectionId: string;
    rolloutIds: readonly string[];
    restoreIds: readonly string[];
    preparedAtMs: number;
  }>;
}

export interface LocalDeploymentComposeEvidenceCollectionCommitCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.compose.evidence-collection.commit';
  readonly options: Readonly<{
    deploymentRoot: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<{
    expectedGeneration: number;
    collectionId: string;
    committedAtMs: number;
  }>;
}

export type LocalDeploymentComposeEvidenceCollectionCommand =
  | LocalDeploymentComposeEvidenceCollectionPrepareCommand
  | LocalDeploymentComposeEvidenceCollectionCommitCommand;

export interface LocalDeploymentComposeEvidenceCollectionResult {
  readonly schemaVersion: 1;
  readonly operation:
    | 'local.deployment.compose.evidence-collection.prepare'
    | 'local.deployment.compose.evidence-collection.commit';
  readonly status: 'prepared' | 'existing' | 'collected';
  readonly generation: number;
  readonly profile: LocalDeploymentProfile;
  readonly collected: Readonly<{
    rolloutBackups: number;
    restoreSafeguards: number;
    bytes: number;
  }>;
  readonly service: Readonly<{
    kind: 'compose';
    state: 'unchanged';
  }>;
}

export class LocalDeploymentConfigurationError extends TypeError {
  readonly code = 'QL3_LOCAL_DEPLOYMENT_CONFIGURATION_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`Local deployment configuration is invalid: ${message}`, options);
    this.name = 'LocalDeploymentConfigurationError';
  }
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

function boundedInteger(
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

export function currentIdentity(): Readonly<{ uid: number; gid: number }> {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    typeof process.getgid !== 'function' ||
    typeof process.getegid !== 'function'
  ) {
    throw new LocalDeploymentConfigurationError(
      'a POSIX process identity is required',
    );
  }
  const uid = process.getuid();
  const gid = process.getgid();
  if (uid !== process.geteuid() || gid !== process.getegid()) {
    throw new LocalDeploymentConfigurationError(
      'real and effective POSIX identities must match',
    );
  }
  return Object.freeze({ uid, gid });
}

function validateRootAcknowledgement(
  allowRootService: unknown,
  uid: number,
): boolean {
  if (typeof allowRootService !== 'boolean') {
    throw new LocalDeploymentConfigurationError(
      'allowRootService must be boolean',
    );
  }
  if ((uid === 0) !== allowRootService) {
    throw new LocalDeploymentConfigurationError(
      uid === 0
        ? 'root execution requires explicit allowRootService=true'
        : 'allowRootService must be false for a non-root service identity',
    );
  }
  return allowRootService;
}

function validateExecutable(
  value: unknown,
  label: string,
  executable: boolean,
  uid: number,
): string {
  const filePath = safeAbsolutePath(value, label);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new LocalDeploymentConfigurationError(`${label} is unavailable`, {
      cause: error,
    });
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(filePath) !== filePath ||
    (stat.uid !== 0 && stat.uid !== uid) ||
    (stat.mode & 0o022) !== 0 ||
    (executable && (stat.mode & 0o111) === 0)
  ) {
    throw new LocalDeploymentConfigurationError(
      `${label} must be a canonical trusted regular file`,
    );
  }
  return filePath;
}

function normalizeService(
  value: unknown,
  uid: number,
): Readonly<LocalDeploymentService> {
  const service = object(value, 'service');
  if (service.kind === 'systemd' || service.kind === 'openrc') {
    exact(
      service,
      ['allowRootService', 'applicationEntrypoint', 'kind', 'nodeExecutable'],
      'service',
    );
    return Object.freeze({
      kind: service.kind,
      nodeExecutable: validateExecutable(
        service.nodeExecutable,
        'nodeExecutable',
        true,
        uid,
      ),
      applicationEntrypoint: validateExecutable(
        service.applicationEntrypoint,
        'applicationEntrypoint',
        false,
        uid,
      ),
      allowRootService: validateRootAcknowledgement(
        service.allowRootService,
        uid,
      ),
    });
  }
  if (service.kind === 'compose') {
    exact(service, ['allowRootService', 'image', 'kind'], 'service');
    if (
      typeof service.image !== 'string' ||
      !IMAGE_DIGEST_PATTERN.test(service.image) ||
      service.image.includes('..') ||
      service.image.includes('//') ||
      service.image.split('@').length !== 2
    ) {
      throw new LocalDeploymentConfigurationError(
        'compose image must be an immutable sha256 reference',
      );
    }
    return Object.freeze({
      kind: 'compose' as const,
      image: service.image,
      allowRootService: validateRootAcknowledgement(
        service.allowRootService,
        uid,
      ),
    });
  }
  throw new LocalDeploymentConfigurationError('service kind is invalid');
}

export function normalizeLocalDeploymentPrepareCommand(
  value: unknown,
): Readonly<LocalDeploymentPrepareCommand> {
  const command = object(value, 'command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.prepare'
  ) {
    throw new LocalDeploymentConfigurationError(
      'schemaVersion or operation is invalid',
    );
  }
  const options = object(command.options, 'options');
  const optionalKeys = Object.hasOwn(options, 'busyTimeoutMs')
    ? ['busyTimeoutMs']
    : [];
  exact(
    options,
    ['deploymentRoot', 'instanceId', 'profile', 'service', ...optionalKeys],
    'options',
  );
  if (options.profile !== 'edge' && options.profile !== 'standalone') {
    throw new LocalDeploymentConfigurationError('profile is invalid');
  }
  if (
    typeof options.instanceId !== 'string' ||
    !INSTANCE_ID_PATTERN.test(options.instanceId)
  ) {
    throw new LocalDeploymentConfigurationError('instanceId is invalid');
  }
  const identity = currentIdentity();
  const request = object(command.request, 'request');
  exact(
    request,
    [
      'activateMutationId',
      'activatedAtMs',
      'ownerPepperKeyId',
      'registerMutationId',
      'registeredAtMs',
    ],
    'request',
  );
  if (
    typeof request.ownerPepperKeyId !== 'string' ||
    !KEY_ID_PATTERN.test(request.ownerPepperKeyId) ||
    typeof request.registerMutationId !== 'string' ||
    !UUID_V4_PATTERN.test(request.registerMutationId) ||
    typeof request.activateMutationId !== 'string' ||
    !UUID_V4_PATTERN.test(request.activateMutationId) ||
    request.activateMutationId === request.registerMutationId
  ) {
    throw new LocalDeploymentConfigurationError('setup identity is invalid');
  }
  const registeredAtMs = boundedInteger(
    request.registeredAtMs,
    0,
    Number.MAX_SAFE_INTEGER,
    'registeredAtMs',
  );
  const activatedAtMs = boundedInteger(
    request.activatedAtMs,
    registeredAtMs,
    Number.MAX_SAFE_INTEGER,
    'activatedAtMs',
  );
  const busyTimeoutMs =
    options.busyTimeoutMs === undefined
      ? undefined
      : boundedInteger(options.busyTimeoutMs, 100, 30_000, 'busyTimeoutMs');
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.prepare' as const,
    options: Object.freeze({
      deploymentRoot: safeAbsolutePath(
        options.deploymentRoot,
        'deploymentRoot',
      ),
      profile: options.profile,
      instanceId: options.instanceId,
      ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
      service: normalizeService(options.service, identity.uid),
    }),
    request: Object.freeze({
      ownerPepperKeyId: request.ownerPepperKeyId,
      registerMutationId: request.registerMutationId,
      activateMutationId: request.activateMutationId,
      registeredAtMs,
      activatedAtMs,
    }),
  });
}

export function normalizeLocalDeploymentStatusCommand(
  value: unknown,
): Readonly<LocalDeploymentStatusCommand> {
  const command = object(value, 'command');
  exact(command, ['operation', 'options', 'schemaVersion'], 'command');
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.status'
  ) {
    throw new LocalDeploymentConfigurationError(
      'schemaVersion or operation is invalid',
    );
  }
  const identity = currentIdentity();
  const options = object(command.options, 'options');
  exact(options, ['allowRootService', 'deploymentRoot'], 'options');
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.status' as const,
    options: Object.freeze({
      deploymentRoot: safeAbsolutePath(
        options.deploymentRoot,
        'deploymentRoot',
      ),
      allowRootService: validateRootAcknowledgement(
        options.allowRootService,
        identity.uid,
      ),
    }),
  });
}

export function normalizeLocalDeploymentComposeRevisionCommand(
  value: unknown,
): Readonly<LocalDeploymentComposeRevisionCommand> {
  const command = object(value, 'command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (
    command.schemaVersion !== 1 ||
    (command.operation !== 'local.deployment.compose.upgrade' &&
      command.operation !== 'local.deployment.compose.rollback')
  ) {
    throw new LocalDeploymentConfigurationError(
      'schemaVersion or operation is invalid',
    );
  }
  const identity = currentIdentity();
  const options = object(command.options, 'options');
  exact(options, ['allowRootService', 'deploymentRoot'], 'options');
  const normalizedOptions = Object.freeze({
    deploymentRoot: safeAbsolutePath(options.deploymentRoot, 'deploymentRoot'),
    allowRootService: validateRootAcknowledgement(
      options.allowRootService,
      identity.uid,
    ),
  });
  const request = object(command.request, 'request');
  if (command.operation === 'local.deployment.compose.upgrade') {
    exact(
      request,
      ['changedAtMs', 'expectedGeneration', 'image', 'mutationId'],
      'request',
    );
    const service = normalizeService(
      {
        kind: 'compose',
        image: request.image,
        allowRootService: normalizedOptions.allowRootService,
      },
      identity.uid,
    ) as Readonly<LocalDeploymentComposeService>;
    if (
      typeof request.mutationId !== 'string' ||
      !UUID_V4_PATTERN.test(request.mutationId)
    ) {
      throw new LocalDeploymentConfigurationError(
        'revision mutation identity is invalid',
      );
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      operation: 'local.deployment.compose.upgrade' as const,
      options: normalizedOptions,
      request: Object.freeze({
        expectedGeneration: boundedInteger(
          request.expectedGeneration,
          1,
          99_999,
          'expectedGeneration',
        ),
        image: service.image,
        mutationId: request.mutationId,
        changedAtMs: boundedInteger(
          request.changedAtMs,
          0,
          Number.MAX_SAFE_INTEGER,
          'changedAtMs',
        ),
      }),
    });
  }
  exact(
    request,
    ['changedAtMs', 'expectedGeneration', 'mutationId', 'targetGeneration'],
    'request',
  );
  if (
    typeof request.mutationId !== 'string' ||
    !UUID_V4_PATTERN.test(request.mutationId)
  ) {
    throw new LocalDeploymentConfigurationError(
      'revision mutation identity is invalid',
    );
  }
  const expectedGeneration = boundedInteger(
    request.expectedGeneration,
    2,
    99_999,
    'expectedGeneration',
  );
  const targetGeneration = boundedInteger(
    request.targetGeneration,
    1,
    expectedGeneration - 1,
    'targetGeneration',
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.compose.rollback' as const,
    options: normalizedOptions,
    request: Object.freeze({
      expectedGeneration,
      targetGeneration,
      mutationId: request.mutationId,
      changedAtMs: boundedInteger(
        request.changedAtMs,
        0,
        Number.MAX_SAFE_INTEGER,
        'changedAtMs',
      ),
    }),
  });
}

export function normalizeLocalDeploymentComposePreflightCommand(
  value: unknown,
): Readonly<LocalDeploymentComposePreflightCommand> {
  const command = object(value, 'command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.compose.preflight'
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
  const request = object(command.request, 'request');
  exact(request, ['expectedGeneration'], 'request');
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.compose.preflight' as const,
    options: Object.freeze({
      deploymentRoot: safeAbsolutePath(
        options.deploymentRoot,
        'deploymentRoot',
      ),
      dockerExecutable: validateExecutable(
        options.dockerExecutable,
        'dockerExecutable',
        true,
        identity.uid,
      ),
      dockerSocketPath: safeAbsolutePath(
        options.dockerSocketPath,
        'dockerSocketPath',
      ),
      allowRootService: validateRootAcknowledgement(
        options.allowRootService,
        identity.uid,
      ),
    }),
    request: Object.freeze({
      expectedGeneration: boundedInteger(
        request.expectedGeneration,
        1,
        100_000,
        'expectedGeneration',
      ),
    }),
  });
}

export function normalizeLocalDeploymentComposeApplyCommand(
  value: unknown,
): Readonly<LocalDeploymentComposeApplyCommand> {
  const command = object(value, 'command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.compose.apply'
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
  const request = object(command.request, 'request');
  exact(
    request,
    [
      'expectedGeneration',
      'failureRollbackChangedAtMs',
      'failureRollbackMutationId',
      'rolloutId',
      'startedAtMs',
    ],
    'request',
  );
  if (
    typeof request.rolloutId !== 'string' ||
    !UUID_V4_PATTERN.test(request.rolloutId) ||
    typeof request.failureRollbackMutationId !== 'string' ||
    !UUID_V4_PATTERN.test(request.failureRollbackMutationId) ||
    request.failureRollbackMutationId === request.rolloutId
  ) {
    throw new LocalDeploymentConfigurationError(
      'compose rollout identity is invalid',
    );
  }
  const startedAtMs = boundedInteger(
    request.startedAtMs,
    0,
    Number.MAX_SAFE_INTEGER,
    'startedAtMs',
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.compose.apply' as const,
    options: Object.freeze({
      deploymentRoot: safeAbsolutePath(
        options.deploymentRoot,
        'deploymentRoot',
      ),
      dockerExecutable: validateExecutable(
        options.dockerExecutable,
        'dockerExecutable',
        true,
        identity.uid,
      ),
      dockerSocketPath: safeAbsolutePath(
        options.dockerSocketPath,
        'dockerSocketPath',
      ),
      allowRootService: validateRootAcknowledgement(
        options.allowRootService,
        identity.uid,
      ),
    }),
    request: Object.freeze({
      expectedGeneration: boundedInteger(
        request.expectedGeneration,
        1,
        99_999,
        'expectedGeneration',
      ),
      rolloutId: request.rolloutId,
      startedAtMs,
      failureRollbackMutationId: request.failureRollbackMutationId,
      failureRollbackChangedAtMs: boundedInteger(
        request.failureRollbackChangedAtMs,
        startedAtMs,
        Number.MAX_SAFE_INTEGER,
        'failureRollbackChangedAtMs',
      ),
    }),
  });
}

export function normalizeLocalDeploymentComposeRestoreCommand(
  value: unknown,
): Readonly<LocalDeploymentComposeRestoreCommand> {
  const command = object(value, 'command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (
    command.schemaVersion !== 1 ||
    (command.operation !== 'local.deployment.compose.restore.prepare' &&
      command.operation !== 'local.deployment.compose.restore.commit')
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
  const normalizedOptions = Object.freeze({
    deploymentRoot: safeAbsolutePath(options.deploymentRoot, 'deploymentRoot'),
    dockerExecutable: validateExecutable(
      options.dockerExecutable,
      'dockerExecutable',
      true,
      identity.uid,
    ),
    dockerSocketPath: safeAbsolutePath(
      options.dockerSocketPath,
      'dockerSocketPath',
    ),
    allowRootService: validateRootAcknowledgement(
      options.allowRootService,
      identity.uid,
    ),
  });
  const request = object(command.request, 'request');
  if (command.operation === 'local.deployment.compose.restore.prepare') {
    exact(
      request,
      ['expectedGeneration', 'preparedAtMs', 'restoreId', 'sourceRolloutId'],
      'request',
    );
    if (
      typeof request.restoreId !== 'string' ||
      !UUID_V4_PATTERN.test(request.restoreId) ||
      typeof request.sourceRolloutId !== 'string' ||
      !UUID_V4_PATTERN.test(request.sourceRolloutId) ||
      request.restoreId === request.sourceRolloutId
    ) {
      throw new LocalDeploymentConfigurationError(
        'compose restore identity is invalid',
      );
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      operation: 'local.deployment.compose.restore.prepare' as const,
      options: normalizedOptions,
      request: Object.freeze({
        expectedGeneration: boundedInteger(
          request.expectedGeneration,
          2,
          100_000,
          'expectedGeneration',
        ),
        restoreId: request.restoreId,
        sourceRolloutId: request.sourceRolloutId,
        preparedAtMs: boundedInteger(
          request.preparedAtMs,
          0,
          Number.MAX_SAFE_INTEGER,
          'preparedAtMs',
        ),
      }),
    });
  }
  exact(
    request,
    ['committedAtMs', 'expectedGeneration', 'restoreId'],
    'request',
  );
  if (
    typeof request.restoreId !== 'string' ||
    !UUID_V4_PATTERN.test(request.restoreId)
  ) {
    throw new LocalDeploymentConfigurationError(
      'compose restore identity is invalid',
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.compose.restore.commit' as const,
    options: normalizedOptions,
    request: Object.freeze({
      expectedGeneration: boundedInteger(
        request.expectedGeneration,
        2,
        100_000,
        'expectedGeneration',
      ),
      restoreId: request.restoreId,
      committedAtMs: boundedInteger(
        request.committedAtMs,
        0,
        Number.MAX_SAFE_INTEGER,
        'committedAtMs',
      ),
    }),
  });
}

function normalizeEvidenceIds(
  value: unknown,
  label: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 4 ||
    value.some(
      (entry) => typeof entry !== 'string' || !UUID_V4_PATTERN.test(entry),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new LocalDeploymentConfigurationError(`${label} is invalid`);
  }
  return Object.freeze([...value]) as readonly string[];
}

export function normalizeLocalDeploymentComposeEvidenceCollectionCommand(
  value: unknown,
): Readonly<LocalDeploymentComposeEvidenceCollectionCommand> {
  const command = object(value, 'command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (
    command.schemaVersion !== 1 ||
    (command.operation !==
      'local.deployment.compose.evidence-collection.prepare' &&
      command.operation !==
        'local.deployment.compose.evidence-collection.commit')
  ) {
    throw new LocalDeploymentConfigurationError(
      'schemaVersion or operation is invalid',
    );
  }
  const identity = currentIdentity();
  const options = object(command.options, 'options');
  exact(options, ['allowRootService', 'deploymentRoot'], 'options');
  const normalizedOptions = Object.freeze({
    deploymentRoot: safeAbsolutePath(options.deploymentRoot, 'deploymentRoot'),
    allowRootService: validateRootAcknowledgement(
      options.allowRootService,
      identity.uid,
    ),
  });
  const request = object(command.request, 'request');
  if (
    command.operation === 'local.deployment.compose.evidence-collection.prepare'
  ) {
    exact(
      request,
      [
        'collectionId',
        'expectedGeneration',
        'preparedAtMs',
        'restoreIds',
        'rolloutIds',
      ],
      'request',
    );
    const rolloutIds = normalizeEvidenceIds(request.rolloutIds, 'rolloutIds');
    const restoreIds = normalizeEvidenceIds(request.restoreIds, 'restoreIds');
    if (
      typeof request.collectionId !== 'string' ||
      !UUID_V4_PATTERN.test(request.collectionId) ||
      rolloutIds.length + restoreIds.length < 1 ||
      rolloutIds.includes(request.collectionId) ||
      restoreIds.includes(request.collectionId)
    ) {
      throw new LocalDeploymentConfigurationError(
        'compose evidence collection identity is invalid',
      );
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      operation:
        'local.deployment.compose.evidence-collection.prepare' as const,
      options: normalizedOptions,
      request: Object.freeze({
        expectedGeneration: boundedInteger(
          request.expectedGeneration,
          1,
          100_000,
          'expectedGeneration',
        ),
        collectionId: request.collectionId,
        rolloutIds,
        restoreIds,
        preparedAtMs: boundedInteger(
          request.preparedAtMs,
          0,
          Number.MAX_SAFE_INTEGER,
          'preparedAtMs',
        ),
      }),
    });
  }
  exact(
    request,
    ['collectionId', 'committedAtMs', 'expectedGeneration'],
    'request',
  );
  if (
    typeof request.collectionId !== 'string' ||
    !UUID_V4_PATTERN.test(request.collectionId)
  ) {
    throw new LocalDeploymentConfigurationError(
      'compose evidence collection identity is invalid',
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.compose.evidence-collection.commit' as const,
    options: normalizedOptions,
    request: Object.freeze({
      expectedGeneration: boundedInteger(
        request.expectedGeneration,
        1,
        100_000,
        'expectedGeneration',
      ),
      collectionId: request.collectionId,
      committedAtMs: boundedInteger(
        request.committedAtMs,
        0,
        Number.MAX_SAFE_INTEGER,
        'committedAtMs',
      ),
    }),
  });
}
