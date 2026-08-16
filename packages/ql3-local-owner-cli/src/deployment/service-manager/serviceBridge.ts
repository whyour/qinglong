import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { LocalDeploymentConfigurationError } from '../foundation/error';
import {
  normalizeLocalServiceBridgeCommand,
  normalizeLocalServiceManagerIntent,
  localServiceManagerIntentPath,
  localServiceManagerOutcomePath,
  type LocalServiceBridgeCommand,
  type LocalServiceBridgeManager,
  type LocalServiceManagerIntent,
} from './serviceBridgeContract';
import {
  ensureRootServiceBridgeDirectory,
  publishServiceBridgeFile,
  readOwnerPrivateJsonFile,
  readServiceBridgeFile,
  validateServiceBridgeDirectory,
} from './serviceBridgeFiles';
import {
  localServiceManagerObservationDigest,
  localServiceManagerOutcomeDigest,
  normalizeLocalServiceManagerObservation,
  normalizeLocalServiceManagerOutcome,
  type LocalServiceManagerManualReason,
  type LocalServiceManagerMutationDisposition,
  type LocalServiceManagerObservation,
  type LocalServiceManagerOutcome,
} from './serviceOutcomeContract';

const MAX_MANAGER_OUTPUT_BYTES = 64 * 1024;
const MANAGER_TIMEOUT_MS = 30_000;

interface ServiceBridgeBarrier {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-local-service-bridge-barrier';
  readonly actionId: string;
  readonly intentDigest: string;
  readonly descriptorDigest: string;
  readonly managerKind: 'systemd' | 'openrc';
  readonly preObservation: Readonly<LocalServiceManagerObservation>;
  readonly createdAtMs: number;
  readonly barrierDigest: string;
}

export interface LocalServiceBridgeRunResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.execute';
  readonly status: 'prepared' | 'existing';
  readonly state: LocalServiceManagerOutcome['state'];
  readonly actionId: string;
  readonly outcomeDigest: string;
}

export interface LocalServiceManagerRunRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface LocalServiceManagerRunResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly responseLost: boolean;
}

export interface LocalServiceBridgeDependencies {
  readonly runManager?: (
    request: Readonly<LocalServiceManagerRunRequest>,
  ) => Readonly<LocalServiceManagerRunResult>;
  readonly now?: () => number;
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
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    typeof process.getgid !== 'function' ||
    typeof process.getegid !== 'function' ||
    process.getuid() !== 0 ||
    process.geteuid() !== 0 ||
    process.getgid() !== 0 ||
    process.getegid() !== 0
  ) {
    configurationError('service bridge requires matching root identities');
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
    (stat.mode & 0o022) !== 0 ||
    (stat.mode & 0o111) === 0 ||
    fs.realpathSync(filePath) !== filePath
  ) {
    configurationError(`${label} must be a canonical root-owned executable`);
  }
}

function validateRootDestinationParent(destinationPath: string): void {
  const directory = path.dirname(destinationPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    configurationError('service descriptor destination is unavailable', error);
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    (stat.mode & 0o022) !== 0 ||
    fs.realpathSync(directory) !== directory
  ) {
    configurationError('service descriptor destination is not trusted');
  }
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
  runManager: NonNullable<LocalServiceBridgeDependencies['runManager']>,
  executable: string,
  args: readonly string[],
): Readonly<LocalServiceManagerRunResult> {
  const result = runManager({
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
    configurationError('service manager runner returned an invalid result');
  }
  return result;
}

function systemdObservation(
  manager: Extract<LocalServiceBridgeManager, { kind: 'systemd' }>,
  intent: Readonly<LocalServiceManagerIntent>,
  runManager: NonNullable<LocalServiceBridgeDependencies['runManager']>,
  now: () => number,
): Readonly<LocalServiceManagerObservation> {
  const result = run(runManager, manager.executable, [
    'show',
    'qinglong3.service',
    '--no-page',
    '--property=LoadState,ActiveState,SubState,FragmentPath,MainPID,UnitFileState',
  ]);
  const fields = new Map<string, string>();
  if (!result.responseLost && result.status === 0) {
    for (const line of result.stdout.split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0)
        fields.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  const rawPid = Number(fields.get('MainPID') ?? '0');
  const loadState = fields.get('LoadState');
  const activeState = fields.get('ActiveState');
  const enabledState = fields.get('UnitFileState');
  const payload = Object.freeze({
    managerKind: 'systemd' as const,
    serviceName: 'qinglong3' as const,
    fragmentPath:
      fields.get('FragmentPath') ?? intent.descriptor.destinationPath,
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
  return normalizeLocalServiceManagerObservation({
    ...payload,
    observationDigest: localServiceManagerObservationDigest(payload),
  });
}

function openrcObservation(
  manager: Extract<LocalServiceBridgeManager, { kind: 'openrc' }>,
  intent: Readonly<LocalServiceManagerIntent>,
  runManager: NonNullable<LocalServiceBridgeDependencies['runManager']>,
  now: () => number,
): Readonly<LocalServiceManagerObservation> {
  const service = run(runManager, manager.serviceExecutable, [
    'qinglong3',
    'status',
  ]);
  const enabled = run(runManager, manager.updateExecutable, [
    'show',
    'default',
  ]);
  const active = !service.responseLost && service.status === 0;
  const stopped =
    !service.responseLost &&
    service.status !== null &&
    (service.stdout.includes('stopped') || service.status === 3);
  const payload = Object.freeze({
    managerKind: 'openrc' as const,
    serviceName: 'qinglong3' as const,
    fragmentPath: intent.descriptor.destinationPath,
    loadState: fs.existsSync(intent.descriptor.destinationPath)
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
      enabled.stdout.split('\n').some((line) => /\bqinglong3\b/.test(line))
        ? ('enabled' as const)
        : ('unknown' as const),
    mainPid: 0,
    observedAtMs: now(),
  });
  return normalizeLocalServiceManagerObservation({
    ...payload,
    observationDigest: localServiceManagerObservationDigest(payload),
  });
}

function inspectManager(
  manager: LocalServiceBridgeManager,
  intent: Readonly<LocalServiceManagerIntent>,
  runManager: NonNullable<LocalServiceBridgeDependencies['runManager']>,
  now: () => number,
): Readonly<LocalServiceManagerObservation> {
  return manager.kind === 'systemd'
    ? systemdObservation(manager, intent, runManager, now)
    : openrcObservation(manager, intent, runManager, now);
}

function managerExecutables(
  manager: LocalServiceBridgeManager,
): readonly string[] {
  return manager.kind === 'systemd'
    ? Object.freeze([manager.executable])
    : Object.freeze([manager.serviceExecutable, manager.updateExecutable]);
}

function executeMutation(
  manager: LocalServiceBridgeManager,
  intent: Readonly<LocalServiceManagerIntent>,
  runManager: NonNullable<LocalServiceBridgeDependencies['runManager']>,
): Readonly<{ failed: boolean; responseLost: boolean }> {
  const results: LocalServiceManagerRunResult[] = [];
  if (manager.kind === 'systemd') {
    if (intent.action === 'install-enable-start') {
      results.push(run(runManager, manager.executable, ['daemon-reload']));
      results.push(
        run(runManager, manager.executable, ['enable', 'qinglong3.service']),
      );
      results.push(
        run(runManager, manager.executable, ['start', 'qinglong3.service']),
      );
    } else {
      results.push(
        run(runManager, manager.executable, [
          intent.action,
          'qinglong3.service',
        ]),
      );
    }
  } else if (intent.action === 'install-enable-start') {
    results.push(
      run(runManager, manager.updateExecutable, [
        'add',
        'qinglong3',
        'default',
      ]),
    );
    results.push(
      run(runManager, manager.serviceExecutable, ['qinglong3', 'start']),
    );
  } else if (intent.action === 'restart') {
    results.push(
      run(runManager, manager.serviceExecutable, ['qinglong3', 'stop']),
    );
    results.push(
      run(runManager, manager.serviceExecutable, ['qinglong3', 'start']),
    );
  } else {
    results.push(
      run(runManager, manager.serviceExecutable, ['qinglong3', intent.action]),
    );
  }
  return Object.freeze({
    failed: results.some(
      (result) => !result.responseLost && result.status !== 0,
    ),
    responseLost: results.some((result) => result.responseLost),
  });
}

function desiredStateProved(
  intent: Readonly<LocalServiceManagerIntent>,
  before: Readonly<LocalServiceManagerObservation>,
  after: Readonly<LocalServiceManagerObservation>,
): boolean {
  if (
    after.managerKind !== intent.service.kind ||
    after.fragmentPath !== intent.descriptor.destinationPath ||
    after.loadState !== 'loaded'
  ) {
    return false;
  }
  if (intent.action === 'stop') {
    return after.activeState === 'inactive' && after.mainPid === 0;
  }
  if (
    after.activeState !== 'active' ||
    (intent.action === 'install-enable-start' &&
      after.enabledState !== 'enabled')
  ) {
    return false;
  }
  if (intent.service.kind === 'openrc') return true;
  if (after.mainPid < 1) return false;
  return (
    intent.action !== 'restart' ||
    before.mainPid === 0 ||
    before.mainPid !== after.mainPid
  );
}

function barrierRecord(
  intent: Readonly<LocalServiceManagerIntent>,
  observation: Readonly<LocalServiceManagerObservation>,
  now: () => number,
): Readonly<ServiceBridgeBarrier> {
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'qinglong3-local-service-bridge-barrier' as const,
    actionId: intent.actionId,
    intentDigest: intent.intentDigest,
    descriptorDigest: intent.descriptor.sha256,
    managerKind: intent.service.kind,
    preObservation: observation,
    createdAtMs: now(),
  });
  return Object.freeze({ ...payload, barrierDigest: digest(payload) });
}

function normalizeBarrier(
  value: unknown,
  intent: Readonly<LocalServiceManagerIntent>,
): Readonly<ServiceBridgeBarrier> {
  const barrier = object(value, 'service bridge barrier');
  exact(
    barrier,
    [
      'actionId',
      'barrierDigest',
      'createdAtMs',
      'descriptorDigest',
      'intentDigest',
      'kind',
      'managerKind',
      'preObservation',
      'schemaVersion',
    ],
    'service bridge barrier',
  );
  const observation = normalizeLocalServiceManagerObservation(
    barrier.preObservation,
  );
  const { barrierDigest, ...payload } = barrier;
  if (
    barrier.schemaVersion !== 1 ||
    barrier.kind !== 'qinglong3-local-service-bridge-barrier' ||
    barrier.actionId !== intent.actionId ||
    barrier.intentDigest !== intent.intentDigest ||
    barrier.descriptorDigest !== intent.descriptor.sha256 ||
    barrier.managerKind !== intent.service.kind ||
    observation.managerKind !== intent.service.kind ||
    !Number.isSafeInteger(barrier.createdAtMs) ||
    (barrier.createdAtMs as number) < 0 ||
    typeof barrierDigest !== 'string' ||
    digest({ ...payload, preObservation: observation }) !== barrierDigest
  ) {
    configurationError('service bridge barrier drifted');
  }
  return barrier as unknown as Readonly<ServiceBridgeBarrier>;
}

function outcomeRecord(
  intent: Readonly<LocalServiceManagerIntent>,
  state: LocalServiceManagerOutcome['state'],
  disposition: LocalServiceManagerMutationDisposition,
  reason: LocalServiceManagerManualReason | null,
  observation: Readonly<LocalServiceManagerObservation>,
  now: () => number,
): Readonly<LocalServiceManagerOutcome> {
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'qinglong3-local-service-manager-outcome' as const,
    actionId: intent.actionId,
    action: intent.action,
    intentDigest: intent.intentDigest,
    descriptorDigest: intent.descriptor.sha256,
    state,
    mutationDisposition: disposition,
    manualReason: reason,
    observation,
    completedAtMs: Math.max(now(), observation.observedAtMs),
  });
  return normalizeLocalServiceManagerOutcome({
    ...payload,
    outcomeDigest: localServiceManagerOutcomeDigest(payload),
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
  intent: Readonly<LocalServiceManagerIntent>,
  outcome: Readonly<LocalServiceManagerOutcome>,
): 'prepared' | 'existing' {
  const contents = `${JSON.stringify(outcome, null, 2)}\n`;
  const rootStatus = publishServiceBridgeFile(
    path.join(actionDirectory, 'outcome.json'),
    contents,
    0o600,
    0,
    0,
    'service bridge root outcome',
  );
  publishServiceBridgeFile(
    intent.outcomePath,
    contents,
    0o600,
    intent.service.uid,
    intent.service.gid,
    'service bridge Owner outcome',
  );
  return rootStatus;
}

function validateIntentMaterial(
  intent: Readonly<LocalServiceManagerIntent>,
): Buffer {
  validateServiceBridgeDirectory(
    intent.deployment.root,
    intent.service.uid,
    intent.service.gid,
    0o700,
    'deploymentRoot',
  );
  validateServiceBridgeDirectory(
    path.join(intent.deployment.root, 'service'),
    intent.service.uid,
    intent.service.gid,
    0o700,
    'serviceDescriptorRoot',
  );
  validateServiceBridgeDirectory(
    path.dirname(intent.outcomePath),
    intent.service.uid,
    intent.service.gid,
    0o700,
    'serviceManagerOutcomeRoot',
  );
  const application = readServiceBridgeFile(
    intent.deployment.applicationConfigPath,
    {
      uid: intent.service.uid,
      gid: intent.service.gid,
      mode: 0o600,
    },
    'application configuration',
  );
  const descriptor = readServiceBridgeFile(
    intent.descriptor.sourcePath,
    {
      uid: intent.service.uid,
      gid: intent.service.gid,
      mode: intent.descriptor.sourceMode,
      maximumBytes: 64 * 1024,
    },
    'service descriptor',
  );
  try {
    if (
      sha256(application) !== intent.deployment.applicationConfigSha256 ||
      sha256(descriptor) !== intent.descriptor.sha256
    ) {
      configurationError('service manager source material drifted');
    }
    return descriptor;
  } finally {
    application.fill(0);
  }
}

function destinationMatches(
  intent: Readonly<LocalServiceManagerIntent>,
): boolean {
  try {
    const bytes = readServiceBridgeFile(
      intent.descriptor.destinationPath,
      {
        uid: 0,
        gid: 0,
        mode: intent.descriptor.destinationMode,
        maximumBytes: 64 * 1024,
      },
      'installed service descriptor',
    );
    try {
      return sha256(bytes) === intent.descriptor.sha256;
    } finally {
      bytes.fill(0);
    }
  } catch {
    return false;
  }
}

export function runLocalServiceBridge(
  input: unknown,
  dependencies: Readonly<LocalServiceBridgeDependencies> = {},
): Readonly<LocalServiceBridgeRunResult> {
  assertRootIdentity();
  const command = normalizeLocalServiceBridgeCommand(input);
  const runManager = dependencies.runManager ?? defaultRunManager;
  const now = dependencies.now ?? Date.now;
  const ownedIntent = readOwnerPrivateJsonFile(
    command.request.intentPath,
    'service manager intent',
  );
  const intent = normalizeLocalServiceManagerIntent(ownedIntent.value);
  if (
    intent.intentDigest !== command.request.expectedIntentDigest ||
    ownedIntent.uid !== intent.service.uid ||
    ownedIntent.gid !== intent.service.gid ||
    command.request.intentPath !==
      localServiceManagerIntentPath(intent.deployment.root, intent.actionId) ||
    intent.outcomePath !==
      localServiceManagerOutcomePath(intent.deployment.root, intent.actionId) ||
    command.options.manager.kind !== intent.service.kind
  ) {
    configurationError('service bridge command and Owner intent drifted');
  }
  for (const executable of managerExecutables(command.options.manager)) {
    trustedRootExecutable(executable, 'service manager executable');
  }
  validateRootDestinationParent(intent.descriptor.destinationPath);
  const descriptor = validateIntentMaterial(intent);
  ensureRootServiceBridgeDirectory(
    command.options.controllerRoot,
    'serviceBridgeControllerRoot',
  );
  const actionDirectory = path.join(
    command.options.controllerRoot,
    intent.actionId,
  );
  ensureRootServiceBridgeDirectory(actionDirectory, 'serviceBridgeActionRoot');
  const barrierPath = path.join(actionDirectory, 'barrier.json');
  const rootOutcomePath = path.join(actionDirectory, 'outcome.json');
  try {
    if (fs.existsSync(rootOutcomePath)) {
      const existing = normalizeLocalServiceManagerOutcome(
        readRootJson(rootOutcomePath, 'service bridge root outcome'),
      );
      if (
        existing.actionId !== intent.actionId ||
        existing.intentDigest !== intent.intentDigest ||
        existing.descriptorDigest !== intent.descriptor.sha256
      ) {
        configurationError('service bridge root outcome drifted');
      }
      publishOutcome(actionDirectory, intent, existing);
      return Object.freeze({
        schemaVersion: 1 as const,
        operation: 'local.deployment.service-manager.execute' as const,
        status: 'existing' as const,
        state: existing.state,
        actionId: existing.actionId,
        outcomeDigest: existing.outcomeDigest,
      });
    }
    const replay = fs.existsSync(barrierPath);
    const barrier = replay
      ? normalizeBarrier(
          readRootJson(barrierPath, 'service bridge barrier'),
          intent,
        )
      : barrierRecord(
          intent,
          inspectManager(command.options.manager, intent, runManager, now),
          now,
        );
    if (!replay) {
      publishServiceBridgeFile(
        barrierPath,
        `${JSON.stringify(barrier, null, 2)}\n`,
        0o600,
        0,
        0,
        'service bridge barrier',
      );
    }
    let descriptorReady = destinationMatches(intent);
    if (
      !replay &&
      intent.action === 'install-enable-start' &&
      !descriptorReady
    ) {
      publishServiceBridgeFile(
        intent.descriptor.destinationPath,
        descriptor.toString('utf8'),
        intent.descriptor.destinationMode,
        0,
        0,
        'installed service descriptor',
      );
      descriptorReady = destinationMatches(intent);
    }
    if (!descriptorReady) {
      const observation = inspectManager(
        command.options.manager,
        intent,
        runManager,
        now,
      );
      const outcome = outcomeRecord(
        intent,
        'manual_required',
        replay ? 'replay-inspected' : 'executed',
        'descriptor_install_unproved',
        observation,
        now,
      );
      const status = publishOutcome(actionDirectory, intent, outcome);
      return Object.freeze({
        schemaVersion: 1 as const,
        operation: 'local.deployment.service-manager.execute' as const,
        status,
        state: outcome.state,
        actionId: outcome.actionId,
        outcomeDigest: outcome.outcomeDigest,
      });
    }
    const mutation = replay
      ? Object.freeze({ failed: false, responseLost: false })
      : executeMutation(command.options.manager, intent, runManager);
    const observation = inspectManager(
      command.options.manager,
      intent,
      runManager,
      now,
    );
    const proved = desiredStateProved(
      intent,
      barrier.preObservation,
      observation,
    );
    const disposition: LocalServiceManagerMutationDisposition = replay
      ? 'replay-inspected'
      : mutation.responseLost
      ? 'response-loss-inspected'
      : 'executed';
    const manualReason: LocalServiceManagerManualReason | null = proved
      ? null
      : mutation.failed
      ? 'manager_command_failed'
      : 'manager_state_unproved';
    const outcome = outcomeRecord(
      intent,
      proved
        ? intent.action === 'stop'
          ? 'stopped'
          : 'active'
        : 'manual_required',
      disposition,
      manualReason,
      observation,
      now,
    );
    const status = publishOutcome(actionDirectory, intent, outcome);
    return Object.freeze({
      schemaVersion: 1 as const,
      operation: 'local.deployment.service-manager.execute' as const,
      status,
      state: outcome.state,
      actionId: outcome.actionId,
      outcomeDigest: outcome.outcomeDigest,
    });
  } finally {
    descriptor.fill(0);
  }
}

export function runLocalServiceBridgeCommandFile(
  commandFile: string,
  dependencies: Readonly<LocalServiceBridgeDependencies> = {},
): Readonly<LocalServiceBridgeRunResult> {
  return runLocalServiceBridge(
    readPrivateLocalCommandFile(commandFile),
    dependencies,
  );
}
