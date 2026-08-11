import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';

import { mapStorageError, sqlState, unavailable } from './authority';

const RETRYABLE_SQL_STATES = new Set(['40001', '40P01']);
const MAX_TRANSACTION_ATTEMPTS = 3;

async function begin(client: PostgresClient): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
    '5s',
  ]);
  await client.query(`SELECT set_config('lock_timeout', $1, true)`, ['2s']);
  await client.query(
    `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
    ['5s'],
  );
}

async function rollback(client: PostgresClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original transaction failure.
  }
}

export async function runTransaction<T>(
  pool: PostgresPool,
  work: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    let client: PostgresClient;
    try {
      client = await pool.connect();
    } catch (error) {
      throw unavailable(error);
    }
    let began = false;
    try {
      await begin(client);
      began = true;
      const result = await work(client);
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (began) await rollback(client);
      if (
        RETRYABLE_SQL_STATES.has(sqlState(error) ?? '') &&
        attempt + 1 < MAX_TRANSACTION_ATTEMPTS
      ) {
        continue;
      }
      throw mapStorageError(error);
    } finally {
      client.release();
    }
  }
  throw unavailable();
}
