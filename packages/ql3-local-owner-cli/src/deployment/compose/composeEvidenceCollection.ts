import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';
import {
  inspectLocalSqliteSnapshot,
  LOCAL_SQLITE_WRITE_CONTRACT_VERSION,
  type LocalSqliteSnapshotEvidence,
} from '@qinglong/local-sqlite/rollout-safety';

import {
  collectedEvidencePath,
  evidenceDigest,
  evidenceStagePath,
  inspectCollectedEvidence,
  publishCollectedEvidence,
  type ComposeEvidenceKind,
  type ComposeSnapshotEvidence,
} from './composeEvidence';
import { inspectActiveComposeImageSelection } from './composeRevision';
import {
  currentIdentity,
  LocalDeploymentConfigurationError,
  normalizeLocalDeploymentComposeEvidenceCollectionCommand,
  type LocalDeploymentComposeEvidenceCollectionCommand,
  type LocalDeploymentComposeEvidenceCollectionPrepareCommand,
  type LocalDeploymentComposeEvidenceCollectionResult,
  type LocalDeploymentProfile,
} from '../foundation/contract';
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
import {
  assertLocalDeploymentComposeLineageReceipt,
  inspectLocalDeploymentComposeLineage,
  normalizeLocalDeploymentComposeLineageReceipt,
  type LocalDeploymentComposeLineage,
  type LocalDeploymentComposeLineageReceipt,
} from './composeLineage';

const PREPARE_SCHEMA = 'qinglong/local-compose-evidence-collection-prepare@v2';
const COMMIT_SCHEMA = 'qinglong/local-compose-evidence-collection-commit@v2';
const ROLLOUT_RECEIPT_SCHEMA = 'qinglong/local-compose-rollout-receipt@v3';
const RESTORE_COMMIT_SCHEMA = 'qinglong/local-compose-restore-commit@v2';
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_RECEIPT_BYTES = 64 * 1024;

interface CollectionItem {
  readonly kind: ComposeEvidenceKind;
  readonly artifactId: string;
  readonly recordedAtMs: number;
  readonly sourceReceiptDigest: string;
  readonly snapshot: Readonly<ComposeSnapshotEvidence>;
}

interface CollectionPrepareReceipt {
  readonly schema: typeof PREPARE_SCHEMA;
  readonly commandDigest: string;
  readonly collectionId: string;
  readonly generation: number;
  readonly profile: LocalDeploymentProfile;
  readonly lineage: Readonly<LocalDeploymentComposeLineageReceipt>;
  readonly recordedAtMs: number;
  readonly items: readonly Readonly<CollectionItem>[];
}

interface CollectionCommitReceipt {
  readonly schema: typeof COMMIT_SCHEMA;
  readonly commandDigest: string;
  readonly prepareReceiptDigest: string;
  readonly collectionId: string;
  readonly generation: number;
  readonly profile: LocalDeploymentProfile;
  readonly lineage: Readonly<LocalDeploymentComposeLineageReceipt>;
  readonly recordedAtMs: number;
  readonly items: readonly Readonly<CollectionItem>[];
  readonly bytes: number;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function commandDigest(
  command: Readonly<LocalDeploymentComposeEvidenceCollectionCommand>,
): string {
  return evidenceDigest(JSON.stringify(command));
}

function boundedPrivateFile(
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

function readJson(contents: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    configurationError(`${label} is invalid`, error);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    configurationError(`${label} shape is invalid`);
  }
  return value as Record<string, unknown>;
}

function snapshot(value: unknown, label: string): ComposeSnapshotEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    configurationError(`${label} shape is invalid`);
  }
  const candidate = value as Partial<ComposeSnapshotEvidence>;
  if (
    Object.keys(value).sort().join(',') !==
      ['bytes', 'contractVersion', 'pageCount', 'pageSize', 'sha256']
        .sort()
        .join(',') ||
    candidate.contractVersion !== LOCAL_SQLITE_WRITE_CONTRACT_VERSION ||
    typeof candidate.sha256 !== 'string' ||
    !SHA256_PATTERN.test(candidate.sha256) ||
    !Number.isSafeInteger(candidate.bytes) ||
    (candidate.bytes as number) < 1 ||
    !Number.isSafeInteger(candidate.pageCount) ||
    (candidate.pageCount as number) < 1 ||
    !Number.isSafeInteger(candidate.pageSize) ||
    (candidate.pageSize as number) < 512 ||
    (candidate.pageSize as number) > 65_536
  ) {
    configurationError(`${label} is invalid`);
  }
  return Object.freeze({
    contractVersion: candidate.contractVersion,
    sha256: candidate.sha256,
    bytes: candidate.bytes,
    pageCount: candidate.pageCount,
    pageSize: candidate.pageSize,
  }) as ComposeSnapshotEvidence;
}

function exactSnapshot(
  expected: Readonly<ComposeSnapshotEvidence>,
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

function rolloutItem(
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
  rolloutId: string,
  lineage: Readonly<LocalDeploymentComposeLineage>,
): Readonly<CollectionItem> {
  const receiptContents = boundedPrivateFile(
    path.join(paths.composeRollouts, `${rolloutId}.json`),
    uid,
    'compose rollout receipt',
    [1, 2],
  );
  const receipt = readJson(receiptContents, 'compose rollout receipt');
  const sqlite = receipt.sqlite as Record<string, unknown> | undefined;
  const backup = sqlite?.backup as Record<string, unknown> | undefined;
  const result = receipt.result as Record<string, unknown> | undefined;
  assertLocalDeploymentComposeLineageReceipt(receipt.lineage, lineage.receipt);
  if (
    receipt.schema !== ROLLOUT_RECEIPT_SCHEMA ||
    receipt.rolloutId !== rolloutId ||
    !Number.isSafeInteger(receipt.recordedAtMs) ||
    (receipt.recordedAtMs as number) < 0 ||
    sqlite?.contractVersion !== LOCAL_SQLITE_WRITE_CONTRACT_VERSION ||
    !backup ||
    (result?.profile !== 'edge' && result?.profile !== 'standalone')
  ) {
    configurationError('compose rollout receipt collection binding drifted');
  }
  return Object.freeze({
    kind: 'rollout-backup' as const,
    artifactId: rolloutId,
    recordedAtMs: receipt.recordedAtMs as number,
    sourceReceiptDigest: evidenceDigest(receiptContents),
    snapshot: snapshot(
      {
        contractVersion: sqlite.contractVersion,
        sha256: backup.sha256,
        bytes: backup.bytes,
        pageCount: backup.pageCount,
        pageSize: backup.pageSize,
      },
      'compose rollout backup evidence',
    ),
  });
}

function restoreItem(
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
  restoreId: string,
  lineage: Readonly<LocalDeploymentComposeLineage>,
): Readonly<CollectionItem> {
  const receiptContents = boundedPrivateFile(
    path.join(paths.composeRestores, `${restoreId}.commit.json`),
    uid,
    'compose restore commit receipt',
    [1, 2],
  );
  const receipt = readJson(receiptContents, 'compose restore commit receipt');
  assertLocalDeploymentComposeLineageReceipt(receipt.lineage, lineage.receipt);
  if (
    receipt.schema !== RESTORE_COMMIT_SCHEMA ||
    receipt.restoreId !== restoreId ||
    !Number.isSafeInteger(receipt.recordedAtMs) ||
    (receipt.recordedAtMs as number) < 0
  ) {
    configurationError('compose restore receipt collection binding drifted');
  }
  return Object.freeze({
    kind: 'restore-safeguard' as const,
    artifactId: restoreId,
    recordedAtMs: receipt.recordedAtMs as number,
    sourceReceiptDigest: evidenceDigest(receiptContents),
    snapshot: snapshot(receipt.safeguard, 'compose restore safeguard evidence'),
  });
}

function artifactPath(
  paths: Readonly<LocalDeploymentPaths>,
  item: Readonly<CollectionItem>,
): string {
  return path.join(
    item.kind === 'rollout-backup'
      ? paths.composeRolloutBackups
      : paths.composeRestoreSafeguards,
    `${item.artifactId}.sqlite`,
  );
}

function verifySourceReceiptDigest(
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
  item: Readonly<CollectionItem>,
): void {
  const receiptPath =
    item.kind === 'rollout-backup'
      ? path.join(paths.composeRollouts, `${item.artifactId}.json`)
      : path.join(paths.composeRestores, `${item.artifactId}.commit.json`);
  const contents = boundedPrivateFile(
    receiptPath,
    uid,
    item.kind === 'rollout-backup'
      ? 'compose rollout receipt'
      : 'compose restore commit receipt',
    [1, 2],
  );
  if (evidenceDigest(contents) !== item.sourceReceiptDigest) {
    configurationError('compose collection source receipt drifted');
  }
}

async function inspectPhysicalItem(
  paths: Readonly<LocalDeploymentPaths>,
  profile: LocalDeploymentProfile,
  item: Readonly<CollectionItem>,
  stage = false,
): Promise<void> {
  const finalPath = artifactPath(paths, item);
  const actual = await inspectLocalSqliteSnapshot({
    databasePath: stage ? evidenceStagePath(finalPath) : finalPath,
    profile,
  });
  exactSnapshot(item.snapshot, actual, 'compose collection snapshot');
}

function catalogIds(root: string, label: string): readonly string[] {
  const ids: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const match = /^([0-9a-f-]+)\.sqlite$/.exec(entry.name);
    if (entry.isFile() && match && UUID_V4_PATTERN.test(match[1] ?? '')) {
      ids.push(match[1]!);
      continue;
    }
    if (
      entry.isFile() &&
      /^\.[0-9a-f-]+\.sqlite\.ql3-collection-stage$/.test(entry.name)
    ) {
      configurationError(`${label} has an unfinished collection stage`);
    }
    configurationError(`${label} contains drift`);
  }
  return Object.freeze(ids);
}

function sortItems(items: readonly Readonly<CollectionItem>[]) {
  return [...items].sort(
    (left, right) =>
      left.recordedAtMs - right.recordedAtMs ||
      left.artifactId.localeCompare(right.artifactId),
  );
}

async function prepareItems(
  command: Readonly<LocalDeploymentComposeEvidenceCollectionPrepareCommand>,
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
  profile: LocalDeploymentProfile,
  lineage: Readonly<LocalDeploymentComposeLineage>,
): Promise<readonly Readonly<CollectionItem>[]> {
  const rolloutCatalog = catalogIds(
    paths.composeRolloutBackups,
    'compose rollout backup catalog',
  );
  const restoreCatalog = catalogIds(
    paths.composeRestoreSafeguards,
    'compose restore safeguard catalog',
  );
  const rolloutItems = await Promise.all(
    rolloutCatalog.map(async (id) => {
      const item = rolloutItem(paths, uid, id, lineage);
      await inspectPhysicalItem(paths, profile, item);
      return item;
    }),
  );
  const restoreItems = await Promise.all(
    restoreCatalog.map(async (id) => {
      const item = restoreItem(paths, uid, id, lineage);
      await inspectPhysicalItem(paths, profile, item);
      return item;
    }),
  );
  const selectedRollouts = new Set(command.request.rolloutIds);
  const selectedRestores = new Set(command.request.restoreIds);
  const rolloutFloor = profile === 'edge' ? 2 : 4;
  const restoreFloor = profile === 'edge' ? 1 : 2;
  const maxItems = profile === 'edge' ? 1 : 4;
  if (
    command.request.rolloutIds.length + command.request.restoreIds.length >
      maxItems ||
    (selectedRollouts.size > 0 &&
      rolloutItems.length - selectedRollouts.size < rolloutFloor) ||
    (selectedRestores.size > 0 &&
      restoreItems.length - selectedRestores.size < restoreFloor)
  ) {
    configurationError(
      'compose evidence collection retention floor is invalid',
    );
  }
  const oldestRollouts = sortItems(rolloutItems)
    .slice(0, selectedRollouts.size)
    .map((item) => item.artifactId);
  const oldestRestores = sortItems(restoreItems)
    .slice(0, selectedRestores.size)
    .map((item) => item.artifactId);
  if (
    oldestRollouts.some((id) => !selectedRollouts.has(id)) ||
    oldestRestores.some((id) => !selectedRestores.has(id)) ||
    selectedRollouts.size !== command.request.rolloutIds.length ||
    selectedRestores.size !== command.request.restoreIds.length
  ) {
    configurationError('compose evidence collection must select oldest items');
  }
  const items = [
    ...sortItems(rolloutItems).filter((item) =>
      selectedRollouts.has(item.artifactId),
    ),
    ...sortItems(restoreItems).filter((item) =>
      selectedRestores.has(item.artifactId),
    ),
  ];
  return Object.freeze(items);
}

function receiptContents(
  receipt: Readonly<CollectionPrepareReceipt | CollectionCommitReceipt>,
): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function prepareReceiptPath(
  paths: Readonly<LocalDeploymentPaths>,
  collectionId: string,
): string {
  return path.join(
    paths.composeEvidenceCollections,
    `${collectionId}.prepare.json`,
  );
}

function commitReceiptPath(
  paths: Readonly<LocalDeploymentPaths>,
  collectionId: string,
): string {
  return path.join(
    paths.composeEvidenceCollections,
    `${collectionId}.commit.json`,
  );
}

function parseItems(value: unknown): readonly Readonly<CollectionItem>[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    configurationError('compose evidence collection items are invalid');
  }
  const seen = new Set<string>();
  return Object.freeze(
    value.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        configurationError('compose evidence collection item is invalid');
      }
      const item = entry as Record<string, unknown>;
      if (
        Object.keys(item).sort().join(',') !==
          [
            'artifactId',
            'kind',
            'recordedAtMs',
            'snapshot',
            'sourceReceiptDigest',
          ]
            .sort()
            .join(',') ||
        (item.kind !== 'rollout-backup' && item.kind !== 'restore-safeguard') ||
        typeof item.artifactId !== 'string' ||
        !UUID_V4_PATTERN.test(item.artifactId) ||
        seen.has(`${item.kind}:${item.artifactId}`) ||
        !Number.isSafeInteger(item.recordedAtMs) ||
        (item.recordedAtMs as number) < 0 ||
        typeof item.sourceReceiptDigest !== 'string' ||
        !SHA256_PATTERN.test(item.sourceReceiptDigest)
      ) {
        configurationError('compose evidence collection item drifted');
      }
      seen.add(`${item.kind}:${item.artifactId}`);
      return Object.freeze({
        kind: item.kind,
        artifactId: item.artifactId,
        recordedAtMs: item.recordedAtMs,
        sourceReceiptDigest: item.sourceReceiptDigest,
        snapshot: snapshot(
          item.snapshot,
          'compose evidence collection snapshot',
        ),
      }) as Readonly<CollectionItem>;
    }),
  );
}

function inspectPrepareReceipt(
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
  command: Readonly<LocalDeploymentComposeEvidenceCollectionPrepareCommand>,
  expectedLineage: Readonly<LocalDeploymentComposeLineage>,
): Readonly<CollectionPrepareReceipt> | null {
  const filePath = prepareReceiptPath(paths, command.request.collectionId);
  if (!fs.existsSync(filePath)) return null;
  const contents = boundedPrivateFile(
    filePath,
    uid,
    'compose evidence collection prepare receipt',
    [1, 2],
  );
  const value = readJson(
    contents,
    'compose evidence collection prepare receipt',
  );
  const items = parseItems(value.items);
  const lineage = normalizeLocalDeploymentComposeLineageReceipt(value.lineage);
  const receipt = {
    ...value,
    lineage,
    items,
  } as unknown as CollectionPrepareReceipt;
  if (
    Object.keys(value).sort().join(',') !==
      [
        'collectionId',
        'commandDigest',
        'generation',
        'items',
        'lineage',
        'profile',
        'recordedAtMs',
        'schema',
      ]
        .sort()
        .join(',') ||
    receipt.schema !== PREPARE_SCHEMA ||
    receipt.commandDigest !== commandDigest(command) ||
    receipt.collectionId !== command.request.collectionId ||
    receipt.generation !== command.request.expectedGeneration ||
    receipt.recordedAtMs !== command.request.preparedAtMs ||
    (receipt.profile !== 'edge' && receipt.profile !== 'standalone') ||
    contents !== receiptContents(receipt)
  ) {
    configurationError('compose evidence collection prepare receipt drifted');
  }
  assertLocalDeploymentComposeLineageReceipt(
    receipt.lineage,
    expectedLineage.receipt,
  );
  publishExactFile(
    filePath,
    contents,
    0o600,
    uid,
    'compose evidence collection prepare receipt',
  );
  return Object.freeze(receipt);
}

function inspectCommitReceipt(
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
  command: Readonly<LocalDeploymentComposeEvidenceCollectionCommand>,
  expectedLineage: Readonly<LocalDeploymentComposeLineage>,
): Readonly<CollectionCommitReceipt> | null {
  const filePath = commitReceiptPath(paths, command.request.collectionId);
  if (!fs.existsSync(filePath)) return null;
  const contents = boundedPrivateFile(
    filePath,
    uid,
    'compose evidence collection commit receipt',
    [1, 2],
  );
  const value = readJson(
    contents,
    'compose evidence collection commit receipt',
  );
  const items = parseItems(value.items);
  const lineage = normalizeLocalDeploymentComposeLineageReceipt(value.lineage);
  const receipt = {
    ...value,
    lineage,
    items,
  } as unknown as CollectionCommitReceipt;
  if (
    Object.keys(value).sort().join(',') !==
      [
        'bytes',
        'collectionId',
        'commandDigest',
        'generation',
        'items',
        'lineage',
        'prepareReceiptDigest',
        'profile',
        'recordedAtMs',
        'schema',
      ]
        .sort()
        .join(',') ||
    receipt.schema !== COMMIT_SCHEMA ||
    receipt.commandDigest !== commandDigest(command) ||
    !SHA256_PATTERN.test(receipt.prepareReceiptDigest) ||
    receipt.collectionId !== command.request.collectionId ||
    receipt.generation !== command.request.expectedGeneration ||
    receipt.recordedAtMs !==
      (command.operation ===
      'local.deployment.compose.evidence-collection.commit'
        ? command.request.committedAtMs
        : -1) ||
    (receipt.profile !== 'edge' && receipt.profile !== 'standalone') ||
    receipt.bytes !==
      items.reduce((total, item) => total + item.snapshot.bytes, 0) ||
    contents !== receiptContents(receipt)
  ) {
    configurationError('compose evidence collection commit receipt drifted');
  }
  assertLocalDeploymentComposeLineageReceipt(
    receipt.lineage,
    expectedLineage.receipt,
  );
  publishExactFile(
    filePath,
    contents,
    0o600,
    uid,
    'compose evidence collection commit receipt',
  );
  return Object.freeze(receipt);
}

function result(
  command: Readonly<LocalDeploymentComposeEvidenceCollectionCommand>,
  status: LocalDeploymentComposeEvidenceCollectionResult['status'],
  profile: LocalDeploymentProfile,
  items: readonly Readonly<CollectionItem>[],
): Readonly<LocalDeploymentComposeEvidenceCollectionResult> {
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status,
    generation: command.request.expectedGeneration,
    profile,
    collected: Object.freeze({
      rolloutBackups: items.filter((item) => item.kind === 'rollout-backup')
        .length,
      restoreSafeguards: items.filter(
        (item) => item.kind === 'restore-safeguard',
      ).length,
      bytes: items.reduce((total, item) => total + item.snapshot.bytes, 0),
    }),
    service: Object.freeze({
      kind: 'compose' as const,
      state: 'unchanged' as const,
    }),
  });
}

function releaseCollectionLock(
  paths: Readonly<LocalDeploymentPaths>,
  intent: string,
  uid: number,
): void {
  if (!fs.existsSync(paths.composeEvidenceCollectionLock)) return;
  preflightPublishedFile(
    paths.composeEvidenceCollectionLock,
    intent,
    0o600,
    uid,
    'compose evidence collection lock',
  );
  fs.unlinkSync(paths.composeEvidenceCollectionLock);
  syncPublishedDirectory(path.dirname(paths.composeEvidenceCollectionLock));
}

function assertOperationsIdle(paths: Readonly<LocalDeploymentPaths>): void {
  if (
    fs.existsSync(paths.composeRevisionLock) ||
    fs.existsSync(paths.composeRolloutLock) ||
    fs.existsSync(paths.composeRestoreLock)
  ) {
    configurationError('compose evidence collection is fenced by an operation');
  }
}

async function prepareCollection(
  command: Readonly<LocalDeploymentComposeEvidenceCollectionPrepareCommand>,
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
  lineage: Readonly<LocalDeploymentComposeLineage>,
): Promise<Readonly<LocalDeploymentComposeEvidenceCollectionResult>> {
  const replay = inspectPrepareReceipt(paths, uid, command, lineage);
  if (replay) return result(command, 'existing', replay.profile, replay.items);
  assertOperationsIdle(paths);
  const selection = inspectActiveComposeImageSelection(
    paths.composeSelection,
    paths.composeRevisions,
    uid,
  );
  if (selection.generation !== command.request.expectedGeneration) {
    configurationError(
      'active compose generation does not match evidence collection',
    );
  }
  const profile = lineage.profile;
  const items = await prepareItems(command, paths, uid, profile, lineage);
  if (items.some((item) => item.recordedAtMs > command.request.preparedAtMs)) {
    configurationError(
      'compose evidence collection precedes retained evidence',
    );
  }
  const intent = `${JSON.stringify(command, null, 2)}\n`;
  publishExactFile(
    paths.composeEvidenceCollectionLock,
    intent,
    0o600,
    uid,
    'compose evidence collection lock',
  );
  try {
    assertOperationsIdle(paths);
  } catch (error) {
    releaseCollectionLock(paths, intent, uid);
    throw error;
  }
  const receipt: CollectionPrepareReceipt = Object.freeze({
    schema: PREPARE_SCHEMA,
    commandDigest: commandDigest(command),
    collectionId: command.request.collectionId,
    generation: command.request.expectedGeneration,
    profile,
    lineage: lineage.receipt,
    recordedAtMs: command.request.preparedAtMs,
    items,
  });
  publishExactFile(
    prepareReceiptPath(paths, command.request.collectionId),
    receiptContents(receipt),
    0o600,
    uid,
    'compose evidence collection prepare receipt',
  );
  return result(command, 'prepared', profile, items);
}

function prepareCommandFromLock(
  command: Readonly<LocalDeploymentComposeEvidenceCollectionCommand>,
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
): Readonly<LocalDeploymentComposeEvidenceCollectionPrepareCommand> {
  const intent = boundedPrivateFile(
    paths.composeEvidenceCollectionLock,
    uid,
    'compose evidence collection lock',
    [1, 2],
  );
  const prepared = normalizeLocalDeploymentComposeEvidenceCollectionCommand(
    readJson(intent, 'compose evidence collection lock'),
  );
  if (
    prepared.operation !==
      'local.deployment.compose.evidence-collection.prepare' ||
    prepared.options.deploymentRoot !== command.options.deploymentRoot ||
    prepared.options.allowRootService !== command.options.allowRootService ||
    prepared.request.collectionId !== command.request.collectionId ||
    prepared.request.expectedGeneration !==
      command.request.expectedGeneration ||
    (command.operation ===
      'local.deployment.compose.evidence-collection.commit' &&
      command.request.committedAtMs < prepared.request.preparedAtMs)
  ) {
    configurationError(
      'compose evidence collection commit does not match prepare',
    );
  }
  preflightPublishedFile(
    paths.composeEvidenceCollectionLock,
    `${JSON.stringify(prepared, null, 2)}\n`,
    0o600,
    uid,
    'compose evidence collection lock',
  );
  return prepared;
}

async function publishItemTombstone(
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
  command: Readonly<LocalDeploymentComposeEvidenceCollectionCommand>,
  profile: LocalDeploymentProfile,
  item: Readonly<CollectionItem>,
): Promise<void> {
  const finalPath = artifactPath(paths, item);
  const stagePath = evidenceStagePath(finalPath);
  const tombstone = inspectCollectedEvidence(
    paths,
    uid,
    LOCAL_SQLITE_WRITE_CONTRACT_VERSION,
    item,
  );
  if (tombstone) {
    if (
      tombstone.collectionId !== command.request.collectionId ||
      tombstone.generation !== command.request.expectedGeneration ||
      tombstone.profile !== profile ||
      (command.operation ===
        'local.deployment.compose.evidence-collection.commit' &&
        tombstone.collectedAtMs !== command.request.committedAtMs)
    ) {
      configurationError('compose collected evidence transaction drifted');
    }
    return;
  }
  if (fs.existsSync(finalPath)) {
    if (fs.existsSync(stagePath)) {
      configurationError('compose collection snapshot stage conflicts');
    }
    await inspectPhysicalItem(paths, profile, item);
    fs.renameSync(finalPath, stagePath);
    syncPublishedDirectory(path.dirname(finalPath));
  } else if (!fs.existsSync(stagePath)) {
    configurationError('compose collection snapshot is unavailable');
  }
  await inspectPhysicalItem(paths, profile, item, true);
  publishCollectedEvidence(paths, uid, {
    schema: 'qinglong/local-compose-collected-evidence@v1',
    kind: item.kind,
    artifactId: item.artifactId,
    collectionId: command.request.collectionId,
    generation: command.request.expectedGeneration,
    profile,
    sourceReceiptDigest: item.sourceReceiptDigest,
    snapshot: item.snapshot,
    collectedAtMs:
      command.operation ===
      'local.deployment.compose.evidence-collection.commit'
        ? command.request.committedAtMs
        : 0,
  });
}

function cleanupStages(
  paths: Readonly<LocalDeploymentPaths>,
  items: readonly Readonly<CollectionItem>[],
): void {
  const touched = new Set<string>();
  for (const item of items) {
    const stagePath = evidenceStagePath(artifactPath(paths, item));
    if (!fs.existsSync(stagePath)) continue;
    fs.unlinkSync(stagePath);
    touched.add(path.dirname(stagePath));
  }
  for (const directory of touched) syncPublishedDirectory(directory);
}

async function commitCollection(
  command: Readonly<LocalDeploymentComposeEvidenceCollectionCommand>,
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
  lineage: Readonly<LocalDeploymentComposeLineage>,
): Promise<Readonly<LocalDeploymentComposeEvidenceCollectionResult>> {
  if (
    command.operation !== 'local.deployment.compose.evidence-collection.commit'
  ) {
    configurationError('compose evidence collection commit command is invalid');
  }
  const existing = inspectCommitReceipt(paths, uid, command, lineage);
  if (existing) {
    const prepareContents = boundedPrivateFile(
      prepareReceiptPath(paths, command.request.collectionId),
      uid,
      'compose evidence collection prepare receipt',
      [1, 2],
    );
    if (evidenceDigest(prepareContents) !== existing.prepareReceiptDigest) {
      configurationError(
        'compose evidence collection prepare receipt digest drifted',
      );
    }
    for (const item of existing.items) {
      verifySourceReceiptDigest(paths, uid, item);
      const tombstone = inspectCollectedEvidence(
        paths,
        uid,
        LOCAL_SQLITE_WRITE_CONTRACT_VERSION,
        item,
      );
      if (
        !tombstone ||
        tombstone.collectionId !== command.request.collectionId ||
        tombstone.generation !== command.request.expectedGeneration ||
        tombstone.profile !== existing.profile ||
        tombstone.collectedAtMs !== command.request.committedAtMs
      ) {
        configurationError('compose collected evidence replay drifted');
      }
    }
    cleanupStages(paths, existing.items);
    if (fs.existsSync(paths.composeEvidenceCollectionLock)) {
      const prepared = prepareCommandFromLock(command, paths, uid);
      releaseCollectionLock(
        paths,
        `${JSON.stringify(prepared, null, 2)}\n`,
        uid,
      );
    }
    return result(command, 'existing', existing.profile, existing.items);
  }
  const prepared = prepareCommandFromLock(command, paths, uid);
  const prepareReceipt = inspectPrepareReceipt(paths, uid, prepared, lineage);
  if (!prepareReceipt) {
    configurationError(
      'compose evidence collection prepare receipt is unavailable',
    );
  }
  const currentSelection = inspectActiveComposeImageSelection(
    paths.composeSelection,
    paths.composeRevisions,
    uid,
  );
  if (currentSelection.generation !== command.request.expectedGeneration) {
    configurationError('compose generation changed after collection prepare');
  }
  for (const item of prepareReceipt.items) {
    verifySourceReceiptDigest(paths, uid, item);
    await publishItemTombstone(
      paths,
      uid,
      command,
      prepareReceipt.profile,
      item,
    );
  }
  const prepareContents = boundedPrivateFile(
    prepareReceiptPath(paths, command.request.collectionId),
    uid,
    'compose evidence collection prepare receipt',
  );
  const receipt: CollectionCommitReceipt = Object.freeze({
    schema: COMMIT_SCHEMA,
    commandDigest: commandDigest(command),
    prepareReceiptDigest: evidenceDigest(prepareContents),
    collectionId: command.request.collectionId,
    generation: command.request.expectedGeneration,
    profile: prepareReceipt.profile,
    lineage: lineage.receipt,
    recordedAtMs: command.request.committedAtMs,
    items: prepareReceipt.items,
    bytes: prepareReceipt.items.reduce(
      (total, item) => total + item.snapshot.bytes,
      0,
    ),
  });
  publishExactFile(
    commitReceiptPath(paths, command.request.collectionId),
    receiptContents(receipt),
    0o600,
    uid,
    'compose evidence collection commit receipt',
  );
  cleanupStages(paths, prepareReceipt.items);
  releaseCollectionLock(paths, `${JSON.stringify(prepared, null, 2)}\n`, uid);
  return result(
    command,
    'collected',
    prepareReceipt.profile,
    prepareReceipt.items,
  );
}

export async function collectLocalDeploymentComposeEvidence(
  input: unknown,
): Promise<Readonly<LocalDeploymentComposeEvidenceCollectionResult>> {
  const command =
    normalizeLocalDeploymentComposeEvidenceCollectionCommand(input);
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
  validatePrivateDirectory(
    paths.composeRestores,
    identity.uid,
    'composeRestoreRoot',
  );
  validatePrivateDirectory(
    paths.composeRestoreSafeguards,
    identity.uid,
    'composeRestoreSafeguardRoot',
  );
  validatePrivateDirectory(
    paths.composeEvidenceCollections,
    identity.uid,
    'composeEvidenceCollectionRoot',
  );
  validatePrivateDirectory(
    paths.composeCollectedRolloutBackups,
    identity.uid,
    'composeCollectedRolloutBackupRoot',
  );
  validatePrivateDirectory(
    paths.composeCollectedRestoreSafeguards,
    identity.uid,
    'composeCollectedRestoreSafeguardRoot',
  );
  const lineage = inspectLocalDeploymentComposeLineage(
    command.options.deploymentRoot,
    identity.uid,
    identity.gid,
    command.options.allowRootService,
  );
  return command.operation ===
    'local.deployment.compose.evidence-collection.prepare'
    ? prepareCollection(command, paths, identity.uid, lineage)
    : commitCollection(command, paths, identity.uid, lineage);
}

export function collectLocalDeploymentComposeEvidencePrepareCommandFile(
  filePath: string,
): Promise<Readonly<LocalDeploymentComposeEvidenceCollectionResult>> {
  const command = normalizeLocalDeploymentComposeEvidenceCollectionCommand(
    readPrivateLocalCommandFile(filePath),
  );
  if (
    command.operation !== 'local.deployment.compose.evidence-collection.prepare'
  ) {
    configurationError(
      'compose evidence collection prepare command is required',
    );
  }
  return collectLocalDeploymentComposeEvidence(command);
}

export function collectLocalDeploymentComposeEvidenceCommitCommandFile(
  filePath: string,
): Promise<Readonly<LocalDeploymentComposeEvidenceCollectionResult>> {
  const command = normalizeLocalDeploymentComposeEvidenceCollectionCommand(
    readPrivateLocalCommandFile(filePath),
  );
  if (
    command.operation !== 'local.deployment.compose.evidence-collection.commit'
  ) {
    configurationError(
      'compose evidence collection commit command is required',
    );
  }
  return collectLocalDeploymentComposeEvidence(command);
}
