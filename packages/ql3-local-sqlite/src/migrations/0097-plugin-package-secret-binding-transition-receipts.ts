import { defineLocalSqliteMigration } from './sqlMigration';
import { LOCAL_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_RECEIPT_TRIGGER_SQL } from '../plugin-package/secret-binding/transitionReceiptSchemaContract';

export const local0097PluginPackageSecretBindingTransitionReceiptsMigration =
  defineLocalSqliteMigration({
    id: '0097-plugin-package-secret-binding-transition-receipts',
    statements: [
      `
CREATE TABLE "QingLong3PluginPackageSecretBindingTransitionReceipts" (
  generation_digest TEXT PRIMARY KEY NOT NULL,
  transition_digest TEXT NOT NULL,
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  lock_digest TEXT NOT NULL,
  generation INTEGER NOT NULL,
  manifest_digest TEXT NOT NULL,
  previous_active_lock_digest TEXT NOT NULL,
  authority_kind TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  binding_digest TEXT,
  committed_at_ms INTEGER NOT NULL,
  receipt_digest TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  CONSTRAINT ql3_plugin_package_secret_binding_transition_receipt_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "QingLong3PluginPackageInstalls" (installation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_secret_binding_transition_receipt_binding_fk
    FOREIGN KEY (binding_digest)
    REFERENCES "QingLong3PluginPackageSecretBindings" (binding_digest)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_secret_binding_transition_receipt_identity_check CHECK (
    length(project_id) BETWEEN 1 AND 128 AND
    length(package_name) BETWEEN 1 AND 63 AND
    length(installation_id) BETWEEN 1 AND 128 AND
    generation BETWEEN 2 AND 2147483647 AND
    authority_kind IN ('approved-action-execution','local-owner-confirmation') AND
    committed_at_ms >= 0
  ),
  CONSTRAINT ql3_plugin_package_secret_binding_transition_receipt_digest_check CHECK (
    length(generation_digest) = 64 AND generation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(transition_digest) = 64 AND transition_digest NOT GLOB '*[^0-9a-f]*' AND
    length(lock_digest) = 64 AND lock_digest NOT GLOB '*[^0-9a-f]*' AND
    length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*' AND
    length(previous_active_lock_digest) = 64 AND previous_active_lock_digest NOT GLOB '*[^0-9a-f]*' AND
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*' AND
    (binding_digest IS NULL OR
      (length(binding_digest) = 64 AND binding_digest NOT GLOB '*[^0-9a-f]*')) AND
    length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_plugin_package_secret_binding_transition_receipt_json_check CHECK (
    length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 196608 AND
    json_valid(receipt_json) AND json_type(receipt_json) = 'object' AND
    json_extract(receipt_json, '$.schema') = 'qinglong/plugin-package-secret-binding-transition-receipt@v1' AND
    json_extract(receipt_json, '$.transitionPlan.transitionDigest') = transition_digest AND
    json_extract(receipt_json, '$.transitionPlan.nextTarget.generationDigest') = generation_digest AND
    json_extract(receipt_json, '$.transitionPlan.nextTarget.projectId') = project_id AND
    json_extract(receipt_json, '$.transitionPlan.nextTarget.packageName') = package_name AND
    json_extract(receipt_json, '$.transitionPlan.nextTarget.installationId') = installation_id AND
    json_extract(receipt_json, '$.transitionPlan.nextTarget.lockDigest') = lock_digest AND
    json_extract(receipt_json, '$.transitionPlan.nextTarget.generation') = generation AND
    json_extract(receipt_json, '$.transitionPlan.nextTarget.manifestDigest') = manifest_digest AND
    json_extract(receipt_json, '$.transitionPlan.previousActiveLockDigest') = previous_active_lock_digest AND
    json_extract(receipt_json, '$.authority.kind') = authority_kind AND
    json_extract(receipt_json, '$.authority.evidenceDigest') = evidence_digest AND
    json_extract(receipt_json, '$.bindingDigest') IS binding_digest AND
    json_extract(receipt_json, '$.committedAtMs') = committed_at_ms AND
    json_extract(receipt_json, '$.receiptDigest') = receipt_digest
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_secret_binding_transition_receipt_transition_uidx ON "QingLong3PluginPackageSecretBindingTransitionReceipts" (transition_digest)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_secret_binding_transition_receipt_digest_uidx ON "QingLong3PluginPackageSecretBindingTransitionReceipts" (receipt_digest)`,
      `CREATE INDEX ql3_plugin_package_secret_binding_transition_receipt_install_idx ON "QingLong3PluginPackageSecretBindingTransitionReceipts" (installation_id, generation_digest)`,
      LOCAL_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_RECEIPT_TRIGGER_SQL,
    ],
  });
