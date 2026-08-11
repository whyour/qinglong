import type { PostgresClient } from '@qinglong/runtime-core';

export const POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS = 3;
export const POSTGRES_DEFINITION_RETRYABLE_SQL_STATES = new Set([
  '40001',
  '40P01',
  '55P03',
]);

export function postgresSqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function postgresRequiredString(
  value: unknown,
  unavailable: () => Error,
): string {
  if (typeof value !== 'string') throw unavailable();
  return value;
}

export function postgresRequiredInteger(
  value: unknown,
  unavailable: () => Error,
): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw unavailable();
}

export function postgresRequiredBoolean(
  value: unknown,
  unavailable: () => Error,
): boolean {
  if (typeof value !== 'boolean') throw unavailable();
  return value;
}

export function postgresRequiredJsonObject(
  value: unknown,
  unavailable: () => Error,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw unavailable();
  }
  return value as Readonly<Record<string, unknown>>;
}

export async function configurePostgresDefinitionTransaction(
  client: PostgresClient,
): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
    '5000ms',
  ]);
  await client.query(`SELECT set_config('lock_timeout', $1, true)`, ['1000ms']);
  await client.query(
    `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
    ['10000ms'],
  );
}

export async function rollbackPostgresDefinitionTransaction(
  client: PostgresClient,
): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the primary failure; releasing the client discards bad sessions.
  }
}
