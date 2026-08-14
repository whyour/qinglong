// Remote Execution owns mounted Secret resolution for authenticated delivery.
import {
  MAX_REMOTE_SECRET_DELIVERY_TOTAL_VALUE_BYTES,
  MAX_REMOTE_SECRET_VALUE_BYTES,
  normalizeRemoteWorkerSecretDeliveryAuthority,
  type RemoteWorkerSecretDeliveryAuthority,
  type RemoteWorkerSecretResolution,
  type RemoteWorkerSecretValueProvider,
} from '@qinglong/runtime-core/remote-secret-delivery';
import { secretProjectionFileName } from '@qinglong/runtime-core/secret-projection';

import { PrivateProjectedFileReader } from '../security/privateProjectedFile';

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
  private readonly reader: PrivateProjectedFileReader;

  constructor(options: ClusterMountedSecretProviderOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new ClusterMountedSecretProviderError('invalid_configuration');
    }
    try {
      this.reader = new PrivateProjectedFileReader({
        rootDirectory: options.rootDirectory,
        minimumBytes: 0,
        maximumBytes: MAX_REMOTE_SECRET_VALUE_BYTES,
        access: 'private_material',
      });
    } catch (error) {
      throw new ClusterMountedSecretProviderError('invalid_configuration', {
        cause: error,
      });
    }
  }

  async verify(): Promise<void> {
    try {
      await this.reader.verify();
    } catch (error) {
      throw new ClusterMountedSecretProviderError('root_unavailable', {
        cause: error,
      });
    }
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
    const buffers: Buffer[] = [];
    try {
      const values = [];
      let totalBytes = 0;
      for (const secretRef of normalized.secretRefs) {
        const bytes = await this.reader
          .read(clusterMountedSecretFileName(secretRef))
          .catch((error) => {
            throw new ClusterMountedSecretProviderError(
              'material_unavailable',
              { cause: error },
            );
          });
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
