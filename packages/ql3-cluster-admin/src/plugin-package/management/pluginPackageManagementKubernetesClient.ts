/** Explicit Kubernetes PortForward client boundary for Plugin Package management. */
import {
  createPrivateKey,
  X509Certificate,
} from 'node:crypto';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';

import {
  ClusterPluginPackageManagementClientConfigurationError,
  ClusterPluginPackageManagementClientRemoteError,
  ClusterPluginPackageManagementClientRequestError,
  executeClusterPluginPackageManagementClient,
  readCanonicalFile,
  type ClusterPluginPackageManagementClientPaths,
  type ClusterPluginPackageManagementClientRawConnection,
  type ClusterPluginPackageManagementClientResult,
} from '../../management-support/pluginPackageManagementClient';
import {
  probeClusterAuthenticatedManagementClientReadiness,
  type ClusterAuthenticatedManagementClientReadiness,
} from '../../management-support/managementReadinessProbe';

const MAX_KUBERNETES_CONFIG_BYTES = 16 * 1024;
const MAX_KUBECONFIG_BYTES = 256 * 1024;
const MAX_KUBERNETES_CA_BYTES = 256 * 1024;
const MAX_KUBERNETES_CLIENT_MATERIAL_BYTES = 256 * 1024;
const MAX_KUBERNETES_TOKEN_BYTES = 16 * 1024;
const MANAGEMENT_NAME = 'ql3-plugin-package-management';
const MANAGEMENT_PORT = 8443;
const MANAGEMENT_LABEL_SELECTOR =
  'app.kubernetes.io/name=ql3-plugin-package-management,' +
  'app.kubernetes.io/component=plugin-package-management';
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const DNS_LABEL_PATTERN =
  /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
const POD_NAME_PATTERN =
  /^ql3-plugin-package-management-[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:-[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)?$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~+/-]{0,16383}$/;

type JsonObject = Record<string, unknown>;
type KubernetesModule = typeof import('@kubernetes/client-node', {
  with: { 'resolution-mode': 'import' }
});
type KubernetesConfig = InstanceType<KubernetesModule['KubeConfig']>;

interface ReviewedKubernetesClientConfig {
  readonly schemaVersion: 1;
  readonly kubeconfigFile: string;
  readonly context: string;
  readonly namespace: string;
  readonly apiTimeoutMs: number;
}

export interface ClusterPluginPackageManagementKubernetesConfigurationSummary {
  readonly schemaVersion: 1;
  readonly transport: 'kubernetes-port-forward';
  readonly authentication: 'token' | 'client-certificate';
}

interface PreparedKubernetesClientConfiguration {
  readonly config: Readonly<ReviewedKubernetesClientConfig>;
  readonly kubeConfig: KubernetesConfig;
  readonly kubernetes: KubernetesModule;
  readonly authentication: 'token' | 'client-certificate';
  dispose(): void;
}

interface KubernetesPod {
  readonly metadata?: {
    readonly name?: string;
    readonly namespace?: string;
    readonly uid?: string;
    readonly deletionTimestamp?: unknown;
    readonly labels?: Readonly<Record<string, string>>;
  };
  readonly spec?: {
    readonly serviceAccountName?: string;
    readonly automountServiceAccountToken?: boolean;
    readonly containers?: readonly Readonly<{ readonly name?: string }>[];
  };
  readonly status?: {
    readonly phase?: string;
    readonly conditions?: readonly Readonly<{
      readonly type?: string;
      readonly status?: string;
    }>[];
    readonly containerStatuses?: readonly Readonly<{
      readonly name?: string;
      readonly ready?: boolean;
    }>[];
  };
}

interface KubernetesPodList {
  readonly metadata?: {
    readonly continue?: string;
  };
  readonly items?: readonly KubernetesPod[];
}

export interface ClusterPluginPackageManagementKubernetesPodApi {
  listNamespacedPod(
    request: Readonly<{
      namespace: string;
      labelSelector: string;
      limit: number;
      timeoutSeconds: number;
      watch: false;
    }>,
  ): Promise<KubernetesPodList>;
}

export interface ClusterPluginPackageManagementKubernetesRuntime {
  readonly pods: ClusterPluginPackageManagementKubernetesPodApi;
  openPortForward(
    request: Readonly<{
      namespace: string;
      podName: string;
      port: 8443;
    }>,
  ): Promise<ClusterPluginPackageManagementClientRawConnection>;
}

export interface ClusterPluginPackageManagementPortForwardWebSocket {
  addEventListener(
    type: 'close' | 'error',
    listener: () => void,
  ): void;
  close(): void;
}

export interface ClusterPluginPackageManagementPortForwardApi {
  portForward(
    namespace: string,
    podName: string,
    targetPorts: number[],
    output: Writable,
    error: Writable,
    input: PassThrough,
    retryCount: 0,
  ): Promise<
    | ClusterPluginPackageManagementPortForwardWebSocket
    | (() => ClusterPluginPackageManagementPortForwardWebSocket | null)
  >;
}

export interface ClusterPluginPackageManagementKubernetesClientPaths
  extends ClusterPluginPackageManagementClientPaths {
  readonly kubernetesFile: string;
}

export interface ClusterPluginPackageManagementKubernetesClientOptions {
  readonly createRuntime?: (
    kubeConfig: KubernetesConfig,
    kubernetes: KubernetesModule,
  ) => ClusterPluginPackageManagementKubernetesRuntime;
}

export class ClusterPluginPackageManagementKubernetesClientConfigurationError extends TypeError {
  readonly code =
    'QL3_PLUGIN_PACKAGE_MANAGEMENT_KUBERNETES_CLIENT_CONFIG_INVALID';

  constructor() {
    super('Kubernetes Plugin Package management client configuration is invalid');
    this.name =
      'ClusterPluginPackageManagementKubernetesClientConfigurationError';
  }
}

export class ClusterPluginPackageManagementKubernetesClientTunnelError extends Error {
  readonly code =
    'QL3_PLUGIN_PACKAGE_MANAGEMENT_KUBERNETES_CLIENT_TUNNEL_FAILED';

  constructor(readonly cause?: unknown) {
    super('Kubernetes Plugin Package management tunnel failed');
    this.name = 'ClusterPluginPackageManagementKubernetesClientTunnelError';
  }
}

function configurationFailure(): ClusterPluginPackageManagementKubernetesClientConfigurationError {
  return new ClusterPluginPackageManagementKubernetesClientConfigurationError();
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationFailure();
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw configurationFailure();
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw configurationFailure();
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (
      error instanceof
      ClusterPluginPackageManagementKubernetesClientConfigurationError
    ) {
      throw error;
    }
    throw configurationFailure();
  }
}

function readPrivateFile(filePath: string, maximumBytes: number): Buffer {
  try {
    return readCanonicalFile(filePath, maximumBytes, 'private');
  } catch {
    throw configurationFailure();
  }
}

function normalizeConfig(
  value: unknown,
): Readonly<ReviewedKubernetesClientConfig> {
  exactObject(value, [
    'schemaVersion',
    'kubeconfigFile',
    'context',
    'namespace',
    'apiTimeoutMs',
  ]);
  if (
    value.schemaVersion !== 1 ||
    typeof value.kubeconfigFile !== 'string' ||
    typeof value.context !== 'string' ||
    !CONTEXT_PATTERN.test(value.context) ||
    typeof value.namespace !== 'string' ||
    !DNS_LABEL_PATTERN.test(value.namespace) ||
    !Number.isSafeInteger(value.apiTimeoutMs) ||
    (value.apiTimeoutMs as number) < 1_000 ||
    (value.apiTimeoutMs as number) > 30_000
  ) {
    throw configurationFailure();
  }
  return Object.freeze({
    schemaVersion: 1,
    kubeconfigFile: value.kubeconfigFile,
    context: value.context,
    namespace: value.namespace,
    apiTimeoutMs: value.apiTimeoutMs as number,
  });
}

function decodeCanonicalBase64(
  value: unknown,
  maximumBytes: number,
): Buffer {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length > maximumBytes * 2 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw configurationFailure();
  }
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.length < 1 ||
    bytes.length > maximumBytes ||
    bytes.toString('base64') !== value
  ) {
    bytes.fill(0);
    throw configurationFailure();
  }
  return bytes;
}

function validateRawKubeconfig(
  value: unknown,
  config: Readonly<ReviewedKubernetesClientConfig>,
): void {
  exactObject(value, [
    'apiVersion',
    'kind',
    'clusters',
    'users',
    'contexts',
    'current-context',
  ]);
  if (
    value.apiVersion !== 'v1' ||
    value.kind !== 'Config' ||
    value['current-context'] !== config.context ||
    !Array.isArray(value.clusters) ||
    value.clusters.length !== 1 ||
    !Array.isArray(value.users) ||
    value.users.length !== 1 ||
    !Array.isArray(value.contexts) ||
    value.contexts.length !== 1
  ) {
    throw configurationFailure();
  }
  const clusterEntry = value.clusters[0];
  const userEntry = value.users[0];
  const contextEntry = value.contexts[0];
  exactObject(clusterEntry, ['name', 'cluster']);
  const rawCluster = clusterEntry.cluster;
  exactObject(rawCluster, [
    'server',
    'certificate-authority-data',
  ]);
  exactObject(userEntry, ['name', 'user']);
  const rawUser = userEntry.user;
  if (!rawUser || typeof rawUser !== 'object' || Array.isArray(rawUser)) {
    throw configurationFailure();
  }
  exactObject(contextEntry, ['name', 'context']);
  const rawContext = contextEntry.context;
  exactObject(rawContext, [
    'cluster',
    'user',
    'namespace',
  ]);
  if (
    typeof clusterEntry.name !== 'string' ||
    !CONTEXT_PATTERN.test(clusterEntry.name) ||
    typeof userEntry.name !== 'string' ||
    !CONTEXT_PATTERN.test(userEntry.name) ||
    contextEntry.name !== config.context ||
    rawContext.cluster !== clusterEntry.name ||
    rawContext.user !== userEntry.name ||
    rawContext.namespace !== config.namespace
  ) {
    throw configurationFailure();
  }
  const userKeys = Object.keys(rawUser).sort();
  if (
    JSON.stringify(userKeys) !== JSON.stringify(['token']) &&
    JSON.stringify(userKeys) !==
      JSON.stringify(
        ['client-certificate-data', 'client-key-data'].sort(),
      )
  ) {
    throw configurationFailure();
  }
}

function validateKubeConfig(
  kubeConfig: KubernetesConfig,
  config: Readonly<ReviewedKubernetesClientConfig>,
): void {
  kubeConfig.setCurrentContext(config.context);
  if (kubeConfig.getCurrentContext() !== config.context) {
    throw configurationFailure();
  }
  const context = kubeConfig.getContextObject(config.context);
  const cluster = kubeConfig.getCurrentCluster();
  const user = kubeConfig.getCurrentUser();
  if (
    !context ||
    context.namespace !== config.namespace ||
    !cluster ||
    !user
  ) {
    throw configurationFailure();
  }

  let server: URL;
  try {
    server = new URL(cluster.server);
  } catch {
    throw configurationFailure();
  }
  if (
    server.protocol !== 'https:' ||
    server.username !== '' ||
    server.password !== '' ||
    (server.pathname !== '' && server.pathname !== '/') ||
    server.search !== '' ||
    server.hash !== '' ||
    server.hostname.length < 1 ||
    cluster.skipTLSVerify !== false ||
    cluster.proxyUrl != null ||
    cluster.caFile != null ||
    typeof cluster.caData !== 'string' ||
    (cluster.tlsServerName != null &&
      cluster.tlsServerName !== server.hostname)
  ) {
    throw configurationFailure();
  }
  const ca = decodeCanonicalBase64(
    cluster.caData,
    MAX_KUBERNETES_CA_BYTES,
  );
  try {
    new X509Certificate(ca);
  } catch {
    throw configurationFailure();
  } finally {
    ca.fill(0);
  }

  if (
    user.exec != null ||
    user.authProvider != null ||
    user.certFile != null ||
    user.keyFile != null ||
    user.username != null ||
    user.password != null ||
    user.impersonateUser != null
  ) {
    throw configurationFailure();
  }
  const hasToken = user.token != null;
  const hasCertificate =
    user.certData != null || user.keyData != null;
  if (
    hasToken === hasCertificate ||
    (hasToken &&
      (typeof user.token !== 'string' ||
        Buffer.byteLength(user.token, 'utf8') >
          MAX_KUBERNETES_TOKEN_BYTES ||
        CONTROL_PATTERN.test(user.token) ||
        !TOKEN_PATTERN.test(user.token)))
  ) {
    throw configurationFailure();
  }
  if (hasCertificate) {
    const certificate = decodeCanonicalBase64(
      user.certData,
      MAX_KUBERNETES_CLIENT_MATERIAL_BYTES,
    );
    const privateKey = decodeCanonicalBase64(
      user.keyData,
      MAX_KUBERNETES_CLIENT_MATERIAL_BYTES,
    );
    try {
      const parsedCertificate = new X509Certificate(certificate);
      const parsedPrivateKey = createPrivateKey(privateKey);
      if (!parsedCertificate.checkPrivateKey(parsedPrivateKey)) {
        throw configurationFailure();
      }
    } catch (error) {
      if (
        error instanceof
        ClusterPluginPackageManagementKubernetesClientConfigurationError
      ) {
        throw error;
      }
      throw configurationFailure();
    } finally {
      certificate.fill(0);
      privateKey.fill(0);
    }
  }
}

async function prepareKubernetesClientConfiguration(
  kubernetesFile: string,
): Promise<PreparedKubernetesClientConfiguration> {
  let kubernetesConfigBytes: Buffer | undefined;
  let kubeconfigBytes: Buffer | undefined;
  try {
    kubernetesConfigBytes = readPrivateFile(
      kubernetesFile,
      MAX_KUBERNETES_CONFIG_BYTES,
    );
    const config = normalizeConfig(parseJson(kubernetesConfigBytes));
    kubeconfigBytes = readPrivateFile(
      config.kubeconfigFile,
      MAX_KUBECONFIG_BYTES,
    );
    const rawKubeconfig = parseJson(kubeconfigBytes);
    validateRawKubeconfig(rawKubeconfig, config);
    let kubernetes: KubernetesModule;
    try {
      kubernetes = await import('@kubernetes/client-node');
    } catch (error) {
      throw new ClusterPluginPackageManagementKubernetesClientTunnelError(
        error,
      );
    }
    const kubeConfig = new kubernetes.KubeConfig();
    try {
      kubeConfig.loadFromString(decodeUtf8(kubeconfigBytes));
      validateKubeConfig(kubeConfig, config);
    } catch (error) {
      if (
        error instanceof
        ClusterPluginPackageManagementKubernetesClientConfigurationError
      ) {
        throw error;
      }
      throw configurationFailure();
    }
    const rawUser = (rawKubeconfig as JsonObject).users as readonly JsonObject[];
    const authentication = Object.hasOwn(
      rawUser[0]!.user as object,
      'token',
    )
      ? 'token'
      : 'client-certificate';
    let disposed = false;
    return Object.freeze({
      config,
      kubeConfig,
      kubernetes,
      authentication,
      dispose() {
        if (disposed) return;
        disposed = true;
        kubernetesConfigBytes?.fill(0);
        kubeconfigBytes?.fill(0);
      },
    });
  } catch (error) {
    kubernetesConfigBytes?.fill(0);
    kubeconfigBytes?.fill(0);
    if (
      error instanceof
        ClusterPluginPackageManagementKubernetesClientConfigurationError ||
      error instanceof ClusterPluginPackageManagementKubernetesClientTunnelError
    ) {
      throw error;
    }
    throw configurationFailure();
  }
}

export async function validateClusterPluginPackageManagementKubernetesConfiguration(
  kubernetesFile: string,
): Promise<
  Readonly<ClusterPluginPackageManagementKubernetesConfigurationSummary>
> {
  const prepared = await prepareKubernetesClientConfiguration(kubernetesFile);
  try {
    return Object.freeze({
      schemaVersion: 1,
      transport: 'kubernetes-port-forward',
      authentication: prepared.authentication,
    });
  } finally {
    prepared.dispose();
  }
}

function isReviewedPod(
  value: KubernetesPod,
  namespace: string,
): value is KubernetesPod & {
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly uid: string;
  };
} {
  const labels = value.metadata?.labels;
  return (
    typeof value.metadata?.name === 'string' &&
    POD_NAME_PATTERN.test(value.metadata.name) &&
    value.metadata.namespace === namespace &&
    typeof value.metadata.uid === 'string' &&
    value.metadata.uid.length >= 8 &&
    value.metadata.uid.length <= 128 &&
    !CONTROL_PATTERN.test(value.metadata.uid) &&
    value.metadata.deletionTimestamp === undefined &&
    labels?.['app.kubernetes.io/name'] === MANAGEMENT_NAME &&
    labels?.['app.kubernetes.io/component'] ===
      'plugin-package-management' &&
    value.spec?.serviceAccountName === MANAGEMENT_NAME &&
    value.spec?.automountServiceAccountToken === false &&
    value.spec?.containers?.some(({ name }) => name === 'management') ===
      true &&
    value.status?.phase === 'Running' &&
    value.status.conditions?.some(
      ({ type, status }) => type === 'Ready' && status === 'True',
    ) === true &&
    value.status.containerStatuses?.some(
      ({ name, ready }) => name === 'management' && ready === true,
    ) === true
  );
}

function selectManagementPod(
  value: KubernetesPodList,
  namespace: string,
): string {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 3 ||
    (value.metadata?.continue !== undefined &&
      value.metadata.continue !== '')
  ) {
    throw new ClusterPluginPackageManagementKubernetesClientTunnelError();
  }
  const current = value.items.filter(
    ({ metadata }) => metadata?.deletionTimestamp === undefined,
  );
  if (
    current.length < 1 ||
    current.length > 2 ||
    !current.every((pod) => isReviewedPod(pod, namespace))
  ) {
    throw new ClusterPluginPackageManagementKubernetesClientTunnelError();
  }
  return current
    .map(({ metadata }) => metadata!.name!)
    .sort()[0]!;
}

function deadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  disposeLate?: (value: T) => void | Promise<void>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new ClusterPluginPackageManagementKubernetesClientTunnelError(),
      );
    }, timeoutMs);
    operation.then(
      (value) => {
        if (settled) {
          void Promise.resolve(disposeLate?.(value)).catch(() => {});
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          error instanceof
          ClusterPluginPackageManagementKubernetesClientTunnelError
            ? error
            : new ClusterPluginPackageManagementKubernetesClientTunnelError(
                error,
              ),
        );
      },
    );
  });
}

export async function openClusterPluginPackageManagementPortForward(
  forward: ClusterPluginPackageManagementPortForwardApi,
  request: Readonly<{
    namespace: string;
    podName: string;
    port: 8443;
  }>,
): Promise<ClusterPluginPackageManagementClientRawConnection> {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  let connection: Duplex | undefined;
  let pendingError = false;
  const errors = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk);
      const failed = bytes.length > 0;
      bytes.fill(0);
      if (failed) {
        pendingError = true;
        connection?.destroy(
          new ClusterPluginPackageManagementKubernetesClientTunnelError(),
        );
      }
      callback();
    },
  });
  const handle = await forward.portForward(
    request.namespace,
    request.podName,
    [request.port],
    incoming,
    errors,
    outgoing,
    0,
  );
  const webSocket =
    typeof handle === 'function' ? handle() : handle;
  if (!webSocket) {
    throw new ClusterPluginPackageManagementKubernetesClientTunnelError();
  }
  const nodeStreamPair = {
    readable: incoming,
    writable: outgoing,
  };
  // Node supports a { readable, writable } pair of Node streams here, while
  // @types/node@24.13.3 currently models only the equivalent Web Streams pair.
  connection = Duplex.from(
    nodeStreamPair as unknown as Parameters<typeof Duplex.from>[0],
  );
  if (pendingError) {
    connection.destroy(
      new ClusterPluginPackageManagementKubernetesClientTunnelError(),
    );
  }
  let closed = false;
  const tunnelFailure = () => {
    if (!closed) {
      connection?.destroy(
        new ClusterPluginPackageManagementKubernetesClientTunnelError(),
      );
    }
  };
  webSocket.addEventListener('close', tunnelFailure);
  webSocket.addEventListener('error', tunnelFailure);
  return Object.freeze({
    stream: connection,
    close() {
      if (closed) return;
      closed = true;
      connection?.end();
      incoming.end();
      outgoing.end();
      errors.end();
      webSocket.close();
    },
  });
}

function productionRuntime(
  kubeConfig: KubernetesConfig,
  kubernetes: KubernetesModule,
): ClusterPluginPackageManagementKubernetesRuntime {
  const pods = kubeConfig.makeApiClient(
    kubernetes.CoreV1Api,
  ) as unknown as ClusterPluginPackageManagementKubernetesPodApi;
  const forward = new kubernetes.PortForward(
    kubeConfig,
    true,
  ) as unknown as ClusterPluginPackageManagementPortForwardApi;
  const runtime: ClusterPluginPackageManagementKubernetesRuntime = {
    pods,
    openPortForward: (request) =>
      openClusterPluginPackageManagementPortForward(
        forward,
        request,
      ),
  };
  return Object.freeze(runtime);
}

export async function executeClusterPluginPackageManagementKubernetesClient(
  paths: ClusterPluginPackageManagementKubernetesClientPaths,
  options: ClusterPluginPackageManagementKubernetesClientOptions = {},
): Promise<Readonly<ClusterPluginPackageManagementClientResult>> {
  exactObject(paths, [
    'configFile',
    'commandFile',
    'assertionFile',
    'kubernetesFile',
  ]);
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'createRuntime') ||
    (options.createRuntime !== undefined &&
      typeof options.createRuntime !== 'function')
  ) {
    throw configurationFailure();
  }

  let prepared: PreparedKubernetesClientConfiguration | undefined;
  try {
    prepared = await prepareKubernetesClientConfiguration(
      paths.kubernetesFile,
    );
    const { config, kubeConfig, kubernetes } = prepared;
    const runtime = (options.createRuntime ?? productionRuntime)(
      kubeConfig,
      kubernetes,
    );
    if (
      !runtime ||
      typeof runtime !== 'object' ||
      typeof runtime.pods?.listNamespacedPod !== 'function' ||
      typeof runtime.openPortForward !== 'function'
    ) {
      throw configurationFailure();
    }

    const expectedHostname =
      `${MANAGEMENT_NAME}.${config.namespace}.svc`;
    return await executeClusterPluginPackageManagementClient(
      {
        configFile: paths.configFile,
        commandFile: paths.commandFile,
        assertionFile: paths.assertionFile,
      },
      {
        async connect(target) {
          if (
            target.hostname !== expectedHostname ||
            target.port !== MANAGEMENT_PORT
          ) {
            throw configurationFailure();
          }
          const list = await deadline(
            runtime.pods.listNamespacedPod({
              namespace: config.namespace,
              labelSelector: MANAGEMENT_LABEL_SELECTOR,
              limit: 3,
              timeoutSeconds: Math.ceil(config.apiTimeoutMs / 1_000),
              watch: false,
            }),
            config.apiTimeoutMs,
          );
          const podName = selectManagementPod(
            list,
            config.namespace,
          );
          return await deadline(
            runtime.openPortForward({
              namespace: config.namespace,
              podName,
              port: MANAGEMENT_PORT,
            }),
            config.apiTimeoutMs,
            async (connection) => {
              await connection.close();
            },
          );
        },
      },
    );
  } catch (error) {
    if (
      error instanceof ClusterPluginPackageManagementClientRequestError &&
      error.cause instanceof
        ClusterPluginPackageManagementKubernetesClientTunnelError
    ) {
      throw error.cause;
    }
    if (
      error instanceof
        ClusterPluginPackageManagementKubernetesClientConfigurationError ||
      error instanceof
        ClusterPluginPackageManagementKubernetesClientTunnelError ||
      error instanceof
        ClusterPluginPackageManagementClientConfigurationError ||
      error instanceof ClusterPluginPackageManagementClientRequestError ||
      error instanceof ClusterPluginPackageManagementClientRemoteError
    ) {
      throw error;
    }
    throw new ClusterPluginPackageManagementKubernetesClientTunnelError(
      error,
    );
  } finally {
    prepared?.dispose();
  }
}

export async function probeClusterPluginPackageManagementKubernetesReadiness(
  configFile: string,
  kubernetesFile: string,
  options: ClusterPluginPackageManagementKubernetesClientOptions = {},
): Promise<Readonly<ClusterAuthenticatedManagementClientReadiness>> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'createRuntime') ||
    (options.createRuntime !== undefined &&
      typeof options.createRuntime !== 'function')
  ) {
    throw configurationFailure();
  }
  let prepared: PreparedKubernetesClientConfiguration | undefined;
  try {
    prepared = await prepareKubernetesClientConfiguration(kubernetesFile);
    const { config, kubeConfig, kubernetes } = prepared;
    const runtime = (options.createRuntime ?? productionRuntime)(
      kubeConfig,
      kubernetes,
    );
    if (
      !runtime ||
      typeof runtime !== 'object' ||
      typeof runtime.pods?.listNamespacedPod !== 'function' ||
      typeof runtime.openPortForward !== 'function'
    ) {
      throw configurationFailure();
    }
    const expectedHostname = `${MANAGEMENT_NAME}.${config.namespace}.svc`;
    return await probeClusterAuthenticatedManagementClientReadiness(
      configFile,
      'package',
      {
        async connect(target) {
          if (
            target.hostname !== expectedHostname ||
            target.port !== MANAGEMENT_PORT
          ) {
            throw configurationFailure();
          }
          const list = await deadline(
            runtime.pods.listNamespacedPod({
              namespace: config.namespace,
              labelSelector: MANAGEMENT_LABEL_SELECTOR,
              limit: 3,
              timeoutSeconds: Math.ceil(config.apiTimeoutMs / 1_000),
              watch: false,
            }),
            config.apiTimeoutMs,
          );
          const podName = selectManagementPod(list, config.namespace);
          return await deadline(
            runtime.openPortForward({
              namespace: config.namespace,
              podName,
              port: MANAGEMENT_PORT,
            }),
            config.apiTimeoutMs,
            async (connection) => {
              await connection.close();
            },
          );
        },
      },
    );
  } catch (error) {
    if (
      error instanceof ClusterPluginPackageManagementClientRequestError &&
      error.cause instanceof
        ClusterPluginPackageManagementKubernetesClientTunnelError
    ) {
      throw error.cause;
    }
    if (
      error instanceof
        ClusterPluginPackageManagementKubernetesClientConfigurationError ||
      error instanceof ClusterPluginPackageManagementKubernetesClientTunnelError ||
      error instanceof ClusterPluginPackageManagementClientConfigurationError ||
      error instanceof ClusterPluginPackageManagementClientRequestError
    ) {
      throw error;
    }
    throw new ClusterPluginPackageManagementKubernetesClientTunnelError(error);
  } finally {
    prepared?.dispose();
  }
}
