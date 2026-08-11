import { createHash } from 'crypto';
import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { assertCompletionReceiptId } from '../../domain/completionReceipt';
import type {
  CompletionReceiptDirectoryEntry,
  CompletionReceiptDirectoryEntryKind,
  CompletionReceiptOrphanDirectory,
  CompletionReceiptOrphanQuarantineResult,
  CompletionReceiptShardSnapshot,
} from '../../ports/completionReceiptOrphanMaintenance';

const SHARD_PATTERN = /^[0-9a-f]{2}$/;
const TEMPORARY_PATTERN = /^\.([0-9a-f-]{36})\.[0-9a-f]{32}\.tmp$/;

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === code
  );
}

function receiptAttemptId(name: string): string | undefined {
  if (!name.endsWith('.json')) return undefined;
  const attemptId = name.slice(0, -'.json'.length);
  try {
    assertCompletionReceiptId(attemptId, 'attemptId');
    return attemptId;
  } catch {
    return undefined;
  }
}

function temporaryAttemptId(name: string): string | undefined {
  const match = TEMPORARY_PATTERN.exec(name);
  if (!match) return undefined;
  try {
    assertCompletionReceiptId(match[1], 'attemptId');
    return match[1];
  } catch {
    return undefined;
  }
}

function entryKind(
  shard: string,
  name: string,
  regularFile: boolean,
): { kind: CompletionReceiptDirectoryEntryKind; attemptId?: string } {
  if (!regularFile) return { kind: 'unsafe' };
  const finalAttemptId = receiptAttemptId(name);
  if (finalAttemptId && finalAttemptId.startsWith(shard)) {
    return { kind: 'receipt', attemptId: finalAttemptId };
  }
  const tempAttemptId = temporaryAttemptId(name);
  if (tempAttemptId && tempAttemptId.startsWith(shard)) {
    return { kind: 'temporary', attemptId: tempAttemptId };
  }
  return { kind: 'unknown' };
}

function filesystemIdentity(
  stat: Awaited<ReturnType<typeof fs.lstat>>,
): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs].join(':');
}

export class CompletionReceiptOrphanFileDirectory
  implements CompletionReceiptOrphanDirectory
{
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root) || root.includes('\0')) {
      throw new RangeError(
        'Completion receipt orphan root must be an absolute path containing no NUL',
      );
    }
    if (path.resolve(root) === path.parse(path.resolve(root)).root) {
      throw new RangeError(
        'Completion receipt orphan root must not be a filesystem root',
      );
    }
  }

  async inspectShard(
    shard: string,
    maxEntries: number,
  ): Promise<CompletionReceiptShardSnapshot> {
    if (!SHARD_PATTERN.test(shard)) {
      throw new RangeError(
        'Completion receipt shard must be two lowercase hex digits',
      );
    }
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > 64
    ) {
      throw new RangeError('maxEntries must be between 1 and 64');
    }
    const directoryPath = await this.resolveShardDirectory(shard);
    if (!directoryPath) return { shard, entries: [], overflow: false };
    const directory = await fs.opendir(directoryPath, { bufferSize: 1 });

    const entries: CompletionReceiptDirectoryEntry[] = [];
    let overflow = false;
    try {
      for await (const dirent of directory) {
        if (entries.length === maxEntries) {
          overflow = true;
          break;
        }
        const entryPath = path.join(directoryPath, dirent.name);
        let stat: Awaited<ReturnType<typeof fs.lstat>>;
        try {
          stat = await fs.lstat(entryPath);
        } catch (error) {
          if (isCode(error, 'ENOENT')) continue;
          throw error;
        }
        const classified = entryKind(shard, dirent.name, stat.isFile());
        entries.push({
          shard,
          name: dirent.name,
          kind: classified.kind,
          modifiedAtMs: Math.max(0, Math.trunc(stat.mtimeMs)),
          sizeBytes: stat.size,
          filesystemIdentity: filesystemIdentity(stat),
          ...(classified.attemptId ? { attemptId: classified.attemptId } : {}),
        });
      }
    } finally {
      await directory.close().catch((error) => {
        if (!isCode(error, 'ERR_DIR_CLOSED')) throw error;
      });
    }
    return { shard, entries, overflow };
  }

  async quarantine(
    entry: CompletionReceiptDirectoryEntry,
  ): Promise<CompletionReceiptOrphanQuarantineResult> {
    if (
      !SHARD_PATTERN.test(entry.shard) ||
      path.basename(entry.name) !== entry.name
    ) {
      throw new RangeError('Completion receipt orphan entry path is invalid');
    }
    if (entry.kind === 'unsafe') return { status: 'changed' };
    const shardDirectory = await this.resolveShardDirectory(entry.shard);
    if (!shardDirectory) return { status: 'changed' };
    const source = path.join(shardDirectory, entry.name);
    let current: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      current = await fs.lstat(source);
    } catch (error) {
      if (isCode(error, 'ENOENT')) return { status: 'changed' };
      throw error;
    }
    if (
      !current.isFile() ||
      filesystemIdentity(current) !== entry.filesystemIdentity
    ) {
      return { status: 'changed' };
    }

    const digest = createHash('sha256')
      .update(`${entry.shard}/${entry.name}\0${entry.filesystemIdentity}`)
      .digest('hex');
    const reference = path.posix.join(
      '.orphan-quarantine',
      entry.shard,
      `${digest}.entry`,
    );
    const canonicalRoot = path.dirname(shardDirectory);
    const directory = await this.ensureQuarantineDirectory(
      canonicalRoot,
      entry.shard,
    );
    const target = path.join(directory, `${digest}.entry`);
    let linkedByThisCall = false;
    try {
      await fs.link(source, target);
      linkedByThisCall = true;
    } catch (error) {
      if (!isCode(error, 'EEXIST')) {
        if (isCode(error, 'ENOENT')) return { status: 'changed' };
        throw error;
      }
      const targetStat = await fs.lstat(target);
      const sourceStat = await fs.lstat(source).catch(() => undefined);
      if (
        !sourceStat ||
        targetStat.dev !== sourceStat.dev ||
        targetStat.ino !== sourceStat.ino
      ) {
        return { status: 'changed' };
      }
    }
    let verifiedShardDirectory: string | undefined;
    try {
      verifiedShardDirectory = await this.resolveShardDirectory(entry.shard);
    } catch (error) {
      if (linkedByThisCall) await fs.unlink(target).catch(() => undefined);
      throw error;
    }
    const verifiedSource = await fs.lstat(source).catch(() => undefined);
    if (
      verifiedShardDirectory !== shardDirectory ||
      !verifiedSource ||
      filesystemIdentity(verifiedSource) !== entry.filesystemIdentity
    ) {
      if (linkedByThisCall) await fs.unlink(target).catch(() => undefined);
      return { status: 'changed' };
    }
    await fs.unlink(source);
    await this.bestEffortSync(path.dirname(source));
    await this.bestEffortSync(directory);
    return { status: 'quarantined', reference };
  }

  private async resolveShardDirectory(
    shard: string,
  ): Promise<string | undefined> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await fs.realpath(this.root);
    } catch (error) {
      if (isCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    const candidate = path.join(canonicalRoot, shard);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(candidate);
    } catch (error) {
      if (isCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        `Completion receipt shard ${shard} is not a safe directory`,
      );
    }
    const canonicalDirectory = await fs.realpath(candidate);
    if (
      path.dirname(canonicalDirectory) !== canonicalRoot ||
      path.basename(canonicalDirectory) !== shard
    ) {
      throw new Error(`Completion receipt shard ${shard} escapes its root`);
    }
    return canonicalDirectory;
  }

  private async ensureQuarantineDirectory(
    canonicalRoot: string,
    shard: string,
  ): Promise<string> {
    const quarantineRoot = path.join(canonicalRoot, '.orphan-quarantine');
    await this.ensurePrivateDirectory(quarantineRoot, canonicalRoot);
    const directory = path.join(quarantineRoot, shard);
    await this.ensurePrivateDirectory(directory, quarantineRoot);
    return directory;
  }

  private async ensurePrivateDirectory(
    directory: string,
    expectedParent: string,
  ): Promise<void> {
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
    }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        'Completion receipt quarantine path is not a safe directory',
      );
    }
    const canonicalDirectory = await fs.realpath(directory);
    if (path.dirname(canonicalDirectory) !== expectedParent) {
      throw new Error('Completion receipt quarantine path escapes its root');
    }
    await fs.chmod(directory, 0o700);
  }

  private async bestEffortSync(directory: string): Promise<void> {
    try {
      const handle = await fs.open(directory, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Directory fsync is unavailable on some supported filesystems.
    }
  }
}
