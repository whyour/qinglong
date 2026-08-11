import { defineLocalSqliteMigration } from './sqlMigration';

export const local0063ToolExecutionFailureCompletionsMigration =
  defineLocalSqliteMigration({
    id: '0063-tool-execution-failure-completions',
    statements: [
      `
CREATE TABLE "ToolExecutionFailureCompletions" (
  start_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  started_step_run_version INTEGER NOT NULL,
  completed_step_run_version INTEGER NOT NULL,
  barrier_digest TEXT NOT NULL,
  adapter_digest TEXT NOT NULL,
  outcome TEXT NOT NULL,
  result_code TEXT NOT NULL,
  error_summary TEXT NOT NULL,
  step_run_mutation_id TEXT NOT NULL,
  step_run_mutation_digest TEXT NOT NULL,
  completed_step_run_digest TEXT NOT NULL,
  run_event_id TEXT NOT NULL,
  completed_at_ms INTEGER NOT NULL,
  completion_digest TEXT NOT NULL,
  completion_json TEXT NOT NULL,
  CONSTRAINT ql3_tool_failure_completion_start_fk
    FOREIGN KEY (start_id)
    REFERENCES "ToolExecutionStartBarriers" (start_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_failure_completion_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "StepRuns" (run_id, id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_failure_completion_mutation_fk
    FOREIGN KEY (step_run_mutation_id)
    REFERENCES "StepRunMutations" (mutation_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_failure_completion_event_fk
    FOREIGN KEY (run_event_id)
    REFERENCES "RunEvents" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_failure_completion_identity_check CHECK (
    length(start_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(step_run_id) BETWEEN 1 AND 128 AND
    length(step_run_mutation_id) BETWEEN 1 AND 128 AND
    length(run_event_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_tool_failure_completion_version_check CHECK (
    started_step_run_version BETWEEN 2 AND 2147483646 AND
    completed_step_run_version = started_step_run_version + 1
  ),
  CONSTRAINT ql3_tool_failure_completion_digest_check CHECK (
    length(barrier_digest) = 64 AND
      barrier_digest NOT GLOB '*[^0-9a-f]*' AND
    length(adapter_digest) = 64 AND
      adapter_digest NOT GLOB '*[^0-9a-f]*' AND
    length(step_run_mutation_digest) = 64 AND
      step_run_mutation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(completed_step_run_digest) = 64 AND
      completed_step_run_digest NOT GLOB '*[^0-9a-f]*' AND
    length(completion_digest) = 64 AND
      completion_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_tool_failure_completion_fact_check CHECK (
    (
      outcome = 'failed' AND
      result_code = 'tool_adapter_failed' AND
      error_summary = 'Trusted Tool execution failed'
    ) OR (
      outcome = 'timed_out' AND
      result_code = 'tool_deadline_exceeded' AND
      error_summary = 'Trusted Tool execution deadline exceeded'
    )
  ),
  CONSTRAINT ql3_tool_failure_completion_budget_check CHECK (
    completed_at_ms >= 0 AND
    length(CAST(completion_json AS BLOB)) BETWEEN 2 AND 24576
  ),
  CONSTRAINT ql3_tool_failure_completion_json_check CHECK (
    json_valid(completion_json) AND
    json_type(completion_json) = 'object' AND
    json_extract(completion_json, '$.schema') =
      'qinglong/tool-execution-failure-completion@v1' AND
    json_extract(completion_json, '$.startId') = start_id AND
    json_extract(completion_json, '$.projectId') = project_id AND
    json_extract(completion_json, '$.runId') = run_id AND
    json_extract(completion_json, '$.stepRunId') = step_run_id AND
    json_extract(completion_json, '$.startedStepRunVersion') =
      started_step_run_version AND
    json_extract(completion_json, '$.completedStepRunVersion') =
      completed_step_run_version AND
    json_extract(completion_json, '$.barrierDigest') = barrier_digest AND
    json_extract(completion_json, '$.adapterDigest') = adapter_digest AND
    json_extract(completion_json, '$.outcome') = outcome AND
    json_extract(completion_json, '$.resultCode') = result_code AND
    json_extract(completion_json, '$.errorSummary') = error_summary AND
    json_extract(completion_json, '$.stepRunMutationId') =
      step_run_mutation_id AND
    json_extract(completion_json, '$.stepRunMutationDigest') =
      step_run_mutation_digest AND
    json_extract(completion_json, '$.completedStepRunDigest') =
      completed_step_run_digest AND
    json_extract(completion_json, '$.runEventId') = run_event_id AND
    json_extract(completion_json, '$.completedAtMs') = completed_at_ms AND
    json_extract(completion_json, '$.completionDigest') = completion_digest
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_tool_failure_completion_mutation_uidx ON "ToolExecutionFailureCompletions" (step_run_mutation_id)`,
      `CREATE UNIQUE INDEX ql3_tool_failure_completion_event_uidx ON "ToolExecutionFailureCompletions" (run_event_id)`,
      `CREATE UNIQUE INDEX ql3_tool_failure_completion_step_version_uidx ON "ToolExecutionFailureCompletions" (run_id, step_run_id, completed_step_run_version)`,
      `CREATE INDEX ql3_tool_failure_completion_project_time_idx ON "ToolExecutionFailureCompletions" (project_id, completed_at_ms, start_id)`,
    ],
  });
