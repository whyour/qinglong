import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from 'pg';
import { isIP } from 'node:net';
import type {
  PostgresClient,
  PostgresDatabaseResource,
  PostgresPool,
  PostgresQueryResult,
} from '@qinglong/runtime-core';

const DEFAULT_RUNTIME_APPLICATION_NAME = 'qinglong-cluster-runtime';
const DEFAULT_ADMIN_APPLICATION_NAME = 'qinglong-cluster-admin';
const DEFAULT_AI_CREDENTIAL_TESTER_APPLICATION_NAME =
  'qinglong-ai-credential-tester';
const DEFAULT_AUTOMATION_MANAGER_APPLICATION_NAME =
  'qinglong-automation-manager';
const DEFAULT_APPROVAL_MANAGER_APPLICATION_NAME = 'qinglong-approval-manager';
const DEFAULT_PACKAGE_MANAGER_APPLICATION_NAME = 'qinglong-package-manager';
const DEFAULT_PACKAGE_EXECUTOR_APPLICATION_NAME = 'qinglong-package-executor';
const DEFAULT_WORKER_CREDENTIAL_MANAGER_APPLICATION_NAME =
  'qinglong-worker-credential-manager';
const DEFAULT_WORKER_CREDENTIAL_EXECUTOR_APPLICATION_NAME =
  'qinglong-worker-credential-executor';
const DEFAULT_WORKER_INGRESS_APPLICATION_NAME = 'qinglong-worker-ingress';
const DEFAULT_MIGRATION_APPLICATION_NAME = 'qinglong-cluster-migration';
const DEFAULT_RUNTIME_POOL_SIZE = 8;
const DEFAULT_ADMIN_POOL_SIZE = 2;
const DEFAULT_WORKER_INGRESS_POOL_SIZE = 4;
const DEFAULT_MIGRATION_POOL_SIZE = 1;
const MAX_RUNTIME_POOL_SIZE = 64;
const MAX_ADMIN_POOL_SIZE = 4;
const MAX_WORKER_INGRESS_POOL_SIZE = 16;
const MAX_MIGRATION_POOL_SIZE = 4;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LIFETIME_SECONDS = 300;
const DEFAULT_RUNTIME_STATEMENT_TIMEOUT_MS = 5_000;
const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_RUNTIME_LOCK_TIMEOUT_MS = 1_000;
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_RUNTIME_IDLE_TRANSACTION_TIMEOUT_MS = 10_000;
const DEFAULT_MIGRATION_IDLE_TRANSACTION_TIMEOUT_MS = 15_000;
const FIXED_SEARCH_PATH = '-c search_path=ql3,pg_catalog';

export const POSTGRES_AVAILABILITY_SQLSTATE_CLASSES = Object.freeze([
  '08',
] as const);

export const POSTGRES_AVAILABILITY_SQLSTATES = Object.freeze([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '25006',
  '57P01',
  '57P02',
  '57P03',
  '57P04',
] as const);

export const POSTGRES_AVAILABILITY_SYSTEM_ERROR_CODES = Object.freeze([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
] as const);

const POSTGRES_AVAILABILITY_CODES = new Set<string>([
  ...POSTGRES_AVAILABILITY_SQLSTATES,
  ...POSTGRES_AVAILABILITY_SYSTEM_ERROR_CODES,
]);

export type PostgresDatabaseRole =
  | 'runtime'
  | 'ai-maintenance'
  | 'ai-credential-manager'
  | 'ai-credential-tester'
  | 'admin'
  | 'automation-manager'
  | 'approval-manager'
  | 'package-manager'
  | 'package-executor'
  | 'worker-credential-manager'
  | 'worker-credential-executor'
  | 'worker-ingress'
  | 'migration';

export type PostgresTlsOptions =
  | Readonly<{
      mode: 'verify-full';
      ca?: string;
      servername: string;
    }>
  | Readonly<{
      mode: 'disable';
    }>;

export interface PostgresConnectionOptions {
  readonly connectionString?: string;
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly user?: string;
  readonly password?: string | (() => string | Promise<string>);
  readonly tls?: PostgresTlsOptions;
}

export interface PostgresPoolOptions {
  readonly applicationName?: string;
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxLifetimeSeconds?: number;
  readonly keepAliveInitialDelayMs?: number;
}

export interface OpenPostgresDatabaseOptions {
  readonly role: PostgresDatabaseRole;
  readonly connection: PostgresConnectionOptions;
  readonly pool?: PostgresPoolOptions;
  readonly onPoolError: (error: Error) => void;
}

export function isPostgresTlsDnsServername(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 253 ||
    isIP(value) !== 0
  ) {
    return false;
  }
  const labels = value.split('.');
  return (
    labels.length >= 2 &&
    labels.every((label) =>
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
    )
  );
}

export type QingLongPostgresQueryResult<
  TRow extends Record<string, unknown> = Record<string, unknown>,
> = PostgresQueryResult<TRow>;

export type QingLongPostgresClient = PostgresClient;

export type QingLongPostgresPool = PostgresPool;

export type QingLongPostgresDatabaseResource = PostgresDatabaseResource;

export function isPostgresAvailabilityError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { readonly code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return (
    POSTGRES_AVAILABILITY_CODES.has(code) ||
    (code.length === 5 &&
      POSTGRES_AVAILABILITY_SQLSTATE_CLASSES.some((prefix) =>
        code.startsWith(prefix),
      ))
  );
}

function reportPostgresAvailabilityError(
  error: unknown,
  listener: (error: Error) => void,
  force = false,
): void {
  if (!(error instanceof Error)) return;
  if (!force && !isPostgresAvailabilityError(error)) return;
  try {
    listener(error);
  } catch {
    // Availability reporting must never replace the original query/Pool error.
  }
}

function requireIntegerInRange(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function validateApplicationName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/.test(value)) {
    throw new TypeError(
      'PostgreSQL applicationName must contain 1-63 safe identifier characters',
    );
  }
  return value;
}

function assertNoConnectionStringTlsOverrides(connectionString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new TypeError('PostgreSQL connectionString must be a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new TypeError(
      'PostgreSQL connectionString must use postgres or postgresql',
    );
  }
  for (const key of parsed.searchParams.keys()) {
    if (key.toLowerCase().startsWith('ssl')) {
      throw new TypeError(
        'PostgreSQL TLS settings must use the explicit tls option',
      );
    }
  }
}

function tlsConfig(tls: PostgresTlsOptions | undefined): PoolConfig['ssl'] {
  if (tls?.mode === 'disable') return false;
  if (tls !== undefined && !isPostgresTlsDnsServername(tls.servername)) {
    throw new TypeError(
      'PostgreSQL verify-full TLS requires an explicit DNS servername',
    );
  }
  return {
    rejectUnauthorized: true,
    ...(tls?.ca === undefined ? {} : { ca: tls.ca }),
    ...(tls === undefined ? {} : { servername: tls.servername }),
  };
}

function buildPoolConfig(options: OpenPostgresDatabaseOptions): PoolConfig {
  if (
    ![
      'runtime',
      'ai-maintenance',
      'ai-credential-manager',
      'ai-credential-tester',
      'admin',
      'automation-manager',
      'approval-manager',
      'package-manager',
      'package-executor',
      'worker-credential-manager',
      'worker-credential-executor',
      'worker-ingress',
      'migration',
    ].includes(options.role)
  ) {
    throw new TypeError('PostgreSQL database role is invalid');
  }
  const connection = options.connection;
  const hasConnectionString = connection.connectionString !== undefined;
  const hasDiscreteAddress =
    connection.host !== undefined ||
    connection.port !== undefined ||
    connection.database !== undefined ||
    connection.user !== undefined;
  if (hasConnectionString && hasDiscreteAddress) {
    throw new TypeError(
      'PostgreSQL connectionString cannot be combined with host, port, database, or user',
    );
  }
  if (hasConnectionString) {
    assertNoConnectionStringTlsOverrides(connection.connectionString!);
  } else if (
    connection.host === undefined ||
    connection.database === undefined ||
    connection.user === undefined
  ) {
    throw new TypeError(
      'PostgreSQL connection requires connectionString or host, database, and user',
    );
  }

  const isRuntime = options.role === 'runtime';
  const isAiMaintenance = options.role === 'ai-maintenance';
  const isAiCredentialManager = options.role === 'ai-credential-manager';
  const isAiCredentialTester = options.role === 'ai-credential-tester';
  const isAdmin = options.role === 'admin';
  const isAutomationManager = options.role === 'automation-manager';
  const isApprovalManager = options.role === 'approval-manager';
  const isPackageManager = options.role === 'package-manager';
  const isPackageExecutor = options.role === 'package-executor';
  const isWorkerCredentialManager =
    options.role === 'worker-credential-manager';
  const isWorkerCredentialExecutor =
    options.role === 'worker-credential-executor';
  const isShortLivedAuthority =
    isAiMaintenance ||
    isAiCredentialManager ||
    isAiCredentialTester ||
    isAdmin ||
    isAutomationManager ||
    isApprovalManager ||
    isPackageManager ||
    isPackageExecutor ||
    isWorkerCredentialManager ||
    isWorkerCredentialExecutor;
  const isWorkerIngress = options.role === 'worker-ingress';
  const maximumPoolSize = isRuntime
    ? MAX_RUNTIME_POOL_SIZE
    : isShortLivedAuthority
    ? MAX_ADMIN_POOL_SIZE
    : isWorkerIngress
    ? MAX_WORKER_INGRESS_POOL_SIZE
    : MAX_MIGRATION_POOL_SIZE;
  const maxConnections = requireIntegerInRange(
    'PostgreSQL maxConnections',
    options.pool?.maxConnections ??
      (isRuntime
        ? DEFAULT_RUNTIME_POOL_SIZE
        : isShortLivedAuthority
        ? DEFAULT_ADMIN_POOL_SIZE
        : isWorkerIngress
        ? DEFAULT_WORKER_INGRESS_POOL_SIZE
        : DEFAULT_MIGRATION_POOL_SIZE),
    1,
    maximumPoolSize,
  );
  const connectionTimeoutMs = requireIntegerInRange(
    'PostgreSQL connectionTimeoutMs',
    options.pool?.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    100,
    60_000,
  );
  const idleTimeoutMs = requireIntegerInRange(
    'PostgreSQL idleTimeoutMs',
    options.pool?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    1_000,
    300_000,
  );
  const maxLifetimeSeconds = requireIntegerInRange(
    'PostgreSQL maxLifetimeSeconds',
    options.pool?.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS,
    30,
    3_600,
  );
  const keepAliveInitialDelayMs = requireIntegerInRange(
    'PostgreSQL keepAliveInitialDelayMs',
    options.pool?.keepAliveInitialDelayMs ?? 1_000,
    0,
    60_000,
  );
  const applicationName = validateApplicationName(
    options.pool?.applicationName ??
      (isRuntime
        ? DEFAULT_RUNTIME_APPLICATION_NAME
        : isAdmin
        ? DEFAULT_ADMIN_APPLICATION_NAME
        : isAiCredentialTester
        ? DEFAULT_AI_CREDENTIAL_TESTER_APPLICATION_NAME
      : isAutomationManager
      ? DEFAULT_AUTOMATION_MANAGER_APPLICATION_NAME
      : isApprovalManager
      ? DEFAULT_APPROVAL_MANAGER_APPLICATION_NAME
        : isPackageManager
        ? DEFAULT_PACKAGE_MANAGER_APPLICATION_NAME
        : isPackageExecutor
        ? DEFAULT_PACKAGE_EXECUTOR_APPLICATION_NAME
        : isWorkerCredentialManager
        ? DEFAULT_WORKER_CREDENTIAL_MANAGER_APPLICATION_NAME
        : isWorkerCredentialExecutor
        ? DEFAULT_WORKER_CREDENTIAL_EXECUTOR_APPLICATION_NAME
        : isWorkerIngress
        ? DEFAULT_WORKER_INGRESS_APPLICATION_NAME
        : DEFAULT_MIGRATION_APPLICATION_NAME),
  );

  return {
    ...(connection.connectionString === undefined
      ? {
          host: connection.host,
          ...(connection.port === undefined
            ? {}
            : {
                port: requireIntegerInRange(
                  'PostgreSQL port',
                  connection.port,
                  1,
                  65_535,
                ),
              }),
          database: connection.database,
          user: connection.user,
        }
      : { connectionString: connection.connectionString }),
    ...(connection.password === undefined
      ? {}
      : { password: connection.password }),
    ssl: tlsConfig(connection.tls),
    application_name: applicationName,
    options: FIXED_SEARCH_PATH,
    max: maxConnections,
    min: 0,
    connectionTimeoutMillis: connectionTimeoutMs,
    idleTimeoutMillis: idleTimeoutMs,
    maxLifetimeSeconds,
    keepAlive: true,
    keepAliveInitialDelayMillis: keepAliveInitialDelayMs,
    allowExitOnIdle: false,
    statement_timeout:
      isRuntime || isWorkerIngress
        ? DEFAULT_RUNTIME_STATEMENT_TIMEOUT_MS
        : DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
    query_timeout:
      isRuntime || isWorkerIngress
        ? DEFAULT_RUNTIME_STATEMENT_TIMEOUT_MS + 1_000
        : DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS + 1_000,
    lock_timeout:
      isRuntime || isWorkerIngress
        ? DEFAULT_RUNTIME_LOCK_TIMEOUT_MS
        : DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout:
      isRuntime || isWorkerIngress
        ? DEFAULT_RUNTIME_IDLE_TRANSACTION_TIMEOUT_MS
        : DEFAULT_MIGRATION_IDLE_TRANSACTION_TIMEOUT_MS,
  };
}

async function query<TRow extends Record<string, unknown>>(
  queryable: Pick<Pool | PoolClient, 'query'>,
  text: string,
  values?: readonly unknown[],
  onAvailabilityError: (error: Error) => void = () => {},
): Promise<PostgresQueryResult<TRow>> {
  try {
    const result = await queryable.query<TRow & QueryResultRow>(
      text,
      values === undefined ? undefined : [...values],
    );
    return { rows: result.rows, rowCount: result.rowCount };
  } catch (error) {
    reportPostgresAvailabilityError(error, onAvailabilityError);
    throw error;
  }
}

class PgClientBinding implements PostgresClient {
  private readonly onClientError: (error: Error) => void;

  constructor(
    private readonly client: PoolClient,
    private readonly onAvailabilityError: (error: Error) => void,
  ) {
    this.onClientError = (error) =>
      reportPostgresAvailabilityError(error, this.onAvailabilityError, true);
    this.client.on('error', this.onClientError);
  }

  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<TRow>> {
    return query<TRow>(this.client, text, values, this.onAvailabilityError);
  }

  release(): void {
    this.client.removeListener('error', this.onClientError);
    this.client.release();
  }
}

export class PgPoolBinding implements PostgresPool {
  constructor(
    private readonly driverPool: Pool,
    private readonly onAvailabilityError: (error: Error) => void = () => {},
  ) {}

  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<TRow>> {
    return query<TRow>(this.driverPool, text, values, this.onAvailabilityError);
  }

  async connect(): Promise<PostgresClient> {
    try {
      return new PgClientBinding(
        await this.driverPool.connect(),
        this.onAvailabilityError,
      );
    } catch (error) {
      reportPostgresAvailabilityError(error, this.onAvailabilityError);
      throw error;
    }
  }
}

class PgDatabaseResource implements PostgresDatabaseResource {
  readonly pool: PostgresPool;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly driverPool: Pool,
    onAvailabilityError: (error: Error) => void,
  ) {
    this.pool = new PgPoolBinding(driverPool, onAvailabilityError);
  }

  close(): Promise<void> {
    this.closePromise ??= this.driverPool.end();
    return this.closePromise;
  }
}

/**
 * Builds a lazy database opener for the core cluster bootstrap. Constructing
 * the opener, and invoking it, do not acquire a PostgreSQL connection; the
 * first readiness or repository query triggers pg.Pool connection creation.
 */
export function createPostgresDatabaseOpener(
  options: OpenPostgresDatabaseOptions,
): () => Promise<PostgresDatabaseResource> {
  const config = buildPoolConfig(options);
  return async () => {
    const driverPool = new Pool(config);
    driverPool.on('connect', (client) => {
      // Keep one listener for the physical connection lifetime. pg swaps its
      // own idle listener while a client is checked out, and a failover can
      // otherwise emit a second socket error after a checkout binding has
      // released but before Pool teardown has completed.
      client.on('error', (error) =>
        reportPostgresAvailabilityError(error, options.onPoolError, true),
      );
    });
    driverPool.on('error', (error) =>
      reportPostgresAvailabilityError(error, options.onPoolError, true),
    );
    return new PgDatabaseResource(driverPool, options.onPoolError);
  };
}
