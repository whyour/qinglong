import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { LocalSqliteProfile } from '@qinglong/local-sqlite/runtime';
import { LocalSqliteAdoptionError, type FileIdentity } from './contracts';

const MAX_PATH_BYTES = 4096;

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  const before = fs.statSync(filePath, { bigint: true });
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  const after = fs.statSync(filePath, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  ) {
    throw new LocalSqliteAdoptionError('file changed while hashing');
  }
  return hash.digest('hex');
}

export function assertProfile(
  profile: unknown,
): asserts profile is LocalSqliteProfile {
  if (profile !== 'edge' && profile !== 'standalone') {
    throw new LocalSqliteAdoptionError('profile must be edge or standalone');
  }
}

export function assertAbsolutePath(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    Buffer.byteLength(value) < 1 ||
    Buffer.byteLength(value) > MAX_PATH_BYTES ||
    value.includes('\0')
  ) {
    throw new LocalSqliteAdoptionError(
      `${label} must be a bounded absolute path`,
    );
  }
}

export function assertRealParent(filePath: string, label: string): void {
  const parent = fs.lstatSync(path.dirname(filePath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new LocalSqliteAdoptionError(
      `${label} parent must be a real directory`,
    );
  }
}

export function assertRegularFile(filePath: string, label: string): void {
  const target = fs.lstatSync(filePath);
  if (!target.isFile() || target.isSymbolicLink()) {
    throw new LocalSqliteAdoptionError(`${label} must be a regular file`);
  }
}

export function assertMissing(filePath: string, label: string): void {
  try {
    fs.lstatSync(filePath);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return;
    }
    throw error;
  }
  throw new LocalSqliteAdoptionError(`${label} already exists`);
}

export function fileIdentity(filePath: string): FileIdentity {
  const stat = fs.statSync(filePath, { bigint: true });
  if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LocalSqliteAdoptionError('source size is unsupported');
  }
  return Object.freeze({
    fileName: path.basename(filePath),
    pathDigest: sha256Text(path.resolve(filePath)),
    bytes: Number(stat.size),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    modifiedAtNs: stat.mtimeNs.toString(),
  });
}

export function sameFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertDistinctPaths(paths: readonly string[]): void {
  const normalized = paths.map((value) => path.resolve(value));
  if (new Set(normalized).size !== normalized.length) {
    throw new LocalSqliteAdoptionError(
      'source and output paths must be distinct',
    );
  }
}

export async function removeCreatedFile(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
  }
}

export function assertClock(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalSqliteAdoptionError('clock returned an invalid timestamp');
  }
  return value;
}

export async function writeManifestAtomically(
  manifestPath: string,
  manifest: object,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(manifestPath),
    `.${path.basename(manifestPath)}.${randomUUID()}.tmp`,
  );
  const handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  let destinationCreated = false;
  try {
    await fs.promises.copyFile(
      temporaryPath,
      manifestPath,
      fs.constants.COPYFILE_EXCL,
    );
    destinationCreated = true;
    await fs.promises.chmod(manifestPath, 0o600);
  } catch (error) {
    if (destinationCreated) await removeCreatedFile(manifestPath);
    throw error;
  } finally {
    await removeCreatedFile(temporaryPath);
  }
}
