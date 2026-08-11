import { randomUUID } from 'node:crypto';

import {
  RunLostRetryUnavailableError,
  buildRunLostRetryTransition,
  normalizeRunLostRetryPageCommand,
  normalizeRunLostRetryPageResult,
  type RunLostRetryDisposition,
  type RunLostRetryPageCommand,
  type RunLostRetryPageResult,
  type RunLostRetryRepository,
  type RunLostRetryTransition,
} from '@qinglong/runtime-core/run-lost-retry';
import type {
  RunRecord,
  RunRepositoryTransaction,
  RunRetryPolicyRecord,
} from '@qinglong/runtime-core/run-repository';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteRunRepository } from './runRepository';

type Row = Record<string, unknown>;

interface Candidate {
  readonly runId: string;
  readonly attemptId: string;
}

function identifier(row: Row, key: string): string {
  const value = row[key];
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`Local SQLite lost retry ${key} is invalid`);
  }
  return value;
}

function generatedId(factory: () => string): string {
  const value = factory();
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 36 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError('Local SQLite lost retry generated ID is invalid');
  }
  return value;
}

/**
 * Local Profiles share one SQLite authority. Candidate discovery and each
 * BEGIN IMMEDIATE aggregate mutation are bounded, serialized operations; this
 * repository owns no connection, timer, cursor, or background task.
 */
export class LocalSqliteRunLostRetryRepository
  implements RunLostRetryRepository
{
  constructor(
    private readonly authority: LocalSqliteOperationAuthority,
    private readonly runs: LocalSqliteRunRepository,
    private readonly createId: () => string = randomUUID,
    private readonly clock: { now(): number } = { now: Date.now },
  ) {
    if (
      !(authority instanceof LocalSqliteOperationAuthority) ||
      !(runs instanceof LocalSqliteRunRepository) ||
      typeof createId !== 'function' ||
      typeof clock?.now !== 'function'
    ) {
      throw new TypeError('Local SQLite lost retry repository is invalid');
    }
  }

  async reconcilePage(
    input: Readonly<RunLostRetryPageCommand>,
  ): Promise<Readonly<RunLostRetryPageResult>> {
    const command = normalizeRunLostRetryPageCommand(input);
    try {
      const candidates = await this.listCandidates(command.limit + 1);
      const page = candidates.slice(0, command.limit);
      const counts: Record<RunLostRetryDisposition | 'raced', number> = {
        scheduled: 0,
        requeued: 0,
        failed_disabled: 0,
        failed_unsafe: 0,
        failed_exhausted: 0,
        raced: 0,
      };
      for (const candidate of page) {
        counts[await this.reconcileCandidate(candidate)] += 1;
      }
      return normalizeRunLostRetryPageResult(
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
      if (error instanceof RunLostRetryUnavailableError) throw error;
      throw new RunLostRetryUnavailableError({ cause: error });
    }
  }

  private listCandidates(limit: number): Promise<readonly Candidate[]> {
    return this.authority.enqueue(
      async () => {
        const observedAtMs = this.observedAtMs();
        const rows = this.authority.client
          .prepare(
            `SELECT run."id" AS "runId", attempt."id" AS "attemptId"
             FROM "Runs" AS run
             JOIN "RunAttempts" AS attempt
               ON attempt."run_id" = run."id"
              AND attempt."attempt" = (
                SELECT MAX(latest."attempt")
                FROM "RunAttempts" AS latest
                WHERE latest."run_id" = run."id"
              )
             LEFT JOIN "RunRetryPolicies" AS policy
               ON policy."run_id" = run."id"
             WHERE run."execution_owner" = 'runtime'
               AND run."trigger_type" <> 'plugin_package_workflow'
               AND run."cancel_requested_at_ms" IS NULL
               AND attempt."status" = 'lost'
               AND (
                 run."status" = 'lost'
                 OR (
                   run."status" = 'retry_wait'
                   AND policy."next_attempt_at_ms" IS NOT NULL
                   AND policy."next_attempt_at_ms" <= ?
                 )
               )
             ORDER BY
               CASE WHEN run."status" = 'lost' THEN 0
                    ELSE policy."next_attempt_at_ms" END,
               run."id"
             LIMIT ?`,
          )
          .all(observedAtMs, limit) as Row[];
        if (rows.length > limit) {
          throw new TypeError('Local SQLite lost retry exceeded its page size');
        }
        return Object.freeze(
          rows.map((row) =>
            Object.freeze({
              runId: identifier(row, 'runId'),
              attemptId: identifier(row, 'attemptId'),
            }),
          ),
        );
      },
      () => new RunLostRetryUnavailableError(),
    );
  }

  private async reconcileCandidate(
    candidate: Readonly<Candidate>,
  ): Promise<RunLostRetryDisposition | 'raced'> {
    return this.runs.transaction(async (transaction) => {
      const run = await transaction.findRunById(candidate.runId);
      const attempt = await transaction.findLatestAttemptByRunId(
        candidate.runId,
      );
      const policy = await transaction.findRetryPolicyByRunId(candidate.runId);
      if (
        !run ||
        !attempt ||
        attempt.id !== candidate.attemptId ||
        attempt.status !== 'lost' ||
        run.executionOwner !== 'runtime' ||
        run.triggerType === 'plugin_package_workflow' ||
        run.cancelRequestedAtMs !== undefined ||
        (run.status !== 'lost' && run.status !== 'retry_wait') ||
        (run.status === 'retry_wait' &&
          (policy?.nextAttemptAtMs === undefined ||
            policy.nextAttemptAtMs > this.observedAtMs()))
      ) {
        return 'raced';
      }
      const transition = buildRunLostRetryTransition({
        run,
        attempt,
        policy,
        observedAtMs: this.observedAtMs(),
        runEventId: generatedId(this.createId),
        ...(run.status === 'retry_wait'
          ? {
              attemptId: generatedId(this.createId),
              attemptEventId: generatedId(this.createId),
            }
          : {}),
      });
      await this.persistTransition(transaction, run, policy, transition);
      return transition.disposition;
    });
  }

  private observedAtMs(): number {
    const value = this.clock.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Local SQLite lost retry clock is invalid');
    }
    return value;
  }

  private async persistTransition(
    transaction: RunRepositoryTransaction,
    currentRun: Readonly<RunRecord>,
    currentPolicy: Readonly<RunRetryPolicyRecord> | null,
    transition: Readonly<RunLostRetryTransition>,
  ): Promise<void> {
    let version = currentRun.version;
    for (const run of transition.runTransitions) {
      if (!(await transaction.compareAndSetRun(run, version))) {
        throw new TypeError('Local SQLite lost retry Run fence changed');
      }
      version = run.version;
    }
    if (transition.policy && transition.policy !== currentPolicy) {
      if (
        !currentPolicy ||
        !(await transaction.compareAndSetRetryPolicy(
          transition.policy,
          currentPolicy.version,
        ))
      ) {
        throw new TypeError('Local SQLite lost retry policy fence changed');
      }
    }
    if (transition.attempt) {
      await transaction.insertAttempt(transition.attempt);
    }
    for (const event of transition.events) {
      await transaction.appendEvent(event);
    }
  }
}
