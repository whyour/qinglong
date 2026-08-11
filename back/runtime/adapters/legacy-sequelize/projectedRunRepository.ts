import { Sequelize, Transaction } from 'sequelize';
import type {
  RunAttemptRecord,
  RunAttemptStatus,
  RunEventRecord,
  RunRecord,
} from '../../domain/run';
import type { RunRetryPolicyRecord } from '../../domain/runRetryPolicy';
import type { RunRepositoryTransaction } from '../../ports/runRepository';
import {
  LegacySequelizeRunRepository,
  LegacySequelizeRunTransaction,
} from './runRepository';

export interface SequelizeRunProjectionContext {
  transaction: Transaction;
  runs: RunRepositoryTransaction;
  changedRunIds: readonly string[];
  changedAttemptIds: readonly string[];
}

export interface SequelizeRunProjectionParticipant {
  apply(context: SequelizeRunProjectionContext): Promise<void>;
}

class TrackingRunRepositoryTransaction implements RunRepositoryTransaction {
  readonly changedRunIds = new Set<string>();
  readonly changedAttemptIds = new Set<string>();

  constructor(private readonly delegate: RunRepositoryTransaction) {}

  findRunById(runId: string): Promise<RunRecord | null> {
    return this.delegate.findRunById(runId);
  }

  findAttemptById(attemptId: string): Promise<RunAttemptRecord | null> {
    return this.delegate.findAttemptById(attemptId);
  }

  findLatestAttemptByRunId(runId: string): Promise<RunAttemptRecord | null> {
    return this.delegate.findLatestAttemptByRunId(runId);
  }

  findRetryPolicyByRunId(runId: string): Promise<RunRetryPolicyRecord | null> {
    return this.delegate.findRetryPolicyByRunId(runId);
  }

  listEvents(
    runId: string,
    options?: { afterSequence?: number; limit?: number },
  ): Promise<RunEventRecord[]> {
    return this.delegate.listEvents(runId, options);
  }

  listCancellationRequested(options?: {
    beforeMs?: number;
    limit?: number;
  }): Promise<RunRecord[]> {
    return this.delegate.listCancellationRequested(options);
  }

  async insertRun(run: RunRecord): Promise<void> {
    await this.delegate.insertRun(run);
    this.changedRunIds.add(run.id);
  }

  async insertAttempt(attempt: RunAttemptRecord): Promise<void> {
    await this.delegate.insertAttempt(attempt);
    this.changedRunIds.add(attempt.runId);
    this.changedAttemptIds.add(attempt.id);
  }

  insertRetryPolicy(policy: RunRetryPolicyRecord): Promise<void> {
    return this.delegate.insertRetryPolicy(policy);
  }

  async compareAndSetRun(
    run: RunRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    const updated = await this.delegate.compareAndSetRun(run, expectedVersion);
    if (updated) this.changedRunIds.add(run.id);
    return updated;
  }

  async compareAndSetAttempt(
    attempt: RunAttemptRecord,
    expected: { status: RunAttemptStatus; callbackSequence: number },
  ): Promise<boolean> {
    const updated = await this.delegate.compareAndSetAttempt(attempt, expected);
    if (updated) {
      this.changedRunIds.add(attempt.runId);
      this.changedAttemptIds.add(attempt.id);
    }
    return updated;
  }

  compareAndSetRetryPolicy(
    policy: RunRetryPolicyRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    return this.delegate.compareAndSetRetryPolicy(policy, expectedVersion);
  }

  appendEvent(event: RunEventRecord): Promise<void> {
    return this.delegate.appendEvent(event);
  }
}

/**
 * Primary-only repository. Existing Shadow repositories keep their original
 * transaction implementation and never execute these projection participants.
 */
export class LegacySequelizeProjectedRunRepository extends LegacySequelizeRunRepository {
  private readonly participants: readonly SequelizeRunProjectionParticipant[];

  constructor(
    private readonly projectedDatabase: Sequelize,
    participants: readonly SequelizeRunProjectionParticipant[],
  ) {
    super(projectedDatabase);
    this.participants = [...participants];
  }

  override async transaction<T>(
    work: (transaction: RunRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    return this.projectedDatabase.transaction(
      { type: Transaction.TYPES.IMMEDIATE },
      async (transaction) => {
        const runs = new LegacySequelizeRunTransaction(
          this.models,
          transaction,
        );
        const tracked = new TrackingRunRepositoryTransaction(runs);
        const result = await work(tracked);
        if (
          tracked.changedRunIds.size > 0 ||
          tracked.changedAttemptIds.size > 0
        ) {
          const context: SequelizeRunProjectionContext = {
            transaction,
            runs,
            changedRunIds: [...tracked.changedRunIds],
            changedAttemptIds: [...tracked.changedAttemptIds],
          };
          for (const participant of this.participants) {
            await participant.apply(context);
          }
        }
        return result;
      },
    );
  }
}
