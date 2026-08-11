import type { RunAttemptStatus } from './run';

export const COMPLETION_RECEIPT_JOURNAL_STATES = [
  'pending',
  'quarantined',
] as const;

export type CompletionReceiptJournalState =
  (typeof COMPLETION_RECEIPT_JOURNAL_STATES)[number];

export interface CompletionReceiptJournalRecord {
  attemptId: string;
  runId: string;
  state: CompletionReceiptJournalState;
  quarantineRef?: string;
  purgeAfterMs?: number;
  registeredAtMs: number;
  updatedAtMs: number;
}

export interface CompletionReceiptJournalCandidate
  extends CompletionReceiptJournalRecord {
  attemptStatus: RunAttemptStatus;
  executorType: string;
  finishedAtMs?: number;
}

export interface CompletionReceiptJournalCursor {
  updatedAtMs: number;
  attemptId: string;
}

export interface CompletionReceiptJournalPage {
  candidates: readonly CompletionReceiptJournalCandidate[];
  truncated: boolean;
  nextCursor?: CompletionReceiptJournalCursor;
}
