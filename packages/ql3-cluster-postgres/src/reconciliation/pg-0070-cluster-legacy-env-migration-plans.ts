import { CAPABILITIES_V68 } from '../remote-execution/pg-0069-worker-session-management-observation';
import { definePostgresSqlMigration } from '../migrations/sqlMigration';

export const CAPABILITIES_V69 = CAPABILITIES_V68.replace(
  '"cluster_execution_revision":1,',
  '"cluster_execution_revision":1,"cluster_legacy_env_migration_plan":1,',
);

export const pg0070ClusterLegacyEnvMigrationPlansMigration =
  definePostgresSqlMigration({
    id: 'pg-0070-cluster-legacy-env-migration-plans',
    statements: [
      `
CREATE TABLE "ql3"."cluster_legacy_env_migration_plans" (
  plan_id varchar(128) PRIMARY KEY,
  mutation_id varchar(128) NOT NULL,
  project_id varchar(128) NOT NULL,
  plan_digest char(64) NOT NULL,
  reconciliation_bundle_digest char(64) NOT NULL,
  decision_digest char(64) NOT NULL,
  candidate_set_digest char(64) NOT NULL,
  source_row_count integer NOT NULL,
  active_row_count integer NOT NULL,
  disabled_row_count integer NOT NULL,
  effective_binding_count integer NOT NULL,
  secret_ref varchar(512) NOT NULL,
  task_revision_set_digest char(64) NOT NULL,
  trigger_revision_set_digest char(64) NOT NULL,
  task_count integer NOT NULL,
  trigger_count integer NOT NULL,
  total_effective_bytes integer NOT NULL,
  planned_at_ms bigint NOT NULL,
  plan_json jsonb NOT NULL,
  CONSTRAINT ql3_cluster_legacy_env_plan_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_cluster_legacy_env_plan_identity_check CHECK (
    plan_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_cluster_legacy_env_plan_digest_check CHECK (
    plan_digest ~ '^[0-9a-f]{64}$' AND
    reconciliation_bundle_digest ~ '^[0-9a-f]{64}$' AND
    decision_digest ~ '^[0-9a-f]{64}$' AND
    candidate_set_digest ~ '^[0-9a-f]{64}$' AND
    task_revision_set_digest ~ '^[0-9a-f]{64}$' AND
    trigger_revision_set_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_cluster_legacy_env_plan_source_check CHECK (
    source_row_count BETWEEN 1 AND 100000 AND
    active_row_count BETWEEN 1 AND 100000 AND
    disabled_row_count BETWEEN 0 AND 100000 AND
    source_row_count = active_row_count + disabled_row_count AND
    effective_binding_count BETWEEN 1 AND active_row_count
  ),
  CONSTRAINT ql3_cluster_legacy_env_plan_target_check CHECK (
    secret_ref ~ '^qlsecret:v1:[A-Za-z0-9_-]+$' AND
    octet_length(secret_ref) BETWEEN 14 AND 512 AND
    task_count BETWEEN 1 AND 100000 AND
    trigger_count BETWEEN 0 AND 500000 AND
    total_effective_bytes BETWEEN 1 AND 65536
  ),
  CONSTRAINT ql3_cluster_legacy_env_plan_time_check CHECK (
    planned_at_ms >= 0
  ),
  CONSTRAINT ql3_cluster_legacy_env_plan_json_check CHECK (
    jsonb_typeof(plan_json) = 'object' AND
    octet_length(plan_json::text) BETWEEN 2 AND 8192 AND
    plan_json = jsonb_build_object(
      'schema', 'qinglong/cluster-legacy-env-migration-plan@v1',
      'planId', plan_id,
      'mutationId', mutation_id,
      'projectId', project_id,
      'source', jsonb_build_object(
        'reconciliationBundleDigest', reconciliation_bundle_digest,
        'decisionDigest', decision_digest,
        'candidateSetDigest', candidate_set_digest,
        'sourceRowCount', source_row_count,
        'activeRowCount', active_row_count,
        'disabledRowCount', disabled_row_count,
        'effectiveBindingCount', effective_binding_count
      ),
      'target', jsonb_build_object(
        'secretRef', secret_ref,
        'taskRevisionSetDigest', task_revision_set_digest,
        'triggerRevisionSetDigest', trigger_revision_set_digest,
        'taskCount', task_count,
        'triggerCount', trigger_count,
        'totalEffectiveBytes', total_effective_bytes
      ),
      'plannedAtMs', planned_at_ms,
      'planDigest', plan_digest
    )
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_cluster_legacy_env_plan_mutation_uidx ON "ql3"."cluster_legacy_env_migration_plans" (mutation_id)`,
      `CREATE UNIQUE INDEX ql3_cluster_legacy_env_plan_digest_uidx ON "ql3"."cluster_legacy_env_migration_plans" (plan_digest)`,
      `CREATE INDEX ql3_cluster_legacy_env_plan_project_idx ON "ql3"."cluster_legacy_env_migration_plans" (project_id, planned_at_ms, plan_id)`,
      `REVOKE ALL ON "ql3"."cluster_legacy_env_migration_plans" FROM PUBLIC`,
      `GRANT SELECT, INSERT ON "ql3"."cluster_legacy_env_migration_plans" TO ql3_automation_manager`,
      `DO $ql3$ BEGIN UPDATE "ql3"."schema_capabilities" SET contract_version = 69, migration_id = 'pg-0070-cluster-legacy-env-migration-plans', capabilities = '${CAPABILITIES_V69}'::jsonb, updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint WHERE contract_name = 'control-core' AND contract_version = 68 AND migration_id = 'pg-0069-worker-session-management-observation' AND capabilities = '${CAPABILITIES_V68}'::jsonb; IF NOT FOUND THEN RAISE EXCEPTION 'control-core capability is not at version 68' USING ERRCODE = 'check_violation'; END IF; END $ql3$`,
    ],
  });
