import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';

import {
  InvalidModelPriceCatalogError,
  ModelPriceCatalogConflictError,
  ModelPriceCatalogUnavailableError,
} from '../../modelPriceCatalog';

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function unavailable(
  cause?: unknown,
): ModelPriceCatalogUnavailableError {
  return new ModelPriceCatalogUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function sqlState(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : '';
}

export function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidModelPriceCatalogError ||
    error instanceof ModelPriceCatalogConflictError ||
    error instanceof ModelPriceCatalogUnavailableError
  )
    return error;
  const state = sqlState(error);
  if (
    state === '23503' ||
    state === '23505' ||
    state === '23514' ||
    state === '40001' ||
    state === '40P01'
  )
    return new ModelPriceCatalogConflictError();
  return unavailable(error);
}

export function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value))
    throw new InvalidModelPriceCatalogError(`${label} is invalid`);
  return value;
}

export function assertPool(pool: PostgresPool): void {
  if (
    !pool ||
    typeof pool.query !== 'function' ||
    typeof pool.connect !== 'function'
  )
    throw new TypeError('PostgreSQL Model price catalog pool is invalid');
}

export async function acquireClient(
  pool: PostgresPool,
): Promise<PostgresClient> {
  try {
    return await pool.connect();
  } catch (error) {
    throw unavailable(error);
  }
}

export async function rollback(client: PostgresClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

export async function runTransaction<T>(
  pool: PostgresPool,
  provider: string,
  model: string,
  work: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  const client = await acquireClient(pool);
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [JSON.stringify([provider, model])],
    );
    return await work(client);
  } catch (error) {
    await rollback(client);
    throw mapStorageError(error);
  } finally {
    client.release();
  }
}
