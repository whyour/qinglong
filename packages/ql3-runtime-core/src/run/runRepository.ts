import type {
  RunAttemptRecord,
  RunAttemptStatus,
  RunEventRecord,
  RunRecord,
} from './run';
import type { RunRetryPolicyRecord } from './runRetryPolicy';

export const MAX_RUN_EVENT_PAYLOAD_BYTES = 16 * 1024;
export const MAX_RUN_EVENT_PAGE_SIZE = 500;
export const MAX_CANCELLATION_RECOVERY_PAGE_SIZE = 500;

export interface RunRepositoryReader {
  findRunById(runId: string): Promise<RunRecord | null>;
  findAttemptById(attemptId: string): Promise<RunAttemptRecord | null>;
  findLatestAttemptByRunId(runId: string): Promise<RunAttemptRecord | null>;
  findRetryPolicyByRunId(runId: string): Promise<RunRetryPolicyRecord | null>;
  listEvents(
    runId: string,
    options?: { afterSequence?: number; limit?: number },
  ): Promise<RunEventRecord[]>;
  listCancellationRequested(options?: {
    beforeMs?: number;
    limit?: number;
  }): Promise<RunRecord[]>;
}

export interface RunRepositoryTransaction extends RunRepositoryReader {
  insertRun(run: RunRecord): Promise<void>;
  insertAttempt(attempt: RunAttemptRecord): Promise<void>;
  insertRetryPolicy(policy: RunRetryPolicyRecord): Promise<void>;
  /**
   * Replaces a Run only when its persisted version still equals
   * `expectedVersion`. The supplied Run must carry `expectedVersion + 1`.
   */
  compareAndSetRun(run: RunRecord, expectedVersion: number): Promise<boolean>;
  /**
   * Replaces an Attempt only when both state and callback sequence still match.
   * The Run aggregate version remains the primary serialization boundary.
   */
  compareAndSetAttempt(
    attempt: RunAttemptRecord,
    expected: {
      status: RunAttemptStatus;
      callbackSequence: number;
    },
  ): Promise<boolean>;
  compareAndSetRetryPolicy(
    policy: RunRetryPolicyRecord,
    expectedVersion: number,
  ): Promise<boolean>;
  appendEvent(event: RunEventRecord): Promise<void>;
}

export interface RunRepository extends RunRepositoryReader {
  transaction<T>(
    work: (transaction: RunRepositoryTransaction) => Promise<T>,
  ): Promise<T>;
}
