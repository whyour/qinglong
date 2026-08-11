import type { RunAttemptStatus } from '../run/run';

export const LOCAL_COMPLETION_RECEIPT_JOURNAL_STATES = [
  'pending',
  'quarantined',
] as const;
export const MAX_LOCAL_COMPLETION_RECEIPT_JOURNAL_PAGE = 64;

export type LocalCompletionReceiptJournalState =
  (typeof LOCAL_COMPLETION_RECEIPT_JOURNAL_STATES)[number];

export interface LocalCompletionReceiptJournalRecord {
  readonly attemptId: string;
  readonly runId: string;
  readonly state: LocalCompletionReceiptJournalState;
  readonly registeredAtMs: number;
  readonly updatedAtMs: number;
  readonly quarantineRef?: string;
  readonly purgeAfterMs?: number;
}

export interface LocalCompletionReceiptJournalCandidate
  extends LocalCompletionReceiptJournalRecord {
  readonly attemptStatus: RunAttemptStatus;
  readonly executorType: string;
  readonly finishedAtMs?: number;
}

export interface LocalCompletionReceiptJournalCursor {
  readonly updatedAtMs: number;
  readonly attemptId: string;
}

export interface LocalCompletionReceiptJournalPage {
  readonly candidates: readonly LocalCompletionReceiptJournalCandidate[];
  readonly truncated: boolean;
  readonly nextCursor?: LocalCompletionReceiptJournalCursor;
}

export interface RegisterLocalCompletionReceiptCommand {
  readonly attemptId: string;
  readonly runId: string;
  readonly registeredAtMs: number;
}

export interface QuarantineLocalCompletionReceiptCommand {
  readonly attemptId: string;
  readonly quarantineRef: string;
  readonly purgeAfterMs: number;
  readonly updatedAtMs: number;
}

export interface LocalCompletionReceiptJournal {
  register(command: RegisterLocalCompletionReceiptCommand): Promise<void>;
  markQuarantined(
    command: QuarantineLocalCompletionReceiptCommand,
  ): Promise<void>;
  resolve(attemptId: string): Promise<boolean>;
  listCandidates(options: {
    readonly observedAtMs: number;
    readonly cursor?: LocalCompletionReceiptJournalCursor;
    readonly limit?: number;
  }): Promise<LocalCompletionReceiptJournalPage>;
}

const PORTABLE_LOCAL_EXECUTION_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;

export function assertLocalCompletionReceiptId(
  value: string,
  field: 'runId' | 'attemptId',
): void {
  if (!PORTABLE_LOCAL_EXECUTION_ID.test(value)) {
    throw new TypeError(`${field} must be a bounded portable execution ID`);
  }
}

export function assertLocalCompletionReceiptTimestamp(
  value: number,
  field: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

export function assertLocalCompletionReceiptJournalCursor(
  cursor: LocalCompletionReceiptJournalCursor,
): void {
  assertLocalCompletionReceiptTimestamp(cursor.updatedAtMs, 'updatedAtMs');
  assertLocalCompletionReceiptId(cursor.attemptId, 'attemptId');
}

export function assertLocalCompletionReceiptJournalLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LOCAL_COMPLETION_RECEIPT_JOURNAL_PAGE
  ) {
    throw new RangeError(
      `limit must be between 1 and ${MAX_LOCAL_COMPLETION_RECEIPT_JOURNAL_PAGE}`,
    );
  }
}
