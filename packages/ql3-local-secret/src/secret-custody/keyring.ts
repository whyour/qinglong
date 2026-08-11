import { randomBytes, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LocalSecretUnavailableError,
  assertLocalSecretKeyId,
  type LocalSecretKeyMaterial,
  type LocalSecretKeyProvider,
} from '@qinglong/runtime-core/local-secret';

const MAX_KEYRING_BYTES = 16 * 1024;
const MAX_KEY_COUNT = 16;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

interface LocalSecretKeyringManifest {
  readonly version: 1;
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, string>>;
}

export interface LocalSecretKeyringSummary {
  readonly version: 1;
  readonly activeKeyId: string;
  readonly keyIds: readonly string[];
  readonly digest: string;
}

export class LocalSecretKeyringConflictError extends Error {
  readonly code = 'LOCAL_SECRET_KEYRING_CONFLICT';

  constructor() {
    super('Local Secret keyring state changed');
    this.name = 'LocalSecretKeyringConflictError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function assertKeyringPath(filePath: unknown): asserts filePath is string {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    filePath.includes('\0') ||
    Buffer.byteLength(filePath, 'utf8') > 4096
  ) {
    throw new TypeError('Local Secret keyring path must be absolute');
  }
}

function parseManifest(value: Buffer): LocalSecretKeyringManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString('utf8'));
  } catch {
    throw new LocalSecretUnavailableError();
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !exactKeys(parsed, ['activeKeyId', 'keys', 'version'])
  ) {
    throw new LocalSecretUnavailableError();
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !record.keys ||
    typeof record.keys !== 'object' ||
    Array.isArray(record.keys)
  ) {
    throw new LocalSecretUnavailableError();
  }
  try {
    assertLocalSecretKeyId(record.activeKeyId);
  } catch {
    throw new LocalSecretUnavailableError();
  }
  const entries = Object.entries(record.keys as Record<string, unknown>);
  if (entries.length < 1 || entries.length > MAX_KEY_COUNT) {
    throw new LocalSecretUnavailableError();
  }
  const keys: Record<string, string> = Object.create(null);
  for (const [keyId, encoded] of entries) {
    let decoded: Buffer | undefined;
    try {
      assertLocalSecretKeyId(keyId);
      decoded =
        typeof encoded === 'string'
          ? Buffer.from(encoded, 'base64url')
          : Buffer.alloc(0);
      if (
        typeof encoded !== 'string' ||
        !BASE64URL_PATTERN.test(encoded) ||
        decoded.length !== 32 ||
        decoded.toString('base64url') !== encoded
      ) {
        throw new LocalSecretUnavailableError();
      }
      keys[keyId] = encoded;
    } catch {
      throw new LocalSecretUnavailableError();
    } finally {
      decoded?.fill(0);
    }
  }
  if (!keys[record.activeKeyId]) {
    throw new LocalSecretUnavailableError();
  }
  return Object.freeze({
    version: 1,
    activeKeyId: record.activeKeyId,
    keys: Object.freeze(keys),
  });
}

function canonicalManifest(manifest: LocalSecretKeyringManifest): Buffer {
  const keys = Object.fromEntries(
    Object.entries(manifest.keys).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return Buffer.from(
    `${JSON.stringify({
      version: 1,
      activeKeyId: manifest.activeKeyId,
      keys,
    })}\n`,
    'utf8',
  );
}

function summary(manifest: LocalSecretKeyringManifest): LocalSecretKeyringSummary {
  const canonical = canonicalManifest(manifest);
  try {
    return Object.freeze({
      version: 1,
      activeKeyId: manifest.activeKeyId,
      keyIds: Object.freeze(Object.keys(manifest.keys).sort()),
      digest: createHash('sha256').update(canonical).digest('hex'),
    });
  } finally {
    canonical.fill(0);
  }
}

async function assertRealParent(filePath: string): Promise<void> {
  const stat = await fs.lstat(path.dirname(filePath));
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new LocalSecretUnavailableError();
  }
}

async function readManifest(filePath: string): Promise<LocalSecretKeyringManifest> {
  let file: fs.FileHandle | undefined;
  let contents: Buffer | undefined;
  try {
    file = await fs.open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 1 ||
      stat.size > MAX_KEYRING_BYTES
    ) {
      throw new LocalSecretUnavailableError();
    }
    contents = await file.readFile();
    if (contents.length !== stat.size) {
      throw new LocalSecretUnavailableError();
    }
    return parseManifest(contents);
  } catch {
    throw new LocalSecretUnavailableError();
  } finally {
    contents?.fill(0);
    await file?.close().catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function newKeyId(): string {
  return `qlsk-${randomBytes(12).toString('base64url')}`;
}

async function writeTemporary(
  filePath: string,
  contents: Buffer,
): Promise<string> {
  const temporary = `${filePath}.tmp-${randomBytes(12).toString('hex')}`;
  const handle = await fs.open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temporary;
}

export class LocalSecretKeyringFileProvider implements LocalSecretKeyProvider {
  private readonly filePath: string;

  constructor(filePath: string) {
    assertKeyringPath(filePath);
    this.filePath = path.resolve(filePath);
  }

  async active(): Promise<LocalSecretKeyMaterial> {
    const manifest = await readManifest(this.filePath);
    return this.material(manifest, manifest.activeKeyId)!;
  }

  async resolve(keyId: string): Promise<LocalSecretKeyMaterial | null> {
    try {
      assertLocalSecretKeyId(keyId);
    } catch {
      throw new LocalSecretUnavailableError();
    }
    return this.material(await readManifest(this.filePath), keyId);
  }

  async inspect(): Promise<LocalSecretKeyringSummary> {
    return summary(await readManifest(this.filePath));
  }

  private material(
    manifest: LocalSecretKeyringManifest,
    keyId: string,
  ): LocalSecretKeyMaterial | null {
    const encoded = manifest.keys[keyId];
    return encoded
      ? Object.freeze({
          keyId,
          key: Uint8Array.from(Buffer.from(encoded, 'base64url')),
        })
      : null;
  }
}

export async function provisionLocalSecretKeyring(
  filePath: string,
): Promise<LocalSecretKeyringSummary> {
  assertKeyringPath(filePath);
  const resolved = path.resolve(filePath);
  await assertRealParent(resolved);
  const keyId = newKeyId();
  const key = randomBytes(32);
  const manifest: LocalSecretKeyringManifest = Object.freeze({
    version: 1,
    activeKeyId: keyId,
    keys: Object.freeze({ [keyId]: key.toString('base64url') }),
  });
  const contents = canonicalManifest(manifest);
  let temporary: string | undefined;
  try {
    temporary = await writeTemporary(resolved, contents);
    await fs.link(temporary, resolved);
    await fs.unlink(temporary);
    temporary = undefined;
    await syncDirectory(path.dirname(resolved));
    return summary(manifest);
  } catch {
    throw new LocalSecretUnavailableError();
  } finally {
    key.fill(0);
    contents.fill(0);
    if (temporary) await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function rotateLocalSecretKeyring(options: {
  readonly filePath: string;
  readonly expectedActiveKeyId: string;
}): Promise<LocalSecretKeyringSummary> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Local Secret keyring rotation options are invalid');
  }
  assertKeyringPath(options.filePath);
  try {
    assertLocalSecretKeyId(options.expectedActiveKeyId);
  } catch {
    throw new TypeError('Local Secret expected active key is invalid');
  }
  const resolved = path.resolve(options.filePath);
  await assertRealParent(resolved);
  const lockPath = `${resolved}.lock`;
  let lock: fs.FileHandle | undefined;
  let temporary: string | undefined;
  let key: Buffer | undefined;
  let contents: Buffer | undefined;
  try {
    lock = await fs.open(
      lockPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await lock.sync();
    const current = await readManifest(resolved);
    if (current.activeKeyId !== options.expectedActiveKeyId) {
      throw new LocalSecretKeyringConflictError();
    }
    if (Object.keys(current.keys).length >= MAX_KEY_COUNT) {
      throw new LocalSecretUnavailableError();
    }
    const keyId = newKeyId();
    key = randomBytes(32);
    const next: LocalSecretKeyringManifest = Object.freeze({
      version: 1,
      activeKeyId: keyId,
      keys: Object.freeze({
        ...current.keys,
        [keyId]: key.toString('base64url'),
      }),
    });
    contents = canonicalManifest(next);
    temporary = await writeTemporary(resolved, contents);
    await fs.rename(temporary, resolved);
    temporary = undefined;
    await syncDirectory(path.dirname(resolved));
    return summary(next);
  } catch (error) {
    if (error instanceof LocalSecretKeyringConflictError) throw error;
    throw new LocalSecretUnavailableError();
  } finally {
    key?.fill(0);
    contents?.fill(0);
    if (temporary) await fs.unlink(temporary).catch(() => undefined);
    await lock?.close().catch(() => undefined);
    if (lock) await fs.unlink(lockPath).catch(() => undefined);
  }
}
