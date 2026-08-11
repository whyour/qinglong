import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import {
  currentIdentity,
  LocalDeploymentConfigurationError,
} from '../../foundation/contract';
import {
  runLocalDeploymentDockerCommand,
  validateLocalDeploymentDockerSocket,
  type LocalDeploymentDockerRunner,
} from '../../foundation/docker';
import {
  preflightPublishedFile,
  publishExactFile,
  validatePrivateDirectory,
} from '../../foundation/files';
import {
  authorizeResolvedLocalCutoverInstance,
  localCutoverInstanceDirectory,
  readLocalCutoverInstanceHead,
  type LocalCutoverInstanceHead,
  type LocalCutoverIdentity,
} from '../instanceLineage';
import {
  EMPTY_RESOLUTION_DIGEST,
  normalizeLocalDeploymentCutoverManualCommand,
  type LocalDeploymentCutoverManualCommand,
} from './manualResolutionContract';
import { cutoverDigest } from '../targetEvidence';

const PREPARATION_SCHEMA = 'qinglong3-local-cutover-manual-resolution';
const JOURNAL_SCHEMA = 'qinglong3-local-cutover-journal-record';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_JOURNAL_FILES = 64;

export type LocalDeploymentCutoverObservationState =
  | 'stopped'
  | 'running'
  | 'unknown';

export interface LocalDeploymentCutoverManualResult {
  readonly schemaVersion: 1;
  readonly operation: LocalDeploymentCutoverManualCommand['operation'];
  readonly status: 'prepared' | 'existing' | 'observed';
  readonly state:
    | 'manual_diagnosed'
    | 'resolution_prepared'
    | 'resolution_authorized';
  readonly currentCutoverId: string;
  readonly nextCutoverId: string;
  readonly legacyState?: LocalDeploymentCutoverObservationState;
  readonly targetState?: LocalDeploymentCutoverObservationState;
  readonly legacyObservationDigest?: string;
  readonly targetObservationDigest?: string;
  readonly preparationDigest?: string;
  readonly instanceHeadDigest?: string;
}

export interface LocalDeploymentCutoverManualDependencies {
  readonly runDocker?: LocalDeploymentDockerRunner;
  readonly validateSocket?: (socketPath: string, uid: number) => void;
}

interface ContainerObservation {
  readonly state: LocalDeploymentCutoverObservationState;
  readonly digest: string;
}

interface ResolutionPreparation {
  readonly schema: typeof PREPARATION_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'resolution_prepared';
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly currentCutoverId: string;
  readonly nextCutoverId: string;
  readonly currentActivationDigest: string;
  readonly nextActivationDigest: string;
  readonly expectedInstanceHeadDigest: string;
  readonly expectedManualRecordDigest: string;
  readonly expectedLegacyContainerId: string;
  readonly expectedTargetContainerId: string;
  readonly legacyObservationDigest: string;
  readonly targetObservationDigest: string;
  readonly requestedAtMs: number;
  readonly preparationDigest: string;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
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

function currentIdentityFor(
  command: Readonly<LocalDeploymentCutoverManualCommand>,
): Readonly<LocalCutoverIdentity> {
  return Object.freeze({
    options: Object.freeze({ deploymentRoot: command.options.deploymentRoot }),
    request: Object.freeze({
      cutoverId: command.request.currentCutoverId,
      profile: command.request.profile,
      instanceId: command.request.instanceId,
      expectedActivationDigest: command.request.currentActivationDigest,
      requestedAtMs: command.request.requestedAtMs,
    }),
  });
}

function nextIdentityFor(
  command: Readonly<LocalDeploymentCutoverManualCommand>,
): Readonly<LocalCutoverIdentity> {
  return Object.freeze({
    options: Object.freeze({ deploymentRoot: command.options.deploymentRoot }),
    request: Object.freeze({
      cutoverId: command.request.nextCutoverId,
      profile: command.request.profile,
      instanceId: command.request.instanceId,
      expectedActivationDigest: command.request.nextActivationDigest,
      requestedAtMs: command.request.requestedAtMs,
    }),
  });
}

function manualHead(
  command: Readonly<LocalDeploymentCutoverManualCommand>,
  uid: number,
): Readonly<LocalCutoverInstanceHead> {
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    command.request.instanceId,
    uid,
  );
  if (
    head.state !== 'manual_required' ||
    head.profile !== command.request.profile ||
    head.cutoverId !== command.request.currentCutoverId ||
    head.activationDigest !== command.request.currentActivationDigest ||
    head.headDigest !== command.request.expectedInstanceHeadDigest ||
    head.sourceRecordDigest !== command.request.expectedManualRecordDigest
  ) {
    configurationError('manual resolution does not match the instance head');
  }
  return head;
}

function verifyManualJournalRecord(
  command: Readonly<LocalDeploymentCutoverManualCommand>,
  head: Readonly<LocalCutoverInstanceHead>,
): void {
  const journal = path.join(
    command.options.deploymentRoot,
    'service',
    'cutovers',
    command.request.currentCutoverId,
  );
  validatePrivateDirectory(journal, currentIdentity().uid, 'cutoverJournal');
  const entries = fs.readdirSync(journal, { withFileTypes: true });
  if (entries.length > MAX_JOURNAL_FILES) {
    configurationError('cutover journal retention limit is exceeded');
  }
  let matched = false;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      configurationError('cutover journal contains drift');
    }
    const value = readPrivateLocalCommandFile(path.join(journal, entry.name));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).recordDigest !==
        command.request.expectedManualRecordDigest
    ) {
      continue;
    }
    const record = object(value, 'manual-required journal record');
    const { recordDigest, ...payload } = record;
    if (
      record.schema !== JOURNAL_SCHEMA ||
      record.schemaVersion !== 1 ||
      record.state !== 'manual_required' ||
      record.cutoverId !== command.request.currentCutoverId ||
      record.profile !== command.request.profile ||
      record.instanceId !== command.request.instanceId ||
      record.activationDigest !== command.request.currentActivationDigest ||
      record.generation !== head.generation ||
      typeof recordDigest !== 'string' ||
      !DIGEST_PATTERN.test(recordDigest) ||
      cutoverDigest(payload) !== recordDigest
    ) {
      configurationError('manual-required journal record drifted');
    }
    matched = true;
  }
  if (!matched)
    configurationError('manual-required journal record is unavailable');
}

function parseContainerObservation(
  output: string,
  expectedContainerId: string,
): Readonly<ContainerObservation> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    configurationError('container inspection is invalid', error);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    configurationError('container inspection count is invalid');
  }
  const container = object(parsed[0], 'container');
  const state = object(container.State, 'container state');
  const hostConfig = object(container.HostConfig, 'container host config');
  const restartPolicy = object(
    hostConfig.RestartPolicy,
    'container restart policy',
  );
  const config = object(container.Config, 'container config');
  if (
    container.Id !== expectedContainerId ||
    typeof container.Created !== 'string' ||
    container.Created.length < 1 ||
    container.Created.length > 128 ||
    typeof container.Name !== 'string' ||
    container.Name.length < 2 ||
    container.Name.length > 256 ||
    typeof config.Image !== 'string' ||
    config.Image.length < 1 ||
    config.Image.length > 512 ||
    (restartPolicy.Name !== '' && restartPolicy.Name !== 'no')
  ) {
    configurationError('container inspection identity is invalid');
  }
  const stopped =
    state.Running === false &&
    state.Restarting === false &&
    state.Paused === false &&
    state.Pid === 0 &&
    (state.Status === 'exited' || state.Status === 'dead');
  const running =
    state.Running === true &&
    state.Restarting === false &&
    state.Paused === false &&
    Number.isSafeInteger(state.Pid) &&
    (state.Pid as number) > 0 &&
    state.Status === 'running';
  if (!stopped && !running) {
    configurationError('container state is ambiguous');
  }
  const observationState = stopped ? 'stopped' : 'running';
  return Object.freeze({
    state: observationState,
    digest: cutoverDigest({
      containerId: container.Id,
      created: container.Created,
      image: config.Image,
      name: container.Name,
      state: observationState,
      restartPolicy: restartPolicy.Name,
    }),
  });
}

function inspectContainer(
  command: Readonly<LocalDeploymentCutoverManualCommand>,
  runDocker: LocalDeploymentDockerRunner,
  containerId: string,
): Readonly<ContainerObservation> {
  try {
    return parseContainerObservation(
      runDocker({
        executable: command.options.dockerExecutable,
        socketPath: command.options.dockerSocketPath,
        args: ['container', 'inspect', containerId],
        timeoutMs: 30_000,
      }),
      containerId,
    );
  } catch {
    return Object.freeze({
      state: 'unknown' as const,
      digest: cutoverDigest({ containerId, state: 'unknown' }),
    });
  }
}

function observations(
  command: Readonly<LocalDeploymentCutoverManualCommand>,
  dependencies: LocalDeploymentCutoverManualDependencies,
  uid: number,
): Readonly<{ legacy: ContainerObservation; target: ContainerObservation }> {
  const validateSocket =
    dependencies.validateSocket ?? validateLocalDeploymentDockerSocket;
  validateSocket(command.options.dockerSocketPath, uid);
  const runDocker = dependencies.runDocker ?? runLocalDeploymentDockerCommand;
  return Object.freeze({
    legacy: inspectContainer(
      command,
      runDocker,
      command.request.expectedLegacyContainerId,
    ),
    target: inspectContainer(
      command,
      runDocker,
      command.request.expectedTargetContainerId,
    ),
  });
}

function preparationPath(
  command: Readonly<LocalDeploymentCutoverManualCommand>,
): string {
  return path.join(
    command.options.deploymentRoot,
    'service',
    'cutovers',
    command.request.currentCutoverId,
    `manual-resolution-${cutoverDigest(command.request.nextCutoverId).slice(
      0,
      32,
    )}.json`,
  );
}

function preparationRecord(
  command: Readonly<LocalDeploymentCutoverManualCommand>,
  observation: Readonly<{
    legacy: ContainerObservation;
    target: ContainerObservation;
  }>,
): Readonly<ResolutionPreparation> {
  const payload = Object.freeze({
    schema: PREPARATION_SCHEMA,
    schemaVersion: 1 as const,
    state: 'resolution_prepared' as const,
    profile: command.request.profile,
    instanceId: command.request.instanceId,
    currentCutoverId: command.request.currentCutoverId,
    nextCutoverId: command.request.nextCutoverId,
    currentActivationDigest: command.request.currentActivationDigest,
    nextActivationDigest: command.request.nextActivationDigest,
    expectedInstanceHeadDigest: command.request.expectedInstanceHeadDigest,
    expectedManualRecordDigest: command.request.expectedManualRecordDigest,
    expectedLegacyContainerId: command.request.expectedLegacyContainerId,
    expectedTargetContainerId: command.request.expectedTargetContainerId,
    legacyObservationDigest: observation.legacy.digest,
    targetObservationDigest: observation.target.digest,
    requestedAtMs: command.request.requestedAtMs,
  });
  return Object.freeze({
    ...payload,
    preparationDigest: cutoverDigest(payload),
  });
}

function parsePreparation(
  value: unknown,
  command: Readonly<LocalDeploymentCutoverManualCommand>,
): Readonly<ResolutionPreparation> {
  const record = object(value, 'manual resolution preparation');
  exact(
    record,
    [
      'currentActivationDigest',
      'currentCutoverId',
      'expectedInstanceHeadDigest',
      'expectedLegacyContainerId',
      'expectedManualRecordDigest',
      'expectedTargetContainerId',
      'instanceId',
      'legacyObservationDigest',
      'nextActivationDigest',
      'nextCutoverId',
      'preparationDigest',
      'profile',
      'requestedAtMs',
      'schema',
      'schemaVersion',
      'state',
      'targetObservationDigest',
    ],
    'manual resolution preparation',
  );
  const { preparationDigest, ...payload } = record;
  if (
    record.schema !== PREPARATION_SCHEMA ||
    record.schemaVersion !== 1 ||
    record.state !== 'resolution_prepared' ||
    record.profile !== command.request.profile ||
    record.instanceId !== command.request.instanceId ||
    record.currentCutoverId !== command.request.currentCutoverId ||
    record.nextCutoverId !== command.request.nextCutoverId ||
    record.currentActivationDigest !==
      command.request.currentActivationDigest ||
    record.nextActivationDigest !== command.request.nextActivationDigest ||
    record.expectedInstanceHeadDigest !==
      command.request.expectedInstanceHeadDigest ||
    record.expectedManualRecordDigest !==
      command.request.expectedManualRecordDigest ||
    record.expectedLegacyContainerId !==
      command.request.expectedLegacyContainerId ||
    record.expectedTargetContainerId !==
      command.request.expectedTargetContainerId ||
    typeof record.legacyObservationDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.legacyObservationDigest) ||
    typeof record.targetObservationDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.targetObservationDigest) ||
    typeof preparationDigest !== 'string' ||
    preparationDigest !== command.request.expectedPreparationDigest ||
    cutoverDigest(payload) !== preparationDigest
  ) {
    configurationError('manual resolution preparation drifted');
  }
  return record as unknown as Readonly<ResolutionPreparation>;
}

function baseResult(command: Readonly<LocalDeploymentCutoverManualCommand>) {
  return {
    schemaVersion: 1 as const,
    operation: command.operation,
    currentCutoverId: command.request.currentCutoverId,
    nextCutoverId: command.request.nextCutoverId,
  };
}

export function runLocalDeploymentCutoverManualCommand(
  input: unknown,
  dependencies: LocalDeploymentCutoverManualDependencies = {},
): Readonly<LocalDeploymentCutoverManualResult> {
  const command = normalizeLocalDeploymentCutoverManualCommand(input);
  const identity = currentIdentity();
  validatePrivateDirectory(
    localCutoverInstanceDirectory(
      command.options.deploymentRoot,
      command.request.instanceId,
    ),
    identity.uid,
    'cutoverInstanceDirectory',
  );
  const currentHead = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    command.request.instanceId,
    identity.uid,
  );
  if (
    command.operation === 'local.deployment.cutover.manual-resolution-commit' &&
    currentHead.state === 'resolution_authorized' &&
    currentHead.cutoverId === command.request.nextCutoverId &&
    currentHead.activationDigest === command.request.nextActivationDigest &&
    currentHead.previousHeadDigest ===
      command.request.expectedInstanceHeadDigest &&
    currentHead.sourceRecordDigest === command.request.expectedPreparationDigest
  ) {
    return Object.freeze({
      ...baseResult(command),
      status: 'existing' as const,
      state: 'resolution_authorized' as const,
      preparationDigest: command.request.expectedPreparationDigest,
      instanceHeadDigest: currentHead.headDigest,
    });
  }
  const head = manualHead(command, identity.uid);
  verifyManualJournalRecord(command, head);
  const observed = observations(command, dependencies, identity.uid);
  if (command.operation === 'local.deployment.cutover.manual-diagnose') {
    return Object.freeze({
      ...baseResult(command),
      status: 'observed' as const,
      state: 'manual_diagnosed' as const,
      legacyState: observed.legacy.state,
      targetState: observed.target.state,
      legacyObservationDigest: observed.legacy.digest,
      targetObservationDigest: observed.target.digest,
      instanceHeadDigest: head.headDigest,
    });
  }
  if (
    observed.legacy.state !== 'stopped' ||
    observed.target.state !== 'stopped'
  ) {
    configurationError(
      'manual resolution requires both legacy and target to be proved stopped',
    );
  }
  if (
    command.operation === 'local.deployment.cutover.manual-resolution-prepare'
  ) {
    const preparation = preparationRecord(command, observed);
    const serialized = `${JSON.stringify(preparation, null, 2)}\n`;
    const filePath = preparationPath(command);
    const preparationStagePath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.ql3-deploy-stage`,
    );
    if (
      fs.readdirSync(path.dirname(filePath)).length >= MAX_JOURNAL_FILES &&
      !fs.existsSync(filePath) &&
      !fs.existsSync(preparationStagePath)
    ) {
      configurationError('cutover journal retention limit is reached');
    }
    preflightPublishedFile(
      filePath,
      serialized,
      0o600,
      identity.uid,
      'manual resolution preparation',
    );
    const status = publishExactFile(
      filePath,
      serialized,
      0o600,
      identity.uid,
      'manual resolution preparation',
    );
    return Object.freeze({
      ...baseResult(command),
      status,
      state: 'resolution_prepared' as const,
      legacyState: observed.legacy.state,
      targetState: observed.target.state,
      legacyObservationDigest: observed.legacy.digest,
      targetObservationDigest: observed.target.digest,
      preparationDigest: preparation.preparationDigest,
      instanceHeadDigest: head.headDigest,
    });
  }
  const preparation = parsePreparation(
    readPrivateLocalCommandFile(preparationPath(command)),
    command,
  );
  if (
    observed.legacy.digest !== preparation.legacyObservationDigest ||
    observed.target.digest !== preparation.targetObservationDigest
  ) {
    configurationError(
      'manual resolution container evidence drifted after prepare',
    );
  }
  const nextHead = authorizeResolvedLocalCutoverInstance(
    currentIdentityFor(command),
    nextIdentityFor(command),
    identity.uid,
    command.request.expectedInstanceHeadDigest,
    preparation.preparationDigest,
  );
  return Object.freeze({
    ...baseResult(command),
    status: 'prepared' as const,
    state: 'resolution_authorized' as const,
    legacyState: observed.legacy.state,
    targetState: observed.target.state,
    legacyObservationDigest: observed.legacy.digest,
    targetObservationDigest: observed.target.digest,
    preparationDigest: preparation.preparationDigest,
    instanceHeadDigest: nextHead.headDigest,
  });
}

export function runLocalDeploymentCutoverManualCommandFile(
  filePath: string,
  expectedOperation?: LocalDeploymentCutoverManualCommand['operation'],
): Readonly<LocalDeploymentCutoverManualResult> {
  const input = readPrivateLocalCommandFile(filePath);
  if (
    expectedOperation !== undefined &&
    (!input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      (input as Record<string, unknown>).operation !== expectedOperation)
  ) {
    configurationError(
      'manual cutover command does not match the CLI operation',
    );
  }
  return runLocalDeploymentCutoverManualCommand(input);
}

export { EMPTY_RESOLUTION_DIGEST };
