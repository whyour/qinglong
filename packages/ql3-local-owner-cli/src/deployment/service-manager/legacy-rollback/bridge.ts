import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { LocalDeploymentConfigurationError } from '../../foundation/error';
import type {
  LocalServiceBridgeManager,
  LocalServiceManagerKind,
} from '../serviceBridgeContract';
import {
  ensureRootServiceBridgeDirectory,
  publishServiceBridgeFile,
  readOwnerPrivateJsonFile,
  readServiceBridgeFile,
  validateServiceBridgeDirectory,
} from '../serviceBridgeFiles';
import type {
  LocalServiceManagerRunRequest,
  LocalServiceManagerRunResult,
} from '../serviceBridge';
import {
  localServiceManagerLegacyDescriptorPath,
  localServiceManagerLegacyStartAuthorizationPath,
  localServiceManagerLegacyStartOutcomeDigest,
  localServiceManagerLegacyStartOutcomePath,
  localServiceManagerRollbackObservationDigest,
  localServiceManagerTargetDescriptorPath,
  normalizeLocalServiceManagerLegacyRollbackBridgeCommand,
  normalizeLocalServiceManagerLegacyStartAuthorization,
  normalizeLocalServiceManagerLegacyStartOutcome,
  normalizeLocalServiceManagerRollbackObservation,
  type LocalServiceManagerLegacyRollbackBridgeCommand,
  type LocalServiceManagerLegacyRollbackBridgeResult,
  type LocalServiceManagerLegacyStartAuthorization,
  type LocalServiceManagerLegacyStartOutcome,
  type LocalServiceManagerRollbackManualReason,
  type LocalServiceManagerRollbackMutationDisposition,
  type LocalServiceManagerRollbackObservation,
} from './contract';

const BARRIER_SCHEMA = 'qinglong3-local-service-manager-legacy-start-barrier';
const MAX_MANAGER_OUTPUT_BYTES = 64 * 1024;
const MANAGER_TIMEOUT_MS = 45_000;

interface LegacyStartBarrier {
  readonly schema: typeof BARRIER_SCHEMA;
  readonly schemaVersion: 1;
  readonly cutoverId: string;
  readonly generation: number;
  readonly managerKind: LocalServiceManagerKind;
  readonly preparationDigest: string;
  readonly authorizationDigest: string;
  readonly ownerUid: number;
  readonly ownerGid: number;
  readonly legacyDescriptorDigest: string;
  readonly targetDescriptorDigest: string;
  readonly legacyPreObservation: Readonly<LocalServiceManagerRollbackObservation>;
  readonly targetPreObservation: Readonly<LocalServiceManagerRollbackObservation>;
  readonly createdAtMs: number;
  readonly barrierDigest: string;
}

export interface LocalServiceManagerLegacyRollbackBridgeDependencies {
  readonly runManager?: (
    request: Readonly<LocalServiceManagerRunRequest>,
  ) => Readonly<LocalServiceManagerRunResult>;
  readonly now?: () => number;
  readonly afterBarrier?: () => void;
  readonly afterStart?: () => void;
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

function digest(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertRootIdentity(): void {
  if (
    process.platform === 'win32' ||
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    process.getuid() !== 0 ||
    process.geteuid() !== 0
  ) {
    configurationError('legacy rollback bridge must run as root');
  }
}

function trustedRootExecutable(filePath: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    configurationError(`${label} is unavailable`, error);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    stat.gid !== 0 ||
    stat.nlink < 1 ||
    (stat.mode & 0o022) !== 0 ||
    fs.realpathSync(filePath) !== filePath
  ) {
    configurationError(`${label} identity is invalid`);
  }
}

function managerExecutables(
  manager: LocalServiceBridgeManager,
): readonly string[] {
  return manager.kind === 'systemd'
    ? Object.freeze([manager.executable])
    : Object.freeze([manager.serviceExecutable, manager.updateExecutable]);
}

function defaultRunManager(
  request: Readonly<LocalServiceManagerRunRequest>,
): Readonly<LocalServiceManagerRunResult> {
  const result = spawnSync(request.executable, [...request.args], {
    encoding: 'utf8',
    env: Object.freeze({
      PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
    }),
    timeout: request.timeoutMs,
    maxBuffer: MAX_MANAGER_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
  });
  return Object.freeze({
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    responseLost: result.error !== undefined || result.status === null,
  });
}

function run(
  runner: NonNullable<
    LocalServiceManagerLegacyRollbackBridgeDependencies['runManager']
  >,
  executable: string,
  args: readonly string[],
): Readonly<LocalServiceManagerRunResult> {
  const result = runner({
    executable,
    args: Object.freeze([...args]),
    timeoutMs: MANAGER_TIMEOUT_MS,
  });
  if (
    !result ||
    typeof result !== 'object' ||
    (result.status !== null && !Number.isSafeInteger(result.status)) ||
    (result.signal !== null && typeof result.signal !== 'string') ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string' ||
    typeof result.responseLost !== 'boolean' ||
    Buffer.byteLength(result.stdout, 'utf8') > MAX_MANAGER_OUTPUT_BYTES ||
    Buffer.byteLength(result.stderr, 'utf8') > MAX_MANAGER_OUTPUT_BYTES
  ) {
    configurationError('legacy rollback manager runner returned invalid data');
  }
  return result;
}

function systemdObservation(
  manager: Extract<LocalServiceBridgeManager, { kind: 'systemd' }>,
  serviceName: 'qinglong' | 'qinglong3',
  fragmentPath: string,
  runner: NonNullable<
    LocalServiceManagerLegacyRollbackBridgeDependencies['runManager']
  >,
  now: () => number,
): Readonly<LocalServiceManagerRollbackObservation> {
  const result = run(runner, manager.executable, [
    'show',
    `${serviceName}.service`,
    '--no-page',
    '--property=LoadState,ActiveState,SubState,FragmentPath,MainPID,UnitFileState',
  ]);
  const fields = new Map<string, string>();
  if (!result.responseLost && result.status === 0) {
    for (const line of result.stdout.split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) {
        fields.set(line.slice(0, separator), line.slice(separator + 1));
      }
    }
  }
  const rawPid = Number(fields.get('MainPID') ?? '0');
  const loadState = fields.get('LoadState');
  const activeState = fields.get('ActiveState');
  const enabledState = fields.get('UnitFileState');
  const payload = Object.freeze({
    managerKind: 'systemd' as const,
    serviceName,
    fragmentPath: fields.get('FragmentPath') || fragmentPath,
    loadState:
      loadState === 'loaded'
        ? ('loaded' as const)
        : loadState === 'not-found'
        ? ('not-found' as const)
        : ('unknown' as const),
    activeState:
      activeState === 'active'
        ? ('active' as const)
        : activeState === 'inactive'
        ? ('inactive' as const)
        : activeState === 'failed'
        ? ('failed' as const)
        : ('unknown' as const),
    subState: (fields.get('SubState') ?? 'unknown').slice(0, 128),
    enabledState:
      enabledState === 'enabled'
        ? ('enabled' as const)
        : enabledState === 'disabled'
        ? ('disabled' as const)
        : enabledState === 'static'
        ? ('static' as const)
        : ('unknown' as const),
    mainPid:
      Number.isSafeInteger(rawPid) && rawPid >= 0 && rawPid <= 0x7fffffff
        ? rawPid
        : 0,
    observedAtMs: now(),
  });
  return normalizeLocalServiceManagerRollbackObservation({
    ...payload,
    observationDigest: localServiceManagerRollbackObservationDigest(payload),
  });
}

function openrcObservation(
  manager: Extract<LocalServiceBridgeManager, { kind: 'openrc' }>,
  serviceName: 'qinglong' | 'qinglong3',
  fragmentPath: string,
  runner: NonNullable<
    LocalServiceManagerLegacyRollbackBridgeDependencies['runManager']
  >,
  now: () => number,
): Readonly<LocalServiceManagerRollbackObservation> {
  const service = run(runner, manager.serviceExecutable, [
    serviceName,
    'status',
  ]);
  const enabled = run(runner, manager.updateExecutable, ['show', 'default']);
  const active = !service.responseLost && service.status === 0;
  const stopped =
    !service.responseLost &&
    service.status !== null &&
    (service.stdout.includes('stopped') || service.status === 3);
  const payload = Object.freeze({
    managerKind: 'openrc' as const,
    serviceName,
    fragmentPath,
    loadState: fs.existsSync(fragmentPath)
      ? ('loaded' as const)
      : ('not-found' as const),
    activeState: active
      ? ('active' as const)
      : stopped
      ? ('inactive' as const)
      : ('unknown' as const),
    subState: active ? 'started' : stopped ? 'stopped' : 'unknown',
    enabledState:
      !enabled.responseLost &&
      enabled.status === 0 &&
      enabled.stdout
        .split('\n')
        .some((line) => new RegExp(`\\b${serviceName}\\b`).test(line))
        ? ('enabled' as const)
        : ('unknown' as const),
    mainPid: 0,
    observedAtMs: now(),
  });
  return normalizeLocalServiceManagerRollbackObservation({
    ...payload,
    observationDigest: localServiceManagerRollbackObservationDigest(payload),
  });
}

function inspectManager(
  manager: LocalServiceBridgeManager,
  serviceName: 'qinglong' | 'qinglong3',
  fragmentPath: string,
  runner: NonNullable<
    LocalServiceManagerLegacyRollbackBridgeDependencies['runManager']
  >,
  now: () => number,
): Readonly<LocalServiceManagerRollbackObservation> {
  return manager.kind === 'systemd'
    ? systemdObservation(manager, serviceName, fragmentPath, runner, now)
    : openrcObservation(manager, serviceName, fragmentPath, runner, now);
}

function descriptorDigest(
  filePath: string,
  kind: LocalServiceManagerKind,
): string {
  const bytes = readServiceBridgeFile(
    filePath,
    {
      uid: 0,
      gid: 0,
      mode: kind === 'systemd' ? 0o644 : 0o755,
      maximumBytes: 64 * 1024,
    },
    'installed rollback service descriptor',
  );
  try {
    return sha256(bytes);
  } finally {
    bytes.fill(0);
  }
}

function ownerMaterialMatches(
  command: Readonly<LocalServiceManagerLegacyRollbackBridgeCommand>,
  authorization: Readonly<LocalServiceManagerLegacyStartAuthorization>,
  ownerUid: number,
  ownerGid: number,
): boolean {
  const material = [
    [
      path.join(command.options.deploymentRoot, 'local-application.json'),
      authorization.applicationConfigDigest,
      'application configuration',
    ],
    [
      path.join(
        command.options.deploymentRoot,
        'service',
        'cutovers',
        authorization.cutoverId,
        '0002-legacy-stopped.json',
      ),
      authorization.commitmentFileDigest,
      'legacy silence commitment',
    ],
  ] as const;
  try {
    for (const [filePath, expectedDigest, label] of material) {
      const bytes = readServiceBridgeFile(
        filePath,
        { uid: ownerUid, gid: ownerGid, mode: 0o600 },
        label,
      );
      try {
        if (sha256(bytes) !== expectedDigest) return false;
      } finally {
        bytes.fill(0);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function barrierRecord(
  authorization: Readonly<LocalServiceManagerLegacyStartAuthorization>,
  ownerUid: number,
  ownerGid: number,
  legacyDescriptorDigest: string,
  targetDescriptorDigest: string,
  legacyPreObservation: Readonly<LocalServiceManagerRollbackObservation>,
  targetPreObservation: Readonly<LocalServiceManagerRollbackObservation>,
  now: () => number,
): Readonly<LegacyStartBarrier> {
  const payload = Object.freeze({
    schema: BARRIER_SCHEMA,
    schemaVersion: 1 as const,
    cutoverId: authorization.cutoverId,
    generation: authorization.generation,
    managerKind: authorization.managerKind,
    preparationDigest: authorization.preparationDigest,
    authorizationDigest: authorization.authorizationDigest,
    ownerUid,
    ownerGid,
    legacyDescriptorDigest,
    targetDescriptorDigest,
    legacyPreObservation,
    targetPreObservation,
    createdAtMs: now(),
  });
  return Object.freeze({ ...payload, barrierDigest: digest(payload) });
}

function normalizeBarrier(
  value: unknown,
  authorization: Readonly<LocalServiceManagerLegacyStartAuthorization>,
): Readonly<LegacyStartBarrier> {
  const barrier = object(value, 'legacy start barrier');
  exact(
    barrier,
    [
      'authorizationDigest',
      'barrierDigest',
      'createdAtMs',
      'cutoverId',
      'generation',
      'legacyDescriptorDigest',
      'legacyPreObservation',
      'managerKind',
      'ownerGid',
      'ownerUid',
      'preparationDigest',
      'schema',
      'schemaVersion',
      'targetDescriptorDigest',
      'targetPreObservation',
    ],
    'legacy start barrier',
  );
  const legacyPreObservation = normalizeLocalServiceManagerRollbackObservation(
    barrier.legacyPreObservation,
  );
  const targetPreObservation = normalizeLocalServiceManagerRollbackObservation(
    barrier.targetPreObservation,
  );
  const { barrierDigest, ...rawPayload } = barrier;
  const payload = {
    ...rawPayload,
    legacyPreObservation,
    targetPreObservation,
  };
  if (
    barrier.schema !== BARRIER_SCHEMA ||
    barrier.schemaVersion !== 1 ||
    barrier.cutoverId !== authorization.cutoverId ||
    barrier.generation !== authorization.generation ||
    barrier.managerKind !== authorization.managerKind ||
    barrier.preparationDigest !== authorization.preparationDigest ||
    barrier.authorizationDigest !== authorization.authorizationDigest ||
    !Number.isSafeInteger(barrier.ownerUid) ||
    (barrier.ownerUid as number) < 0 ||
    !Number.isSafeInteger(barrier.ownerGid) ||
    (barrier.ownerGid as number) < 0 ||
    typeof barrier.legacyDescriptorDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(barrier.legacyDescriptorDigest) ||
    barrier.targetDescriptorDigest !== authorization.targetDescriptorDigest ||
    legacyPreObservation.managerKind !== authorization.managerKind ||
    legacyPreObservation.serviceName !== 'qinglong' ||
    targetPreObservation.managerKind !== authorization.managerKind ||
    targetPreObservation.serviceName !== 'qinglong3' ||
    !Number.isSafeInteger(barrier.createdAtMs) ||
    (barrier.createdAtMs as number) < authorization.requestedAtMs ||
    typeof barrierDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(barrierDigest) ||
    digest(payload) !== barrierDigest
  ) {
    configurationError('legacy start barrier drifted');
  }
  return barrier as unknown as Readonly<LegacyStartBarrier>;
}

function preconditionProved(
  observation: Readonly<LocalServiceManagerRollbackObservation>,
  expectedPath: string,
): boolean {
  return (
    observation.fragmentPath === expectedPath &&
    observation.loadState === 'loaded' &&
    observation.activeState === 'inactive' &&
    observation.mainPid === 0
  );
}

function finalStateProved(
  managerKind: LocalServiceManagerKind,
  legacy: Readonly<LocalServiceManagerRollbackObservation>,
  target: Readonly<LocalServiceManagerRollbackObservation>,
  legacyPath: string,
  targetPath: string,
): boolean {
  return (
    legacy.fragmentPath === legacyPath &&
    legacy.loadState === 'loaded' &&
    legacy.activeState === 'active' &&
    (managerKind === 'openrc' || legacy.mainPid > 0) &&
    target.fragmentPath === targetPath &&
    target.loadState === 'loaded' &&
    target.activeState === 'inactive' &&
    target.mainPid === 0
  );
}

function executeStart(
  manager: LocalServiceBridgeManager,
  runner: NonNullable<
    LocalServiceManagerLegacyRollbackBridgeDependencies['runManager']
  >,
): Readonly<{ failed: boolean; responseLost: boolean }> {
  const result =
    manager.kind === 'systemd'
      ? run(runner, manager.executable, ['start', 'qinglong.service'])
      : run(runner, manager.serviceExecutable, ['qinglong', 'start']);
  return Object.freeze({
    failed: !result.responseLost && result.status !== 0,
    responseLost: result.responseLost,
  });
}

function outcomeRecord(
  authorization: Readonly<LocalServiceManagerLegacyStartAuthorization>,
  barrier: Readonly<LegacyStartBarrier>,
  state: LocalServiceManagerLegacyStartOutcome['state'],
  disposition: LocalServiceManagerRollbackMutationDisposition,
  manualReason: LocalServiceManagerRollbackManualReason | null,
  legacyObservation: Readonly<LocalServiceManagerRollbackObservation>,
  targetObservation: Readonly<LocalServiceManagerRollbackObservation>,
  now: () => number,
): Readonly<LocalServiceManagerLegacyStartOutcome> {
  const payload = Object.freeze({
    schema: 'qinglong3-local-service-manager-legacy-start-outcome' as const,
    schemaVersion: 1 as const,
    state,
    cutoverId: authorization.cutoverId,
    profile: authorization.profile,
    instanceId: authorization.instanceId,
    generation: authorization.generation,
    activationDigest: authorization.activationDigest,
    managerKind: authorization.managerKind,
    preparationDigest: authorization.preparationDigest,
    authorizationDigest: authorization.authorizationDigest,
    barrierDigest: barrier.barrierDigest,
    legacyDescriptorDigest: barrier.legacyDescriptorDigest,
    targetDescriptorDigest: barrier.targetDescriptorDigest,
    mutationDisposition: disposition,
    manualReason,
    legacyObservation,
    targetObservation,
    completedAtMs: Math.max(
      now(),
      legacyObservation.observedAtMs,
      targetObservation.observedAtMs,
    ),
  });
  return normalizeLocalServiceManagerLegacyStartOutcome({
    ...payload,
    outcomeDigest: localServiceManagerLegacyStartOutcomeDigest(payload),
  });
}

function readRootJson(filePath: string, label: string): unknown {
  const file = readOwnerPrivateJsonFile(filePath, label);
  if (file.uid !== 0 || file.gid !== 0) {
    configurationError(`${label} is not root-owned`);
  }
  return file.value;
}

function publishOutcome(
  actionDirectory: string,
  ownerOutcomePath: string,
  ownerUid: number,
  ownerGid: number,
  outcome: Readonly<LocalServiceManagerLegacyStartOutcome>,
): 'prepared' | 'existing' {
  const contents = `${JSON.stringify(outcome, null, 2)}\n`;
  const status = publishServiceBridgeFile(
    path.join(actionDirectory, 'outcome.json'),
    contents,
    0o600,
    0,
    0,
    'legacy start root outcome',
  );
  publishServiceBridgeFile(
    ownerOutcomePath,
    contents,
    0o600,
    ownerUid,
    ownerGid,
    'legacy start Owner outcome',
  );
  return status;
}

function result(
  command: Readonly<LocalServiceManagerLegacyRollbackBridgeCommand>,
  status: 'prepared' | 'existing',
  outcome: Readonly<LocalServiceManagerLegacyStartOutcome>,
): Readonly<LocalServiceManagerLegacyRollbackBridgeResult> {
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status,
    state: outcome.state,
    cutoverId: outcome.cutoverId,
    generation: outcome.generation,
    outcomeDigest: outcome.outcomeDigest,
  });
}

export function runLocalServiceManagerLegacyRollbackBridge(
  input: unknown,
  dependencies: Readonly<LocalServiceManagerLegacyRollbackBridgeDependencies> = {},
): Readonly<LocalServiceManagerLegacyRollbackBridgeResult> {
  assertRootIdentity();
  const command =
    normalizeLocalServiceManagerLegacyRollbackBridgeCommand(input);
  const runner = dependencies.runManager ?? defaultRunManager;
  const now = dependencies.now ?? Date.now;
  for (const executable of managerExecutables(command.options.manager)) {
    trustedRootExecutable(executable, 'service manager executable');
  }
  const authorizationPath = localServiceManagerLegacyStartAuthorizationPath(
    command.options.deploymentRoot,
    command.request.cutoverId,
    command.request.generation,
  );
  const ownedAuthorization = readOwnerPrivateJsonFile(
    authorizationPath,
    'legacy start authorization',
  );
  const authorization = normalizeLocalServiceManagerLegacyStartAuthorization(
    ownedAuthorization.value,
  );
  if (
    authorization.authorizationDigest !==
      command.request.expectedAuthorizationDigest ||
    authorization.cutoverId !== command.request.cutoverId ||
    authorization.generation !== command.request.generation ||
    authorization.managerKind !== command.options.manager.kind
  ) {
    configurationError('legacy rollback root authorization drifted');
  }
  const ownerUid = ownedAuthorization.uid;
  const ownerGid = ownedAuthorization.gid;
  validateServiceBridgeDirectory(
    command.options.deploymentRoot,
    ownerUid,
    ownerGid,
    0o700,
    'deploymentRoot',
  );
  validateServiceBridgeDirectory(
    path.join(command.options.deploymentRoot, 'service'),
    ownerUid,
    ownerGid,
    0o700,
    'serviceDescriptorRoot',
  );
  const legacyPath = localServiceManagerLegacyDescriptorPath(
    authorization.managerKind,
  );
  const targetPath = localServiceManagerTargetDescriptorPath(
    authorization.managerKind,
  );
  ensureRootServiceBridgeDirectory(
    command.options.controllerRoot,
    'serviceBridgeControllerRoot',
  );
  const rollbackRoot = path.join(
    command.options.controllerRoot,
    'legacy-rollbacks',
  );
  ensureRootServiceBridgeDirectory(rollbackRoot, 'legacyRollbackRoot');
  const actionDirectory = path.join(
    rollbackRoot,
    authorization.authorizationDigest,
  );
  ensureRootServiceBridgeDirectory(actionDirectory, 'legacyRollbackActionRoot');
  const barrierPath = path.join(actionDirectory, 'barrier.json');
  const rootOutcomePath = path.join(actionDirectory, 'outcome.json');
  const ownerOutcomePath = localServiceManagerLegacyStartOutcomePath(
    command.options.deploymentRoot,
    authorization.cutoverId,
    authorization.generation,
  );
  if (fs.existsSync(rootOutcomePath)) {
    const existing = normalizeLocalServiceManagerLegacyStartOutcome(
      readRootJson(rootOutcomePath, 'legacy start root outcome'),
    );
    if (
      existing.authorizationDigest !== authorization.authorizationDigest ||
      existing.preparationDigest !== authorization.preparationDigest ||
      existing.managerKind !== authorization.managerKind
    ) {
      configurationError('legacy start root outcome drifted');
    }
    publishOutcome(
      actionDirectory,
      ownerOutcomePath,
      ownerUid,
      ownerGid,
      existing,
    );
    return result(command, 'existing', existing);
  }
  const legacyDigest = descriptorDigest(legacyPath, authorization.managerKind);
  const targetDigest = descriptorDigest(targetPath, authorization.managerKind);
  if (
    targetDigest !== authorization.targetDescriptorDigest ||
    !ownerMaterialMatches(command, authorization, ownerUid, ownerGid)
  ) {
    configurationError('legacy rollback root preflight material drifted');
  }
  const replay = fs.existsSync(barrierPath);
  const barrier = replay
    ? normalizeBarrier(
        readRootJson(barrierPath, 'legacy start barrier'),
        authorization,
      )
    : barrierRecord(
        authorization,
        ownerUid,
        ownerGid,
        legacyDigest,
        targetDigest,
        inspectManager(
          command.options.manager,
          'qinglong',
          legacyPath,
          runner,
          now,
        ),
        inspectManager(
          command.options.manager,
          'qinglong3',
          targetPath,
          runner,
          now,
        ),
        now,
      );
  if (!replay) {
    publishServiceBridgeFile(
      barrierPath,
      `${JSON.stringify(barrier, null, 2)}\n`,
      0o600,
      0,
      0,
      'legacy start barrier',
    );
    dependencies.afterBarrier?.();
  }
  let mutation: Readonly<{ failed: boolean; responseLost: boolean }> =
    Object.freeze({ failed: false, responseLost: false });
  let immediateReason: LocalServiceManagerRollbackManualReason | null = null;
  if (
    !preconditionProved(barrier.legacyPreObservation, legacyPath) ||
    !preconditionProved(barrier.targetPreObservation, targetPath)
  ) {
    immediateReason = 'start_precondition_unproved';
  } else if (
    descriptorDigest(legacyPath, authorization.managerKind) !==
      barrier.legacyDescriptorDigest ||
    descriptorDigest(targetPath, authorization.managerKind) !==
      barrier.targetDescriptorDigest
  ) {
    immediateReason = 'service_descriptor_drifted';
  } else if (
    !ownerMaterialMatches(command, authorization, ownerUid, ownerGid)
  ) {
    immediateReason = 'authorization_material_drifted';
  } else if (!replay) {
    mutation = executeStart(command.options.manager, runner);
    dependencies.afterStart?.();
  }
  const legacyObservation = inspectManager(
    command.options.manager,
    'qinglong',
    legacyPath,
    runner,
    now,
  );
  const targetObservation = inspectManager(
    command.options.manager,
    'qinglong3',
    targetPath,
    runner,
    now,
  );
  let descriptorDrifted = false;
  try {
    descriptorDrifted =
      descriptorDigest(legacyPath, authorization.managerKind) !==
        barrier.legacyDescriptorDigest ||
      descriptorDigest(targetPath, authorization.managerKind) !==
        barrier.targetDescriptorDigest;
  } catch {
    descriptorDrifted = true;
  }
  const proved =
    immediateReason === null &&
    !descriptorDrifted &&
    finalStateProved(
      authorization.managerKind,
      legacyObservation,
      targetObservation,
      legacyPath,
      targetPath,
    );
  const disposition: LocalServiceManagerRollbackMutationDisposition = replay
    ? 'replay-inspected'
    : mutation.responseLost
    ? 'response-loss-inspected'
    : 'executed';
  const manualReason: LocalServiceManagerRollbackManualReason | null = proved
    ? null
    : immediateReason ??
      (descriptorDrifted
        ? 'service_descriptor_drifted'
        : mutation.failed
        ? 'manager_command_failed'
        : 'manager_state_unproved');
  const outcome = outcomeRecord(
    authorization,
    barrier,
    proved ? 'legacy_running' : 'manual_required',
    disposition,
    manualReason,
    legacyObservation,
    targetObservation,
    now,
  );
  const status = publishOutcome(
    actionDirectory,
    ownerOutcomePath,
    ownerUid,
    ownerGid,
    outcome,
  );
  return result(command, status, outcome);
}

export function runLocalServiceManagerLegacyRollbackBridgeCommandFile(
  commandFile: string,
  dependencies: Readonly<LocalServiceManagerLegacyRollbackBridgeDependencies> = {},
): Readonly<LocalServiceManagerLegacyRollbackBridgeResult> {
  return runLocalServiceManagerLegacyRollbackBridge(
    readPrivateLocalCommandFile(commandFile),
    dependencies,
  );
}
