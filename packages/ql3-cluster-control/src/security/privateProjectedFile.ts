import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, relative } from 'node:path';

const MAX_ROOT_DIRECTORY_BYTES = 4096;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

export interface PrivateProjectedFileReaderOptions {
  readonly rootDirectory: string;
  readonly minimumBytes: number;
  readonly maximumBytes: number;
  readonly access: 'private_material' | 'read_only_keyring';
}

export class PrivateProjectedFileError extends Error {
  constructor(options?: ErrorOptions) {
    super('Private projected file is unavailable', options);
    this.name = 'PrivateProjectedFileError';
  }
}

function unavailable(cause?: unknown): never {
  throw new PrivateProjectedFileError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function rootDirectory(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    parse(value).root === value ||
    normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_ROOT_DIRECTORY_BYTES
  ) {
    return unavailable();
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    return unavailable();
  }
  return value;
}

function fileName(value: unknown): string {
  if (typeof value !== 'string' || !FILE_NAME_PATTERN.test(value)) {
    return unavailable();
  }
  return value;
}

function remainsBelow(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return (
    suffix.length > 0 &&
    !isAbsolute(suffix) &&
    suffix !== '..' &&
    !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}

function safeMode(
  mode: number,
  access: PrivateProjectedFileReaderOptions['access'],
): boolean {
  if ((mode & 0o111) !== 0 || (mode & 0o007) !== 0) return false;
  return access === 'private_material'
    ? (mode & 0o027) === 0
    : (mode & 0o222) === 0 && (mode & 0o440) !== 0;
}

/** Internal, no-cache reader for Kubernetes atomic-writer style projections. */
export class PrivateProjectedFileReader {
  readonly #rootDirectory: string;
  readonly #minimumBytes: number;
  readonly #maximumBytes: number;
  readonly #access: PrivateProjectedFileReaderOptions['access'];

  constructor(options: PrivateProjectedFileReaderOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      unavailable();
    }
    const normalizedRoot = rootDirectory(options.rootDirectory);
    const minimumBytes = boundedInteger(options.minimumBytes, 0);
    const maximumBytes = boundedInteger(options.maximumBytes, 1);
    if (
      maximumBytes < minimumBytes ||
      (options.access !== 'private_material' &&
        options.access !== 'read_only_keyring')
    ) {
      unavailable();
    }
    this.#rootDirectory = normalizedRoot;
    this.#minimumBytes = minimumBytes;
    this.#maximumBytes = maximumBytes;
    this.#access = options.access;
  }

  async #resolvedRoot(): Promise<string> {
    try {
      const stat = await lstat(this.#rootDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return unavailable();
      return await realpath(this.#rootDirectory);
    } catch (cause) {
      return unavailable(cause);
    }
  }

  async verify(): Promise<void> {
    await this.#resolvedRoot();
  }

  async read(name: string): Promise<Buffer> {
    const normalizedName = fileName(name);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let bytes: Buffer | undefined;
    try {
      const root = await this.#resolvedRoot();
      const candidate = join(root, normalizedName);
      const target = await realpath(candidate);
      if (!remainsBelow(root, target)) return unavailable();
      handle = await open(
        target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size < this.#minimumBytes ||
        before.size > this.#maximumBytes ||
        !safeMode(before.mode, this.#access)
      ) {
        return unavailable();
      }
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        bytes.byteLength !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        (await realpath(candidate)) !== target ||
        (await realpath(this.#rootDirectory)) !== root
      ) {
        return unavailable();
      }
      const owned = bytes;
      bytes = undefined;
      return owned;
    } catch (cause) {
      return unavailable(cause);
    } finally {
      bytes?.fill(0);
      await handle?.close().catch(() => undefined);
    }
  }
}
