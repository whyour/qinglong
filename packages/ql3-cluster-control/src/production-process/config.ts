import type {
  DeploymentProfile,
  OpenPostgresDatabase,
} from '@qinglong/runtime-core';
import {
  createPostgresDatabaseOpener,
  isPostgresTlsDnsServername,
  loadPostgresConnectionEnvironment,
  loadPostgresCertificateAuthorityFile,
  type PostgresConnectionOptions,
  type PostgresPoolOptions,
} from '@qinglong/cluster-postgres/runtime';
import { ClusterControlAvailabilityFence } from '../database/availability';
import type { ClusterControlHttpSurfaceOptions } from '../transport/httpSurface';

export type ClusterControlEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface DisabledClusterControlConfig {
  readonly enabled: false;
  readonly profile: DeploymentProfile;
}

export interface EnabledClusterControlConfig {
  readonly enabled: true;
  readonly profile: 'cluster-control';
  readonly http: ClusterControlHttpSurfaceOptions;
  readonly database: Readonly<{
    connection: PostgresConnectionOptions;
    pool: PostgresPoolOptions;
  }>;
  readonly security: Readonly<{
    apiCredentialPepper: string;
  }>;
}

export type ClusterControlConfig =
  | DisabledClusterControlConfig
  | EnabledClusterControlConfig;

export interface ClusterControlDatabaseBinding {
  readonly availability: ClusterControlAvailabilityFence;
  readonly openDatabase: OpenPostgresDatabase;
}

export class ClusterControlConfigError extends TypeError {
  constructor(message: string) {
    super(`Cluster-control configuration is invalid: ${message}`);
    this.name = 'ClusterControlConfigError';
  }
}

const PROFILES = new Set<DeploymentProfile>([
  'edge',
  'standalone',
  'cluster-control',
  'worker',
]);

function booleanValue(
  environment: ClusterControlEnvironment,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = environment[name];
  if (value === undefined || value === '') return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ClusterControlConfigError(`${name} must be true or false`);
}

function integerValue(
  environment: ClusterControlEnvironment,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = environment[name];
  if (value === undefined || value === '') return defaultValue;
  if (!/^\d+$/.test(value)) {
    throw new ClusterControlConfigError(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ClusterControlConfigError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function boundedValue(
  environment: ClusterControlEnvironment,
  name: string,
  maximumLength: number,
  required = false,
): string | undefined {
  const value = environment[name];
  if (value === undefined || value === '') {
    if (required) throw new ClusterControlConfigError(`${name} is required`);
    return undefined;
  }
  if (value.length > maximumLength || /[\0\r\n]/.test(value)) {
    throw new ClusterControlConfigError(`${name} is invalid`);
  }
  return value;
}

function deploymentProfile(
  environment: ClusterControlEnvironment,
): DeploymentProfile {
  const value = environment.QL_DEPLOYMENT_PROFILE ?? 'standalone';
  if (!PROFILES.has(value as DeploymentProfile)) {
    throw new ClusterControlConfigError('QL_DEPLOYMENT_PROFILE is invalid');
  }
  return value as DeploymentProfile;
}

function runtimeConnection(
  environment: ClusterControlEnvironment,
): PostgresConnectionOptions {
  let connection: PostgresConnectionOptions;
  try {
    connection = loadPostgresConnectionEnvironment(environment, {
      connectionString: 'QL3_POSTGRES_RUNTIME_URL',
      host: 'QL3_POSTGRES_RUNTIME_HOST',
      port: 'QL3_POSTGRES_RUNTIME_PORT',
      database: 'QL3_POSTGRES_RUNTIME_DATABASE',
      user: 'QL3_POSTGRES_RUNTIME_USER',
      password: 'QL3_POSTGRES_RUNTIME_PASSWORD',
    });
  } catch (error) {
    throw new ClusterControlConfigError(
      error instanceof Error
        ? error.message
        : 'PostgreSQL runtime connection is invalid',
    );
  }

  const mode = environment.QL3_POSTGRES_TLS_MODE ?? 'verify-full';
  if (mode !== 'verify-full' && mode !== 'disable') {
    throw new ClusterControlConfigError(
      'QL3_POSTGRES_TLS_MODE must be verify-full or disable',
    );
  }
  if (
    mode === 'disable' &&
    !booleanValue(environment, 'QL3_POSTGRES_ALLOW_INSECURE', false)
  ) {
    throw new ClusterControlConfigError(
      'disabling PostgreSQL TLS requires QL3_POSTGRES_ALLOW_INSECURE=true',
    );
  }
  const servername = boundedValue(
    environment,
    'QL3_POSTGRES_TLS_SERVERNAME',
    253,
  );
  if (mode === 'verify-full' && !isPostgresTlsDnsServername(servername)) {
    throw new ClusterControlConfigError(
      'QL3_POSTGRES_TLS_SERVERNAME must be an explicit DNS name for verify-full',
    );
  }
  const certificateAuthorityFile = boundedValue(
    environment,
    'QL3_POSTGRES_TLS_CA_FILE',
    4096,
  );
  if (mode === 'disable' && certificateAuthorityFile !== undefined) {
    throw new ClusterControlConfigError(
      'QL3_POSTGRES_TLS_CA_FILE cannot be used when TLS is disabled',
    );
  }
  let certificateAuthority: string | undefined;
  if (certificateAuthorityFile !== undefined) {
    try {
      certificateAuthority = loadPostgresCertificateAuthorityFile(
        certificateAuthorityFile,
      );
    } catch {
      throw new ClusterControlConfigError(
        'QL3_POSTGRES_TLS_CA_FILE must contain a bounded trusted CA bundle',
      );
    }
  }
  return Object.freeze({
    ...connection,
    tls:
      mode === 'disable'
        ? Object.freeze({ mode: 'disable' as const })
        : Object.freeze({
            mode: 'verify-full' as const,
            ...(certificateAuthority === undefined
              ? {}
              : { ca: certificateAuthority }),
            servername: servername!,
          }),
  });
}

function apiCredentialPepper(environment: ClusterControlEnvironment): string {
  const value = boundedValue(
    environment,
    'QL3_API_CREDENTIAL_PEPPER',
    64,
    true,
  )!;
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new ClusterControlConfigError(
      'QL3_API_CREDENTIAL_PEPPER must be canonical base64url for 32 bytes',
    );
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) {
    throw new ClusterControlConfigError(
      'QL3_API_CREDENTIAL_PEPPER must be canonical base64url for 32 bytes',
    );
  }
  decoded.fill(0);
  return value;
}

/**
 * Parses the profile gate before reading PostgreSQL configuration. A disabled
 * cluster-control therefore does not touch its runtime credential source.
 */
export function loadClusterControlConfig(
  environment: ClusterControlEnvironment,
): ClusterControlConfig {
  if (
    !environment ||
    typeof environment !== 'object' ||
    Array.isArray(environment)
  ) {
    throw new ClusterControlConfigError('environment must be an object');
  }
  const profile = deploymentProfile(environment);
  const enabled = booleanValue(
    environment,
    'QL3_CLUSTER_CONTROL_ENABLED',
    false,
  );
  if (!enabled) return Object.freeze({ enabled: false, profile });
  if (profile !== 'cluster-control') {
    throw new ClusterControlConfigError(
      'enabled runtime requires QL_DEPLOYMENT_PROFILE=cluster-control',
    );
  }

  const applicationName =
    boundedValue(environment, 'QL3_POSTGRES_APPLICATION_NAME', 63) ??
    'qinglong-cluster-runtime';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/.test(applicationName)) {
    throw new ClusterControlConfigError(
      'QL3_POSTGRES_APPLICATION_NAME is invalid',
    );
  }
  const host =
    boundedValue(environment, 'QL3_CLUSTER_HTTP_HOST', 253) ?? '0.0.0.0';
  const config: EnabledClusterControlConfig = {
    enabled: true,
    profile: 'cluster-control',
    http: Object.freeze({
      host,
      port: integerValue(environment, 'QL3_CLUSTER_HTTP_PORT', 5800, 1, 65_535),
      maxBodyBytes: integerValue(
        environment,
        'QL3_CLUSTER_HTTP_MAX_BODY_BYTES',
        1024 * 1024,
        1024,
        4 * 1024 * 1024,
      ),
      maxInFlightRequests: integerValue(
        environment,
        'QL3_CLUSTER_HTTP_MAX_IN_FLIGHT',
        64,
        1,
        1024,
      ),
      authenticationRateWindowMs: integerValue(
        environment,
        'QL3_CLUSTER_AUTH_RATE_WINDOW_MS',
        60_000,
        1_000,
        60 * 60_000,
      ),
      authenticationRatePerPeer: integerValue(
        environment,
        'QL3_CLUSTER_AUTH_RATE_PER_PEER',
        300,
        1,
        1_000_000,
      ),
      authenticationRateGlobal: integerValue(
        environment,
        'QL3_CLUSTER_AUTH_RATE_GLOBAL',
        1_200,
        1,
        1_000_000,
      ),
      authenticationRateMaxPeers: integerValue(
        environment,
        'QL3_CLUSTER_AUTH_RATE_MAX_PEERS',
        4_096,
        1,
        65_536,
      ),
      requestTimeoutMs: integerValue(
        environment,
        'QL3_CLUSTER_HTTP_REQUEST_TIMEOUT_MS',
        15_000,
        100,
        120_000,
      ),
      drainTimeoutMs: integerValue(
        environment,
        'QL3_CLUSTER_HTTP_DRAIN_TIMEOUT_MS',
        10_000,
        100,
        120_000,
      ),
    }),
    database: Object.freeze({
      connection: runtimeConnection(environment),
      pool: Object.freeze({
        applicationName,
        maxConnections: integerValue(
          environment,
          'QL3_POSTGRES_MAX_CONNECTIONS',
          8,
          1,
          64,
        ),
        connectionTimeoutMs: integerValue(
          environment,
          'QL3_POSTGRES_CONNECTION_TIMEOUT_MS',
          5_000,
          100,
          60_000,
        ),
      }),
    }),
    security: Object.freeze({
      apiCredentialPepper: apiCredentialPepper(environment),
    }),
  };
  return Object.freeze(config);
}

export function createClusterControlDatabaseBinding(
  config: EnabledClusterControlConfig,
): ClusterControlDatabaseBinding {
  if (!config?.enabled || config.profile !== 'cluster-control') {
    throw new ClusterControlConfigError(
      'database binding requires an enabled cluster-control config',
    );
  }
  const availability = new ClusterControlAvailabilityFence();
  const openDatabase = createPostgresDatabaseOpener({
    role: 'runtime',
    connection: config.database.connection,
    pool: config.database.pool,
    onPoolError(error) {
      // pg emits idle-client errors outside a request Promise. They are an
      // availability signal, never a callback exception or transaction retry.
      void availability.signal(error).catch(() => undefined);
    },
  });
  return Object.freeze({ availability, openDatabase });
}
