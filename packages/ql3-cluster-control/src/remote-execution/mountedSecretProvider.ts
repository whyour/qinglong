// Remote Execution owns mounted Secret resolution for authenticated delivery.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, relative } from 'node:path';
import {
  MAX_REMOTE_SECRET_DELIVERY_TOTAL_VALUE_BYTES,
  MAX_REMOTE_SECRET_VALUE_BYTES,
  normalizeRemoteWorkerSecretDeliveryAuthority,
  type RemoteWorkerSecretDeliveryAuthority,
  type RemoteWorkerSecretResolution,
  type RemoteWorkerSecretValueProvider,
} from '@qinglong/runtime-core/remote-secret-delivery';
import { secretProjectionFileName } from '@qinglong/runtime-core/secret-projection';

const MAX_SECRET_ROOT_BYTES = 4096;

export interface ClusterMountedSecretProviderOptions {
  /**
   * Read-only directory whose file names are SHA-256(canonical SecretRef).
   * Kubernetes projected-volume symlinks are accepted only when their resolved
   * regular file remains below this directory.
   */
  readonly rootDirectory: string;
}

export class ClusterMountedSecretProviderError extends Error {
  readonly code = 'QL3_CLUSTER_MOUNTED_SECRET_UNAVAILABLE';

  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'root_unavailable'
      | 'material_unavailable',
    options?: ErrorOptions,
  ) {
    super(`Cluster mounted Secret provider failed: ${reason}`, options);
    this.name = 'ClusterMountedSecretProviderError';
  }
}

function rootDirectory(value: string): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    parse(value).root === value ||
    normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_SECRET_ROOT_BYTES
  ) {
    throw new ClusterMountedSecretProviderError('invalid_configuration');
  }
  return value;
}

/**
 * Kubernetes Secret keys cannot contain a SecretRef directly. This stable,
 * non-reversible name also prevents Project/name input from becoming a path.
 */
export function clusterMountedSecretFileName(secretRef: string): string {
  try {
    return secretProjectionFileName(secretRef);
  } catch (error) {
    throw new ClusterMountedSecretProviderError('invalid_configuration', {
      cause: error,
    });
  }
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

async function resolvedRoot(path: string): Promise<string> {
  try {
    const configured = await lstat(path);
    if (!configured.isDirectory() || configured.isSymbolicLink()) {
      throw new Error('root is not a direct directory');
    }
    return await realpath(path);
  } catch (error) {
    throw new ClusterMountedSecretProviderError('root_unavailable', {
      cause: error,
    });
  }
}

async function readMaterial(root: string, secretRef: string): Promise<Buffer> {
  const candidate = join(root, clusterMountedSecretFileName(secretRef));
  let handle;
  try {
    const target = await realpath(candidate);
    if (!remainsBelow(root, target)) {
      throw new Error('material escaped its root');
    }
    handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size < 0 ||
      stat.size > MAX_REMOTE_SECRET_VALUE_BYTES ||
      (stat.mode & 0o111) !== 0 ||
      (stat.mode & 0o027) !== 0
    ) {
      throw new Error('material metadata is unsafe');
    }
    const bytes = await handle.readFile();
    if (
      bytes.byteLength !== stat.size ||
      bytes.byteLength > MAX_REMOTE_SECRET_VALUE_BYTES ||
      (await realpath(candidate)) !== target
    ) {
      bytes.fill(0);
      throw new Error('material changed while reading');
    }
    return bytes;
  } catch (error) {
    throw new ClusterMountedSecretProviderError('material_unavailable', {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function secretValue(bytes: Buffer): string {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (value.includes('\0')) {
      throw new Error('Secret contains NUL');
    }
    return value;
  } catch (error) {
    throw new ClusterMountedSecretProviderError('material_unavailable', {
      cause: error,
    });
  }
}

/**
 * A zero-client, zero-watcher Cluster provider for Kubernetes Secret, CSI or
 * operator-managed projected files. Every authorized delivery resolves the
 * active files again, so atomic projection replacement rotates material
 * without a timer, cache, control restart or Kubernetes API permission.
 */
export class ClusterMountedSecretProvider
  implements RemoteWorkerSecretValueProvider
{
  private readonly rootDirectory: string;

  constructor(options: ClusterMountedSecretProviderOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new ClusterMountedSecretProviderError('invalid_configuration');
    }
    this.rootDirectory = rootDirectory(options.rootDirectory);
  }

  async verify(): Promise<void> {
    await resolvedRoot(this.rootDirectory);
  }

  async resolve(
    authority: Readonly<RemoteWorkerSecretDeliveryAuthority>,
  ): Promise<Readonly<RemoteWorkerSecretResolution>> {
    let normalized: Readonly<RemoteWorkerSecretDeliveryAuthority>;
    try {
      normalized = normalizeRemoteWorkerSecretDeliveryAuthority(authority);
    } catch (error) {
      throw new ClusterMountedSecretProviderError('material_unavailable', {
        cause: error,
      });
    }
    const root = await resolvedRoot(this.rootDirectory);
    const buffers: Buffer[] = [];
    try {
      const values = [];
      let totalBytes = 0;
      for (const secretRef of normalized.secretRefs) {
        const bytes = await readMaterial(root, secretRef);
        buffers.push(bytes);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_REMOTE_SECRET_DELIVERY_TOTAL_VALUE_BYTES) {
          throw new ClusterMountedSecretProviderError('material_unavailable');
        }
        values.push(
          Object.freeze({
            secretRef,
            value: secretValue(bytes),
          }),
        );
      }
      let disposed = false;
      return Object.freeze({
        values: Object.freeze(values),
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const bytes of buffers) bytes.fill(0);
        },
      });
    } catch (error) {
      for (const bytes of buffers) bytes.fill(0);
      if (error instanceof ClusterMountedSecretProviderError) throw error;
      throw new ClusterMountedSecretProviderError('material_unavailable', {
        cause: error,
      });
    }
  }
}

export async function createClusterMountedSecretProvider(
  options: ClusterMountedSecretProviderOptions,
): Promise<Readonly<ClusterMountedSecretProvider>> {
  const provider = new ClusterMountedSecretProvider(options);
  await provider.verify();
  return provider;
}
