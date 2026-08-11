/** Worker credential management PostgreSQL process composition boundary. */
import type {
  OpenPostgresDatabase,
  PostgresDatabaseResource,
} from '@qinglong/runtime-core';
import {
  assertPostgresWorkerCredentialManagerSchemaReady,
  createPostgresDatabaseOpener,
  isPostgresTlsDnsServername,
  loadPostgresCertificateAuthorityFile,
  loadPostgresConnectionEnvironment,
  PostgresWorkerCredentialManagementIdentityKeysetLedgerRepository,
  PostgresWorkerCredentialManagementQuotaRepository,
  type PostgresConnectionOptions,
  type PostgresPoolOptions,
  type PostgresSchemaReadinessReport,
} from '@qinglong/cluster-postgres/worker-credential-manager';

import {
  absoluteManagementEnvironmentFile,
  booleanManagementEnvironmentValue,
  boundedManagementEnvironmentValue,
  integerManagementEnvironmentValue,
  readManagementTlsFile,
} from '../../management-support/managementProcessSupport';
import {
  createClusterWorkerCredentialIdentityKeysetFile,
  type ClusterPluginPackageIdentityKeysetFile,
  type ClusterPluginPackageIdentityKeysetSnapshot,
} from '../../management-support/pluginPackageIdentityKeyset';
import { createClusterWorkerCredentialManagementService } from './workerCredentialManagement';
import {
  startClusterWorkerCredentialManagementHttp,
  type ClusterWorkerCredentialManagementHttpApplication,
  type StartClusterWorkerCredentialManagementHttpOptions,
} from './workerCredentialManagementHttp';
import { createClusterWorkerCredentialManagementTransport } from './workerCredentialManagementTransport';
import { validateWorkerCredentialManagementClientTrust } from './workerCredentialManagementMutualTls';

const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,254}$/;
const SAFE_APPLICATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/;

export type ClusterWorkerCredentialManagementProcessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type ClusterWorkerCredentialManagementProcessConfig =
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
      planLifetimeMs: number;
      approvalLifetimeMs: number;
      quota: Readonly<{
        windowMs: number;
        planLimit: number;
        proposeLimit: number;
        decideLimit: number;
        inspectLimit: number;
      }>;
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

export type ClusterWorkerCredentialManagementProcessRuntime =
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

export interface StartClusterWorkerCredentialManagementProcessOptions {
  readonly environment: ClusterWorkerCredentialManagementProcessEnvironment;
  readonly openDatabase?: OpenPostgresDatabase;
  readonly identities?: ClusterPluginPackageIdentityKeysetFile;
  readonly assertReady?: (
    pool: PostgresDatabaseResource['pool'],
  ) => Promise<PostgresSchemaReadinessReport>;
  readonly startHttp?: (
    options: StartClusterWorkerCredentialManagementHttpOptions,
  ) => Promise<Readonly<ClusterWorkerCredentialManagementHttpApplication>>;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export class ClusterWorkerCredentialManagementProcessConfigError extends TypeError {
  readonly code = 'QL3_WORKER_CREDENTIAL_MANAGEMENT_PROCESS_CONFIG_INVALID';

  constructor(message: string) {
    super(
      `Worker credential management process configuration is invalid: ${message}`,
    );
    this.name = 'ClusterWorkerCredentialManagementProcessConfigError';
  }
}

function configFailure(
  message: string,
): ClusterWorkerCredentialManagementProcessConfigError {
  return new ClusterWorkerCredentialManagementProcessConfigError(message);
}

function boundedValue(
  environment: ClusterWorkerCredentialManagementProcessEnvironment,
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
  environment: ClusterWorkerCredentialManagementProcessEnvironment,
  name: string,
): boolean {
  return booleanManagementEnvironmentValue(environment, name, configFailure);
}

function integerValue(
  environment: ClusterWorkerCredentialManagementProcessEnvironment,
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

function absoluteFile(
  environment: ClusterWorkerCredentialManagementProcessEnvironment,
  name: string,
): string {
  return absoluteManagementEnvironmentFile(environment, name, configFailure);
}

function loadConnection(
  environment: ClusterWorkerCredentialManagementProcessEnvironment,
): Readonly<{
  connection: PostgresConnectionOptions;
  pool: PostgresPoolOptions;
}> {
  let connection: PostgresConnectionOptions;
  try {
    connection = loadPostgresConnectionEnvironment(environment, {
      connectionString: 'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_URL',
      host: 'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_HOST',
      port: 'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_PORT',
      database: 'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_DATABASE',
      user: 'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_USER',
      password: 'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_PASSWORD',
    });
  } catch (error) {
    throw configFailure(
      error instanceof Error
        ? error.message
        : 'PostgreSQL Worker credential manager connection is invalid',
    );
  }
  const mode =
    environment.QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_TLS_MODE ??
    'verify-full';
  if (mode !== 'verify-full' && mode !== 'disable') {
    throw configFailure(
      'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_TLS_MODE must be verify-full or disable',
    );
  }
  if (
    mode === 'disable' &&
    !booleanValue(
      environment,
      'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_ALLOW_INSECURE',
    )
  ) {
    throw configFailure(
      'disabling Worker credential manager PostgreSQL TLS requires QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_ALLOW_INSECURE=true',
    );
  }
  const servername = boundedValue(
    environment,
    'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_TLS_SERVERNAME',
    253,
  );
  if (mode === 'verify-full' && !isPostgresTlsDnsServername(servername)) {
    throw configFailure(
      'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_TLS_SERVERNAME must be an explicit DNS name',
    );
  }
  const caFile = boundedValue(
    environment,
    'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_TLS_CA_FILE',
    4_096,
  );
  if (mode === 'disable' && caFile !== undefined) {
    throw configFailure(
      'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_TLS_CA_FILE cannot be used when TLS is disabled',
    );
  }
  let ca: string | undefined;
  if (caFile !== undefined) {
    try {
      ca = loadPostgresCertificateAuthorityFile(caFile);
    } catch {
      throw configFailure(
        'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_TLS_CA_FILE is invalid',
      );
    }
  }
  const applicationName =
    boundedValue(
      environment,
      'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_APPLICATION_NAME',
      63,
    ) ?? 'qinglong3-worker-credential-manager';
  if (!SAFE_APPLICATION_NAME.test(applicationName)) {
    throw configFailure(
      'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_APPLICATION_NAME is invalid',
    );
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
        'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_MAX_CONNECTIONS',
        2,
        1,
        4,
      ),
      connectionTimeoutMs: integerValue(
        environment,
        'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_CONNECTION_TIMEOUT_MS',
        5_000,
        100,
        60_000,
      ),
    }),
  });
}

export function loadClusterWorkerCredentialManagementProcessConfig(
  environment: ClusterWorkerCredentialManagementProcessEnvironment,
): Readonly<ClusterWorkerCredentialManagementProcessConfig> {
  if (!environment || typeof environment !== 'object') {
    throw configFailure('environment is invalid');
  }
  if (!booleanValue(environment, 'QL3_WORKER_CREDENTIAL_MANAGEMENT_ENABLED')) {
    return Object.freeze({ enabled: false as const });
  }
  if (environment.QL3_PROFILE !== 'cluster-admin') {
    throw configFailure(
      'QL3_PROFILE must be cluster-admin when Worker credential management is enabled',
    );
  }
  const host =
    boundedValue(environment, 'QL3_WORKER_CREDENTIAL_MANAGEMENT_HOST', 255) ??
    '0.0.0.0';
  if (!SAFE_HOST.test(host)) {
    throw configFailure('QL3_WORKER_CREDENTIAL_MANAGEMENT_HOST is invalid');
  }
  const http = Object.freeze({
    maxBodyBytes: integerValue(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_MAX_BODY_BYTES',
      64 * 1024,
      1_024,
      256 * 1024,
    ),
    maxConnections: integerValue(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_MAX_CONNECTIONS',
      64,
      1,
      512,
    ),
    maxConcurrentRequests: integerValue(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_MAX_CONCURRENT_REQUESTS',
      32,
      1,
      256,
    ),
    requestTimeoutMs: integerValue(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_REQUEST_TIMEOUT_MS',
      10_000,
      1_000,
      60_000,
    ),
    drainTimeoutMs: integerValue(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_DRAIN_TIMEOUT_MS',
      5_000,
      100,
      60_000,
    ),
    rateWindowMs: integerValue(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_RATE_WINDOW_MS',
      60_000,
      1_000,
      5 * 60_000,
    ),
    peerRequestLimit: integerValue(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_PEER_REQUEST_LIMIT',
      60,
      1,
      10_000,
    ),
    globalRequestLimit: integerValue(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_GLOBAL_REQUEST_LIMIT',
      600,
      1,
      100_000,
    ),
    maxRateLimitPeers: integerValue(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_MAX_RATE_LIMIT_PEERS',
      1_024,
      1,
      16_384,
    ),
  });
  if (http.globalRequestLimit < http.peerRequestLimit) {
    throw configFailure(
      'global request limit cannot be below the peer request limit',
    );
  }
  return Object.freeze({
    enabled: true as const,
    profile: 'cluster-admin' as const,
    host,
    port: integerValue(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_PORT',
      8_444,
      1,
      65_535,
    ),
    certificateFile: absoluteFile(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_TLS_CERT_FILE',
    ),
    privateKeyFile: absoluteFile(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_TLS_KEY_FILE',
    ),
    clientCertificateAuthorityFile: absoluteFile(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_CA_FILE',
    ),
    clientCertificateRevocationListFile: absoluteFile(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_CRL_FILE',
    ),
    identityKeysetFile: absoluteFile(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_IDENTITY_KEYSET_FILE',
    ),
    planLifetimeMs: integerValue(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_PLAN_LIFETIME_MS',
      15 * 60_000,
      1_000,
      15 * 60_000,
    ),
    approvalLifetimeMs: integerValue(
      environment,
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_APPROVAL_LIFETIME_MS',
      15 * 60_000,
      1_000,
      15 * 60_000,
    ),
    quota: Object.freeze({
      windowMs: integerValue(
        environment,
        'QL3_WORKER_CREDENTIAL_MANAGEMENT_QUOTA_WINDOW_MS',
        60_000,
        1_000,
        5 * 60_000,
      ),
      planLimit: integerValue(
        environment,
        'QL3_WORKER_CREDENTIAL_MANAGEMENT_PLAN_QUOTA',
        30,
        1,
        1_000,
      ),
      proposeLimit: integerValue(
        environment,
        'QL3_WORKER_CREDENTIAL_MANAGEMENT_PROPOSE_QUOTA',
        30,
        1,
        1_000,
      ),
      decideLimit: integerValue(
        environment,
        'QL3_WORKER_CREDENTIAL_MANAGEMENT_DECIDE_QUOTA',
        60,
        1,
        1_000,
      ),
      inspectLimit: integerValue(
        environment,
        'QL3_WORKER_CREDENTIAL_MANAGEMENT_INSPECT_QUOTA',
        600,
        1,
        1_000,
      ),
    }),
    http,
    database: loadConnection(environment),
  });
}

export async function startClusterWorkerCredentialManagementProcess(
  options: StartClusterWorkerCredentialManagementProcessOptions,
): Promise<Readonly<ClusterWorkerCredentialManagementProcessRuntime>> {
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
    throw configFailure('options are invalid');
  }
  const config = loadClusterWorkerCredentialManagementProcessConfig(
    options.environment,
  );
  if (!config.enabled) {
    return Object.freeze({
      status: 'disabled' as const,
      close: () => Promise.resolve(),
    });
  }
  const now = options.now ?? Date.now;
  let http:
    | Readonly<ClusterWorkerCredentialManagementHttpApplication>
    | undefined;
  let database: PostgresDatabaseResource | undefined;
  let unavailableError: unknown;
  let closePromise: Promise<void> | undefined;
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics do not own availability or cleanup.
    }
  };
  const openDatabase =
    options.openDatabase ??
    createPostgresDatabaseOpener({
      role: 'worker-credential-manager',
      connection: config.database.connection,
      pool: config.database.pool,
      onPoolError(error) {
        const firstAvailabilityError = unavailableError === undefined;
        unavailableError ??= error;
        http?.withdraw(error);
        if (firstAvailabilityError) report(error);
      },
    });
  try {
    database = await openDatabase();
    const evidence = await (
      options.assertReady ?? assertPostgresWorkerCredentialManagerSchemaReady
    )(database.pool);
    if (unavailableError !== undefined) throw unavailableError;
    const identities =
      options.identities ??
      createClusterWorkerCredentialIdentityKeysetFile({
        filePath: config.identityKeysetFile,
        now,
        ledger:
          new PostgresWorkerCredentialManagementIdentityKeysetLedgerRepository(
            database.pool,
            'worker-credential-management',
          ),
      });
    const identity = await identities.reload();
    const quota = new PostgresWorkerCredentialManagementQuotaRepository(
      database.pool,
      {
        windowMs: config.quota.windowMs,
        limits: {
          'worker-credential.plan': config.quota.planLimit,
          'worker-credential.propose': config.quota.proposeLimit,
          'worker-credential.decide': config.quota.decideLimit,
          'worker-credential.inspect': config.quota.inspectLimit,
        },
      },
    );
    const service = createClusterWorkerCredentialManagementService({
      pool: database.pool,
      planLifetimeMs: config.planLifetimeMs,
      approvalLifetimeMs: config.approvalLifetimeMs,
      quota,
      now,
    });
    const transport = createClusterWorkerCredentialManagementTransport({
      service,
      now,
    });
    const privateKey = readManagementTlsFile(
      config.privateKeyFile,
      true,
      configFailure,
    );
    try {
      const certificate = readManagementTlsFile(
        config.certificateFile,
        false,
        configFailure,
      );
      const clientCertificateAuthority = readManagementTlsFile(
        config.clientCertificateAuthorityFile,
        false,
        configFailure,
      );
      const clientCertificateRevocationList = readManagementTlsFile(
        config.clientCertificateRevocationListFile,
        false,
        configFailure,
      );
      try {
        validateWorkerCredentialManagementClientTrust(
          clientCertificateAuthority,
          clientCertificateRevocationList,
          now(),
          configFailure,
        );
        http = await (
          options.startHttp ?? startClusterWorkerCredentialManagementHttp
        )({
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
        clientCertificateAuthority.fill(0);
        clientCertificateRevocationList.fill(0);
      }
    } finally {
      privateKey.fill(0);
    }
    if (unavailableError !== undefined) {
      http.withdraw(unavailableError);
    }
    return Object.freeze({
      status: 'active' as const,
      address: http.address,
      database: evidence,
      identity,
      availabilityStatus: () => http?.availabilityStatus() ?? 'stopped',
      close(): Promise<void> {
        if (closePromise) return closePromise;
        closePromise = (async () => {
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
