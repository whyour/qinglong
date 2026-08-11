import { defineLocalSqliteMigration } from './sqlMigration';

export const local0069PluginPackageQuarantineMigration =
  defineLocalSqliteMigration({
    id: '0069-plugin-package-quarantine',
    statements: [
      `
CREATE UNIQUE INDEX ql3_plugin_package_installs_quarantine_target_uidx
ON "QingLong3PluginPackageInstalls" (
  project_id, package_name, installation_id, lock_digest, record_digest
)
      `,
      `
CREATE UNIQUE INDEX ql3_project_tool_definition_snapshot_withdrawal_uidx
ON "QingLong3ProjectToolDefinitionSnapshots" (
  project_id, active_vector_digest, snapshot_digest
)
      `,
      `
CREATE TABLE "QingLong3PluginPackageQuarantineEvents" (
  event_digest TEXT PRIMARY KEY NOT NULL,
  mutation_id TEXT NOT NULL,
  revocation_receipt_digest TEXT NOT NULL,
  impact_digest TEXT NOT NULL,
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  lock_digest TEXT NOT NULL,
  install_state TEXT NOT NULL,
  install_version INTEGER NOT NULL,
  install_record_digest TEXT NOT NULL,
  active_lock_digest TEXT,
  proposer_type TEXT NOT NULL,
  proposer_id TEXT NOT NULL,
  confirmer_type TEXT NOT NULL,
  confirmer_id TEXT NOT NULL,
  authorization_mode TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  CONSTRAINT ql3_plugin_package_quarantine_install_fk
    FOREIGN KEY (
      project_id, package_name, installation_id, lock_digest,
      install_record_digest
    )
    REFERENCES "QingLong3PluginPackageInstalls" (
      project_id, package_name, installation_id, lock_digest, record_digest
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_quarantine_identity_check CHECK (
    length(mutation_id) BETWEEN 1 AND 128 AND
    length(package_name) BETWEEN 1 AND 63 AND
    length(installation_id) BETWEEN 1 AND 128 AND
    install_state IN ('queued','staged','activating','active') AND
    install_version BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_plugin_package_quarantine_state_check CHECK (
    (
      install_state = 'active' AND active_lock_digest = lock_digest
    ) OR (
      install_state <> 'active' AND
      (active_lock_digest IS NULL OR active_lock_digest <> lock_digest)
    )
  ),
  CONSTRAINT ql3_plugin_package_quarantine_subject_check CHECK (
    proposer_type IN ('user','api_app','mcp_client','agent','system','worker') AND
    confirmer_type IN ('user','api_app','mcp_client','agent','system','worker') AND
    length(proposer_id) BETWEEN 1 AND 255 AND
    length(confirmer_id) BETWEEN 1 AND 255 AND
    authorization_mode IN ('dual_control','break_glass') AND
    (
      authorization_mode = 'break_glass' OR
      proposer_type <> confirmer_type OR proposer_id <> confirmer_id
    ) AND
    reason_code IN (
      'suspected_key_compromise','confirmed_key_compromise'
    )
  ),
  CONSTRAINT ql3_plugin_package_quarantine_digest_check CHECK (
    length(event_digest) = 64 AND
      event_digest NOT GLOB '*[^0-9a-f]*' AND
    length(revocation_receipt_digest) = 64 AND
      revocation_receipt_digest NOT GLOB '*[^0-9a-f]*' AND
    length(impact_digest) = 64 AND
      impact_digest NOT GLOB '*[^0-9a-f]*' AND
    length(lock_digest) = 64 AND
      lock_digest NOT GLOB '*[^0-9a-f]*' AND
    length(install_record_digest) = 64 AND
      install_record_digest NOT GLOB '*[^0-9a-f]*' AND
    (
      active_lock_digest IS NULL OR
      length(active_lock_digest) = 64 AND
        active_lock_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CONSTRAINT ql3_plugin_package_quarantine_json_check CHECK (
    length(CAST(event_json AS BLOB)) BETWEEN 2 AND 262144 AND
    json_valid(event_json) AND json_type(event_json) = 'object' AND
    json_extract(event_json, '$.schema') =
      'qinglong/plugin-package-quarantine-event@v1' AND
    json_extract(event_json, '$.mutationId') = mutation_id AND
    json_extract(event_json, '$.revocationReceiptDigest') =
      revocation_receipt_digest AND
    json_extract(event_json, '$.impactDigest') = impact_digest AND
    json_extract(event_json, '$.target.projectId') = project_id AND
    json_extract(event_json, '$.target.packageName') = package_name AND
    json_extract(event_json, '$.target.installationId') = installation_id AND
    json_extract(event_json, '$.target.lockDigest') = lock_digest AND
    json_extract(event_json, '$.target.installState') = install_state AND
    json_extract(event_json, '$.target.installVersion') = install_version AND
    json_extract(event_json, '$.target.installRecordDigest') =
      install_record_digest AND
    (
      (
        active_lock_digest IS NULL AND
        json_type(event_json, '$.target.activeLockDigest') = 'null'
      ) OR
      json_extract(event_json, '$.target.activeLockDigest') =
        active_lock_digest
    ) AND
    json_extract(event_json, '$.proposer.type') = proposer_type AND
    json_extract(event_json, '$.proposer.id') = proposer_id AND
    json_extract(event_json, '$.confirmer.type') = confirmer_type AND
    json_extract(event_json, '$.confirmer.id') = confirmer_id AND
    json_extract(event_json, '$.authorizationMode') = authorization_mode AND
    json_extract(event_json, '$.reasonCode') = reason_code AND
    json_extract(event_json, '$.occurredAtMs') = occurred_at_ms AND
    json_extract(event_json, '$.eventDigest') = event_digest
  ),
  CONSTRAINT ql3_plugin_package_quarantine_time_check CHECK (
    occurred_at_ms >= 0
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_quarantine_mutation_uidx ON "QingLong3PluginPackageQuarantineEvents" (mutation_id)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_quarantine_target_uidx ON "QingLong3PluginPackageQuarantineEvents" (project_id, package_name, installation_id, lock_digest)`,
      `CREATE INDEX ql3_plugin_package_quarantine_lock_idx ON "QingLong3PluginPackageQuarantineEvents" (lock_digest, project_id, package_name)`,
      `CREATE INDEX ql3_plugin_package_quarantine_project_idx ON "QingLong3PluginPackageQuarantineEvents" (project_id, package_name, occurred_at_ms, event_digest)`,
      `
CREATE TABLE "QingLong3PluginPackageWithdrawalReceipts" (
  event_digest TEXT PRIMARY KEY NOT NULL,
  receipt_digest TEXT NOT NULL,
  project_id TEXT NOT NULL,
  capability_status TEXT NOT NULL,
  task_count INTEGER NOT NULL,
  previous_active_vector_digest TEXT,
  current_active_vector_digest TEXT,
  current_tool_snapshot_digest TEXT,
  retained_source_count INTEGER NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  CONSTRAINT ql3_plugin_package_withdrawal_event_fk
    FOREIGN KEY (event_digest)
    REFERENCES "QingLong3PluginPackageQuarantineEvents" (event_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_withdrawal_snapshot_fk
    FOREIGN KEY (
      project_id, current_active_vector_digest, current_tool_snapshot_digest
    )
    REFERENCES "QingLong3ProjectToolDefinitionSnapshots" (
      project_id, active_vector_digest, snapshot_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_withdrawal_disposition_check CHECK (
    (
      capability_status = 'not_active' AND
      task_count = 0 AND
      previous_active_vector_digest IS NULL AND
      current_active_vector_digest IS NULL AND
      current_tool_snapshot_digest IS NULL AND
      retained_source_count = 0
    ) OR (
      capability_status = 'withdrawn' AND
      task_count BETWEEN 0 AND 128 AND
      previous_active_vector_digest IS NOT NULL AND
      current_active_vector_digest IS NOT NULL AND
      previous_active_vector_digest <> current_active_vector_digest AND
      current_tool_snapshot_digest IS NOT NULL AND
      retained_source_count BETWEEN 0 AND 128
    )
  ),
  CONSTRAINT ql3_plugin_package_withdrawal_digest_check CHECK (
    length(event_digest) = 64 AND
      event_digest NOT GLOB '*[^0-9a-f]*' AND
    length(receipt_digest) = 64 AND
      receipt_digest NOT GLOB '*[^0-9a-f]*' AND
    (
      previous_active_vector_digest IS NULL OR
      length(previous_active_vector_digest) = 64 AND
        previous_active_vector_digest NOT GLOB '*[^0-9a-f]*'
    ) AND
    (
      current_active_vector_digest IS NULL OR
      length(current_active_vector_digest) = 64 AND
        current_active_vector_digest NOT GLOB '*[^0-9a-f]*'
    ) AND
    (
      current_tool_snapshot_digest IS NULL OR
      length(current_tool_snapshot_digest) = 64 AND
        current_tool_snapshot_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CONSTRAINT ql3_plugin_package_withdrawal_json_check CHECK (
    length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 8388608 AND
    json_valid(receipt_json) AND json_type(receipt_json) = 'object' AND
    json_extract(receipt_json, '$.schema') =
      'qinglong/plugin-package-withdrawal-receipt@v1' AND
    json_extract(receipt_json, '$.eventDigest') = event_digest AND
    json_extract(receipt_json, '$.target.projectId') = project_id AND
    json_extract(receipt_json, '$.capability.status') = capability_status AND
    json_array_length(
      json_extract(receipt_json, '$.capability.taskWithdrawals')
    ) = task_count AND
    (
      (
        previous_active_vector_digest IS NULL AND
        json_type(
          receipt_json, '$.capability.previousActiveVectorDigest'
        ) = 'null'
      ) OR
      json_extract(
        receipt_json, '$.capability.previousActiveVectorDigest'
      ) = previous_active_vector_digest
    ) AND
    (
      (
        current_active_vector_digest IS NULL AND
        json_type(
          receipt_json, '$.capability.currentActiveVectorDigest'
        ) = 'null'
      ) OR
      json_extract(
        receipt_json, '$.capability.currentActiveVectorDigest'
      ) = current_active_vector_digest
    ) AND
    (
      (
        current_tool_snapshot_digest IS NULL AND
        json_type(
          receipt_json, '$.capability.currentToolSnapshotDigest'
        ) = 'null'
      ) OR
      json_extract(
        receipt_json, '$.capability.currentToolSnapshotDigest'
      ) = current_tool_snapshot_digest
    ) AND
    json_extract(receipt_json, '$.capability.retainedSourceCount') =
      retained_source_count AND
    json_extract(receipt_json, '$.committedAtMs') = committed_at_ms AND
    json_extract(receipt_json, '$.receiptDigest') = receipt_digest
  ),
  CONSTRAINT ql3_plugin_package_withdrawal_time_check CHECK (
    committed_at_ms >= 0
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_withdrawal_receipt_uidx ON "QingLong3PluginPackageWithdrawalReceipts" (receipt_digest)`,
      `CREATE INDEX ql3_plugin_package_withdrawal_snapshot_idx ON "QingLong3PluginPackageWithdrawalReceipts" (current_tool_snapshot_digest, event_digest)`,
      `
CREATE TABLE "QingLong3PluginPackageWithdrawalTasks" (
  event_digest TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  previous_revision INTEGER NOT NULL,
  disabled_revision INTEGER NOT NULL,
  previous_content_digest TEXT NOT NULL,
  disabled_content_digest TEXT NOT NULL,
  PRIMARY KEY (event_digest, task_id),
  CONSTRAINT ql3_plugin_package_withdrawal_task_receipt_fk
    FOREIGN KEY (event_digest)
    REFERENCES "QingLong3PluginPackageWithdrawalReceipts" (event_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_withdrawal_task_previous_fk
    FOREIGN KEY (project_id, task_id, previous_revision)
    REFERENCES "QingLong3TaskDefinitionRevisions" (
      project_id, task_id, revision
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_withdrawal_task_disabled_fk
    FOREIGN KEY (project_id, task_id, disabled_revision)
    REFERENCES "QingLong3TaskDefinitionRevisions" (
      project_id, task_id, revision
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_withdrawal_task_identity_check CHECK (
    length(task_id) BETWEEN 1 AND 128 AND
    previous_revision BETWEEN 1 AND 2147483646 AND
    disabled_revision = previous_revision + 1
  ),
  CONSTRAINT ql3_plugin_package_withdrawal_task_digest_check CHECK (
    length(event_digest) = 64 AND
      event_digest NOT GLOB '*[^0-9a-f]*' AND
    length(previous_content_digest) = 64 AND
      previous_content_digest NOT GLOB '*[^0-9a-f]*' AND
    length(disabled_content_digest) = 64 AND
      disabled_content_digest NOT GLOB '*[^0-9a-f]*'
  )
)
      `,
      `CREATE INDEX ql3_plugin_package_withdrawal_task_task_idx ON "QingLong3PluginPackageWithdrawalTasks" (project_id, task_id, event_digest)`,
    ],
  });
