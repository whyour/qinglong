import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import {
  assertCompletionReceiptId,
  InvalidCompletionReceiptError,
  MAX_COMPLETION_RECEIPT_BYTES,
  parseCompletionReceipt,
  serializeCompletionReceipt,
  type CompletionReceipt,
} from '../../domain/completionReceipt';
import type { CompletionReceiptStore } from '../../ports/completionReceiptStore';

export class CompletionReceiptAlreadyExistsError extends Error {
  constructor(readonly attemptId: string) {
    super(`Completion receipt already exists for Attempt ${attemptId}`);
    this.name = 'CompletionReceiptAlreadyExistsError';
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === code
  );
}

/**
 * A bounded local journal. It does not scan directories or own a lifecycle;
 * callers must discover active Attempts from the database.
 */
export class CompletionReceiptFileStore implements CompletionReceiptStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) {
      throw new RangeError('Completion receipt root must be absolute');
    }
  }

  async publish(receipt: CompletionReceipt): Promise<void> {
    const serialized = serializeCompletionReceipt(receipt);
    const directory = this.directory(receipt.attemptId);
    const target = this.target(receipt.attemptId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      directory,
      `.${receipt.attemptId}.${randomBytes(16).toString('hex')}.tmp`,
    );
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;

      // A hard link publishes the fully written inode atomically and, unlike
      // plain rename(), never replaces an existing completion fact.
      try {
        await fs.link(temporary, target);
      } catch (error) {
        if (isCode(error, 'EEXIST')) {
          throw new CompletionReceiptAlreadyExistsError(receipt.attemptId);
        }
        throw error;
      }
      await this.bestEffortUnlink(temporary);
      await this.bestEffortSyncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await this.bestEffortUnlink(temporary);
      throw error;
    }
  }

  async read(attemptId: string): Promise<CompletionReceipt | undefined> {
    const target = this.target(attemptId);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(
        target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (isCode(error, 'ENOENT')) return undefined;
      if (isCode(error, 'ELOOP')) {
        throw new InvalidCompletionReceiptError(
          'Completion receipt must not be a symbolic link',
        );
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new InvalidCompletionReceiptError(
          'Completion receipt must be a regular file',
        );
      }
      const bytes = Buffer.allocUnsafe(MAX_COMPLETION_RECEIPT_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_COMPLETION_RECEIPT_BYTES) {
        throw new InvalidCompletionReceiptError(
          'Completion receipt exceeds the byte limit',
        );
      }
      const receipt = parseCompletionReceipt(bytes.subarray(0, bytesRead));
      if (receipt.attemptId !== attemptId) {
        throw new InvalidCompletionReceiptError(
          'Completion receipt path and Attempt do not match',
        );
      }
      return receipt;
    } finally {
      await handle.close();
    }
  }

  async remove(attemptId: string): Promise<boolean> {
    const target = this.target(attemptId);
    try {
      await fs.unlink(target);
      await this.bestEffortSyncDirectory(path.dirname(target));
      return true;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  async quarantine(attemptId: string): Promise<string | undefined> {
    const target = this.target(attemptId);
    const reference = this.quarantineReference(attemptId);
    const relativeDirectory = path.dirname(reference);
    const directory = path.join(this.root, relativeDirectory);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const quarantined = path.join(this.root, reference);
    try {
      await fs.link(target, quarantined);
    } catch (error) {
      if (isCode(error, 'ENOENT')) {
        return (await this.pathExists(quarantined)) ? reference : undefined;
      }
      if (!isCode(error, 'EEXIST')) throw error;
    }
    await this.unlinkIfPresent(target);
    await this.bestEffortSyncDirectory(path.dirname(target));
    await this.bestEffortSyncDirectory(directory);
    return reference;
  }

  quarantineReference(attemptId: string): string {
    assertCompletionReceiptId(attemptId, 'attemptId');
    return path.posix.join(
      '.quarantine',
      attemptId.slice(0, 2),
      `${attemptId}.json`,
    );
  }

  async purgeQuarantine(attemptId: string): Promise<boolean> {
    const target = path.join(this.root, this.quarantineReference(attemptId));
    try {
      await fs.unlink(target);
      await this.bestEffortSyncDirectory(path.dirname(target));
      return true;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  private directory(attemptId: string): string {
    assertCompletionReceiptId(attemptId, 'attemptId');
    return path.join(this.root, attemptId.slice(0, 2));
  }

  private target(attemptId: string): string {
    return path.join(this.directory(attemptId), `${attemptId}.json`);
  }

  private async bestEffortUnlink(value: string): Promise<void> {
    try {
      await fs.unlink(value);
    } catch (error) {
      if (!isCode(error, 'ENOENT')) {
        // Temp cleanup is diagnostic-only; the immutable final fact wins.
      }
    }
  }

  private async unlinkIfPresent(value: string): Promise<void> {
    try {
      await fs.unlink(value);
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    }
  }

  private async pathExists(value: string): Promise<boolean> {
    try {
      await fs.lstat(value);
      return true;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  private async bestEffortSyncDirectory(directory: string): Promise<void> {
    try {
      const handle = await fs.open(directory, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Some supported filesystems cannot fsync directories. The receipt
      // remains restart-safe, while power-loss durability is best effort.
    }
  }
}
