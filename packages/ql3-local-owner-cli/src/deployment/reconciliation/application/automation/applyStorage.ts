import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import type {
  LocalReconciliationAutomationApplyIntent,
  LocalReconciliationAutomationApplyReceipt,
  LocalReconciliationAutomationRollbackReceipt,
} from './applyEvidence';
import {
  normalizeLocalReconciliationAutomationApplyIntent,
  normalizeLocalReconciliationAutomationApplyReceipt,
  normalizeLocalReconciliationAutomationRollbackReceipt,
} from './applyEvidence';

const MAX_EVIDENCE_BYTES = 64 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;

export interface LocalReconciliationAutomationApplyPaths {
  readonly root: string;
  readonly backupRoot: string;
  readonly rollbackRoot: string;
  readonly intent: string;
  readonly backup: string;
  readonly receipt: string;
  readonly rollbackReceipt: string;
  readonly rollbackSource: string;
  readonly restoreStage: string;
  readonly replaced: string;
}

function fail(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation automation apply storage ${message}`,
    { cause },
  );
}

export function localReconciliationAutomationApplyPaths(
  root: string,
  automationId: string,
): Readonly<LocalReconciliationAutomationApplyPaths> {
  const selected = path.join(root, automationId);
  const backupRoot = path.join(selected, 'backup');
  const rollbackRoot = path.join(selected, 'rollback-work');
  return Object.freeze({
    root: selected,
    backupRoot,
    rollbackRoot,
    intent: path.join(selected, 'intent.json'),
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

export function ensureLocalReconciliationAutomationApplyLayout(
  selected: Readonly<LocalReconciliationAutomationApplyPaths>,
  uid: number,
): void {
  if (!fs.existsSync(selected.root)) {
    ensureDirectory(selected.root, uid, 'root');
  }
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

export function validateLocalReconciliationAutomationApplyLayout(
  selected: Readonly<LocalReconciliationAutomationApplyPaths>,
  uid: number,
): void {
  directoryMode(selected.root, uid, [0o700, 0o500], 'root');
  directoryMode(selected.backupRoot, uid, [0o700, 0o500], 'backup root');
  directoryMode(
    selected.rollbackRoot,
    uid,
    [0o700, 0o500],
    'rollback work root',
  );
}

export function validateLocalReconciliationAutomationApplyCatalog(
  selected: Readonly<LocalReconciliationAutomationApplyPaths>,
): void {
  const rootAllowed = new Set([
    'backup',
    'rollback-work',
    'intent.json',
    'receipt.json',
    '.intent.json.ql3-deploy-stage',
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

function stableJson(
  filePath: string,
  uid: number,
  modes: readonly number[],
  label: string,
  links: readonly bigint[] = [1n, 2n],
): unknown {
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      !modes.includes(Number(before.mode) & 0o777) ||
      !links.includes(before.nlink) ||
      before.size < 2n ||
      before.size > BigInt(MAX_EVIDENCE_BYTES)
    ) {
      fail(`${label} identity is invalid`);
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
      opened.ctimeNs !== before.ctimeNs ||
      opened.mode !== before.mode ||
      opened.nlink !== before.nlink
    ) {
      fail(`${label} changed while opening`);
    }
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) fail(`${label} read stalled`);
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      after.mode !== opened.mode ||
      after.nlink !== opened.nlink
    ) {
      fail(`${label} drifted while reading`);
    }
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return fail(`${label} cannot be read`, error);
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readLocalReconciliationAutomationApplyIntent(
  selected: Readonly<LocalReconciliationAutomationApplyPaths>,
  uid: number,
): Readonly<LocalReconciliationAutomationApplyIntent> {
  return normalizeLocalReconciliationAutomationApplyIntent(
    stableJson(selected.intent, uid, [0o600, 0o400], 'intent'),
  );
}

export function readLocalReconciliationAutomationApplyReceipt(
  selected: Readonly<LocalReconciliationAutomationApplyPaths>,
  uid: number,
): Readonly<LocalReconciliationAutomationApplyReceipt> {
  return normalizeLocalReconciliationAutomationApplyReceipt(
    stableJson(selected.receipt, uid, [0o600, 0o400], 'receipt'),
  );
}

export function readLocalReconciliationAutomationRollbackReceipt(
  selected: Readonly<LocalReconciliationAutomationApplyPaths>,
  uid: number,
): Readonly<LocalReconciliationAutomationRollbackReceipt> {
  return normalizeLocalReconciliationAutomationRollbackReceipt(
    stableJson(
      selected.rollbackReceipt,
      uid,
      [0o600, 0o400],
      'rollback receipt',
    ),
  );
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
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

function stableFileSha256(
  filePath: string,
  uid: number,
  modes: readonly number[],
  expectedBytes: number,
  expectedSha256: string,
  label: string,
): void {
  let descriptor: number | undefined;
  const buffer = Buffer.alloc(HASH_BUFFER_BYTES);
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      !modes.includes(Number(before.mode) & 0o777) ||
      before.nlink !== 1n ||
      before.size !== BigInt(expectedBytes) ||
      fs.realpathSync(filePath) !== filePath
    ) {
      fail(`${label} identity is invalid`);
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
      opened.ctimeNs !== before.ctimeNs ||
      opened.mode !== before.mode ||
      opened.nlink !== before.nlink
    ) {
      fail(`${label} changed while opening`);
    }
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < expectedBytes) {
      const count = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, expectedBytes - offset),
        offset,
      );
      if (count < 1) fail(`${label} read stalled`);
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      after.mode !== opened.mode ||
      after.nlink !== opened.nlink ||
      hash.digest('hex') !== expectedSha256
    ) {
      fail(`${label} content drifted`);
    }
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    fail(`${label} cannot be verified`, error);
  } finally {
    buffer.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function removeExactHardLink(
  targetPath: string,
  stagePath: string,
  uid: number,
  label: string,
): void {
  if (!fs.existsSync(stagePath)) return;
  const target = fs.lstatSync(targetPath, { bigint: true });
  const stage = fs.lstatSync(stagePath, { bigint: true });
  if (
    !target.isFile() ||
    !stage.isFile() ||
    target.isSymbolicLink() ||
    stage.isSymbolicLink() ||
    Number(target.uid) !== uid ||
    Number(stage.uid) !== uid ||
    target.dev !== stage.dev ||
    target.ino !== stage.ino ||
    target.nlink !== 2n ||
    stage.nlink !== 2n
  ) {
    fail(`${label} stage identity drifted`);
  }
  fs.unlinkSync(stagePath);
  syncDirectory(path.dirname(stagePath));
}

function removeExactStage(
  targetPath: string,
  uid: number,
  label: string,
): void {
  removeExactHardLink(
    targetPath,
    path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.ql3-deploy-stage`,
    ),
    uid,
    label,
  );
}

function sealFile(filePath: string, uid: number, label: string): void {
  removeExactStage(filePath, uid, label);
  const before = fs.lstatSync(filePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== uid ||
    before.nlink !== 1 ||
    ![0o600, 0o400].includes(before.mode & 0o777)
  ) {
    fail(`${label} cannot be sealed`);
  }
  if ((before.mode & 0o777) !== 0o400) fs.chmodSync(filePath, 0o400);
  syncFile(filePath);
}

function sealDirectory(directory: string, uid: number, label: string): void {
  const mode = directoryMode(directory, uid, [0o700, 0o500], label);
  if (mode !== 0o500) fs.chmodSync(directory, 0o500);
  syncDirectory(directory);
}

function emptyDirectory(directory: string, label: string): void {
  if (fs.readdirSync(directory).length !== 0) {
    fail(`${label} must be empty`);
  }
}

function validateBackup(
  selected: Readonly<LocalReconciliationAutomationApplyPaths>,
  intent: Readonly<LocalReconciliationAutomationApplyIntent>,
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

export function sealLocalReconciliationAutomationAppliedStorage(
  selected: Readonly<LocalReconciliationAutomationApplyPaths>,
  intent: Readonly<LocalReconciliationAutomationApplyIntent>,
  _receipt: Readonly<LocalReconciliationAutomationApplyReceipt>,
  uid: number,
): void {
  validateLocalReconciliationAutomationApplyLayout(selected, uid);
  validateLocalReconciliationAutomationApplyCatalog(selected);
  removeExactHardLink(
    selected.backup,
    path.join(selected.backupRoot, '.before.sqlite.ql3-backup-stage'),
    uid,
    'backup',
  );
  validateBackup(selected, intent, uid, [0o600, 0o400]);
  emptyDirectory(selected.rollbackRoot, 'rollback work root');
  sealFile(selected.intent, uid, 'intent');
  sealFile(selected.receipt, uid, 'receipt');
  sealFile(selected.backup, uid, 'backup');
  sealDirectory(selected.backupRoot, uid, 'backup root');
  sealDirectory(selected.root, uid, 'root');
  validateLocalReconciliationAutomationAppliedStorage(selected, intent, uid);
}

export function validateLocalReconciliationAutomationAppliedStorage(
  selected: Readonly<LocalReconciliationAutomationApplyPaths>,
  intent: Readonly<LocalReconciliationAutomationApplyIntent>,
  uid: number,
): void {
  directoryMode(selected.root, uid, [0o500], 'root');
  directoryMode(selected.backupRoot, uid, [0o500], 'backup root');
  directoryMode(selected.rollbackRoot, uid, [0o700], 'rollback work root');
  validateLocalReconciliationAutomationApplyCatalog(selected);
  emptyDirectory(selected.rollbackRoot, 'rollback work root');
  stableJson(selected.intent, uid, [0o400], 'intent', [1n]);
  stableJson(selected.receipt, uid, [0o400], 'receipt', [1n]);
  validateBackup(selected, intent, uid, [0o400]);
}

/**
 * Collects the rollback copy only after the cross-domain completion head is
 * durable. The operation accepts its own partially collected layout so a
 * response loss or process crash can be replayed without restoring authority.
 */
export function collectLocalReconciliationAutomationCompletedStorage(
  selected: Readonly<LocalReconciliationAutomationApplyPaths>,
  intent: Readonly<LocalReconciliationAutomationApplyIntent>,
  uid: number,
): void {
  directoryMode(selected.root, uid, [0o500], 'root');
  directoryMode(selected.backupRoot, uid, [0o700, 0o500], 'backup root');
  directoryMode(
    selected.rollbackRoot,
    uid,
    [0o700, 0o500],
    'rollback work root',
  );
  validateLocalReconciliationAutomationApplyCatalog(selected);
  emptyDirectory(selected.rollbackRoot, 'rollback work root');
  stableJson(selected.intent, uid, [0o400], 'intent', [1n]);
  stableJson(selected.receipt, uid, [0o400], 'receipt', [1n]);
  if (fs.existsSync(selected.backup)) {
    validateBackup(selected, intent, uid, [0o400]);
    if ((fs.statSync(selected.backupRoot).mode & 0o777) !== 0o700) {
      fs.chmodSync(selected.backupRoot, 0o700);
      syncDirectory(selected.root);
    }
    unlinkIfPresent(selected.backup);
  }
  sealDirectory(selected.backupRoot, uid, 'backup root');
  sealDirectory(selected.rollbackRoot, uid, 'rollback work root');
  validateLocalReconciliationAutomationCompletedStorage(selected, uid);
}

export function validateLocalReconciliationAutomationCompletedStorage(
  selected: Readonly<LocalReconciliationAutomationApplyPaths>,
  uid: number,
): void {
  directoryMode(selected.root, uid, [0o500], 'root');
  directoryMode(selected.backupRoot, uid, [0o500], 'backup root');
  directoryMode(selected.rollbackRoot, uid, [0o500], 'rollback work root');
  validateLocalReconciliationAutomationApplyCatalog(selected);
  emptyDirectory(selected.backupRoot, 'backup root');
  emptyDirectory(selected.rollbackRoot, 'rollback work root');
  stableJson(selected.intent, uid, [0o400], 'intent', [1n]);
  stableJson(selected.receipt, uid, [0o400], 'receipt', [1n]);
}

export function prepareLocalReconciliationAutomationRollbackSource(
  selected: Readonly<LocalReconciliationAutomationApplyPaths>,
  intent: Readonly<LocalReconciliationAutomationApplyIntent>,
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
      if (fs.existsSync(selected.rollbackSource)) {
        try {
          fs.unlinkSync(selected.rollbackSource);
          syncDirectory(selected.rollbackRoot);
        } catch {
          // Deterministic residue remains fail-closed for exact replay.
        }
      }
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

export function sealLocalReconciliationAutomationRolledBackStorage(
  selected: Readonly<LocalReconciliationAutomationApplyPaths>,
  intent: Readonly<LocalReconciliationAutomationApplyIntent>,
  _receipt: Readonly<LocalReconciliationAutomationApplyReceipt>,
  _rollback: Readonly<LocalReconciliationAutomationRollbackReceipt>,
  uid: number,
): void {
  validateLocalReconciliationAutomationApplyLayout(selected, uid);
  validateLocalReconciliationAutomationApplyCatalog(selected);
  if (fs.existsSync(selected.backup)) {
    validateBackup(selected, intent, uid, [0o400]);
  }
  for (const temporary of [selected.restoreStage, selected.replaced]) {
    if (fs.existsSync(temporary)) {
      fail('rollback temporary evidence remains');
    }
  }
  unlinkIfPresent(selected.rollbackSource);
  if ((fs.statSync(selected.backupRoot).mode & 0o777) !== 0o700) {
    fs.chmodSync(selected.backupRoot, 0o700);
    syncDirectory(selected.root);
  }
  unlinkIfPresent(selected.backup);
  removeExactStage(selected.rollbackReceipt, uid, 'rollback receipt');
  sealFile(selected.intent, uid, 'intent');
  sealFile(selected.receipt, uid, 'receipt');
  sealFile(selected.rollbackReceipt, uid, 'rollback receipt');
  sealDirectory(selected.backupRoot, uid, 'backup root');
  sealDirectory(selected.rollbackRoot, uid, 'rollback work root');
  sealDirectory(selected.root, uid, 'root');
  validateLocalReconciliationAutomationRolledBackStorage(selected, uid);
}

export function validateLocalReconciliationAutomationRolledBackStorage(
  selected: Readonly<LocalReconciliationAutomationApplyPaths>,
  uid: number,
): void {
  directoryMode(selected.root, uid, [0o500], 'root');
  directoryMode(selected.backupRoot, uid, [0o500], 'backup root');
  directoryMode(selected.rollbackRoot, uid, [0o500], 'rollback work root');
  validateLocalReconciliationAutomationApplyCatalog(selected);
  emptyDirectory(selected.backupRoot, 'backup root');
  if (
    fs
      .readdirSync(selected.rollbackRoot)
      .some((name) => name !== 'receipt.json')
  ) {
    fail('sealed rollback work root contains temporary material');
  }
  stableJson(selected.intent, uid, [0o400], 'intent', [1n]);
  stableJson(selected.receipt, uid, [0o400], 'receipt', [1n]);
  stableJson(selected.rollbackReceipt, uid, [0o400], 'rollback receipt', [1n]);
}
