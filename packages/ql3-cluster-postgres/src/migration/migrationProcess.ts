import type {
  OpenPostgresDatabase,
  PostgresDatabaseResource,
  PostgresPool,
} from '@qinglong/runtime-core';
import {
  createPostgresDatabaseOpener,
  isPostgresTlsDnsServername,
  type PostgresConnectionOptions,
  type PostgresPoolOptions,
} from '../connection/pool';
import { loadPostgresConnectionEnvironment } from '../connection/connectionEnvironment';
import { loadPostgresCertificateAuthorityFile } from '../connection/certificateAuthority';
import { runPostgresMigrations } from './migrate';

export type PostgresMigrationProcessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface PostgresMigrationProcessConfig {
  readonly connection: PostgresConnectionOptions;
  readonly pool: PostgresPoolOptions;
}

export interface PostgresMigrationProcessEvent {
  readonly schemaVersion: 1;
  readonly component: 'qinglong3-cluster-migration';
  readonly event: 'migration_started' | 'migration_completed';
}

export interface RunPostgresMigrationProcessOptions {
  readonly environment: PostgresMigrationProcessEnvironment;
  readonly openDatabase?: OpenPostgresDatabase;
  readonly migrate?: (options: {
    readonly pool: PostgresPool;
  }) => Promise<void>;
  readonly emit?: (
    event: PostgresMigrationProcessEvent,
  ) => void | Promise<void>;
}

export class PostgresMigrationProcessConfigError extends TypeError {
  readonly code = 'QL3_POSTGRES_MIGRATION_PROCESS_CONFIG_INVALID';

  constructor(message: string) {
    super(`PostgreSQL migration process configuration is invalid: ${message}`);
    this.name = 'PostgresMigrationProcessConfigError';
  }
}

function boundedValue(
  environment: PostgresMigrationProcessEnvironment,
  name: string,
  maximumLength: number,
  required = false,
): string | undefined {
  const value = environment[name];
  if (value === undefined || value === '') {
    if (required) {
      throw new PostgresMigrationProcessConfigError(`${name} is required`);
    }
    return undefined;
  }
  if (value.length > maximumLength || /[\0\r\n]/.test(value)) {
    throw new PostgresMigrationProcessConfigError(`${name} is invalid`);
  }
  return value;
}

function booleanValue(
  environment: PostgresMigrationProcessEnvironment,
  name: string,
): boolean {
  const value = environment[name];
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new PostgresMigrationProcessConfigError(
    `${name} must be true or false`,
  );
}

/** Parses a migration-only PostgreSQL connection without reading runtime keys. */
export function loadPostgresMigrationProcessConfig(
  environment: PostgresMigrationProcessEnvironment,
): PostgresMigrationProcessConfig {
  if (
    !environment ||
    typeof environment !== 'object' ||
    Array.isArray(environment)
  ) {
    throw new PostgresMigrationProcessConfigError(
      'environment must be an object',
    );
  }
  let connection: PostgresConnectionOptions;
  try {
    connection = loadPostgresConnectionEnvironment(environment, {
      connectionString: 'QL3_POSTGRES_MIGRATION_URL',
      host: 'QL3_POSTGRES_MIGRATION_HOST',
      port: 'QL3_POSTGRES_MIGRATION_PORT',
      database: 'QL3_POSTGRES_MIGRATION_DATABASE',
      user: 'QL3_POSTGRES_MIGRATION_USER',
      password: 'QL3_POSTGRES_MIGRATION_PASSWORD',
    });
  } catch (error) {
    throw new PostgresMigrationProcessConfigError(
      error instanceof Error
        ? error.message
        : 'PostgreSQL migration connection is invalid',
    );
  }

  const mode = environment.QL3_POSTGRES_TLS_MODE ?? 'verify-full';
  if (mode !== 'verify-full' && mode !== 'disable') {
    throw new PostgresMigrationProcessConfigError(
      'QL3_POSTGRES_TLS_MODE must be verify-full or disable',
    );
  }
  if (
    mode === 'disable' &&
    !booleanValue(environment, 'QL3_POSTGRES_ALLOW_INSECURE')
  ) {
    throw new PostgresMigrationProcessConfigError(
      'disabling PostgreSQL TLS requires QL3_POSTGRES_ALLOW_INSECURE=true',
    );
  }
  const servername = boundedValue(
    environment,
    'QL3_POSTGRES_TLS_SERVERNAME',
    253,
  );
  if (mode === 'verify-full' && !isPostgresTlsDnsServername(servername)) {
    throw new PostgresMigrationProcessConfigError(
      'QL3_POSTGRES_TLS_SERVERNAME must be an explicit DNS name for verify-full',
    );
  }
  const certificateAuthorityFile = boundedValue(
    environment,
    'QL3_POSTGRES_TLS_CA_FILE',
    4096,
  );
  if (mode === 'disable' && certificateAuthorityFile !== undefined) {
    throw new PostgresMigrationProcessConfigError(
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
      throw new PostgresMigrationProcessConfigError(
        'QL3_POSTGRES_TLS_CA_FILE must contain a bounded trusted CA bundle',
      );
    }
  }
  const applicationName =
    boundedValue(environment, 'QL3_POSTGRES_APPLICATION_NAME', 63) ??
    'qinglong3-cluster-migration';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/.test(applicationName)) {
    throw new PostgresMigrationProcessConfigError(
      'QL3_POSTGRES_APPLICATION_NAME is invalid',
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
              ...(certificateAuthority === undefined
                ? {}
                : { ca: certificateAuthority }),
              servername: servername!,
            }),
    }),
    pool: Object.freeze({
      applicationName,
      maxConnections: 1,
      connectionTimeoutMs: 15_000,
    }),
  });
}

function processEvent(
  event: PostgresMigrationProcessEvent['event'],
): PostgresMigrationProcessEvent {
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-cluster-migration',
    event,
  });
}

async function emit(
  sink: RunPostgresMigrationProcessOptions['emit'],
  value: PostgresMigrationProcessEvent,
): Promise<void> {
  if (!sink) return;
  try {
    await sink(value);
  } catch {
    // Diagnostics cannot replace migration or close outcomes.
  }
}

/** Opens exactly one migration-role Pool, runs the reviewed stream and closes. */
export async function runPostgresMigrationProcess(
  options: RunPostgresMigrationProcessOptions,
): Promise<'migrated'> {
  if (!options || typeof options !== 'object') {
    throw new TypeError('PostgreSQL migration process options are invalid');
  }
  const config = loadPostgresMigrationProcessConfig(options.environment);
  const openDatabase =
    options.openDatabase ??
    createPostgresDatabaseOpener({
      role: 'migration',
      connection: config.connection,
      pool: config.pool,
      onPoolError() {
        // Awaited migration statements remain authoritative. An idle Pool
        // error will be observed by the migration or final close.
      },
    });
  const migrate = options.migrate ?? runPostgresMigrations;
  if (
    typeof openDatabase !== 'function' ||
    typeof migrate !== 'function' ||
    (options.emit !== undefined && typeof options.emit !== 'function')
  ) {
    throw new TypeError('PostgreSQL migration process adapters are invalid');
  }

  let database: PostgresDatabaseResource | undefined;
  let primaryError: unknown;
  try {
    database = await openDatabase();
    await emit(options.emit, processEvent('migration_started'));
    await migrate({ pool: database.pool });
    await emit(options.emit, processEvent('migration_completed'));
  } catch (error) {
    primaryError = error;
  }
  if (database) {
    try {
      await database.close();
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError) throw primaryError;
  return 'migrated';
}
