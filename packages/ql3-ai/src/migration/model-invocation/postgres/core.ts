import type { PostgresQueryable } from '@qinglong/runtime-core';

import {
  POSTGRES_MODEL_INVOCATION_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_SCHEMA,
} from '../identities';

import { defineSqlMigration } from '../shared';

const POSTGRES_START_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts" (
  invocation_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  run_id varchar(36) NOT NULL,
  step_run_id varchar(128) NOT NULL,
  trace_id varchar(128) NOT NULL,
  provider varchar(128) NOT NULL,
  model varchar(128) NOT NULL,
  policy_revision varchar(128) NOT NULL,
  request_digest varchar(71) NOT NULL,
  input_bytes integer NOT NULL,
  max_output_tokens integer NOT NULL,
  deadline_at_ms bigint NOT NULL,
  admitted_at_ms bigint NOT NULL,
  mutation_id varchar(128) NOT NULL,
  mutation_digest char(64) NOT NULL,
  run_event_id varchar(36) NOT NULL,
  start_digest char(64) NOT NULL,
  record_json jsonb NOT NULL,
  FOREIGN KEY (run_id, step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (mutation_id)
    REFERENCES "ql3"."step_run_mutations" (mutation_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_event_id)
    REFERENCES "ql3"."run_events" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_starts_identity_check CHECK (
    invocation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    trace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_model_invocation_starts_value_check CHECK (
    request_digest ~ '^sha256:[0-9a-f]{64}$' AND
    mutation_digest ~ '^[0-9a-f]{64}$' AND
    start_digest ~ '^[0-9a-f]{64}$' AND
    input_bytes BETWEEN 1 AND 262144 AND
    max_output_tokens BETWEEN 1 AND 32768 AND
    admitted_at_ms >= 0 AND deadline_at_ms > admitted_at_ms
  ),
  CONSTRAINT ql3_model_invocation_starts_json_check CHECK (
    jsonb_typeof(record_json) = 'object' AND
    octet_length(record_json::text) BETWEEN 2 AND 24576 AND
    record_json @> jsonb_build_object(
      'schema', 'qinglong/model-invocation-start@v1',
      'invocationId', invocation_id,
      'projectId', project_id,
      'runId', run_id,
      'stepRunId', step_run_id,
      'traceId', trace_id,
      'provider', provider,
      'model', model,
      'policyRevision', policy_revision,
      'requestDigest', request_digest,
      'inputBytes', input_bytes,
      'maxOutputTokens', max_output_tokens,
      'deadlineAtMs', deadline_at_ms,
      'admittedAtMs', admitted_at_ms,
      'stepRunMutationId', mutation_id,
      'stepRunMutationDigest', mutation_digest,
      'runEventId', run_event_id,
      'startDigest', start_digest
    )
  )
)`;

const POSTGRES_COMPLETION_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions" (
  invocation_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  run_id varchar(36) NOT NULL,
  step_run_id varchar(128) NOT NULL,
  trace_id varchar(128) NOT NULL,
  start_digest char(64) NOT NULL,
  outcome varchar(32) NOT NULL,
  output_bytes integer NOT NULL,
  error_code varchar(64),
  completed_at_ms bigint NOT NULL,
  mutation_id varchar(128) NOT NULL,
  mutation_digest char(64) NOT NULL,
  run_event_id varchar(36) NOT NULL,
  completion_digest char(64) NOT NULL,
  record_json jsonb NOT NULL,
  FOREIGN KEY (invocation_id)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts" (invocation_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (run_id, step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (mutation_id)
    REFERENCES "ql3"."step_run_mutations" (mutation_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_event_id)
    REFERENCES "ql3"."run_events" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_completions_value_check CHECK (
    outcome IN ('succeeded', 'failed', 'timed_out', 'outcome_unknown') AND
    output_bytes BETWEEN 0 AND 1048576 AND completed_at_ms >= 0 AND
    ((outcome = 'succeeded' AND error_code IS NULL) OR
      (outcome <> 'succeeded' AND
       error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')) AND
    start_digest ~ '^[0-9a-f]{64}$' AND
    mutation_digest ~ '^[0-9a-f]{64}$' AND
    completion_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_model_invocation_completions_json_check CHECK (
    jsonb_typeof(record_json) = 'object' AND
    octet_length(record_json::text) BETWEEN 2 AND 24576 AND
    record_json @> jsonb_build_object(
      'schema', 'qinglong/model-invocation-completion@v1',
      'invocationId', invocation_id,
      'projectId', project_id,
      'runId', run_id,
      'stepRunId', step_run_id,
      'traceId', trace_id,
      'startDigest', start_digest,
      'outcome', outcome,
      'outputBytes', output_bytes,
      'errorCode', error_code,
      'completedAtMs', completed_at_ms,
      'stepRunMutationId', mutation_id,
      'stepRunMutationDigest', mutation_digest,
      'runEventId', run_event_id,
      'completionDigest', completion_digest
    )
  )
)`;

const POSTGRES_RESOLUTION_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_resolutions" (
  resolution_id varchar(128) PRIMARY KEY,
  invocation_id varchar(128) NOT NULL UNIQUE,
  project_id varchar(128) NOT NULL,
  run_id varchar(36) NOT NULL,
  step_run_id varchar(128) NOT NULL,
  trace_id varchar(128) NOT NULL,
  completion_digest char(64) NOT NULL,
  decision varchar(16) NOT NULL,
  resolved_by_user_id varchar(128) NOT NULL,
  resolved_at_ms bigint NOT NULL,
  mutation_id varchar(128) NOT NULL UNIQUE,
  mutation_digest char(64) NOT NULL,
  run_event_id varchar(36) NOT NULL UNIQUE,
  resolution_digest char(64) NOT NULL UNIQUE,
  record_json jsonb NOT NULL,
  FOREIGN KEY (invocation_id)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions" (invocation_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (run_id, step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (mutation_id)
    REFERENCES "ql3"."step_run_mutations" (mutation_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_event_id)
    REFERENCES "ql3"."run_events" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_invocation_resolutions_value_check CHECK (
    decision IN ('retry', 'fail', 'cancel') AND
    resolved_at_ms >= 0 AND
    resolution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    invocation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    trace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    resolved_by_user_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    completion_digest ~ '^[0-9a-f]{64}$' AND
    mutation_digest ~ '^[0-9a-f]{64}$' AND
    resolution_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_model_invocation_resolutions_json_check CHECK (
    jsonb_typeof(record_json) = 'object' AND
    octet_length(record_json::text) BETWEEN 2 AND 24576 AND
    record_json @> jsonb_build_object(
      'schema', 'qinglong/model-invocation-resolution@v1',
      'resolutionId', resolution_id,
      'invocationId', invocation_id,
      'projectId', project_id,
      'runId', run_id,
      'stepRunId', step_run_id,
      'traceId', trace_id,
      'completionDigest', completion_digest,
      'decision', decision,
      'resolvedByUserId', resolved_by_user_id,
      'resolvedAtMs', resolved_at_ms,
      'stepRunMutationId', mutation_id,
      'stepRunMutationDigest', mutation_digest,
      'runEventId', run_event_id,
      'resolutionDigest', resolution_digest
    )
  )
)`;

const postgresMigration = defineSqlMigration<PostgresQueryable>(
  POSTGRES_MODEL_INVOCATION_MIGRATION_ID,
  [
    POSTGRES_START_TABLE_SQL,
    `CREATE INDEX ql3_model_invocation_starts_step_history_idx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts"
       (run_id, step_run_id, admitted_at_ms, invocation_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_starts_mutation_uidx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts" (mutation_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_starts_event_uidx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts" (run_event_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_starts_digest_uidx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts" (start_digest)`,
    POSTGRES_COMPLETION_TABLE_SQL,
    `CREATE INDEX ql3_model_invocation_completions_step_history_idx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions"
       (run_id, step_run_id, completed_at_ms, invocation_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_completions_mutation_uidx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions" (mutation_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_completions_event_uidx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions" (run_event_id)`,
    `CREATE UNIQUE INDEX ql3_model_invocation_completions_digest_uidx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions" (completion_digest)`,
    POSTGRES_RESOLUTION_TABLE_SQL,
    `CREATE INDEX ql3_model_invocation_resolutions_step_history_idx
       ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_resolutions"
       (run_id, step_run_id, resolved_at_ms, resolution_id)`,
    `GRANT USAGE ON SCHEMA "${POSTGRES_MODEL_INVOCATION_SCHEMA}"
     TO ql3_runtime`,
    `REVOKE ALL ON TABLE
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts",
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions",
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_resolutions"
     FROM PUBLIC`,
    `GRANT SELECT, INSERT ON TABLE
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts",
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions",
       "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_resolutions"
     TO ql3_runtime`,
  ],
  (context, statement) => context.query(statement).then(() => undefined),
);

export const postgresCoreMigrations = Object.freeze([
  postgresMigration,
]);
