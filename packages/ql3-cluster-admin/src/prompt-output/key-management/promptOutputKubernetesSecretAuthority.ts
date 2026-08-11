/** Least-privilege Kubernetes Secret authority assembly boundary. */
import {
  ClusterPromptOutputKubernetesSecretKeyring,
  type ClusterPromptOutputKubernetesSecretApi,
  type ClusterPromptOutputKubernetesSecretKeyringOptions,
} from './promptOutputKubernetesSecretKeyring';

interface AccessReviewAttributes {
  readonly namespace?: string;
  readonly verb: string;
  readonly resource: string;
  readonly name?: string;
}

interface AuthorizationApi {
  createSelfSubjectAccessReview(
    request: Readonly<{
      body: Readonly<{
        apiVersion: 'authorization.k8s.io/v1';
        kind: 'SelfSubjectAccessReview';
        spec: Readonly<{ resourceAttributes: AccessReviewAttributes }>;
      }>;
    }>,
  ): Promise<
    Readonly<{
      status?: Readonly<{ allowed?: boolean; denied?: boolean }>;
    }>
  >;
}

function accessMatrix(
  options: ClusterPromptOutputKubernetesSecretKeyringOptions,
): Readonly<{
  allowed: readonly AccessReviewAttributes[];
  denied: readonly AccessReviewAttributes[];
}> {
  return Object.freeze({
    allowed: Object.freeze([
      {
        namespace: options.namespace,
        verb: 'get',
        resource: 'secrets',
        name: options.secretName,
      },
      {
        namespace: options.namespace,
        verb: 'update',
        resource: 'secrets',
        name: options.secretName,
      },
    ]),
    denied: Object.freeze([
      { namespace: options.namespace, verb: 'list', resource: 'secrets' },
      { namespace: options.namespace, verb: 'watch', resource: 'secrets' },
      { namespace: options.namespace, verb: 'create', resource: 'secrets' },
      {
        namespace: options.namespace,
        verb: 'delete',
        resource: 'secrets',
        name: options.secretName,
      },
      {
        namespace: options.namespace,
        verb: 'patch',
        resource: 'secrets',
        name: options.secretName,
      },
      {
        namespace: options.namespace,
        verb: 'get',
        resource: 'secrets',
        name: `${options.secretName}-other`,
      },
      { namespace: options.namespace, verb: 'get', resource: 'configmaps' },
      { namespace: options.namespace, verb: 'get', resource: 'pods' },
    ]),
  });
}

async function assertExactKubernetesAuthority(
  api: AuthorizationApi,
  options: ClusterPromptOutputKubernetesSecretKeyringOptions,
): Promise<void> {
  const matrix = accessMatrix(options);
  for (const [expected, checks] of [
    [true, matrix.allowed],
    [false, matrix.denied],
  ] as const) {
    for (const attributes of checks) {
      const review = await api.createSelfSubjectAccessReview({
        body: {
          apiVersion: 'authorization.k8s.io/v1',
          kind: 'SelfSubjectAccessReview',
          spec: { resourceAttributes: attributes },
        },
      });
      if (
        review.status?.allowed !== expected ||
        (expected && review.status.denied === true)
      ) {
        throw new TypeError(
          'Kubernetes Secret lifecycle authority is not exact',
        );
      }
    }
  }
}

export async function openPromptOutputKubernetesSecretAuthority(
  options: ClusterPromptOutputKubernetesSecretKeyringOptions,
): Promise<
  Readonly<{
    materials: ClusterPromptOutputKubernetesSecretKeyring;
    dispose(): void;
  }>
> {
  const kubernetes = await import('@kubernetes/client-node');
  const config = new kubernetes.KubeConfig();
  config.loadFromCluster();
  const cluster = config.getCurrentCluster();
  let server: URL;
  try {
    server = new URL(cluster?.server ?? '');
  } catch {
    throw new TypeError('Kubernetes cluster authority is invalid');
  }
  if (
    !cluster ||
    server.protocol !== 'https:' ||
    server.username !== '' ||
    server.password !== '' ||
    server.hash !== '' ||
    cluster.skipTLSVerify === true ||
    (typeof cluster.caData !== 'string' && typeof cluster.caFile !== 'string')
  ) {
    throw new TypeError('Kubernetes cluster authority is invalid');
  }
  const secrets = config.makeApiClient(
    kubernetes.CoreV1Api,
  ) as unknown as ClusterPromptOutputKubernetesSecretApi;
  const authorization = config.makeApiClient(
    kubernetes.AuthorizationV1Api,
  ) as unknown as AuthorizationApi;
  await assertExactKubernetesAuthority(authorization, options);
  let active = true;
  return Object.freeze({
    materials: new ClusterPromptOutputKubernetesSecretKeyring(secrets, options),
    dispose() {
      if (!active) return;
      active = false;
      for (const user of config.getUsers()) {
        (user as { token?: string }).token = '';
      }
      config.setCurrentContext('disposed');
    },
  });
}
