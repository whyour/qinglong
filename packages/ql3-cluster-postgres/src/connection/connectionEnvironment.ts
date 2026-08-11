import type { PostgresConnectionOptions } from './pool';

export type PostgresConnectionEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface PostgresConnectionEnvironmentKeys {
  readonly connectionString: string;
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

export class PostgresConnectionEnvironmentError extends TypeError {
  readonly code = 'QL3_POSTGRES_CONNECTION_ENVIRONMENT_INVALID';

  constructor(message: string) {
    super(`PostgreSQL connection environment is invalid: ${message}`);
    this.name = 'PostgresConnectionEnvironmentError';
  }
}

function present(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

function bounded(
  environment: PostgresConnectionEnvironment,
  name: string,
  maximumLength: number,
): string | undefined {
  const value = environment[name];
  if (!present(value)) return undefined;
  if (value!.length > maximumLength || /[\0\r\n]/.test(value!)) {
    throw new PostgresConnectionEnvironmentError(`${name} is invalid`);
  }
  return value;
}

function assertConnectionString(value: string, name: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PostgresConnectionEnvironmentError(`${name} must be a valid URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new PostgresConnectionEnvironmentError(
      `${name} must use postgres or postgresql`,
    );
  }
  for (const parameter of url.searchParams.keys()) {
    if (parameter.toLowerCase().startsWith('ssl')) {
      throw new PostgresConnectionEnvironmentError(
        'PostgreSQL TLS query parameters are forbidden',
      );
    }
  }
}

function port(value: string | undefined, name: string): number {
  if (value === undefined) return 5432;
  if (!/^\d+$/.test(value)) {
    throw new PostgresConnectionEnvironmentError(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new PostgresConnectionEnvironmentError(
      `${name} must be between 1 and 65535`,
    );
  }
  return parsed;
}

function identifier(value: string | undefined, name: string): string {
  if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(value)) {
    throw new PostgresConnectionEnvironmentError(
      `${name} must be a safe PostgreSQL identifier`,
    );
  }
  return value;
}

/**
 * Loads either one legacy connection URL or an exact discrete credential set.
 *
 * Discrete values avoid duplicating Kubernetes Secret passwords inside a DSN
 * and let an operator-managed DatabaseRole Secret remain the sole password
 * authority. The two forms are deliberately mutually exclusive.
 */
export function loadPostgresConnectionEnvironment(
  environment: PostgresConnectionEnvironment,
  keys: PostgresConnectionEnvironmentKeys,
): PostgresConnectionOptions {
  if (
    !environment ||
    typeof environment !== 'object' ||
    Array.isArray(environment)
  ) {
    throw new PostgresConnectionEnvironmentError(
      'environment must be an object',
    );
  }
  const connectionString = bounded(environment, keys.connectionString, 4096);
  const host = bounded(environment, keys.host, 253);
  const portValue = bounded(environment, keys.port, 5);
  const database = bounded(environment, keys.database, 63);
  const user = bounded(environment, keys.user, 63);
  const password = bounded(environment, keys.password, 1024);
  const discreteValues = [host, portValue, database, user, password];
  const hasDiscreteValue = discreteValues.some((value) => value !== undefined);

  if (connectionString !== undefined) {
    if (hasDiscreteValue) {
      throw new PostgresConnectionEnvironmentError(
        `${keys.connectionString} cannot be combined with discrete PostgreSQL connection keys`,
      );
    }
    assertConnectionString(connectionString, keys.connectionString);
    return Object.freeze({ connectionString });
  }

  if (
    host === undefined ||
    database === undefined ||
    user === undefined ||
    password === undefined
  ) {
    throw new PostgresConnectionEnvironmentError(
      `use ${keys.connectionString} or provide ${keys.host}, ${keys.database}, ${keys.user}, and ${keys.password}`,
    );
  }
  return Object.freeze({
    host,
    port: port(portValue, keys.port),
    database: identifier(database, keys.database),
    user: identifier(user, keys.user),
    password,
  });
}
