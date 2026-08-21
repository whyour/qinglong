import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';
import {
  checkpointLocalSqliteForRestore,
  createLocalSqliteRolloutBackup,
  inspectLocalSqliteSnapshot,
  LOCAL_SQLITE_WRITE_CONTRACT_VERSION,
  restoreLocalSqliteSnapshot,
  type LocalSqliteRestoreEvidence,
  type LocalSqliteSnapshotEvidence,
} from '@qinglong/local-sqlite/rollout-safety';

import {
  evidenceDigest,
  inspectCollectedEvidence,
  type ComposeSnapshotEvidence,
} from './composeEvidence';
import {
  inspectActiveComposeImageSelection,
  inspectComposeImageSelectionGeneration,
} from './composeRevision';
import {
  currentIdentity,
  LocalDeploymentConfigurationError,
  normalizeLocalDeploymentComposeApplyCommand,
  normalizeLocalDeploymentComposeRestoreCommand,
  type LocalDeploymentComposeApplyCommand,
  type LocalDeploymentComposeRestoreCommand,
  type LocalDeploymentComposeRestorePrepareCommand,
  type LocalDeploymentComposeRestoreResult,
  type LocalDeploymentProfile,
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
  syncPublishedDirectory,
  validatePrivateDirectory,
} from '../foundation/files';
import {
  deploymentPaths,
  type LocalDeploymentPaths,
} from '../foundation/render';
import {
  assertLocalDeploymentComposeLineageReceipt,
  inspectLocalDeploymentComposeLineage,
  normalizeLocalDeploymentComposeLineageReceipt,
  type LocalDeploymentComposeLineage,
  type LocalDeploymentComposeLineageReceipt,
} from './composeLineage';

const PREPARE_SCHEMA = 'qinglong/local-compose-restore-prepare@v2';
const COMMIT_SCHEMA = 'qinglong/local-compose-restore-commit@v2';
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_RESTORE_SAFEGUARDS = 4;

interface RestorePrepareReceipt {
  readonly schema: typeof PREPARE_SCHEMA;
  readonly commandDigest: string;
  readonly failedApplyCommandDigest: string;
  readonly restoreId: string;
  readonly sourceRolloutId: string;
  readonly generation: number;
  readonly recordedAtMs: number;
  readonly profile: LocalDeploymentProfile;
  readonly lineage: Readonly<LocalDeploymentComposeLineageReceipt>;
  readonly current: Readonly<LocalSqliteSnapshotEvidence>;
  readonly source: Readonly<LocalSqliteSnapshotEvidence>;
  readonly safeguard: Readonly<LocalSqliteSnapshotEvidence>;
}

interface RestoreCommitReceipt {
  readonly schema: typeof COMMIT_SCHEMA;
  readonly commandDigest: string;
  readonly prepareReceiptDigest: string;
  readonly restoreId: string;
  readonly sourceRolloutId: string;
  readonly generation: number;
  readonly recordedAtMs: number;
  readonly profile: LocalDeploymentProfile;
  readonly lineage: Readonly<LocalDeploymentComposeLineageReceipt>;
  readonly source: Readonly<LocalSqliteSnapshotEvidence>;
  readonly safeguard: Readonly<LocalSqliteSnapshotEvidence>;
  readonly restored: Readonly<LocalSqliteSnapshotEvidence>;
}

interface RestoreState {
  readonly failedCommand: Readonly<LocalDeploymentComposeApplyCommand>;
  readonly failedIntent: string;
  readonly failedCommandDigest: string;
  readonly profile: LocalDeploymentProfile;
  readonly sourcePath: string;
  readonly source: Readonly<LocalSqliteSnapshotEvidence>;
}

export interface LocalDeploymentComposeRestoreDependencies {
  readonly runDocker?: LocalDeploymentDockerRunner;
  readonly validateSocket?: (socketPath: string, uid: number) => void;
  readonly checkpoint?: typeof checkpointLocalSqliteForRestore;
  readonly createSafeguard?: typeof createLocalSqliteRolloutBackup;
  readonly restoreSnapshot?: typeof restoreLocalSqliteSnapshot;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function digest(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function commandDigest(
  command: Readonly<LocalDeploymentComposeRestoreCommand>,
): string {
  return digest(JSON.stringify(command));
}

function failedCommandDigest(
  command: Readonly<LocalDeploymentComposeApplyCommand>,
): string {
  return digest(JSON.stringify(command));
}

function receiptContents(
  receipt: Readonly<RestorePrepareReceipt | RestoreCommitReceipt>,
): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function snapshotReceipt(
  evidence: Readonly<LocalSqliteSnapshotEvidence>,
): Readonly<LocalSqliteSnapshotEvidence> {
  return Object.freeze({
    contractVersion: evidence.contractVersion,
    sha256: evidence.sha256,
    bytes: evidence.bytes,
    pageCount: evidence.pageCount,
    pageSize: evidence.pageSize,
  });
}

function snapshotIsValid(value: unknown): value is LocalSqliteSnapshotEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<LocalSqliteSnapshotEvidence>;
  const keys = Object.keys(value).sort();
  const expected = [
    'bytes',
    'contractVersion',
    'pageCount',
    'pageSize',
    'sha256',
  ].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    candidate.contractVersion === LOCAL_SQLITE_WRITE_CONTRACT_VERSION &&
    typeof candidate.sha256 === 'string' &&
    SHA256_PATTERN.test(candidate.sha256) &&
    Number.isSafeInteger(candidate.bytes) &&
    (candidate.bytes as number) > 0 &&
    Number.isSafeInteger(candidate.pageCount) &&
    (candidate.pageCount as number) > 0 &&
    Number.isSafeInteger(candidate.pageSize) &&
    (candidate.pageSize as number) >= 512 &&
    (candidate.pageSize as number) <= 65_536
  );
}

function exactSnapshot(
  expected: Readonly<LocalSqliteSnapshotEvidence>,
  actual: Readonly<LocalSqliteSnapshotEvidence>,
  label: string,
): void {
  if (
    expected.contractVersion !== actual.contractVersion ||
    expected.sha256 !== actual.sha256 ||
    expected.bytes !== actual.bytes ||
    expected.pageCount !== actual.pageCount ||
    expected.pageSize !== actual.pageSize
  ) {
    configurationError(`${label} drifted`);
  }
}

function boundedReceipt(
  filePath: string,
  uid: number,
  label: string,
  allowedLinks: readonly number[] = [1],
): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    configurationError(`${label} is unavailable`, error);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o600 ||
    !allowedLinks.includes(stat.nlink) ||
    stat.size < 2 ||
    stat.size > MAX_RECEIPT_BYTES
  ) {
    configurationError(`${label} identity is invalid`);
  }
  return fs.readFileSync(filePath, 'utf8');
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
  command: Readonly<LocalDeploymentComposeRestoreCommand>,
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

function stopAndVerifyCompose(
  command: Readonly<LocalDeploymentComposeRestoreCommand>,
  paths: Readonly<LocalDeploymentPaths>,
  runDocker: LocalDeploymentDockerRunner,
): void {
  try {
    docker(
      command,
      runDocker,
      composeArgs(paths, ['stop', '--timeout', '30', 'qinglong3']),
      45_000,
    );
  } catch {
    // A lost Docker response is reconciled by the inspect-only observation
    // below. The restore ceremony never repeats `compose stop` blindly.
  }
  const containerId = docker(
    command,
    runDocker,
    composeArgs(paths, ['ps', '--all', '--quiet', 'qinglong3']),
  ).trim();
  if (containerId === '') return;
  if (!CONTAINER_ID_PATTERN.test(containerId)) {
    configurationError('compose restore container identity is invalid');
  }
  let inspected: unknown;
  try {
    inspected = JSON.parse(
      docker(command, runDocker, ['container', 'inspect', containerId]),
    );
  } catch (error) {
    configurationError('compose restore container inspection failed', error);
  }
  const container = Array.isArray(inspected) ? inspected[0] : undefined;
  if (
    !container ||
    typeof container !== 'object' ||
    (container as { readonly State?: { readonly Running?: unknown } }).State
      ?.Running !== false
  ) {
    configurationError('compose service did not stop for restore');
  }
}

function restoreResult(
  operation: LocalDeploymentComposeRestoreResult['operation'],
  status: LocalDeploymentComposeRestoreResult['status'],
  generation: number,
  profile: LocalDeploymentProfile,
  serviceState: LocalDeploymentComposeRestoreResult['service']['state'] = 'stopped',
  sqliteSource: LocalDeploymentComposeRestoreResult['sqlite']['source'] = 'ready',
  sqliteSafeguard: LocalDeploymentComposeRestoreResult['sqlite']['safeguard'] = 'ready',
): Readonly<LocalDeploymentComposeRestoreResult> {
  return Object.freeze({
    schemaVersion: 1 as const,
    operation,
    status,
    generation,
    profile,
    sqlite: Object.freeze({
      source: sqliteSource,
      safeguard: sqliteSafeguard,
    }),
    service: Object.freeze({
      kind: 'compose' as const,
      state: serviceState,
    }),
  });
}

function safeguardPath(
  paths: Readonly<LocalDeploymentPaths>,
  restoreId: string,
): string {
  return path.join(paths.composeRestoreSafeguards, `${restoreId}.sqlite`);
}

function prepareReceiptPath(
  paths: Readonly<LocalDeploymentPaths>,
  restoreId: string,
): string {
  return path.join(paths.composeRestores, `${restoreId}.prepare.json`);
}

function commitReceiptPath(
  paths: Readonly<LocalDeploymentPaths>,
  restoreId: string,
): string {
  return path.join(paths.composeRestores, `${restoreId}.commit.json`);
}

function preflightRestoreCatalog(
  paths: Readonly<LocalDeploymentPaths>,
  restoreId: string,
): void {
  const safeguardName = `${restoreId}.sqlite`;
  const safeguardStage = `.${safeguardName}.ql3-backup-stage`;
  const safeguards = fs.readdirSync(paths.composeRestoreSafeguards, {
    withFileTypes: true,
  });
  let retained = 0;
  for (const entry of safeguards) {
    if (
      entry.isFile() &&
      entry.name.endsWith('.sqlite') &&
      UUID_V4_PATTERN.test(entry.name.slice(0, -'.sqlite'.length))
    ) {
      retained += 1;
      continue;
    }
    if (entry.isFile() && entry.name === safeguardStage) continue;
    configurationError('compose restore safeguard catalog contains drift');
  }
  if (
    retained > MAX_RESTORE_SAFEGUARDS ||
    (retained === MAX_RESTORE_SAFEGUARDS &&
      !safeguards.some((entry) => entry.name === safeguardName))
  ) {
    configurationError('compose restore safeguard retention limit is reached');
  }
  const allowed = new Set([
    `${restoreId}.prepare.json`,
    `${restoreId}.commit.json`,
    `${restoreId}.replaced.sqlite`,
    `.${restoreId}.prepare.json.ql3-deploy-stage`,
    `.${restoreId}.commit.json.ql3-deploy-stage`,
  ]);
  for (const entry of fs.readdirSync(paths.composeRestores, {
    withFileTypes: true,
  })) {
    const receiptMatch = /^([0-9a-f-]+)\.(prepare|commit)\.json$/.exec(
      entry.name,
    );
    if (
      entry.isFile() &&
      ((receiptMatch !== null && UUID_V4_PATTERN.test(receiptMatch[1] ?? '')) ||
        allowed.has(entry.name))
    ) {
      continue;
    }
    configurationError('compose restore receipt catalog contains drift');
  }
}

async function readRestoreState(
  command: Readonly<LocalDeploymentComposeRestorePrepareCommand>,
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
  lineage: Readonly<LocalDeploymentComposeLineage>,
): Promise<Readonly<RestoreState>> {
  const failedIntent = boundedReceipt(
    paths.composeRolloutLock,
    uid,
    'compose rollout lock',
    [1, 2],
  );
  let value: unknown;
  try {
    value = JSON.parse(failedIntent);
  } catch (error) {
    configurationError('compose rollout lock is invalid', error);
  }
  const failedCommand = normalizeLocalDeploymentComposeApplyCommand(value);
  const canonicalIntent = `${JSON.stringify(failedCommand, null, 2)}\n`;
  preflightPublishedFile(
    paths.composeRolloutLock,
    canonicalIntent,
    0o600,
    uid,
    'compose rollout lock',
  );
  if (
    failedIntent !== canonicalIntent ||
    failedCommand.options.deploymentRoot !== command.options.deploymentRoot ||
    failedCommand.options.dockerExecutable !==
      command.options.dockerExecutable ||
    failedCommand.options.dockerSocketPath !==
      command.options.dockerSocketPath ||
    failedCommand.options.allowRootService !==
      command.options.allowRootService ||
    failedCommand.request.rolloutId !== command.request.sourceRolloutId
  ) {
    configurationError('compose restore does not match the failed rollout');
  }
  const selection = inspectActiveComposeImageSelection(
    paths.composeSelection,
    paths.composeRevisions,
    uid,
  );
  const attempted = inspectComposeImageSelectionGeneration(
    paths.composeRevisions,
    failedCommand.request.expectedGeneration,
    uid,
  );
  if (
    selection.generation !== command.request.expectedGeneration ||
    selection.generation !== failedCommand.request.expectedGeneration + 1 ||
    selection.previousGeneration !== failedCommand.request.expectedGeneration ||
    selection.rollbackTargetGeneration !== attempted.previousGeneration ||
    selection.mutationId !== failedCommand.request.failureRollbackMutationId ||
    fs.existsSync(
      path.join(
        paths.composeRollouts,
        `${failedCommand.request.rolloutId}.json`,
      ),
    )
  ) {
    configurationError('compose restore recovery generation drifted');
  }
  const profile = lineage.profile;
  const sourcePath = path.join(
    paths.composeRolloutBackups,
    `${command.request.sourceRolloutId}.sqlite`,
  );
  const source = await inspectLocalSqliteSnapshot({
    databasePath: sourcePath,
    profile,
  });
  return Object.freeze({
    failedCommand,
    failedIntent,
    failedCommandDigest: failedCommandDigest(failedCommand),
    profile,
    sourcePath,
    source,
  });
}

async function inspectPrepareReceipt(
  filePath: string,
  uid: number,
  expectedCommandDigest: string,
  command: Readonly<LocalDeploymentComposeRestorePrepareCommand>,
  paths: Readonly<LocalDeploymentPaths>,
  expectedLineage: Readonly<LocalDeploymentComposeLineage>,
): Promise<Readonly<RestorePrepareReceipt> | null> {
  if (!fs.existsSync(filePath)) return null;
  const contents = boundedReceipt(
    filePath,
    uid,
    'compose restore prepare receipt',
    [1, 2],
  );
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    configurationError('compose restore prepare receipt is invalid', error);
  }
  const receipt = value as RestorePrepareReceipt;
  const lineage = normalizeLocalDeploymentComposeLineageReceipt(
    receipt.lineage,
  );
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    Object.keys(receipt).sort().join(',') !==
      [
        'commandDigest',
        'current',
        'failedApplyCommandDigest',
        'generation',
        'lineage',
        'profile',
        'recordedAtMs',
        'restoreId',
        'safeguard',
        'schema',
        'source',
        'sourceRolloutId',
      ]
        .sort()
        .join(',') ||
    receipt.schema !== PREPARE_SCHEMA ||
    receipt.commandDigest !== expectedCommandDigest ||
    !SHA256_PATTERN.test(receipt.failedApplyCommandDigest) ||
    receipt.restoreId !== command.request.restoreId ||
    receipt.sourceRolloutId !== command.request.sourceRolloutId ||
    receipt.generation !== command.request.expectedGeneration ||
    receipt.recordedAtMs !== command.request.preparedAtMs ||
    (receipt.profile !== 'edge' && receipt.profile !== 'standalone') ||
    !snapshotIsValid(receipt.current) ||
    !snapshotIsValid(receipt.source) ||
    !snapshotIsValid(receipt.safeguard) ||
    receipt.current.sha256 === receipt.source.sha256 ||
    JSON.stringify(receipt.lineage) !== JSON.stringify(lineage) ||
    contents !== receiptContents(receipt)
  ) {
    configurationError('compose restore prepare receipt drifted');
  }
  assertLocalDeploymentComposeLineageReceipt(lineage, expectedLineage.receipt);
  const source = await inspectLocalSqliteSnapshot({
    databasePath: path.join(
      paths.composeRolloutBackups,
      `${receipt.sourceRolloutId}.sqlite`,
    ),
    profile: receipt.profile,
  });
  const safeguard = await inspectLocalSqliteSnapshot({
    databasePath: safeguardPath(paths, receipt.restoreId),
    profile: receipt.profile,
  });
  exactSnapshot(receipt.source, source, 'compose restore source snapshot');
  exactSnapshot(
    receipt.safeguard,
    safeguard,
    'compose restore safeguard snapshot',
  );
  publishExactFile(
    filePath,
    contents,
    0o600,
    uid,
    'compose restore prepare receipt',
  );
  return Object.freeze(receipt);
}

function inspectCommitReceipt(
  filePath: string,
  uid: number,
  expectedCommandDigest: string,
  command: Readonly<LocalDeploymentComposeRestoreCommand>,
  expectedLineage: Readonly<LocalDeploymentComposeLineage>,
): Readonly<RestoreCommitReceipt> | null {
  if (!fs.existsSync(filePath)) return null;
  const contents = boundedReceipt(
    filePath,
    uid,
    'compose restore commit receipt',
    [1, 2],
  );
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    configurationError('compose restore commit receipt is invalid', error);
  }
  const receipt = value as RestoreCommitReceipt;
  const lineage = normalizeLocalDeploymentComposeLineageReceipt(
    receipt.lineage,
  );
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    Object.keys(receipt).sort().join(',') !==
      [
        'commandDigest',
        'generation',
        'lineage',
        'prepareReceiptDigest',
        'profile',
        'recordedAtMs',
        'restoreId',
        'restored',
        'safeguard',
        'schema',
        'source',
        'sourceRolloutId',
      ]
        .sort()
        .join(',') ||
    receipt.schema !== COMMIT_SCHEMA ||
    receipt.commandDigest !== expectedCommandDigest ||
    !SHA256_PATTERN.test(receipt.prepareReceiptDigest) ||
    receipt.restoreId !== command.request.restoreId ||
    receipt.generation !== command.request.expectedGeneration ||
    receipt.recordedAtMs !==
      (command.operation === 'local.deployment.compose.restore.commit'
        ? command.request.committedAtMs
        : -1) ||
    (receipt.profile !== 'edge' && receipt.profile !== 'standalone') ||
    !UUID_V4_PATTERN.test(receipt.sourceRolloutId) ||
    !snapshotIsValid(receipt.source) ||
    !snapshotIsValid(receipt.safeguard) ||
    !snapshotIsValid(receipt.restored) ||
    receipt.source.sha256 !== receipt.restored.sha256 ||
    JSON.stringify(receipt.lineage) !== JSON.stringify(lineage) ||
    contents !== receiptContents(receipt)
  ) {
    configurationError('compose restore commit receipt drifted');
  }
  assertLocalDeploymentComposeLineageReceipt(lineage, expectedLineage.receipt);
  publishExactFile(
    filePath,
    contents,
    0o600,
    uid,
    'compose restore commit receipt',
  );
  return Object.freeze(receipt);
}

function releaseRestoreLock(
  paths: Readonly<LocalDeploymentPaths>,
  prepareIntent: string,
  uid: number,
): void {
  if (!fs.existsSync(paths.composeRestoreLock)) return;
  preflightPublishedFile(
    paths.composeRestoreLock,
    prepareIntent,
    0o600,
    uid,
    'compose restore lock',
  );
  fs.unlinkSync(paths.composeRestoreLock);
  syncPublishedDirectory(path.dirname(paths.composeRestoreLock));
}

async function prepareRestore(
  command: Readonly<LocalDeploymentComposeRestorePrepareCommand>,
  paths: Readonly<LocalDeploymentPaths>,
  dependencies: LocalDeploymentComposeRestoreDependencies,
  lineage: Readonly<LocalDeploymentComposeLineage>,
): Promise<Readonly<LocalDeploymentComposeRestoreResult>> {
  const identity = currentIdentity();
  if (fs.existsSync(commitReceiptPath(paths, command.request.restoreId))) {
    configurationError('compose restore transaction is already committed');
  }
  const validateSocket =
    dependencies.validateSocket ?? validateLocalDeploymentDockerSocket;
  validateSocket(command.options.dockerSocketPath, identity.uid);
  const runDocker = dependencies.runDocker ?? runLocalDeploymentDockerCommand;
  const state = await readRestoreState(command, paths, identity.uid, lineage);
  const intent = `${JSON.stringify(command, null, 2)}\n`;
  publishExactFile(
    paths.composeRestoreLock,
    intent,
    0o600,
    identity.uid,
    'compose restore lock',
  );
  if (fs.existsSync(paths.composeEvidenceCollectionLock)) {
    releaseRestoreLock(paths, intent, identity.uid);
    configurationError('compose restore is fenced by an evidence collection');
  }
  stopAndVerifyCompose(command, paths, runDocker);
  const receiptPath = prepareReceiptPath(paths, command.request.restoreId);
  const replay = await inspectPrepareReceipt(
    receiptPath,
    identity.uid,
    commandDigest(command),
    command,
    paths,
    lineage,
  );
  if (replay) {
    const current = await inspectLocalSqliteSnapshot({
      databasePath: lineage.databasePath,
      profile: replay.profile,
    });
    exactSnapshot(replay.current, current, 'compose restore current database');
    return restoreResult(
      command.operation,
      'existing',
      command.request.expectedGeneration,
      replay.profile,
    );
  }
  const checkpoint = dependencies.checkpoint ?? checkpointLocalSqliteForRestore;
  const current = await checkpoint({
    databasePath: lineage.databasePath,
    profile: state.profile,
  });
  if (current.sha256 === state.source.sha256) {
    configurationError(
      'compose restore source already matches current database',
    );
  }
  const createSafeguard =
    dependencies.createSafeguard ?? createLocalSqliteRolloutBackup;
  const safeguard = await createSafeguard({
    databasePath: lineage.databasePath,
    backupPath: safeguardPath(paths, command.request.restoreId),
    profile: state.profile,
  });
  const receipt: RestorePrepareReceipt = Object.freeze({
    schema: PREPARE_SCHEMA,
    commandDigest: commandDigest(command),
    failedApplyCommandDigest: state.failedCommandDigest,
    restoreId: command.request.restoreId,
    sourceRolloutId: command.request.sourceRolloutId,
    generation: command.request.expectedGeneration,
    recordedAtMs: command.request.preparedAtMs,
    profile: state.profile,
    lineage: lineage.receipt,
    current: snapshotReceipt(current),
    source: snapshotReceipt(state.source),
    safeguard: snapshotReceipt(safeguard),
  });
  publishExactFile(
    receiptPath,
    receiptContents(receipt),
    0o600,
    identity.uid,
    'compose restore prepare receipt',
  );
  return restoreResult(
    command.operation,
    'prepared',
    command.request.expectedGeneration,
    state.profile,
  );
}

async function commitRestore(
  command: Readonly<LocalDeploymentComposeRestoreCommand>,
  paths: Readonly<LocalDeploymentPaths>,
  dependencies: LocalDeploymentComposeRestoreDependencies,
  lineage: Readonly<LocalDeploymentComposeLineage>,
): Promise<Readonly<LocalDeploymentComposeRestoreResult>> {
  if (command.operation !== 'local.deployment.compose.restore.commit') {
    configurationError('compose restore commit command is invalid');
  }
  const identity = currentIdentity();
  const commitPath = commitReceiptPath(paths, command.request.restoreId);
  const replay = inspectCommitReceipt(
    commitPath,
    identity.uid,
    commandDigest(command),
    command,
    lineage,
  );
  if (replay) {
    const sourcePath = path.join(
      paths.composeRolloutBackups,
      `${replay.sourceRolloutId}.sqlite`,
    );
    const sourceReceiptContents = boundedReceipt(
      path.join(paths.composeRollouts, `${replay.sourceRolloutId}.json`),
      identity.uid,
      'compose rollout receipt',
      [1, 2],
    );
    let sourceState: 'ready' | 'collected';
    if (fs.existsSync(sourcePath)) {
      const source = await inspectLocalSqliteSnapshot({
        databasePath: sourcePath,
        profile: replay.profile,
      });
      exactSnapshot(replay.source, source, 'compose restore source snapshot');
      sourceState = 'ready';
    } else if (
      inspectCollectedEvidence(
        paths,
        identity.uid,
        LOCAL_SQLITE_WRITE_CONTRACT_VERSION,
        {
          kind: 'rollout-backup',
          artifactId: replay.sourceRolloutId,
          sourceReceiptDigest: evidenceDigest(sourceReceiptContents),
          snapshot: replay.source as ComposeSnapshotEvidence,
        },
      )
    ) {
      sourceState = 'collected';
    } else {
      configurationError('compose restore source snapshot is unavailable');
    }
    const safeguard = safeguardPath(paths, replay.restoreId);
    let safeguardState: 'ready' | 'collected';
    if (fs.existsSync(safeguard)) {
      const inspected = await inspectLocalSqliteSnapshot({
        databasePath: safeguard,
        profile: replay.profile,
      });
      exactSnapshot(
        replay.safeguard,
        inspected,
        'compose restore safeguard snapshot',
      );
      safeguardState = 'ready';
    } else if (
      inspectCollectedEvidence(
        paths,
        identity.uid,
        LOCAL_SQLITE_WRITE_CONTRACT_VERSION,
        {
          kind: 'restore-safeguard',
          artifactId: replay.restoreId,
          sourceReceiptDigest: evidenceDigest(
            boundedReceipt(
              commitPath,
              identity.uid,
              'compose restore commit receipt',
              [1, 2],
            ),
          ),
          snapshot: replay.safeguard as ComposeSnapshotEvidence,
        },
      )
    ) {
      safeguardState = 'collected';
    } else {
      configurationError('compose restore safeguard snapshot is unavailable');
    }
    if (fs.existsSync(paths.composeRestoreLock)) {
      const prepareIntent = boundedReceipt(
        paths.composeRestoreLock,
        identity.uid,
        'compose restore lock',
        [1, 2],
      );
      let prepareValue: unknown;
      try {
        prepareValue = JSON.parse(prepareIntent);
      } catch (error) {
        configurationError('compose restore lock is invalid', error);
      }
      const prepareCommand =
        normalizeLocalDeploymentComposeRestoreCommand(prepareValue);
      if (
        prepareCommand.operation !==
          'local.deployment.compose.restore.prepare' ||
        prepareCommand.options.deploymentRoot !==
          command.options.deploymentRoot ||
        prepareCommand.options.dockerExecutable !==
          command.options.dockerExecutable ||
        prepareCommand.options.dockerSocketPath !==
          command.options.dockerSocketPath ||
        prepareCommand.options.allowRootService !==
          command.options.allowRootService ||
        prepareCommand.request.restoreId !== command.request.restoreId ||
        prepareCommand.request.sourceRolloutId !== replay.sourceRolloutId ||
        prepareCommand.request.expectedGeneration !==
          command.request.expectedGeneration ||
        command.request.committedAtMs < prepareCommand.request.preparedAtMs
      ) {
        configurationError(
          'compose restore commit receipt does not match restore lock',
        );
      }
      releaseRestoreLock(
        paths,
        `${JSON.stringify(prepareCommand, null, 2)}\n`,
        identity.uid,
      );
    }
    return restoreResult(
      command.operation,
      'existing',
      command.request.expectedGeneration,
      replay.profile,
      'unchanged',
      sourceState,
      safeguardState,
    );
  }
  const prepareIntent = boundedReceipt(
    paths.composeRestoreLock,
    identity.uid,
    'compose restore lock',
    [1, 2],
  );
  let prepareValue: unknown;
  try {
    prepareValue = JSON.parse(prepareIntent);
  } catch (error) {
    configurationError('compose restore lock is invalid', error);
  }
  const prepareCommand =
    normalizeLocalDeploymentComposeRestoreCommand(prepareValue);
  if (
    prepareCommand.operation !== 'local.deployment.compose.restore.prepare' ||
    prepareCommand.options.deploymentRoot !== command.options.deploymentRoot ||
    prepareCommand.options.dockerExecutable !==
      command.options.dockerExecutable ||
    prepareCommand.options.dockerSocketPath !==
      command.options.dockerSocketPath ||
    prepareCommand.options.allowRootService !==
      command.options.allowRootService ||
    prepareCommand.request.restoreId !== command.request.restoreId ||
    prepareCommand.request.expectedGeneration !==
      command.request.expectedGeneration ||
    command.request.committedAtMs < prepareCommand.request.preparedAtMs
  ) {
    configurationError('compose restore commit does not match prepare');
  }
  preflightPublishedFile(
    paths.composeRestoreLock,
    `${JSON.stringify(prepareCommand, null, 2)}\n`,
    0o600,
    identity.uid,
    'compose restore lock',
  );
  const preparePath = prepareReceiptPath(paths, command.request.restoreId);
  const prepareReceipt = await inspectPrepareReceipt(
    preparePath,
    identity.uid,
    commandDigest(prepareCommand),
    prepareCommand,
    paths,
    lineage,
  );
  if (!prepareReceipt) {
    configurationError('compose restore prepare receipt is unavailable');
  }
  const state = await readRestoreState(
    prepareCommand,
    paths,
    identity.uid,
    lineage,
  );
  if (
    state.failedCommandDigest !== prepareReceipt.failedApplyCommandDigest ||
    state.source.sha256 !== prepareReceipt.source.sha256
  ) {
    configurationError('compose restore failed rollout binding drifted');
  }
  const validateSocket =
    dependencies.validateSocket ?? validateLocalDeploymentDockerSocket;
  validateSocket(command.options.dockerSocketPath, identity.uid);
  const runDocker = dependencies.runDocker ?? runLocalDeploymentDockerCommand;
  stopAndVerifyCompose(command, paths, runDocker);
  if (fs.existsSync(lineage.databasePath)) {
    const checkpoint =
      dependencies.checkpoint ?? checkpointLocalSqliteForRestore;
    const current = await checkpoint({
      databasePath: lineage.databasePath,
      profile: prepareReceipt.profile,
    });
    if (
      current.sha256 !== prepareReceipt.current.sha256 &&
      current.sha256 !== prepareReceipt.source.sha256
    ) {
      configurationError(
        'compose restore current database changed after prepare',
      );
    }
  }
  const restoreSnapshot =
    dependencies.restoreSnapshot ?? restoreLocalSqliteSnapshot;
  const restored: Readonly<LocalSqliteRestoreEvidence> = await restoreSnapshot({
    databasePath: lineage.databasePath,
    profile: prepareReceipt.profile,
    preserveDatabaseIdentity: lineage.mode === 'adopted',
    sourceSnapshotPath: state.sourcePath,
    restoreStagePath: path.join(
      path.dirname(lineage.databasePath),
      `.${path.basename(lineage.databasePath)}.${
        command.request.restoreId
      }.restore-stage`,
    ),
    replacedDatabasePath: path.join(
      paths.composeRestores,
      `${command.request.restoreId}.replaced.sqlite`,
    ),
    expectedCurrentSha256: prepareReceipt.current.sha256,
    expectedSourceSha256: prepareReceipt.source.sha256,
  });
  const commitReceipt: RestoreCommitReceipt = Object.freeze({
    schema: COMMIT_SCHEMA,
    commandDigest: commandDigest(command),
    prepareReceiptDigest: digest(
      boundedReceipt(
        preparePath,
        identity.uid,
        'compose restore prepare receipt',
      ),
    ),
    restoreId: command.request.restoreId,
    sourceRolloutId: prepareReceipt.sourceRolloutId,
    generation: command.request.expectedGeneration,
    recordedAtMs: command.request.committedAtMs,
    profile: prepareReceipt.profile,
    lineage: lineage.receipt,
    source: prepareReceipt.source,
    safeguard: prepareReceipt.safeguard,
    restored: snapshotReceipt(restored),
  });
  publishExactFile(
    commitPath,
    receiptContents(commitReceipt),
    0o600,
    identity.uid,
    'compose restore commit receipt',
  );
  releaseRestoreLock(paths, prepareIntent, identity.uid);
  return restoreResult(
    command.operation,
    restored.status,
    command.request.expectedGeneration,
    prepareReceipt.profile,
  );
}

export async function restoreLocalDeploymentCompose(
  input: unknown,
  dependencies: LocalDeploymentComposeRestoreDependencies = {},
): Promise<Readonly<LocalDeploymentComposeRestoreResult>> {
  const command = normalizeLocalDeploymentComposeRestoreCommand(input);
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
  ensurePrivateDirectory(
    paths.composeRestores,
    identity.uid,
    'composeRestoreRoot',
  );
  ensurePrivateDirectory(
    paths.composeRestoreSafeguards,
    identity.uid,
    'composeRestoreSafeguardRoot',
  );
  const lineage = inspectLocalDeploymentComposeLineage(
    command.options.deploymentRoot,
    identity.uid,
    identity.gid,
    command.options.allowRootService,
  );
  if (fs.existsSync(paths.composeEvidenceCollectionLock)) {
    configurationError('compose restore is fenced by an evidence collection');
  }
  preflightRestoreCatalog(paths, command.request.restoreId);
  return command.operation === 'local.deployment.compose.restore.prepare'
    ? prepareRestore(command, paths, dependencies, lineage)
    : commitRestore(command, paths, dependencies, lineage);
}

export function restoreLocalDeploymentComposeCommandFile(
  filePath: string,
): Promise<Readonly<LocalDeploymentComposeRestoreResult>> {
  return restoreLocalDeploymentCompose(readPrivateLocalCommandFile(filePath));
}

export function restoreLocalDeploymentComposePrepareCommandFile(
  filePath: string,
): Promise<Readonly<LocalDeploymentComposeRestoreResult>> {
  const command = normalizeLocalDeploymentComposeRestoreCommand(
    readPrivateLocalCommandFile(filePath),
  );
  if (command.operation !== 'local.deployment.compose.restore.prepare') {
    configurationError('compose restore prepare command is required');
  }
  return restoreLocalDeploymentCompose(command);
}

export function restoreLocalDeploymentComposeCommitCommandFile(
  filePath: string,
): Promise<Readonly<LocalDeploymentComposeRestoreResult>> {
  const command = normalizeLocalDeploymentComposeRestoreCommand(
    readPrivateLocalCommandFile(filePath),
  );
  if (command.operation !== 'local.deployment.compose.restore.commit') {
    configurationError('compose restore commit command is required');
  }
  return restoreLocalDeploymentCompose(command);
}
