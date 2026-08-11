import type { DatabaseSync } from 'node:sqlite';

export type SqliteQueryRow = Record<string, unknown>;

export type SqliteQueryValue = string | number | bigint | Uint8Array | null;

export interface SqlitePersistenceErrorContract {
  readonly invalidRowValue: (property: string) => Error;
  readonly invalidJson: (property: string) => Error;
  readonly unsupportedRowValue: (property: string) => Error;
  readonly duplicateIdentityRows: () => Error;
  readonly mapDriverError: (error: unknown) => Error;
}

export interface SqlitePersistencePrimitives {
  readonly requiredString: (row: SqliteQueryRow, property: string) => string;
  readonly optionalString: (
    row: SqliteQueryRow,
    property: string,
  ) => string | undefined;
  readonly requiredInteger: (row: SqliteQueryRow, property: string) => number;
  readonly requiredBlob: (row: SqliteQueryRow, property: string) => Buffer;
  readonly optionalInteger: (
    row: SqliteQueryRow,
    property: string,
  ) => number | undefined;
  readonly requiredBoolean: (row: SqliteQueryRow, property: string) => boolean;
  readonly requiredJson: (row: SqliteQueryRow, property: string) => unknown;
  readonly requiredEnum: <T extends string>(
    row: SqliteQueryRow,
    property: string,
    allowed: readonly T[],
  ) => T;
  readonly queryRows: (
    client: DatabaseSync,
    sql: string,
    values?: readonly SqliteQueryValue[],
  ) => SqliteQueryRow[];
  readonly singleRow: (rows: SqliteQueryRow[]) => SqliteQueryRow | null;
}

export function sqliteDriverErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
}

export function sqliteDriverErrorNumber(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { errcode?: unknown }).errcode;
  return typeof value === 'number' ? value : undefined;
}

export function sqliteDriverErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

export function isSqliteDriverError(error: unknown): boolean {
  return (
    sqliteDriverErrorNumber(error) !== undefined ||
    sqliteDriverErrorCode(error)?.startsWith('ERR_SQLITE_') === true
  );
}

export function createSqlitePersistencePrimitives(
  errors: SqlitePersistenceErrorContract,
): SqlitePersistencePrimitives {
  function requiredString(row: SqliteQueryRow, property: string): string {
    const value = row[property];
    if (typeof value !== 'string' || value.length === 0) {
      throw errors.invalidRowValue(property);
    }
    return value;
  }

  function optionalString(
    row: SqliteQueryRow,
    property: string,
  ): string | undefined {
    const value = row[property];
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'string') {
      throw errors.invalidRowValue(property);
    }
    return value;
  }

  function requiredInteger(row: SqliteQueryRow, property: string): number {
    const value = row[property];
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    throw errors.invalidRowValue(property);
  }

  function requiredBlob(row: SqliteQueryRow, property: string): Buffer {
    const value = row[property];
    if (!(value instanceof Uint8Array)) {
      throw errors.invalidRowValue(property);
    }
    return Buffer.from(value);
  }

  function optionalInteger(
    row: SqliteQueryRow,
    property: string,
  ): number | undefined {
    if (row[property] === null || row[property] === undefined) return undefined;
    return requiredInteger(row, property);
  }

  function requiredBoolean(row: SqliteQueryRow, property: string): boolean {
    const value = row[property];
    if (value === 0) return false;
    if (value === 1) return true;
    throw errors.invalidRowValue(property);
  }

  function requiredJson(row: SqliteQueryRow, property: string): unknown {
    const value = requiredString(row, property);
    try {
      return JSON.parse(value);
    } catch {
      throw errors.invalidJson(property);
    }
  }

  function requiredEnum<T extends string>(
    row: SqliteQueryRow,
    property: string,
    allowed: readonly T[],
  ): T {
    const value = requiredString(row, property);
    if (!allowed.includes(value as T)) {
      throw errors.unsupportedRowValue(property);
    }
    return value as T;
  }

  function queryRows(
    client: DatabaseSync,
    sql: string,
    values: readonly SqliteQueryValue[] = [],
  ): SqliteQueryRow[] {
    try {
      return client.prepare(sql).all(...values) as unknown as SqliteQueryRow[];
    } catch (error) {
      throw errors.mapDriverError(error);
    }
  }

  function singleRow(rows: SqliteQueryRow[]): SqliteQueryRow | null {
    const [row] = rows;
    if (!row) return null;
    if (rows.length !== 1) throw errors.duplicateIdentityRows();
    return row;
  }

  return Object.freeze({
    requiredString,
    optionalString,
    requiredInteger,
    requiredBlob,
    optionalInteger,
    requiredBoolean,
    requiredJson,
    requiredEnum,
    queryRows,
    singleRow,
  });
}
