import { defineLocalSqliteMigration } from './sqlMigration';

export const local0087RunAttemptLogRetentionMigration =
  defineLocalSqliteMigration({
    id: '0087-run-attempt-log-retention',
    statements: [
      `
CREATE TABLE "QingLong3RunAttemptLogArtifactTombstones" (
  log_artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  executor_type TEXT NOT NULL
    CONSTRAINT ql3_run_log_tombstone_executor_check
    CHECK (executor_type = 'local_process'),
  finished_at_ms INTEGER NOT NULL,
  eligible_at_ms INTEGER NOT NULL,
  retired_at_ms INTEGER NOT NULL,
  disposition TEXT NOT NULL
    CONSTRAINT ql3_run_log_tombstone_disposition_check
    CHECK (disposition IN ('deleted','already_absent')),
  byte_length INTEGER NOT NULL,
  truncated TEXT NOT NULL
    CONSTRAINT ql3_run_log_tombstone_truncated_check
    CHECK (truncated IN ('true','false','unknown')),
  maximum_bytes INTEGER,
  truncation_observed_at_ms INTEGER,
  record_digest TEXT NOT NULL,
  CONSTRAINT ql3_run_log_tombstone_identity_check CHECK (
    length(project_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(attempt_id) BETWEEN 1 AND 128 AND
    length(log_artifact_id) = 36 AND
    substr(log_artifact_id, 1, 6) = 'local-' AND
    substr(log_artifact_id, 7) NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_run_log_tombstone_time_check CHECK (
    finished_at_ms >= 0 AND
    eligible_at_ms >= finished_at_ms AND
    retired_at_ms >= eligible_at_ms
  ),
  CONSTRAINT ql3_run_log_tombstone_size_check CHECK (
    byte_length BETWEEN 0 AND 1073741824 AND
    (disposition <> 'already_absent' OR byte_length = 0)
  ),
  CONSTRAINT ql3_run_log_tombstone_truncation_shape_check CHECK (
    (truncated = 'unknown' AND maximum_bytes IS NULL AND truncation_observed_at_ms IS NULL) OR
    (truncated IN ('true','false') AND maximum_bytes >= 1 AND truncation_observed_at_ms >= 0)
  ),
  CONSTRAINT ql3_run_log_tombstone_digest_check CHECK (
    length(record_digest) = 64 AND record_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_run_log_tombstone_attempt_fk
    FOREIGN KEY (attempt_id) REFERENCES "RunAttempts" (id) ON DELETE CASCADE,
  CONSTRAINT ql3_run_log_tombstone_run_fk
    FOREIGN KEY (run_id) REFERENCES "Runs" (id) ON DELETE CASCADE
)
      `,
      `CREATE INDEX ql3_run_log_tombstone_retired_idx ON "QingLong3RunAttemptLogArtifactTombstones" (retired_at_ms, attempt_id)`,
      `CREATE UNIQUE INDEX ql3_run_log_tombstone_attempt_uidx ON "QingLong3RunAttemptLogArtifactTombstones" (attempt_id)`,
      `CREATE INDEX ql3_run_log_retention_candidate_idx ON "RunAttempts" (executor_type, status, finished_at_ms, id) WHERE log_artifact_id IS NOT NULL`,
      `
CREATE TABLE "QingLong3RunAttemptLogRetentionState" (
  maintenance_id TEXT PRIMARY KEY
    CONSTRAINT ql3_run_log_retention_state_id_check
    CHECK (maintenance_id = 'local-run-attempt-log'),
  cursor_finished_at_ms INTEGER,
  cursor_attempt_id TEXT,
  updated_at_ms INTEGER NOT NULL,
  CONSTRAINT ql3_run_log_retention_state_cursor_check CHECK (
    (cursor_finished_at_ms IS NULL AND cursor_attempt_id IS NULL) OR
    (cursor_finished_at_ms >= 0 AND length(cursor_attempt_id) BETWEEN 1 AND 128)
  ),
  CONSTRAINT ql3_run_log_retention_state_time_check CHECK (updated_at_ms >= 0)
)
      `,
      `INSERT INTO "QingLong3RunAttemptLogRetentionState" (maintenance_id, cursor_finished_at_ms, cursor_attempt_id, updated_at_ms) VALUES ('local-run-attempt-log', NULL, NULL, 0)`,
    ],
  });
