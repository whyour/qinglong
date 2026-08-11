import type {
  OpenPostgresDatabase,
  PostgresDatabaseResource,
} from '@qinglong/runtime-core';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import {
  PostgresAutomationManagementIdentityKeysetLedgerRepository,
  PostgresProjectPolicyRepository,
  PostgresTaskDefinitionAdministrationRepository,
  PostgresTriggerAdministrationRepository,
  assertPostgresAutomationManagerSchemaReady,
  createPostgresDatabaseOpener,
  isPostgresTlsDnsServername,
  loadPostgresCertificateAuthorityFile,
  loadPostgresConnectionEnvironment,
  type PostgresConnectionOptions,
  type PostgresPoolOptions,
  type PostgresSchemaReadinessReport,
} from '@qinglong/cluster-postgres/automation-manager';

import {
  absoluteManagementEnvironmentFile,
  booleanManagementEnvironmentValue,
  boundedManagementEnvironmentValue,
  integerManagementEnvironmentValue,
  readManagementTlsFile,
} from '../management-support/managementProcessSupport';
import {
  createClusterAutomationIdentityKeysetFile,
  type ClusterPluginPackageIdentityKeysetFile,
  type ClusterPluginPackageIdentityKeysetSnapshot,
} from '../management-support/pluginPackageIdentityKeyset';
import { createClusterAutomationManagementService } from './automationManagement';
import {
  startClusterAutomationManagementHttp,
  type ClusterAutomationManagementHttpApplication,
  type StartClusterAutomationManagementHttpOptions,
} from './automationManagementHttp';
import { createClusterAutomationManagementTransport } from './automationManagementTransport';
import { validateClusterManagementClientTrust } from '../worker-credential/management-server/workerCredentialManagementMutualTls';

const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,254}$/;
const SAFE_APPLICATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/;

export type ClusterAutomationManagementProcessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type ClusterAutomationManagementProcessConfig =
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

export type ClusterAutomationManagementProcessRuntime =
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

export interface StartClusterAutomationManagementProcessOptions {
  readonly environment: ClusterAutomationManagementProcessEnvironment;
  readonly openDatabase?: OpenPostgresDatabase;
  readonly identities?: ClusterPluginPackageIdentityKeysetFile;
  readonly assertReady?: (
    pool: PostgresDatabaseResource['pool'],
  ) => Promise<PostgresSchemaReadinessReport>;
  readonly startHttp?: (
    options: StartClusterAutomationManagementHttpOptions,
  ) => Promise<Readonly<ClusterAutomationManagementHttpApplication>>;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export class ClusterAutomationManagementProcessConfigError extends TypeError {
  readonly code = 'QL3_AUTOMATION_MANAGEMENT_PROCESS_CONFIG_INVALID';

  constructor(message: string) {
    super(`Automation management process configuration is invalid: ${message}`);
    this.name = 'ClusterAutomationManagementProcessConfigError';
  }
}

function configFailure(
  message: string,
): ClusterAutomationManagementProcessConfigError {
  return new ClusterAutomationManagementProcessConfigError(message);
}

function boundedValue(
  environment: ClusterAutomationManagementProcessEnvironment,
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
  environment: ClusterAutomationManagementProcessEnvironment,
  name: string,
): boolean {
  return booleanManagementEnvironmentValue(environment, name, configFailure);
}

function integerValue(
  environment: ClusterAutomationManagementProcessEnvironment,
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
  environment: ClusterAutomationManagementProcessEnvironment,
  name: string,
): string {
  return absoluteManagementEnvironmentFile(environment, name, configFailure);
}

function loadConnection(
  environment: ClusterAutomationManagementProcessEnvironment,
): Readonly<{
  connection: PostgresConnectionOptions;
  pool: PostgresPoolOptions;
}> {
  let connection: PostgresConnectionOptions;
  try {
    connection = loadPostgresConnectionEnvironment(environment, {
      connectionString: 'QL3_POSTGRES_AUTOMATION_MANAGER_URL',
      host: 'QL3_POSTGRES_AUTOMATION_MANAGER_HOST',
      port: 'QL3_POSTGRES_AUTOMATION_MANAGER_PORT',
      database: 'QL3_POSTGRES_AUTOMATION_MANAGER_DATABASE',
      user: 'QL3_POSTGRES_AUTOMATION_MANAGER_USER',
      password: 'QL3_POSTGRES_AUTOMATION_MANAGER_PASSWORD',
    });
  } catch (error) {
    throw configFailure(
      error instanceof Error
        ? error.message
        : 'PostgreSQL automation manager connection is invalid',
    );
  }
  const mode =
    environment.QL3_POSTGRES_AUTOMATION_MANAGER_TLS_MODE ?? 'verify-full';
  if (mode !== 'verify-full' && mode !== 'disable') {
    throw configFailure(
      'QL3_POSTGRES_AUTOMATION_MANAGER_TLS_MODE must be verify-full or disable',
    );
  }
  if (
    mode === 'disable' &&
    !booleanValue(environment, 'QL3_POSTGRES_AUTOMATION_MANAGER_ALLOW_INSECURE')
  ) {
    throw configFailure(
      'disabling automation manager PostgreSQL TLS requires QL3_POSTGRES_AUTOMATION_MANAGER_ALLOW_INSECURE=true',
    );
  }
  const servername = boundedValue(
    environment,
    'QL3_POSTGRES_AUTOMATION_MANAGER_TLS_SERVERNAME',
    253,
  );
  if (mode === 'verify-full' && !isPostgresTlsDnsServername(servername)) {
    throw configFailure(
      'QL3_POSTGRES_AUTOMATION_MANAGER_TLS_SERVERNAME must be an explicit DNS name',
    );
  }
  const caFile = boundedValue(
    environment,
    'QL3_POSTGRES_AUTOMATION_MANAGER_TLS_CA_FILE',
    4_096,
  );
  if (mode === 'disable' && caFile !== undefined) {
    throw configFailure(
      'QL3_POSTGRES_AUTOMATION_MANAGER_TLS_CA_FILE cannot be used when TLS is disabled',
    );
  }
  let ca: string | undefined;
  if (caFile !== undefined) {
    try {
      ca = loadPostgresCertificateAuthorityFile(caFile);
    } catch {
      throw configFailure(
        'QL3_POSTGRES_AUTOMATION_MANAGER_TLS_CA_FILE is invalid',
      );
    }
  }
  const applicationName =
    boundedValue(
      environment,
      'QL3_POSTGRES_AUTOMATION_MANAGER_APPLICATION_NAME',
      63,
    ) ?? 'qinglong3-automation-manager';
  if (!SAFE_APPLICATION_NAME.test(applicationName)) {
    throw configFailure(
      'QL3_POSTGRES_AUTOMATION_MANAGER_APPLICATION_NAME is invalid',
    );
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
      maxConnections: integerValue(
        environment,
        'QL3_POSTGRES_AUTOMATION_MANAGER_POOL_MAX',
        2,
        1,
        4,
      ),
      idleTimeoutMs: integerValue(
        environment,
        'QL3_POSTGRES_AUTOMATION_MANAGER_IDLE_TIMEOUT_MS',
        10_000,
        1_000,
        60_000,
      ),
      connectionTimeoutMs: integerValue(
        environment,
        'QL3_POSTGRES_AUTOMATION_MANAGER_CONNECTION_TIMEOUT_MS',
        5_000,
        100,
        60_000,
      ),
    }),
  });
}

export function loadClusterAutomationManagementProcessConfig(
  environment: ClusterAutomationManagementProcessEnvironment,
): Readonly<ClusterAutomationManagementProcessConfig> {
  if (!environment || typeof environment !== 'object') {
    throw configFailure('environment is invalid');
  }
  if (!booleanValue(environment, 'QL3_AUTOMATION_MANAGEMENT_ENABLED')) {
    return Object.freeze({ enabled: false as const });
  }
  if (environment.QL3_PROFILE !== 'cluster-admin') {
    throw configFailure(
      'QL3_PROFILE must be cluster-admin when automation management is enabled',
    );
  }
  const host =
    boundedValue(environment, 'QL3_AUTOMATION_MANAGEMENT_HOST', 255) ??
    '0.0.0.0';
  if (!SAFE_HOST.test(host)) {
    throw configFailure('QL3_AUTOMATION_MANAGEMENT_HOST is invalid');
  }
  const http = Object.freeze({
    maxBodyBytes: integerValue(
      environment,
      'QL3_AUTOMATION_MANAGEMENT_MAX_BODY_BYTES',
      64 * 1024,
      1_024,
      256 * 1024,
    ),
    maxConnections: integerValue(
      environment,
      'QL3_AUTOMATION_MANAGEMENT_MAX_CONNECTIONS',
      32,
      1,
      512,
    ),
    maxConcurrentRequests: integerValue(
      environment,
      'QL3_AUTOMATION_MANAGEMENT_MAX_CONCURRENT_REQUESTS',
      16,
      1,
      256,
    ),
    requestTimeoutMs: integerValue(
      environment,
      'QL3_AUTOMATION_MANAGEMENT_REQUEST_TIMEOUT_MS',
      10_000,
      1_000,
      60_000,
    ),
    drainTimeoutMs: integerValue(
      environment,
      'QL3_AUTOMATION_MANAGEMENT_DRAIN_TIMEOUT_MS',
      5_000,
      100,
      60_000,
    ),
    rateWindowMs: integerValue(
      environment,
      'QL3_AUTOMATION_MANAGEMENT_RATE_WINDOW_MS',
      60_000,
      1_000,
      5 * 60_000,
    ),
    peerRequestLimit: integerValue(
      environment,
      'QL3_AUTOMATION_MANAGEMENT_PEER_REQUEST_LIMIT',
      60,
      1,
      10_000,
    ),
    globalRequestLimit: integerValue(
      environment,
      'QL3_AUTOMATION_MANAGEMENT_GLOBAL_REQUEST_LIMIT',
      600,
      1,
      100_000,
    ),
    maxRateLimitPeers: integerValue(
      environment,
      'QL3_AUTOMATION_MANAGEMENT_MAX_RATE_LIMIT_PEERS',
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
      'QL3_AUTOMATION_MANAGEMENT_PORT',
      8_445,
      1,
      65_535,
    ),
    certificateFile: absoluteFile(
      environment,
      'QL3_AUTOMATION_MANAGEMENT_TLS_CERT_FILE',
    ),
    privateKeyFile: absoluteFile(
      environment,
      'QL3_AUTOMATION_MANAGEMENT_TLS_KEY_FILE',
    ),
    clientCertificateAuthorityFile: absoluteFile(
      environment,
      'QL3_AUTOMATION_MANAGEMENT_CLIENT_CA_FILE',
    ),
    clientCertificateRevocationListFile: absoluteFile(
      environment,
      'QL3_AUTOMATION_MANAGEMENT_CLIENT_CRL_FILE',
    ),
    identityKeysetFile: absoluteFile(
      environment,
      'QL3_AUTOMATION_MANAGEMENT_IDENTITY_KEYSET_FILE',
    ),
    http,
    database: loadConnection(environment),
  });
}

function readTlsFile(filePath: string, privateMaterial: boolean): Buffer {
  return readManagementTlsFile(filePath, privateMaterial, configFailure);
}

export async function startClusterAutomationManagementProcess(
  options: StartClusterAutomationManagementProcessOptions,
): Promise<Readonly<ClusterAutomationManagementProcessRuntime>> {
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
  const config = loadClusterAutomationManagementProcessConfig(
    options.environment,
  );
  if (!config.enabled) {
    return Object.freeze({
      status: 'disabled' as const,
      close: () => Promise.resolve(),
    });
  }
  const now = options.now ?? Date.now;
  let http: Readonly<ClusterAutomationManagementHttpApplication> | undefined;
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
      role: 'automation-manager',
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
      options.assertReady ?? assertPostgresAutomationManagerSchemaReady
    )(database.pool);
    if (unavailableError !== undefined) throw unavailableError;
    const identities =
      options.identities ??
      createClusterAutomationIdentityKeysetFile({
        filePath: config.identityKeysetFile,
        now,
        ledger: new PostgresAutomationManagementIdentityKeysetLedgerRepository(
          database.pool,
          'automation-management',
        ),
      });
    const identity = await identities.reload();
    const policy = new ProjectPolicyEngine(
      new PostgresProjectPolicyRepository(database.pool),
    );
    const service = createClusterAutomationManagementService({
      policy,
      taskDefinitions: new PostgresTaskDefinitionAdministrationRepository(
        database.pool,
      ),
      triggers: new PostgresTriggerAdministrationRepository(database.pool),
      now,
    });
    const transport = createClusterAutomationManagementTransport({
      service,
      now,
    });
    const privateKey = readTlsFile(config.privateKeyFile, true);
    try {
      const certificate = readTlsFile(config.certificateFile, false);
      const clientCertificateAuthority = readTlsFile(
        config.clientCertificateAuthorityFile,
        false,
      );
      const clientCertificateRevocationList = readTlsFile(
        config.clientCertificateRevocationListFile,
        false,
      );
      validateClusterManagementClientTrust(
        clientCertificateAuthority,
        clientCertificateRevocationList,
        now(),
        configFailure,
      );
      http = await (options.startHttp ?? startClusterAutomationManagementHttp)({
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
