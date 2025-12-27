import { lock } from 'proper-lockfile';
import os from 'os';
import path from 'path';
import { writeFile, open, chmod, FileHandle } from 'fs/promises';
import { fileExist } from '../config/util';
import Logger from '../loaders/logger';

function getUniqueLockPath(filePath: string) {
  const sanitizedPath = filePath
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^_/, '');
  return path.join(os.tmpdir(), `${sanitizedPath}.ql_lock`);
}

export async function writeFileWithLock(
  filePath: string,
  content: string,
  options: Parameters<typeof writeFile>[2] = {},
) {
  if (typeof options === 'string') {
    options = { encoding: options };
  }
  
  // Ensure file exists before locking
  if (!(await fileExist(filePath))) {
    let fileHandle: FileHandle | undefined;
    try {
      fileHandle = await open(filePath, 'w');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create file ${filePath}: ${errorMessage}`);
    } finally {
      if (fileHandle !== undefined) {
        try {
          await fileHandle.close();
        } catch (closeError) {
          // Log close error but don't throw to avoid masking the original error
          Logger.error(`Failed to close file handle for ${filePath}:`, closeError);
        }
      }
    }
  }
  
  const lockfilePath = getUniqueLockPath(filePath);
  let release: (() => Promise<void>) | undefined;

  try {
    release = await lock(filePath, {
      retries: {
        retries: 10,
        factor: 2,
        minTimeout: 100,
        maxTimeout: 3000,
      },
      lockfilePath,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to acquire lock for ${filePath}: ${errorMessage}`);
  }

  try {
    await writeFile(filePath, content, { encoding: 'utf8', ...options });
    if (options?.mode) {
      await chmod(filePath, options.mode);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write to file ${filePath}: ${errorMessage}`);
  } finally {
    if (release) {
      try {
        await release();
      } catch (error) {
        // Log but don't throw on release failure
        Logger.error(`Failed to release lock for ${filePath}:`, error);
      }
    }
  }
}
