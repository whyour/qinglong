import type { PostgresQueryable } from '@qinglong/runtime-core';

import {
  POSTGRES_PLUGIN_PACKAGE_PROMPT_ADMISSION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_FINALIZATION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_PRODUCT_AUTHORIZATION_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_SCHEMA,
  POSTGRES_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE,
} from '../identities';

import { defineSqlMigration } from '../shared';

const POSTGRES_PLUGIN_PACKAGE_PROMPT_ADMISSION_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_admissions" (
  request_id varchar(128) PRIMARY KEY,
  invocation_id varchar(128) NOT NULL UNIQUE,
  plan_digest char(64) NOT NULL UNIQUE,
  run_id varchar(36) NOT NULL UNIQUE,
  step_run_id varchar(128) NOT NULL UNIQUE,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  installation_id varchar(128) NOT NULL,
  lock_digest char(64) NOT NULL,
  generation integer NOT NULL,
  generation_digest char(64) NOT NULL,
  materialized_revision_digest char(64) NOT NULL,
  publication_digest char(64) NOT NULL,
  prompt_id varchar(128) NOT NULL,
  prompt_definition_digest char(64) NOT NULL,
  parameter_digest char(64) NOT NULL,
  model_request_digest varchar(71) NOT NULL,
  admitted_at_ms bigint NOT NULL,
  receipt_digest char(64) NOT NULL UNIQUE,
  plan_json jsonb NOT NULL,
  receipt_json jsonb NOT NULL,
  CONSTRAINT ql3_ai_prompt_admission_run_fk
    FOREIGN KEY (run_id) REFERENCES "ql3"."runs" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_admission_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_admission_publication_fk
    FOREIGN KEY (publication_digest)
    REFERENCES "ql3"."plugin_package_automation_publications" (
      publication_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_admission_identity_check CHECK (
    request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    invocation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' AND
    step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' AND
    installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    prompt_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    generation BETWEEN 1 AND 2147483647 AND admitted_at_ms >= 0
  ),
  CONSTRAINT ql3_ai_prompt_admission_digest_check CHECK (
    plan_digest ~ '^[0-9a-f]{64}$' AND
    lock_digest ~ '^[0-9a-f]{64}$' AND
    generation_digest ~ '^[0-9a-f]{64}$' AND
    materialized_revision_digest ~ '^[0-9a-f]{64}$' AND
    publication_digest ~ '^[0-9a-f]{64}$' AND
    prompt_definition_digest ~ '^[0-9a-f]{64}$' AND
    parameter_digest ~ '^[0-9a-f]{64}$' AND
    model_request_digest ~ '^sha256:[0-9a-f]{64}$' AND
    receipt_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_ai_prompt_admission_json_check CHECK (
    jsonb_typeof(plan_json) = 'object' AND
    octet_length(plan_json::text) BETWEEN 2 AND 32768 AND
    plan_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-prompt-execution-plan@v1',
      'requestId', request_id, 'invocationId', invocation_id,
      'planDigest', plan_digest, 'runId', run_id, 'stepRunId', step_run_id,
      'parameterDigest', parameter_digest,
      'modelRequestDigest', model_request_digest,
      'plannedAtMs', admitted_at_ms
    ) AND
    plan_json -> 'target' @> jsonb_build_object(
      'projectId', project_id, 'packageName', package_name,
      'installationId', installation_id, 'lockDigest', lock_digest,
      'generation', generation, 'generationDigest', generation_digest,
      'materializedRevisionDigest', materialized_revision_digest,
      'publicationDigest', publication_digest, 'promptId', prompt_id,
      'promptDefinitionDigest', prompt_definition_digest
    ) AND
    jsonb_typeof(receipt_json) = 'object' AND
    octet_length(receipt_json::text) BETWEEN 2 AND 16384 AND
    receipt_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-prompt-admission-receipt@v1',
      'requestId', request_id, 'invocationId', invocation_id,
      'planDigest', plan_digest, 'runId', run_id, 'stepRunId', step_run_id,
      'publicationDigest', publication_digest, 'promptId', prompt_id,
      'admittedAtMs', admitted_at_ms, 'receiptDigest', receipt_digest
    )
  )
)`;

const postgresPluginPackagePromptAdmissionMigration =
  defineSqlMigration<PostgresQueryable>(
    POSTGRES_PLUGIN_PACKAGE_PROMPT_ADMISSION_MIGRATION_ID,
    [
      POSTGRES_PLUGIN_PACKAGE_PROMPT_ADMISSION_TABLE_SQL,
      `CREATE UNIQUE INDEX ql3_ai_prompt_admission_run_step_uidx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_admissions"
         (run_id, step_run_id)`,
      `CREATE INDEX ql3_ai_prompt_admission_target_idx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_admissions"
         (project_id, package_name, admitted_at_ms, request_id)`,
      `REVOKE ALL ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_admissions"
       FROM PUBLIC`,
      `GRANT SELECT, INSERT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_admissions"
       TO ql3_runtime`,
      `CREATE FUNCTION
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."plugin_package_prompt_admission_snapshot"(
           p_project_id varchar,
           p_package_name varchar,
           p_publication_digest char(64),
           p_requested_by_subject_type varchar,
           p_requested_by_subject_id varchar,
           p_project_version integer,
           p_binding_version integer
         )
       RETURNS TABLE(publication_json jsonb, revision_json jsonb)
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
          AND binding.subject_type = p_requested_by_subject_type
          AND binding.subject_id = p_requested_by_subject_id
          AND binding.version = p_binding_version
         WHERE project.id = p_project_id
           AND project.status = 'active'
           AND project.version = p_project_version
           AND binding.state = 'active'
           AND binding.version = (
             SELECT max(candidate.version)
             FROM "ql3"."project_role_bindings" AS candidate
             WHERE candidate.project_id = p_project_id
               AND candidate.subject_type = p_requested_by_subject_type
               AND candidate.subject_id = p_requested_by_subject_id
           )
         FOR SHARE OF project, binding;
         IF NOT FOUND THEN
           RETURN;
         END IF;
         IF NOT "ql3"."plugin_package_automation_start_allowed"(
           p_project_id, p_package_name, p_publication_digest
         ) THEN
           RETURN;
         END IF;
         RETURN QUERY
         SELECT publication.publication_json, revision.revision_json
         FROM "ql3"."plugin_package_automation_publications" AS publication
         JOIN "ql3"."plugin_package_materialized_revisions" AS revision
           ON revision.generation_digest = publication.generation_digest
          AND revision.revision_digest =
            publication.materialized_revision_digest
         WHERE publication.project_id = p_project_id
           AND publication.package_name = p_package_name
           AND publication.publication_digest = p_publication_digest
           AND publication.state = 'active'
         FOR SHARE OF publication, revision;
       END
       $ql3_ai$`,
      `REVOKE ALL ON FUNCTION
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."plugin_package_prompt_admission_snapshot"(
           varchar, varchar, char(64), varchar, varchar, integer, integer
         )
       FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
            ql3_package_executor, ql3_worker_ingress`,
      `GRANT EXECUTE ON FUNCTION
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."plugin_package_prompt_admission_snapshot"(
           varchar, varchar, char(64), varchar, varchar, integer, integer
         )
       TO ql3_runtime`,
    ],
    (context, statement) => context.query(statement).then(() => undefined),
  );

const POSTGRES_PLUGIN_PACKAGE_PROMPT_FINALIZATION_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_finalizations" (
  request_id varchar(128) PRIMARY KEY,
  invocation_id varchar(128) NOT NULL UNIQUE,
  plan_digest char(64) NOT NULL UNIQUE,
  run_id varchar(36) NOT NULL UNIQUE,
  step_run_id varchar(128) NOT NULL UNIQUE,
  terminal_evidence_kind varchar(16) NOT NULL,
  terminal_evidence_digest char(64) NOT NULL UNIQUE,
  final_step_run_digest char(64) NOT NULL,
  run_status varchar(16) NOT NULL,
  event_id varchar(36) NOT NULL UNIQUE,
  final_run_version integer NOT NULL,
  final_run_event_sequence integer NOT NULL,
  finalized_at_ms bigint NOT NULL,
  receipt_digest char(64) NOT NULL UNIQUE,
  receipt_json jsonb NOT NULL,
  CONSTRAINT ql3_ai_prompt_finalization_admission_fk
    FOREIGN KEY (request_id)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_admissions"
      (request_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_finalization_invocation_fk
    FOREIGN KEY (invocation_id)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_admissions"
      (invocation_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_finalization_plan_fk
    FOREIGN KEY (plan_digest)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_admissions"
      (plan_digest) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_finalization_run_fk
    FOREIGN KEY (run_id) REFERENCES "ql3"."runs" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_finalization_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_finalization_event_fk
    FOREIGN KEY (event_id) REFERENCES "ql3"."run_events" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_finalization_identity_check CHECK (
    request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    invocation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' AND
    step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' AND
    terminal_evidence_kind IN ('completion', 'resolution') AND
    run_status IN ('succeeded', 'failed', 'cancelled', 'timed_out') AND
    final_run_version BETWEEN 3 AND 2147483647 AND
    final_run_event_sequence = final_run_version AND finalized_at_ms >= 0
  ),
  CONSTRAINT ql3_ai_prompt_finalization_digest_check CHECK (
    plan_digest ~ '^[0-9a-f]{64}$' AND
    terminal_evidence_digest ~ '^[0-9a-f]{64}$' AND
    final_step_run_digest ~ '^[0-9a-f]{64}$' AND
    receipt_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_ai_prompt_finalization_json_check CHECK (
    jsonb_typeof(receipt_json) = 'object' AND
    octet_length(receipt_json::text) BETWEEN 2 AND 16384 AND
    receipt_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-prompt-finalization-receipt@v1',
      'requestId', request_id, 'invocationId', invocation_id,
      'planDigest', plan_digest, 'runId', run_id, 'stepRunId', step_run_id,
      'terminalEvidenceKind', terminal_evidence_kind,
      'terminalEvidenceDigest', terminal_evidence_digest,
      'finalStepRunDigest', final_step_run_digest, 'runStatus', run_status,
      'eventId', event_id, 'finalRunVersion', final_run_version,
      'finalRunEventSequence', final_run_event_sequence,
      'finalizedAtMs', finalized_at_ms, 'receiptDigest', receipt_digest
    )
  )
)`;

const postgresPluginPackagePromptFinalizationMigration =
  defineSqlMigration<PostgresQueryable>(
    POSTGRES_PLUGIN_PACKAGE_PROMPT_FINALIZATION_MIGRATION_ID,
    [
      POSTGRES_PLUGIN_PACKAGE_PROMPT_FINALIZATION_TABLE_SQL,
      `CREATE UNIQUE INDEX ql3_ai_prompt_finalization_run_step_uidx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_finalizations"
         (run_id, step_run_id)`,
      `CREATE INDEX ql3_ai_prompt_finalization_status_idx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_finalizations"
         (run_status, finalized_at_ms, request_id)`,
      `REVOKE ALL ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_finalizations"
       FROM PUBLIC`,
      `GRANT SELECT, INSERT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_finalizations"
       TO ql3_runtime`,
      `GRANT SELECT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${POSTGRES_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE}"
       TO ql3_runtime`,
    ],
    (context, statement) => context.query(statement).then(() => undefined),
  );

const POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_artifacts" (
  artifact_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  run_id varchar(36) NOT NULL,
  step_run_id varchar(128) NOT NULL,
  invocation_id varchar(128) NOT NULL UNIQUE,
  requested_by_type varchar(32) NOT NULL,
  requested_by_id varchar(128) NOT NULL,
  provider varchar(256) NOT NULL,
  model varchar(256) NOT NULL,
  content_digest char(64) NOT NULL,
  output_bytes integer NOT NULL,
  retention_policy_revision varchar(128) NOT NULL,
  retention_ms bigint NOT NULL,
  retention_policy_digest char(64) NOT NULL,
  retention_eligible_at_ms bigint NOT NULL,
  key_id varchar(128) NOT NULL,
  algorithm varchar(16) NOT NULL,
  plaintext_bytes integer NOT NULL,
  sealed_at_ms bigint NOT NULL,
  artifact_digest char(64) NOT NULL UNIQUE,
  artifact_json jsonb NOT NULL,
  CONSTRAINT ql3_ai_prompt_output_artifact_admission_fk
    FOREIGN KEY (invocation_id)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_admissions"
      (invocation_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_output_artifact_start_fk
    FOREIGN KEY (invocation_id)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts"
      (invocation_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_output_artifact_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_output_artifact_identity_check CHECK (
    artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' AND
    step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    invocation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    length(requested_by_type) BETWEEN 1 AND 32 AND
    requested_by_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    length(provider) BETWEEN 1 AND 256 AND
    length(model) BETWEEN 1 AND 256 AND
    retention_policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND
    algorithm = 'aes-256-gcm'
  ),
  CONSTRAINT ql3_ai_prompt_output_artifact_value_check CHECK (
    output_bytes BETWEEN 0 AND 1048576 AND
    plaintext_bytes BETWEEN 1 AND 1052672 AND
    retention_ms BETWEEN 3600000 AND 31536000000 AND
    sealed_at_ms >= 0 AND
    retention_eligible_at_ms = sealed_at_ms + retention_ms AND
    content_digest ~ '^[0-9a-f]{64}$' AND
    retention_policy_digest ~ '^[0-9a-f]{64}$' AND
    artifact_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_ai_prompt_output_artifact_json_check CHECK (
    jsonb_typeof(artifact_json) = 'object' AND
    octet_length(artifact_json::text) BETWEEN 2 AND 1572864 AND
    artifact_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-prompt-output-artifact@v1',
      'artifactId', artifact_id, 'projectId', project_id,
      'runId', run_id, 'stepRunId', step_run_id,
      'invocationId', invocation_id, 'provider', provider, 'model', model,
      'contentDigest', content_digest, 'outputBytes', output_bytes,
      'retentionPolicyDigest', retention_policy_digest,
      'retentionEligibleAtMs', retention_eligible_at_ms,
      'keyId', key_id, 'algorithm', algorithm,
      'plaintextBytes', plaintext_bytes, 'sealedAtMs', sealed_at_ms,
      'artifactDigest', artifact_digest
    ) AND
    artifact_json -> 'requestedBy' @> jsonb_build_object(
      'type', requested_by_type, 'id', requested_by_id
    ) AND
    artifact_json -> 'retentionPolicy' @> jsonb_build_object(
      'revision', retention_policy_revision, 'retentionMs', retention_ms
    )
  )
)`;

const postgresPluginPackagePromptOutputArtifactMigration =
  defineSqlMigration<PostgresQueryable>(
    POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_MIGRATION_ID,
    [
      POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_TABLE_SQL,
      `CREATE INDEX ql3_ai_prompt_output_artifact_retention_idx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_artifacts"
         (retention_eligible_at_ms, artifact_id)`,
      `CREATE INDEX ql3_ai_prompt_output_artifact_project_run_idx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_artifacts"
         (project_id, run_id, artifact_id)`,
      `REVOKE ALL ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_artifacts"
       FROM PUBLIC`,
      `GRANT SELECT, INSERT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_artifacts"
       TO ql3_runtime`,
    ],
    (context, statement) => context.query(statement).then(() => undefined),
  );

const POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_artifact_tombstones" (
  artifact_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  run_id varchar(36) NOT NULL,
  step_run_id varchar(128) NOT NULL,
  invocation_id varchar(128) NOT NULL UNIQUE,
  artifact_digest char(64) NOT NULL UNIQUE,
  retention_policy_digest char(64) NOT NULL,
  retention_eligible_at_ms bigint NOT NULL,
  key_id varchar(128) NOT NULL,
  tombstoned_at_ms bigint NOT NULL,
  tombstone_digest char(64) NOT NULL UNIQUE,
  tombstone_json jsonb NOT NULL,
  CONSTRAINT ql3_ai_prompt_output_tombstone_admission_fk
    FOREIGN KEY (invocation_id)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_admissions"
      (invocation_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_output_tombstone_start_fk
    FOREIGN KEY (invocation_id)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts"
      (invocation_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_output_tombstone_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_output_tombstone_identity_check CHECK (
    artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' AND
    step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    invocation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  ),
  CONSTRAINT ql3_ai_prompt_output_tombstone_value_check CHECK (
    retention_eligible_at_ms >= 0 AND
    tombstoned_at_ms >= retention_eligible_at_ms AND
    artifact_digest ~ '^[0-9a-f]{64}$' AND
    retention_policy_digest ~ '^[0-9a-f]{64}$' AND
    tombstone_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_ai_prompt_output_tombstone_json_check CHECK (
    jsonb_typeof(tombstone_json) = 'object' AND
    octet_length(tombstone_json::text) BETWEEN 2 AND 8192 AND
    tombstone_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-prompt-output-artifact-tombstone@v1',
      'tombstonedAtMs', tombstoned_at_ms,
      'tombstoneDigest', tombstone_digest
    ) AND
    tombstone_json -> 'reference' @> jsonb_build_object(
      'artifactId', artifact_id, 'projectId', project_id,
      'runId', run_id, 'stepRunId', step_run_id,
      'invocationId', invocation_id, 'artifactDigest', artifact_digest,
      'retentionPolicyDigest', retention_policy_digest,
      'retentionEligibleAtMs', retention_eligible_at_ms, 'keyId', key_id
    )
  )
)`;

const postgresPluginPackagePromptOutputTombstoneMigration =
  defineSqlMigration<PostgresQueryable>(
    POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_MIGRATION_ID,
    [
      POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_TABLE_SQL,
      `CREATE INDEX ql3_ai_prompt_output_tombstone_time_idx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_artifact_tombstones"
         (tombstoned_at_ms, artifact_id)`,
      `CREATE INDEX ql3_ai_prompt_output_tombstone_project_run_idx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_artifact_tombstones"
         (project_id, run_id, artifact_id)`,
      `REVOKE ALL ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_artifact_tombstones"
       FROM PUBLIC`,
      `DO $$
       BEGIN
         EXECUTE format(
           'GRANT CONNECT ON DATABASE %I TO ql3_ai_maintenance',
           current_database()
         );
       END
       $$`,
      `GRANT SELECT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_artifact_tombstones"
       TO ql3_runtime`,
      `GRANT USAGE ON SCHEMA "${POSTGRES_MODEL_INVOCATION_SCHEMA}"
       TO ql3_ai_maintenance`,
      `GRANT SELECT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${POSTGRES_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE}",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_admissions",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_finalizations"
       TO ql3_ai_maintenance`,
      `GRANT SELECT, DELETE ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_artifacts"
       TO ql3_ai_maintenance`,
      `GRANT SELECT, INSERT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_artifact_tombstones"
       TO ql3_ai_maintenance`,
      `GRANT USAGE ON SCHEMA "ql3" TO ql3_ai_maintenance`,
      `GRANT SELECT ON TABLE "ql3"."runs", "ql3"."step_runs"
       TO ql3_ai_maintenance`,
    ],
    (context, statement) => context.query(statement).then(() => undefined),
  );

const POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_PREPARATION_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_retirement_preparations" (
  key_id varchar(128) PRIMARY KEY,
  retirement_id varchar(128) NOT NULL UNIQUE,
  request_id varchar(128) NOT NULL UNIQUE,
  mutation_id varchar(128) NOT NULL UNIQUE,
  catalog_digest char(64) NOT NULL,
  material_proof char(64) NOT NULL,
  prepared_at_ms bigint NOT NULL,
  preparation_digest char(64) NOT NULL UNIQUE,
  preparation_json jsonb NOT NULL,
  CONSTRAINT ql3_ai_prompt_output_key_retirement_preparation_fk_uidx
    UNIQUE (key_id, preparation_digest),
  CONSTRAINT ql3_ai_prompt_output_key_retirement_preparation_identity_check CHECK (
    key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND
    retirement_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  ),
  CONSTRAINT ql3_ai_prompt_output_key_retirement_preparation_value_check CHECK (
    prepared_at_ms >= 0 AND
    catalog_digest ~ '^[0-9a-f]{64}$' AND
    material_proof ~ '^[0-9a-f]{64}$' AND
    preparation_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_ai_prompt_output_key_retirement_preparation_json_check CHECK (
    jsonb_typeof(preparation_json) = 'object' AND
    octet_length(preparation_json::text) BETWEEN 2 AND 8192 AND
    preparation_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-prompt-output-key-retirement-preparation@v1',
      'keyId', key_id, 'retirementId', retirement_id,
      'requestId', request_id, 'mutationId', mutation_id,
      'catalogDigest', catalog_digest, 'materialProof', material_proof,
      'preparedAtMs', prepared_at_ms,
      'preparationDigest', preparation_digest
    )
  )
)`;

const POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_COMPLETION_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_retirement_completions" (
  key_id varchar(128) PRIMARY KEY,
  retirement_id varchar(128) NOT NULL UNIQUE,
  request_id varchar(128) NOT NULL UNIQUE,
  mutation_id varchar(128) NOT NULL UNIQUE,
  preparation_digest char(64) NOT NULL UNIQUE,
  retired_catalog_digest char(64) NOT NULL,
  absence_proof char(64) NOT NULL,
  completed_at_ms bigint NOT NULL,
  completion_digest char(64) NOT NULL UNIQUE,
  completion_json jsonb NOT NULL,
  CONSTRAINT ql3_ai_prompt_output_key_retirement_completion_preparation_fk
    FOREIGN KEY (key_id, preparation_digest)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_retirement_preparations"
      (key_id, preparation_digest) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_output_key_retirement_completion_identity_check CHECK (
    key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND
    retirement_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  ),
  CONSTRAINT ql3_ai_prompt_output_key_retirement_completion_value_check CHECK (
    completed_at_ms >= 0 AND
    preparation_digest ~ '^[0-9a-f]{64}$' AND
    retired_catalog_digest ~ '^[0-9a-f]{64}$' AND
    absence_proof ~ '^[0-9a-f]{64}$' AND
    completion_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_ai_prompt_output_key_retirement_completion_json_check CHECK (
    jsonb_typeof(completion_json) = 'object' AND
    octet_length(completion_json::text) BETWEEN 2 AND 8192 AND
    completion_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-prompt-output-key-retirement-completion@v1',
      'keyId', key_id, 'retirementId', retirement_id,
      'requestId', request_id, 'mutationId', mutation_id,
      'preparationDigest', preparation_digest,
      'retiredCatalogDigest', retired_catalog_digest,
      'absenceProof', absence_proof, 'completedAtMs', completed_at_ms,
      'completionDigest', completion_digest
    )
  )
)`;

const postgresPluginPackagePromptOutputKeyRetirementMigration =
  defineSqlMigration<PostgresQueryable>(
    POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_MIGRATION_ID,
    [
      POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_PREPARATION_TABLE_SQL,
      POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_COMPLETION_TABLE_SQL,
      `CREATE INDEX ql3_ai_prompt_output_key_retirement_completion_time_idx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_retirement_completions"
         (completed_at_ms, key_id)`,
      `REVOKE ALL ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_retirement_preparations",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_retirement_completions"
       FROM PUBLIC`,
      `GRANT SELECT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_retirement_preparations"
       TO ql3_runtime`,
      `GRANT SELECT, INSERT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_retirement_preparations",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_retirement_completions"
       TO ql3_ai_maintenance`,
    ],
    (context, statement) => context.query(statement).then(() => undefined),
  );

const POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_PREPARATION_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_rotation_preparations" (
  rotation_id varchar(128) PRIMARY KEY,
  request_id varchar(128) NOT NULL UNIQUE,
  mutation_id varchar(128) NOT NULL UNIQUE,
  expected_secret_uid varchar(128) NOT NULL,
  expected_active_key_id varchar(128) NOT NULL,
  expected_catalog_digest char(64) NOT NULL,
  new_key_id varchar(128) NOT NULL UNIQUE,
  material_proof char(64) NOT NULL,
  prepared_at_ms bigint NOT NULL,
  preparation_digest char(64) NOT NULL UNIQUE,
  preparation_json jsonb NOT NULL,
  CONSTRAINT ql3_ai_prompt_key_rotation_preparation_fk_uidx
    UNIQUE (rotation_id, preparation_digest),
  CONSTRAINT ql3_ai_prompt_key_rotation_source_uidx
    UNIQUE (expected_secret_uid, expected_catalog_digest),
  CONSTRAINT ql3_ai_prompt_key_rotation_preparation_identity_check CHECK (
    rotation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    expected_secret_uid ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    expected_active_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND
    new_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND
    expected_active_key_id <> new_key_id
  ),
  CONSTRAINT ql3_ai_prompt_key_rotation_preparation_value_check CHECK (
    prepared_at_ms >= 0 AND
    expected_catalog_digest ~ '^[0-9a-f]{64}$' AND
    material_proof ~ '^[0-9a-f]{64}$' AND
    preparation_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_ai_prompt_key_rotation_preparation_json_check CHECK (
    jsonb_typeof(preparation_json) = 'object' AND
    octet_length(preparation_json::text) BETWEEN 2 AND 8192 AND
    preparation_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-prompt-output-key-rotation-preparation@v1',
      'rotationId', rotation_id, 'requestId', request_id,
      'mutationId', mutation_id, 'expectedSecretUid', expected_secret_uid,
      'expectedActiveKeyId', expected_active_key_id,
      'expectedCatalogDigest', expected_catalog_digest,
      'newKeyId', new_key_id, 'materialProof', material_proof,
      'preparedAtMs', prepared_at_ms, 'preparationDigest', preparation_digest
    )
  )
)`;

const POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_COMPLETION_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_rotation_completions" (
  rotation_id varchar(128) PRIMARY KEY,
  request_id varchar(128) NOT NULL UNIQUE,
  mutation_id varchar(128) NOT NULL UNIQUE,
  preparation_digest char(64) NOT NULL UNIQUE,
  generation bigint NOT NULL,
  previous_active_key_id varchar(128) NOT NULL,
  active_key_id varchar(128) NOT NULL,
  catalog_digest char(64) NOT NULL,
  material_proof char(64) NOT NULL,
  completed_at_ms bigint NOT NULL,
  completion_digest char(64) NOT NULL UNIQUE,
  completion_json jsonb NOT NULL,
  CONSTRAINT ql3_ai_prompt_key_rotation_completion_preparation_fk
    FOREIGN KEY (rotation_id, preparation_digest)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_rotation_preparations"
      (rotation_id, preparation_digest) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_prompt_key_rotation_completion_identity_check CHECK (
    rotation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    previous_active_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND
    active_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND
    previous_active_key_id <> active_key_id
  ),
  CONSTRAINT ql3_ai_prompt_key_rotation_completion_value_check CHECK (
    generation BETWEEN 2 AND 9007199254740991 AND completed_at_ms >= 0 AND
    preparation_digest ~ '^[0-9a-f]{64}$' AND
    catalog_digest ~ '^[0-9a-f]{64}$' AND
    material_proof ~ '^[0-9a-f]{64}$' AND
    completion_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_ai_prompt_key_rotation_completion_json_check CHECK (
    jsonb_typeof(completion_json) = 'object' AND
    octet_length(completion_json::text) BETWEEN 2 AND 8192 AND
    completion_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-prompt-output-key-rotation-completion@v1',
      'rotationId', rotation_id, 'requestId', request_id,
      'mutationId', mutation_id, 'preparationDigest', preparation_digest,
      'generation', generation, 'previousActiveKeyId', previous_active_key_id,
      'activeKeyId', active_key_id, 'catalogDigest', catalog_digest,
      'materialProof', material_proof, 'completedAtMs', completed_at_ms,
      'completionDigest', completion_digest
    )
  )
)`;

const postgresPluginPackagePromptOutputKeyRotationMigration =
  defineSqlMigration<PostgresQueryable>(
    POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_MIGRATION_ID,
    [
      POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_PREPARATION_TABLE_SQL,
      POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_COMPLETION_TABLE_SQL,
      `CREATE INDEX ql3_ai_prompt_key_rotation_completion_time_idx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_rotation_completions"
         (completed_at_ms, rotation_id)`,
      `REVOKE ALL ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_rotation_preparations",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_rotation_completions"
       FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
            ql3_package_executor, ql3_automation_manager, ql3_worker_ingress,
            ql3_worker_credential_manager, ql3_worker_credential_executor,
            ql3_ai_credential_manager, ql3_ai_credential_tester`,
      `GRANT SELECT, INSERT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_rotation_preparations",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_prompt_output_key_rotation_completions"
       TO ql3_ai_maintenance`,
    ],
    (context, statement) => context.query(statement).then(() => undefined),
  );

const postgresPluginPackagePromptProductAuthorizationMigration =
  defineSqlMigration<PostgresQueryable>(
    POSTGRES_PLUGIN_PACKAGE_PROMPT_PRODUCT_AUTHORIZATION_MIGRATION_ID,
    [
      `CREATE FUNCTION
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."plugin_package_prompt_authorize_admission"(
           p_credential_id varchar,
           p_credential_version integer,
           p_project_id varchar,
           p_subject_type varchar,
           p_subject_id varchar,
           p_project_version integer,
           p_binding_version integer,
           p_audit_event_id uuid,
           p_request_id varchar,
           p_planned_at_ms bigint,
           p_replay boolean
         )
       RETURNS boolean
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
         PERFORM pg_advisory_xact_lock(
           hashtextextended('ql3-api-credential:' || p_credential_id, 0)
         );
         PERFORM pg_advisory_xact_lock(
           hashtextextended(
             'ql3-identity:' || p_subject_type || ':' || p_subject_id,
             0
           )
         );
         PERFORM 1
         FROM "ql3"."api_credentials" AS credential
         JOIN "ql3"."identity_subjects" AS identity
           ON identity.subject_type = credential.subject_type
          AND identity.subject_id = credential.subject_id
         WHERE credential.credential_id = p_credential_id
           AND credential.version = p_credential_version
           AND credential.version = (
             SELECT max(candidate.version)
             FROM "ql3"."api_credentials" AS candidate
             WHERE candidate.credential_id = p_credential_id
           )
           AND credential.state = 'active'
           AND credential.subject_type = p_subject_type
           AND credential.subject_id = p_subject_id
           AND credential.not_before_at_ms <=
             floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
           AND credential.expires_at_ms >
             floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
           AND identity.status = 'active'
         FOR SHARE OF credential, identity;
         IF NOT FOUND THEN
           RETURN false;
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
           AND binding.role IN ('owner', 'admin', 'operator')
           AND p_subject_type <> 'agent'
           AND binding.version = (
             SELECT max(candidate.version)
             FROM "ql3"."project_role_bindings" AS candidate
             WHERE candidate.project_id = p_project_id
               AND candidate.subject_type = p_subject_type
               AND candidate.subject_id = p_subject_id
           )
         FOR SHARE OF project, binding;
         IF NOT FOUND THEN
           RETURN false;
         END IF;
         IF NOT p_replay THEN
           INSERT INTO "ql3"."security_audit_events" (
             event_id, request_id, operation_id, project_id,
             subject_type, subject_id, authentication_id, outcome, reasons,
             project_version, binding_version, occurred_at_ms
           ) VALUES (
             p_audit_event_id, p_request_id, 'prompt.execute', p_project_id,
             p_subject_type, p_subject_id,
             'api_credential:' || p_credential_id || ':' || p_credential_version,
             'allowed', '["project_policy_allowed"]'::jsonb,
             p_project_version, p_binding_version, p_planned_at_ms
           );
         END IF;
         RETURN true;
       END
       $ql3_ai$`,
      `REVOKE ALL ON FUNCTION
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."plugin_package_prompt_authorize_admission"(
           varchar, integer, varchar, varchar, varchar, integer, integer,
           uuid, varchar, bigint, boolean
         )
       FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
            ql3_package_executor, ql3_worker_ingress`,
      `GRANT EXECUTE ON FUNCTION
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."plugin_package_prompt_authorize_admission"(
           varchar, integer, varchar, varchar, varchar, integer, integer,
           uuid, varchar, bigint, boolean
         )
       TO ql3_runtime`,
    ],
    (context, statement) => context.query(statement).then(() => undefined),
  );

export const postgresPromptBaseMigrations = Object.freeze([
  postgresPluginPackagePromptAdmissionMigration,
  postgresPluginPackagePromptFinalizationMigration,
  postgresPluginPackagePromptOutputArtifactMigration,
  postgresPluginPackagePromptOutputTombstoneMigration,
  postgresPluginPackagePromptOutputKeyRetirementMigration,
]);

export const postgresPromptExtensionMigrations = Object.freeze([
  postgresPluginPackagePromptOutputKeyRotationMigration,
  postgresPluginPackagePromptProductAuthorizationMigration,
]);
