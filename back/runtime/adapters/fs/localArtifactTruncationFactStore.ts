import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import {
  decodeLocalArtifactTruncationFact,
  MAX_LOCAL_ARTIFACT_TRUNCATION_FACT_BYTES,
  type LocalArtifactTruncationFact,
} from '../../domain/localArtifactTruncation';
import { assertLocalExecutionArtifactId } from '../../domain/localExecutionArtifact';
import type { LocalArtifactTruncationFactStore as LocalArtifactTruncationFactStorePort } from '../../ports/localArtifactTruncationFactStore';

export function localArtifactTruncationFactFileName(
  logArtifactId: string,
): string {
  assertLocalExecutionArtifactId(logArtifactId);
  return `.${logArtifactId}.log.truncated.json`;
}

export class UnsafeLocalArtifactTruncationFactError extends Error {
  constructor() {
    super('Local Artifact truncation fact target is unsafe');
    this.name = 'UnsafeLocalArtifactTruncationFactError';
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

export class LocalArtifactTruncationFactStore
  implements LocalArtifactTruncationFactStorePort
{
  private readonly root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root) || root.includes('\0')) {
      throw new TypeError('Local Artifact truncation root must be absolute');
    }
    this.root = path.resolve(root);
  }

  async read(
    logArtifactId: string,
  ): Promise<Readonly<LocalArtifactTruncationFact> | null> {
    assertLocalExecutionArtifactId(logArtifactId);
    const directory = path.join(this.root, logArtifactId.slice(6, 8));
    await this.assertDirectory(this.root);
    if (!(await this.optionalDirectory(directory))) return null;
    const target = path.join(
      directory,
      localArtifactTruncationFactFileName(logArtifactId),
    );
    let handle;
    try {
      handle = await fs.open(
        target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (isCode(error, 'ENOENT')) return null;
      throw new UnsafeLocalArtifactTruncationFactError();
    }
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        !Number.isSafeInteger(stat.size) ||
        stat.size < 1 ||
        stat.size > MAX_LOCAL_ARTIFACT_TRUNCATION_FACT_BYTES
      ) {
        throw new UnsafeLocalArtifactTruncationFactError();
      }
      const fact = decodeLocalArtifactTruncationFact(await handle.readFile());
      if (fact.logArtifactId !== logArtifactId) {
        throw new UnsafeLocalArtifactTruncationFactError();
      }
      return fact;
    } finally {
      await handle.close();
    }
  }

  private async assertDirectory(value: string): Promise<void> {
    try {
      const stat = await fs.lstat(value);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new UnsafeLocalArtifactTruncationFactError();
      }
    } catch (error) {
      if (error instanceof UnsafeLocalArtifactTruncationFactError) throw error;
      throw new UnsafeLocalArtifactTruncationFactError();
    }
  }

  private async optionalDirectory(value: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(value);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new UnsafeLocalArtifactTruncationFactError();
      }
      return true;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return false;
      if (error instanceof UnsafeLocalArtifactTruncationFactError) throw error;
      throw new UnsafeLocalArtifactTruncationFactError();
    }
  }
}
