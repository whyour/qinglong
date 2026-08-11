// PostgreSQL authority adapter for lost-run retry reconciliation.
import { randomUUID } from 'node:crypto';
import {
  ClusterRunLostRetryUnavailableError,
  buildClusterRunLostRetryTransition,
  normalizeClusterRunLostRetryPageCommand,
  normalizeClusterRunLostRetryPageResult,
  type ClusterRunLostRetryDisposition,
  type ClusterRunLostRetryPageCommand,
  type ClusterRunLostRetryPageResult,
  type ClusterRunLostRetryRepository,
  type PostgresClient,
  type PostgresPool,
  type RunAttemptRecord,
  type RunRecord,
  type RunRetryPolicyRecord,
} from '@qinglong/runtime-core';
import { lockAttemptAuthority } from '../run/attemptAuthorityLock';
import { PostgresRunTransaction } from '../run/runRepository';

type Row = Record<string, unknown>;

interface Candidate {
  readonly runId: string;
  readonly attemptId: string;
}

const TRANSACTION_STATEMENT_TIMEOUT_MS = 5_000;
const TRANSACTION_LOCK_TIMEOUT_MS = 1_000;
const TRANSACTION_IDLE_TIMEOUT_MS = 10_000;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw new TypeError(`PostgreSQL lost retry ${key} is invalid`);
  }
  return value;
}

function integer(row: Row, key: string): number {
  const raw = row[key];
  const value =
    typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw)
      ? Number(raw)
      : raw;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(`PostgreSQL lost retry ${key} is invalid`);
  }
  return value;
}

function rowCount(result: { readonly rowCount?: number | null; readonly rows: readonly unknown[] }): number {
  return result.rowCount ?? result.rows.length;
}

function eventId(factory: () => string): string {
  const value = factory();
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 36 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError('PostgreSQL lost retry generated ID is invalid');
  }
  return value;
}

async function begin(client: PostgresClient): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
    `${TRANSACTION_STATEMENT_TIMEOUT_MS}ms`,
  ]);
  await client.query(`SELECT set_config('lock_timeout', $1, true)`, [
    `${TRANSACTION_LOCK_TIMEOUT_MS}ms`,
  ]);
  await client.query(
    `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
    [`${TRANSACTION_IDLE_TIMEOUT_MS}ms`],
  );
}

async function rollback(client: PostgresClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the primary transaction failure.
  }
}

/**
 * PostgreSQL owns candidate ordering, aggregate/advisory locks and the atomic
 * write bundle. Policy remains in runtime-core's pure transition builder.
 */
export class PostgresClusterRunLostRetryRepository
  implements ClusterRunLostRetryRepository
{
  constructor(
    private readonly pool: PostgresPool,
    private readonly createId: () => string = randomUUID,
  ) {
    if (
      !pool ||
      typeof pool.connect !== 'function' ||
      typeof createId !== 'function'
    ) {
      throw new TypeError('PostgreSQL lost retry repository is invalid');
    }
  }

  async reconcilePage(
    input: Readonly<ClusterRunLostRetryPageCommand>,
  ): Promise<Readonly<ClusterRunLostRetryPageResult>> {
    const command = normalizeClusterRunLostRetryPageCommand(input);
    try {
      const candidates = await this.listCandidates(command.limit + 1);
      const page = candidates.slice(0, command.limit);
      const counts: Record<ClusterRunLostRetryDisposition | 'raced', number> = {
        scheduled: 0,
        requeued: 0,
        failed_disabled: 0,
        failed_unsafe: 0,
        failed_exhausted: 0,
        raced: 0,
      };
      for (const candidate of page) {
        const disposition = await this.reconcileCandidate(candidate);
        counts[disposition] += 1;
      }
      return normalizeClusterRunLostRetryPageResult(
        {
          scanned: page.length,
          scheduled: counts.scheduled,
          requeued: counts.requeued,
          failed:
            counts.failed_disabled +
            counts.failed_unsafe +
            counts.failed_exhausted,
          raced: counts.raced,
          hasMore: candidates.length > command.limit,
        },
        command.limit,
      );
    } catch (error) {
      if (error instanceof ClusterRunLostRetryUnavailableError) throw error;
      throw new ClusterRunLostRetryUnavailableError({ cause: error });
    }
  }

  private async listCandidates(limit: number): Promise<readonly Candidate[]> {
    const result = await this.pool.query<Row>(
      `WITH observation AS MATERIALIZED (
         SELECT floor(
           extract(epoch FROM statement_timestamp()) * 1000
         )::bigint AS observed_at_ms
       )
       SELECT run.id AS "runId", attempt.id AS "attemptId"
       FROM "ql3"."runs" AS run
       JOIN LATERAL (
         SELECT candidate.id, candidate.status, candidate.attempt
         FROM "ql3"."run_attempts" AS candidate
         WHERE candidate.run_id = run.id
         ORDER BY candidate.attempt DESC, candidate.id DESC
         LIMIT 1
       ) AS attempt ON attempt.status = 'lost'
       LEFT JOIN "ql3"."run_retry_policies" AS policy
         ON policy.run_id = run.id
       CROSS JOIN observation
       WHERE run.execution_owner = 'runtime'
         AND run.trigger_type <> 'plugin_package_workflow'
         AND run.cancel_requested_at_ms IS NULL
         AND (
           run.status = 'lost'
           OR (
             run.status = 'retry_wait'
             AND policy.next_attempt_at_ms IS NOT NULL
             AND policy.next_attempt_at_ms <= observation.observed_at_ms
           )
         )
       ORDER BY
         CASE
           WHEN run.status = 'lost' THEN 0
           ELSE policy.next_attempt_at_ms
         END,
         run.id
       LIMIT $1`,
      [limit],
    );
    if (result.rows.length > limit) {
      throw new TypeError('PostgreSQL lost retry exceeded its page size');
    }
    return Object.freeze(
      result.rows.map((row) =>
        Object.freeze({
          runId: text(row, 'runId'),
          attemptId: text(row, 'attemptId'),
        }),
      ),
    );
  }

  private async reconcileCandidate(
    candidate: Readonly<Candidate>,
  ): Promise<ClusterRunLostRetryDisposition | 'raced'> {
    const client = await this.pool.connect();
    let began = false;
    try {
      await begin(client);
      began = true;
      await lockAttemptAuthority(client, candidate.attemptId);
      const locked = await client.query<Row>(
        `SELECT run.id AS "runId"
         FROM "ql3"."runs" AS run
         WHERE run.id = $1
           AND run.execution_owner = 'runtime'
           AND run.trigger_type <> 'plugin_package_workflow'
           AND run.cancel_requested_at_ms IS NULL
           AND run.status IN ('lost', 'retry_wait')
         FOR UPDATE`,
        [candidate.runId],
      );
      if (locked.rows.length === 0) {
        await client.query('COMMIT');
        began = false;
        return 'raced';
      }
      if (locked.rows.length !== 1) {
        throw new TypeError('PostgreSQL lost retry duplicated a Run');
      }
      const runs = new PostgresRunTransaction(client);
      const [run, attempt, policy] = await Promise.all([
        runs.findRunById(candidate.runId),
        runs.findLatestAttemptByRunId(candidate.runId),
        runs.findRetryPolicyByRunId(candidate.runId),
      ]);
      if (
        !run ||
        !attempt ||
        attempt.id !== candidate.attemptId ||
        attempt.status !== 'lost'
      ) {
        await client.query('COMMIT');
        began = false;
        return 'raced';
      }
      if (policy) {
        const policyLock = await client.query<Row>(
          `SELECT run_id AS "runId"
           FROM "ql3"."run_retry_policies"
           WHERE run_id = $1
           FOR UPDATE`,
          [candidate.runId],
        );
        if (policyLock.rows.length !== 1) {
          throw new TypeError('PostgreSQL lost retry policy disappeared');
        }
      }
      const observation = await client.query<Row>(
        `SELECT floor(
           extract(epoch FROM statement_timestamp()) * 1000
         )::bigint AS "observedAtMs"`,
      );
      if (observation.rows.length !== 1) {
        throw new TypeError('PostgreSQL lost retry observation is invalid');
      }
      const transition = buildClusterRunLostRetryTransition({
        run,
        attempt,
        policy,
        observedAtMs: integer(observation.rows[0]!, 'observedAtMs'),
        runEventId: eventId(this.createId),
        ...(run.status === 'retry_wait'
          ? {
              attemptId: eventId(this.createId),
              attemptEventId: eventId(this.createId),
            }
          : {}),
      });
      await this.persistTransition(runs, run, policy, transition);
      await client.query('COMMIT');
      began = false;
      return transition.disposition;
    } catch (error) {
      if (began) await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async persistTransition(
    runs: PostgresRunTransaction,
    currentRun: Readonly<RunRecord>,
    currentPolicy: Readonly<RunRetryPolicyRecord> | null,
    transition: ReturnType<typeof buildClusterRunLostRetryTransition>,
  ): Promise<void> {
    let version = currentRun.version;
    for (const run of transition.runTransitions) {
      if (!(await runs.compareAndSetRun(run, version))) {
        throw new TypeError('PostgreSQL lost retry Run fence changed');
      }
      version = run.version;
    }
    if (transition.policy && transition.policy !== currentPolicy) {
      if (
        !currentPolicy ||
        !(await runs.compareAndSetRetryPolicy(
          transition.policy,
          currentPolicy.version,
        ))
      ) {
        throw new TypeError('PostgreSQL lost retry policy fence changed');
      }
    }
    if (transition.attempt) {
      await runs.insertAttempt(transition.attempt);
    }
    for (const event of transition.events) {
      await runs.appendEvent(event);
    }
  }
}
