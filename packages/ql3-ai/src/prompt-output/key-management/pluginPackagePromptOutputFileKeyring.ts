import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  PluginPackagePromptOutputArtifactKeyMaterial,
  PluginPackagePromptOutputArtifactKeyProvider,
} from '../pluginPackagePromptOutputArtifact';
import {
  InvalidPluginPackagePromptOutputKeyRetirementError,
  PluginPackagePromptOutputKeyRetirementConflictError,
  PluginPackagePromptOutputKeyRetirementUnavailableError,
  type PluginPackagePromptOutputKeyMaterialState,
  type PluginPackagePromptOutputKeyRetirementMaterialAuthority,
  type PluginPackagePromptOutputKeyRetirementPreparation,
} from './pluginPackagePromptOutputKeyRetirement';
import {
  MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_BYTES,
  MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_KEYS,
  PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_MANIFEST_SCHEMA,
  canonicalPluginPackagePromptOutputKeyringManifest,
  inspectPluginPackagePromptOutputKeyringManifest,
  normalizePluginPackagePromptOutputKeyringDigest,
  normalizePluginPackagePromptOutputKeyringKeyId,
  parsePluginPackagePromptOutputKeyringManifest,
  pluginPackagePromptOutputKeyringCatalogDigest,
  resolvePluginPackagePromptOutputKeyringMaterial,
  retirePluginPackagePromptOutputKeyringManifest,
  summarizePluginPackagePromptOutputKeyringManifest,
  type PluginPackagePromptOutputKeyringManifest,
  type PluginPackagePromptOutputKeyringSummary,
} from './pluginPackagePromptOutputKeyringManifest';

export const PLUGIN_PACKAGE_PROMPT_OUTPUT_FILE_KEYRING_SCHEMA =
  PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_MANIFEST_SCHEMA;

const STALE_EMPTY_LOCK_MS = 30_000;

export type PluginPackagePromptOutputFileKeyringSummary =
  PluginPackagePromptOutputKeyringSummary;

function unavailable(
  cause?: unknown,
): PluginPackagePromptOutputKeyRetirementUnavailableError {
  return new PluginPackagePromptOutputKeyRetirementUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function assertFilePath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    throw new InvalidPluginPackagePromptOutputKeyRetirementError(
      'keyring path is invalid',
    );
  }
}

async function assertPrivateParent(filePath: string): Promise<void> {
  const stat = await fs.lstat(path.dirname(filePath));
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw unavailable();
  }
}

async function readManifest(
  filePath: string,
): Promise<Readonly<PluginPackagePromptOutputKeyringManifest>> {
  let handle: fs.FileHandle | undefined;
  let bytes: Buffer | undefined;
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 1 ||
      stat.size > MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_BYTES
    ) {
      throw unavailable();
    }
    bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw unavailable();
    return parsePluginPackagePromptOutputKeyringManifest(bytes);
  } catch (cause) {
    throw cause instanceof
      PluginPackagePromptOutputKeyRetirementUnavailableError
      ? cause
      : unavailable(cause);
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
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

async function writeManifest(
  filePath: string,
  manifest: Readonly<PluginPackagePromptOutputKeyringManifest>,
): Promise<void> {
  const bytes = canonicalPluginPackagePromptOutputKeyringManifest(manifest);
  const temporary = `${filePath}.tmp-${randomBytes(12).toString('hex')}`;
  let handle: fs.FileHandle | undefined;
  try {
    if (bytes.length > MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_BYTES) {
      throw unavailable();
    }
    handle = await fs.open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (cause) {
    throw cause instanceof
      PluginPackagePromptOutputKeyRetirementUnavailableError
      ? cause
      : unavailable(cause);
  } finally {
    bytes.fill(0);
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function reclaimStaleLock(lockPath: string): Promise<boolean> {
  try {
    const ownerPath = path.join(lockPath, 'owner.json');
    let stale = false;
    try {
      const parsed = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as {
        readonly pid?: unknown;
      };
      stale =
        !Number.isSafeInteger(parsed.pid) ||
        (parsed.pid as number) < 1 ||
        !(await processIsAlive(parsed.pid as number));
    } catch {
      const stat = await fs.stat(lockPath);
      stale = Date.now() - stat.mtimeMs >= STALE_EMPTY_LOCK_MS;
    }
    if (!stale) return false;
    const stalePath = `${lockPath}.stale-${randomBytes(12).toString('hex')}`;
    await fs.rename(lockPath, stalePath);
    await fs.rm(stalePath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function withKeyringLock<T>(
  filePath: string,
  work: () => Promise<T>,
): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const token = randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      const ownerPath = path.join(lockPath, 'owner.json');
      const handle = await fs.open(
        ownerPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, token })}\n`,
          'utf8',
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(lockPath);
      try {
        return await work();
      } finally {
        try {
          const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as {
            readonly token?: unknown;
          };
          if (owner.token === token) {
            await fs.rm(lockPath, { recursive: true });
            await syncDirectory(path.dirname(filePath));
          }
        } catch {
          // A changed lock owner is never removed by this process.
        }
      }
    } catch (cause) {
      if (
        (cause as NodeJS.ErrnoException).code === 'EEXIST' &&
        attempt === 0 &&
        (await reclaimStaleLock(lockPath))
      ) {
        continue;
      }
      throw cause instanceof PluginPackagePromptOutputKeyRetirementConflictError
        ? cause
        : unavailable(cause);
    }
  }
  throw unavailable();
}

export class PluginPackagePromptOutputFileKeyring
  implements
    PluginPackagePromptOutputArtifactKeyProvider,
    PluginPackagePromptOutputKeyRetirementMaterialAuthority
{
  readonly #filePath: string;

  constructor(filePath: string) {
    assertFilePath(filePath);
    this.#filePath = path.resolve(filePath);
  }

  async active(): Promise<PluginPackagePromptOutputArtifactKeyMaterial> {
    const manifest = await readManifest(this.#filePath);
    return resolvePluginPackagePromptOutputKeyringMaterial(
      manifest,
      manifest.activeKeyId,
    )!;
  }

  async resolve(
    candidateKeyId: string,
  ): Promise<PluginPackagePromptOutputArtifactKeyMaterial | null> {
    return resolvePluginPackagePromptOutputKeyringMaterial(
      await readManifest(this.#filePath),
      candidateKeyId,
    );
  }

  async summary(): Promise<
    Readonly<PluginPackagePromptOutputFileKeyringSummary>
  > {
    return summarizePluginPackagePromptOutputKeyringManifest(
      await readManifest(this.#filePath),
    );
  }

  async inspect(
    candidateKeyId: string,
  ): Promise<PluginPackagePromptOutputKeyMaterialState> {
    return inspectPluginPackagePromptOutputKeyringManifest(
      await readManifest(this.#filePath),
      candidateKeyId,
    );
  }

  async retire(
    command: Readonly<{
      preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>;
    }>,
  ): Promise<
    Readonly<{
      state: 'absent';
      keyId: string;
      catalogDigest: string;
      absenceProof: string;
    }>
  > {
    return withKeyringLock(this.#filePath, async () => {
      const manifest = await readManifest(this.#filePath);
      const mutation = retirePluginPackagePromptOutputKeyringManifest(
        manifest,
        command.preparation,
      );
      if (mutation.changed) {
        await writeManifest(this.#filePath, mutation.manifest);
      }
      return mutation.state;
    });
  }
}

export async function provisionPluginPackagePromptOutputFileKeyring(
  filePath: string,
): Promise<Readonly<PluginPackagePromptOutputFileKeyringSummary>> {
  assertFilePath(filePath);
  const resolved = path.resolve(filePath);
  await assertPrivateParent(resolved);
  const newKeyId = `qlpo-${randomBytes(12).toString('base64url')}`;
  const key = randomBytes(32);
  const manifest: PluginPackagePromptOutputKeyringManifest = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_FILE_KEYRING_SCHEMA,
    generation: 1,
    activeKeyId: newKeyId,
    keys: Object.freeze({ [newKeyId]: key.toString('base64url') }),
    retirements: Object.freeze({}),
  });
  const bytes = canonicalPluginPackagePromptOutputKeyringManifest(manifest);
  const temporary = `${resolved}.tmp-${randomBytes(12).toString('hex')}`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(temporary, resolved);
    await fs.unlink(temporary);
    await syncDirectory(path.dirname(resolved));
    return summarizePluginPackagePromptOutputKeyringManifest(manifest);
  } catch (cause) {
    throw unavailable(cause);
  } finally {
    key.fill(0);
    bytes.fill(0);
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function rotatePluginPackagePromptOutputFileKeyring(
  options: Readonly<{
    filePath: string;
    expectedActiveKeyId: string;
    expectedCatalogDigest: string;
  }>,
): Promise<Readonly<PluginPackagePromptOutputFileKeyringSummary>> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new InvalidPluginPackagePromptOutputKeyRetirementError(
      'keyring rotation options are invalid',
    );
  }
  assertFilePath(options.filePath);
  const expectedActiveKeyId = normalizePluginPackagePromptOutputKeyringKeyId(
    options.expectedActiveKeyId,
  );
  const expectedCatalogDigest = normalizePluginPackagePromptOutputKeyringDigest(
    options.expectedCatalogDigest,
    'expectedCatalogDigest',
  );
  const resolved = path.resolve(options.filePath);
  await assertPrivateParent(resolved);
  return withKeyringLock(resolved, async () => {
    const manifest = await readManifest(resolved);
    if (
      manifest.activeKeyId !== expectedActiveKeyId ||
      pluginPackagePromptOutputKeyringCatalogDigest(manifest) !==
        expectedCatalogDigest ||
      Object.keys(manifest.keys).length >=
        MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_KEYS
    ) {
      throw new PluginPackagePromptOutputKeyRetirementConflictError();
    }
    const newKeyId = `qlpo-${randomBytes(12).toString('base64url')}`;
    const key = randomBytes(32);
    try {
      const next: PluginPackagePromptOutputKeyringManifest = Object.freeze({
        ...manifest,
        generation: manifest.generation + 1,
        activeKeyId: newKeyId,
        keys: Object.freeze({
          ...manifest.keys,
          [newKeyId]: key.toString('base64url'),
        }),
      });
      await writeManifest(resolved, next);
      return summarizePluginPackagePromptOutputKeyringManifest(next);
    } finally {
      key.fill(0);
    }
  });
}
