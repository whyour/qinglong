import { constants, type Stats } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { MAX_LOCAL_ARTIFACT_TRUNCATION_FACT_BYTES } from '../../domain/localArtifactTruncation';
import { assertLocalExecutionArtifactId } from '../../domain/localExecutionArtifact';
import type {
  LocalArtifactFileRetirementResult,
  LocalArtifactFileRetirementStore as LocalArtifactFileRetirementStorePort,
} from '../../ports/localArtifactFileRetirementStore';
import { localArtifactTruncationFactFileName } from './localArtifactTruncationFactStore';

export class UnsafeLocalArtifactRetirementError extends Error {
  constructor() {
    super('Local Artifact retirement target is unsafe');
    this.name = 'UnsafeLocalArtifactRetirementError';
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

export class LocalArtifactFileRetirementStore
  implements LocalArtifactFileRetirementStorePort
{
  private readonly root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root) || root.includes('\0')) {
      throw new TypeError('Local Artifact retirement root must be absolute');
    }
    this.root = path.resolve(root);
  }

  async retire(
    logArtifactId: string,
  ): Promise<LocalArtifactFileRetirementResult> {
    assertLocalExecutionArtifactId(logArtifactId);
    const directory = path.join(this.root, logArtifactId.slice(6, 8));
    await this.assertDirectory(this.root);
    if (!(await this.optionalDirectory(directory))) {
      return Object.freeze({
        disposition: 'already_absent',
        bytesReclaimed: 0,
      });
    }
    const target = path.join(directory, `${logArtifactId}.log`);
    const fifo = path.join(directory, `.${logArtifactId}.log.fifo`);
    const truncation = path.join(
      directory,
      localArtifactTruncationFactFileName(logArtifactId),
    );
    const truncationTemporary = path.join(
      directory,
      `.${logArtifactId}.log.truncated.tmp`,
    );
    const [targetStat, fifoStat, truncationStat, truncationTemporaryStat] =
      await Promise.all([
        this.lstat(target),
        this.lstat(fifo),
        this.lstat(truncation),
        this.lstat(truncationTemporary),
      ]);
    if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink())) {
      throw new UnsafeLocalArtifactRetirementError();
    }
    if (
      targetStat &&
      (!Number.isSafeInteger(targetStat.size) || targetStat.size < 0)
    ) {
      throw new UnsafeLocalArtifactRetirementError();
    }
    if (fifoStat && (!fifoStat.isFIFO() || fifoStat.isSymbolicLink())) {
      throw new UnsafeLocalArtifactRetirementError();
    }
    for (const stat of [truncationStat, truncationTemporaryStat]) {
      if (
        stat &&
        (!stat.isFile() ||
          stat.isSymbolicLink() ||
          !Number.isSafeInteger(stat.size) ||
          stat.size < 0 ||
          stat.size > MAX_LOCAL_ARTIFACT_TRUNCATION_FACT_BYTES)
      ) {
        throw new UnsafeLocalArtifactRetirementError();
      }
    }
    let targetDeleted = false;
    let bytesReclaimed = 0;
    if (targetStat) {
      try {
        await fs.unlink(target);
        targetDeleted = true;
        bytesReclaimed = targetStat.size;
      } catch (error) {
        if (!isCode(error, 'ENOENT')) throw error;
      }
    }
    let auxiliaryRemoved = false;
    for (const [auxiliary, stat] of [
      [fifo, fifoStat],
      [truncation, truncationStat],
      [truncationTemporary, truncationTemporaryStat],
    ] as const) {
      if (!stat) continue;
      try {
        await fs.unlink(auxiliary);
        auxiliaryRemoved = true;
      } catch (error) {
        if (!isCode(error, 'ENOENT')) throw error;
      }
    }
    if (targetDeleted || auxiliaryRemoved) {
      await this.syncDirectory(directory);
    }
    if (!targetDeleted) {
      return Object.freeze({
        disposition: 'already_absent',
        bytesReclaimed: 0,
      });
    }
    return Object.freeze({
      disposition: 'deleted',
      bytesReclaimed,
    });
  }

  private async assertDirectory(value: string): Promise<void> {
    try {
      const stat = await fs.lstat(value);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new UnsafeLocalArtifactRetirementError();
      }
    } catch (error) {
      if (error instanceof UnsafeLocalArtifactRetirementError) throw error;
      throw new UnsafeLocalArtifactRetirementError();
    }
  }

  private async optionalDirectory(value: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(value);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new UnsafeLocalArtifactRetirementError();
      }
      return true;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return false;
      if (error instanceof UnsafeLocalArtifactRetirementError) throw error;
      throw new UnsafeLocalArtifactRetirementError();
    }
  }

  private async lstat(value: string): Promise<Stats | null> {
    try {
      return await fs.lstat(value);
    } catch (error) {
      if (isCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(
      directory,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
