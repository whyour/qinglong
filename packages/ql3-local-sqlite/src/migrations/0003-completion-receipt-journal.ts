import { defineLocalSqliteMigration } from './sqlMigration';

export const local0003CompletionReceiptJournalMigration =
  defineLocalSqliteMigration({
    id: '0003-completion-receipt-journal',
    statements: [
      `
CREATE TABLE "LocalCompletionReceiptJournal" (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL
    CONSTRAINT ql3_local_receipt_journal_state_check
    CHECK (state IN ('pending','quarantined')),
  quarantine_ref TEXT,
  purge_after_ms INTEGER,
  registered_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CONSTRAINT ql3_local_receipt_journal_time_check CHECK (
    registered_at_ms >= 0 AND updated_at_ms >= registered_at_ms AND
    (purge_after_ms IS NULL OR purge_after_ms >= updated_at_ms)
  ),
  CONSTRAINT ql3_local_receipt_journal_shape_check CHECK (
    (state = 'pending' AND quarantine_ref IS NULL AND purge_after_ms IS NULL) OR
    (state = 'quarantined' AND quarantine_ref IS NOT NULL AND purge_after_ms IS NOT NULL)
  ),
  CONSTRAINT ql3_local_receipt_journal_attempt_fk
    FOREIGN KEY (attempt_id) REFERENCES "RunAttempts" (id) ON DELETE CASCADE,
  CONSTRAINT ql3_local_receipt_journal_run_fk
    FOREIGN KEY (run_id) REFERENCES "Runs" (id) ON DELETE CASCADE
)
      `,
      `CREATE INDEX ql3_local_receipt_journal_scan_idx ON "LocalCompletionReceiptJournal" (state, updated_at_ms, attempt_id)`,
      `CREATE INDEX ql3_local_receipt_journal_purge_idx ON "LocalCompletionReceiptJournal" (purge_after_ms, attempt_id) WHERE state = 'quarantined'`,
    ],
  });
