import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import {
  LocalSecretUnavailableError,
  assertLocalSecretKeyId,
} from '../../domain/localSecret';
import type {
  LocalSecretKeyMaterial,
  LocalSecretKeyProvider,
} from '../../ports/localSecretKeyProvider';

const MAX_KEYRING_BYTES = 16 * 1024;
const MAX_KEY_COUNT = 16;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

interface LocalSecretKeyringManifest {
  version: 1;
  activeKeyId: string;
  keys: Record<string, string>;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
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
  assertLocalSecretKeyId(record.activeKeyId as string);
  const entries = Object.entries(record.keys as Record<string, unknown>);
  if (entries.length < 1 || entries.length > MAX_KEY_COUNT) {
    throw new LocalSecretUnavailableError();
  }
  const keys: Record<string, string> = Object.create(null);
  for (const [keyId, encoded] of entries) {
    assertLocalSecretKeyId(keyId);
    const decoded =
      typeof encoded === 'string'
        ? Buffer.from(encoded, 'base64url')
        : Buffer.alloc(0);
    if (
      typeof encoded !== 'string' ||
      !BASE64URL_PATTERN.test(encoded) ||
      decoded.length !== 32 ||
      decoded.toString('base64url') !== encoded
    ) {
      decoded.fill(0);
      throw new LocalSecretUnavailableError();
    }
    decoded.fill(0);
    keys[keyId] = encoded;
  }
  if (!keys[record.activeKeyId as string]) {
    throw new LocalSecretUnavailableError();
  }
  return {
    version: 1,
    activeKeyId: record.activeKeyId as string,
    keys,
  };
}

export class LocalSecretKeyringFileProvider implements LocalSecretKeyProvider {
  private readonly filePath: string;

  constructor(filePath: string) {
    if (!path.isAbsolute(filePath) || filePath.includes('\0')) {
      throw new TypeError('Local Secret keyring path must be absolute');
    }
    this.filePath = path.resolve(filePath);
  }

  async active(): Promise<LocalSecretKeyMaterial> {
    const manifest = await this.read();
    return this.material(
      manifest,
      manifest.activeKeyId,
    ) as LocalSecretKeyMaterial;
  }

  async resolve(keyId: string): Promise<LocalSecretKeyMaterial | null> {
    try {
      assertLocalSecretKeyId(keyId);
    } catch {
      throw new LocalSecretUnavailableError();
    }
    const manifest = await this.read();
    return this.material(manifest, keyId);
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

  private async read(): Promise<LocalSecretKeyringManifest> {
    let file: fs.FileHandle | undefined;
    let contents: Buffer | undefined;
    try {
      file = await fs.open(
        this.filePath,
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
}
