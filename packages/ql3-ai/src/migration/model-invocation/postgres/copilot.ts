import type { PostgresQueryable } from '@qinglong/runtime-core';

import {
  POSTGRES_COPILOT_FAILURE_DIAGNOSIS_ADMISSION_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_SCHEMA,
} from '../identities';
import { defineSqlMigration } from '../shared';

const ADMISSION_TABLE = 'copilot_failure_diagnosis_admissions';
const SOURCE_SNAPSHOT_FUNCTION =
  'copilot_failure_diagnosis_admission_source_snapshot';

const POSTGRES_COPILOT_FAILURE_DIAGNOSIS_ADMISSION_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${ADMISSION_TABLE}" (
  request_id varchar(128) PRIMARY KEY,
  plan_digest char(64) NOT NULL UNIQUE,
  run_id varchar(36) NOT NULL UNIQUE,
  project_id varchar(128) NOT NULL,
  source_run_id varchar(36) NOT NULL,
  source_run_version integer NOT NULL,
  source_run_status varchar(32) NOT NULL,
  source_attempt_id varchar(36) NOT NULL,
  source_attempt_status varchar(32) NOT NULL,
  source_log_artifact_id varchar(36) NOT NULL,
  tool_plan_digest char(64) NOT NULL,
  tool_action_digest char(64) NOT NULL,
  tool_step_run_id varchar(128) NOT NULL UNIQUE,
  model_intent_digest char(64) NOT NULL,
  model_step_run_id varchar(128) NOT NULL UNIQUE,
  admitted_at_ms bigint NOT NULL,
  receipt_digest char(64) NOT NULL UNIQUE,
  plan_json jsonb NOT NULL,
  receipt_json jsonb NOT NULL,
  CONSTRAINT ql3_ai_copilot_diagnosis_admission_run_fk
    FOREIGN KEY (run_id) REFERENCES "ql3"."runs" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_copilot_diagnosis_admission_source_run_fk
    FOREIGN KEY (source_run_id) REFERENCES "ql3"."runs" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_copilot_diagnosis_admission_source_attempt_fk
    FOREIGN KEY (source_attempt_id)
    REFERENCES "ql3"."run_attempts" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_copilot_diagnosis_admission_tool_step_fk
    FOREIGN KEY (run_id, tool_step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_copilot_diagnosis_admission_model_step_fk
    FOREIGN KEY (run_id, model_step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_copilot_diagnosis_admission_identity_check CHECK (
    request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    source_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' AND
    source_attempt_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' AND
    source_log_artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' AND
    tool_step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    model_step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    source_run_version BETWEEN 1 AND 2147483647 AND admitted_at_ms >= 0
  ),
  CONSTRAINT ql3_ai_copilot_diagnosis_admission_status_check CHECK (
    source_run_status IN ('failed', 'timed_out') AND
    source_attempt_status IN ('failed', 'timed_out', 'lost') AND
    ((source_run_status = 'failed' AND source_attempt_status IN ('failed', 'lost')) OR
     (source_run_status = 'timed_out' AND source_attempt_status = 'timed_out'))
  ),
  CONSTRAINT ql3_ai_copilot_diagnosis_admission_digest_check CHECK (
    plan_digest ~ '^[0-9a-f]{64}$' AND
    tool_plan_digest ~ '^[0-9a-f]{64}$' AND
    tool_action_digest ~ '^[0-9a-f]{64}$' AND
    model_intent_digest ~ '^[0-9a-f]{64}$' AND
    receipt_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_ai_copilot_diagnosis_admission_json_check CHECK (
    jsonb_typeof(plan_json) = 'object' AND
    octet_length(plan_json::text) BETWEEN 2 AND 32768 AND
    plan_json @> jsonb_build_object(
      'schema', 'qinglong/copilot-failure-diagnosis-execution-plan@v1',
      'requestId', request_id, 'planDigest', plan_digest,
      'runId', run_id, 'projectId', project_id,
      'toolStepRunId', tool_step_run_id,
      'modelStepRunId', model_step_run_id,
      'plannedAtMs', admitted_at_ms
    ) AND
    plan_json -> 'source' @> jsonb_build_object(
      'runId', source_run_id, 'runVersion', source_run_version,
      'runStatus', source_run_status, 'attemptId', source_attempt_id,
      'attemptStatus', source_attempt_status,
      'logArtifactId', source_log_artifact_id
    ) AND
    plan_json -> 'tool' @> jsonb_build_object(
      'planDigest', tool_plan_digest, 'actionDigest', tool_action_digest
    ) AND
    plan_json -> 'model' @> jsonb_build_object(
      'intentDigest', model_intent_digest
    ) AND
    jsonb_typeof(receipt_json) = 'object' AND
    octet_length(receipt_json::text) BETWEEN 2 AND 16384 AND
    receipt_json @> jsonb_build_object(
      'schema', 'qinglong/copilot-failure-diagnosis-admission-receipt@v1',
      'requestId', request_id, 'planDigest', plan_digest,
      'runId', run_id, 'sourceRunId', source_run_id,
      'sourceRunVersion', source_run_version,
      'sourceAttemptId', source_attempt_id,
      'toolStepRunId', tool_step_run_id,
      'modelStepRunId', model_step_run_id,
      'admittedAtMs', admitted_at_ms, 'receiptDigest', receipt_digest
    )
  )
)`;

const POSTGRES_COPILOT_FAILURE_DIAGNOSIS_SOURCE_SNAPSHOT_SQL = `
CREATE FUNCTION
  "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${SOURCE_SNAPSHOT_FUNCTION}"(
    p_project_id varchar,
    p_subject_type varchar,
    p_subject_id varchar,
    p_project_version integer,
    p_binding_version integer,
    p_source_run_id varchar,
    p_source_attempt_id varchar
  )
RETURNS TABLE(
  run_id varchar,
  run_version integer,
  run_status varchar,
  attempt_id varchar,
  attempt_status varchar,
  attempt_finished_at_ms bigint,
  log_artifact_id varchar
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3, ql3_ai
AS $ql3_ai$
BEGIN
  IF NOT pg_has_role(session_user, 'ql3_runtime', 'member') THEN
    RAISE EXCEPTION 'Runtime authority is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM 1
  FROM "ql3"."projects" AS project
  JOIN "ql3"."project_role_bindings" AS binding
    ON binding.project_id = project.id
   AND binding.subject_type = p_subject_type
   AND binding.subject_id = p_subject_id
   AND binding.version = p_binding_version
  WHERE project.id = p_project_id
    AND project.status = 'active'
    AND project.version = p_project_version
    AND binding.state = 'active'
    AND binding.version = (
      SELECT max(candidate.version)
      FROM "ql3"."project_role_bindings" AS candidate
      WHERE candidate.project_id = p_project_id
        AND candidate.subject_type = p_subject_type
        AND candidate.subject_id = p_subject_id
    )
  FOR SHARE OF project, binding;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT source_run.id, source_run.version, source_run.status,
         source_attempt.id, source_attempt.status,
         source_attempt.finished_at_ms, source_attempt.log_artifact_id
  FROM "ql3"."runs" AS source_run
  JOIN "ql3"."run_attempts" AS source_attempt
    ON source_attempt.run_id = source_run.id
  WHERE source_run.id = p_source_run_id
    AND source_run.project_id = p_project_id
    AND source_run.status IN ('failed', 'timed_out')
    AND source_attempt.id = p_source_attempt_id
    AND source_attempt.attempt = (
      SELECT max(candidate.attempt)
      FROM "ql3"."run_attempts" AS candidate
      WHERE candidate.run_id = source_run.id
    )
    AND source_attempt.status IN ('failed', 'timed_out', 'lost')
    AND ((source_run.status = 'failed' AND source_attempt.status IN ('failed', 'lost')) OR
         (source_run.status = 'timed_out' AND source_attempt.status = 'timed_out'))
    AND source_attempt.finished_at_ms IS NOT NULL
    AND source_attempt.log_artifact_id IS NOT NULL
  FOR SHARE OF source_run, source_attempt;
END
$ql3_ai$`;

const postgresCopilotFailureDiagnosisAdmissionMigration =
  defineSqlMigration<PostgresQueryable>(
    POSTGRES_COPILOT_FAILURE_DIAGNOSIS_ADMISSION_MIGRATION_ID,
    [
      POSTGRES_COPILOT_FAILURE_DIAGNOSIS_ADMISSION_TABLE_SQL,
      `CREATE UNIQUE INDEX ql3_ai_copilot_diagnosis_run_steps_uidx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${ADMISSION_TABLE}"
         (run_id, tool_step_run_id, model_step_run_id)`,
      `CREATE INDEX ql3_ai_copilot_diagnosis_source_idx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${ADMISSION_TABLE}"
         (project_id, source_run_id, admitted_at_ms, request_id)`,
      `REVOKE ALL ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${ADMISSION_TABLE}"
       FROM PUBLIC`,
      `GRANT SELECT, INSERT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${ADMISSION_TABLE}"
       TO ql3_runtime`,
      POSTGRES_COPILOT_FAILURE_DIAGNOSIS_SOURCE_SNAPSHOT_SQL,
      `REVOKE ALL ON FUNCTION
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${SOURCE_SNAPSHOT_FUNCTION}"(
           varchar, varchar, varchar, integer, integer, varchar, varchar
         ) FROM PUBLIC`,
      `GRANT EXECUTE ON FUNCTION
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${SOURCE_SNAPSHOT_FUNCTION}"(
           varchar, varchar, varchar, integer, integer, varchar, varchar
         ) TO ql3_runtime`,
    ],
    (context, statement) => context.query(statement).then(() => undefined),
  );

export const postgresCopilotMigrations = Object.freeze([
  postgresCopilotFailureDiagnosisAdmissionMigration,
]);
