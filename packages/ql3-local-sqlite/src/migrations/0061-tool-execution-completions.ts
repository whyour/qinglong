import { defineLocalSqliteMigration } from './sqlMigration';

export const local0061ToolExecutionCompletionsMigration =
  defineLocalSqliteMigration({
    id: '0061-tool-execution-completions',
    statements: [
      `
CREATE TABLE "ToolExecutionCompletions" (
  start_id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  started_step_run_version INTEGER NOT NULL,
  completed_step_run_version INTEGER NOT NULL,
  barrier_digest TEXT NOT NULL,
  adapter_digest TEXT NOT NULL,
  output_digest TEXT NOT NULL,
  execution_result_digest TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  key_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  plaintext_bytes INTEGER NOT NULL,
  step_run_mutation_id TEXT NOT NULL,
  step_run_mutation_digest TEXT NOT NULL,
  completed_step_run_digest TEXT NOT NULL,
  run_event_id TEXT NOT NULL,
  completed_at_ms INTEGER NOT NULL,
  completion_digest TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  completion_json TEXT NOT NULL,
  CONSTRAINT ql3_tool_completion_start_fk
    FOREIGN KEY (start_id)
    REFERENCES "ToolExecutionStartBarriers" (start_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_completion_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "StepRuns" (run_id, id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_completion_mutation_fk
    FOREIGN KEY (step_run_mutation_id)
    REFERENCES "StepRunMutations" (mutation_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_completion_event_fk
    FOREIGN KEY (run_event_id)
    REFERENCES "RunEvents" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_completion_identity_check CHECK (
    length(start_id) BETWEEN 1 AND 128 AND
    length(artifact_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(step_run_id) BETWEEN 1 AND 128 AND
    length(key_id) BETWEEN 1 AND 128 AND
    length(step_run_mutation_id) BETWEEN 1 AND 128 AND
    length(run_event_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_tool_completion_version_check CHECK (
    started_step_run_version BETWEEN 2 AND 2147483646 AND
    completed_step_run_version = started_step_run_version + 1
  ),
  CONSTRAINT ql3_tool_completion_digest_check CHECK (
    length(barrier_digest) = 64 AND
      barrier_digest NOT GLOB '*[^0-9a-f]*' AND
    length(adapter_digest) = 64 AND
      adapter_digest NOT GLOB '*[^0-9a-f]*' AND
    length(output_digest) = 64 AND
      output_digest NOT GLOB '*[^0-9a-f]*' AND
    length(execution_result_digest) = 64 AND
      execution_result_digest NOT GLOB '*[^0-9a-f]*' AND
    length(artifact_digest) = 64 AND
      artifact_digest NOT GLOB '*[^0-9a-f]*' AND
    length(step_run_mutation_digest) = 64 AND
      step_run_mutation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(completed_step_run_digest) = 64 AND
      completed_step_run_digest NOT GLOB '*[^0-9a-f]*' AND
    length(completion_digest) = 64 AND
      completion_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_tool_completion_budget_check CHECK (
    algorithm = 'aes-256-gcm' AND
    plaintext_bytes BETWEEN 0 AND 262144 AND
    completed_at_ms >= 0 AND
    length(CAST(artifact_json AS BLOB)) BETWEEN 2 AND 393216 AND
    length(CAST(completion_json AS BLOB)) BETWEEN 2 AND 24576
  ),
  CONSTRAINT ql3_tool_completion_json_check CHECK (
    json_valid(artifact_json) AND
    json_type(artifact_json) = 'object' AND
    json_extract(artifact_json, '$.schema') =
      'qinglong/tool-execution-result-artifact@v1' AND
    json_extract(artifact_json, '$.artifactId') = artifact_id AND
    json_extract(artifact_json, '$.projectId') = project_id AND
    json_extract(artifact_json, '$.startId') = start_id AND
    json_extract(artifact_json, '$.runId') = run_id AND
    json_extract(artifact_json, '$.stepRunId') = step_run_id AND
    json_extract(artifact_json, '$.barrierDigest') = barrier_digest AND
    json_extract(artifact_json, '$.adapterDigest') = adapter_digest AND
    json_extract(artifact_json, '$.outputDigest') = output_digest AND
    json_extract(artifact_json, '$.executionResultDigest') =
      execution_result_digest AND
    json_extract(artifact_json, '$.artifactDigest') = artifact_digest AND
    json_extract(artifact_json, '$.keyId') = key_id AND
    json_extract(artifact_json, '$.algorithm') = algorithm AND
    json_extract(artifact_json, '$.plaintextBytes') = plaintext_bytes AND
    json_extract(artifact_json, '$.sealedAtMs') = completed_at_ms AND
    json_valid(completion_json) AND
    json_type(completion_json) = 'object' AND
    json_extract(completion_json, '$.schema') =
      'qinglong/tool-execution-completion@v1' AND
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
    json_extract(completion_json, '$.resultArtifact.artifactId') =
      artifact_id AND
    json_extract(completion_json, '$.resultArtifact.artifactDigest') =
      artifact_digest AND
    json_extract(completion_json, '$.resultArtifact.outputDigest') =
      output_digest AND
    json_extract(
      completion_json, '$.resultArtifact.executionResultDigest'
    ) = execution_result_digest AND
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
      `CREATE UNIQUE INDEX ql3_tool_completion_artifact_uidx ON "ToolExecutionCompletions" (artifact_id)`,
      `CREATE UNIQUE INDEX ql3_tool_completion_mutation_uidx ON "ToolExecutionCompletions" (step_run_mutation_id)`,
      `CREATE UNIQUE INDEX ql3_tool_completion_event_uidx ON "ToolExecutionCompletions" (run_event_id)`,
      `CREATE UNIQUE INDEX ql3_tool_completion_step_version_uidx ON "ToolExecutionCompletions" (run_id, step_run_id, completed_step_run_version)`,
      `CREATE INDEX ql3_tool_completion_project_time_idx ON "ToolExecutionCompletions" (project_id, completed_at_ms, start_id)`,
    ],
  });
