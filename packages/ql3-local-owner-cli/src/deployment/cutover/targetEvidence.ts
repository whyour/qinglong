import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { LocalDeploymentConfigurationError } from '../foundation/contract';
import type { LocalDeploymentTargetRunCommand } from './target-run/targetRunContract';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BOOT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const START_TICKS_PATTERN = /^[1-9][0-9]{0,19}$/;
const NODE_VERSION_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface LegacySilenceEvidence {
  readonly commitmentDigest: string;
  readonly legacyContainerIdentityDigest: string;
  readonly legacySourceBindingDigest: string;
}

export interface TargetApplicationBinding {
  readonly schema:
    | 'qinglong/local-application-process@v3'
    | 'qinglong/local-application-process@v4';
  readonly configDigest: string;
  readonly targetActivationPath: string;
  readonly targetLegacySourcePath: string;
  readonly targetDatabasePath: string;
  readonly targetRecoveryPath: string;
  readonly targetManifestPath: string;
  readonly legacyDataApplicationCommitDigest: string | null;
  readonly legacyDataApplicationReceiptDigest: string | null;
  readonly localApi?: Readonly<{
    configDigest: string;
    targetConfigPath: string;
    targetDeploymentRoot: string;
    targetOwnerPepperKeyringDirectory: string;
    listener: Readonly<{
      host: '127.0.0.1' | '::1';
      port: number;
    }>;
  }>;
}

export interface TargetContainerEvidence {
  readonly identityDigest: string;
  readonly applicationBindingDigest: string;
}

export interface TargetStartupReceiptEvidence {
  readonly digest: string;
  readonly bootId: string;
  readonly activeBootAgeMs: number;
  readonly processId: number;
  readonly processStartTicks: string;
  readonly nodeExecutable: string;
}

export interface TargetStartupReceiptCommandIdentity {
  readonly request: Readonly<{
    applicationConfigPath: string;
    instanceId: string;
    profile: 'edge' | 'standalone';
  }>;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

export function cutoverDigest(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function textDigest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    path.parse(value).root !== value
  );
}

function readTargetLocalApiBinding(
  command: Readonly<LocalDeploymentTargetRunCommand>,
): TargetApplicationBinding['localApi'] {
  const targetApi = command.request.targetApi;
  if (targetApi === undefined) return undefined;
  const config = object(
    readPrivateLocalCommandFile(targetApi.configPath),
    'target Local API configuration',
  );
  exact(
    config,
    [
      'applicationConfigFilePath',
      'deploymentRoot',
      'listener',
      'ownerPepperKeyringDirectory',
      'schema',
    ],
    'target Local API configuration',
  );
  const listener = object(config.listener, 'target Local API listener');
  exact(listener, ['host', 'port'], 'target Local API listener');
  const ownerPepperRelative =
    normalizedAbsolutePath(config.deploymentRoot) &&
    normalizedAbsolutePath(config.ownerPepperKeyringDirectory)
      ? path.relative(config.deploymentRoot, config.ownerPepperKeyringDirectory)
      : null;
  if (
    config.schema !== 'qinglong/local-api-process@v1' ||
    !normalizedAbsolutePath(config.deploymentRoot) ||
    config.applicationConfigFilePath !==
      command.request.expectedTargetApplicationConfigPath ||
    !normalizedAbsolutePath(config.ownerPepperKeyringDirectory) ||
    ownerPepperRelative === null ||
    ownerPepperRelative.length === 0 ||
    ownerPepperRelative.startsWith('..') ||
    path.isAbsolute(ownerPepperRelative) ||
    (listener.host !== '127.0.0.1' && listener.host !== '::1') ||
    !Number.isSafeInteger(listener.port) ||
    (listener.port as number) < 1_024 ||
    (listener.port as number) > 65_535
  ) {
    configurationError('target Local API configuration binding is invalid');
  }
  return Object.freeze({
    configDigest: cutoverDigest(config),
    targetConfigPath: targetApi.expectedTargetConfigPath,
    targetDeploymentRoot: config.deploymentRoot,
    targetOwnerPepperKeyringDirectory: config.ownerPepperKeyringDirectory,
    listener: Object.freeze({
      host: listener.host as '127.0.0.1' | '::1',
      port: listener.port as number,
    }),
  });
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

function endpointDigest(
  command: Readonly<LocalDeploymentTargetRunCommand>,
): string {
  return cutoverDigest({
    executable: command.options.dockerExecutable,
    socketPath: command.options.dockerSocketPath,
  });
}

export function legacyCommitmentPath(
  command: Readonly<LocalDeploymentTargetRunCommand>,
): string {
  return path.join(
    command.options.deploymentRoot,
    'service',
    'cutovers',
    command.request.cutoverId,
    '0002-legacy-stopped.json',
  );
}

export function verifyTargetRunActivation(
  command: Readonly<LocalDeploymentTargetRunCommand>,
): void {
  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.lstatSync(command.request.legacySourcePath);
  } catch (error) {
    configurationError('legacy source is unavailable', error);
  }
  if (
    !sourceStat.isFile() ||
    sourceStat.isSymbolicLink() ||
    fs.realpathSync(command.request.legacySourcePath) !==
      command.request.legacySourcePath
  ) {
    configurationError('legacy source must be a canonical regular file');
  }
  const activation = object(
    readPrivateLocalCommandFile(command.request.activationPath),
    'activation',
  );
  exact(
    activation,
    [
      'activationDigest',
      'adoptionManifestDigest',
      'createdAtMs',
      'kind',
      'planDigest',
      'profile',
      'recoverySha256',
      'schemaVersion',
      'sourcePathDigest',
      'sourceSha256',
      'state',
      'targetDevice',
      'targetInode',
      'targetPathDigest',
      'targetSha256',
    ],
    'activation',
  );
  const { activationDigest, ...payload } = activation;
  if (
    activation.schemaVersion !== 1 ||
    activation.kind !== 'qinglong3-local-sqlite-activation' ||
    activation.state !== 'prepared' ||
    activation.profile !== command.request.profile ||
    activation.sourcePathDigest !==
      textDigest(command.request.legacySourcePath) ||
    activationDigest !== command.request.expectedActivationDigest ||
    typeof activationDigest !== 'string' ||
    !DIGEST_PATTERN.test(activationDigest) ||
    typeof activation.sourceSha256 !== 'string' ||
    !DIGEST_PATTERN.test(activation.sourceSha256) ||
    cutoverDigest(payload) !== activationDigest
  ) {
    configurationError('activation does not match the target run request');
  }
}

export function readLegacySilenceEvidence(
  command: Readonly<LocalDeploymentTargetRunCommand>,
): Readonly<LegacySilenceEvidence> {
  const commitment = object(
    readPrivateLocalCommandFile(legacyCommitmentPath(command)),
    'legacy silence commitment',
  );
  exact(
    commitment,
    [
      'activationDigest',
      'commitmentDigest',
      'controller',
      'cutoverId',
      'instanceId',
      'kind',
      'observedAtMs',
      'previousRecordDigest',
      'profile',
      'requestedAtMs',
      'schemaVersion',
      'state',
    ],
    'legacy silence commitment',
  );
  const controller = object(commitment.controller, 'commitment controller');
  exact(
    controller,
    [
      'endpointDigest',
      'kind',
      'legacyContainerId',
      'legacyContainerIdentityDigest',
      'legacySourceBindingDigest',
    ],
    'commitment controller',
  );
  const { commitmentDigest, ...payload } = commitment;
  if (
    commitment.schemaVersion !== 1 ||
    commitment.kind !== 'qinglong3-local-legacy-silence-commitment' ||
    commitment.state !== 'legacy_stopped' ||
    commitment.cutoverId !== command.request.cutoverId ||
    commitment.profile !== command.request.profile ||
    commitment.instanceId !== command.request.instanceId ||
    commitment.activationDigest !== command.request.expectedActivationDigest ||
    commitmentDigest !== command.request.expectedLegacyCommitmentDigest ||
    typeof commitmentDigest !== 'string' ||
    !DIGEST_PATTERN.test(commitmentDigest) ||
    controller.kind !== 'docker' ||
    controller.endpointDigest !== endpointDigest(command) ||
    controller.legacyContainerId !==
      command.request.expectedLegacyContainerId ||
    typeof controller.legacyContainerIdentityDigest !== 'string' ||
    !DIGEST_PATTERN.test(controller.legacyContainerIdentityDigest) ||
    typeof controller.legacySourceBindingDigest !== 'string' ||
    !DIGEST_PATTERN.test(controller.legacySourceBindingDigest) ||
    cutoverDigest(payload) !== commitmentDigest
  ) {
    configurationError('legacy silence commitment does not match target run');
  }
  return Object.freeze({
    commitmentDigest,
    legacyContainerIdentityDigest:
      controller.legacyContainerIdentityDigest as string,
    legacySourceBindingDigest: controller.legacySourceBindingDigest as string,
  });
}

export function readTargetApplicationBinding(
  command: Readonly<LocalDeploymentTargetRunCommand>,
): Readonly<TargetApplicationBinding> {
  const config = object(
    readPrivateLocalCommandFile(command.request.applicationConfigPath),
    'target application configuration',
  );
  const storage = object(config.storage, 'target storage configuration');
  const cutover = object(config.cutover, 'target cutover configuration');
  const isV4 = config.schema === 'qinglong/local-application-process@v4';
  const legacyDataApplication = isV4
    ? object(
        config.legacyDataApplication,
        'target legacy data application configuration',
      )
    : undefined;
  const localApi = readTargetLocalApiBinding(command);
  if (legacyDataApplication !== undefined) {
    exact(
      legacyDataApplication,
      ['commitPath', 'expectedCommitDigest', 'expectedReceiptDigest'],
      'target legacy data application configuration',
    );
  }
  if (
    (config.schema !== 'qinglong/local-application-process@v3' && !isV4) ||
    config.profile !== command.request.profile ||
    config.instanceId !== command.request.instanceId ||
    storage.mode !== 'adopted' ||
    storage.expectedActivationDigest !==
      command.request.expectedActivationDigest ||
    typeof storage.sourcePath !== 'string' ||
    !path.isAbsolute(storage.sourcePath) ||
    path.normalize(storage.sourcePath) !== storage.sourcePath ||
    typeof storage.activationPath !== 'string' ||
    !path.isAbsolute(storage.activationPath) ||
    path.normalize(storage.activationPath) !== storage.activationPath ||
    typeof storage.targetPath !== 'string' ||
    !path.isAbsolute(storage.targetPath) ||
    path.normalize(storage.targetPath) !== storage.targetPath ||
    typeof storage.recoveryPath !== 'string' ||
    !path.isAbsolute(storage.recoveryPath) ||
    path.normalize(storage.recoveryPath) !== storage.recoveryPath ||
    typeof storage.manifestPath !== 'string' ||
    !path.isAbsolute(storage.manifestPath) ||
    path.normalize(storage.manifestPath) !== storage.manifestPath ||
    cutover.cutoverId !== command.request.cutoverId ||
    cutover.commitmentPath !== command.request.expectedTargetCommitmentPath ||
    cutover.expectedCommitmentDigest !==
      command.request.expectedLegacyCommitmentDigest ||
    (legacyDataApplication !== undefined &&
      (typeof legacyDataApplication.commitPath !== 'string' ||
        !path.isAbsolute(legacyDataApplication.commitPath) ||
        path.normalize(legacyDataApplication.commitPath) !==
          legacyDataApplication.commitPath ||
        typeof legacyDataApplication.expectedCommitDigest !== 'string' ||
        !DIGEST_PATTERN.test(legacyDataApplication.expectedCommitDigest) ||
        typeof legacyDataApplication.expectedReceiptDigest !== 'string' ||
        !DIGEST_PATTERN.test(legacyDataApplication.expectedReceiptDigest)))
  ) {
    configurationError('target application configuration binding is invalid');
  }
  return Object.freeze({
    schema: config.schema as TargetApplicationBinding['schema'],
    configDigest: cutoverDigest(config),
    targetActivationPath: storage.activationPath,
    targetLegacySourcePath: storage.sourcePath,
    targetDatabasePath: storage.targetPath,
    targetRecoveryPath: storage.recoveryPath,
    targetManifestPath: storage.manifestPath,
    legacyDataApplicationCommitDigest:
      legacyDataApplication === undefined
        ? null
        : (legacyDataApplication.expectedCommitDigest as string),
    legacyDataApplicationReceiptDigest:
      legacyDataApplication === undefined
        ? null
        : (legacyDataApplication.expectedReceiptDigest as string),
    ...(localApi === undefined ? {} : { localApi }),
  });
}

interface DockerMount {
  readonly source: string;
  readonly destination: string;
  readonly readWrite: boolean;
}

function validMount(value: unknown): DockerMount | undefined {
  const mount = object(value, 'target container mount');
  if (
    mount.Type !== 'bind' ||
    typeof mount.Source !== 'string' ||
    typeof mount.Destination !== 'string' ||
    typeof mount.RW !== 'boolean' ||
    !path.isAbsolute(mount.Source) ||
    !path.isAbsolute(mount.Destination) ||
    path.normalize(mount.Source) !== mount.Source ||
    path.normalize(mount.Destination) !== mount.Destination
  ) {
    return undefined;
  }
  return Object.freeze({
    source: mount.Source,
    destination: mount.Destination,
    readWrite: mount.RW,
  });
}

function mappedMount(
  mounts: readonly DockerMount[],
  hostPath: string,
  targetPath: string,
  label: string,
  expectedReadWrite = true,
): DockerMount {
  const matches = mounts.filter((mount) => {
    const relative = path.relative(mount.source, hostPath);
    return (
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      path.join(mount.destination, relative) === targetPath
    );
  });
  if (matches.length !== 1 || matches[0]?.readWrite !== expectedReadWrite) {
    configurationError(
      `${label} must have one ${
        expectedReadWrite ? 'read-write' : 'read-only'
      } bind mapping`,
    );
  }
  return matches[0]!;
}

function parsedContainer(
  output: string,
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    configurationError(`${label} inspection is invalid`, error);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    configurationError(`${label} inspection count is invalid`);
  }
  return object(parsed[0], label);
}

export function parseStoppedLegacyEvidence(
  output: string,
  command: Readonly<LocalDeploymentTargetRunCommand>,
): Readonly<{
  identityDigest: string;
  sourceBindingDigest: string;
}> {
  const container = parsedContainer(output, 'legacy container');
  const state = object(container.State, 'legacy container state');
  const hostConfig = object(
    container.HostConfig,
    'legacy container host config',
  );
  const restartPolicy = object(
    hostConfig.RestartPolicy,
    'legacy container restart policy',
  );
  const config = object(container.Config, 'legacy container config');
  if (
    container.Id !== command.request.expectedLegacyContainerId ||
    state.Running !== false ||
    state.Restarting !== false ||
    state.Paused !== false ||
    state.Pid !== 0 ||
    (state.Status !== 'exited' && state.Status !== 'dead') ||
    (restartPolicy.Name !== '' && restartPolicy.Name !== 'no') ||
    typeof container.Created !== 'string' ||
    typeof container.Name !== 'string' ||
    typeof config.Image !== 'string' ||
    !Array.isArray(container.Mounts)
  ) {
    configurationError('legacy container silence cannot be reverified');
  }
  const mounts = container.Mounts.flatMap((value) => {
    const candidate = validMount(value);
    return candidate === undefined ? [] : [candidate];
  });
  const sourceMount = mappedMount(
    mounts,
    command.request.legacySourcePath,
    command.request.expectedLegacyDatabasePath,
    'legacy source',
  );
  return Object.freeze({
    identityDigest: cutoverDigest({
      containerId: container.Id,
      created: container.Created,
      image: config.Image,
      name: container.Name,
    }),
    sourceBindingDigest: cutoverDigest({
      sourcePathDigest: textDigest(command.request.legacySourcePath),
      databasePathDigest: textDigest(
        command.request.expectedLegacyDatabasePath,
      ),
      mountSourceDigest: textDigest(sourceMount.source),
      mountDestinationDigest: textDigest(sourceMount.destination),
      readWrite: sourceMount.readWrite,
    }),
  });
}

export function parseActiveLegacyEvidence(
  output: string,
  command: Readonly<LocalDeploymentTargetRunCommand>,
): Readonly<{
  identityDigest: string;
  sourceBindingDigest: string;
}> {
  const container = parsedContainer(output, 'legacy container');
  const state = object(container.State, 'legacy container state');
  const hostConfig = object(
    container.HostConfig,
    'legacy container host config',
  );
  const restartPolicy = object(
    hostConfig.RestartPolicy,
    'legacy container restart policy',
  );
  const config = object(container.Config, 'legacy container config');
  if (
    container.Id !== command.request.expectedLegacyContainerId ||
    state.Running !== true ||
    state.Restarting !== false ||
    state.Paused !== false ||
    !Number.isSafeInteger(state.Pid) ||
    (state.Pid as number) < 1 ||
    state.Status !== 'running' ||
    (restartPolicy.Name !== '' && restartPolicy.Name !== 'no') ||
    typeof container.Created !== 'string' ||
    typeof container.Name !== 'string' ||
    typeof config.Image !== 'string' ||
    !Array.isArray(container.Mounts)
  ) {
    configurationError('legacy container running state cannot be proved');
  }
  const mounts = container.Mounts.flatMap((value) => {
    const candidate = validMount(value);
    return candidate === undefined ? [] : [candidate];
  });
  const sourceMount = mappedMount(
    mounts,
    command.request.legacySourcePath,
    command.request.expectedLegacyDatabasePath,
    'legacy source',
  );
  return Object.freeze({
    identityDigest: cutoverDigest({
      containerId: container.Id,
      created: container.Created,
      image: config.Image,
      name: container.Name,
    }),
    sourceBindingDigest: cutoverDigest({
      sourcePathDigest: textDigest(command.request.legacySourcePath),
      databasePathDigest: textDigest(
        command.request.expectedLegacyDatabasePath,
      ),
      mountSourceDigest: textDigest(sourceMount.source),
      mountDestinationDigest: textDigest(sourceMount.destination),
      readWrite: sourceMount.readWrite,
    }),
  });
}

export function parseTargetContainerEvidence(
  output: string,
  command: Readonly<LocalDeploymentTargetRunCommand>,
  application: Readonly<TargetApplicationBinding>,
  expectedState: 'stopped' | 'active',
): Readonly<TargetContainerEvidence> {
  const container = parsedContainer(output, 'target container');
  const state = object(container.State, 'target container state');
  const hostConfig = object(
    container.HostConfig,
    'target container host config',
  );
  const restartPolicy = object(
    hostConfig.RestartPolicy,
    'target container restart policy',
  );
  const config = object(container.Config, 'target container config');
  const expectedEntryConfigPath =
    application.localApi?.targetConfigPath ??
    command.request.expectedTargetApplicationConfigPath;
  const stopped =
    state.Running === false &&
    state.Restarting === false &&
    state.Paused === false &&
    state.Pid === 0 &&
    (state.Status === 'created' ||
      state.Status === 'exited' ||
      state.Status === 'dead');
  const active =
    state.Running === true &&
    state.Restarting === false &&
    state.Paused === false &&
    Number.isSafeInteger(state.Pid) &&
    (state.Pid as number) > 0 &&
    state.Status === 'running';
  if (
    container.Id !== command.request.expectedTargetContainerId ||
    (expectedState === 'stopped' ? !stopped : !active) ||
    (restartPolicy.Name !== '' && restartPolicy.Name !== 'no') ||
    hostConfig.ReadonlyRootfs !== true ||
    hostConfig.Privileged === true ||
    !Array.isArray(hostConfig.SecurityOpt) ||
    !hostConfig.SecurityOpt.includes('no-new-privileges') ||
    config.Image !== command.request.targetImage.reference ||
    container.Image !== command.request.targetImage.imageId ||
    JSON.stringify(config.Cmd) !==
      JSON.stringify([
        '--cutover-probe',
        '--config',
        expectedEntryConfigPath,
      ]) ||
    typeof container.Created !== 'string' ||
    typeof container.Name !== 'string' ||
    !Array.isArray(container.Mounts)
  ) {
    configurationError(`target container ${expectedState} evidence is invalid`);
  }
  const mounts = container.Mounts.flatMap((value) => {
    const candidate = validMount(value);
    return candidate === undefined ? [] : [candidate];
  });
  const commitmentMount = mappedMount(
    mounts,
    legacyCommitmentPath(command),
    command.request.expectedTargetCommitmentPath,
    'target commitment',
  );
  const configMount = mappedMount(
    mounts,
    command.request.applicationConfigPath,
    command.request.expectedTargetApplicationConfigPath,
    'target application configuration',
  );
  const localApiBinding =
    application.localApi === undefined ||
    command.request.targetApi === undefined
      ? undefined
      : Object.freeze({
          configDigest: application.localApi.configDigest,
          configMount: mappedMount(
            mounts,
            command.request.targetApi.configPath,
            command.request.targetApi.expectedTargetConfigPath,
            'target Local API configuration',
          ),
          deploymentMount: mappedMount(
            mounts,
            command.options.deploymentRoot,
            application.localApi.targetDeploymentRoot,
            'target Local API deployment root',
          ),
          listener: application.localApi.listener,
          targetOwnerPepperKeyringDirectory:
            application.localApi.targetOwnerPepperKeyringDirectory,
        });
  const activationMount = mappedMount(
    mounts,
    command.request.activationPath,
    application.targetActivationPath,
    'target activation',
  );
  const sourceMount = mappedMount(
    mounts,
    command.request.legacySourcePath,
    application.targetLegacySourcePath,
    'target legacy source',
    false,
  );
  const databaseMount = mappedMount(
    mounts,
    command.request.targetDatabasePath,
    application.targetDatabasePath,
    'target database',
  );
  const recoveryMount = mappedMount(
    mounts,
    command.request.recoveryPath,
    application.targetRecoveryPath,
    'target recovery database',
  );
  const manifestMount = mappedMount(
    mounts,
    command.request.manifestPath,
    application.targetManifestPath,
    'target adoption manifest',
  );
  return Object.freeze({
    identityDigest: cutoverDigest({
      containerId: container.Id,
      created: container.Created,
      image: config.Image,
      imageAuthority: command.request.targetImage.authority,
      imageId: container.Image,
      name: container.Name,
    }),
    applicationBindingDigest: cutoverDigest({
      configDigest: application.configDigest,
      configMount,
      commitmentMount,
      activationMount,
      sourceMount,
      databaseMount,
      recoveryMount,
      manifestMount,
      ...(localApiBinding === undefined ? {} : { localApi: localApiBinding }),
    }),
  });
}

export function readTargetStartupReceipt(
  command: Readonly<TargetStartupReceiptCommandIdentity>,
): Readonly<TargetStartupReceiptEvidence> | null {
  const receiptPath = `${command.request.applicationConfigPath}.active.json`;
  if (!fs.existsSync(receiptPath)) return null;
  const receipt = object(
    readPrivateLocalCommandFile(receiptPath),
    'target startup receipt',
  );
  exact(
    receipt,
    [
      'activeBootAgeMs',
      'aiStatus',
      'bootId',
      'instanceId',
      'nodeExecutable',
      'nodeVersion',
      'processId',
      'processStartTicks',
      'profile',
      'schema',
      'schemaVersion',
      'sha256',
    ],
    'target startup receipt',
  );
  const { sha256, ...payload } = receipt;
  const receiptDigest = crypto
    .createHash('sha256')
    .update('qinglong.local-application-startup-receipt.v1\0', 'utf8')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
  if (
    receipt.schemaVersion !== 1 ||
    receipt.schema !== 'qinglong/local-application-startup-receipt@v1' ||
    receipt.instanceId !== command.request.instanceId ||
    receipt.profile !== command.request.profile ||
    (receipt.aiStatus !== 'deployment_excluded' &&
      receipt.aiStatus !== 'schema_absent' &&
      receipt.aiStatus !== 'inactive' &&
      receipt.aiStatus !== 'active') ||
    typeof receipt.bootId !== 'string' ||
    !BOOT_ID_PATTERN.test(receipt.bootId) ||
    !Number.isSafeInteger(receipt.activeBootAgeMs) ||
    (receipt.activeBootAgeMs as number) < 0 ||
    !Number.isSafeInteger(receipt.processId) ||
    (receipt.processId as number) < 1 ||
    typeof receipt.processStartTicks !== 'string' ||
    !START_TICKS_PATTERN.test(receipt.processStartTicks) ||
    typeof receipt.nodeExecutable !== 'string' ||
    !path.isAbsolute(receipt.nodeExecutable) ||
    path.normalize(receipt.nodeExecutable) !== receipt.nodeExecutable ||
    typeof receipt.nodeVersion !== 'string' ||
    !NODE_VERSION_PATTERN.test(receipt.nodeVersion) ||
    typeof sha256 !== 'string' ||
    !DIGEST_PATTERN.test(sha256) ||
    receiptDigest !== sha256
  ) {
    configurationError('target startup receipt is invalid');
  }
  return Object.freeze({
    digest: receiptDigest,
    bootId: receipt.bootId,
    activeBootAgeMs: receipt.activeBootAgeMs as number,
    processId: receipt.processId as number,
    processStartTicks: receipt.processStartTicks,
    nodeExecutable: receipt.nodeExecutable,
  });
}
