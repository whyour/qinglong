import { Buffer } from 'node:buffer';

import type { ToolInvocationArtifactKeyProvider } from '@qinglong/runtime-core/tool-invocation-artifact';

import { PrivateProjectedFileReader } from '../../security/privateProjectedFile';
import {
  MAX_CLUSTER_TOOL_INVOCATION_KEYRING_BYTES,
  canonicalClusterToolInvocationKeyringManifest,
  parseClusterToolInvocationKeyringManifest,
  resolveClusterToolInvocationKeyringMaterial,
  summarizeClusterToolInvocationKeyringManifest,
  type ClusterToolInvocationKeyringManifest,
  type ClusterToolInvocationKeyringSummary,
} from './toolInvocationKeyringManifest';

const DATA_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

export {
  CLUSTER_TOOL_INVOCATION_KEYRING_MANIFEST_SCHEMA,
  MAX_CLUSTER_TOOL_INVOCATION_KEYRING_BYTES,
  MAX_CLUSTER_TOOL_INVOCATION_PROJECTED_KEYS,
  InvalidClusterToolInvocationKeyringManifestError,
  canonicalClusterToolInvocationKeyringManifest,
  normalizeClusterToolInvocationKeyringManifest,
  parseClusterToolInvocationKeyringManifest,
  resolveClusterToolInvocationKeyringMaterial,
  summarizeClusterToolInvocationKeyringManifest,
  type ClusterToolInvocationKeyringManifest,
  type ClusterToolInvocationKeyringSummary,
} from './toolInvocationKeyringManifest';

export interface ClusterToolInvocationProjectedKeyringOptions {
  readonly rootDirectory: string;
  readonly dataFileName?: string;
}

export class ClusterToolInvocationProjectedKeyringUnavailableError extends Error {
  readonly code = 'QL3_CLUSTER_TOOL_INVOCATION_PROJECTED_KEYRING_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Projected Cluster Tool invocation keyring is unavailable', options);
    this.name = 'ClusterToolInvocationProjectedKeyringUnavailableError';
  }
}

function unavailable(
  cause?: unknown,
): ClusterToolInvocationProjectedKeyringUnavailableError {
  return new ClusterToolInvocationProjectedKeyringUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function dataFileName(value: unknown): string {
  if (typeof value !== 'string' || !DATA_FILE_NAME.test(value)) {
    throw unavailable();
  }
  return value;
}

async function readManifest(
  reader: PrivateProjectedFileReader,
  fileName: string,
): Promise<Readonly<ClusterToolInvocationKeyringManifest>> {
  let bytes: Buffer | undefined;
  let canonical: Buffer | undefined;
  try {
    bytes = await reader.read(fileName);
    const manifest = parseClusterToolInvocationKeyringManifest(bytes);
    canonical = canonicalClusterToolInvocationKeyringManifest(manifest);
    if (!canonical.equals(bytes)) throw unavailable();
    return manifest;
  } catch (cause) {
    throw cause instanceof ClusterToolInvocationProjectedKeyringUnavailableError
      ? cause
      : unavailable(cause);
  } finally {
    bytes?.fill(0);
    canonical?.fill(0);
  }
}

/** Read-only, no-cache invocation Artifact key authority for projections. */
export class ClusterToolInvocationProjectedKeyring
  implements ToolInvocationArtifactKeyProvider
{
  readonly #reader: PrivateProjectedFileReader;
  readonly #dataFileName: string;

  constructor(options: ClusterToolInvocationProjectedKeyringOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw unavailable();
    }
    try {
      this.#reader = new PrivateProjectedFileReader({
        rootDirectory: options.rootDirectory,
        minimumBytes: 1,
        maximumBytes: MAX_CLUSTER_TOOL_INVOCATION_KEYRING_BYTES,
        access: 'read_only_keyring',
      });
      this.#dataFileName = dataFileName(options.dataFileName ?? 'keyring.json');
    } catch (cause) {
      throw unavailable(cause);
    }
  }

  async verify(): Promise<Readonly<ClusterToolInvocationKeyringSummary>> {
    return summarizeClusterToolInvocationKeyringManifest(
      await readManifest(this.#reader, this.#dataFileName),
    );
  }

  async active(): ReturnType<ToolInvocationArtifactKeyProvider['active']> {
    try {
      const manifest = await readManifest(this.#reader, this.#dataFileName);
      return resolveClusterToolInvocationKeyringMaterial(
        manifest,
        manifest.activeKeyId,
      )!;
    } catch (cause) {
      throw cause instanceof
        ClusterToolInvocationProjectedKeyringUnavailableError
        ? cause
        : unavailable(cause);
    }
  }

  async resolve(
    keyId: string,
  ): ReturnType<ToolInvocationArtifactKeyProvider['resolve']> {
    try {
      return resolveClusterToolInvocationKeyringMaterial(
        await readManifest(this.#reader, this.#dataFileName),
        keyId,
      );
    } catch (cause) {
      throw cause instanceof
        ClusterToolInvocationProjectedKeyringUnavailableError
        ? cause
        : unavailable(cause);
    }
  }
}

export async function createClusterToolInvocationProjectedKeyring(
  options: ClusterToolInvocationProjectedKeyringOptions,
): Promise<Readonly<ClusterToolInvocationProjectedKeyring>> {
  const provider = new ClusterToolInvocationProjectedKeyring(options);
  await provider.verify();
  return provider;
}
