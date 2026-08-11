import type { PostgresQueryable } from '@qinglong/runtime-core';

import {
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_CATALOG_MIGRATION_ID,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_MIGRATION_ID,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_IDENTITY_MIGRATION_ID,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_TEST_CONNECTION_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_SCHEMA,
} from '../identities';

import { defineSqlMigration } from '../shared';

const POSTGRES_MODEL_PROVIDER_CREDENTIAL_BINDING_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_bindings" (
  project_id varchar(128) NOT NULL,
  provider varchar(128) NOT NULL,
  revision varchar(128) NOT NULL,
  secret_ref varchar(512) NOT NULL,
  scheme varchar(16) NOT NULL,
  binding_digest varchar(71) NOT NULL UNIQUE,
  binding_json jsonb NOT NULL,
  PRIMARY KEY (project_id, provider, revision),
  CONSTRAINT ql3_ai_model_provider_credential_binding_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_model_provider_credential_binding_identity_check CHECK (
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    length(secret_ref) BETWEEN 1 AND 512 AND
    secret_ref LIKE 'qlsecret:v1:%' AND
    scheme = 'bearer' AND
    binding_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_ai_model_provider_credential_binding_json_check CHECK (
    jsonb_typeof(binding_json) = 'object' AND
    octet_length(binding_json::text) BETWEEN 2 AND 4096 AND
    binding_json @> jsonb_build_object(
      'schema', 'qinglong/model-provider-credential-binding@v1',
      'projectId', project_id, 'provider', provider,
      'revision', revision, 'secretRef', secret_ref, 'scheme', scheme
    )
  )
)`;

const POSTGRES_MODEL_PROVIDER_CREDENTIAL_TRANSITION_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_transitions" (
  project_id varchar(128) NOT NULL,
  provider varchar(128) NOT NULL,
  generation integer NOT NULL,
  action varchar(16) NOT NULL,
  active_binding_revision varchar(128),
  active_binding_digest char(64),
  previous_transition_digest char(64),
  mutation_id varchar(128) NOT NULL UNIQUE,
  changed_by_type varchar(32) NOT NULL,
  changed_by_id varchar(128) NOT NULL,
  changed_at_ms bigint NOT NULL,
  command_digest char(64) NOT NULL,
  transition_digest char(64) NOT NULL UNIQUE,
  transition_json jsonb NOT NULL,
  PRIMARY KEY (project_id, provider, generation),
  CONSTRAINT ql3_ai_model_provider_credential_transition_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_model_provider_credential_transition_binding_fk
    FOREIGN KEY (project_id, provider, active_binding_revision)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_bindings"
      (project_id, provider, revision) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_model_provider_credential_transition_identity_check CHECK (
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    generation BETWEEN 1 AND 2147483647 AND
    action IN ('bind', 'revoke') AND
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    changed_by_type IN ('user', 'api_app', 'mcp_client', 'agent', 'system', 'worker') AND
    changed_by_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    changed_at_ms >= 0
  ),
  CONSTRAINT ql3_ai_model_provider_credential_transition_state_check CHECK (
    (action = 'bind' AND active_binding_revision IS NOT NULL AND
      active_binding_digest ~ '^[0-9a-f]{64}$') OR
    (action = 'revoke' AND active_binding_revision IS NULL AND
      active_binding_digest IS NULL)
  ),
  CONSTRAINT ql3_ai_model_provider_credential_transition_digest_check CHECK (
    (previous_transition_digest IS NULL OR
      previous_transition_digest ~ '^[0-9a-f]{64}$') AND
    command_digest ~ '^[0-9a-f]{64}$' AND
    transition_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_ai_model_provider_credential_transition_json_check CHECK (
    jsonb_typeof(transition_json) = 'object' AND
    octet_length(transition_json::text) BETWEEN 2 AND 8192 AND
    transition_json @> jsonb_build_object(
      'schema', 'qinglong/model-provider-credential-transition@v1',
      'mutationId', mutation_id, 'projectId', project_id,
      'provider', provider, 'generation', generation, 'action', action,
      'activeBindingRevision', active_binding_revision,
      'activeBindingDigest', active_binding_digest,
      'previousTransitionDigest', previous_transition_digest,
      'changedAtMs', changed_at_ms, 'commandDigest', command_digest,
      'transitionDigest', transition_digest
    ) AND
    transition_json -> 'changedBy' @> jsonb_build_object(
      'type', changed_by_type, 'id', changed_by_id
    )
  )
)`;

const POSTGRES_MODEL_PROVIDER_CREDENTIAL_AUDIT_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_audits" (
  project_id varchar(128) NOT NULL,
  provider varchar(128) NOT NULL,
  request_id varchar(128) NOT NULL,
  operation varchar(16) NOT NULL,
  binding_revision varchar(128) NOT NULL,
  binding_digest varchar(71) NOT NULL,
  occurred_at_ms bigint NOT NULL,
  audit_digest char(64) PRIMARY KEY,
  audit_json jsonb NOT NULL,
  CONSTRAINT ql3_ai_model_provider_credential_audit_identity_uidx
    UNIQUE (project_id, provider, request_id, operation),
  CONSTRAINT ql3_ai_model_provider_credential_audit_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_model_provider_credential_audit_identity_check CHECK (
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    operation IN ('list_models', 'generate', 'stream') AND
    binding_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    binding_digest ~ '^sha256:[0-9a-f]{64}$' AND
    occurred_at_ms >= 0 AND audit_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_ai_model_provider_credential_audit_json_check CHECK (
    jsonb_typeof(audit_json) = 'object' AND
    octet_length(audit_json::text) BETWEEN 2 AND 4096 AND
    audit_json @> jsonb_build_object(
      'schema', 'qinglong/model-provider-credential-audit@v1',
      'projectId', project_id, 'provider', provider,
      'requestId', request_id, 'operation', operation,
      'bindingRevision', binding_revision,
      'bindingDigest', binding_digest, 'occurredAtMs', occurred_at_ms
    )
  )
)`;

const postgresModelProviderCredentialCatalogMigration =
  defineSqlMigration<PostgresQueryable>(
    POSTGRES_MODEL_PROVIDER_CREDENTIAL_CATALOG_MIGRATION_ID,
    [
      POSTGRES_MODEL_PROVIDER_CREDENTIAL_BINDING_TABLE_SQL,
      POSTGRES_MODEL_PROVIDER_CREDENTIAL_TRANSITION_TABLE_SQL,
      POSTGRES_MODEL_PROVIDER_CREDENTIAL_AUDIT_TABLE_SQL,
      `CREATE INDEX ql3_ai_model_provider_credential_transition_current_idx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_transitions"
         (project_id, provider, generation DESC)`,
      `CREATE INDEX ql3_ai_model_provider_credential_audit_project_time_idx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_audits"
         (project_id, occurred_at_ms DESC, request_id)`,
      `REVOKE ALL ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_bindings",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_transitions",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_audits"
       FROM PUBLIC`,
      `GRANT USAGE ON SCHEMA "${POSTGRES_MODEL_INVOCATION_SCHEMA}"
       TO ql3_runtime, ql3_ai_maintenance`,
      `GRANT SELECT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_bindings",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_transitions"
       TO ql3_runtime`,
      `GRANT SELECT, INSERT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_audits"
       TO ql3_runtime`,
      `GRANT SELECT, INSERT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_bindings",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_transitions"
       TO ql3_ai_maintenance`,
      `GRANT SELECT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_audits"
       TO ql3_ai_maintenance`,
    ],
    (context, statement) => context.query(statement).then(() => undefined),
  );

const postgresModelProviderCredentialManagementMigration =
  defineSqlMigration<PostgresQueryable>(
    POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_MIGRATION_ID,
    [
      `DO $ql3_ai$
       BEGIN
         EXECUTE format(
           'GRANT CONNECT ON DATABASE %I TO ql3_ai_credential_manager',
           current_database()
         );
       END
       $ql3_ai$`,
      `REVOKE CREATE ON SCHEMA "ql3", "${POSTGRES_MODEL_INVOCATION_SCHEMA}"
       FROM ql3_ai_credential_manager`,
      `REVOKE ALL ON ALL TABLES IN SCHEMA "${POSTGRES_MODEL_INVOCATION_SCHEMA}"
       FROM ql3_ai_credential_manager`,
      `REVOKE ALL ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_bindings",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_transitions",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_audits"
       FROM ql3_ai_maintenance`,
      `REVOKE ALL ON TABLE
         "ql3"."projects",
         "ql3"."project_role_bindings",
         "ql3"."security_audit_events"
       FROM ql3_ai_credential_manager`,
      `GRANT USAGE ON SCHEMA "ql3", "${POSTGRES_MODEL_INVOCATION_SCHEMA}"
       TO ql3_ai_credential_manager`,
      `GRANT SELECT ON TABLE
         "ql3"."projects",
         "ql3"."project_role_bindings",
         "ql3"."security_audit_events"
       TO ql3_ai_credential_manager`,
      `GRANT INSERT ON TABLE "ql3"."security_audit_events"
       TO ql3_ai_credential_manager`,
      `GRANT SELECT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."ai_schema_migrations",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_bindings",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_transitions",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_audits"
       TO ql3_ai_credential_manager`,
      `GRANT INSERT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_bindings",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_transitions"
       TO ql3_ai_credential_manager`,
    ],
    (context, statement) => context.query(statement).then(() => undefined),
  );

const postgresModelProviderCredentialManagementIdentityMigration =
  defineSqlMigration<PostgresQueryable>(
    POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_IDENTITY_MIGRATION_ID,
    [
      `CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_management_identity_keyset_ledger" (
         authority varchar(64) PRIMARY KEY,
         generation bigint NOT NULL,
         digest varchar(43) NOT NULL,
         issuer varchar(512) NOT NULL,
         audience varchar(256) NOT NULL,
         active_key_ids jsonb NOT NULL,
         revoked_key_ids jsonb NOT NULL,
         updated_at_ms bigint NOT NULL,
         CONSTRAINT ql3_ai_provider_credential_identity_authority_check
           CHECK (authority = 'model-provider-credential-management'),
         CONSTRAINT ql3_ai_provider_credential_identity_generation_check
           CHECK (generation >= 1 AND updated_at_ms >= 0),
         CONSTRAINT ql3_ai_provider_credential_identity_digest_check
           CHECK (digest ~ '^[A-Za-z0-9_-]{43}$'),
         CONSTRAINT ql3_ai_provider_credential_identity_trust_domain_check
           CHECK (
             char_length(issuer) BETWEEN 1 AND 512 AND
             issuer !~ '[[:cntrl:]]' AND
             char_length(audience) BETWEEN 1 AND 256 AND
             audience !~ '[[:cntrl:]]'
           ),
         CONSTRAINT ql3_ai_provider_credential_identity_keys_check
           CHECK (
             jsonb_typeof(active_key_ids) = 'array' AND
             jsonb_array_length(active_key_ids) BETWEEN 1 AND 8 AND
             octet_length(active_key_ids::text) BETWEEN 3 AND 8192 AND
             jsonb_typeof(revoked_key_ids) = 'array' AND
             jsonb_array_length(revoked_key_ids) BETWEEN 0 AND 64 AND
             octet_length(revoked_key_ids::text) BETWEEN 2 AND 16384
           )
       )`,
      `REVOKE ALL ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_management_identity_keyset_ledger"
       FROM PUBLIC, ql3_ai_maintenance`,
      `GRANT SELECT, INSERT, UPDATE ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_management_identity_keyset_ledger"
       TO ql3_ai_credential_manager`,
    ],
    (context, statement) => context.query(statement).then(() => undefined),
  );

const postgresModelProviderCredentialTestConnectionMigration =
  defineSqlMigration<PostgresQueryable>(
    POSTGRES_MODEL_PROVIDER_CREDENTIAL_TEST_CONNECTION_MIGRATION_ID,
    [
      `CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_plans" (
         test_id uuid PRIMARY KEY,
         request_id varchar(128) NOT NULL,
         project_id varchar(128) NOT NULL,
         provider varchar(128) NOT NULL,
         adapter varchar(32) NOT NULL,
         base_url varchar(1024) NOT NULL,
         endpoint_revision varchar(128) NOT NULL,
         endpoint_config_digest char(64) NOT NULL,
         deadline_ms integer NOT NULL,
         max_response_bytes integer NOT NULL,
         max_models integer NOT NULL,
         max_cost_microusd bigint NOT NULL,
         retry_limit integer NOT NULL,
         requested_by_type varchar(32) NOT NULL,
         requested_by_id varchar(128) NOT NULL,
         project_version integer NOT NULL,
         binding_version integer NOT NULL,
         planned_at_ms bigint NOT NULL,
         expires_at_ms bigint NOT NULL,
         plan_digest char(64) NOT NULL UNIQUE,
         plan_json jsonb NOT NULL,
         CONSTRAINT ql3_ai_provider_credential_test_plan_project_fk
           FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
           ON DELETE RESTRICT,
         CONSTRAINT ql3_ai_provider_credential_test_plan_identity_uidx
           UNIQUE (project_id, request_id),
         CONSTRAINT ql3_ai_provider_credential_test_plan_digest_uidx
           UNIQUE (test_id, plan_digest),
         CONSTRAINT ql3_ai_provider_credential_test_plan_identity_check CHECK (
           project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
           provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
           request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
           endpoint_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
           requested_by_type = 'user' AND
           char_length(requested_by_id) BETWEEN 1 AND 128 AND
           requested_by_id !~ '[[:cntrl:]]'
         ),
         CONSTRAINT ql3_ai_provider_credential_test_plan_budget_check CHECK (
           adapter = 'openai-compatible' AND
           base_url ~ '^https://[^[:cntrl:]]+/$' AND
           endpoint_config_digest ~ '^[0-9a-f]{64}$' AND
           deadline_ms BETWEEN 1000 AND 15000 AND
           max_response_bytes BETWEEN 1024 AND 262144 AND
           max_models BETWEEN 1 AND 256 AND
           max_cost_microusd = 0 AND retry_limit = 0
         ),
         CONSTRAINT ql3_ai_provider_credential_test_plan_fence_check CHECK (
           project_version BETWEEN 1 AND 2147483647 AND
           binding_version BETWEEN 1 AND 2147483647 AND
           planned_at_ms >= 0 AND expires_at_ms > planned_at_ms AND
           expires_at_ms - planned_at_ms <= 300000 AND
           plan_digest ~ '^[0-9a-f]{64}$'
         ),
         CONSTRAINT ql3_ai_provider_credential_test_plan_json_check CHECK (
           jsonb_typeof(plan_json) = 'object' AND
           octet_length(plan_json::text) BETWEEN 2 AND 16384 AND
           plan_json @> jsonb_build_object(
             'schema', 'qinglong/model-provider-credential-test-plan@v1',
             'testId', test_id::text, 'requestId', request_id,
             'projectId', project_id, 'provider', provider,
             'plannedAtMs', planned_at_ms, 'expiresAtMs', expires_at_ms,
             'planDigest', plan_digest
           ) AND
           plan_json -> 'endpoint' @> jsonb_build_object(
             'provider', provider, 'adapter', adapter, 'baseUrl', base_url,
             'revision', endpoint_revision,
             'configDigest', endpoint_config_digest,
             'deadlineMs', deadline_ms,
             'maxResponseBytes', max_response_bytes,
             'maxModels', max_models, 'maxCostMicrousd', max_cost_microusd,
             'retryLimit', retry_limit
           ) AND
           plan_json -> 'requestedBy' @> jsonb_build_object(
             'type', requested_by_type, 'id', requested_by_id
           ) AND
           plan_json -> 'fence' @> jsonb_build_object(
             'projectVersion', project_version,
             'bindingVersion', binding_version
           )
         )
       )`,
      `CREATE INDEX ql3_ai_provider_credential_test_plan_expiry_idx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_plans"
         (expires_at_ms, test_id)`,
      `CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_quota_buckets" (
         project_id varchar(128) NOT NULL,
         subject_id varchar(128) NOT NULL,
         window_started_at_ms bigint NOT NULL,
         consumed_count integer NOT NULL,
         receipt_ids jsonb NOT NULL,
         updated_at_ms bigint NOT NULL,
         PRIMARY KEY (project_id, subject_id),
         CONSTRAINT ql3_ai_provider_credential_test_quota_project_fk
           FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
           ON DELETE RESTRICT,
         CONSTRAINT ql3_ai_provider_credential_test_quota_identity_check CHECK (
           project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
           char_length(subject_id) BETWEEN 1 AND 128 AND
           subject_id !~ '[[:cntrl:]]'
         ),
         CONSTRAINT ql3_ai_provider_credential_test_quota_value_check CHECK (
           window_started_at_ms >= 0 AND
           consumed_count BETWEEN 1 AND 32 AND
           updated_at_ms >= window_started_at_ms AND
           jsonb_typeof(receipt_ids) = 'array' AND
           jsonb_array_length(receipt_ids) BETWEEN 1 AND 32 AND
           octet_length(receipt_ids::text) BETWEEN 3 AND 8192
         )
       )`,
      `CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_executions" (
         execution_id uuid PRIMARY KEY,
         test_id uuid NOT NULL UNIQUE,
         plan_digest char(64) NOT NULL,
         started_at_ms bigint NOT NULL,
         execution_digest char(64) NOT NULL UNIQUE,
         execution_json jsonb NOT NULL,
         CONSTRAINT ql3_ai_provider_credential_test_execution_plan_fk
           FOREIGN KEY (test_id, plan_digest)
           REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_plans"
             (test_id, plan_digest) ON DELETE RESTRICT,
         CONSTRAINT ql3_ai_provider_credential_test_execution_value_check CHECK (
           plan_digest ~ '^[0-9a-f]{64}$' AND started_at_ms >= 0 AND
           execution_digest ~ '^[0-9a-f]{64}$'
         ),
         CONSTRAINT ql3_ai_provider_credential_test_execution_json_check CHECK (
           jsonb_typeof(execution_json) = 'object' AND
           octet_length(execution_json::text) BETWEEN 2 AND 4096 AND
           execution_json @> jsonb_build_object(
             'schema', 'qinglong/model-provider-credential-test-execution@v1',
             'executionId', execution_id::text, 'testId', test_id::text,
             'planDigest', plan_digest, 'startedAtMs', started_at_ms,
             'executionDigest', execution_digest
           )
         )
       )`,
      `ALTER TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_executions"
         ADD CONSTRAINT ql3_ai_provider_credential_test_execution_identity_uidx
         UNIQUE (execution_id, test_id, plan_digest)`,
      `CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_results" (
         execution_id uuid PRIMARY KEY,
         test_id uuid NOT NULL UNIQUE,
         plan_digest char(64) NOT NULL,
         outcome varchar(16) NOT NULL,
         model_count integer,
         duration_ms integer NOT NULL,
         completed_at_ms bigint NOT NULL,
         result_digest char(64) NOT NULL UNIQUE,
         result_json jsonb NOT NULL,
         CONSTRAINT ql3_ai_provider_credential_test_result_execution_fk
           FOREIGN KEY (execution_id, test_id, plan_digest)
           REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_executions"
             (execution_id, test_id, plan_digest) ON DELETE RESTRICT,
         CONSTRAINT ql3_ai_provider_credential_test_result_value_check CHECK (
           plan_digest ~ '^[0-9a-f]{64}$' AND
           ((outcome = 'reachable' AND model_count BETWEEN 0 AND 256) OR
            (outcome = 'unreachable' AND model_count IS NULL)) AND
           duration_ms BETWEEN 0 AND 15000 AND completed_at_ms >= 0 AND
           result_digest ~ '^[0-9a-f]{64}$'
         ),
         CONSTRAINT ql3_ai_provider_credential_test_result_json_check CHECK (
           jsonb_typeof(result_json) = 'object' AND
           octet_length(result_json::text) BETWEEN 2 AND 4096 AND
           result_json @> jsonb_build_object(
             'schema', 'qinglong/model-provider-credential-test-result@v1',
             'executionId', execution_id::text, 'testId', test_id::text,
             'planDigest', plan_digest, 'outcome', outcome,
             'modelCount', model_count, 'durationMs', duration_ms,
             'completedAtMs', completed_at_ms, 'resultDigest', result_digest
           )
         )
       )`,
      `DO $ql3_ai$
       BEGIN
         EXECUTE format(
           'GRANT CONNECT ON DATABASE %I TO ql3_ai_credential_tester',
           current_database()
         );
       END
       $ql3_ai$`,
      `REVOKE CREATE ON SCHEMA "ql3", "${POSTGRES_MODEL_INVOCATION_SCHEMA}"
       FROM ql3_ai_credential_tester`,
      `REVOKE ALL ON ALL TABLES IN SCHEMA "ql3", "${POSTGRES_MODEL_INVOCATION_SCHEMA}"
       FROM ql3_ai_credential_tester`,
      `REVOKE ALL ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_plans",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_quota_buckets",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_executions",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_results"
       FROM PUBLIC, ql3_runtime, ql3_ai_maintenance, ql3_admin,
            ql3_package_manager, ql3_package_executor, ql3_worker_ingress,
            ql3_ai_credential_manager, ql3_ai_credential_tester`,
      `GRANT USAGE ON SCHEMA "${POSTGRES_MODEL_INVOCATION_SCHEMA}"
       TO ql3_ai_credential_tester`,
      `GRANT SELECT, INSERT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_plans"
       TO ql3_ai_credential_manager`,
      `GRANT SELECT, INSERT, UPDATE ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_quota_buckets"
       TO ql3_ai_credential_manager`,
      `GRANT SELECT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_executions",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_results"
       TO ql3_ai_credential_manager`,
      `GRANT SELECT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."ai_schema_migrations",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_bindings",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_transitions",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_audits",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_plans",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_executions",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_results"
       TO ql3_ai_credential_tester`,
      `GRANT INSERT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_audits",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_executions",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_provider_credential_test_results"
       TO ql3_ai_credential_tester`,
    ],
    (context, statement) => context.query(statement).then(() => undefined),
  );

export const postgresCredentialMigrations = Object.freeze([
  postgresModelProviderCredentialCatalogMigration,
  postgresModelProviderCredentialManagementMigration,
  postgresModelProviderCredentialManagementIdentityMigration,
  postgresModelProviderCredentialTestConnectionMigration,
]);
