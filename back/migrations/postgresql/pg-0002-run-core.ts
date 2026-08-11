import { definePostgresSqlMigration } from './sqlMigration';

export const POSTGRESQL_RUN_TABLE = 'runs';
export const POSTGRESQL_RUN_ATTEMPT_TABLE = 'run_attempts';
export const POSTGRESQL_RUN_EVENT_TABLE = 'run_events';

export const pg0002RunCoreMigration = definePostgresSqlMigration({
  id: 'pg-0002-run-core',
  statements: [
    `
CREATE TABLE "ql3"."${POSTGRESQL_RUN_TABLE}" (
  id varchar(36) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  task_id varchar(255) NOT NULL,
  task_revision varchar(128) NOT NULL,
  task_name varchar(255),
  task_snapshot_ref varchar(512),
  parent_run_id varchar(36),
  retry_of_run_id varchar(36),
  trigger_id varchar(36),
  trigger_type varchar(64) NOT NULL,
  execution_origin varchar(64) NOT NULL,
  execution_owner varchar(16) NOT NULL
    CONSTRAINT ql3_runs_execution_owner_check
    CHECK (execution_owner = 'runtime'),
  triggered_by varchar(255),
  request_id varchar(128),
  scheduled_for_ms bigint
    CONSTRAINT ql3_runs_scheduled_for_check
    CHECK (scheduled_for_ms IS NULL OR scheduled_for_ms >= 0),
  status varchar(32) NOT NULL
    CONSTRAINT ql3_runs_status_check
    CHECK (status IN (
      'created', 'queued', 'dispatching', 'running', 'waiting_approval',
      'retry_wait', 'lost', 'succeeded', 'failed', 'cancelled', 'timed_out'
    )),
  version integer NOT NULL DEFAULT 0
    CONSTRAINT ql3_runs_version_check
    CHECK (version >= 0),
  event_sequence integer NOT NULL DEFAULT 0
    CONSTRAINT ql3_runs_event_sequence_check
    CHECK (event_sequence >= 0),
  priority integer NOT NULL DEFAULT 0,
  idempotency_key varchar(255),
  input_ref varchar(512),
  output_ref varchar(512),
  created_at_ms bigint NOT NULL
    CONSTRAINT ql3_runs_created_at_check
    CHECK (created_at_ms >= 0),
  queued_at_ms bigint
    CONSTRAINT ql3_runs_queued_at_check
    CHECK (queued_at_ms IS NULL OR queued_at_ms >= 0),
  started_at_ms bigint
    CONSTRAINT ql3_runs_started_at_check
    CHECK (started_at_ms IS NULL OR started_at_ms >= 0),
  finished_at_ms bigint
    CONSTRAINT ql3_runs_finished_at_check
    CHECK (finished_at_ms IS NULL OR finished_at_ms >= 0),
  cancel_requested_at_ms bigint
    CONSTRAINT ql3_runs_cancel_requested_at_check
    CHECK (cancel_requested_at_ms IS NULL OR cancel_requested_at_ms >= 0),
  cancel_reason varchar(16)
    CONSTRAINT ql3_runs_cancel_reason_check
    CHECK (cancel_reason IS NULL OR cancel_reason IN (
      'user', 'policy', 'shutdown', 'reconcile', 'timeout'
    )),
  error_code varchar(128),
  error_summary varchar(1024),
  CONSTRAINT ql3_runs_parent_fk
    FOREIGN KEY (parent_run_id) REFERENCES "ql3"."${POSTGRESQL_RUN_TABLE}" (id),
  CONSTRAINT ql3_runs_retry_of_fk
    FOREIGN KEY (retry_of_run_id) REFERENCES "ql3"."${POSTGRESQL_RUN_TABLE}" (id)
)
    `.trim(),
    `
CREATE UNIQUE INDEX ql3_runs_project_idempotency_uidx
ON "ql3"."${POSTGRESQL_RUN_TABLE}" (project_id, idempotency_key)
WHERE idempotency_key IS NOT NULL
    `.trim(),
    `
CREATE INDEX ql3_runs_project_created_idx
ON "ql3"."${POSTGRESQL_RUN_TABLE}" (project_id, created_at_ms, id)
    `.trim(),
    `
CREATE INDEX ql3_runs_task_created_idx
ON "ql3"."${POSTGRESQL_RUN_TABLE}" (task_id, created_at_ms, id)
    `.trim(),
    `
CREATE INDEX ql3_runs_dispatch_candidates_idx
ON "ql3"."${POSTGRESQL_RUN_TABLE}" (priority DESC, queued_at_ms, id)
WHERE execution_owner = 'runtime'
  AND status IN ('queued', 'dispatching')
  AND cancel_requested_at_ms IS NULL
  AND queued_at_ms IS NOT NULL
    `.trim(),
    `
CREATE TABLE "ql3"."${POSTGRESQL_RUN_ATTEMPT_TABLE}" (
  id varchar(36) PRIMARY KEY,
  run_id varchar(36) NOT NULL,
  step_run_id varchar(36),
  attempt integer NOT NULL
    CONSTRAINT ql3_run_attempts_attempt_check
    CHECK (attempt >= 1),
  status varchar(32) NOT NULL
    CONSTRAINT ql3_run_attempts_status_check
    CHECK (status IN (
      'claimed', 'starting', 'running', 'succeeded', 'failed',
      'cancelled', 'timed_out', 'lost'
    )),
  executor_type varchar(64) NOT NULL,
  worker_id varchar(128),
  executor_handle varchar(2048),
  pid integer
    CONSTRAINT ql3_run_attempts_pid_check
    CHECK (pid IS NULL OR pid >= 1),
  log_artifact_id varchar(36),
  lease_token varchar(128),
  lease_expires_at_ms bigint
    CONSTRAINT ql3_run_attempts_lease_expiry_check
    CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
  deadline_at_ms bigint
    CONSTRAINT ql3_run_attempts_deadline_check
    CHECK (deadline_at_ms IS NULL OR deadline_at_ms >= 0),
  callback_token_hash varchar(128),
  callback_sequence integer NOT NULL DEFAULT 0
    CONSTRAINT ql3_run_attempts_callback_sequence_check
    CHECK (callback_sequence >= 0),
  created_at_ms bigint NOT NULL
    CONSTRAINT ql3_run_attempts_created_at_check
    CHECK (created_at_ms >= 0),
  started_at_ms bigint
    CONSTRAINT ql3_run_attempts_started_at_check
    CHECK (started_at_ms IS NULL OR started_at_ms >= 0),
  finished_at_ms bigint
    CONSTRAINT ql3_run_attempts_finished_at_check
    CHECK (finished_at_ms IS NULL OR finished_at_ms >= 0),
  exit_code integer,
  error_code varchar(128),
  error_summary varchar(1024),
  CONSTRAINT ql3_run_attempts_run_fk
    FOREIGN KEY (run_id) REFERENCES "ql3"."${POSTGRESQL_RUN_TABLE}" (id)
)
    `.trim(),
    `
CREATE UNIQUE INDEX ql3_run_attempts_run_attempt_uidx
ON "ql3"."${POSTGRESQL_RUN_ATTEMPT_TABLE}" (run_id, attempt)
    `.trim(),
    `
CREATE INDEX ql3_run_attempts_dispatch_candidates_idx
ON "ql3"."${POSTGRESQL_RUN_ATTEMPT_TABLE}" (status, run_id, created_at_ms, id)
    `.trim(),
    `
CREATE INDEX ql3_run_attempts_lease_idx
ON "ql3"."${POSTGRESQL_RUN_ATTEMPT_TABLE}" (lease_expires_at_ms, id)
WHERE lease_expires_at_ms IS NOT NULL
    `.trim(),
    `
CREATE TABLE "ql3"."${POSTGRESQL_RUN_EVENT_TABLE}" (
  id varchar(36) PRIMARY KEY,
  run_id varchar(36) NOT NULL,
  sequence integer NOT NULL
    CONSTRAINT ql3_run_events_sequence_check
    CHECK (sequence >= 1),
  type varchar(128) NOT NULL,
  dedupe_key varchar(255),
  actor_type varchar(64) NOT NULL
    CONSTRAINT ql3_run_events_actor_type_check
    CHECK (actor_type IN (
      'user', 'api_app', 'trigger', 'agent', 'mcp_client', 'worker',
      'executor', 'system', 'legacy_shell', 'scheduler', 'reconciler',
      'compatibility'
    )),
  actor_id varchar(255),
  attempt_id varchar(36),
  step_run_id varchar(36),
  payload jsonb NOT NULL
    CONSTRAINT ql3_run_events_payload_check
    CHECK (jsonb_typeof(payload) = 'object'),
  created_at_ms bigint NOT NULL
    CONSTRAINT ql3_run_events_created_at_check
    CHECK (created_at_ms >= 0),
  CONSTRAINT ql3_run_events_run_fk
    FOREIGN KEY (run_id) REFERENCES "ql3"."${POSTGRESQL_RUN_TABLE}" (id),
  CONSTRAINT ql3_run_events_attempt_fk
    FOREIGN KEY (attempt_id) REFERENCES "ql3"."${POSTGRESQL_RUN_ATTEMPT_TABLE}" (id)
)
    `.trim(),
    `
CREATE UNIQUE INDEX ql3_run_events_run_sequence_uidx
ON "ql3"."${POSTGRESQL_RUN_EVENT_TABLE}" (run_id, sequence)
    `.trim(),
    `
CREATE UNIQUE INDEX ql3_run_events_run_dedupe_uidx
ON "ql3"."${POSTGRESQL_RUN_EVENT_TABLE}" (run_id, dedupe_key)
WHERE dedupe_key IS NOT NULL
    `.trim(),
    `
CREATE INDEX ql3_run_events_run_created_idx
ON "ql3"."${POSTGRESQL_RUN_EVENT_TABLE}" (run_id, created_at_ms, id)
    `.trim(),
    `
INSERT INTO "ql3"."schema_capabilities" (
  contract_name,
  contract_version,
  migration_id,
  capabilities,
  updated_at_ms
)
VALUES (
  'control-core',
  1,
  'pg-0002-run-core',
  '{"run_core":1}'::jsonb,
  floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
)
ON CONFLICT (contract_name) DO UPDATE
SET contract_version = EXCLUDED.contract_version,
    migration_id = EXCLUDED.migration_id,
    capabilities = EXCLUDED.capabilities,
    updated_at_ms = EXCLUDED.updated_at_ms
WHERE "schema_capabilities".contract_version < EXCLUDED.contract_version
    `.trim(),
  ],
});
