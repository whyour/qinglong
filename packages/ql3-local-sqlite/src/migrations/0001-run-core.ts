import { defineLocalSqliteMigration } from './sqlMigration';

export const local0001RunCoreMigration = defineLocalSqliteMigration({
  id: '0001-run-core',
  statements: [
    `
CREATE TABLE "QingLong3SchemaCapabilities" (
  contract_name TEXT PRIMARY KEY,
  contract_version INTEGER NOT NULL
    CONSTRAINT ql3_local_capabilities_version_check CHECK (contract_version >= 1),
  migration_id TEXT NOT NULL,
  capabilities TEXT NOT NULL
    CONSTRAINT ql3_local_capabilities_json_check
    CHECK (json_valid(capabilities) AND json_type(capabilities) = 'object'),
  updated_at_ms INTEGER NOT NULL
    CONSTRAINT ql3_local_capabilities_updated_at_check CHECK (updated_at_ms >= 0),
  CONSTRAINT ql3_local_capabilities_migration_fk
    FOREIGN KEY (migration_id)
    REFERENCES "QingLong3SchemaMigrations" (migration_id)
)
    `,
    `
CREATE TABLE "Runs" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_revision TEXT NOT NULL,
  task_name TEXT,
  task_snapshot_ref TEXT,
  legacy_cron_id INTEGER,
  parent_run_id TEXT,
  retry_of_run_id TEXT,
  trigger_id TEXT,
  trigger_type TEXT NOT NULL,
  execution_origin TEXT NOT NULL
    CONSTRAINT ql3_local_runs_execution_origin_check
    CHECK (execution_origin IN ('manual','scheduled_system','scheduled_node','once','boot','grpc','subscription','system','script','legacy_import')),
  execution_owner TEXT NOT NULL
    CONSTRAINT ql3_local_runs_execution_owner_check
    CHECK (execution_owner IN ('legacy','runtime')),
  triggered_by TEXT,
  request_id TEXT,
  scheduled_for_ms INTEGER,
  status TEXT NOT NULL
    CONSTRAINT ql3_local_runs_status_check
    CHECK (status IN ('created','queued','dispatching','running','waiting_approval','retry_wait','lost','succeeded','failed','cancelled','timed_out')),
  version INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ql3_local_runs_version_check CHECK (version >= 0),
  event_sequence INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ql3_local_runs_event_sequence_check CHECK (event_sequence >= 0),
  priority INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  input_ref TEXT,
  output_ref TEXT,
  created_at_ms INTEGER NOT NULL,
  queued_at_ms INTEGER,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  cancel_requested_at_ms INTEGER,
  cancel_reason TEXT
    CONSTRAINT ql3_local_runs_cancel_reason_check
    CHECK (cancel_reason IS NULL OR cancel_reason IN ('user','policy','shutdown','reconcile','timeout')),
  error_code TEXT,
  error_summary TEXT,
  CONSTRAINT ql3_local_runs_time_check CHECK (
    created_at_ms >= 0 AND
    (scheduled_for_ms IS NULL OR scheduled_for_ms >= 0) AND
    (queued_at_ms IS NULL OR queued_at_ms >= 0) AND
    (started_at_ms IS NULL OR started_at_ms >= 0) AND
    (finished_at_ms IS NULL OR finished_at_ms >= 0) AND
    (cancel_requested_at_ms IS NULL OR cancel_requested_at_ms >= 0)
  ),
  CONSTRAINT ql3_local_runs_parent_fk FOREIGN KEY (parent_run_id) REFERENCES "Runs" (id),
  CONSTRAINT ql3_local_runs_retry_fk FOREIGN KEY (retry_of_run_id) REFERENCES "Runs" (id)
)
    `,
    `CREATE UNIQUE INDEX ql3_local_runs_project_idempotency_uidx ON "Runs" (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
    `CREATE INDEX ql3_local_runs_project_created_idx ON "Runs" (project_id, created_at_ms, id)`,
    `CREATE INDEX ql3_local_runs_task_created_idx ON "Runs" (task_id, created_at_ms, id)`,
    `CREATE INDEX ql3_local_runs_cancel_requested_idx ON "Runs" (status, cancel_requested_at_ms, id)`,
    `CREATE INDEX ql3_local_runs_lost_retry_idx ON "Runs" (execution_owner, status, id)`,
    `
CREATE TABLE "RunAttempts" (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_run_id TEXT,
  attempt INTEGER NOT NULL
    CONSTRAINT ql3_local_attempts_attempt_check CHECK (attempt >= 1),
  status TEXT NOT NULL
    CONSTRAINT ql3_local_attempts_status_check
    CHECK (status IN ('claimed','starting','running','succeeded','failed','cancelled','timed_out','lost')),
  executor_type TEXT NOT NULL,
  worker_id TEXT,
  worker_session_id TEXT,
  worker_generation INTEGER,
  executor_handle TEXT,
  pid INTEGER,
  log_artifact_id TEXT,
  lease_token TEXT,
  lease_token_digest TEXT,
  lease_generation INTEGER,
  lease_version INTEGER,
  lease_expires_at_ms INTEGER,
  offer_id TEXT,
  deadline_at_ms INTEGER,
  callback_token_hash TEXT,
  callback_sequence INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ql3_local_attempts_callback_sequence_check CHECK (callback_sequence >= 0),
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  exit_code INTEGER,
  error_code TEXT,
  error_summary TEXT,
  CONSTRAINT ql3_local_attempts_time_check CHECK (
    created_at_ms >= 0 AND
    (started_at_ms IS NULL OR started_at_ms >= 0) AND
    (finished_at_ms IS NULL OR finished_at_ms >= 0) AND
    (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0) AND
    (deadline_at_ms IS NULL OR deadline_at_ms >= 0)
  ),
  CONSTRAINT ql3_local_attempts_run_fk FOREIGN KEY (run_id) REFERENCES "Runs" (id) ON DELETE CASCADE
)
    `,
    `CREATE UNIQUE INDEX ql3_local_attempts_run_attempt_uidx ON "RunAttempts" (run_id, attempt)`,
    `CREATE INDEX ql3_local_attempts_run_status_idx ON "RunAttempts" (run_id, status, id)`,
    `CREATE INDEX ql3_local_attempts_lease_idx ON "RunAttempts" (lease_expires_at_ms, id)`,
    `CREATE INDEX ql3_local_attempts_deadline_idx ON "RunAttempts" (status, deadline_at_ms, id)`,
    `
CREATE TABLE "RunEvents" (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL
    CONSTRAINT ql3_local_events_sequence_check CHECK (sequence >= 1),
  type TEXT NOT NULL,
  dedupe_key TEXT,
  actor_type TEXT NOT NULL
    CONSTRAINT ql3_local_events_actor_type_check
    CHECK (actor_type IN ('user','api_app','trigger','agent','mcp_client','worker','executor','system','legacy_shell','scheduler','reconciler','compatibility')),
  actor_id TEXT,
  attempt_id TEXT,
  step_run_id TEXT,
  payload TEXT NOT NULL
    CONSTRAINT ql3_local_events_payload_check
    CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  created_at_ms INTEGER NOT NULL
    CONSTRAINT ql3_local_events_created_at_check CHECK (created_at_ms >= 0),
  CONSTRAINT ql3_local_events_run_fk FOREIGN KEY (run_id) REFERENCES "Runs" (id) ON DELETE CASCADE,
  CONSTRAINT ql3_local_events_attempt_fk FOREIGN KEY (attempt_id) REFERENCES "RunAttempts" (id) ON DELETE SET NULL
)
    `,
    `CREATE UNIQUE INDEX ql3_local_events_run_sequence_uidx ON "RunEvents" (run_id, sequence)`,
    `CREATE UNIQUE INDEX ql3_local_events_run_dedupe_uidx ON "RunEvents" (run_id, dedupe_key) WHERE dedupe_key IS NOT NULL`,
    `CREATE INDEX ql3_local_events_run_created_idx ON "RunEvents" (run_id, created_at_ms, id)`,
    `
CREATE TABLE "RunRetryPolicies" (
  run_id TEXT PRIMARY KEY,
  max_attempts INTEGER NOT NULL
    CONSTRAINT ql3_local_retry_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 16),
  retry_on_lost INTEGER NOT NULL
    CONSTRAINT ql3_local_retry_on_lost_check CHECK (retry_on_lost IN (0, 1)),
  safety TEXT NOT NULL
    CONSTRAINT ql3_local_retry_safety_check CHECK (safety IN ('unknown','idempotent','deduplicated')),
  backoff_base_ms INTEGER NOT NULL,
  backoff_max_ms INTEGER NOT NULL,
  next_attempt_at_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ql3_local_retry_version_check CHECK (version >= 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CONSTRAINT ql3_local_retry_backoff_check CHECK (
    backoff_base_ms BETWEEN 0 AND 86400000 AND
    backoff_max_ms BETWEEN backoff_base_ms AND 86400000
  ),
  CONSTRAINT ql3_local_retry_time_check CHECK (
    created_at_ms >= 0 AND updated_at_ms >= created_at_ms AND
    (next_attempt_at_ms IS NULL OR next_attempt_at_ms >= 0)
  ),
  CONSTRAINT ql3_local_retry_run_fk FOREIGN KEY (run_id) REFERENCES "Runs" (id) ON DELETE CASCADE
)
    `,
    `CREATE INDEX ql3_local_retry_due_idx ON "RunRetryPolicies" (next_attempt_at_ms, run_id) WHERE next_attempt_at_ms IS NOT NULL`,
  ],
});
