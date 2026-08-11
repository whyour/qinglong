/** One-shot Worker credential executor process composition boundary. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import type { OpenPostgresDatabase } from '@qinglong/runtime-core';
import {
  createPostgresDatabaseOpener,
  isPostgresTlsDnsServername,
  loadPostgresCertificateAuthorityFile,
  loadPostgresConnectionEnvironment,
  type PostgresConnectionOptions,
  type PostgresPoolOptions,
} from '@qinglong/cluster-postgres/worker-credential-executor';

import {
  absoluteManagementEnvironmentFile,
  booleanManagementEnvironmentValue,
  boundedManagementEnvironmentValue,
  integerManagementEnvironmentValue,
} from '../management-support/managementProcessSupport';
import {
  runClusterWorkerCredentialExecution,
  type ClusterWorkerCredentialExecutionRun,
  type RunClusterWorkerCredentialExecutionOptions,
} from './workerCredentialManagementExecutor';
import type { WorkerCredentialKubernetesDeliveryAdapterOptions } from './workerCredentialKubernetesDelivery';
import {
  createWorkerCredentialKubernetesKubeConfigTokenRequestSession,
  type WorkerCredentialKubernetesAuthorizationApi,
  type WorkerCredentialKubernetesTokenRequestSession,
} from './workerCredentialKubernetesTokenRequest';

const COMMAND_MAX_BYTES = 16 * 1024;
const PEPPER_MAX_BYTES = 256;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const SAFE_APPLICATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;

type KubernetesModule = typeof import('@kubernetes/client-node', {
  with: { 'resolution-mode': 'import' }
});

export interface ClusterWorkerCredentialExecutorCommand {
  readonly schemaVersion: 1;
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly consumptionId: string;
  readonly dispatchId: string;
  readonly auditEventId: string;
}

export type ClusterWorkerCredentialExecutorProcessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type ClusterWorkerCredentialExecutorProcessConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      profile: 'cluster-admin';
      commandFile: string;
      pepperFile: string;
      serviceAccountName: string;
      identitySecretName: string;
      delivery: WorkerCredentialKubernetesDeliveryAdapterOptions;
      database: Readonly<{
        connection: PostgresConnectionOptions;
        pool: PostgresPoolOptions;
      }>;
    }>;

export type ClusterWorkerCredentialExecutorProcessResult =
  | Readonly<{ status: 'disabled' }>
  | Readonly<{
      status: 'completed';
      command: Readonly<ClusterWorkerCredentialExecutorCommand>;
      run: Readonly<ClusterWorkerCredentialExecutionRun>;
    }>;

interface KubernetesExecutionAuthority {
  readonly session: WorkerCredentialKubernetesTokenRequestSession;
  confirmAuthorization(): Promise<void>;
  dispose(): void;
}

export interface RunClusterWorkerCredentialExecutorProcessOptions {
  readonly environment: ClusterWorkerCredentialExecutorProcessEnvironment;
  readonly command?: Readonly<ClusterWorkerCredentialExecutorCommand>;
  readonly openDatabase?: OpenPostgresDatabase;
  readonly kubernetesAuthority?: KubernetesExecutionAuthority;
  readonly createKubernetesAuthority?: (
    config: Readonly<ClusterWorkerCredentialExecutorProcessConfig & { enabled: true }>,
  ) => Promise<KubernetesExecutionAuthority>;
  readonly execute?: (
    options: RunClusterWorkerCredentialExecutionOptions,
  ) => Promise<Readonly<ClusterWorkerCredentialExecutionRun>>;
  readonly now?: () => number;
}

export class ClusterWorkerCredentialExecutorProcessConfigError extends TypeError {
  readonly code = 'QL3_WORKER_CREDENTIAL_EXECUTOR_PROCESS_CONFIG_INVALID';

  constructor(message: string) {
    super(`Worker credential executor process configuration is invalid: ${message}`);
    this.name = 'ClusterWorkerCredentialExecutorProcessConfigError';
  }
}

function configFailure(
  message: string,
): ClusterWorkerCredentialExecutorProcessConfigError {
  return new ClusterWorkerCredentialExecutorProcessConfigError(message);
}

function boundedValue(
  environment: ClusterWorkerCredentialExecutorProcessEnvironment,
  name: string,
  maximumLength: number,
  required = false,
): string | undefined {
  return boundedManagementEnvironmentValue(
    environment,
    name,
    maximumLength,
    configFailure,
    required,
  );
}

function booleanValue(
  environment: ClusterWorkerCredentialExecutorProcessEnvironment,
  name: string,
): boolean {
  return booleanManagementEnvironmentValue(environment, name, configFailure);
}

function integerValue(
  environment: ClusterWorkerCredentialExecutorProcessEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return integerManagementEnvironmentValue(
    environment,
    name,
    fallback,
    minimum,
    maximum,
    configFailure,
  );
}

function identifier(value: unknown, label: string, pattern = ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw configFailure(`${label} is invalid`);
  }
  return value;
}

function loadConnection(
  environment: ClusterWorkerCredentialExecutorProcessEnvironment,
): Readonly<{
  connection: PostgresConnectionOptions;
  pool: PostgresPoolOptions;
}> {
  let connection: PostgresConnectionOptions;
  try {
    connection = loadPostgresConnectionEnvironment(environment, {
      connectionString: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_URL',
      host: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_HOST',
      port: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_PORT',
      database: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_DATABASE',
      user: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_USER',
      password: 'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_PASSWORD',
    });
  } catch (error) {
    throw configFailure(
      error instanceof Error
        ? error.message
        : 'PostgreSQL Worker credential executor connection is invalid',
    );
  }
  const mode =
    environment.QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_TLS_MODE ??
    'verify-full';
  if (mode !== 'verify-full' && mode !== 'disable') {
    throw configFailure(
      'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_TLS_MODE must be verify-full or disable',
    );
  }
  if (
    mode === 'disable' &&
    !booleanValue(
      environment,
      'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_ALLOW_INSECURE',
    )
  ) {
    throw configFailure(
      'disabling Worker credential executor PostgreSQL TLS requires explicit opt-in',
    );
  }
  const servername = boundedValue(
    environment,
    'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_TLS_SERVERNAME',
    253,
  );
  if (mode === 'verify-full' && !isPostgresTlsDnsServername(servername)) {
    throw configFailure(
      'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_TLS_SERVERNAME must be an explicit DNS name',
    );
  }
  const caFile = boundedValue(
    environment,
    'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_TLS_CA_FILE',
    4_096,
  );
  if (mode === 'disable' && caFile !== undefined) {
    throw configFailure('PostgreSQL CA file cannot be used when TLS is disabled');
  }
  let ca: string | undefined;
  if (caFile !== undefined) {
    try {
      ca = loadPostgresCertificateAuthorityFile(caFile);
    } catch {
      throw configFailure('PostgreSQL CA file is invalid');
    }
  }
  const applicationName =
    boundedValue(
      environment,
      'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_APPLICATION_NAME',
      63,
    ) ?? 'qinglong3-worker-credential-executor';
  if (!SAFE_APPLICATION_NAME.test(applicationName)) {
    throw configFailure('PostgreSQL application name is invalid');
  }
  return Object.freeze({
    connection: Object.freeze({
      ...connection,
      tls:
        mode === 'disable'
          ? { mode: 'disable' as const }
          : {
              mode: 'verify-full' as const,
              servername: servername!,
              ...(ca === undefined ? {} : { ca }),
            },
    }),
    pool: Object.freeze({
      applicationName,
      maxConnections: integerValue(
        environment,
        'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_MAX_CONNECTIONS',
        1,
        1,
        2,
      ),
      connectionTimeoutMs: integerValue(
        environment,
        'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_CONNECTION_TIMEOUT_MS',
        5_000,
        100,
        60_000,
      ),
    }),
  });
}

export function loadClusterWorkerCredentialExecutorProcessConfig(
  environment: ClusterWorkerCredentialExecutorProcessEnvironment,
): Readonly<ClusterWorkerCredentialExecutorProcessConfig> {
  if (!environment || typeof environment !== 'object') {
    throw configFailure('environment is invalid');
  }
  if (!booleanValue(environment, 'QL3_WORKER_CREDENTIAL_EXECUTOR_ENABLED')) {
    return Object.freeze({ enabled: false as const });
  }
  if (environment.QL3_PROFILE !== 'cluster-admin') {
    throw configFailure('QL3_PROFILE must be cluster-admin when executor is enabled');
  }
  const delivery = Object.freeze({
    clusterIdentity: identifier(
      boundedValue(
        environment,
        'QL3_WORKER_CREDENTIAL_EXECUTOR_CLUSTER_IDENTITY',
        128,
        true,
      ),
      'cluster identity',
    ),
    stageNamespace: identifier(
      boundedValue(
        environment,
        'QL3_WORKER_CREDENTIAL_EXECUTOR_STAGE_NAMESPACE',
        63,
        true,
      ),
      'stage namespace',
      /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/,
    ),
    namespace: identifier(
      boundedValue(
        environment,
        'QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_NAMESPACE',
        63,
        true,
      ),
      'target namespace',
      /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/,
    ),
    targetSecretName: identifier(
      boundedValue(
        environment,
        'QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_SECRET',
        253,
        true,
      ),
      'target Secret',
      /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/,
    ),
    targetDeploymentName: identifier(
      boundedValue(
        environment,
        'QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_DEPLOYMENT',
        253,
        true,
      ),
      'target Deployment',
      /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/,
    ),
    targetDataKey: identifier(
      boundedValue(
        environment,
        'QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_DATA_KEY',
        253,
        true,
      ),
      'target data key',
      /^[A-Za-z0-9._-]{1,253}$/,
    ),
  });
  return Object.freeze({
    enabled: true as const,
    profile: 'cluster-admin' as const,
    commandFile: absoluteManagementEnvironmentFile(
      environment,
      'QL3_WORKER_CREDENTIAL_EXECUTOR_COMMAND_FILE',
      configFailure,
    ),
    pepperFile: absoluteManagementEnvironmentFile(
      environment,
      'QL3_WORKER_CREDENTIAL_EXECUTOR_PEPPER_FILE',
      configFailure,
    ),
    serviceAccountName: identifier(
      boundedValue(
        environment,
        'QL3_WORKER_CREDENTIAL_EXECUTOR_DELIVERY_SERVICE_ACCOUNT',
        63,
        true,
      ),
      'delivery ServiceAccount',
      /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/,
    ),
    identitySecretName: identifier(
      boundedValue(
        environment,
        'QL3_WORKER_CREDENTIAL_EXECUTOR_IDENTITY_SECRET',
        253,
        true,
      ),
      'identity Secret',
      /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/,
    ),
    delivery,
    database: loadConnection(environment),
  });
}

async function readBoundedFile(
  filePath: string,
  maximumBytes: number,
  privateMaterial: boolean,
): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > maximumBytes ||
      (before.mode & 0o022) !== 0 ||
      (privateMaterial && (before.mode & 0o007) !== 0)
    ) {
      throw configFailure('authority file permissions or size are invalid');
    }
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw configFailure('authority file changed while being read');
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function normalizeCommand(
  value: unknown,
): Readonly<ClusterWorkerCredentialExecutorCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configFailure('command must be an object');
  }
  const command = value as Record<string, unknown>;
  const keys = [
    'actionRef',
    'approvalRequestId',
    'auditEventId',
    'consumptionId',
    'dispatchId',
    'schemaVersion',
  ];
  if (
    Object.keys(command).sort().join('\0') !== keys.sort().join('\0') ||
    command.schemaVersion !== 1
  ) {
    throw configFailure('command shape is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    actionRef: identifier(command.actionRef, 'actionRef', ACTION_REF),
    approvalRequestId: identifier(command.approvalRequestId, 'approvalRequestId'),
    consumptionId: identifier(command.consumptionId, 'consumptionId'),
    dispatchId: identifier(command.dispatchId, 'dispatchId'),
    auditEventId: identifier(command.auditEventId, 'auditEventId'),
  });
}

async function loadCommand(
  filePath: string,
): Promise<Readonly<ClusterWorkerCredentialExecutorCommand>> {
  const bytes = await readBoundedFile(filePath, COMMAND_MAX_BYTES, false);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return normalizeCommand(JSON.parse(text));
  } catch (error) {
    if (error instanceof ClusterWorkerCredentialExecutorProcessConfigError) {
      throw error;
    }
    throw configFailure('command file is invalid');
  }
}

async function loadPepper(filePath: string): Promise<string> {
  const bytes = await readBoundedFile(filePath, PEPPER_MAX_BYTES, true);
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (
      CONTROL_PATTERN.test(value) ||
      !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      Buffer.from(value, 'base64url').length !== 32 ||
      Buffer.from(value, 'base64url').toString('base64url') !== value
    ) {
      throw configFailure('Worker credential pepper is invalid');
    }
    return value;
  } finally {
    bytes.fill(0);
  }
}

async function createDefaultKubernetesAuthority(
  config: Readonly<ClusterWorkerCredentialExecutorProcessConfig & { enabled: true }>,
): Promise<KubernetesExecutionAuthority> {
  const kubernetes = (await import('@kubernetes/client-node')) as KubernetesModule;
  const issuer = new kubernetes.KubeConfig();
  issuer.loadFromCluster();
  const authorization = issuer.makeApiClient(
    kubernetes.AuthorizationV1Api,
  ) as unknown as WorkerCredentialKubernetesAuthorizationApi;
  const confirmAuthorization = async (): Promise<void> => {
    const result = await authorization.createSelfSubjectAccessReview({
      body: {
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'SelfSubjectAccessReview',
        spec: {
          resourceAttributes: {
            namespace: config.delivery.stageNamespace,
            verb: 'create',
            resource: 'serviceaccounts',
            subresource: 'token',
            name: config.serviceAccountName,
          },
        },
      },
    });
    if (result?.status?.allowed !== true || result.status.denied === true) {
      throw configFailure('executor Kubernetes authorization is unavailable');
    }
  };
  return Object.freeze({
    session: createWorkerCredentialKubernetesKubeConfigTokenRequestSession(
      issuer,
      kubernetes,
      {
        serviceAccountName: config.serviceAccountName,
        identitySecretName: config.identitySecretName,
        delivery: config.delivery,
      },
    ),
    confirmAuthorization,
    dispose() {
      for (const user of issuer.getUsers()) {
        const mutable = user as {
          token?: string;
          certData?: string;
          keyData?: string;
        };
        mutable.token = '';
        mutable.certData = '';
        mutable.keyData = '';
      }
      issuer.setCurrentContext('disposed');
    },
  });
}

export async function runClusterWorkerCredentialExecutorProcess(
  options: RunClusterWorkerCredentialExecutorProcessOptions,
): Promise<Readonly<ClusterWorkerCredentialExecutorProcessResult>> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          'environment',
          'command',
          'openDatabase',
          'kubernetesAuthority',
          'createKubernetesAuthority',
          'execute',
          'now',
        ].includes(key),
    ) ||
    !options.environment ||
    typeof options.environment !== 'object' ||
    (options.openDatabase !== undefined &&
      typeof options.openDatabase !== 'function') ||
    (options.createKubernetesAuthority !== undefined &&
      typeof options.createKubernetesAuthority !== 'function') ||
    (options.execute !== undefined && typeof options.execute !== 'function') ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw configFailure('options are invalid');
  }
  const config = loadClusterWorkerCredentialExecutorProcessConfig(
    options.environment,
  );
  if (!config.enabled) return Object.freeze({ status: 'disabled' as const });
  const command = normalizeCommand(
    options.command ?? (await loadCommand(config.commandFile)),
  );
  const pepper = await loadPepper(config.pepperFile);
  const openDatabase =
    options.openDatabase ??
    createPostgresDatabaseOpener({
      role: 'worker-credential-executor',
      connection: config.database.connection,
      pool: config.database.pool,
      onPoolError() {},
    });
  const authority =
    options.kubernetesAuthority ??
    (await (
      options.createKubernetesAuthority ?? createDefaultKubernetesAuthority
    )(config));
  if (
    !authority ||
    typeof authority !== 'object' ||
    !authority.session ||
    typeof authority.session.withDelivery !== 'function' ||
    typeof authority.confirmAuthorization !== 'function' ||
    typeof authority.dispose !== 'function'
  ) {
    throw configFailure('Kubernetes execution authority is invalid');
  }
  let failure: unknown;
  try {
    const run = await (options.execute ?? runClusterWorkerCredentialExecution)({
      openDatabase,
      tokenRequestSession: authority.session,
      workerCredentialPepper: pepper,
      actionRef: command.actionRef,
      approvalRequestId: command.approvalRequestId,
      consumptionId: command.consumptionId,
      dispatchId: command.dispatchId,
      auditEventId: command.auditEventId,
      confirmAuthorization: authority.confirmAuthorization,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return Object.freeze({ status: 'completed' as const, command, run });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      authority.dispose();
    } catch (disposeError) {
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, disposeError],
          'Worker credential executor failed and Kubernetes authority did not dispose',
        );
      }
      throw disposeError;
    }
  }
}
