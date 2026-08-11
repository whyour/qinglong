import type { LocalMigrationContext } from './context';

import {
  LOCAL_MODEL_INVOCATION_MIGRATION_ID,
} from '../identities';

import { defineSqlMigration } from '../shared';

const LOCAL_START_TABLE_SQL = `
CREATE TABLE "ModelInvocationStarts" (
  invocation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  input_bytes INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  deadline_at_ms INTEGER NOT NULL,
  admitted_at_ms INTEGER NOT NULL,
  mutation_id TEXT NOT NULL,
  mutation_digest TEXT NOT NULL,
  run_event_id TEXT NOT NULL,
  start_digest TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (run_id, step_run_id)
    REFERENCES "StepRuns" (run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (mutation_id)
    REFERENCES "StepRunMutations" (mutation_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_event_id)
    REFERENCES "RunEvents" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_starts_identity_check CHECK (
    length(invocation_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(step_run_id) BETWEEN 1 AND 128 AND
    length(trace_id) BETWEEN 1 AND 128 AND
    length(provider) BETWEEN 1 AND 128 AND
    length(model) BETWEEN 1 AND 128 AND
    length(policy_revision) BETWEEN 1 AND 128 AND
    length(mutation_id) BETWEEN 1 AND 128 AND
    length(run_event_id) BETWEEN 1 AND 36
  ),
  CONSTRAINT ql3_model_invocation_starts_digest_check CHECK (
    length(request_digest) = 71 AND
      substr(request_digest, 1, 7) = 'sha256:' AND
      substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*' AND
    length(mutation_digest) = 64 AND
      mutation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(start_digest) = 64 AND
      start_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_model_invocation_starts_budget_check CHECK (
    input_bytes BETWEEN 1 AND 262144 AND
    max_output_tokens BETWEEN 1 AND 32768 AND
    admitted_at_ms >= 0 AND deadline_at_ms > admitted_at_ms
  ),
  CONSTRAINT ql3_model_invocation_starts_json_check CHECK (
    length(CAST(record_json AS BLOB)) BETWEEN 2 AND 24576 AND
    json_valid(record_json) AND json_type(record_json) = 'object' AND
    json_extract(record_json, '$.schema') =
      'qinglong/model-invocation-start@v1' AND
    json_extract(record_json, '$.invocationId') = invocation_id AND
    json_extract(record_json, '$.projectId') = project_id AND
    json_extract(record_json, '$.runId') = run_id AND
    json_extract(record_json, '$.stepRunId') = step_run_id AND
    json_extract(record_json, '$.traceId') = trace_id AND
    json_extract(record_json, '$.provider') = provider AND
    json_extract(record_json, '$.model') = model AND
    json_extract(record_json, '$.policyRevision') = policy_revision AND
    json_extract(record_json, '$.requestDigest') = request_digest AND
    json_extract(record_json, '$.inputBytes') = input_bytes AND
    json_extract(record_json, '$.maxOutputTokens') = max_output_tokens AND
    json_extract(record_json, '$.deadlineAtMs') = deadline_at_ms AND
    json_extract(record_json, '$.admittedAtMs') = admitted_at_ms AND
    json_extract(record_json, '$.stepRunMutationId') = mutation_id AND
    json_extract(record_json, '$.stepRunMutationDigest') = mutation_digest AND
    json_extract(record_json, '$.runEventId') = run_event_id AND
    json_extract(record_json, '$.startDigest') = start_digest
  )
)`;

const LOCAL_COMPLETION_TABLE_SQL = `
CREATE TABLE "ModelInvocationCompletions" (
  invocation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  start_digest TEXT NOT NULL,
  outcome TEXT NOT NULL,
  output_bytes INTEGER NOT NULL,
  error_code TEXT,
  completed_at_ms INTEGER NOT NULL,
  mutation_id TEXT NOT NULL,
  mutation_digest TEXT NOT NULL,
  run_event_id TEXT NOT NULL,
  completion_digest TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (invocation_id)
    REFERENCES "ModelInvocationStarts" (invocation_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, step_run_id)
    REFERENCES "StepRuns" (run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (mutation_id)
    REFERENCES "StepRunMutations" (mutation_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_event_id)
    REFERENCES "RunEvents" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_completions_outcome_check CHECK (
    outcome IN ('succeeded', 'failed', 'timed_out', 'outcome_unknown')
  ),
  CONSTRAINT ql3_model_invocation_completions_value_check CHECK (
    output_bytes BETWEEN 0 AND 1048576 AND completed_at_ms >= 0 AND
    ((outcome = 'succeeded' AND error_code IS NULL) OR
      (outcome <> 'succeeded' AND
       length(error_code) BETWEEN 1 AND 64 AND
       substr(error_code, 1, 1) GLOB '[A-Z]' AND
       error_code NOT GLOB '*[^A-Z0-9_]*')) AND
    length(start_digest) = 64 AND
      start_digest NOT GLOB '*[^0-9a-f]*' AND
    length(mutation_digest) = 64 AND
      mutation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(completion_digest) = 64 AND
      completion_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_model_invocation_completions_json_check CHECK (
    length(CAST(record_json AS BLOB)) BETWEEN 2 AND 24576 AND
    json_valid(record_json) AND json_type(record_json) = 'object' AND
    json_extract(record_json, '$.schema') =
      'qinglong/model-invocation-completion@v1' AND
    json_extract(record_json, '$.invocationId') = invocation_id AND
    json_extract(record_json, '$.projectId') = project_id AND
    json_extract(record_json, '$.runId') = run_id AND
    json_extract(record_json, '$.stepRunId') = step_run_id AND
    json_extract(record_json, '$.traceId') = trace_id AND
    json_extract(record_json, '$.startDigest') = start_digest AND
    json_extract(record_json, '$.outcome') = outcome AND
    json_extract(record_json, '$.outputBytes') = output_bytes AND
    json_extract(record_json, '$.errorCode') IS error_code AND
    json_extract(record_json, '$.completedAtMs') = completed_at_ms AND
    json_extract(record_json, '$.stepRunMutationId') = mutation_id AND
    json_extract(record_json, '$.stepRunMutationDigest') = mutation_digest AND
    json_extract(record_json, '$.runEventId') = run_event_id AND
    json_extract(record_json, '$.completionDigest') = completion_digest
  )
)`;

const LOCAL_RESOLUTION_TABLE_SQL = `
CREATE TABLE "ModelInvocationResolutions" (
  resolution_id TEXT PRIMARY KEY NOT NULL,
  invocation_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  completion_digest TEXT NOT NULL,
  decision TEXT NOT NULL,
  resolved_by_user_id TEXT NOT NULL,
  resolved_at_ms INTEGER NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE,
  mutation_digest TEXT NOT NULL,
  run_event_id TEXT NOT NULL UNIQUE,
  resolution_digest TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL,
  FOREIGN KEY (invocation_id)
    REFERENCES "ModelInvocationCompletions" (invocation_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, step_run_id)
    REFERENCES "StepRuns" (run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (mutation_id)
    REFERENCES "StepRunMutations" (mutation_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_event_id)
    REFERENCES "RunEvents" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_resolutions_value_check CHECK (
    decision IN ('retry', 'fail', 'cancel') AND
    resolved_at_ms >= 0 AND
    length(resolution_id) BETWEEN 1 AND 128 AND
    length(invocation_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(step_run_id) BETWEEN 1 AND 128 AND
    length(trace_id) BETWEEN 1 AND 128 AND
    length(resolved_by_user_id) BETWEEN 1 AND 128 AND
    length(mutation_id) BETWEEN 1 AND 128 AND
    length(run_event_id) BETWEEN 1 AND 36 AND
    length(completion_digest) = 64 AND
      completion_digest NOT GLOB '*[^0-9a-f]*' AND
    length(mutation_digest) = 64 AND
      mutation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(resolution_digest) = 64 AND
      resolution_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_model_invocation_resolutions_json_check CHECK (
    length(CAST(record_json AS BLOB)) BETWEEN 2 AND 24576 AND
    json_valid(record_json) AND json_type(record_json) = 'object' AND
    json_extract(record_json, '$.schema') =
      'qinglong/model-invocation-resolution@v1' AND
    json_extract(record_json, '$.resolutionId') = resolution_id AND
    json_extract(record_json, '$.invocationId') = invocation_id AND
    json_extract(record_json, '$.projectId') = project_id AND
    json_extract(record_json, '$.runId') = run_id AND
    json_extract(record_json, '$.stepRunId') = step_run_id AND
    json_extract(record_json, '$.traceId') = trace_id AND
    json_extract(record_json, '$.completionDigest') = completion_digest AND
    json_extract(record_json, '$.decision') = decision AND
    json_extract(record_json, '$.resolvedByUserId') = resolved_by_user_id AND
    json_extract(record_json, '$.resolvedAtMs') = resolved_at_ms AND
    json_extract(record_json, '$.stepRunMutationId') = mutation_id AND
    json_extract(record_json, '$.stepRunMutationDigest') = mutation_digest AND
    json_extract(record_json, '$.runEventId') = run_event_id AND
    json_extract(record_json, '$.resolutionDigest') = resolution_digest
  )
)`;

const localMigration = defineSqlMigration<LocalMigrationContext>(
  LOCAL_MODEL_INVOCATION_MIGRATION_ID,
  [
    LOCAL_START_TABLE_SQL,
    `CREATE INDEX ql3_model_invocation_starts_step_history_idx
       ON "ModelInvocationStarts"
       (run_id, step_run_id, admitted_at_ms, invocation_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_starts_mutation_uidx
       ON "ModelInvocationStarts" (mutation_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_starts_event_uidx
       ON "ModelInvocationStarts" (run_event_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_starts_digest_uidx
       ON "ModelInvocationStarts" (start_digest)`,
    LOCAL_COMPLETION_TABLE_SQL,
    `CREATE INDEX ql3_model_invocation_completions_step_history_idx
       ON "ModelInvocationCompletions"
       (run_id, step_run_id, completed_at_ms, invocation_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_completions_mutation_uidx
       ON "ModelInvocationCompletions" (mutation_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_completions_event_uidx
       ON "ModelInvocationCompletions" (run_event_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_completions_digest_uidx
       ON "ModelInvocationCompletions" (completion_digest)`,
    LOCAL_RESOLUTION_TABLE_SQL,
    `CREATE INDEX ql3_model_invocation_resolutions_step_history_idx
       ON "ModelInvocationResolutions"
       (run_id, step_run_id, resolved_at_ms, resolution_id)`,
  ],
  (context, statement) => context.client.exec(statement),
);

export const sqliteCoreMigrations = Object.freeze([
  localMigration,
]);
