import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';
import {
  createLocalSqliteRolloutBackup,
  inspectLocalSqliteRolloutBackup,
  LOCAL_SQLITE_WRITE_CONTRACT_VERSION,
  openLocalSqliteChangeObserver,
  type LocalSqliteRolloutBackupEvidence,
  type LocalSqliteRolloutBackupOptions,
} from '@qinglong/local-sqlite/rollout-safety';

import { preflightLocalDeploymentCompose } from './composePreflight';
import { evidenceDigest, inspectCollectedEvidence } from './composeEvidence';
import {
  inspectActiveComposeImageSelection,
  inspectComposeImageSelectionGeneration,
  switchLocalDeploymentComposeRevision,
  type ComposeImageSelection,
} from './composeRevision';
import {
  currentIdentity,
  LocalDeploymentConfigurationError,
  normalizeLocalDeploymentComposeApplyCommand,
  type LocalDeploymentComposeApplyCommand,
  type LocalDeploymentComposeApplyResult,
  type LocalDeploymentProfile,
} from '../foundation/contract';
import {
  runLocalDeploymentDockerCommand,
  validateLocalDeploymentDockerSocket,
  type LocalDeploymentDockerRunner,
} from '../foundation/docker';
import {
  preflightPublishedFile,
  publishExactFile,
  syncPublishedDirectory,
  validatePrivateDirectory,
} from '../foundation/files';
import {
  deploymentPaths,
  type LocalDeploymentPaths,
} from '../foundation/render';

const RECEIPT_SCHEMA = 'qinglong/local-compose-rollout-receipt@v2';
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_RETAINED_ROLLOUT_BACKUPS = 8;

export interface LocalDeploymentComposeApplyDependencies {
  readonly runDocker?: LocalDeploymentDockerRunner;
  readonly validateSocket?: (socketPath: string, uid: number) => void;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly createBackup?: typeof createLocalSqliteRolloutBackup;
  readonly inspectBackup?: typeof inspectLocalSqliteRolloutBackup;
  readonly openChangeObserver?: typeof openLocalSqliteChangeObserver;
}

interface ActiveEvidence {
  readonly digest: string;
}

type SqliteWriteObservation = 'unchanged' | 'changed' | 'recovery_unknown';

interface RolloutBackupReceipt {
  readonly sha256: string;
  readonly bytes: number;
  readonly pageCount: number;
  readonly pageSize: number;
}

interface RolloutSqliteReceipt {
  readonly contractVersion: number;
  readonly writeContractVersion: number;
  readonly writeObservation: SqliteWriteObservation;
  readonly backup: Readonly<RolloutBackupReceipt> | null;
}

interface RolloutReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly commandDigest: string;
  readonly rolloutId: string;
  readonly attemptedGeneration: number;
  readonly recordedAtMs: number;
  readonly healthEventDigest: string | null;
  readonly sqlite: Readonly<RolloutSqliteReceipt>;
  readonly result: Readonly<LocalDeploymentComposeApplyResult>;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function commandDigest(
  command: Readonly<LocalDeploymentComposeApplyCommand>,
): string {
  return digest(JSON.stringify(command));
}

function composeArgs(
  paths: Readonly<LocalDeploymentPaths>,
  args: readonly string[],
): readonly string[] {
  return [
    'compose',
    '--project-directory',
    paths.service,
    '-f',
    path.join(paths.service, 'compose.yaml'),
    '-f',
    paths.composeSelection,
    ...args,
  ];
}

function docker(
  command: Readonly<LocalDeploymentComposeApplyCommand>,
  runDocker: LocalDeploymentDockerRunner,
  args: readonly string[],
  timeoutMs = 30_000,
): string {
  return runDocker({
    executable: command.options.dockerExecutable,
    socketPath: command.options.dockerSocketPath,
    args,
    timeoutMs,
  });
}

function applyActiveSelection(
  command: Readonly<LocalDeploymentComposeApplyCommand>,
  paths: Readonly<LocalDeploymentPaths>,
  runDocker: LocalDeploymentDockerRunner,
): void {
  docker(
    command,
    runDocker,
    composeArgs(paths, [
      'up',
      '--detach',
      '--force-recreate',
      '--no-build',
      '--pull',
      'never',
      '--remove-orphans',
      'qinglong3',
    ]),
    60_000,
  );
}

function stopFailedSelection(
  command: Readonly<LocalDeploymentComposeApplyCommand>,
  paths: Readonly<LocalDeploymentPaths>,
  runDocker: LocalDeploymentDockerRunner,
): void {
  docker(
    command,
    runDocker,
    composeArgs(paths, ['stop', '--timeout', '30', 'qinglong3']),
    45_000,
  );
}

function parseContainerIdentity(value: string): string | null {
  const containerId = value.trim();
  if (!CONTAINER_ID_PATTERN.test(containerId)) return null;
  return containerId;
}

function inspectRunningContainer(
  output: string,
  containerId: string,
  selection: Readonly<ComposeImageSelection>,
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return false;
  }
  const inspected = Array.isArray(value) ? value[0] : undefined;
  const candidate = inspected as
    | {
        readonly Id?: unknown;
        readonly State?: {
          readonly Running?: unknown;
          readonly Status?: unknown;
        };
        readonly Config?: {
          readonly Image?: unknown;
          readonly Labels?: Readonly<Record<string, unknown>>;
        };
        readonly HostConfig?: {
          readonly ReadonlyRootfs?: unknown;
          readonly NetworkMode?: unknown;
          readonly Privileged?: unknown;
        };
      }
    | undefined;
  return (
    (candidate?.Id === containerId ||
      (typeof candidate?.Id === 'string' &&
        candidate.Id.startsWith(containerId))) &&
    candidate?.State?.Running === true &&
    candidate.State.Status === 'running' &&
    candidate.Config?.Image === selection.image &&
    candidate.Config.Labels?.['io.qinglong.deployment.generation'] ===
      String(selection.generation) &&
    candidate.Config.Labels?.['io.qinglong.deployment.mutation'] ===
      selection.mutationId &&
    candidate.HostConfig?.ReadonlyRootfs === true &&
    candidate.HostConfig.NetworkMode === 'none' &&
    candidate.HostConfig.Privileged !== true
  );
}

function activeEventEvidence(
  logs: string,
  profile: LocalDeploymentProfile,
): Readonly<ActiveEvidence> | null {
  const lines = logs
    .split('\n')
    .filter((line) => line.length > 0)
    .slice(-256);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let value: unknown;
    try {
      value = JSON.parse(lines[index]!);
    } catch {
      continue;
    }
    const event = value as Readonly<Record<string, unknown>>;
    if (
      event.schemaVersion === 1 &&
      event.component === 'qinglong3-local-application' &&
      event.level === 'info' &&
      event.event === 'active' &&
      event.profile === profile &&
      event.aiStatus === 'deployment_excluded' &&
      typeof event.instanceId === 'string'
    ) {
      return Object.freeze({ digest: digest(JSON.stringify(event)) });
    }
  }
  return null;
}

async function observeActive(
  command: Readonly<LocalDeploymentComposeApplyCommand>,
  paths: Readonly<LocalDeploymentPaths>,
  selection: Readonly<ComposeImageSelection>,
  profile: LocalDeploymentProfile,
  dependencies: Required<
    Pick<LocalDeploymentComposeApplyDependencies, 'runDocker' | 'now' | 'wait'>
  >,
): Promise<Readonly<ActiveEvidence> | null> {
  const timeoutMs = profile === 'edge' ? 30_000 : 60_000;
  const deadline = dependencies.now() + timeoutMs;
  const maxAttempts = profile === 'edge' ? 120 : 240;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const containerId = parseContainerIdentity(
        docker(
          command,
          dependencies.runDocker,
          composeArgs(paths, ['ps', '--all', '--quiet', 'qinglong3']),
        ),
      );
      if (containerId) {
        const running = inspectRunningContainer(
          docker(command, dependencies.runDocker, [
            'container',
            'inspect',
            containerId,
          ]),
          containerId,
          selection,
        );
        if (running) {
          const evidence = activeEventEvidence(
            docker(command, dependencies.runDocker, [
              'container',
              'logs',
              '--tail',
              '256',
              containerId,
            ]),
            profile,
          );
          if (evidence) return evidence;
        }
      }
    } catch {
      // A starting or failed candidate is handled by the bounded observation
      // window and the generation-fenced rollback below.
    }
    if (dependencies.now() >= deadline) return null;
    await dependencies.wait(250);
  }
  return null;
}

function backupPathFor(
  paths: Readonly<LocalDeploymentPaths>,
  rolloutId: string,
): string {
  return path.join(paths.composeRolloutBackups, `${rolloutId}.sqlite`);
}

function backupOptions(
  command: Readonly<LocalDeploymentComposeApplyCommand>,
  paths: Readonly<LocalDeploymentPaths>,
  profile: LocalDeploymentProfile,
): Readonly<LocalSqliteRolloutBackupOptions> {
  return Object.freeze({
    databasePath: paths.database,
    backupPath: backupPathFor(paths, command.request.rolloutId),
    profile,
  });
}

function preflightBackupCatalog(
  paths: Readonly<LocalDeploymentPaths>,
  rolloutId: string,
): void {
  const finalName = `${rolloutId}.sqlite`;
  const stageName = `.${finalName}.ql3-backup-stage`;
  const entries = fs.readdirSync(paths.composeRolloutBackups, {
    withFileTypes: true,
  });
  let retained = 0;
  for (const entry of entries) {
    if (
      entry.isFile() &&
      UUID_V4_PATTERN.test(entry.name.replace(/\.sqlite$/, '')) &&
      entry.name.endsWith('.sqlite')
    ) {
      retained += 1;
      continue;
    }
    if (entry.isFile() && entry.name === stageName) continue;
    configurationError('compose rollout backup catalog contains drift');
  }
  if (
    retained > MAX_RETAINED_ROLLOUT_BACKUPS ||
    (retained === MAX_RETAINED_ROLLOUT_BACKUPS &&
      !entries.some((entry) => entry.name === finalName))
  ) {
    configurationError('compose rollout backup retention limit is reached');
  }
}

function backupReceipt(
  evidence: Readonly<LocalSqliteRolloutBackupEvidence> | null,
): Readonly<RolloutBackupReceipt> | null {
  if (evidence === null) return null;
  return Object.freeze({
    sha256: evidence.sha256,
    bytes: evidence.bytes,
    pageCount: evidence.pageCount,
    pageSize: evidence.pageSize,
  });
}

function sqliteReceipt(
  backup: Readonly<LocalSqliteRolloutBackupEvidence> | null,
  writeObservation: SqliteWriteObservation,
): Readonly<RolloutSqliteReceipt> {
  return Object.freeze({
    contractVersion: LOCAL_SQLITE_WRITE_CONTRACT_VERSION,
    writeContractVersion: LOCAL_SQLITE_WRITE_CONTRACT_VERSION,
    writeObservation,
    backup: backupReceipt(backup),
  });
}

async function applyAndObserveCandidate(
  command: Readonly<LocalDeploymentComposeApplyCommand>,
  paths: Readonly<LocalDeploymentPaths>,
  selection: Readonly<ComposeImageSelection>,
  profile: LocalDeploymentProfile,
  dependencies: Required<
    Pick<
      LocalDeploymentComposeApplyDependencies,
      'runDocker' | 'now' | 'wait' | 'openChangeObserver'
    >
  >,
): Promise<
  Readonly<{
    evidence: Readonly<ActiveEvidence> | null;
    writeObservation: SqliteWriteObservation;
  }>
> {
  const observer = dependencies.openChangeObserver({
    databasePath: paths.database,
    profile,
  });
  let evidence: Readonly<ActiveEvidence> | null = null;
  try {
    try {
      applyActiveSelection(command, paths, dependencies.runDocker);
      evidence = await observeActive(
        command,
        paths,
        selection,
        profile,
        dependencies,
      );
    } catch {
      evidence = null;
    }
    let writeObservation: SqliteWriteObservation;
    try {
      writeObservation = observer.changed() ? 'changed' : 'unchanged';
    } catch (error) {
      if (evidence) throw error;
      writeObservation = 'recovery_unknown';
    }
    return Object.freeze({ evidence, writeObservation });
  } finally {
    observer.close();
  }
}

function result(
  status: LocalDeploymentComposeApplyResult['status'],
  attemptedGeneration: number,
  activeGeneration: number | null,
  profile: LocalDeploymentProfile,
): Readonly<LocalDeploymentComposeApplyResult> {
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.compose.apply' as const,
    status,
    attemptedGeneration,
    activeGeneration,
    profile,
    health: Object.freeze({
      event:
        status === 'failed_stopped'
          ? ('unavailable' as const)
          : ('active' as const),
    }),
    service: Object.freeze({ kind: 'compose' as const }),
  });
}

function receiptContents(receipt: Readonly<RolloutReceipt>): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

async function readReceipt(
  filePath: string,
  uid: number,
  expectedCommandDigest: string,
  rolloutId: string,
  expectedGeneration: number,
  paths: Readonly<LocalDeploymentPaths>,
  inspectBackup: typeof inspectLocalSqliteRolloutBackup,
): Promise<Readonly<LocalDeploymentComposeApplyResult> | null> {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o600 ||
    (stat.nlink !== 1 && stat.nlink !== 2) ||
    stat.size < 2 ||
    stat.size > MAX_RECEIPT_BYTES
  ) {
    configurationError('compose rollout receipt identity is invalid');
  }
  const contents = fs.readFileSync(filePath, 'utf8');
  let receipt: RolloutReceipt;
  try {
    receipt = JSON.parse(contents) as RolloutReceipt;
  } catch (error) {
    configurationError('compose rollout receipt is invalid', error);
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    configurationError('compose rollout receipt shape is invalid');
  }
  const receiptKeys = Object.keys(receipt).sort();
  const resultKeys = Object.keys(receipt.result ?? {}).sort();
  const healthKeys = Object.keys(receipt.result?.health ?? {}).sort();
  const serviceKeys = Object.keys(receipt.result?.service ?? {}).sort();
  const sqliteKeys = Object.keys(receipt.sqlite ?? {}).sort();
  const backupKeys = Object.keys(receipt.sqlite?.backup ?? {}).sort();
  const expectedReceiptKeys = [
    'attemptedGeneration',
    'commandDigest',
    'healthEventDigest',
    'recordedAtMs',
    'result',
    'rolloutId',
    'schema',
    'sqlite',
  ].sort();
  const expectedResultKeys = [
    'activeGeneration',
    'attemptedGeneration',
    'health',
    'operation',
    'profile',
    'schemaVersion',
    'service',
    'status',
  ].sort();
  const expectedSqliteKeys = [
    'backup',
    'contractVersion',
    'writeContractVersion',
    'writeObservation',
  ].sort();
  const expectedBackupKeys = [
    'bytes',
    'pageCount',
    'pageSize',
    'sha256',
  ].sort();
  const validStatus =
    receipt.result?.status === 'active' ||
    receipt.result?.status === 'rolled_back' ||
    receipt.result?.status === 'failed_stopped';
  const expectedActiveGeneration =
    receipt.result?.status === 'active'
      ? expectedGeneration
      : receipt.result?.status === 'rolled_back'
      ? expectedGeneration + 1
      : null;
  const canonicalReceipt: RolloutReceipt = {
    schema: receipt.schema,
    commandDigest: receipt.commandDigest,
    rolloutId: receipt.rolloutId,
    attemptedGeneration: receipt.attemptedGeneration,
    recordedAtMs: receipt.recordedAtMs,
    healthEventDigest: receipt.healthEventDigest,
    sqlite: {
      contractVersion: receipt.sqlite?.contractVersion,
      writeContractVersion: receipt.sqlite?.writeContractVersion,
      writeObservation: receipt.sqlite?.writeObservation,
      backup:
        receipt.sqlite?.backup === null
          ? null
          : {
              sha256: receipt.sqlite?.backup?.sha256,
              bytes: receipt.sqlite?.backup?.bytes,
              pageCount: receipt.sqlite?.backup?.pageCount,
              pageSize: receipt.sqlite?.backup?.pageSize,
            },
    } as RolloutSqliteReceipt,
    result: {
      schemaVersion: receipt.result?.schemaVersion,
      operation: receipt.result?.operation,
      status: receipt.result?.status,
      attemptedGeneration: receipt.result?.attemptedGeneration,
      activeGeneration: receipt.result?.activeGeneration,
      profile: receipt.result?.profile,
      health: {
        event: receipt.result?.health?.event,
      },
      service: {
        kind: receipt.result?.service?.kind,
      },
    } as LocalDeploymentComposeApplyResult,
  };
  if (
    contents !== receiptContents(canonicalReceipt) ||
    receiptKeys.length !== expectedReceiptKeys.length ||
    receiptKeys.some((key, index) => key !== expectedReceiptKeys[index]) ||
    resultKeys.length !== expectedResultKeys.length ||
    resultKeys.some((key, index) => key !== expectedResultKeys[index]) ||
    healthKeys.length !== 1 ||
    healthKeys[0] !== 'event' ||
    serviceKeys.length !== 1 ||
    serviceKeys[0] !== 'kind' ||
    sqliteKeys.length !== expectedSqliteKeys.length ||
    sqliteKeys.some((key, index) => key !== expectedSqliteKeys[index]) ||
    (receipt.sqlite?.backup === null
      ? backupKeys.length !== 0
      : backupKeys.length !== expectedBackupKeys.length ||
        backupKeys.some((key, index) => key !== expectedBackupKeys[index])) ||
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.commandDigest !== expectedCommandDigest ||
    receipt.rolloutId !== rolloutId ||
    receipt.attemptedGeneration !== expectedGeneration ||
    !Number.isSafeInteger(receipt.recordedAtMs) ||
    receipt.recordedAtMs < 0 ||
    (receipt.healthEventDigest !== null &&
      (typeof receipt.healthEventDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(receipt.healthEventDigest))) ||
    receipt.sqlite?.contractVersion !== LOCAL_SQLITE_WRITE_CONTRACT_VERSION ||
    receipt.sqlite?.writeContractVersion !==
      LOCAL_SQLITE_WRITE_CONTRACT_VERSION ||
    (receipt.sqlite?.writeObservation !== 'unchanged' &&
      receipt.sqlite?.writeObservation !== 'changed' &&
      receipt.sqlite?.writeObservation !== 'recovery_unknown') ||
    (expectedGeneration === 1
      ? receipt.sqlite?.backup !== null
      : !receipt.sqlite?.backup) ||
    (receipt.sqlite?.backup !== null &&
      (typeof receipt.sqlite?.backup?.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(receipt.sqlite.backup.sha256) ||
        !Number.isSafeInteger(receipt.sqlite.backup.bytes) ||
        receipt.sqlite.backup.bytes < 1 ||
        !Number.isSafeInteger(receipt.sqlite.backup.pageCount) ||
        receipt.sqlite.backup.pageCount < 1 ||
        !Number.isSafeInteger(receipt.sqlite.backup.pageSize) ||
        receipt.sqlite.backup.pageSize < 512 ||
        receipt.sqlite.backup.pageSize > 65_536)) ||
    !receipt.result ||
    receipt.result.schemaVersion !== 1 ||
    receipt.result.operation !== 'local.deployment.compose.apply' ||
    !validStatus ||
    receipt.result.attemptedGeneration !== expectedGeneration ||
    receipt.result.activeGeneration !== expectedActiveGeneration ||
    (receipt.result.profile !== 'edge' &&
      receipt.result.profile !== 'standalone') ||
    receipt.result.health?.event !==
      (receipt.result.status === 'failed_stopped' ? 'unavailable' : 'active') ||
    receipt.result.service?.kind !== 'compose' ||
    (receipt.result.status === 'failed_stopped'
      ? receipt.healthEventDigest !== null
      : receipt.healthEventDigest === null)
  ) {
    configurationError('compose rollout receipt drifted');
  }
  if (receipt.sqlite.backup !== null) {
    const backupPath = backupPathFor(paths, rolloutId);
    if (fs.existsSync(backupPath)) {
      const inspected = await inspectBackup({
        databasePath: paths.database,
        backupPath,
        profile: receipt.result.profile,
      });
      if (
        inspected.contractVersion !== receipt.sqlite.contractVersion ||
        inspected.writeContractVersion !==
          receipt.sqlite.writeContractVersion ||
        inspected.sha256 !== receipt.sqlite.backup.sha256 ||
        inspected.bytes !== receipt.sqlite.backup.bytes ||
        inspected.pageCount !== receipt.sqlite.backup.pageCount ||
        inspected.pageSize !== receipt.sqlite.backup.pageSize
      ) {
        configurationError('compose rollout backup receipt drifted');
      }
    } else if (
      !inspectCollectedEvidence(
        paths,
        uid,
        LOCAL_SQLITE_WRITE_CONTRACT_VERSION,
        {
          kind: 'rollout-backup',
          artifactId: rolloutId,
          sourceReceiptDigest: evidenceDigest(contents),
          snapshot: {
            contractVersion: receipt.sqlite.contractVersion,
            sha256: receipt.sqlite.backup.sha256,
            bytes: receipt.sqlite.backup.bytes,
            pageCount: receipt.sqlite.backup.pageCount,
            pageSize: receipt.sqlite.backup.pageSize,
          },
        },
      )
    ) {
      configurationError('compose rollout backup is unavailable');
    }
  }
  publishExactFile(filePath, contents, 0o600, uid, 'compose rollout receipt');
  return Object.freeze({
    ...receipt.result,
    health: Object.freeze({ ...receipt.result.health }),
    service: Object.freeze({ ...receipt.result.service }),
  });
}

function releaseLock(lockPath: string, intent: string, uid: number): void {
  if (!fs.existsSync(lockPath)) return;
  preflightPublishedFile(lockPath, intent, 0o600, uid, 'compose rollout lock');
  fs.unlinkSync(lockPath);
  syncPublishedDirectory(path.dirname(lockPath));
}

function publishReceipt(
  filePath: string,
  command: Readonly<LocalDeploymentComposeApplyCommand>,
  rolloutResult: Readonly<LocalDeploymentComposeApplyResult>,
  evidence: Readonly<ActiveEvidence> | null,
  sqlite: Readonly<RolloutSqliteReceipt>,
  uid: number,
): void {
  publishExactFile(
    filePath,
    receiptContents({
      schema: RECEIPT_SCHEMA,
      commandDigest: commandDigest(command),
      rolloutId: command.request.rolloutId,
      attemptedGeneration: command.request.expectedGeneration,
      recordedAtMs: command.request.failureRollbackChangedAtMs,
      healthEventDigest: evidence?.digest ?? null,
      sqlite,
      result: rolloutResult,
    }),
    0o600,
    uid,
    'compose rollout receipt',
  );
}

function applyCommand(
  command: Readonly<LocalDeploymentComposeApplyCommand>,
  generation: number,
): Readonly<LocalDeploymentComposeApplyCommand> {
  return Object.freeze({
    ...command,
    request: Object.freeze({
      ...command.request,
      expectedGeneration: generation,
    }),
  });
}

export async function applyLocalDeploymentCompose(
  input: unknown,
  dependencies: LocalDeploymentComposeApplyDependencies = {},
): Promise<Readonly<LocalDeploymentComposeApplyResult>> {
  const command = normalizeLocalDeploymentComposeApplyCommand(input);
  const identity = currentIdentity();
  const paths = deploymentPaths(command.options.deploymentRoot);
  validatePrivateDirectory(
    command.options.deploymentRoot,
    identity.uid,
    'deploymentRoot',
  );
  validatePrivateDirectory(
    paths.service,
    identity.uid,
    'serviceDescriptorRoot',
  );
  validatePrivateDirectory(
    paths.composeRevisions,
    identity.uid,
    'composeRevisionRoot',
  );
  validatePrivateDirectory(
    paths.composeRollouts,
    identity.uid,
    'composeRolloutRoot',
  );
  validatePrivateDirectory(
    paths.composeRolloutBackups,
    identity.uid,
    'composeRolloutBackupRoot',
  );
  if (fs.existsSync(paths.composeEvidenceCollectionLock)) {
    configurationError('compose rollout is fenced by an evidence collection');
  }
  if (fs.existsSync(paths.composeRestoreLock)) {
    configurationError('compose rollout is fenced by an in-flight restore');
  }
  preflightBackupCatalog(paths, command.request.rolloutId);
  const validateSocket =
    dependencies.validateSocket ?? validateLocalDeploymentDockerSocket;
  validateSocket(command.options.dockerSocketPath, identity.uid);
  const runDocker = dependencies.runDocker ?? runLocalDeploymentDockerCommand;
  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const createBackup =
    dependencies.createBackup ?? createLocalSqliteRolloutBackup;
  const inspectBackup =
    dependencies.inspectBackup ?? inspectLocalSqliteRolloutBackup;
  const openChangeObserver =
    dependencies.openChangeObserver ?? openLocalSqliteChangeObserver;
  const receiptPath = path.join(
    paths.composeRollouts,
    `${command.request.rolloutId}.json`,
  );
  const intent = `${JSON.stringify(command, null, 2)}\n`;
  const replay = await readReceipt(
    receiptPath,
    identity.uid,
    commandDigest(command),
    command.request.rolloutId,
    command.request.expectedGeneration,
    paths,
    inspectBackup,
  );
  if (replay) {
    releaseLock(paths.composeRolloutLock, intent, identity.uid);
    return replay;
  }
  publishExactFile(
    paths.composeRolloutLock,
    intent,
    0o600,
    identity.uid,
    'compose rollout lock',
  );
  if (fs.existsSync(paths.composeEvidenceCollectionLock)) {
    releaseLock(paths.composeRolloutLock, intent, identity.uid);
    configurationError('compose rollout is fenced by an evidence collection');
  }

  let selection = inspectActiveComposeImageSelection(
    paths.composeSelection,
    paths.composeRevisions,
    identity.uid,
  );
  const attempted = inspectComposeImageSelectionGeneration(
    paths.composeRevisions,
    command.request.expectedGeneration,
    identity.uid,
  );
  if (
    selection.generation !== command.request.expectedGeneration &&
    !(
      selection.generation === command.request.expectedGeneration + 1 &&
      selection.previousGeneration === command.request.expectedGeneration &&
      selection.rollbackTargetGeneration === attempted.previousGeneration &&
      selection.mutationId === command.request.failureRollbackMutationId
    )
  ) {
    configurationError(
      'active compose generation does not match the rollout recovery state',
    );
  }

  let rolloutBackup: Readonly<LocalSqliteRolloutBackupEvidence> | null = null;
  let writeObservation: SqliteWriteObservation = 'recovery_unknown';
  if (selection.generation === command.request.expectedGeneration) {
    const preflight = await preflightLocalDeploymentCompose(
      {
        schemaVersion: 1,
        operation: 'local.deployment.compose.preflight',
        options: command.options,
        request: {
          expectedGeneration: command.request.expectedGeneration,
        },
      },
      { runDocker, validateSocket },
    );
    if (selection.previousGeneration >= 1) {
      rolloutBackup = await createBackup(
        backupOptions(command, paths, preflight.profile),
      );
    }
    const candidate = await applyAndObserveCandidate(
      command,
      paths,
      selection,
      preflight.profile,
      { runDocker, now, wait, openChangeObserver },
    );
    const evidence = candidate.evidence;
    writeObservation = candidate.writeObservation;
    if (evidence) {
      const active = result(
        'active',
        command.request.expectedGeneration,
        command.request.expectedGeneration,
        preflight.profile,
      );
      publishReceipt(
        receiptPath,
        command,
        active,
        evidence,
        sqliteReceipt(rolloutBackup, writeObservation),
        identity.uid,
      );
      releaseLock(paths.composeRolloutLock, intent, identity.uid);
      return active;
    }
    if (selection.previousGeneration < 1) {
      stopFailedSelection(command, paths, runDocker);
      const stopped = result(
        'failed_stopped',
        command.request.expectedGeneration,
        null,
        preflight.profile,
      );
      publishReceipt(
        receiptPath,
        command,
        stopped,
        null,
        sqliteReceipt(null, writeObservation),
        identity.uid,
      );
      releaseLock(paths.composeRolloutLock, intent, identity.uid);
      return stopped;
    }
    await switchLocalDeploymentComposeRevision(
      {
        schemaVersion: 1,
        operation: 'local.deployment.compose.rollback',
        options: {
          deploymentRoot: command.options.deploymentRoot,
          allowRootService: command.options.allowRootService,
        },
        request: {
          expectedGeneration: selection.generation,
          targetGeneration: selection.previousGeneration,
          mutationId: command.request.failureRollbackMutationId,
          changedAtMs: command.request.failureRollbackChangedAtMs,
        },
      },
      intent,
    );
    selection = inspectActiveComposeImageSelection(
      paths.composeSelection,
      paths.composeRevisions,
      identity.uid,
    );
  }

  const rollbackCommand = applyCommand(command, selection.generation);
  const rollbackPreflight = await preflightLocalDeploymentCompose(
    {
      schemaVersion: 1,
      operation: 'local.deployment.compose.preflight',
      options: command.options,
      request: { expectedGeneration: selection.generation },
    },
    { runDocker, validateSocket },
  );
  if (command.request.expectedGeneration > 1 && rolloutBackup === null) {
    rolloutBackup = await inspectBackup(
      backupOptions(command, paths, rollbackPreflight.profile),
    );
  }
  applyActiveSelection(rollbackCommand, paths, runDocker);
  const rollbackEvidence = await observeActive(
    rollbackCommand,
    paths,
    selection,
    rollbackPreflight.profile,
    { runDocker, now, wait },
  );
  if (!rollbackEvidence) {
    configurationError(
      'compose rollback did not produce active health evidence',
    );
  }
  const rolledBack = result(
    'rolled_back',
    command.request.expectedGeneration,
    selection.generation,
    rollbackPreflight.profile,
  );
  publishReceipt(
    receiptPath,
    command,
    rolledBack,
    rollbackEvidence,
    sqliteReceipt(rolloutBackup, writeObservation),
    identity.uid,
  );
  releaseLock(paths.composeRolloutLock, intent, identity.uid);
  return rolledBack;
}

export function applyLocalDeploymentComposeCommandFile(
  filePath: string,
): Promise<Readonly<LocalDeploymentComposeApplyResult>> {
  return applyLocalDeploymentCompose(readPrivateLocalCommandFile(filePath));
}
