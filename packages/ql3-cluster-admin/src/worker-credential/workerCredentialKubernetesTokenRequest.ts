/** Short-lived Kubernetes TokenRequest delivery session boundary. */
import {
  WorkerCredentialKubernetesDeliveryAdapter,
  type WorkerCredentialKubernetesDeliveryAdapterOptions,
  type WorkerCredentialKubernetesDeploymentApi,
  type WorkerCredentialKubernetesSecretApi,
} from './workerCredentialKubernetesDelivery';

export const WORKER_CREDENTIAL_KUBERNETES_TOKEN_REQUEST_SECONDS = 600;

const MIN_USEFUL_TOKEN_SECONDS = 30;
const MAX_TOKEN_BYTES = 16 * 1024;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN =
  /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const SAFE_JWT_ALGORITHM = /^[A-Za-z0-9_-]{2,32}$/;
const JWT = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

type JsonObject = Record<string, unknown>;
type KubernetesModule = typeof import('@kubernetes/client-node', {
  with: { 'resolution-mode': 'import' }
});
type KubernetesConfig = InstanceType<KubernetesModule['KubeConfig']>;

interface TokenRequestResponse {
  apiVersion?: string;
  kind?: string;
  status?: {
    token?: string;
    expirationTimestamp?: Date | string;
  };
}

interface AccessReviewAttributes {
  readonly namespace?: string;
  readonly verb: string;
  readonly group?: string;
  readonly resource: string;
  readonly subresource?: string;
  readonly name?: string;
}

export interface WorkerCredentialKubernetesTokenRequestApi {
  createNamespacedServiceAccountToken(request: Readonly<{
    name: string;
    namespace: string;
    body: Readonly<{
      apiVersion: 'authentication.k8s.io/v1';
      kind: 'TokenRequest';
      spec: Readonly<{ expirationSeconds: 600 }>;
    }>;
  }>): Promise<TokenRequestResponse>;
}

export interface WorkerCredentialKubernetesAuthorizationApi {
  createSelfSubjectAccessReview(request: Readonly<{
    body: Readonly<{
      apiVersion: 'authorization.k8s.io/v1';
      kind: 'SelfSubjectAccessReview';
      spec: Readonly<{
        resourceAttributes: AccessReviewAttributes;
      }>;
    }>;
  }>): Promise<Readonly<{
    status?: Readonly<{
      allowed?: boolean;
      denied?: boolean;
      reason?: string;
    }>;
  }>>;
}

export interface WorkerCredentialKubernetesRestrictedClients {
  readonly secrets: WorkerCredentialKubernetesSecretApi;
  readonly deployments: WorkerCredentialKubernetesDeploymentApi;
  readonly authorization: WorkerCredentialKubernetesAuthorizationApi;
  dispose(): void | Promise<void>;
}

export interface WorkerCredentialKubernetesTokenRequestSessionOptions {
  readonly serviceAccountName: string;
  readonly identitySecretName: string;
  readonly delivery: WorkerCredentialKubernetesDeliveryAdapterOptions;
  readonly now?: () => number;
}

export interface WorkerCredentialKubernetesTokenRequestEvidence {
  readonly tokenLifetimeSeconds: number;
  readonly issuerAllowedChecks: number;
  readonly issuerDeniedChecks: number;
  readonly allowedChecks: number;
  readonly deniedChecks: number;
}

export interface WorkerCredentialKubernetesTokenRequestContext {
  readonly delivery: WorkerCredentialKubernetesDeliveryAdapter;
  readonly evidence: WorkerCredentialKubernetesTokenRequestEvidence;
}

export interface WorkerCredentialKubernetesTokenRequestSession {
  withDelivery<T>(
    operation: (
      context: Readonly<WorkerCredentialKubernetesTokenRequestContext>,
    ) => Promise<T>,
  ): Promise<T>;
}

export class WorkerCredentialKubernetesTokenRequestUnavailableError
  extends Error {
  readonly code = 'QL3_WORKER_CREDENTIAL_KUBERNETES_TOKEN_REQUEST_UNAVAILABLE';

  constructor() {
    super('Worker credential Kubernetes TokenRequest session is unavailable');
    this.name = 'WorkerCredentialKubernetesTokenRequestUnavailableError';
  }
}

const VALIDATION_SECRET_API: WorkerCredentialKubernetesSecretApi = {
  async readNamespacedSecret() { throw new Error('validation only'); },
  async createNamespacedSecret() { throw new Error('validation only'); },
  async replaceNamespacedSecret() { throw new Error('validation only'); },
  async deleteNamespacedSecret() { throw new Error('validation only'); },
  async listNamespacedSecret() { throw new Error('validation only'); },
};

const VALIDATION_DEPLOYMENT_API: WorkerCredentialKubernetesDeploymentApi = {
  async readNamespacedDeployment() { throw new Error('validation only'); },
  async replaceNamespacedDeployment() { throw new Error('validation only'); },
};

function jsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
  }
  return value as JsonObject;
}

function decodeJwtSegment(value: string): JsonObject {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) {
      throw new Error('non-canonical base64url');
    }
    return jsonObject(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (error instanceof WorkerCredentialKubernetesTokenRequestUnavailableError) {
      throw error;
    }
    throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
  }
}

function tokenEvidence(
  response: TokenRequestResponse,
  namespace: string,
  serviceAccountName: string,
  observedAtMs: number,
): Readonly<{ token: string; lifetimeSeconds: number }> {
  if (
    response?.apiVersion !== 'authentication.k8s.io/v1' ||
    response.kind !== 'TokenRequest' ||
    typeof response.status?.token !== 'string' ||
    response.status.token.length < 1 ||
    Buffer.byteLength(response.status.token, 'utf8') > MAX_TOKEN_BYTES
  ) {
    throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
  }
  const match = JWT.exec(response.status.token);
  if (!match) {
    throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
  }
  const header = decodeJwtSegment(match[1]!);
  const claims = decodeJwtSegment(match[2]!);
  if (
    typeof header.alg !== 'string' ||
    !SAFE_JWT_ALGORITHM.test(header.alg) ||
    header.alg.toLowerCase() === 'none' ||
    claims.sub !== `system:serviceaccount:${namespace}:${serviceAccountName}` ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp)
  ) {
    throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
  }
  const issuedAtSeconds = claims.iat as number;
  const expiresAtSeconds = claims.exp as number;
  const lifetimeSeconds = expiresAtSeconds - issuedAtSeconds;
  const expiration = response.status.expirationTimestamp;
  const expirationMs = expiration instanceof Date
    ? expiration.getTime()
    : typeof expiration === 'string'
      ? Date.parse(expiration)
      : Number.NaN;
  if (
    lifetimeSeconds < MIN_USEFUL_TOKEN_SECONDS ||
    lifetimeSeconds > WORKER_CREDENTIAL_KUBERNETES_TOKEN_REQUEST_SECONDS ||
    !Number.isSafeInteger(expirationMs) ||
    expirationMs !== expiresAtSeconds * 1_000 ||
    expirationMs - observedAtMs < MIN_USEFUL_TOKEN_SECONDS * 1_000
  ) {
    throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
  }
  return Object.freeze({
    token: response.status.token,
    lifetimeSeconds,
  });
}

function accessMatrix(
  delivery: WorkerCredentialKubernetesDeliveryAdapterOptions,
  identitySecretName: string,
  serviceAccountName: string,
): Readonly<{
  allowed: readonly AccessReviewAttributes[];
  denied: readonly AccessReviewAttributes[];
}> {
  const allowed: readonly AccessReviewAttributes[] = [
    { namespace: delivery.stageNamespace, verb: 'get', resource: 'secrets', name: 'stage' },
    { namespace: delivery.stageNamespace, verb: 'list', resource: 'secrets' },
    { namespace: delivery.stageNamespace, verb: 'create', resource: 'secrets' },
    { namespace: delivery.stageNamespace, verb: 'delete', resource: 'secrets', name: 'stage' },
    { namespace: delivery.namespace, verb: 'get', resource: 'secrets', name: delivery.targetSecretName },
    { namespace: delivery.namespace, verb: 'update', resource: 'secrets', name: delivery.targetSecretName },
    { namespace: delivery.namespace, verb: 'get', group: 'apps', resource: 'deployments', name: delivery.targetDeploymentName },
    { namespace: delivery.namespace, verb: 'update', group: 'apps', resource: 'deployments', name: delivery.targetDeploymentName },
  ];
  const denied: readonly AccessReviewAttributes[] = [
    { namespace: delivery.stageNamespace, verb: 'update', resource: 'secrets', name: 'stage' },
    { namespace: delivery.stageNamespace, verb: 'patch', resource: 'secrets', name: 'stage' },
    { namespace: delivery.stageNamespace, verb: 'watch', resource: 'secrets' },
    { namespace: delivery.stageNamespace, verb: 'get', resource: 'configmaps', name: 'any' },
    { namespace: delivery.namespace, verb: 'list', resource: 'secrets' },
    { namespace: delivery.namespace, verb: 'get', resource: 'secrets', name: identitySecretName },
    { namespace: delivery.namespace, verb: 'create', resource: 'secrets' },
    { namespace: delivery.namespace, verb: 'delete', resource: 'secrets', name: delivery.targetSecretName },
    { namespace: delivery.namespace, verb: 'patch', resource: 'secrets', name: delivery.targetSecretName },
    { namespace: delivery.namespace, verb: 'watch', resource: 'secrets' },
    { namespace: delivery.namespace, verb: 'list', group: 'apps', resource: 'deployments' },
    { namespace: delivery.namespace, verb: 'get', group: 'apps', resource: 'deployments', name: 'other' },
    { namespace: delivery.namespace, verb: 'patch', group: 'apps', resource: 'deployments', name: delivery.targetDeploymentName },
    { namespace: delivery.namespace, verb: 'delete', group: 'apps', resource: 'deployments', name: delivery.targetDeploymentName },
    { namespace: delivery.namespace, verb: 'get', resource: 'pods' },
    { namespace: delivery.namespace, verb: 'list', resource: 'pods' },
    { namespace: delivery.namespace, verb: 'create', resource: 'pods', subresource: 'exec' },
    { namespace: delivery.namespace, verb: 'delete', resource: 'pods', name: 'any' },
    { namespace: delivery.stageNamespace, verb: 'create', resource: 'serviceaccounts', subresource: 'token', name: serviceAccountName },
    { verb: 'get', resource: 'namespaces', name: delivery.namespace },
  ];
  return Object.freeze({ allowed, denied });
}

function issuerAccessMatrix(
  delivery: WorkerCredentialKubernetesDeliveryAdapterOptions,
  serviceAccountName: string,
): Readonly<{
  allowed: readonly AccessReviewAttributes[];
  denied: readonly AccessReviewAttributes[];
}> {
  return Object.freeze({
    allowed: [{
      namespace: delivery.stageNamespace,
      verb: 'create',
      resource: 'serviceaccounts',
      subresource: 'token',
      name: serviceAccountName,
    }],
    denied: [
      {
        namespace: delivery.stageNamespace,
        verb: 'create',
        resource: 'serviceaccounts',
        subresource: 'token',
        name: 'other',
      },
      { namespace: delivery.stageNamespace, verb: 'get', resource: 'secrets', name: 'any' },
      { namespace: delivery.stageNamespace, verb: 'list', resource: 'secrets' },
      { namespace: delivery.stageNamespace, verb: 'create', resource: 'secrets' },
      { namespace: delivery.namespace, verb: 'get', resource: 'secrets', name: delivery.targetSecretName },
      { namespace: delivery.namespace, verb: 'get', group: 'apps', resource: 'deployments', name: delivery.targetDeploymentName },
      { namespace: delivery.namespace, verb: 'get', resource: 'pods' },
      { verb: 'get', resource: 'namespaces', name: delivery.namespace },
    ],
  });
}

async function assertAccess(
  authorization: WorkerCredentialKubernetesAuthorizationApi,
  expected: boolean,
  checks: readonly AccessReviewAttributes[],
): Promise<void> {
  for (const attributes of checks) {
    let result;
    try {
      result = await authorization.createSelfSubjectAccessReview({
        body: {
          apiVersion: 'authorization.k8s.io/v1',
          kind: 'SelfSubjectAccessReview',
          spec: { resourceAttributes: attributes },
        },
      });
    } catch {
      throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
    }
    if (result?.status?.allowed !== expected) {
      throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
    }
  }
}

export function createWorkerCredentialKubernetesTokenRequestSession(
  tokenRequests: WorkerCredentialKubernetesTokenRequestApi,
  issuerAuthorization: WorkerCredentialKubernetesAuthorizationApi,
  createRestrictedClients: (
    token: string,
  ) => WorkerCredentialKubernetesRestrictedClients,
  options: WorkerCredentialKubernetesTokenRequestSessionOptions,
): WorkerCredentialKubernetesTokenRequestSession {
  if (
    !tokenRequests ||
    typeof tokenRequests.createNamespacedServiceAccountToken !== 'function' ||
    !issuerAuthorization ||
    typeof issuerAuthorization.createSelfSubjectAccessReview !== 'function' ||
    typeof createRestrictedClients !== 'function' ||
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) =>
      !['serviceAccountName', 'identitySecretName', 'delivery', 'now'].includes(key)) ||
    typeof options.serviceAccountName !== 'string' ||
    !DNS_LABEL.test(options.serviceAccountName) ||
    typeof options.identitySecretName !== 'string' ||
    !DNS_SUBDOMAIN.test(options.identitySecretName) ||
    Buffer.byteLength(options.identitySecretName, 'utf8') > 253 ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new TypeError('Worker credential Kubernetes TokenRequest options are invalid');
  }
  const validation = new WorkerCredentialKubernetesDeliveryAdapter(
    VALIDATION_SECRET_API,
    VALIDATION_DEPLOYMENT_API,
    options.delivery,
  );
  const now = options.now ?? Date.now;
  const matrix = accessMatrix(
    options.delivery,
    options.identitySecretName,
    options.serviceAccountName,
  );
  const issuerMatrix = issuerAccessMatrix(
    options.delivery,
    options.serviceAccountName,
  );

  return Object.freeze({
    async withDelivery<T>(
      operation: (
        context: Readonly<WorkerCredentialKubernetesTokenRequestContext>,
      ) => Promise<T>,
    ): Promise<T> {
      if (typeof operation !== 'function') {
        throw new TypeError('Worker credential Kubernetes operation is invalid');
      }
      const requestedAtMs = now();
      if (!Number.isSafeInteger(requestedAtMs) || requestedAtMs < 0) {
        throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
      }
      let response: TokenRequestResponse | undefined;
      let issuedToken = '';
      let clients: WorkerCredentialKubernetesRestrictedClients | undefined;
      try {
        await assertAccess(issuerAuthorization, true, issuerMatrix.allowed);
        await assertAccess(issuerAuthorization, false, issuerMatrix.denied);
        try {
          response = await tokenRequests.createNamespacedServiceAccountToken({
            name: options.serviceAccountName,
            namespace: options.delivery.stageNamespace,
            body: {
              apiVersion: 'authentication.k8s.io/v1',
              kind: 'TokenRequest',
              spec: {
                expirationSeconds:
                  WORKER_CREDENTIAL_KUBERNETES_TOKEN_REQUEST_SECONDS,
              },
            },
          });
        } catch {
          throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
        }
        const observedAtMs = now();
        if (
          !Number.isSafeInteger(observedAtMs) ||
          observedAtMs < requestedAtMs
        ) {
          throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
        }
        const evidence = tokenEvidence(
          response,
          options.delivery.stageNamespace,
          options.serviceAccountName,
          observedAtMs,
        );
        issuedToken = evidence.token;
        try {
          clients = createRestrictedClients(issuedToken);
        } catch {
          throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
        } finally {
          if (response.status) response.status.token = '';
          issuedToken = '';
        }
        if (
          !clients ||
          !clients.authorization ||
          typeof clients.authorization.createSelfSubjectAccessReview !== 'function' ||
          typeof clients.dispose !== 'function'
        ) {
          throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
        }
        const delivery = new WorkerCredentialKubernetesDeliveryAdapter(
          clients.secrets,
          clients.deployments,
          options.delivery,
        );
        if (delivery.deploymentTargetDigest !== validation.deploymentTargetDigest) {
          throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
        }
        await assertAccess(clients.authorization, true, matrix.allowed);
        await assertAccess(clients.authorization, false, matrix.denied);
        return await operation(Object.freeze({
          delivery,
          evidence: Object.freeze({
            tokenLifetimeSeconds: evidence.lifetimeSeconds,
            issuerAllowedChecks: issuerMatrix.allowed.length,
            issuerDeniedChecks: issuerMatrix.denied.length,
            allowedChecks: matrix.allowed.length,
            deniedChecks: matrix.denied.length,
          }),
        }));
      } finally {
        if (response?.status) response.status.token = '';
        issuedToken = '';
        try {
          await clients?.dispose();
        } catch {
          throw new WorkerCredentialKubernetesTokenRequestUnavailableError();
        } finally {
          clients = undefined;
          response = undefined;
        }
      }
    },
  });
}

export function createWorkerCredentialKubernetesKubeConfigTokenRequestSession(
  issuerKubeConfig: KubernetesConfig,
  kubernetes: KubernetesModule,
  options: WorkerCredentialKubernetesTokenRequestSessionOptions,
): WorkerCredentialKubernetesTokenRequestSession {
  if (
    !issuerKubeConfig ||
    !kubernetes ||
    typeof kubernetes !== 'object' ||
    typeof kubernetes.KubeConfig !== 'function' ||
    typeof kubernetes.CoreV1Api !== 'function' ||
    typeof kubernetes.AppsV1Api !== 'function' ||
    typeof kubernetes.AuthorizationV1Api !== 'function' ||
    typeof issuerKubeConfig.getCurrentCluster !== 'function' ||
    typeof issuerKubeConfig.makeApiClient !== 'function'
  ) {
    throw new TypeError('Worker credential Kubernetes issuer kubeconfig is invalid');
  }
  const cluster = issuerKubeConfig.getCurrentCluster();
  let server: URL;
  try {
    server = new URL(cluster?.server ?? '');
  } catch {
    throw new TypeError('Worker credential Kubernetes issuer cluster is invalid');
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
    throw new TypeError('Worker credential Kubernetes issuer cluster is invalid');
  }
  const tokenRequestClient = issuerKubeConfig.makeApiClient(
    kubernetes.CoreV1Api,
  );
  const issuerAuthorization = issuerKubeConfig.makeApiClient(
    kubernetes.AuthorizationV1Api,
  ) as unknown as WorkerCredentialKubernetesAuthorizationApi;
  const tokenRequests: WorkerCredentialKubernetesTokenRequestApi = {
    async createNamespacedServiceAccountToken(request) {
      return await tokenRequestClient.createNamespacedServiceAccountToken({
        ...request,
        body: {
          ...request.body,
          spec: {
            audiences: [],
            expirationSeconds: request.body.spec.expirationSeconds,
          },
        },
      }) as unknown as TokenRequestResponse;
    },
  };
  return createWorkerCredentialKubernetesTokenRequestSession(
    tokenRequests,
    issuerAuthorization,
    (token) => {
      const restricted = new kubernetes.KubeConfig();
      restricted.loadFromOptions({
        clusters: [{ ...cluster, name: 'ql3-worker-credential-delivery' }],
        users: [{ name: 'ql3-worker-credential-delivery', token }],
        contexts: [{
          name: 'ql3-worker-credential-delivery',
          cluster: 'ql3-worker-credential-delivery',
          user: 'ql3-worker-credential-delivery',
          namespace: options.delivery.stageNamespace,
        }],
        currentContext: 'ql3-worker-credential-delivery',
      });
      let active = true;
      return {
        secrets: restricted.makeApiClient(
          kubernetes.CoreV1Api,
        ) as unknown as WorkerCredentialKubernetesSecretApi,
        deployments: restricted.makeApiClient(
          kubernetes.AppsV1Api,
        ) as unknown as WorkerCredentialKubernetesDeploymentApi,
        authorization: restricted.makeApiClient(
          kubernetes.AuthorizationV1Api,
        ) as unknown as WorkerCredentialKubernetesAuthorizationApi,
        dispose() {
          if (!active) return;
          active = false;
          for (const user of restricted.getUsers()) {
            (user as { token?: string }).token = '';
          }
          restricted.setCurrentContext('disposed');
        },
      };
    },
    options,
  );
}
