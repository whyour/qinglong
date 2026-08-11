import { defineLocalSqliteMigration } from './sqlMigration';

export const local0055ToolExecutionStartBarriersMigration =
  defineLocalSqliteMigration({
    id: '0055-tool-execution-start-barriers',
    statements: [
      `
CREATE TABLE "ToolExecutionStartBarriers" (
  start_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  started_step_run_version INTEGER NOT NULL,
  step_run_mutation_id TEXT NOT NULL,
  run_event_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  barrier_digest TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  barrier_json TEXT NOT NULL,
  CONSTRAINT ql3_tool_start_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "StepRuns" (run_id, id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_mutation_fk
    FOREIGN KEY (step_run_mutation_id)
    REFERENCES "StepRunMutations" (mutation_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_event_fk
    FOREIGN KEY (run_event_id)
    REFERENCES "RunEvents" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_trace_fk
    FOREIGN KEY (trace_id, span_id)
    REFERENCES "ToolExecutionTraceAnchors" (trace_id, span_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_audit_fk
    FOREIGN KEY (audit_event_id)
    REFERENCES "ToolExecutionAuditReceipts" (event_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_identity_check CHECK (
    length(start_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(step_run_id) BETWEEN 1 AND 128 AND
    length(step_run_mutation_id) BETWEEN 1 AND 128 AND
    length(run_event_id) BETWEEN 1 AND 128 AND
    length(trace_id) = 32 AND trace_id NOT GLOB '*[^0-9a-f]*' AND
    length(span_id) = 16 AND span_id NOT GLOB '*[^0-9a-f]*' AND
    length(audit_event_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_tool_start_version_time_check CHECK (
    started_step_run_version BETWEEN 2 AND 2147483647 AND
    started_at_ms >= 0
  ),
  CONSTRAINT ql3_tool_start_digest_check CHECK (
    length(command_digest) = 64 AND
      command_digest NOT GLOB '*[^0-9a-f]*' AND
    length(barrier_digest) = 64 AND
      barrier_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_tool_start_json_check CHECK (
    length(CAST(barrier_json AS BLOB)) BETWEEN 2 AND 16384 AND
    json_valid(barrier_json) AND json_type(barrier_json) = 'object' AND
    json_extract(barrier_json, '$.schema') =
      'qinglong/tool-execution-start-barrier@v1' AND
    json_extract(barrier_json, '$.startId') = start_id AND
    json_extract(barrier_json, '$.projectId') = project_id AND
    json_extract(barrier_json, '$.runId') = run_id AND
    json_extract(barrier_json, '$.stepRunId') = step_run_id AND
    json_extract(barrier_json, '$.startedStepRunVersion') IS
      started_step_run_version AND
    json_extract(barrier_json, '$.stepRunMutationId') =
      step_run_mutation_id AND
    json_extract(barrier_json, '$.runEventId') = run_event_id AND
    json_extract(barrier_json, '$.traceId') = trace_id AND
    json_extract(barrier_json, '$.spanId') = span_id AND
    json_extract(barrier_json, '$.auditEventId') = audit_event_id AND
    json_extract(barrier_json, '$.commandDigest') = command_digest AND
    json_extract(barrier_json, '$.barrierDigest') = barrier_digest AND
    json_extract(barrier_json, '$.startedAtMs') IS started_at_ms
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_tool_start_step_version_uidx ON "ToolExecutionStartBarriers" (run_id, step_run_id, started_step_run_version)`,
      `CREATE UNIQUE INDEX ql3_tool_start_mutation_uidx ON "ToolExecutionStartBarriers" (step_run_mutation_id)`,
      `CREATE UNIQUE INDEX ql3_tool_start_event_uidx ON "ToolExecutionStartBarriers" (run_event_id)`,
      `CREATE UNIQUE INDEX ql3_tool_start_trace_uidx ON "ToolExecutionStartBarriers" (trace_id, span_id)`,
      `CREATE UNIQUE INDEX ql3_tool_start_audit_uidx ON "ToolExecutionStartBarriers" (audit_event_id)`,
      `CREATE INDEX ql3_tool_start_run_time_idx ON "ToolExecutionStartBarriers" (run_id, started_at_ms, start_id)`,
    ],
  });
