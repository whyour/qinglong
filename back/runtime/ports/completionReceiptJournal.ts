import type {
  CompletionReceiptJournalCursor,
  CompletionReceiptJournalPage,
} from '../domain/completionReceiptJournal';

export const MAX_COMPLETION_RECEIPT_JOURNAL_BATCH_SIZE = 64;

export interface RegisterCompletionReceiptCommand {
  attemptId: string;
  runId: string;
  registeredAtMs: number;
}

export interface QuarantineCompletionReceiptCommand {
  attemptId: string;
  quarantineRef: string;
  purgeAfterMs: number;
  updatedAtMs: number;
}

export interface CompletionReceiptJournal {
  register(command: RegisterCompletionReceiptCommand): Promise<void>;
  markQuarantined(command: QuarantineCompletionReceiptCommand): Promise<void>;
  resolve(attemptId: string): Promise<boolean>;
  listCandidates(options: {
    observedAtMs: number;
    cursor?: CompletionReceiptJournalCursor;
    limit?: number;
  }): Promise<CompletionReceiptJournalPage>;
}
