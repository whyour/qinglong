import type {
  OpenPostgresDatabase,
  PostgresDatabaseResource,
} from '@qinglong/runtime-core';
import {
  PostgresApprovalManagementIdentityKeysetLedgerRepository,
  assertPostgresApprovalManagerSchemaReady,
  createPostgresDatabaseOpener,
  isPostgresTlsDnsServername,
  loadPostgresCertificateAuthorityFile,
  loadPostgresConnectionEnvironment,
  type PostgresConnectionOptions,
  type PostgresPoolOptions,
  type PostgresSchemaReadinessReport,
} from '@qinglong/cluster-postgres/approval-manager';
import {
  absoluteManagementEnvironmentFile,
  booleanManagementEnvironmentValue,
  boundedManagementEnvironmentValue,
  integerManagementEnvironmentValue,
  readManagementTlsFile,
} from '../management-support/managementProcessSupport';
import {
  createClusterApprovalIdentityKeysetFile,
  type ClusterPluginPackageIdentityKeysetFile,
  type ClusterPluginPackageIdentityKeysetSnapshot,
} from '../management-support/pluginPackageIdentityKeyset';
import { validateClusterManagementClientTrust } from '../worker-credential/management-server/workerCredentialManagementMutualTls';
import { createClusterApprovalManagementService } from './approvalManagement';
import {
  startClusterApprovalManagementHttp,
  type ClusterApprovalManagementHttpApplication,
  type StartClusterApprovalManagementHttpOptions,
} from './approvalManagementHttp';
import { createClusterApprovalManagementTransport } from './approvalManagementTransport';

const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,254}$/;
const SAFE_APPLICATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/;

export type ClusterApprovalManagementProcessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type ClusterApprovalManagementProcessConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      profile: 'cluster-admin';
      host: string;
      port: number;
      certificateFile: string;
      privateKeyFile: string;
      clientCertificateAuthorityFile: string;
      clientCertificateRevocationListFile: string;
      identityKeysetFile: string;
      http: Readonly<{
        maxBodyBytes: number;
        maxConnections: number;
        maxConcurrentRequests: number;
        requestTimeoutMs: number;
        drainTimeoutMs: number;
        rateWindowMs: number;
        peerRequestLimit: number;
        globalRequestLimit: number;
        maxRateLimitPeers: number;
      }>;
      database: Readonly<{
        connection: PostgresConnectionOptions;
        pool: PostgresPoolOptions;
      }>;
    }>;

export type ClusterApprovalManagementProcessRuntime =
  | Readonly<{
      status: 'disabled';
      close(): Promise<void>;
    }>
  | Readonly<{
      status: 'active';
      address: Readonly<{ host: string; port: number }>;
      database: PostgresSchemaReadinessReport;
      identity: ClusterPluginPackageIdentityKeysetSnapshot;
      availabilityStatus(): 'ready' | 'unavailable' | 'stopped';
      close(): Promise<void>;
    }>;

export interface StartClusterApprovalManagementProcessOptions {
  readonly environment: ClusterApprovalManagementProcessEnvironment;
  readonly openDatabase?: OpenPostgresDatabase;
  readonly identities?: ClusterPluginPackageIdentityKeysetFile;
  readonly assertReady?: (
    pool: PostgresDatabaseResource['pool'],
  ) => Promise<PostgresSchemaReadinessReport>;
  readonly startHttp?: (
    options: StartClusterApprovalManagementHttpOptions,
  ) => Promise<Readonly<ClusterApprovalManagementHttpApplication>>;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export class ClusterApprovalManagementProcessConfigError extends TypeError {
  readonly code = 'QL3_APPROVAL_MANAGEMENT_PROCESS_CONFIG_INVALID';

  constructor(message: string) {
    super(`Approval management process configuration is invalid: ${message}`);
    this.name = 'ClusterApprovalManagementProcessConfigError';
  }
}

function failure(message: string): ClusterApprovalManagementProcessConfigError {
  return new ClusterApprovalManagementProcessConfigError(message);
}

function bounded(
  environment: ClusterApprovalManagementProcessEnvironment,
  name: string,
  maximumLength: number,
  required = false,
): string | undefined {
  return boundedManagementEnvironmentValue(
    environment,
    name,
    maximumLength,
    failure,
    required,
  );
}

function bool(
  environment: ClusterApprovalManagementProcessEnvironment,
  name: string,
): boolean {
  return booleanManagementEnvironmentValue(environment, name, failure);
}

function integer(
  environment: ClusterApprovalManagementProcessEnvironment,
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
    failure,
  );
}

function absolute(
  environment: ClusterApprovalManagementProcessEnvironment,
  name: string,
): string {
  return absoluteManagementEnvironmentFile(environment, name, failure);
}

function loadDatabase(
  environment: ClusterApprovalManagementProcessEnvironment,
): Readonly<{
  connection: PostgresConnectionOptions;
  pool: PostgresPoolOptions;
}> {
  let connection: PostgresConnectionOptions;
  try {
    connection = loadPostgresConnectionEnvironment(environment, {
      connectionString: 'QL3_POSTGRES_APPROVAL_MANAGER_URL',
      host: 'QL3_POSTGRES_APPROVAL_MANAGER_HOST',
      port: 'QL3_POSTGRES_APPROVAL_MANAGER_PORT',
      database: 'QL3_POSTGRES_APPROVAL_MANAGER_DATABASE',
      user: 'QL3_POSTGRES_APPROVAL_MANAGER_USER',
      password: 'QL3_POSTGRES_APPROVAL_MANAGER_PASSWORD',
    });
  } catch (error) {
    throw failure(
      error instanceof Error
        ? error.message
        : 'PostgreSQL approval manager connection is invalid',
    );
  }
  const mode =
    environment.QL3_POSTGRES_APPROVAL_MANAGER_TLS_MODE ?? 'verify-full';
  if (mode !== 'verify-full' && mode !== 'disable') {
    throw failure(
      'QL3_POSTGRES_APPROVAL_MANAGER_TLS_MODE must be verify-full or disable',
    );
  }
  if (
    mode === 'disable' &&
    !bool(environment, 'QL3_POSTGRES_APPROVAL_MANAGER_ALLOW_INSECURE')
  ) {
    throw failure(
      'disabling approval manager PostgreSQL TLS requires QL3_POSTGRES_APPROVAL_MANAGER_ALLOW_INSECURE=true',
    );
  }
  const servername = bounded(
    environment,
    'QL3_POSTGRES_APPROVAL_MANAGER_TLS_SERVERNAME',
    253,
  );
  if (mode === 'verify-full' && !isPostgresTlsDnsServername(servername)) {
    throw failure(
      'QL3_POSTGRES_APPROVAL_MANAGER_TLS_SERVERNAME must be an explicit DNS name',
    );
  }
  const caFile = bounded(
    environment,
    'QL3_POSTGRES_APPROVAL_MANAGER_TLS_CA_FILE',
    4_096,
  );
  if (mode === 'disable' && caFile !== undefined) {
    throw failure(
      'QL3_POSTGRES_APPROVAL_MANAGER_TLS_CA_FILE cannot be used when TLS is disabled',
    );
  }
  let ca: string | undefined;
  if (caFile !== undefined) {
    try {
      ca = loadPostgresCertificateAuthorityFile(caFile);
    } catch {
      throw failure('QL3_POSTGRES_APPROVAL_MANAGER_TLS_CA_FILE is invalid');
    }
  }
  const applicationName =
    bounded(
      environment,
      'QL3_POSTGRES_APPROVAL_MANAGER_APPLICATION_NAME',
      63,
    ) ?? 'qinglong3-approval-manager';
  if (!SAFE_APPLICATION_NAME.test(applicationName)) {
    throw failure('QL3_POSTGRES_APPROVAL_MANAGER_APPLICATION_NAME is invalid');
  }
  return Object.freeze({
    connection: Object.freeze({
      ...connection,
      tls:
        mode === 'disable'
          ? Object.freeze({ mode: 'disable' as const })
          : Object.freeze({
              mode: 'verify-full' as const,
              servername: servername!,
              ...(ca === undefined ? {} : { ca }),
            }),
    }),
    pool: Object.freeze({
      applicationName,
      maxConnections: integer(
        environment,
        'QL3_POSTGRES_APPROVAL_MANAGER_POOL_MAX',
        2,
        1,
        4,
      ),
      idleTimeoutMs: integer(
        environment,
        'QL3_POSTGRES_APPROVAL_MANAGER_IDLE_TIMEOUT_MS',
        10_000,
        1_000,
        60_000,
      ),
      connectionTimeoutMs: integer(
        environment,
        'QL3_POSTGRES_APPROVAL_MANAGER_CONNECTION_TIMEOUT_MS',
        5_000,
        100,
        60_000,
      ),
    }),
  });
}

export function loadClusterApprovalManagementProcessConfig(
  environment: ClusterApprovalManagementProcessEnvironment,
): Readonly<ClusterApprovalManagementProcessConfig> {
  if (!environment || typeof environment !== 'object') {
    throw failure('environment is invalid');
  }
  if (!bool(environment, 'QL3_APPROVAL_MANAGEMENT_ENABLED')) {
    return Object.freeze({ enabled: false as const });
  }
  if (environment.QL3_PROFILE !== 'cluster-admin') {
    throw failure(
      'QL3_PROFILE must be cluster-admin when Approval management is enabled',
    );
  }
  const host =
    bounded(environment, 'QL3_APPROVAL_MANAGEMENT_HOST', 255) ?? '0.0.0.0';
  if (!SAFE_HOST.test(host)) {
    throw failure('QL3_APPROVAL_MANAGEMENT_HOST is invalid');
  }
  const http = Object.freeze({
    maxBodyBytes: integer(
      environment,
      'QL3_APPROVAL_MANAGEMENT_MAX_BODY_BYTES',
      64 * 1024,
      1_024,
      256 * 1024,
    ),
    maxConnections: integer(
      environment,
      'QL3_APPROVAL_MANAGEMENT_MAX_CONNECTIONS',
      32,
      1,
      512,
    ),
    maxConcurrentRequests: integer(
      environment,
      'QL3_APPROVAL_MANAGEMENT_MAX_CONCURRENT_REQUESTS',
      16,
      1,
      256,
    ),
    requestTimeoutMs: integer(
      environment,
      'QL3_APPROVAL_MANAGEMENT_REQUEST_TIMEOUT_MS',
      10_000,
      1_000,
      60_000,
    ),
    drainTimeoutMs: integer(
      environment,
      'QL3_APPROVAL_MANAGEMENT_DRAIN_TIMEOUT_MS',
      5_000,
      100,
      60_000,
    ),
    rateWindowMs: integer(
      environment,
      'QL3_APPROVAL_MANAGEMENT_RATE_WINDOW_MS',
      60_000,
      1_000,
      5 * 60_000,
    ),
    peerRequestLimit: integer(
      environment,
      'QL3_APPROVAL_MANAGEMENT_PEER_REQUEST_LIMIT',
      30,
      1,
      10_000,
    ),
    globalRequestLimit: integer(
      environment,
      'QL3_APPROVAL_MANAGEMENT_GLOBAL_REQUEST_LIMIT',
      300,
      1,
      100_000,
    ),
    maxRateLimitPeers: integer(
      environment,
      'QL3_APPROVAL_MANAGEMENT_MAX_RATE_LIMIT_PEERS',
      1_024,
      1,
      16_384,
    ),
  });
  if (http.globalRequestLimit < http.peerRequestLimit) {
    throw failure('global request limit cannot be below peer request limit');
  }
  return Object.freeze({
    enabled: true as const,
    profile: 'cluster-admin' as const,
    host,
    port: integer(
      environment,
      'QL3_APPROVAL_MANAGEMENT_PORT',
      8_447,
      1,
      65_535,
    ),
    certificateFile: absolute(
      environment,
      'QL3_APPROVAL_MANAGEMENT_TLS_CERT_FILE',
    ),
    privateKeyFile: absolute(
      environment,
      'QL3_APPROVAL_MANAGEMENT_TLS_KEY_FILE',
    ),
    clientCertificateAuthorityFile: absolute(
      environment,
      'QL3_APPROVAL_MANAGEMENT_CLIENT_CA_FILE',
    ),
    clientCertificateRevocationListFile: absolute(
      environment,
      'QL3_APPROVAL_MANAGEMENT_CLIENT_CRL_FILE',
    ),
    identityKeysetFile: absolute(
      environment,
      'QL3_APPROVAL_MANAGEMENT_IDENTITY_KEYSET_FILE',
    ),
    http,
    database: loadDatabase(environment),
  });
}

export async function startClusterApprovalManagementProcess(
  options: StartClusterApprovalManagementProcessOptions,
): Promise<Readonly<ClusterApprovalManagementProcessRuntime>> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          'environment',
          'openDatabase',
          'identities',
          'assertReady',
          'startHttp',
          'now',
          'onError',
        ].includes(key),
    ) ||
    !options.environment ||
    typeof options.environment !== 'object' ||
    (options.openDatabase !== undefined &&
      typeof options.openDatabase !== 'function') ||
    (options.identities !== undefined &&
      (typeof options.identities.reload !== 'function' ||
        typeof options.identities.bind !== 'function')) ||
    (options.assertReady !== undefined &&
      typeof options.assertReady !== 'function') ||
    (options.startHttp !== undefined &&
      typeof options.startHttp !== 'function') ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.onError !== undefined && typeof options.onError !== 'function')
  ) {
    throw failure('options are invalid');
  }
  const config = loadClusterApprovalManagementProcessConfig(
    options.environment,
  );
  if (!config.enabled) {
    return Object.freeze({
      status: 'disabled' as const,
      close: () => Promise.resolve(),
    });
  }
  const now = options.now ?? Date.now;
  let http: Readonly<ClusterApprovalManagementHttpApplication> | undefined;
  let database: PostgresDatabaseResource | undefined;
  let unavailableError: unknown;
  let closePromise: Promise<void> | undefined;
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics never own availability or cleanup.
    }
  };
  const openDatabase =
    options.openDatabase ??
    createPostgresDatabaseOpener({
      role: 'approval-manager',
      connection: config.database.connection,
      pool: config.database.pool,
      onPoolError(error) {
        const first = unavailableError === undefined;
        unavailableError ??= error;
        http?.withdraw(error);
        if (first) report(error);
      },
    });
  try {
    database = await openDatabase();
    const evidence = await (
      options.assertReady ?? assertPostgresApprovalManagerSchemaReady
    )(database.pool);
    if (unavailableError !== undefined) throw unavailableError;
    const identities =
      options.identities ??
      createClusterApprovalIdentityKeysetFile({
        filePath: config.identityKeysetFile,
        now,
        ledger: new PostgresApprovalManagementIdentityKeysetLedgerRepository(
          database.pool,
          'approval-management',
        ),
      });
    const identity = await identities.reload();
    const service = createClusterApprovalManagementService({
      pool: database.pool,
      now,
    });
    const transport = createClusterApprovalManagementTransport({
      service,
      now,
    });
    const privateKey = readManagementTlsFile(
      config.privateKeyFile,
      true,
      failure,
    );
    try {
      const certificate = readManagementTlsFile(
        config.certificateFile,
        false,
        failure,
      );
      const clientCertificateAuthority = readManagementTlsFile(
        config.clientCertificateAuthorityFile,
        false,
        failure,
      );
      const clientCertificateRevocationList = readManagementTlsFile(
        config.clientCertificateRevocationListFile,
        false,
        failure,
      );
      validateClusterManagementClientTrust(
        clientCertificateAuthority,
        clientCertificateRevocationList,
        now(),
        failure,
      );
      http = await (options.startHttp ?? startClusterApprovalManagementHttp)({
        host: config.host,
        port: config.port,
        tls: {
          privateKey,
          certificate,
          clientCertificateAuthority,
          clientCertificateRevocationList,
        },
        transport,
        identities,
        limits: config.http,
        now,
        onError: report,
      });
    } finally {
      privateKey.fill(0);
    }
    if (unavailableError !== undefined) http.withdraw(unavailableError);
    return Object.freeze({
      status: 'active' as const,
      address: http.address,
      database: evidence,
      identity,
      availabilityStatus: () => http?.availabilityStatus() ?? 'stopped',
      close(): Promise<void> {
        closePromise ??= (async () => {
          let primaryError: unknown;
          try {
            await http?.close();
          } catch (error) {
            primaryError = error;
          }
          try {
            await database?.close();
          } catch (error) {
            primaryError ??= error;
          }
          if (primaryError) throw primaryError;
        })();
        return closePromise;
      },
    });
  } catch (error) {
    try {
      await http?.close();
    } catch {
      // Preserve startup failure.
    }
    try {
      await database?.close();
    } catch {
      // Preserve startup failure.
    }
    throw error;
  }
}
