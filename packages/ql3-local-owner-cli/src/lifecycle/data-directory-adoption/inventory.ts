import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION,
  LocalDataDirectoryAdoptionConfigurationError,
  normalizeInspectLocalDataDirectoryAdoptionCommand,
  type InspectLocalDataDirectoryAdoptionCommand,
} from './contract';

const HASH_BUFFER_BYTES = 64 * 1024;
const MAX_RELATIVE_PATH_BYTES = 4_096;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

type DataDirectoryDisposition =
  | 'copy_reviewed'
  | 'transform'
  | 'retain_external'
  | 'regenerate';

type DataDirectoryInspection = 'recursive_content' | 'root_only';

interface CategoryPolicy {
  readonly name: string;
  readonly disposition: DataDirectoryDisposition;
  readonly inspection: DataDirectoryInspection;
}

interface InventoryBudget {
  readonly maxEntries: number;
  readonly maxHashedBytes: number;
  readonly maxFileBytes: number;
  readonly maxDepth: number;
}

interface MutableCategorySummary {
  entries: number;
  directories: number;
  regularFiles: number;
  logicalBytes: number;
  allocatedBytes: number;
  broadReadableEntries: number;
  unsafeEntries: number;
  activeSqliteSidecars: number;
  primaryDatabaseFiles: number;
  legacyKeyValueDatabaseFiles: number;
  hashedBytes: number;
}

export interface LocalDataDirectoryCategoryEvidence {
  readonly name: string;
  readonly disposition: DataDirectoryDisposition;
  readonly inspection: DataDirectoryInspection;
  readonly present: boolean;
  readonly entries: number;
  readonly directories: number;
  readonly regularFiles: number;
  readonly logicalBytes: number | null;
  readonly allocatedBytes: number | null;
  readonly broadReadableEntries: number;
  readonly unsafeEntries: number;
  readonly activeSqliteSidecars: number;
  readonly primaryDatabaseFiles: number;
  readonly legacyKeyValueDatabaseFiles: number;
  readonly contentDigest: string;
}

export interface LocalDataDirectoryAdoptionEvidence {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-data-directory-adoption-plan';
  readonly profile: 'edge' | 'standalone';
  readonly policyVersion: 1;
  readonly dataRootPathDigest: string;
  readonly budget: Readonly<InventoryBudget>;
  readonly assessment: 'reviewable' | 'manual_review';
  readonly categories: readonly LocalDataDirectoryCategoryEvidence[];
  readonly unknownTopLevelEntries: number;
  readonly unknownTopLevelDigest: string;
  readonly totalInspectedEntries: number;
  readonly totalHashedBytes: number;
  readonly totalUnsafeEntries: number;
  readonly planDigest: string;
}

export interface LocalDataDirectoryAdoptionInspectResult {
  readonly schemaVersion: 1;
  readonly operation: typeof LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION;
  readonly status: 'inspected';
  readonly evidence: Readonly<LocalDataDirectoryAdoptionEvidence>;
}

const POLICIES: readonly CategoryPolicy[] = Object.freeze([
  Object.freeze({
    name: 'config',
    disposition: 'transform',
    inspection: 'recursive_content',
  }),
  Object.freeze({
    name: 'scripts',
    disposition: 'copy_reviewed',
    inspection: 'recursive_content',
  }),
  Object.freeze({
    name: 'db',
    disposition: 'transform',
    inspection: 'recursive_content',
  }),
  Object.freeze({
    name: 'upload',
    disposition: 'copy_reviewed',
    inspection: 'recursive_content',
  }),
  Object.freeze({
    name: 'ssh.d',
    disposition: 'transform',
    inspection: 'recursive_content',
  }),
  Object.freeze({
    name: 'log',
    disposition: 'retain_external',
    inspection: 'root_only',
  }),
  Object.freeze({
    name: 'syslog',
    disposition: 'retain_external',
    inspection: 'root_only',
  }),
  Object.freeze({
    name: 'bak',
    disposition: 'retain_external',
    inspection: 'root_only',
  }),
  Object.freeze({
    name: 'repo',
    disposition: 'regenerate',
    inspection: 'root_only',
  }),
  Object.freeze({
    name: 'raw',
    disposition: 'regenerate',
    inspection: 'root_only',
  }),
  Object.freeze({
    name: 'dep_cache',
    disposition: 'regenerate',
    inspection: 'root_only',
  }),
  Object.freeze({
    name: 'deps',
    disposition: 'regenerate',
    inspection: 'root_only',
  }),
]);

const EMPTY_DIGEST = crypto.createHash('sha256').digest('hex');

function digestText(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function budget(profile: 'edge' | 'standalone'): Readonly<InventoryBudget> {
  return Object.freeze(
    profile === 'edge'
      ? {
          maxEntries: 8_192,
          maxHashedBytes: 512 * 1024 * 1024,
          maxFileBytes: 64 * 1024 * 1024,
          maxDepth: 32,
        }
      : {
          maxEntries: 65_536,
          maxHashedBytes: 4 * 1024 * 1024 * 1024,
          maxFileBytes: 512 * 1024 * 1024,
          maxDepth: 64,
        },
  );
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'POSIX ownership is unavailable',
    );
  }
  return process.getuid();
}

function sameStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function stableRoot(dataRoot: string, uid: number): fs.BigIntStats {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(dataRoot, { bigint: true });
  } catch (error) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'dataRoot is unavailable',
      error,
    );
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== BigInt(uid) ||
    (stat.mode & 0o022n) !== 0n ||
    fs.realpathSync(dataRoot) !== dataRoot
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'dataRoot must be an owner-controlled canonical directory',
    );
  }
  return stat;
}

function sortedDirectoryNames(
  directoryPath: string,
  maxNames: number,
): readonly string[] {
  const directory = fs.opendirSync(directoryPath);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > maxNames) {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'data directory entry count exceeds the Profile budget',
        );
      }
    }
  } finally {
    directory.closeSync();
  }
  return names.sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );
}

function relativePath(base: string, candidate: string): string {
  const relative = path.relative(base, candidate);
  if (
    relative.length < 1 ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    Buffer.byteLength(relative, 'utf8') > MAX_RELATIVE_PATH_BYTES
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'data directory entry path is invalid or too long',
    );
  }
  return relative.split(path.sep).join('/');
}

function updateMetadata(
  hash: crypto.Hash,
  relative: string,
  stat: fs.BigIntStats,
  kind: string,
  contentDigest?: string,
): void {
  hash.update(
    `${JSON.stringify({
      relative,
      kind,
      mode: (stat.mode & 0o777n).toString(8),
      uid: stat.uid.toString(),
      links: stat.nlink.toString(),
      bytes: stat.size.toString(),
      modifiedAtNs: stat.mtimeNs.toString(),
      changedAtNs: stat.ctimeNs.toString(),
      ...(contentDigest === undefined ? {} : { contentDigest }),
    })}\n`,
    'utf8',
  );
}

function stableFileDigest(filePath: string, expected: fs.BigIntStats): string {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStat(expected, before) || !before.isFile()) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'data directory file identity changed before inspection',
      );
    }
    const hash = crypto.createHash('sha256');
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStat(before, after)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'data directory file changed during inspection',
      );
    }
    return hash.digest('hex');
  } finally {
    buffer.fill(0);
    fs.closeSync(descriptor);
  }
}

function mutableSummary(): MutableCategorySummary {
  return {
    entries: 0,
    directories: 0,
    regularFiles: 0,
    logicalBytes: 0,
    allocatedBytes: 0,
    broadReadableEntries: 0,
    unsafeEntries: 0,
    activeSqliteSidecars: 0,
    primaryDatabaseFiles: 0,
    legacyKeyValueDatabaseFiles: 0,
    hashedBytes: 0,
  };
}

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      `${label} exceeds the supported numeric range`,
    );
  }
  return Number(value);
}

function addEntryBytes(
  summary: MutableCategorySummary,
  stat: fs.BigIntStats,
): void {
  const logical = safeNumber(stat.size, 'entry bytes');
  const allocated = safeNumber(stat.blocks * 512n, 'allocated entry bytes');
  if (
    !Number.isSafeInteger(summary.logicalBytes + logical) ||
    !Number.isSafeInteger(summary.allocatedBytes + allocated)
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'category byte total exceeds the supported numeric range',
    );
  }
  summary.logicalBytes += logical;
  summary.allocatedBytes += allocated;
}

function inspectRecursiveCategory(
  dataRoot: string,
  categoryRoot: string,
  rootStat: fs.BigIntStats,
  uid: number,
  limits: Readonly<InventoryBudget>,
  shared: { entries: number; hashedBytes: number },
): Readonly<{
  summary: MutableCategorySummary;
  contentDigest: string;
}> {
  const summary = mutableSummary();
  const hash = crypto.createHash('sha256');

  const visitDirectory = (
    directoryPath: string,
    expected: fs.BigIntStats,
    depth: number,
  ): void => {
    if (depth > limits.maxDepth) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'data directory depth exceeds the Profile budget',
      );
    }
    const names = sortedDirectoryNames(
      directoryPath,
      limits.maxEntries - shared.entries,
    );
    for (const name of names) {
      const entryPath = path.join(directoryPath, name);
      const relative = relativePath(dataRoot, entryPath);
      const stat = fs.lstatSync(entryPath, { bigint: true });
      shared.entries += 1;
      summary.entries += 1;
      if (shared.entries > limits.maxEntries) {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'data directory entry count exceeds the Profile budget',
        );
      }
      addEntryBytes(summary, stat);
      const mode = stat.mode & 0o777n;
      if ((mode & 0o044n) !== 0n) summary.broadReadableEntries += 1;
      const unsafeIdentity =
        stat.uid !== BigInt(uid) ||
        (mode & 0o022n) !== 0n ||
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1n);
      if (unsafeIdentity) {
        summary.unsafeEntries += 1;
        updateMetadata(hash, relative, stat, 'unsafe');
        continue;
      }
      if (stat.isDirectory()) {
        summary.directories += 1;
        updateMetadata(hash, relative, stat, 'directory');
        visitDirectory(entryPath, stat, depth + 1);
        const after = fs.lstatSync(entryPath, { bigint: true });
        if (!sameStat(stat, after)) {
          throw new LocalDataDirectoryAdoptionConfigurationError(
            'data directory changed during inspection',
          );
        }
        continue;
      }
      const size = safeNumber(stat.size, 'file bytes');
      if (size > limits.maxFileBytes) {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'data directory file exceeds the Profile budget',
        );
      }
      if (shared.hashedBytes + size > limits.maxHashedBytes) {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'data directory hashed bytes exceed the Profile budget',
        );
      }
      shared.hashedBytes += size;
      summary.hashedBytes += size;
      summary.regularFiles += 1;
      const baseName = path.basename(entryPath);
      if (relative === 'db/database.sqlite') summary.primaryDatabaseFiles += 1;
      if (relative === 'db/keyv.sqlite')
        summary.legacyKeyValueDatabaseFiles += 1;
      if (/^(?:database|keyv)\.sqlite-(?:wal|shm|journal)$/.test(baseName)) {
        summary.activeSqliteSidecars += 1;
      }
      updateMetadata(
        hash,
        relative,
        stat,
        'file',
        stableFileDigest(entryPath, stat),
      );
    }
    const after = fs.lstatSync(directoryPath, { bigint: true });
    if (!sameStat(expected, after)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'data directory changed during inspection',
      );
    }
  };

  visitDirectory(categoryRoot, rootStat, 1);
  return Object.freeze({ summary, contentDigest: hash.digest('hex') });
}

function inspectCategory(
  policy: Readonly<CategoryPolicy>,
  dataRoot: string,
  uid: number,
  limits: Readonly<InventoryBudget>,
  shared: { entries: number; hashedBytes: number },
): Readonly<LocalDataDirectoryCategoryEvidence> {
  const categoryRoot = path.join(dataRoot, policy.name);
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(categoryRoot, { bigint: true });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return Object.freeze({
        ...policy,
        present: false,
        entries: 0,
        directories: 0,
        regularFiles: 0,
        logicalBytes: policy.inspection === 'root_only' ? null : 0,
        allocatedBytes: policy.inspection === 'root_only' ? null : 0,
        broadReadableEntries: 0,
        unsafeEntries: 0,
        activeSqliteSidecars: 0,
        primaryDatabaseFiles: 0,
        legacyKeyValueDatabaseFiles: 0,
        contentDigest: EMPTY_DIGEST,
      });
    }
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'data category is unavailable',
      error,
    );
  }
  const mode = stat.mode & 0o777n;
  const safeDirectory =
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.uid === BigInt(uid) &&
    (mode & 0o022n) === 0n;
  if (!safeDirectory || policy.inspection === 'root_only') {
    const evidence = Object.freeze({
      ...policy,
      present: true,
      entries: 0,
      directories: 0,
      regularFiles: 0,
      logicalBytes: null,
      allocatedBytes: null,
      broadReadableEntries: (mode & 0o044n) !== 0n ? 1 : 0,
      unsafeEntries: safeDirectory ? 0 : 1,
      activeSqliteSidecars: 0,
      primaryDatabaseFiles: 0,
      legacyKeyValueDatabaseFiles: 0,
      contentDigest: digestText(
        JSON.stringify({
          category: policy.name,
          mode: mode.toString(8),
          uid: stat.uid.toString(),
          kind: safeDirectory ? 'directory' : 'unsafe',
        }),
      ),
    });
    const after = fs.lstatSync(categoryRoot, { bigint: true });
    if (!sameStat(stat, after)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'data category changed during inspection',
      );
    }
    return evidence;
  }
  const inspected = inspectRecursiveCategory(
    dataRoot,
    categoryRoot,
    stat,
    uid,
    limits,
    shared,
  );
  return Object.freeze({
    ...policy,
    present: true,
    entries: inspected.summary.entries,
    directories: inspected.summary.directories,
    regularFiles: inspected.summary.regularFiles,
    logicalBytes: inspected.summary.logicalBytes,
    allocatedBytes: inspected.summary.allocatedBytes,
    broadReadableEntries: inspected.summary.broadReadableEntries,
    unsafeEntries: inspected.summary.unsafeEntries,
    activeSqliteSidecars: inspected.summary.activeSqliteSidecars,
    primaryDatabaseFiles: inspected.summary.primaryDatabaseFiles,
    legacyKeyValueDatabaseFiles: inspected.summary.legacyKeyValueDatabaseFiles,
    contentDigest: inspected.contentDigest,
  });
}

function unknownTopLevelEvidence(
  dataRoot: string,
  known: ReadonlySet<string>,
  limits: Readonly<InventoryBudget>,
  shared: { entries: number; hashedBytes: number },
): Readonly<{ count: number; digest: string }> {
  const hash = crypto.createHash('sha256');
  let count = 0;
  const names = sortedDirectoryNames(
    dataRoot,
    limits.maxEntries - shared.entries + known.size,
  );
  for (const name of names) {
    if (known.has(name)) continue;
    count += 1;
    shared.entries += 1;
    if (shared.entries > limits.maxEntries) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'data directory entry count exceeds the Profile budget',
      );
    }
    const stat = fs.lstatSync(path.join(dataRoot, name), { bigint: true });
    hash.update(
      `${JSON.stringify({
        nameDigest: digestText(name),
        mode: (stat.mode & 0o777n).toString(8),
        uid: stat.uid.toString(),
        kind: stat.isDirectory()
          ? 'directory'
          : stat.isFile()
          ? 'file'
          : stat.isSymbolicLink()
          ? 'symlink'
          : 'special',
      })}\n`,
      'utf8',
    );
    const after = fs.lstatSync(path.join(dataRoot, name), { bigint: true });
    if (!sameStat(stat, after)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'unknown data directory entry changed during inspection',
      );
    }
  }
  return Object.freeze({ count, digest: hash.digest('hex') });
}

function planDigest(
  evidence: Omit<LocalDataDirectoryAdoptionEvidence, 'planDigest'>,
): string {
  return digestText(JSON.stringify(evidence));
}

export function inspectLocalDataDirectoryAdoption(
  value: unknown,
): Readonly<LocalDataDirectoryAdoptionInspectResult> {
  try {
    const command: Readonly<InspectLocalDataDirectoryAdoptionCommand> =
      normalizeInspectLocalDataDirectoryAdoptionCommand(value);
    const uid = currentUid();
    const rootBefore = stableRoot(command.options.dataRoot, uid);
    const limits = budget(command.options.profile);
    const shared = { entries: 0, hashedBytes: 0 };
    const categories = POLICIES.map((policy) =>
      inspectCategory(policy, command.options.dataRoot, uid, limits, shared),
    );
    const unknown = unknownTopLevelEvidence(
      command.options.dataRoot,
      new Set(POLICIES.map((policy) => policy.name)),
      limits,
      shared,
    );
    const rootAfter = stableRoot(command.options.dataRoot, uid);
    if (!sameStat(rootBefore, rootAfter)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'dataRoot changed during inspection',
      );
    }
    const totalUnsafeEntries = categories.reduce(
      (total, category) => total + category.unsafeEntries,
      0,
    );
    const payload = Object.freeze({
      schemaVersion: 1 as const,
      kind: 'qinglong3-legacy-data-directory-adoption-plan' as const,
      profile: command.options.profile,
      policyVersion: 1 as const,
      dataRootPathDigest: digestText(command.options.dataRoot),
      budget: limits,
      assessment:
        totalUnsafeEntries === 0 && unknown.count === 0
          ? ('reviewable' as const)
          : ('manual_review' as const),
      categories: Object.freeze(categories),
      unknownTopLevelEntries: unknown.count,
      unknownTopLevelDigest: unknown.digest,
      totalInspectedEntries: shared.entries,
      totalHashedBytes: shared.hashedBytes,
      totalUnsafeEntries,
    });
    const evidence = Object.freeze({
      ...payload,
      planDigest: planDigest(payload),
    });
    if (!DIGEST_PATTERN.test(evidence.planDigest)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'data directory plan digest is invalid',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      operation: LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION,
      status: 'inspected',
      evidence,
    });
  } catch (error) {
    if (error instanceof LocalDataDirectoryAdoptionConfigurationError) {
      throw error;
    }
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'data directory inspection failed',
      error,
    );
  }
}
