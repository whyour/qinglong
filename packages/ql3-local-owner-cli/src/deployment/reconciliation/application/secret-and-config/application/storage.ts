import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  normalizePreparedReconciliationSecretConfigMaterial,
  type PreparedReconciliationSecretConfigMaterial,
} from '@qinglong/local-admin/reconciliation-secret-and-config-application';

import { LocalDeploymentConfigurationError } from '../../../../foundation/error';
import {
  preflightPublishedFile,
  publishExactFile,
} from '../../../../foundation/files';
import type {
  LocalReconciliationSecretConfigApplyIntent,
  LocalReconciliationSecretConfigApplyReceipt,
  LocalReconciliationSecretConfigMaterialEvidence,
  LocalReconciliationSecretConfigRollbackReceipt,
} from './evidence';
import {
  normalizeLocalReconciliationSecretConfigApplyIntent,
  normalizeLocalReconciliationSecretConfigApplyReceipt,
  normalizeLocalReconciliationSecretConfigRollbackReceipt,
} from './evidence';

const MAX_JSON_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_EDGE_MATERIAL_BYTES = 4 * 1024 * 1024;
const MAX_STANDALONE_MATERIAL_BYTES = 16 * 1024 * 1024;

export interface LocalReconciliationSecretConfigApplyPaths {
  readonly root: string;
  readonly backupRoot: string;
  readonly rollbackRoot: string;
  readonly intent: string;
  readonly material: string;
  readonly backup: string;
  readonly receipt: string;
  readonly rollbackReceipt: string;
  readonly rollbackSource: string;
  readonly restoreStage: string;
  readonly replaced: string;
}

function fail(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation secret config apply storage ${message}`,
    { cause },
  );
}

export function localReconciliationSecretConfigApplyPaths(
  root: string,
  secretConfigId: string,
): Readonly<LocalReconciliationSecretConfigApplyPaths> {
  const selected = path.join(root, secretConfigId);
  const backupRoot = path.join(selected, 'backup');
  const rollbackRoot = path.join(selected, 'rollback-work');
  return Object.freeze({
    root: selected,
    backupRoot,
    rollbackRoot,
    intent: path.join(selected, 'intent.json'),
    material: path.join(selected, 'materials.ndjson'),
    backup: path.join(backupRoot, 'before.sqlite'),
    receipt: path.join(selected, 'receipt.json'),
    rollbackReceipt: path.join(rollbackRoot, 'receipt.json'),
    rollbackSource: path.join(rollbackRoot, 'restore-source.sqlite'),
    restoreStage: path.join(rollbackRoot, 'restore-stage.sqlite'),
    replaced: path.join(rollbackRoot, 'replaced.sqlite'),
  });
}

function directoryMode(
  directory: string,
  uid: number,
  modes: readonly number[],
  label: string,
): number {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    return fail(`${label} is unavailable`, error);
  }
  const mode = stat.mode & 0o777;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    !modes.includes(mode) ||
    fs.realpathSync(directory) !== directory
  ) {
    fail(`${label} identity is invalid`);
  }
  return mode;
}

function ensureDirectory(directory: string, uid: number, label: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      fail(`${label} cannot be created`, error);
    }
  }
  directoryMode(directory, uid, [0o700], label);
}

export function ensureLocalReconciliationSecretConfigApplyLayout(
  selected: Readonly<LocalReconciliationSecretConfigApplyPaths>,
  uid: number,
): void {
  if (!fs.existsSync(selected.root))
    ensureDirectory(selected.root, uid, 'root');
  const rootMode = directoryMode(selected.root, uid, [0o700, 0o500], 'root');
  if (rootMode === 0o700) {
    if (!fs.existsSync(selected.backupRoot)) {
      ensureDirectory(selected.backupRoot, uid, 'backup root');
    }
    if (!fs.existsSync(selected.rollbackRoot)) {
      ensureDirectory(selected.rollbackRoot, uid, 'rollback work root');
    }
  }
  directoryMode(selected.backupRoot, uid, [0o700, 0o500], 'backup root');
  directoryMode(
    selected.rollbackRoot,
    uid,
    [0o700, 0o500],
    'rollback work root',
  );
}

export function validateLocalReconciliationSecretConfigApplyCatalog(
  selected: Readonly<LocalReconciliationSecretConfigApplyPaths>,
): void {
  const rootAllowed = new Set([
    'backup',
    'rollback-work',
    'intent.json',
    'materials.ndjson',
    'receipt.json',
    '.intent.json.ql3-deploy-stage',
    '.materials.ndjson.ql3-deploy-stage',
    '.receipt.json.ql3-deploy-stage',
  ]);
  for (const entry of fs.readdirSync(selected.root, { withFileTypes: true })) {
    if (!rootAllowed.has(entry.name) || entry.isSymbolicLink()) {
      fail('root contains unknown material');
    }
  }
  const backupAllowed = new Set([
    'before.sqlite',
    '.before.sqlite.ql3-backup-stage',
  ]);
  for (const entry of fs.readdirSync(selected.backupRoot, {
    withFileTypes: true,
  })) {
    if (!backupAllowed.has(entry.name) || entry.isSymbolicLink()) {
      fail('backup root contains unknown material');
    }
  }
  const rollbackAllowed = new Set([
    'receipt.json',
    '.receipt.json.ql3-deploy-stage',
    'restore-source.sqlite',
    'restore-stage.sqlite',
    'replaced.sqlite',
  ]);
  for (const entry of fs.readdirSync(selected.rollbackRoot, {
    withFileTypes: true,
  })) {
    if (!rollbackAllowed.has(entry.name) || entry.isSymbolicLink()) {
      fail('rollback work root contains unknown material');
    }
  }
}

function stableBytes(
  filePath: string,
  uid: number,
  modes: readonly number[],
  maximumBytes: number,
  label: string,
): Buffer {
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      !modes.includes(Number(before.mode) & 0o777) ||
      before.nlink !== 1n ||
      before.size < 2n ||
      before.size > BigInt(maximumBytes) ||
      fs.realpathSync(filePath) !== filePath
    ) {
      return fail(`${label} identity is invalid`);
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    ) {
      return fail(`${label} changed while opening`);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read < 1) {
        bytes.fill(0);
        return fail(`${label} read stalled`);
      }
      offset += read;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      bytes.fill(0);
      return fail(`${label} drifted while reading`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return fail(`${label} cannot be read`, error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function stableJson(
  filePath: string,
  uid: number,
  modes: readonly number[],
  label: string,
): unknown {
  const bytes = stableBytes(filePath, uid, modes, MAX_JSON_BYTES, label);
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    return fail(`${label} is not UTF-8 JSON`, error);
  } finally {
    bytes.fill(0);
  }
}

export function publishLocalReconciliationSecretConfigMaterials(
  selected: Readonly<LocalReconciliationSecretConfigApplyPaths>,
  materials: readonly Readonly<PreparedReconciliationSecretConfigMaterial>[],
  profile: 'edge' | 'standalone',
  uid: number,
): Readonly<LocalReconciliationSecretConfigMaterialEvidence> {
  if (materials.length < 1) fail('material set must not be empty');
  const lines = materials.map((entry, index) => {
    const normalized =
      normalizePreparedReconciliationSecretConfigMaterial(entry);
    if (normalized.ordinal !== index + 1) fail('material ordinal drifted');
    const line = `${JSON.stringify(normalized)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      fail('material line exceeds its byte bound');
    }
    return line;
  });
  const contents = lines.join('');
  const fileBytes = Buffer.byteLength(contents, 'utf8');
  const maximum =
    profile === 'edge'
      ? MAX_EDGE_MATERIAL_BYTES
      : MAX_STANDALONE_MATERIAL_BYTES;
  if (fileBytes > maximum) fail('material file exceeds its profile budget');
  const materialHash = createHash('sha256').update(
    'qinglong3.reconciliation-secret-config-material-set.v1\0',
  );
  for (const entry of materials) {
    materialHash.update('\0').update(JSON.stringify(entry));
  }
  const evidence = Object.freeze({
    fileBytes,
    fileDigest: createHash('sha256').update(contents).digest('hex'),
    secretCount: materials.length,
    activeBindingCount: materials.filter(
      (entry) => entry.disposition === 'active_binding',
    ).length,
    disabledPreservationCount: materials.filter(
      (entry) => entry.disposition === 'disabled_preservation',
    ).length,
    materialSetDigest: materialHash.digest('hex'),
  });
  preflightPublishedFile(
    selected.material,
    contents,
    0o600,
    uid,
    'secret config prepared materials',
  );
  publishExactFile(
    selected.material,
    contents,
    0o600,
    uid,
    'secret config prepared materials',
  );
  return evidence;
}

export function discardUnpreparedLocalReconciliationSecretConfigMaterials(
  selected: Readonly<LocalReconciliationSecretConfigApplyPaths>,
): void {
  if (fs.existsSync(selected.intent)) {
    fail('prepared materials are already authoritative');
  }
  if (!fs.existsSync(selected.material)) return;
  fs.unlinkSync(selected.material);
  syncDirectory(selected.root);
}

export function readLocalReconciliationSecretConfigMaterials(
  selected: Readonly<LocalReconciliationSecretConfigApplyPaths>,
  profile: 'edge' | 'standalone',
  uid: number,
  expected?: Readonly<LocalReconciliationSecretConfigMaterialEvidence>,
): readonly Readonly<PreparedReconciliationSecretConfigMaterial>[] {
  const bytes = stableBytes(
    selected.material,
    uid,
    [0o600, 0o400],
    profile === 'edge'
      ? MAX_EDGE_MATERIAL_BYTES
      : MAX_STANDALONE_MATERIAL_BYTES,
    'prepared materials',
  );
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n')) fail('material file is not newline framed');
    const rawLines = text.slice(0, -1).split('\n');
    const materials = rawLines.map((line, index) => {
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        return fail('material line exceeds its byte bound');
      }
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        return fail('material line is not JSON', error);
      }
      const normalized =
        normalizePreparedReconciliationSecretConfigMaterial(value);
      if (normalized.ordinal !== index + 1) fail('material ordinal drifted');
      return normalized;
    });
    const materialHash = createHash('sha256').update(
      'qinglong3.reconciliation-secret-config-material-set.v1\0',
    );
    for (const entry of materials) {
      materialHash.update('\0').update(JSON.stringify(entry));
    }
    const evidence = {
      fileBytes: bytes.length,
      fileDigest: createHash('sha256').update(bytes).digest('hex'),
      secretCount: materials.length,
      activeBindingCount: materials.filter(
        (entry) => entry.disposition === 'active_binding',
      ).length,
      disabledPreservationCount: materials.filter(
        (entry) => entry.disposition === 'disabled_preservation',
      ).length,
      materialSetDigest: materialHash.digest('hex'),
    };
    if (
      expected &&
      Object.keys(evidence).some(
        (key) =>
          evidence[key as keyof typeof evidence] !==
          expected[key as keyof typeof evidence],
      )
    ) {
      fail('material evidence drifted');
    }
    return Object.freeze(materials);
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return fail('material file cannot be decoded', error);
  } finally {
    bytes.fill(0);
  }
}

export function readLocalReconciliationSecretConfigApplyIntent(
  selected: Readonly<LocalReconciliationSecretConfigApplyPaths>,
  uid: number,
): Readonly<LocalReconciliationSecretConfigApplyIntent> {
  return normalizeLocalReconciliationSecretConfigApplyIntent(
    stableJson(selected.intent, uid, [0o600, 0o400], 'intent'),
  );
}

export function readLocalReconciliationSecretConfigApplyReceipt(
  selected: Readonly<LocalReconciliationSecretConfigApplyPaths>,
  uid: number,
): Readonly<LocalReconciliationSecretConfigApplyReceipt> {
  return normalizeLocalReconciliationSecretConfigApplyReceipt(
    stableJson(selected.receipt, uid, [0o600, 0o400], 'receipt'),
  );
}

export function readLocalReconciliationSecretConfigRollbackReceipt(
  selected: Readonly<LocalReconciliationSecretConfigApplyPaths>,
  uid: number,
): Readonly<LocalReconciliationSecretConfigRollbackReceipt> {
  return normalizeLocalReconciliationSecretConfigRollbackReceipt(
    stableJson(
      selected.rollbackReceipt,
      uid,
      [0o600, 0o400],
      'rollback receipt',
    ),
  );
}

function syncFile(filePath: string): void {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sealFile(filePath: string, uid: number, label: string): void {
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    stat.nlink !== 1 ||
    ![0o600, 0o400].includes(stat.mode & 0o777)
  ) {
    fail(`${label} cannot be sealed`);
  }
  if ((stat.mode & 0o777) !== 0o400) fs.chmodSync(filePath, 0o400);
  syncFile(filePath);
}

function sealDirectory(directory: string, uid: number, label: string): void {
  const mode = directoryMode(directory, uid, [0o700, 0o500], label);
  if (mode !== 0o500) fs.chmodSync(directory, 0o500);
  syncDirectory(directory);
}

function stableFileSha256(
  filePath: string,
  uid: number,
  modes: readonly number[],
  expectedBytes: number,
  expectedSha256: string,
  label: string,
): void {
  const bytes = stableBytes(filePath, uid, modes, expectedBytes, label);
  try {
    if (
      bytes.length !== expectedBytes ||
      createHash('sha256').update(bytes).digest('hex') !== expectedSha256
    ) {
      fail(`${label} digest drifted`);
    }
  } finally {
    bytes.fill(0);
  }
}

function validateBackup(
  selected: Readonly<LocalReconciliationSecretConfigApplyPaths>,
  intent: Readonly<LocalReconciliationSecretConfigApplyIntent>,
  uid: number,
  modes: readonly number[],
): void {
  stableFileSha256(
    selected.backup,
    uid,
    modes,
    intent.backup.bytes,
    intent.backup.sha256,
    'backup',
  );
}

export function sealLocalReconciliationSecretConfigAppliedStorage(
  selected: Readonly<LocalReconciliationSecretConfigApplyPaths>,
  intent: Readonly<LocalReconciliationSecretConfigApplyIntent>,
  uid: number,
): void {
  validateLocalReconciliationSecretConfigApplyCatalog(selected);
  validateBackup(selected, intent, uid, [0o600, 0o400]);
  readLocalReconciliationSecretConfigMaterials(
    selected,
    intent.profile,
    uid,
    intent.material,
  );
  if (fs.readdirSync(selected.rollbackRoot).length !== 0) {
    fail('rollback work root must be empty');
  }
  for (const [file, label] of [
    [selected.intent, 'intent'],
    [selected.material, 'materials'],
    [selected.receipt, 'receipt'],
    [selected.backup, 'backup'],
  ] as const) {
    sealFile(file, uid, label);
  }
  sealDirectory(selected.backupRoot, uid, 'backup root');
  sealDirectory(selected.root, uid, 'root');
}

export function validateLocalReconciliationSecretConfigAppliedStorage(
  selected: Readonly<LocalReconciliationSecretConfigApplyPaths>,
  intent: Readonly<LocalReconciliationSecretConfigApplyIntent>,
  uid: number,
): void {
  directoryMode(selected.root, uid, [0o500], 'root');
  directoryMode(selected.backupRoot, uid, [0o500], 'backup root');
  directoryMode(selected.rollbackRoot, uid, [0o700], 'rollback work root');
  validateLocalReconciliationSecretConfigApplyCatalog(selected);
  if (fs.readdirSync(selected.rollbackRoot).length !== 0) {
    fail('rollback work root must be empty');
  }
  readLocalReconciliationSecretConfigApplyIntent(selected, uid);
  readLocalReconciliationSecretConfigApplyReceipt(selected, uid);
  readLocalReconciliationSecretConfigMaterials(
    selected,
    intent.profile,
    uid,
    intent.material,
  );
  validateBackup(selected, intent, uid, [0o400]);
}

export function prepareLocalReconciliationSecretConfigRollbackSource(
  selected: Readonly<LocalReconciliationSecretConfigApplyPaths>,
  intent: Readonly<LocalReconciliationSecretConfigApplyIntent>,
  uid: number,
): void {
  directoryMode(selected.root, uid, [0o500], 'root');
  directoryMode(selected.backupRoot, uid, [0o500], 'backup root');
  directoryMode(selected.rollbackRoot, uid, [0o700], 'rollback work root');
  validateBackup(selected, intent, uid, [0o400]);
  if (!fs.existsSync(selected.rollbackSource)) {
    try {
      fs.copyFileSync(
        selected.backup,
        selected.rollbackSource,
        fs.constants.COPYFILE_EXCL,
      );
      fs.chmodSync(selected.rollbackSource, 0o600);
      syncFile(selected.rollbackSource);
      syncDirectory(selected.rollbackRoot);
    } catch (error) {
      if (fs.existsSync(selected.rollbackSource))
        fs.unlinkSync(selected.rollbackSource);
      fail('rollback source cannot be prepared', error);
    }
  }
  stableFileSha256(
    selected.rollbackSource,
    uid,
    [0o600],
    intent.backup.bytes,
    intent.backup.sha256,
    'rollback source',
  );
}

function unlinkIfPresent(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  fs.unlinkSync(filePath);
  syncDirectory(path.dirname(filePath));
}

export function sealLocalReconciliationSecretConfigRolledBackStorage(
  selected: Readonly<LocalReconciliationSecretConfigApplyPaths>,
  intent: Readonly<LocalReconciliationSecretConfigApplyIntent>,
  uid: number,
): void {
  validateLocalReconciliationSecretConfigApplyCatalog(selected);
  if (fs.existsSync(selected.backup)) {
    validateBackup(selected, intent, uid, [0o400]);
  }
  for (const temporary of [
    selected.restoreStage,
    selected.replaced,
    selected.rollbackSource,
  ]) {
    unlinkIfPresent(temporary);
  }
  if ((fs.statSync(selected.backupRoot).mode & 0o777) !== 0o700) {
    fs.chmodSync(selected.backupRoot, 0o700);
    syncDirectory(selected.root);
  }
  unlinkIfPresent(selected.backup);
  for (const [file, label] of [
    [selected.intent, 'intent'],
    [selected.material, 'materials'],
    [selected.receipt, 'receipt'],
    [selected.rollbackReceipt, 'rollback receipt'],
  ] as const) {
    sealFile(file, uid, label);
  }
  sealDirectory(selected.backupRoot, uid, 'backup root');
  sealDirectory(selected.rollbackRoot, uid, 'rollback work root');
  sealDirectory(selected.root, uid, 'root');
}

export function validateLocalReconciliationSecretConfigRolledBackStorage(
  selected: Readonly<LocalReconciliationSecretConfigApplyPaths>,
  intent: Readonly<LocalReconciliationSecretConfigApplyIntent>,
  uid: number,
): void {
  directoryMode(selected.root, uid, [0o500], 'root');
  directoryMode(selected.backupRoot, uid, [0o500], 'backup root');
  directoryMode(selected.rollbackRoot, uid, [0o500], 'rollback work root');
  validateLocalReconciliationSecretConfigApplyCatalog(selected);
  if (fs.readdirSync(selected.backupRoot).length !== 0) {
    fail('sealed backup root is not empty');
  }
  if (
    fs
      .readdirSync(selected.rollbackRoot)
      .some((entry) => entry !== 'receipt.json')
  ) {
    fail('sealed rollback work root contains temporary material');
  }
  readLocalReconciliationSecretConfigApplyIntent(selected, uid);
  readLocalReconciliationSecretConfigApplyReceipt(selected, uid);
  readLocalReconciliationSecretConfigRollbackReceipt(selected, uid);
  readLocalReconciliationSecretConfigMaterials(
    selected,
    intent.profile,
    uid,
    intent.material,
  );
}
