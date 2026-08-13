import { CAPABILITIES_V61 } from './pg-0062-plugin-package-secret-binding-target-guard';
import { definePostgresSqlMigration } from './sqlMigration';

export const CAPABILITIES_V62 = CAPABILITIES_V61.replace(
  '"plugin_package_secret_binding_transition":1,',
  '"plugin_package_secret_binding_transition":1,"plugin_package_secret_binding_transition_receipt":1,',
);

export const pg0063PluginPackageSecretBindingTransitionReceiptsMigration =
  definePostgresSqlMigration({
    id: 'pg-0063-plugin-package-secret-binding-transition-receipts',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_secret_binding_transition_receipts" (
  generation_digest char(64) PRIMARY KEY,
  transition_digest char(64) NOT NULL,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  installation_id varchar(128) NOT NULL,
  lock_digest char(64) NOT NULL,
  generation integer NOT NULL,
  manifest_digest char(64) NOT NULL,
  previous_active_lock_digest char(64) NOT NULL,
  authority_kind varchar(32) NOT NULL,
  evidence_digest char(64) NOT NULL,
  binding_digest char(64),
  committed_at_ms bigint NOT NULL,
  receipt_digest char(64) NOT NULL,
  receipt_json jsonb NOT NULL,
  CONSTRAINT ql3_plugin_package_secret_binding_transition_receipt_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_secret_binding_transition_receipt_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "ql3"."plugin_package_installs" (installation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_package_secret_transition_receipt_identity_check CHECK (
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' AND
    installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    generation BETWEEN 2 AND 2147483647 AND
    authority_kind = 'approved-action-execution' AND
    committed_at_ms >= 0
  ),
  CONSTRAINT ql3_package_secret_transition_receipt_digest_check CHECK (
    generation_digest ~ '^[0-9a-f]{64}$' AND
    transition_digest ~ '^[0-9a-f]{64}$' AND
    lock_digest ~ '^[0-9a-f]{64}$' AND
    manifest_digest ~ '^[0-9a-f]{64}$' AND
    previous_active_lock_digest ~ '^[0-9a-f]{64}$' AND
    evidence_digest ~ '^[0-9a-f]{64}$' AND
    (binding_digest IS NULL OR binding_digest ~ '^[0-9a-f]{64}$') AND
    receipt_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_package_secret_transition_receipt_json_check CHECK (
    jsonb_typeof(receipt_json) = 'object' AND
    octet_length(receipt_json::text) BETWEEN 2 AND 196608 AND
    receipt_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-secret-binding-transition-receipt@v1',
      'transitionPlan', jsonb_build_object(
        'schema', 'qinglong/plugin-package-secret-binding-transition-plan@v1',
        'transitionDigest', transition_digest,
        'previousActiveLockDigest', previous_active_lock_digest,
        'nextTarget', jsonb_build_object(
          'generationDigest', generation_digest,
          'projectId', project_id,
          'packageName', package_name,
          'installationId', installation_id,
          'lockDigest', lock_digest,
          'generation', generation,
          'manifestDigest', manifest_digest
        )
      ),
      'authority', jsonb_build_object(
        'kind', authority_kind,
        'evidenceDigest', evidence_digest
      ),
      'bindingDigest', binding_digest,
      'committedAtMs', committed_at_ms,
      'receiptDigest', receipt_digest
    )
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_package_secret_transition_receipt_transition_uidx ON "ql3"."plugin_package_secret_binding_transition_receipts" (transition_digest)`,
      `CREATE UNIQUE INDEX ql3_package_secret_transition_receipt_digest_uidx ON "ql3"."plugin_package_secret_binding_transition_receipts" (receipt_digest)`,
      `CREATE INDEX ql3_package_secret_transition_receipt_install_idx ON "ql3"."plugin_package_secret_binding_transition_receipts" (installation_id, generation_digest)`,
      `
CREATE FUNCTION "ql3"."enforce_plugin_package_secret_binding_transition_receipt_target"()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, ql3
AS $ql3$
BEGIN
  PERFORM 1
    FROM "ql3"."plugin_package_install_heads" AS head
    JOIN "ql3"."plugin_package_installs" AS install
      ON install.installation_id = head.installation_id
     AND install.project_id = head.project_id
     AND install.package_name = head.package_name
    JOIN "ql3"."plugin_package_installs" AS previous
      ON previous.project_id = install.project_id
     AND previous.package_name = install.package_name
     AND previous.lock_digest = install.previous_active_lock_digest
   WHERE head.project_id = NEW.project_id
     AND head.package_name = NEW.package_name
     AND install.installation_id = NEW.installation_id
     AND install.lock_digest = NEW.lock_digest
     AND install.target_generation = NEW.generation
     AND install.lock_json ->> 'manifestDigest' = NEW.manifest_digest
     AND install.state = 'staged'
     AND install.previous_active_lock_digest = NEW.previous_active_lock_digest
     AND install.active_lock_digest = install.previous_active_lock_digest
     AND install.target_generation = (
       SELECT MAX(history.target_generation)
         FROM "ql3"."plugin_package_installs" AS history
        WHERE history.project_id = install.project_id
          AND history.package_name = install.package_name
     )
     AND previous.state = 'active'
     AND previous.active_lock_digest = previous.lock_digest
     AND previous.target_generation < install.target_generation
     AND (
       (NEW.binding_digest IS NULL AND NOT EXISTS (
         SELECT 1 FROM "ql3"."plugin_package_secret_bindings" AS binding
          WHERE binding.generation_digest = NEW.generation_digest
       )) OR
       EXISTS (
         SELECT 1 FROM "ql3"."plugin_package_secret_bindings" AS binding
          WHERE binding.generation_digest = NEW.generation_digest
            AND binding.binding_digest = NEW.binding_digest
            AND binding.project_id = NEW.project_id
            AND binding.package_name = NEW.package_name
            AND binding.installation_id = NEW.installation_id
            AND binding.lock_digest = NEW.lock_digest
            AND binding.generation = NEW.generation
            AND binding.manifest_digest = NEW.manifest_digest
            AND binding.authority_kind = NEW.authority_kind
            AND binding.evidence_digest = NEW.evidence_digest
            AND binding.bound_at_ms = NEW.committed_at_ms
       )
     )
   FOR SHARE OF head, install, previous;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Plugin Package Secret binding transition receipt target is not reviewed staged generation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$ql3$
      `.trim(),
      `REVOKE ALL ON "ql3"."plugin_package_secret_binding_transition_receipts" FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress`,
      `GRANT SELECT, INSERT ON "ql3"."plugin_package_secret_binding_transition_receipts" TO ql3_package_executor`,
      `REVOKE ALL ON FUNCTION "ql3"."enforce_plugin_package_secret_binding_transition_receipt_target"() FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress`,
      `CREATE TRIGGER ql3_package_secret_transition_receipt_target_guard BEFORE INSERT ON "ql3"."plugin_package_secret_binding_transition_receipts" FOR EACH ROW EXECUTE FUNCTION "ql3"."enforce_plugin_package_secret_binding_transition_receipt_target"()`,
      `DO $ql3$ BEGIN UPDATE "ql3"."schema_capabilities" SET contract_version = 62, migration_id = 'pg-0063-plugin-package-secret-binding-transition-receipts', capabilities = '${CAPABILITIES_V62}'::jsonb, updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint WHERE contract_name = 'control-core' AND contract_version = 61 AND migration_id = 'pg-0062-plugin-package-secret-binding-target-guard' AND capabilities = '${CAPABILITIES_V61}'::jsonb; IF NOT FOUND THEN RAISE EXCEPTION 'control-core capability is not at version 61' USING ERRCODE = 'check_violation'; END IF; END $ql3$`,
    ],
  });
