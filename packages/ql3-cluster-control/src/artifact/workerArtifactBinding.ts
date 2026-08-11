// Artifact owns lazy production binding without widening the Worker runtime port.
import {
  createS3ClusterRemoteWorkerArtifactClient,
  S3ClusterRemoteWorkerArtifactStore,
} from './s3ArtifactStore';
import type { ClusterRemoteWorkerArtifactStore } from '../remote-execution/remoteWorkerCompletionService';
import type { ClusterWorkerArtifactS3Config } from '../worker-ingress/workerIngressConfig';

export interface ClusterWorkerArtifactBinding {
  readonly store: ClusterRemoteWorkerArtifactStore;
  close(): Promise<void>;
}

export function createClusterWorkerArtifactBinding(
  config: ClusterWorkerArtifactS3Config,
): Readonly<ClusterWorkerArtifactBinding> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Cluster Worker Artifact binding config is invalid');
  }
  const client = createS3ClusterRemoteWorkerArtifactClient({
    region: config.region,
    ...(config.endpoint === undefined
      ? {}
      : { endpoint: config.endpoint }),
    forcePathStyle: config.forcePathStyle,
  });
  const store = new S3ClusterRemoteWorkerArtifactStore({
    client,
    bucket: config.bucket,
    ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
    ...(config.expectedBucketOwner === undefined
      ? {}
      : { expectedBucketOwner: config.expectedBucketOwner }),
    encryption: config.encryption,
  });
  let closed = false;
  return Object.freeze({
    store,
    async close() {
      if (closed) return;
      closed = true;
      client.destroy();
    },
  });
}
