import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import {
  currentIdentity,
  LocalDeploymentConfigurationError,
} from '../foundation/contract';
import {
  runLocalDeploymentDockerCommand,
  validateLocalDeploymentDockerSocket,
  type LocalDeploymentDockerRunner,
} from '../foundation/docker';
import {
  ensurePrivateDirectory,
  preflightPublishedFile,
  publishExactFile,
  validatePrivateDirectory,
} from '../foundation/files';
import {
  normalizeLocalDeploymentLegacyStopCommand,
  type LocalDeploymentLegacyStopCommand,
  type LocalDeploymentLegacyStopResult,
} from './contract';
import {
  advanceLocalCutoverInstanceHead,
  claimLocalCutoverInstance,
} from './instanceLineage';

const INTENT_SCHEMA = 'qinglong3-local-cutover-journal-record';
const COMMITMENT_KIND = 'qinglong3-local-legacy-silence-commitment';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CUTOVERS = 64;

export interface LocalDeploymentLegacyStopDependencies {
  readonly runDocker?: LocalDeploymentDockerRunner;
  readonly validateSocket?: (socketPath: string, uid: number) => void;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function digest(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function textDigest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
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

function verifyActivation(
  command: Readonly<LocalDeploymentLegacyStopCommand>,
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
  const expectedKeys = [
    'activationDigest',
    'adoptionManifestDigest',
    'createdAtMs',
    'kind',
    'planDigest',
    'profile',
    'recoverySha256',
    'schemaVersion',
    'sourcePathDigest',
    'state',
    'targetDevice',
    'targetInode',
    'targetPathDigest',
    'targetSha256',
  ];
  exact(activation, expectedKeys, 'activation');
  if (
    activation.schemaVersion !== 1 ||
    activation.kind !== 'qinglong3-local-sqlite-activation' ||
    activation.state !== 'prepared' ||
    activation.profile !== command.request.profile ||
    activation.sourcePathDigest !==
      textDigest(command.request.legacySourcePath) ||
    activation.activationDigest !== command.request.expectedActivationDigest
  ) {
    configurationError('activation does not match the cutover request');
  }
  const { activationDigest, ...payload } = activation;
  if (
    typeof activationDigest !== 'string' ||
    !DIGEST_PATTERN.test(activationDigest) ||
    digest(payload) !== activationDigest
  ) {
    configurationError('activation digest does not match');
  }
}

function cutoverDirectory(
  command: Readonly<LocalDeploymentLegacyStopCommand>,
  uid: number,
): string {
  const serviceRoot = path.join(command.options.deploymentRoot, 'service');
  validatePrivateDirectory(
    command.options.deploymentRoot,
    uid,
    'deploymentRoot',
  );
  validatePrivateDirectory(serviceRoot, uid, 'serviceDescriptorRoot');
  const catalog = path.join(serviceRoot, 'cutovers');
  ensurePrivateDirectory(catalog, uid, 'cutoverRoot');
  const entries = fs.readdirSync(catalog, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      configurationError('cutover catalog contains drift');
    }
  }
  const target = path.join(catalog, command.request.cutoverId);
  if (entries.length >= MAX_CUTOVERS && !fs.existsSync(target)) {
    configurationError('cutover retention limit is reached');
  }
  ensurePrivateDirectory(target, uid, 'cutoverJournal');
  return target;
}

function endpointDigest(
  command: Readonly<LocalDeploymentLegacyStopCommand>,
): string {
  return digest({
    executable: command.options.dockerExecutable,
    socketPath: command.options.dockerSocketPath,
  });
}

function intentRecord(command: Readonly<LocalDeploymentLegacyStopCommand>) {
  const payload = Object.freeze({
    schema: INTENT_SCHEMA,
    schemaVersion: 1 as const,
    sequence: 1 as const,
    state: 'legacy_stop_requested' as const,
    cutoverId: command.request.cutoverId,
    profile: command.request.profile,
    instanceId: command.request.instanceId,
    activationDigest: command.request.expectedActivationDigest,
    requestedAtMs: command.request.requestedAtMs,
    controller: Object.freeze({
      kind: 'docker' as const,
      endpointDigest: endpointDigest(command),
      legacyContainerId: command.request.expectedLegacyContainerId,
      requestedSourceBindingDigest: digest({
        legacySourcePath: command.request.legacySourcePath,
        legacyDatabasePath: command.request.expectedLegacyDatabasePath,
      }),
    }),
  });
  return Object.freeze({ ...payload, recordDigest: digest(payload) });
}

function parseStoppedContainer(
  output: string,
  command: Readonly<LocalDeploymentLegacyStopCommand>,
): Readonly<{ identityDigest: string; sourceBindingDigest: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    configurationError('legacy container inspection is invalid', error);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    configurationError('legacy container inspection count is invalid');
  }
  const container = object(parsed[0], 'legacy container');
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
    container.Created.length < 1 ||
    container.Created.length > 128 ||
    typeof container.Name !== 'string' ||
    container.Name.length < 2 ||
    container.Name.length > 256 ||
    typeof config.Image !== 'string' ||
    config.Image.length < 1 ||
    config.Image.length > 512
  ) {
    configurationError(
      'legacy container is not durably stopped with restart disabled',
    );
  }
  if (!Array.isArray(container.Mounts)) {
    configurationError('legacy container mount evidence is unavailable');
  }
  const matchingMounts = container.Mounts.flatMap((value) => {
    const mount = object(value, 'legacy container mount');
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
      return [];
    }
    const relative = path.relative(
      mount.Source,
      command.request.legacySourcePath,
    );
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      path.join(mount.Destination, relative) !==
        command.request.expectedLegacyDatabasePath
    ) {
      return [];
    }
    return [
      Object.freeze({
        source: mount.Source,
        destination: mount.Destination,
        readWrite: mount.RW,
      }),
    ];
  });
  if (matchingMounts.length !== 1) {
    configurationError(
      'legacy container does not have one exact activation source binding',
    );
  }
  const matchingMount = matchingMounts[0]!;
  return Object.freeze({
    identityDigest: digest({
      containerId: container.Id,
      created: container.Created,
      image: config.Image,
      name: container.Name,
    }),
    sourceBindingDigest: digest({
      sourcePathDigest: textDigest(command.request.legacySourcePath),
      databasePathDigest: textDigest(
        command.request.expectedLegacyDatabasePath,
      ),
      mountSourceDigest: textDigest(matchingMount.source),
      mountDestinationDigest: textDigest(matchingMount.destination),
      readWrite: matchingMount.readWrite,
    }),
  });
}

function commitmentRecord(
  command: Readonly<LocalDeploymentLegacyStopCommand>,
  previousRecordDigest: string,
  legacyContainerIdentityDigest: string,
  legacySourceBindingDigest: string,
) {
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: COMMITMENT_KIND,
    state: 'legacy_stopped' as const,
    cutoverId: command.request.cutoverId,
    profile: command.request.profile,
    instanceId: command.request.instanceId,
    activationDigest: command.request.expectedActivationDigest,
    previousRecordDigest,
    requestedAtMs: command.request.requestedAtMs,
    observedAtMs: command.request.requestedAtMs,
    controller: Object.freeze({
      kind: 'docker' as const,
      endpointDigest: endpointDigest(command),
      legacyContainerId: command.request.expectedLegacyContainerId,
      legacyContainerIdentityDigest,
      legacySourceBindingDigest,
    }),
  });
  return Object.freeze({ ...payload, commitmentDigest: digest(payload) });
}

function verifyExistingCommitment(
  value: unknown,
  command: Readonly<LocalDeploymentLegacyStopCommand>,
  previousRecordDigest: string,
): Readonly<{ commitmentDigest: string }> {
  const commitment = object(value, 'legacy silence commitment');
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
    commitment.kind !== COMMITMENT_KIND ||
    commitment.state !== 'legacy_stopped' ||
    commitment.cutoverId !== command.request.cutoverId ||
    commitment.profile !== command.request.profile ||
    commitment.instanceId !== command.request.instanceId ||
    commitment.activationDigest !== command.request.expectedActivationDigest ||
    commitment.previousRecordDigest !== previousRecordDigest ||
    commitment.requestedAtMs !== command.request.requestedAtMs ||
    commitment.observedAtMs !== command.request.requestedAtMs ||
    controller.kind !== 'docker' ||
    controller.endpointDigest !== endpointDigest(command) ||
    controller.legacyContainerId !==
      command.request.expectedLegacyContainerId ||
    typeof controller.legacyContainerIdentityDigest !== 'string' ||
    !DIGEST_PATTERN.test(controller.legacyContainerIdentityDigest) ||
    typeof controller.legacySourceBindingDigest !== 'string' ||
    !DIGEST_PATTERN.test(controller.legacySourceBindingDigest) ||
    typeof commitmentDigest !== 'string' ||
    !DIGEST_PATTERN.test(commitmentDigest) ||
    digest(payload) !== commitmentDigest
  ) {
    configurationError('legacy silence commitment drifted');
  }
  return Object.freeze({ commitmentDigest });
}

function docker(
  command: Readonly<LocalDeploymentLegacyStopCommand>,
  runDocker: LocalDeploymentDockerRunner,
  args: readonly string[],
  timeoutMs: number,
): string {
  return runDocker({
    executable: command.options.dockerExecutable,
    socketPath: command.options.dockerSocketPath,
    args,
    timeoutMs,
  });
}

export function stopLegacyDockerForLocalDeployment(
  input: unknown,
  dependencies: LocalDeploymentLegacyStopDependencies = {},
): Readonly<LocalDeploymentLegacyStopResult> {
  const command = normalizeLocalDeploymentLegacyStopCommand(input);
  const identity = currentIdentity();
  verifyActivation(command);
  const intent = intentRecord(command);
  claimLocalCutoverInstance(command, identity.uid, intent.recordDigest);
  const journal = cutoverDirectory(command, identity.uid);
  const intentPath = path.join(journal, '0001-legacy-stop-requested.json');
  const commitmentPath = path.join(journal, '0002-legacy-stopped.json');
  const intentContents = `${JSON.stringify(intent, null, 2)}\n`;
  preflightPublishedFile(
    intentPath,
    intentContents,
    0o600,
    identity.uid,
    'legacy stop intent',
  );
  publishExactFile(
    intentPath,
    intentContents,
    0o600,
    identity.uid,
    'legacy stop intent',
  );
  if (fs.existsSync(commitmentPath)) {
    const existing = verifyExistingCommitment(
      readPrivateLocalCommandFile(commitmentPath),
      command,
      intent.recordDigest,
    );
    advanceLocalCutoverInstanceHead(
      command,
      identity.uid,
      'legacy_stopped',
      0,
      existing.commitmentDigest,
    );
    return Object.freeze({
      schemaVersion: 1 as const,
      operation: command.operation,
      status: 'existing' as const,
      state: 'legacy_stopped' as const,
      cutoverId: command.request.cutoverId,
      commitmentDigest: existing.commitmentDigest,
    });
  }
  const validateSocket =
    dependencies.validateSocket ?? validateLocalDeploymentDockerSocket;
  validateSocket(command.options.dockerSocketPath, identity.uid);
  const runDocker = dependencies.runDocker ?? runLocalDeploymentDockerCommand;
  docker(
    command,
    runDocker,
    [
      'container',
      'update',
      '--restart',
      'no',
      command.request.expectedLegacyContainerId,
    ],
    30_000,
  );
  docker(
    command,
    runDocker,
    [
      'container',
      'stop',
      '--time',
      '30',
      command.request.expectedLegacyContainerId,
    ],
    45_000,
  );
  const stopped = parseStoppedContainer(
    docker(
      command,
      runDocker,
      ['container', 'inspect', command.request.expectedLegacyContainerId],
      30_000,
    ),
    command,
  );
  const commitment = commitmentRecord(
    command,
    intent.recordDigest,
    stopped.identityDigest,
    stopped.sourceBindingDigest,
  );
  const commitmentContents = `${JSON.stringify(commitment, null, 2)}\n`;
  preflightPublishedFile(
    commitmentPath,
    commitmentContents,
    0o600,
    identity.uid,
    'legacy silence commitment',
  );
  publishExactFile(
    commitmentPath,
    commitmentContents,
    0o600,
    identity.uid,
    'legacy silence commitment',
  );
  advanceLocalCutoverInstanceHead(
    command,
    identity.uid,
    'legacy_stopped',
    0,
    commitment.commitmentDigest,
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status: 'prepared' as const,
    state: 'legacy_stopped' as const,
    cutoverId: command.request.cutoverId,
    commitmentDigest: commitment.commitmentDigest,
  });
}

export function stopLegacyDockerForLocalDeploymentCommandFile(
  filePath: string,
): Readonly<LocalDeploymentLegacyStopResult> {
  return stopLegacyDockerForLocalDeployment(
    readPrivateLocalCommandFile(filePath),
  );
}
