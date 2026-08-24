import { definePostgresSqlMigration } from '../migrations/sqlMigration';
import { CAPABILITIES_V69 } from './pg-0070-cluster-legacy-env-migration-plans';

export const CAPABILITIES_V70 = CAPABILITIES_V69.replace(
  '"cluster_legacy_env_migration_plan":1,',
  '"cluster_legacy_env_migration_application":1,"cluster_legacy_env_migration_plan":1,',
);

export const pg0071ClusterLegacyEnvMigrationApplicationsMigration =
  definePostgresSqlMigration({
    id: 'pg-0071-cluster-legacy-env-migration-applications',
    statements: [
      `
CREATE TABLE "ql3"."cluster_legacy_env_migration_application_receipts" (
  application_id varchar(128) PRIMARY KEY,
  mutation_id uuid NOT NULL,
  project_id varchar(128) NOT NULL,
  plan_id varchar(128) NOT NULL,
  plan_digest char(64) NOT NULL,
  environment_bundle_ref varchar(512) NOT NULL,
  task_revision_set_digest char(64) NOT NULL,
  trigger_revision_set_digest char(64) NOT NULL,
  task_mutation_set_digest char(64) NOT NULL,
  trigger_mutation_set_digest char(64) NOT NULL,
  task_count integer NOT NULL,
  trigger_count integer NOT NULL,
  committed_at_ms bigint NOT NULL,
  receipt_digest char(64) NOT NULL,
  receipt_json jsonb NOT NULL,
  CONSTRAINT ql3_cluster_legacy_env_application_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_cluster_legacy_env_application_plan_fk
    FOREIGN KEY (plan_id) REFERENCES "ql3"."cluster_legacy_env_migration_plans" (plan_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_cluster_legacy_env_application_identity_check CHECK (
    application_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    plan_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_cluster_legacy_env_application_digest_check CHECK (
    plan_digest ~ '^[0-9a-f]{64}$' AND
    task_revision_set_digest ~ '^[0-9a-f]{64}$' AND
    trigger_revision_set_digest ~ '^[0-9a-f]{64}$' AND
    task_mutation_set_digest ~ '^[0-9a-f]{64}$' AND
    trigger_mutation_set_digest ~ '^[0-9a-f]{64}$' AND
    receipt_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_cluster_legacy_env_application_target_check CHECK (
    environment_bundle_ref ~ '^qlsecret:v1:[A-Za-z0-9_-]+$' AND
    octet_length(environment_bundle_ref) BETWEEN 14 AND 512 AND
    task_count BETWEEN 1 AND 100000 AND
    trigger_count BETWEEN 0 AND 500000 AND
    committed_at_ms >= 0
  ),
  CONSTRAINT ql3_cluster_legacy_env_application_json_check CHECK (
    jsonb_typeof(receipt_json) = 'object' AND
    octet_length(receipt_json::text) BETWEEN 2 AND 8192 AND
    receipt_json = jsonb_build_object(
      'schema', 'qinglong/cluster-legacy-env-migration-application-receipt@v1',
      'applicationId', application_id,
      'mutationId', mutation_id::text,
      'projectId', project_id,
      'planId', plan_id,
      'planDigest', plan_digest,
      'environmentBundleRef', environment_bundle_ref,
      'taskRevisionSetDigest', task_revision_set_digest,
      'triggerRevisionSetDigest', trigger_revision_set_digest,
      'taskMutationSetDigest', task_mutation_set_digest,
      'triggerMutationSetDigest', trigger_mutation_set_digest,
      'taskCount', task_count,
      'triggerCount', trigger_count,
      'committedAtMs', committed_at_ms,
      'receiptDigest', receipt_digest
    )
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_cluster_legacy_env_application_mutation_uidx ON "ql3"."cluster_legacy_env_migration_application_receipts" (mutation_id)`,
      `CREATE UNIQUE INDEX ql3_cluster_legacy_env_application_project_uidx ON "ql3"."cluster_legacy_env_migration_application_receipts" (application_id, project_id)`,
      `CREATE UNIQUE INDEX ql3_cluster_legacy_env_application_plan_uidx ON "ql3"."cluster_legacy_env_migration_application_receipts" (plan_id)`,
      `CREATE UNIQUE INDEX ql3_cluster_legacy_env_application_digest_uidx ON "ql3"."cluster_legacy_env_migration_application_receipts" (receipt_digest)`,
      `CREATE INDEX ql3_cluster_legacy_env_application_project_idx ON "ql3"."cluster_legacy_env_migration_application_receipts" (project_id, committed_at_ms, application_id)`,
      `
CREATE TABLE "ql3"."cluster_legacy_env_migration_application_tasks" (
  application_id varchar(128) NOT NULL,
  ordinal integer NOT NULL,
  project_id varchar(128) NOT NULL,
  task_id varchar(128) NOT NULL,
  previous_revision integer NOT NULL,
  previous_content_digest char(64) NOT NULL,
  mutation_id uuid NOT NULL,
  revision integer NOT NULL,
  content_digest char(64) NOT NULL,
  execution_content_digest char(64),
  item_digest char(64) NOT NULL,
  CONSTRAINT cluster_legacy_env_migration_application_tasks_pkey
    PRIMARY KEY (application_id, ordinal),
  CONSTRAINT ql3_cluster_legacy_env_application_task_receipt_fk
    FOREIGN KEY (application_id, project_id)
    REFERENCES "ql3"."cluster_legacy_env_migration_application_receipts"
      (application_id, project_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_cluster_legacy_env_application_task_identity_check CHECK (
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    char_length(task_id) BETWEEN 1 AND 128 AND task_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ql3_cluster_legacy_env_application_task_revision_check CHECK (
    ordinal BETWEEN 0 AND 99999 AND
    previous_revision BETWEEN 1 AND 2147483646 AND
    revision = previous_revision + 1
  ),
  CONSTRAINT ql3_cluster_legacy_env_application_task_digest_check CHECK (
    previous_content_digest ~ '^[0-9a-f]{64}$' AND
    content_digest ~ '^[0-9a-f]{64}$' AND
    (execution_content_digest IS NULL OR execution_content_digest ~ '^[0-9a-f]{64}$') AND
    item_digest ~ '^[0-9a-f]{64}$'
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_cluster_legacy_env_application_task_uidx ON "ql3"."cluster_legacy_env_migration_application_tasks" (application_id, task_id)`,
      `CREATE UNIQUE INDEX ql3_cluster_legacy_env_application_task_revision_uidx ON "ql3"."cluster_legacy_env_migration_application_tasks" (application_id, project_id, task_id, revision, content_digest)`,
      `
CREATE TABLE "ql3"."cluster_legacy_env_migration_application_triggers" (
  application_id varchar(128) NOT NULL,
  ordinal integer NOT NULL,
  project_id varchar(128) NOT NULL,
  trigger_id varchar(128) NOT NULL,
  task_id varchar(128) NOT NULL,
  previous_revision integer NOT NULL,
  previous_content_digest char(64) NOT NULL,
  previous_task_revision integer NOT NULL,
  previous_task_content_digest char(64) NOT NULL,
  mutation_id uuid NOT NULL,
  revision integer NOT NULL,
  content_digest char(64) NOT NULL,
  task_revision integer NOT NULL,
  task_content_digest char(64) NOT NULL,
  item_digest char(64) NOT NULL,
  CONSTRAINT cluster_legacy_env_migration_application_triggers_pkey
    PRIMARY KEY (application_id, ordinal),
  CONSTRAINT ql3_cluster_legacy_env_application_trigger_receipt_fk
    FOREIGN KEY (application_id, project_id)
    REFERENCES "ql3"."cluster_legacy_env_migration_application_receipts"
      (application_id, project_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_cluster_legacy_env_application_trigger_task_fk
    FOREIGN KEY (application_id, project_id, task_id, task_revision, task_content_digest)
    REFERENCES "ql3"."cluster_legacy_env_migration_application_tasks"
      (application_id, project_id, task_id, revision, content_digest)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_cluster_legacy_env_application_trigger_identity_check CHECK (
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    char_length(trigger_id) BETWEEN 1 AND 128 AND trigger_id !~ '[[:cntrl:]]' AND
    char_length(task_id) BETWEEN 1 AND 128 AND task_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ql3_cluster_legacy_env_application_trigger_revision_check CHECK (
    ordinal BETWEEN 0 AND 499999 AND
    previous_revision BETWEEN 1 AND 2147483646 AND
    revision = previous_revision + 1 AND
    previous_task_revision BETWEEN 1 AND 2147483647 AND
    task_revision BETWEEN 2 AND 2147483647
  ),
  CONSTRAINT ql3_cluster_legacy_env_application_trigger_digest_check CHECK (
    previous_content_digest ~ '^[0-9a-f]{64}$' AND
    previous_task_content_digest ~ '^[0-9a-f]{64}$' AND
    content_digest ~ '^[0-9a-f]{64}$' AND
    task_content_digest ~ '^[0-9a-f]{64}$' AND
    item_digest ~ '^[0-9a-f]{64}$'
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_cluster_legacy_env_application_trigger_uidx ON "ql3"."cluster_legacy_env_migration_application_triggers" (application_id, trigger_id)`,
      `REVOKE ALL ON "ql3"."cluster_legacy_env_migration_application_receipts" FROM PUBLIC`,
      `REVOKE ALL ON "ql3"."cluster_legacy_env_migration_application_tasks" FROM PUBLIC`,
      `REVOKE ALL ON "ql3"."cluster_legacy_env_migration_application_triggers" FROM PUBLIC`,
      `GRANT SELECT, INSERT ON "ql3"."cluster_legacy_env_migration_application_receipts" TO ql3_automation_manager`,
      `GRANT SELECT, INSERT ON "ql3"."cluster_legacy_env_migration_application_tasks" TO ql3_automation_manager`,
      `GRANT SELECT, INSERT ON "ql3"."cluster_legacy_env_migration_application_triggers" TO ql3_automation_manager`,
      `DO $ql3$ BEGIN UPDATE "ql3"."schema_capabilities" SET contract_version = 70, migration_id = 'pg-0071-cluster-legacy-env-migration-applications', capabilities = '${CAPABILITIES_V70}'::jsonb, updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint WHERE contract_name = 'control-core' AND contract_version = 69 AND migration_id = 'pg-0070-cluster-legacy-env-migration-plans' AND capabilities = '${CAPABILITIES_V69}'::jsonb; IF NOT FOUND THEN RAISE EXCEPTION 'control-core capability is not at version 69' USING ERRCODE = 'check_violation'; END IF; END $ql3$`,
    ],
  });
