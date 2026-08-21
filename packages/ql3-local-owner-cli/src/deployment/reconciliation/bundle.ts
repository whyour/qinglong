import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { currentIdentity } from '../foundation/contract';
import { LocalDeploymentConfigurationError } from '../foundation/error';
import {
  ensurePrivateDirectory,
  publishExactFile,
  syncPublishedDirectory,
  validatePrivateDirectory,
} from '../foundation/files';
import {
  advanceLocalCutoverInstanceHead,
  readLocalCutoverInstanceHead,
  type LocalCutoverInstanceHead,
} from '../cutover/instanceLineage';
import { cutoverDigest } from '../cutover/targetEvidence';
import {
  normalizeLocalReconciliationCaptureCommitCommand,
  normalizeLocalReconciliationCaptureVerifyCommand,
  type LocalReconciliationCaptureCommitCommand,
  type LocalReconciliationCaptureTerminalResult,
} from './contract';
import {
  localReconciliationCaptureDirectory,
  readLocalReconciliationCaptureIntent,
  type LocalReconciliationCaptureIntent,
} from './preparation';
import { proveLocalReconciliationLineage } from './lineageProof';
import { proveLocalReconciliationStoppedState } from './stoppedProof';
import {
  copyLocalReconciliationAsset,
  localReconciliationCaptureAssetFileName,
  localReconciliationCaptureAssetPlan,
  verifyLocalReconciliationPublishedAsset,
  verifyLocalReconciliationSidecarPlan,
  verifyLocalReconciliationSourceSnapshot,
  type LocalReconciliationCapturedAsset,
  type LocalReconciliationStableCopyDependencies,
} from './stableCopy';

const MANIFEST_SCHEMA = 'qinglong3-local-reconciliation-capture-manifest';
const RECEIPT_SCHEMA = 'qinglong3-local-reconciliation-capture-receipt';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const LOGICAL_NAMES = [
  'target-main',
  'target-wal',
  'target-shm',
  'target-journal',
  'legacy-main',
  'legacy-wal',
  'legacy-shm',
  'legacy-journal',
  'recovery-main',
] as const;

export interface LocalReconciliationCaptureManifest {
  readonly schema: typeof MANIFEST_SCHEMA;
  readonly schemaVersion: 2;
  readonly state: 'reconciliation_captured';
  readonly captureId: string;
  readonly profile: 'edge' | 'standalone';
  readonly preparationDigest: string;
  readonly stoppedRecordDigest: string;
  readonly stoppedProofDigest: string;
  readonly reconciliationEvidenceDigest: string;
  readonly lineageProjectionDigest: string;
  readonly legacyBaselineSha256: string;
  readonly targetBaselineSha256: string;
  readonly preparedHeadDigest: string;
  readonly committedAtMs: number;
  readonly assets: readonly Readonly<LocalReconciliationCapturedAsset>[];
  readonly totalBytes: number;
  readonly manifestDigest: string;
}

export interface LocalReconciliationCaptureReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly schemaVersion: 2;
  readonly state: 'reconciliation_captured';
  readonly captureId: string;
  readonly profile: 'edge' | 'standalone';
  readonly preparationDigest: string;
  readonly manifestDigest: string;
  readonly assetCount: number;
  readonly totalBytes: number;
  readonly committedAtMs: number;
  readonly bundleDigest: string;
}

export interface LocalReconciliationCaptureDependencies {
  readonly stableCopy?: LocalReconciliationStableCopyDependencies;
  readonly afterAssetPublished?: (
    logicalName: LocalReconciliationCapturedAsset['logicalName'],
  ) => void;
  readonly afterManifestPublished?: () => void;
  readonly afterReceiptPublished?: () => void;
  readonly afterAssetSealed?: (
    logicalName: LocalReconciliationCapturedAsset['logicalName'],
  ) => void;
  readonly afterAssetsSealed?: () => void;
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

function capturePaths(
  captureRoot: string,
  captureId: string,
): Readonly<{
  root: string;
  staging: string;
  assets: string;
  manifest: string;
  receipt: string;
}> {
  const root = localReconciliationCaptureDirectory(captureRoot, captureId);
  return Object.freeze({
    root,
    staging: path.join(root, 'staging'),
    assets: path.join(root, 'assets'),
    manifest: path.join(root, 'manifest.json'),
    receipt: path.join(root, 'receipt.json'),
  });
}

function validateIntentBinding(
  intent: Readonly<LocalReconciliationCaptureIntent>,
  command: Readonly<LocalReconciliationCaptureCommitCommand>,
): void {
  if (
    intent.command.options.deploymentRoot !== command.options.deploymentRoot ||
    intent.command.options.captureRoot !== command.options.captureRoot ||
    intent.command.options.allowRootService !==
      command.options.allowRootService ||
    intent.command.request.captureId !== command.request.captureId ||
    intent.preparationDigest !== command.request.expectedPreparationDigest ||
    command.request.committedAtMs < intent.command.request.preparedAtMs
  ) {
    configurationError('capture commit is not bound to its exact preparation');
  }
}

function validateHeadIdentity(
  head: Readonly<LocalCutoverInstanceHead>,
  intent: Readonly<LocalReconciliationCaptureIntent>,
): void {
  if (
    head.profile !== intent.command.request.profile ||
    head.cutoverId !== intent.command.request.cutoverId ||
    head.activationDigest !== intent.command.request.expectedActivationDigest ||
    head.generation !== intent.command.request.generation
  ) {
    configurationError('capture instance head identity drifted');
  }
}

function normalizeAsset(
  value: unknown,
): Readonly<LocalReconciliationCapturedAsset> {
  const asset = object(value, 'capture manifest asset');
  exact(
    asset,
    ['bytes', 'logicalName', 'sha256', 'sourceIdentityDigest'],
    'capture manifest asset',
  );
  if (
    typeof asset.logicalName !== 'string' ||
    !LOGICAL_NAMES.includes(
      asset.logicalName as (typeof LOGICAL_NAMES)[number],
    ) ||
    !Number.isSafeInteger(asset.bytes) ||
    (asset.bytes as number) < 0 ||
    typeof asset.sha256 !== 'string' ||
    !DIGEST_PATTERN.test(asset.sha256) ||
    typeof asset.sourceIdentityDigest !== 'string' ||
    !DIGEST_PATTERN.test(asset.sourceIdentityDigest)
  ) {
    configurationError('capture manifest asset drifted');
  }
  return Object.freeze({
    logicalName:
      asset.logicalName as LocalReconciliationCapturedAsset['logicalName'],
    bytes: asset.bytes as number,
    sha256: asset.sha256,
    sourceIdentityDigest: asset.sourceIdentityDigest,
  });
}

export function normalizeLocalReconciliationCaptureManifest(
  value: unknown,
): Readonly<LocalReconciliationCaptureManifest> {
  const manifest = object(value, 'reconciliation capture manifest');
  exact(
    manifest,
    [
      'assets',
      'captureId',
      'committedAtMs',
      'legacyBaselineSha256',
      'lineageProjectionDigest',
      'manifestDigest',
      'preparationDigest',
      'preparedHeadDigest',
      'profile',
      'reconciliationEvidenceDigest',
      'schema',
      'schemaVersion',
      'state',
      'stoppedProofDigest',
      'stoppedRecordDigest',
      'targetBaselineSha256',
      'totalBytes',
    ],
    'reconciliation capture manifest',
  );
  if (!Array.isArray(manifest.assets)) {
    configurationError('capture manifest assets must be an array');
  }
  const assets = Object.freeze(manifest.assets.map(normalizeAsset));
  const names = assets.map((asset) => asset.logicalName);
  const order = names.map((name) => LOGICAL_NAMES.indexOf(name));
  const { manifestDigest, ...payload } = manifest;
  if (
    manifest.schema !== MANIFEST_SCHEMA ||
    manifest.schemaVersion !== 2 ||
    manifest.state !== 'reconciliation_captured' ||
    typeof manifest.captureId !== 'string' ||
    (manifest.profile !== 'edge' && manifest.profile !== 'standalone') ||
    assets.length < 3 ||
    assets.length > LOGICAL_NAMES.length ||
    new Set(names).size !== names.length ||
    order.some(
      (index, position) => position > 0 && index <= order[position - 1]!,
    ) ||
    names[0] !== 'target-main' ||
    !names.includes('legacy-main') ||
    names.at(-1) !== 'recovery-main' ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    (manifest.totalBytes as number) < 1 ||
    assets.reduce((total, asset) => total + asset.bytes, 0) !==
      manifest.totalBytes ||
    !Number.isSafeInteger(manifest.committedAtMs) ||
    (manifest.committedAtMs as number) < 0 ||
    [
      manifest.preparationDigest,
      manifest.stoppedRecordDigest,
      manifest.stoppedProofDigest,
      manifest.reconciliationEvidenceDigest,
      manifest.lineageProjectionDigest,
      manifest.legacyBaselineSha256,
      manifest.targetBaselineSha256,
      manifest.preparedHeadDigest,
      manifestDigest,
    ].some(
      (candidate) =>
        typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate),
    ) ||
    cutoverDigest(payload) !== manifestDigest
  ) {
    configurationError('reconciliation capture manifest drifted');
  }
  return Object.freeze({
    ...(manifest as unknown as LocalReconciliationCaptureManifest),
    assets,
  });
}

export function normalizeLocalReconciliationCaptureReceipt(
  value: unknown,
): Readonly<LocalReconciliationCaptureReceipt> {
  const receipt = object(value, 'reconciliation capture receipt');
  exact(
    receipt,
    [
      'assetCount',
      'bundleDigest',
      'captureId',
      'committedAtMs',
      'manifestDigest',
      'preparationDigest',
      'profile',
      'schema',
      'schemaVersion',
      'state',
      'totalBytes',
    ],
    'reconciliation capture receipt',
  );
  const { bundleDigest, ...payload } = receipt;
  if (
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.schemaVersion !== 2 ||
    receipt.state !== 'reconciliation_captured' ||
    typeof receipt.captureId !== 'string' ||
    (receipt.profile !== 'edge' && receipt.profile !== 'standalone') ||
    !Number.isSafeInteger(receipt.assetCount) ||
    (receipt.assetCount as number) < 3 ||
    (receipt.assetCount as number) > LOGICAL_NAMES.length ||
    !Number.isSafeInteger(receipt.totalBytes) ||
    (receipt.totalBytes as number) < 1 ||
    !Number.isSafeInteger(receipt.committedAtMs) ||
    (receipt.committedAtMs as number) < 0 ||
    [receipt.preparationDigest, receipt.manifestDigest, bundleDigest].some(
      (candidate) =>
        typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate),
    ) ||
    cutoverDigest(payload) !== bundleDigest
  ) {
    configurationError('reconciliation capture receipt drifted');
  }
  return receipt as unknown as Readonly<LocalReconciliationCaptureReceipt>;
}

function manifestContents(
  manifest: Readonly<LocalReconciliationCaptureManifest>,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function receiptContents(
  receipt: Readonly<LocalReconciliationCaptureReceipt>,
): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function captureReceipt(
  manifest: Readonly<LocalReconciliationCaptureManifest>,
): Readonly<LocalReconciliationCaptureReceipt> {
  const payload = Object.freeze({
    schema: RECEIPT_SCHEMA,
    schemaVersion: 2 as const,
    state: 'reconciliation_captured' as const,
    captureId: manifest.captureId,
    profile: manifest.profile,
    preparationDigest: manifest.preparationDigest,
    manifestDigest: manifest.manifestDigest,
    assetCount: manifest.assets.length,
    totalBytes: manifest.totalBytes,
    committedAtMs: manifest.committedAtMs,
  });
  return Object.freeze({
    ...payload,
    bundleDigest: cutoverDigest(payload),
  });
}

function validateTerminalCatalog(
  paths: ReturnType<typeof capturePaths>,
  terminal: boolean,
): void {
  const allowedRoot = new Set([
    'assets',
    'intent.json',
    'manifest.json',
    'receipt.json',
    'staging',
    ...(!terminal
      ? ['.manifest.json.ql3-deploy-stage', '.receipt.json.ql3-deploy-stage']
      : []),
  ]);
  for (const entry of fs.readdirSync(paths.root, { withFileTypes: true })) {
    if (!allowedRoot.has(entry.name) || entry.isSymbolicLink()) {
      configurationError('capture bundle root contains unknown material');
    }
  }
  if (fs.readdirSync(paths.staging).length !== 0) {
    configurationError('capture staging root contains unknown material');
  }
  const allowedAssets = new Set<string>(
    LOGICAL_NAMES.map(localReconciliationCaptureAssetFileName),
  );
  if (!terminal) {
    for (const name of LOGICAL_NAMES) {
      allowedAssets.add(
        `.${localReconciliationCaptureAssetFileName(
          name,
        )}.ql3-capture-stage`,
      );
    }
  }
  for (const entry of fs.readdirSync(paths.assets, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !allowedAssets.has(entry.name)
    ) {
      configurationError('capture assets contain unknown material');
    }
  }
}

function validateSealedAssetsDirectory(directory: string, uid: number): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    return configurationError('sealed capture assets are unavailable', error);
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o500 ||
    fs.realpathSync(directory) !== directory
  ) {
    configurationError(
      'sealed capture assets must be a canonical current-UID 0500 directory',
    );
  }
}

function sealTerminalAssets(
  paths: ReturnType<typeof capturePaths>,
  manifest: Readonly<LocalReconciliationCaptureManifest>,
  uid: number,
  afterAssetSealed?: (
    logicalName: LocalReconciliationCapturedAsset['logicalName'],
  ) => void,
): void {
  const directory = fs.lstatSync(paths.assets);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== uid ||
    ![0o700, 0o500].includes(directory.mode & 0o777) ||
    fs.realpathSync(paths.assets) !== paths.assets
  ) {
    configurationError('capture assets cannot be sealed');
  }
  if ((directory.mode & 0o777) === 0o500) {
    for (const asset of manifest.assets) {
      verifyLocalReconciliationPublishedAsset(asset, paths.assets, uid, [
        0o400n,
      ]);
    }
    return;
  }
  for (const asset of manifest.assets) {
    verifyLocalReconciliationPublishedAsset(asset, paths.assets, uid, [
      0o600n,
      0o400n,
    ]);
    const assetPath = path.join(
      paths.assets,
      localReconciliationCaptureAssetFileName(asset.logicalName),
    );
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        assetPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      const opened = fs.fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.uid !== uid ||
        opened.nlink !== 1 ||
        ![0o600, 0o400].includes(opened.mode & 0o777)
      ) {
        configurationError('capture asset seal identity drifted');
      }
      if ((opened.mode & 0o777) === 0o600) {
        fs.fchmodSync(descriptor, 0o400);
        fs.fsyncSync(descriptor);
      }
    } catch (error) {
      if (error instanceof LocalDeploymentConfigurationError) throw error;
      configurationError('capture asset cannot be sealed', error);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    verifyLocalReconciliationPublishedAsset(asset, paths.assets, uid, [
      0o400n,
    ]);
    afterAssetSealed?.(asset.logicalName);
  }
  let directoryDescriptor: number | undefined;
  try {
    directoryDescriptor = fs.openSync(paths.assets, fs.constants.O_RDONLY);
    fs.fchmodSync(directoryDescriptor, 0o500);
    fs.fsyncSync(directoryDescriptor);
  } catch (error) {
    configurationError('capture assets directory cannot be sealed', error);
  } finally {
    if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
  }
  syncPublishedDirectory(paths.root);
  validateSealedAssetsDirectory(paths.assets, uid);
}

function readTerminal(
  paths: ReturnType<typeof capturePaths>,
  uid: number,
): Readonly<{
  manifest: Readonly<LocalReconciliationCaptureManifest>;
  receipt: Readonly<LocalReconciliationCaptureReceipt>;
}> {
  validatePrivateDirectory(paths.root, uid, 'captureDirectory');
  validatePrivateDirectory(paths.staging, uid, 'captureStagingDirectory');
  validateSealedAssetsDirectory(paths.assets, uid);
  const manifest = normalizeLocalReconciliationCaptureManifest(
    readPrivateLocalCommandFile(paths.manifest),
  );
  const receipt = normalizeLocalReconciliationCaptureReceipt(
    readPrivateLocalCommandFile(paths.receipt),
  );
  if (
    receipt.captureId !== manifest.captureId ||
    receipt.profile !== manifest.profile ||
    receipt.preparationDigest !== manifest.preparationDigest ||
    receipt.manifestDigest !== manifest.manifestDigest ||
    receipt.assetCount !== manifest.assets.length ||
    receipt.totalBytes !== manifest.totalBytes
  ) {
    configurationError('capture terminal receipt is detached from manifest');
  }
  for (const asset of manifest.assets) {
    verifyLocalReconciliationPublishedAsset(asset, paths.assets, uid, [
      0o400n,
    ]);
  }
  validateTerminalCatalog(paths, true);
  return Object.freeze({ manifest, receipt });
}

export function readLocalReconciliationCaptureTerminal(
  captureRoot: string,
  captureId: string,
  uid: number,
): Readonly<{
  manifest: Readonly<LocalReconciliationCaptureManifest>;
  receipt: Readonly<LocalReconciliationCaptureReceipt>;
}> {
  return readTerminal(capturePaths(captureRoot, captureId), uid);
}

function readPublishedManifest(
  paths: ReturnType<typeof capturePaths>,
  uid: number,
): Readonly<LocalReconciliationCaptureManifest> {
  validatePrivateDirectory(paths.root, uid, 'captureDirectory');
  validatePrivateDirectory(paths.staging, uid, 'captureStagingDirectory');
  validatePrivateDirectory(paths.assets, uid, 'captureAssetsDirectory');
  const manifest = normalizeLocalReconciliationCaptureManifest(
    readPrivateLocalCommandFile(paths.manifest),
  );
  for (const asset of manifest.assets) {
    verifyLocalReconciliationPublishedAsset(asset, paths.assets, uid);
  }
  validateTerminalCatalog(paths, false);
  return manifest;
}

function terminalResult(
  operation: LocalReconciliationCaptureTerminalResult['operation'],
  status: LocalReconciliationCaptureTerminalResult['status'],
  terminal: ReturnType<typeof readTerminal>,
  head: Readonly<LocalCutoverInstanceHead>,
): Readonly<LocalReconciliationCaptureTerminalResult> {
  return Object.freeze({
    schemaVersion: 1 as const,
    operation,
    status,
    state: 'reconciliation_captured' as const,
    captureId: terminal.receipt.captureId,
    bundleDigest: terminal.receipt.bundleDigest,
    profile: terminal.receipt.profile,
    assetCount: terminal.receipt.assetCount,
    totalBytes: terminal.receipt.totalBytes,
    instanceHeadDigest: head.headDigest,
  });
}

function advanceCapturedHead(
  intent: Readonly<LocalReconciliationCaptureIntent>,
  uid: number,
  committedAtMs: number,
  bundleDigest: string,
): Readonly<LocalCutoverInstanceHead> {
  return advanceLocalCutoverInstanceHead(
    {
      options: {
        deploymentRoot: intent.command.options.deploymentRoot,
      },
      request: {
        cutoverId: intent.command.request.cutoverId,
        profile: intent.command.request.profile,
        instanceId: intent.command.request.instanceId,
        expectedActivationDigest:
          intent.command.request.expectedActivationDigest,
        requestedAtMs: committedAtMs,
      },
    },
    uid,
    'reconciliation_captured',
    intent.command.request.generation,
    bundleDigest,
  );
}

export function commitLocalReconciliationCapture(
  input: unknown,
  dependencies: LocalReconciliationCaptureDependencies = {},
): Readonly<LocalReconciliationCaptureTerminalResult> {
  const command = normalizeLocalReconciliationCaptureCommitCommand(input);
  const identity = currentIdentity();
  validatePrivateDirectory(
    command.options.deploymentRoot,
    identity.uid,
    'deploymentRoot',
  );
  validatePrivateDirectory(
    command.options.captureRoot,
    identity.uid,
    'captureRoot',
  );
  const intent = readLocalReconciliationCaptureIntent(
    command.options.captureRoot,
    command.request.captureId,
  );
  validateIntentBinding(intent, command);
  const paths = capturePaths(
    command.options.captureRoot,
    command.request.captureId,
  );
  validatePrivateDirectory(paths.root, identity.uid, 'captureDirectory');
  validatePrivateDirectory(
    paths.staging,
    identity.uid,
    'captureStagingDirectory',
  );
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.command.request.instanceId,
    identity.uid,
  );
  validateHeadIdentity(head, intent);
  if (fs.existsSync(paths.receipt)) {
    const manifest = normalizeLocalReconciliationCaptureManifest(
      readPrivateLocalCommandFile(paths.manifest),
    );
    sealTerminalAssets(
      paths,
      manifest,
      identity.uid,
      dependencies.afterAssetSealed,
    );
    dependencies.afterAssetsSealed?.();
    const terminal = readTerminal(paths, identity.uid);
    if (
      terminal.receipt.preparationDigest !== intent.preparationDigest ||
      terminal.receipt.committedAtMs !== command.request.committedAtMs ||
      (head.state !== 'reconciliation_capture_prepared' &&
        head.state !== 'reconciliation_captured') ||
      (head.state === 'reconciliation_capture_prepared' &&
        head.sourceRecordDigest !== intent.preparationDigest) ||
      (head.state === 'reconciliation_captured' &&
        head.sourceRecordDigest !== terminal.receipt.bundleDigest)
    ) {
      configurationError('terminal capture lost its instance head binding');
    }
    const terminalHead =
      head.state === 'reconciliation_captured'
        ? head
        : advanceCapturedHead(
            intent,
            identity.uid,
            terminal.receipt.committedAtMs,
            terminal.receipt.bundleDigest,
          );
    return terminalResult(
      command.operation,
      head.state === 'reconciliation_captured' ? 'existing' : 'prepared',
      terminal,
      terminalHead,
    );
  }
  if (
    head.state !== 'reconciliation_capture_prepared' ||
    head.sourceRecordDigest !== intent.preparationDigest
  ) {
    configurationError('capture commit lost the prepared instance head fence');
  }
  if (fs.existsSync(paths.manifest)) {
    const manifest = readPublishedManifest(paths, identity.uid);
    if (
      manifest.captureId !== command.request.captureId ||
      manifest.profile !== intent.command.request.profile ||
      manifest.preparationDigest !== intent.preparationDigest ||
      manifest.stoppedRecordDigest !==
        intent.command.request.expectedStoppedRecordDigest ||
      manifest.stoppedProofDigest !== intent.stoppedProofDigest ||
      manifest.reconciliationEvidenceDigest !==
        intent.reconciliationEvidenceDigest ||
      manifest.lineageProjectionDigest !== intent.lineage.projectionDigest ||
      manifest.legacyBaselineSha256 !== intent.lineage.sourceSha256 ||
      manifest.targetBaselineSha256 !== intent.lineage.targetSha256 ||
      manifest.preparedHeadDigest !== head.headDigest ||
      manifest.committedAtMs !== command.request.committedAtMs
    ) {
      configurationError('published capture manifest lost its preparation');
    }
    const receipt = captureReceipt(manifest);
    publishExactFile(
      paths.receipt,
      receiptContents(receipt),
      0o600,
      identity.uid,
      'reconciliation capture receipt',
    );
    dependencies.afterReceiptPublished?.();
    sealTerminalAssets(
      paths,
      manifest,
      identity.uid,
      dependencies.afterAssetSealed,
    );
    dependencies.afterAssetsSealed?.();
    const terminal = readTerminal(paths, identity.uid);
    const terminalHead = advanceCapturedHead(
      intent,
      identity.uid,
      manifest.committedAtMs,
      receipt.bundleDigest,
    );
    return terminalResult(
      command.operation,
      'prepared',
      terminal,
      terminalHead,
    );
  }
  const stoppedBefore = proveLocalReconciliationStoppedState(
    intent.command,
    identity.uid,
  );
  const lineageBefore = proveLocalReconciliationLineage(
    intent.command,
    identity.uid,
  );
  if (
    stoppedBefore.proofDigest !== intent.stoppedProofDigest ||
    stoppedBefore.reconciliationEvidenceDigest !==
      intent.reconciliationEvidenceDigest ||
    lineageBefore.projectionDigest !== intent.lineage.projectionDigest
  ) {
    configurationError('capture source lineage drifted before copy');
  }
  ensurePrivateDirectory(paths.assets, identity.uid, 'captureAssetsDirectory');
  validateTerminalCatalog(paths, false);
  const plan = localReconciliationCaptureAssetPlan(intent);
  const copied = plan.assets.map((asset) => {
    const result = copyLocalReconciliationAsset(
      asset,
      paths.assets,
      identity.uid,
      dependencies.stableCopy,
    );
    dependencies.afterAssetPublished?.(asset.logicalName);
    return result;
  });
  for (const result of copied) {
    verifyLocalReconciliationSourceSnapshot(result.sourceSnapshot);
  }
  verifyLocalReconciliationSidecarPlan(
    intent,
    plan.targetSidecars,
    plan.legacySidecars,
  );
  const recovery = copied.find(
    (result) => result.manifest.logicalName === 'recovery-main',
  );
  if (
    recovery === undefined ||
    recovery.manifest.sha256 !== intent.lineage.recoverySha256
  ) {
    configurationError('captured recovery database drifted from activation');
  }
  const stoppedAfter = proveLocalReconciliationStoppedState(
    intent.command,
    identity.uid,
  );
  const lineageAfter = proveLocalReconciliationLineage(
    intent.command,
    identity.uid,
  );
  if (
    stoppedAfter.proofDigest !== stoppedBefore.proofDigest ||
    lineageAfter.projectionDigest !== lineageBefore.projectionDigest
  ) {
    configurationError('capture source lineage changed during copy');
  }
  const assets = Object.freeze(copied.map((result) => result.manifest));
  const totalBytes = assets.reduce((total, asset) => total + asset.bytes, 0);
  const manifestPayload = Object.freeze({
    schema: MANIFEST_SCHEMA,
    schemaVersion: 2 as const,
    state: 'reconciliation_captured' as const,
    captureId: command.request.captureId,
    profile: intent.command.request.profile,
    preparationDigest: intent.preparationDigest,
    stoppedRecordDigest: intent.command.request.expectedStoppedRecordDigest,
    stoppedProofDigest: intent.stoppedProofDigest,
    reconciliationEvidenceDigest: intent.reconciliationEvidenceDigest,
    lineageProjectionDigest: intent.lineage.projectionDigest,
    legacyBaselineSha256: intent.lineage.sourceSha256,
    targetBaselineSha256: intent.lineage.targetSha256,
    preparedHeadDigest: head.headDigest,
    committedAtMs: command.request.committedAtMs,
    assets,
    totalBytes,
  });
  const manifest: Readonly<LocalReconciliationCaptureManifest> = Object.freeze({
    ...manifestPayload,
    manifestDigest: cutoverDigest(manifestPayload),
  });
  publishExactFile(
    paths.manifest,
    manifestContents(manifest),
    0o600,
    identity.uid,
    'reconciliation capture manifest',
  );
  dependencies.afterManifestPublished?.();
  const receipt = captureReceipt(manifest);
  publishExactFile(
    paths.receipt,
    receiptContents(receipt),
    0o600,
    identity.uid,
    'reconciliation capture receipt',
  );
  dependencies.afterReceiptPublished?.();
  sealTerminalAssets(
    paths,
    manifest,
    identity.uid,
    dependencies.afterAssetSealed,
  );
  dependencies.afterAssetsSealed?.();
  const terminal = readTerminal(paths, identity.uid);
  const terminalHead = advanceCapturedHead(
    intent,
    identity.uid,
    command.request.committedAtMs,
    receipt.bundleDigest,
  );
  return terminalResult(command.operation, 'prepared', terminal, terminalHead);
}

export function verifyLocalReconciliationCapture(
  input: unknown,
): Readonly<LocalReconciliationCaptureTerminalResult> {
  const command = normalizeLocalReconciliationCaptureVerifyCommand(input);
  const identity = currentIdentity();
  validatePrivateDirectory(
    command.options.deploymentRoot,
    identity.uid,
    'deploymentRoot',
  );
  validatePrivateDirectory(
    command.options.captureRoot,
    identity.uid,
    'captureRoot',
  );
  const intent = readLocalReconciliationCaptureIntent(
    command.options.captureRoot,
    command.request.captureId,
  );
  if (
    intent.command.options.deploymentRoot !== command.options.deploymentRoot ||
    intent.command.options.captureRoot !== command.options.captureRoot ||
    intent.command.options.allowRootService !==
      command.options.allowRootService ||
    intent.command.request.captureId !== command.request.captureId
  ) {
    configurationError('capture verify is detached from preparation');
  }
  const terminal = readTerminal(
    capturePaths(command.options.captureRoot, command.request.captureId),
    identity.uid,
  );
  if (
    terminal.receipt.bundleDigest !== command.request.expectedBundleDigest ||
    terminal.receipt.preparationDigest !== intent.preparationDigest
  ) {
    configurationError('capture verify expected bundle drifted');
  }
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.command.request.instanceId,
    identity.uid,
  );
  validateHeadIdentity(head, intent);
  if (
    head.state !== 'reconciliation_captured' ||
    head.sourceRecordDigest !== terminal.receipt.bundleDigest
  ) {
    configurationError('capture verify lost the terminal instance head');
  }
  return terminalResult(command.operation, 'verified', terminal, head);
}

export function commitLocalReconciliationCaptureCommandFile(
  filePath: string,
): Readonly<LocalReconciliationCaptureTerminalResult> {
  return commitLocalReconciliationCapture(
    readPrivateLocalCommandFile(filePath),
  );
}

export function verifyLocalReconciliationCaptureCommandFile(
  filePath: string,
): Readonly<LocalReconciliationCaptureTerminalResult> {
  return verifyLocalReconciliationCapture(
    readPrivateLocalCommandFile(filePath),
  );
}
