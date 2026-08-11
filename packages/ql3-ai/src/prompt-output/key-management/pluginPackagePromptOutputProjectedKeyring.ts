import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, relative } from 'node:path';

import type {
  PluginPackagePromptOutputArtifactKeyMaterial,
  PluginPackagePromptOutputArtifactKeyProvider,
} from '../pluginPackagePromptOutputArtifact';
import {
  MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_BYTES,
  canonicalPluginPackagePromptOutputKeyringManifest,
  parsePluginPackagePromptOutputKeyringManifest,
  resolvePluginPackagePromptOutputKeyringMaterial,
  summarizePluginPackagePromptOutputKeyringManifest,
  type PluginPackagePromptOutputKeyringManifest,
  type PluginPackagePromptOutputKeyringSummary,
} from './pluginPackagePromptOutputKeyringManifest';

const MAX_ROOT_DIRECTORY_BYTES = 4096;
const DATA_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

export interface PluginPackagePromptOutputProjectedKeyringOptions {
  /**
   * Direct read-only volume root. Kubernetes atomic-writer symlinks are
   * accepted only when their resolved regular file remains below this root.
   */
  readonly rootDirectory: string;
  readonly dataFileName?: string;
}

export class PluginPackagePromptOutputProjectedKeyringUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_OUTPUT_PROJECTED_KEYRING_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Projected Prompt output keyring is unavailable', options);
    this.name = 'PluginPackagePromptOutputProjectedKeyringUnavailableError';
  }
}

function unavailable(
  cause?: unknown,
): PluginPackagePromptOutputProjectedKeyringUnavailableError {
  return new PluginPackagePromptOutputProjectedKeyringUnavailableError({
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
    throw unavailable();
  }
  return value;
}

function dataFileName(value: unknown): string {
  if (typeof value !== 'string' || !DATA_FILE_NAME.test(value)) {
    throw unavailable();
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

async function resolvedRoot(configuredRoot: string): Promise<string> {
  try {
    const stat = await lstat(configuredRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
    return await realpath(configuredRoot);
  } catch (cause) {
    throw cause instanceof
      PluginPackagePromptOutputProjectedKeyringUnavailableError
      ? cause
      : unavailable(cause);
  }
}

async function readManifest(
  configuredRoot: string,
  fileName: string,
): Promise<Readonly<PluginPackagePromptOutputKeyringManifest>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let bytes: Buffer | undefined;
  let canonical: Buffer | undefined;
  try {
    const root = await resolvedRoot(configuredRoot);
    const candidate = join(root, fileName);
    const target = await realpath(candidate);
    if (!remainsBelow(root, target)) throw unavailable();
    handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_BYTES ||
      (before.mode & 0o222) !== 0 ||
      (before.mode & 0o111) !== 0 ||
      (before.mode & 0o007) !== 0 ||
      (before.mode & 0o440) === 0
    ) {
      throw unavailable();
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
      (await realpath(configuredRoot)) !== root
    ) {
      throw unavailable();
    }
    const manifest = parsePluginPackagePromptOutputKeyringManifest(bytes);
    canonical = canonicalPluginPackagePromptOutputKeyringManifest(manifest);
    if (!canonical.equals(bytes)) throw unavailable();
    return manifest;
  } catch (cause) {
    throw cause instanceof
      PluginPackagePromptOutputProjectedKeyringUnavailableError
      ? cause
      : unavailable(cause);
  } finally {
    bytes?.fill(0);
    canonical?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Read-only runtime provider for Kubernetes Secret, CSI, or Secret-operator
 * atomic projections. It reopens one bounded canonical manifest per operation
 * and owns no cache, watcher, timer, API client, or mutation authority.
 */
export class PluginPackagePromptOutputProjectedKeyring
  implements PluginPackagePromptOutputArtifactKeyProvider
{
  readonly #rootDirectory: string;
  readonly #dataFileName: string;

  constructor(options: PluginPackagePromptOutputProjectedKeyringOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw unavailable();
    }
    this.#rootDirectory = rootDirectory(options.rootDirectory);
    this.#dataFileName = dataFileName(options.dataFileName ?? 'keyring.json');
  }

  async verify(): Promise<Readonly<PluginPackagePromptOutputKeyringSummary>> {
    return summarizePluginPackagePromptOutputKeyringManifest(
      await readManifest(this.#rootDirectory, this.#dataFileName),
    );
  }

  async active(): Promise<PluginPackagePromptOutputArtifactKeyMaterial> {
    try {
      const manifest = await readManifest(
        this.#rootDirectory,
        this.#dataFileName,
      );
      const material = resolvePluginPackagePromptOutputKeyringMaterial(
        manifest,
        manifest.activeKeyId,
      );
      if (!material) throw unavailable();
      return material;
    } catch (cause) {
      throw cause instanceof
        PluginPackagePromptOutputProjectedKeyringUnavailableError
        ? cause
        : unavailable(cause);
    }
  }

  async resolve(
    keyId: string,
  ): Promise<PluginPackagePromptOutputArtifactKeyMaterial | null> {
    try {
      return resolvePluginPackagePromptOutputKeyringMaterial(
        await readManifest(this.#rootDirectory, this.#dataFileName),
        keyId,
      );
    } catch (cause) {
      throw cause instanceof
        PluginPackagePromptOutputProjectedKeyringUnavailableError
        ? cause
        : unavailable(cause);
    }
  }
}

export async function createPluginPackagePromptOutputProjectedKeyring(
  options: PluginPackagePromptOutputProjectedKeyringOptions,
): Promise<Readonly<PluginPackagePromptOutputProjectedKeyring>> {
  const provider = new PluginPackagePromptOutputProjectedKeyring(options);
  await provider.verify();
  return provider;
}
