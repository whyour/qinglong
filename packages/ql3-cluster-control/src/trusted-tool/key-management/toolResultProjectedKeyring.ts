import { Buffer } from 'node:buffer';

import type { ToolInvocationArtifactKeyProvider } from '@qinglong/runtime-core/tool-invocation-artifact';

import { PrivateProjectedFileReader } from '../../security/privateProjectedFile';

import {
  MAX_CLUSTER_TOOL_RESULT_KEYRING_BYTES,
  canonicalClusterToolResultKeyringManifest,
  parseClusterToolResultKeyringManifest,
  resolveClusterToolResultKeyringMaterial,
  summarizeClusterToolResultKeyringManifest,
  type ClusterToolResultKeyringManifest,
  type ClusterToolResultKeyringSummary,
} from './toolResultKeyringManifest';

const DATA_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

export {
  CLUSTER_TOOL_RESULT_KEYRING_MANIFEST_SCHEMA,
  MAX_CLUSTER_TOOL_RESULT_KEYRING_BYTES,
  MAX_CLUSTER_TOOL_RESULT_PROJECTED_KEYS,
  InvalidClusterToolResultKeyringManifestError,
  canonicalClusterToolResultKeyringManifest,
  normalizeClusterToolResultKeyringManifest,
  parseClusterToolResultKeyringManifest,
  resolveClusterToolResultKeyringMaterial,
  summarizeClusterToolResultKeyringManifest,
  type ClusterToolResultKeyringManifest,
  type ClusterToolResultKeyringSummary,
} from './toolResultKeyringManifest';

export interface ClusterToolResultProjectedKeyringOptions {
  readonly rootDirectory: string;
  readonly dataFileName?: string;
}

export class ClusterToolResultProjectedKeyringUnavailableError extends Error {
  readonly code = 'QL3_CLUSTER_TOOL_RESULT_PROJECTED_KEYRING_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Projected Cluster Tool result keyring is unavailable', options);
    this.name = 'ClusterToolResultProjectedKeyringUnavailableError';
  }
}

function unavailable(
  cause?: unknown,
): ClusterToolResultProjectedKeyringUnavailableError {
  return new ClusterToolResultProjectedKeyringUnavailableError({
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
): Promise<Readonly<ClusterToolResultKeyringManifest>> {
  let bytes: Buffer | undefined;
  let canonical: Buffer | undefined;
  try {
    bytes = await reader.read(fileName);
    const manifest = parseClusterToolResultKeyringManifest(bytes);
    canonical = canonicalClusterToolResultKeyringManifest(manifest);
    if (!canonical.equals(bytes)) throw unavailable();
    return manifest;
  } catch (cause) {
    throw cause instanceof ClusterToolResultProjectedKeyringUnavailableError
      ? cause
      : unavailable(cause);
  } finally {
    bytes?.fill(0);
    canonical?.fill(0);
  }
}

/**
 * Read-only result-key material authority for Kubernetes/CSI projections.
 * PostgreSQL remains the sole active/decryptable state authority: this class
 * only resolves key material and deliberately has no active() method.
 */
export class ClusterToolResultProjectedKeyring
  implements Pick<ToolInvocationArtifactKeyProvider, 'resolve'>
{
  readonly #reader: PrivateProjectedFileReader;
  readonly #dataFileName: string;

  constructor(options: ClusterToolResultProjectedKeyringOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw unavailable();
    }
    try {
      this.#reader = new PrivateProjectedFileReader({
        rootDirectory: options.rootDirectory,
        minimumBytes: 1,
        maximumBytes: MAX_CLUSTER_TOOL_RESULT_KEYRING_BYTES,
        access: 'read_only_keyring',
      });
      this.#dataFileName = dataFileName(options.dataFileName ?? 'keyring.json');
    } catch (cause) {
      throw unavailable(cause);
    }
  }

  async verify(): Promise<Readonly<ClusterToolResultKeyringSummary>> {
    return summarizeClusterToolResultKeyringManifest(
      await readManifest(this.#reader, this.#dataFileName),
    );
  }

  async resolve(
    keyId: string,
  ): ReturnType<Pick<ToolInvocationArtifactKeyProvider, 'resolve'>['resolve']> {
    try {
      return resolveClusterToolResultKeyringMaterial(
        await readManifest(this.#reader, this.#dataFileName),
        keyId,
      );
    } catch (cause) {
      throw cause instanceof ClusterToolResultProjectedKeyringUnavailableError
        ? cause
        : unavailable(cause);
    }
  }
}

export async function createClusterToolResultProjectedKeyring(
  options: ClusterToolResultProjectedKeyringOptions,
): Promise<Readonly<ClusterToolResultProjectedKeyring>> {
  const provider = new ClusterToolResultProjectedKeyring(options);
  await provider.verify();
  return provider;
}
