import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { promisify } from 'util';
import { brotliCompress, brotliDecompress, constants } from 'zlib';
import { lock } from 'proper-lockfile';
import { resolveFileAccess } from './fileAccess';
import { getUniqueLockPath } from './utils';

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);
const hash = (content: string) =>
  createHash('sha256').update(content).digest('hex');

export const SCRIPT_HISTORY_LIMITS = {
  versions: 20,
  fileBytes: 1024 * 1024,
  unpackedBytes: 8 * 1024 * 1024,
  archiveBytes: 2 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  files: 1000,
};

type Source = 'baseline' | 'save' | 'restore' | 'external';
interface Version {
  id: string;
  createdAt: string;
  source: Source;
  hash: string;
  content: string;
}
interface Archive {
  format: 1;
  path: string;
  versions: Version[];
  head?: { hash: string; createdAt: string; source: Source };
}

export class ScriptHistoryError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class HistoryUnavailableError extends ScriptHistoryError {
  constructor(public currentHash: string) {
    super(413, '历史版本仅支持不超过 1 MiB 的 UTF-8 文本脚本');
  }
}
interface SaveOptions {
  skipHistory?: boolean;
  expectedHash?: string;
}

/** Lazy, bounded storage: no watcher, database, daemon, or in-memory cache.
 * Full snapshots share a Brotli window, so similar revisions compress together
 * without a patch chain. All mutations use the existing script lock and a
 * cross-process archive lock. History is durable before overwriting the script. */
export class ScriptHistory {
  constructor(
    private scriptRoot: string,
    private historyRoot: string,
    private blacklist: string[] = [],
    private limits = SCRIPT_HISTORY_LIMITS,
  ) {}

  private async target(directory: string, filename: string) {
    const candidate = resolveFileAccess(
      this.scriptRoot,
      [directory, filename],
      this.blacklist,
    );
    if (!candidate) throw new ScriptHistoryError(403, '暂无权限');
    try {
      const file = await fs.realpath(candidate);
      const root = await fs.realpath(this.scriptRoot);
      const relative = path.relative(root, file);
      const key = hash(relative);
      return {
        file,
        relative,
        archive: path.join(this.historyRoot, key + '.br'),
      };
    } catch (error: any) {
      if (error.code === 'ENOENT')
        throw new ScriptHistoryError(404, '脚本不存在');
      throw error;
    }
  }

  private async readText(file: string) {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ScriptHistoryError(400, '请选择脚本文件');
      if (stat.size > this.limits.fileBytes)
        throw new ScriptHistoryError(
          413,
          '历史版本仅支持不超过 1 MiB 的 UTF-8 文本脚本',
        );
      // Bounded read even if an external process grows the file after stat.
      const bytes = Buffer.alloc(this.limits.fileBytes + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          size,
          bytes.length - size,
          null,
        );
        if (!bytesRead) break;
        size += bytesRead;
      }
      const buffer = bytes.subarray(0, size);
      const content = buffer.toString('utf8');
      if (
        size > this.limits.fileBytes ||
        content.includes('\0') ||
        !Buffer.from(content).equals(buffer)
      ) {
        throw new ScriptHistoryError(
          413,
          '历史版本仅支持不超过 1 MiB 的 UTF-8 文本脚本',
        );
      }
      return content;
    } finally {
      await handle.close();
    }
  }

  private async readArchive(file: string, relative: string): Promise<Archive> {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > this.limits.archiveBytes)
        throw new Error('Invalid archive');
      const bytes = await decompress(await fs.readFile(file), {
        maxOutputLength: this.limits.unpackedBytes,
      });
      const archive: Archive = JSON.parse(bytes.toString('utf8'));
      if (
        archive.format !== 1 ||
        archive.path !== relative ||
        !Array.isArray(archive.versions) ||
        archive.versions.length > this.limits.versions ||
        archive.versions.some(
          (v) =>
            typeof v.content !== 'string' ||
            typeof v.id !== 'string' ||
            typeof v.createdAt !== 'string' ||
            !['baseline', 'save', 'restore', 'external'].includes(v.source) ||
            Buffer.byteLength(v.content) > this.limits.fileBytes ||
            hash(v.content) !== v.hash,
        )
      ) {
        throw new Error('Invalid archive');
      }
      return archive;
    } catch (error: any) {
      if (error.code === 'ENOENT')
        return { format: 1, path: relative, versions: [] };
      throw new ScriptHistoryError(500, '历史版本读取失败，请检查历史文件');
    }
  }

  async list(directory: string, filename: string) {
    const target = await this.target(directory, filename);
    const [current, archive] = await Promise.all([
      this.readText(target.file),
      this.readArchive(target.archive, target.relative),
    ]);
    const currentHash = hash(current);
    const versions = archive.versions
      .slice()
      .reverse()
      .map(({ content, ...v }) => ({
        ...v,
        size: Buffer.byteLength(content),
        identical: v.hash === currentHash,
      }));
    return { versions, currentHash, limit: this.limits.versions };
  }

  async detail(directory: string, filename: string, id: string) {
    const target = await this.target(directory, filename);
    const [current, archive] = await Promise.all([
      this.readText(target.file),
      this.readArchive(target.archive, target.relative),
    ]);
    const version = archive.versions.find((v) => v.id === id);
    if (!version) throw new ScriptHistoryError(404, '历史版本不存在或已清理');
    return { version, current, currentHash: hash(current) };
  }

  async save(
    directory: string,
    filename: string,
    content: string,
    options: SaveOptions = {},
  ) {
    return this.mutate(directory, filename, { content, ...options });
  }

  async restore(
    directory: string,
    filename: string,
    id: string,
    expectedHash: string,
  ) {
    return this.mutate(directory, filename, { id, expectedHash });
  }

  private async mutate(
    directory: string,
    filename: string,
    change:
      | ({ content: string } & SaveOptions)
      | { id: string; expectedHash: string },
  ) {
    const target = await this.target(directory, filename);
    const releaseFile = await lock(target.file, {
      lockfilePath: getUniqueLockPath(target.file),
      retries: { retries: 20, minTimeout: 50, maxTimeout: 250 },
    });
    try {
      let current: string;
      try {
        current = await this.readText(target.file);
        if (
          'content' in change &&
          (Buffer.byteLength(change.content) > this.limits.fileBytes ||
            change.content.includes('\0'))
        ) {
          throw new ScriptHistoryError(
            413,
            '历史版本仅支持不超过 1 MiB 的 UTF-8 文本脚本',
          );
        }
      } catch (error) {
        if (
          !('content' in change) ||
          !(error instanceof ScriptHistoryError) ||
          error.status !== 413
        )
          throw error;
        // Hash oversized or non-UTF-8 files without reading them all into memory.
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(target.file))
          digest.update(chunk);
        const currentHash = digest.digest('hex');
        if (!change.skipHistory) throw new HistoryUnavailableError(currentHash);
        if (change.expectedHash !== currentHash)
          throw new ScriptHistoryError(409, '文件已变化，请刷新历史版本后重试');
        await this.preparedWrite(target.file, change.content, (commit) =>
          commit(),
        );
        return {
          content: change.content,
          changed: true,
          historyRecorded: false,
        };
      }
      if (
        ('id' in change || change.skipHistory) &&
        hash(current) !== change.expectedHash
      ) {
        throw new ScriptHistoryError(409, '文件已变化，请刷新历史版本后重试');
      }
      if ('content' in change && change.content === current)
        return { content: current, changed: false };
      await fs.mkdir(this.historyRoot, { recursive: true, mode: 0o700 });
      const releaseHistory = await lock(this.historyRoot, {
        retries: { retries: 20, minTimeout: 50, maxTimeout: 250 },
      });
      try {
        const archive = await this.readArchive(target.archive, target.relative);
        const restored =
          'id' in change
            ? archive.versions.find((v) => v.id === change.id)
            : undefined;
        if ('id' in change && !restored)
          throw new ScriptHistoryError(404, '历史版本不存在或已清理');
        const content =
          'content' in change ? change.content : restored!.content;
        if (content === current) return { content, changed: false };
        if (
          Buffer.byteLength(content) > this.limits.fileBytes ||
          content.includes('\0')
        ) {
          throw new ScriptHistoryError(
            413,
            '历史版本仅支持不超过 1 MiB 的 UTF-8 文本脚本',
          );
        }
        const currentHash = hash(current);
        if (
          archive.versions[archive.versions.length - 1]?.hash !== currentHash
        ) {
          const head =
            archive.head?.hash === currentHash ? archive.head : undefined;
          archive.versions.push({
            id: randomUUID(),
            createdAt: head?.createdAt || new Date().toISOString(),
            source:
              head?.source ||
              (archive.versions.length ? 'external' : 'baseline'),
            hash: currentHash,
            content: current,
          });
        }
        // Only prior contents are stored. Head metadata labels the next snapshot,
        // but is used only if its hash matches the file. A failed file write can
        // never introduce a phantom content version or lose the old snapshot.
        archive.head = {
          hash: hash(content),
          createdAt: new Date().toISOString(),
          source: 'id' in change ? 'restore' : 'save',
        };
        const packed = await this.pack(archive);
        const cleanupPending = await this.preparedWrite(
          target.file,
          content,
          (commit) => this.store(target.archive, packed, commit),
        );
        return {
          content,
          changed: true,
          historyRecorded: true,
          cleanupPending,
        };
      } finally {
        await releaseHistory();
      }
    } finally {
      await releaseFile();
    }
  }

  private async pack(archive: Archive) {
    archive.versions = archive.versions.slice(-this.limits.versions);
    while (true) {
      const serialized = Buffer.from(JSON.stringify(archive));
      if (serialized.length <= this.limits.unpackedBytes) {
        const compressed = await compress(serialized, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 4,
            [constants.BROTLI_PARAM_LGWIN]: 22,
          },
        });
        if (compressed.length <= this.limits.archiveBytes) return compressed;
      }
      if (archive.versions.length <= 1)
        throw new ScriptHistoryError(413, '历史版本容量不足，无法安全保存');
      archive.versions.shift();
    }
  }

  /** Stage the script before publishing history. A failed write/fsync never
   * truncates the original. Preserve the existing file's ownership and mode. */
  private async preparedWrite<T>(
    file: string,
    content: string,
    run: (commit: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const stat = await fs.stat(file);
    const temporary = path.join(
      path.dirname(file),
      `.ql-save-${randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(temporary, content, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      if (
        typeof process.getuid === 'function' &&
        typeof process.getgid === 'function' &&
        (stat.uid !== process.getuid() || stat.gid !== process.getgid())
      ) {
        await fs.chown(temporary, stat.uid, stat.gid);
      }
      await fs.chmod(temporary, stat.mode & 0o7777);
      const handle = await fs.open(temporary, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      return await run(() => fs.rename(temporary, file));
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  private async store(
    file: string,
    content: Buffer,
    commit: () => Promise<void>,
  ) {
    const entries = [];
    for (const name of await fs.readdir(this.historyRoot)) {
      if (!/^[a-f0-9]{64}\.br$/.test(name)) continue;
      const fullPath = path.join(this.historyRoot, name);
      if (fullPath === file) continue;
      const stat = await fs.lstat(fullPath);
      entries.push({ file: fullPath, size: stat.size, time: stat.mtimeMs });
    }
    entries.sort((a, b) => a.time - b.time);
    let total = entries.reduce((sum, v) => sum + v.size, content.length);
    const victims: string[] = [];
    while (
      entries.length &&
      (total > this.limits.totalBytes || entries.length >= this.limits.files)
    ) {
      const oldest = entries.shift()!;
      victims.push(oldest.file);
      total -= oldest.size;
    }
    if (total > this.limits.totalBytes)
      throw new ScriptHistoryError(413, '历史版本容量不足，无法安全保存');
    const previous = await fs.readFile(file).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const temporary = path.join(this.historyRoot, '.pending.tmp');
    const publish = async (bytes: Buffer) => {
      await fs.unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      const handle = await fs.open(temporary, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
    };
    try {
      await publish(content);
      try {
        await commit();
      } catch (error) {
        // The original script is still intact. Restore its exact history before
        // returning an error; no unrelated archive has been removed yet.
        if (previous) await publish(previous);
        else await fs.unlink(file);
        throw error;
      }
      // Quota eviction is post-commit maintenance. Report cleanup failures as a
      // warning, not a failed save (which would encourage a misleading retry).
      let cleanupPending = false;
      for (const victim of victims) {
        try {
          await fs.unlink(victim);
        } catch (error: any) {
          if (error.code !== 'ENOENT') cleanupPending = true;
        }
      }
      return cleanupPending;
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}
