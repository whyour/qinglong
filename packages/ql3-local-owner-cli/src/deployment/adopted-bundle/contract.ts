import fs from 'node:fs';
import path from 'node:path';

import {
  LocalComposeReleaseSelectionError,
  resolveLocalComposeReleaseSelection,
  type LocalComposeReleaseSelectionInput,
  type ResolvedLocalComposeReleaseSelection,
} from '../compose/releaseSelection';
import {
  currentIdentity,
  type LocalDeploymentProcessService,
  type LocalDeploymentProfile,
} from '../foundation/contract';
import { LocalDeploymentConfigurationError } from '../foundation/error';

const MAX_PATH_BYTES = 4_096;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type LocalDeploymentAdoptedBundleOperation =
  | 'local.deployment.adopted.prepare'
  | 'local.deployment.adopted.verify';

export interface LocalDeploymentAdoptedComposeService {
  readonly kind: 'compose';
  readonly releaseSelection: Readonly<LocalComposeReleaseSelectionInput>;
  readonly allowRootService: boolean;
}

export interface NormalizedLocalDeploymentAdoptedComposeService
  extends Omit<LocalDeploymentAdoptedComposeService, 'releaseSelection'> {
  readonly releaseSelection: Readonly<ResolvedLocalComposeReleaseSelection>;
}

export type LocalDeploymentAdoptedService =
  | LocalDeploymentProcessService
  | LocalDeploymentAdoptedComposeService;

export type NormalizedLocalDeploymentAdoptedService =
  | Readonly<LocalDeploymentProcessService>
  | Readonly<NormalizedLocalDeploymentAdoptedComposeService>;

export interface LocalDeploymentAdoptedBundleCommand {
  readonly schemaVersion: 1;
  readonly operation: LocalDeploymentAdoptedBundleOperation;
  readonly options: Readonly<{
    deploymentRoot: string;
    profile: LocalDeploymentProfile;
    instanceId: string;
    busyTimeoutMs?: number;
    service: Readonly<LocalDeploymentAdoptedService>;
  }>;
  readonly request: Readonly<{
    bundleId: string;
    preparedAtMs: number;
    cutoverId: string;
    storage: Readonly<{
      sourcePath: string;
      targetPath: string;
      recoveryPath: string;
      manifestPath: string;
      activationPath: string;
      expectedActivationDigest: string;
    }>;
    cutover: Readonly<{
      commitmentPath: string;
      expectedCommitmentDigest: string;
    }>;
    legacyDataApplication: Readonly<{
      commitPath: string;
      expectedCommitDigest: string;
      expectedReceiptDigest: string;
    }>;
  }>;
}

export interface NormalizedLocalDeploymentAdoptedBundleCommand
  extends Omit<LocalDeploymentAdoptedBundleCommand, 'options'> {
  readonly options: Omit<
    LocalDeploymentAdoptedBundleCommand['options'],
    'service'
  > &
    Readonly<{ service: NormalizedLocalDeploymentAdoptedService }>;
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
      `${label} must be a supervisor-safe absolute path`,
    );
  }
  return value;
}

function strictDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

function validateRootAcknowledgement(value: unknown, uid: number): boolean {
  if (typeof value !== 'boolean' || (uid === 0) !== value) {
    throw new LocalDeploymentConfigurationError(
      uid === 0
        ? 'root execution requires explicit allowRootService=true'
        : 'allowRootService must be false for a non-root service identity',
    );
  }
  return value;
}

function trustedFile(
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
): NormalizedLocalDeploymentAdoptedService {
  const service = object(value, 'service');
  if (service.kind === 'systemd' || service.kind === 'openrc') {
    exact(
      service,
      ['allowRootService', 'applicationEntrypoint', 'kind', 'nodeExecutable'],
      'service',
    );
    return Object.freeze({
      kind: service.kind,
      nodeExecutable: trustedFile(
        service.nodeExecutable,
        'nodeExecutable',
        true,
        uid,
      ),
      applicationEntrypoint: trustedFile(
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
  if (service.kind !== 'compose') {
    throw new LocalDeploymentConfigurationError('service kind is invalid');
  }
  exact(service, ['allowRootService', 'kind', 'releaseSelection'], 'service');
  const allowRootService = validateRootAcknowledgement(
    service.allowRootService,
    uid,
  );
  const releaseSelection = object(service.releaseSelection, 'releaseSelection');
  exact(
    releaseSelection,
    ['expectedSelectionDigest', 'path'],
    'releaseSelection',
  );
  try {
    return Object.freeze({
      kind: 'compose' as const,
      allowRootService,
      releaseSelection: resolveLocalComposeReleaseSelection(
        {
          path: safeAbsolutePath(
            releaseSelection.path,
            'releaseSelection.path',
          ),
          expectedSelectionDigest:
            releaseSelection.expectedSelectionDigest as string,
        },
        uid,
        allowRootService,
      ),
    });
  } catch (error) {
    if (error instanceof LocalComposeReleaseSelectionError) {
      throw new LocalDeploymentConfigurationError(
        'compose release selection is invalid',
        { cause: error },
      );
    }
    throw error;
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new LocalDeploymentConfigurationError(`${label} is invalid`);
  }
  return value;
}

export function normalizeLocalDeploymentAdoptedBundleCommand(
  value: unknown,
  expectedOperation?: LocalDeploymentAdoptedBundleOperation,
): Readonly<NormalizedLocalDeploymentAdoptedBundleCommand> {
  const command = object(value, 'adopted deployment bundle command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  if (
    command.schemaVersion !== 1 ||
    (command.operation !== 'local.deployment.adopted.prepare' &&
      command.operation !== 'local.deployment.adopted.verify') ||
    (expectedOperation !== undefined && command.operation !== expectedOperation)
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
  if (
    (options.profile !== 'edge' && options.profile !== 'standalone') ||
    typeof options.instanceId !== 'string' ||
    !INSTANCE_ID_PATTERN.test(options.instanceId)
  ) {
    throw new LocalDeploymentConfigurationError(
      'deployment identity is invalid',
    );
  }
  const deploymentRoot = safeAbsolutePath(
    options.deploymentRoot,
    'deploymentRoot',
  );
  const busyTimeoutMs = options.busyTimeoutMs;
  if (
    busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(busyTimeoutMs) ||
      (busyTimeoutMs as number) < 100 ||
      (busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalDeploymentConfigurationError('busyTimeoutMs is invalid');
  }
  const normalizedBusyTimeoutMs =
    busyTimeoutMs === undefined ? undefined : (busyTimeoutMs as number);
  const request = object(command.request, 'request');
  exact(
    request,
    [
      'bundleId',
      'cutover',
      'cutoverId',
      'legacyDataApplication',
      'preparedAtMs',
      'storage',
    ],
    'request',
  );
  if (
    typeof request.bundleId !== 'string' ||
    !UUID_V4_PATTERN.test(request.bundleId) ||
    !Number.isSafeInteger(request.preparedAtMs) ||
    (request.preparedAtMs as number) < 0 ||
    typeof request.cutoverId !== 'string' ||
    !INSTANCE_ID_PATTERN.test(request.cutoverId)
  ) {
    throw new LocalDeploymentConfigurationError('request identity is invalid');
  }
  const storage = object(request.storage, 'storage');
  exact(
    storage,
    [
      'activationPath',
      'expectedActivationDigest',
      'manifestPath',
      'recoveryPath',
      'sourcePath',
      'targetPath',
    ],
    'storage',
  );
  const cutover = object(request.cutover, 'cutover');
  exact(cutover, ['commitmentPath', 'expectedCommitmentDigest'], 'cutover');
  const dataApplication = object(
    request.legacyDataApplication,
    'legacyDataApplication',
  );
  exact(
    dataApplication,
    ['commitPath', 'expectedCommitDigest', 'expectedReceiptDigest'],
    'legacyDataApplication',
  );
  const sourcePath = safeAbsolutePath(storage.sourcePath, 'sourcePath');
  const authorityPaths = {
    targetPath: safeAbsolutePath(storage.targetPath, 'targetPath'),
    recoveryPath: safeAbsolutePath(storage.recoveryPath, 'recoveryPath'),
    manifestPath: safeAbsolutePath(storage.manifestPath, 'manifestPath'),
    activationPath: safeAbsolutePath(storage.activationPath, 'activationPath'),
    commitmentPath: safeAbsolutePath(cutover.commitmentPath, 'commitmentPath'),
    commitPath: safeAbsolutePath(dataApplication.commitPath, 'commitPath'),
  };
  if (
    strictDescendant(deploymentRoot, sourcePath) ||
    Object.values(authorityPaths).some(
      (candidate) => !strictDescendant(deploymentRoot, candidate),
    ) ||
    new Set([sourcePath, ...Object.values(authorityPaths)]).size !== 7 ||
    authorityPaths.commitmentPath !==
      path.join(
        deploymentRoot,
        'service',
        'cutovers',
        request.cutoverId,
        '0002-legacy-stopped.json',
      )
  ) {
    throw new LocalDeploymentConfigurationError(
      'adopted authority path boundary is invalid',
    );
  }
  const identity = currentIdentity();
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    options: Object.freeze({
      deploymentRoot,
      profile: options.profile,
      instanceId: options.instanceId,
      ...(normalizedBusyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: normalizedBusyTimeoutMs }),
      service: normalizeService(options.service, identity.uid),
    }),
    request: Object.freeze({
      bundleId: request.bundleId,
      preparedAtMs: request.preparedAtMs as number,
      cutoverId: request.cutoverId,
      storage: Object.freeze({
        sourcePath,
        targetPath: authorityPaths.targetPath,
        recoveryPath: authorityPaths.recoveryPath,
        manifestPath: authorityPaths.manifestPath,
        activationPath: authorityPaths.activationPath,
        expectedActivationDigest: digest(
          storage.expectedActivationDigest,
          'expectedActivationDigest',
        ),
      }),
      cutover: Object.freeze({
        commitmentPath: authorityPaths.commitmentPath,
        expectedCommitmentDigest: digest(
          cutover.expectedCommitmentDigest,
          'expectedCommitmentDigest',
        ),
      }),
      legacyDataApplication: Object.freeze({
        commitPath: authorityPaths.commitPath,
        expectedCommitDigest: digest(
          dataApplication.expectedCommitDigest,
          'expectedCommitDigest',
        ),
        expectedReceiptDigest: digest(
          dataApplication.expectedReceiptDigest,
          'expectedReceiptDigest',
        ),
      }),
    }),
  });
}
