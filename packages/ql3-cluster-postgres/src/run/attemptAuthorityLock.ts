import type { PostgresClient } from '@qinglong/runtime-core';

/**
 * Run-owned lock serializing every mutation and attestation that can change or certify one
 * Attempt's remote-execution authority. Callers must already be inside a
 * transaction and acquire this before row locks to keep one lock order.
 */
export async function lockAttemptAuthority(
  queryable: Pick<PostgresClient, 'query'>,
  attemptId: string,
): Promise<void> {
  await queryable.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`ql3-attempt-authority:${attemptId}`],
  );
}
