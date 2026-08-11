import { defineLocalSqliteMigration } from './sqlMigration';
import { LOCAL_STEP_RUN_REFERENCE_TRIGGERS } from '../run/stepRunSchemaContract';

export const local0051StepRunsMigration = defineLocalSqliteMigration({
  id: '0051-step-runs',
  statements: [
    `
CREATE TEMP TABLE "QingLong3StepRunReferenceUpgradeGuard" (
  valid INTEGER NOT NULL CHECK (valid = 1)
)
    `,
    `
INSERT INTO "QingLong3StepRunReferenceUpgradeGuard" (valid)
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM "RunAttempts" WHERE step_run_id IS NOT NULL
    UNION ALL
    SELECT 1 FROM "RunEvents" WHERE step_run_id IS NOT NULL
  ) THEN 0
  ELSE 1
END
    `,
    `DROP TABLE "QingLong3StepRunReferenceUpgradeGuard"`,
    `
CREATE TABLE "StepRuns" (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  parent_step_run_id TEXT,
  step_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  definition_ref TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  required INTEGER NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  input_ref TEXT,
  output_ref TEXT,
  approval_request_id TEXT,
  ready_at_ms INTEGER,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  result_code TEXT,
  error_summary TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  last_mutation_id TEXT NOT NULL,
  step_run_digest TEXT NOT NULL,
  step_run_json TEXT NOT NULL,
  CONSTRAINT ql3_step_runs_run_fk
    FOREIGN KEY (run_id) REFERENCES "Runs" (id) ON DELETE CASCADE,
  CONSTRAINT ql3_step_runs_parent_fk
    FOREIGN KEY (run_id, parent_step_run_id)
    REFERENCES "StepRuns" (run_id, id) ON DELETE RESTRICT,
  CONSTRAINT ql3_step_runs_identity_check CHECK (
    length(id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    (parent_step_run_id IS NULL OR
      (length(parent_step_run_id) BETWEEN 1 AND 128 AND
       parent_step_run_id <> id)) AND
    length(step_key) BETWEEN 1 AND 128 AND
    length(CAST(definition_ref AS BLOB)) BETWEEN 1 AND 512
  ),
  CONSTRAINT ql3_step_runs_kind_check CHECK (
    kind IN (
      'task', 'tool', 'model', 'agent', 'condition', 'approval',
      'subworkflow'
    )
  ),
  CONSTRAINT ql3_step_runs_status_check CHECK (
    status IN (
      'pending', 'ready', 'waiting_approval', 'running', 'lost',
      'succeeded', 'failed', 'skipped', 'cancelled', 'timed_out'
    )
  ),
  CONSTRAINT ql3_step_runs_digest_check CHECK (
    length(definition_digest) = 64 AND
      definition_digest NOT GLOB '*[^0-9a-f]*' AND
    length(step_run_digest) = 64 AND
      step_run_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_step_runs_counter_check CHECK (
    required IN (0, 1) AND
    version BETWEEN 1 AND 2147483647 AND
    attempt_count BETWEEN 0 AND 64
  ),
  CONSTRAINT ql3_step_runs_reference_check CHECK (
    (input_ref IS NULL OR
      length(CAST(input_ref AS BLOB)) BETWEEN 1 AND 512) AND
    (output_ref IS NULL OR
      length(CAST(output_ref AS BLOB)) BETWEEN 1 AND 512) AND
    (approval_request_id IS NULL OR
      length(approval_request_id) BETWEEN 1 AND 128)
  ),
  CONSTRAINT ql3_step_runs_time_check CHECK (
    created_at_ms >= 0 AND updated_at_ms >= created_at_ms AND
    (ready_at_ms IS NULL OR
      ready_at_ms BETWEEN created_at_ms AND updated_at_ms) AND
    (started_at_ms IS NULL OR
      (ready_at_ms IS NOT NULL AND
       started_at_ms BETWEEN ready_at_ms AND updated_at_ms)) AND
    (finished_at_ms IS NULL OR
      (finished_at_ms BETWEEN created_at_ms AND updated_at_ms AND
       (ready_at_ms IS NULL OR finished_at_ms >= ready_at_ms) AND
       (started_at_ms IS NULL OR finished_at_ms >= started_at_ms)))
  ),
  CONSTRAINT ql3_step_runs_state_shape_check CHECK (
    (status = 'pending' AND ready_at_ms IS NULL AND
      started_at_ms IS NULL AND finished_at_ms IS NULL) OR
    (status IN ('ready', 'waiting_approval') AND ready_at_ms IS NOT NULL AND
      started_at_ms IS NULL AND finished_at_ms IS NULL) OR
    (status IN ('running', 'lost') AND ready_at_ms IS NOT NULL AND
      started_at_ms IS NOT NULL AND finished_at_ms IS NULL) OR
    (status IN ('succeeded', 'failed', 'skipped', 'cancelled', 'timed_out')
      AND finished_at_ms IS NOT NULL)
  ),
  CONSTRAINT ql3_step_runs_result_shape_check CHECK (
    (status = 'waiting_approval' AND approval_request_id IS NOT NULL) OR
    status <> 'waiting_approval'
  ),
  CONSTRAINT ql3_step_runs_result_value_check CHECK (
    (output_ref IS NULL OR status = 'succeeded') AND
    (status = 'succeeded' AND result_code IS NULL AND error_summary IS NULL OR
     status IN ('failed', 'skipped', 'cancelled', 'timed_out', 'lost') AND
       result_code IS NOT NULL OR
     status IN ('pending', 'ready', 'waiting_approval', 'running') AND
       result_code IS NULL AND error_summary IS NULL) AND
    (result_code IS NULL OR
      (length(result_code) BETWEEN 1 AND 64 AND
       result_code NOT GLOB '*[^a-z0-9_]*' AND
       substr(result_code, 1, 1) GLOB '[a-z]')) AND
    (error_summary IS NULL OR
      length(CAST(error_summary AS BLOB)) BETWEEN 1 AND 2048)
  ),
  CONSTRAINT ql3_step_runs_mutation_identity_check CHECK (
    length(last_mutation_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_step_runs_json_check CHECK (
    length(CAST(step_run_json AS BLOB)) BETWEEN 2 AND 16384 AND
    json_valid(step_run_json) AND json_type(step_run_json) = 'object' AND
    json_extract(step_run_json, '$.schema') = 'qinglong/step-run@v1' AND
    json_extract(step_run_json, '$.id') = id AND
    json_extract(step_run_json, '$.runId') = run_id AND
    json_extract(step_run_json, '$.parentStepRunId') IS parent_step_run_id AND
    json_extract(step_run_json, '$.stepKey') = step_key AND
    json_extract(step_run_json, '$.kind') = kind AND
    json_extract(step_run_json, '$.definitionRef') = definition_ref AND
    json_extract(step_run_json, '$.definitionDigest') = definition_digest AND
    json_extract(step_run_json, '$.required') IS required AND
    json_extract(step_run_json, '$.status') = status AND
    json_extract(step_run_json, '$.version') = version AND
    json_extract(step_run_json, '$.attemptCount') IS attempt_count AND
    json_extract(step_run_json, '$.inputRef') IS input_ref AND
    json_extract(step_run_json, '$.outputRef') IS output_ref AND
    json_extract(step_run_json, '$.approvalRequestId') IS
      approval_request_id AND
    json_extract(step_run_json, '$.readyAtMs') IS ready_at_ms AND
    json_extract(step_run_json, '$.startedAtMs') IS started_at_ms AND
    json_extract(step_run_json, '$.finishedAtMs') IS finished_at_ms AND
    json_extract(step_run_json, '$.resultCode') IS result_code AND
    json_extract(step_run_json, '$.errorSummary') IS error_summary AND
    json_extract(step_run_json, '$.createdAtMs') IS created_at_ms AND
    json_extract(step_run_json, '$.updatedAtMs') IS updated_at_ms AND
    json_extract(step_run_json, '$.lastMutationId') = last_mutation_id AND
    json_extract(step_run_json, '$.stepRunDigest') = step_run_digest
  )
)
    `,
    `CREATE UNIQUE INDEX ql3_step_runs_run_id_uidx ON "StepRuns" (run_id, id)`,
    `CREATE UNIQUE INDEX ql3_step_runs_run_step_uidx ON "StepRuns" (run_id, step_key)`,
    `CREATE INDEX ql3_step_runs_run_status_idx ON "StepRuns" (run_id, status, id)`,
    `CREATE INDEX ql3_step_runs_recovery_idx ON "StepRuns" (status, updated_at_ms, id) WHERE status IN ('waiting_approval', 'running', 'lost')`,
    `
CREATE TABLE "StepRunMutations" (
  mutation_id TEXT PRIMARY KEY NOT NULL,
  mutation_digest TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  step_run_digest TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  run_version INTEGER NOT NULL,
  step_run_json TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  CONSTRAINT ql3_step_run_mutations_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "StepRuns" (run_id, id) ON DELETE CASCADE,
  CONSTRAINT ql3_step_run_mutations_event_fk
    FOREIGN KEY (event_id) REFERENCES "RunEvents" (id) ON DELETE CASCADE,
  CONSTRAINT ql3_step_run_mutations_identity_check CHECK (
    length(mutation_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(step_run_id) BETWEEN 1 AND 128 AND
    length(event_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_step_run_mutations_digest_check CHECK (
    length(mutation_digest) = 64 AND
      mutation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(step_run_digest) = 64 AND
      step_run_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_step_run_mutations_counter_check CHECK (
    event_sequence BETWEEN 1 AND 2147483647 AND
    run_version BETWEEN 1 AND 2147483647 AND
    committed_at_ms >= 0
  ),
  CONSTRAINT ql3_step_run_mutations_json_check CHECK (
    length(CAST(step_run_json AS BLOB)) BETWEEN 2 AND 16384 AND
    json_valid(step_run_json) AND json_type(step_run_json) = 'object' AND
    json_extract(step_run_json, '$.schema') = 'qinglong/step-run@v1' AND
    json_extract(step_run_json, '$.id') = step_run_id AND
    json_extract(step_run_json, '$.runId') = run_id AND
    json_extract(step_run_json, '$.lastMutationId') = mutation_id AND
    json_extract(step_run_json, '$.stepRunDigest') = step_run_digest
  )
)
    `,
    `CREATE UNIQUE INDEX ql3_step_run_mutations_event_uidx ON "StepRunMutations" (event_id)`,
    `CREATE INDEX ql3_step_run_mutations_step_idx ON "StepRunMutations" (run_id, step_run_id, event_sequence, mutation_id)`,
    ...LOCAL_STEP_RUN_REFERENCE_TRIGGERS.map((trigger) => trigger.sql),
  ],
});
