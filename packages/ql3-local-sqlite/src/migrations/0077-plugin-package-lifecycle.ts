import { defineLocalSqliteMigration } from './sqlMigration';

export const local0077PluginPackageLifecycleMigration =
  defineLocalSqliteMigration({
    id: '0077-plugin-package-lifecycle',
    statements: [
      `
CREATE UNIQUE INDEX ql3_approved_action_dispatch_lifecycle_uidx
ON "QingLong3ApprovedActionDispatches" (
  dispatch_id, project_id, action_type, action_digest, preview_digest
)
      `,
      `
CREATE TABLE "QingLong3PluginPackageLifecycleEvents" (
  event_digest TEXT PRIMARY KEY NOT NULL,
  mutation_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  approved_action_type TEXT NOT NULL,
  action TEXT NOT NULL,
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  lock_digest TEXT NOT NULL,
  install_version INTEGER NOT NULL,
  install_record_digest TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  expected_disposition TEXT NOT NULL,
  expected_event_digest TEXT,
  generation_digest TEXT NOT NULL,
  materialized_revision_digest TEXT NOT NULL,
  current_tool_snapshot_digest TEXT NOT NULL,
  reference_graph_digest TEXT NOT NULL,
  impact_digest TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  requested_by_type TEXT NOT NULL,
  requested_by_id TEXT NOT NULL,
  approved_by_type TEXT NOT NULL,
  approved_by_id TEXT NOT NULL,
  authorization_mode TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  CONSTRAINT ql3_plugin_package_lifecycle_install_fk
    FOREIGN KEY (
      project_id, package_name, installation_id, lock_digest,
      install_record_digest
    )
    REFERENCES "QingLong3PluginPackageInstalls" (
      project_id, package_name, installation_id, lock_digest, record_digest
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_dispatch_fk
    FOREIGN KEY (
      dispatch_id, project_id, approved_action_type, action_digest,
      impact_digest
    )
    REFERENCES "QingLong3ApprovedActionDispatches" (
      dispatch_id, project_id, action_type, action_digest, preview_digest
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_previous_event_fk
    FOREIGN KEY (expected_event_digest)
    REFERENCES "QingLong3PluginPackageLifecycleEvents" (event_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_identity_check CHECK (
    length(mutation_id) BETWEEN 1 AND 128 AND
    length(dispatch_id) BETWEEN 1 AND 128 AND
    length(package_name) BETWEEN 1 AND 63 AND
    length(installation_id) BETWEEN 1 AND 128 AND
    install_version BETWEEN 1 AND 2147483647 AND
    action IN ('disable','enable','uninstall') AND
    approved_action_type = 'plugin_package.lifecycle.' || action
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_expectation_check CHECK (
    (
      action = 'disable' AND expected_disposition = 'active'
    ) OR (
      action IN ('enable','uninstall') AND
      expected_disposition = 'disabled'
    )
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_origin_check CHECK (
    (
      expected_version = 0 AND
      expected_disposition = 'active' AND
      expected_event_digest IS NULL
    ) OR (
      expected_version BETWEEN 1 AND 2147483646 AND
      expected_event_digest IS NOT NULL
    )
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_subject_check CHECK (
    requested_by_type = 'user' AND approved_by_type = 'user' AND
    length(requested_by_id) BETWEEN 1 AND 255 AND
    length(approved_by_id) BETWEEN 1 AND 255 AND
    authorization_mode IN ('human_confirmation','separation_of_duty') AND
    (
      (
        authorization_mode = 'human_confirmation' AND
        requested_by_id = approved_by_id
      ) OR (
        authorization_mode = 'separation_of_duty' AND
        requested_by_id <> approved_by_id
      )
    )
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_digest_check CHECK (
    length(event_digest) = 64 AND
      event_digest NOT GLOB '*[^0-9a-f]*' AND
    length(lock_digest) = 64 AND
      lock_digest NOT GLOB '*[^0-9a-f]*' AND
    length(install_record_digest) = 64 AND
      install_record_digest NOT GLOB '*[^0-9a-f]*' AND
    length(generation_digest) = 64 AND
      generation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(materialized_revision_digest) = 64 AND
      materialized_revision_digest NOT GLOB '*[^0-9a-f]*' AND
    length(current_tool_snapshot_digest) = 64 AND
      current_tool_snapshot_digest NOT GLOB '*[^0-9a-f]*' AND
    length(reference_graph_digest) = 64 AND
      reference_graph_digest NOT GLOB '*[^0-9a-f]*' AND
    length(impact_digest) = 64 AND
      impact_digest NOT GLOB '*[^0-9a-f]*' AND
    length(action_digest) = 64 AND
      action_digest NOT GLOB '*[^0-9a-f]*' AND
    (
      expected_event_digest IS NULL OR
      length(expected_event_digest) = 64 AND
        expected_event_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_json_check CHECK (
    length(CAST(event_json AS BLOB)) BETWEEN 2 AND 524288 AND
    json_valid(event_json) AND json_type(event_json) = 'object' AND
    json_extract(event_json, '$.schema') =
      'qinglong/plugin-package-lifecycle-event@v1' AND
    json_extract(event_json, '$.mutationId') = mutation_id AND
    json_extract(event_json, '$.dispatchId') = dispatch_id AND
    json_extract(event_json, '$.impact.schema') =
      'qinglong/plugin-package-lifecycle-impact@v1' AND
    json_extract(event_json, '$.impact.action') = action AND
    json_extract(event_json, '$.impact.target.projectId') = project_id AND
    json_extract(event_json, '$.impact.target.packageName') = package_name AND
    json_extract(event_json, '$.impact.target.installationId') =
      installation_id AND
    json_extract(event_json, '$.impact.target.lockDigest') = lock_digest AND
    json_extract(event_json, '$.impact.target.installVersion') =
      install_version AND
    json_extract(event_json, '$.impact.target.installRecordDigest') =
      install_record_digest AND
    json_extract(event_json, '$.impact.expected.version') = expected_version AND
    json_extract(event_json, '$.impact.expected.disposition') =
      expected_disposition AND
    (
      (
        expected_event_digest IS NULL AND
        json_type(event_json, '$.impact.expected.eventDigest') = 'null'
      ) OR
      json_extract(event_json, '$.impact.expected.eventDigest') =
        expected_event_digest
    ) AND
    json_extract(event_json, '$.impact.generationDigest') =
      generation_digest AND
    json_extract(event_json, '$.impact.materializedRevisionDigest') =
      materialized_revision_digest AND
    json_extract(event_json, '$.impact.currentToolSnapshotDigest') =
      current_tool_snapshot_digest AND
    json_extract(event_json, '$.impact.referenceGraphDigest') =
      reference_graph_digest AND
    json_extract(event_json, '$.impact.impactDigest') = impact_digest AND
    json_extract(event_json, '$.actionDigest') = action_digest AND
    json_extract(event_json, '$.requestedBy.type') = requested_by_type AND
    json_extract(event_json, '$.requestedBy.id') = requested_by_id AND
    json_extract(event_json, '$.approvedBy.type') = approved_by_type AND
    json_extract(event_json, '$.approvedBy.id') = approved_by_id AND
    json_extract(event_json, '$.authorizationMode') = authorization_mode AND
    json_extract(event_json, '$.occurredAtMs') = occurred_at_ms AND
    json_extract(event_json, '$.eventDigest') = event_digest
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_time_check CHECK (
    occurred_at_ms >= 0
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_lifecycle_mutation_uidx ON "QingLong3PluginPackageLifecycleEvents" (mutation_id)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_lifecycle_dispatch_uidx ON "QingLong3PluginPackageLifecycleEvents" (dispatch_id)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_lifecycle_target_version_uidx ON "QingLong3PluginPackageLifecycleEvents" (project_id, package_name, installation_id, lock_digest, expected_version)`,
      `CREATE INDEX ql3_plugin_package_lifecycle_project_idx ON "QingLong3PluginPackageLifecycleEvents" (project_id, package_name, occurred_at_ms, event_digest)`,
      `
CREATE TABLE "QingLong3PluginPackageLifecycleHeads" (
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  lock_digest TEXT NOT NULL,
  install_record_digest TEXT NOT NULL,
  version INTEGER NOT NULL,
  disposition TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (project_id, package_name),
  CONSTRAINT ql3_plugin_package_lifecycle_head_install_fk
    FOREIGN KEY (
      project_id, package_name, installation_id, lock_digest,
      install_record_digest
    )
    REFERENCES "QingLong3PluginPackageInstalls" (
      project_id, package_name, installation_id, lock_digest, record_digest
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_head_event_fk
    FOREIGN KEY (event_digest)
    REFERENCES "QingLong3PluginPackageLifecycleEvents" (event_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_head_state_check CHECK (
    version BETWEEN 1 AND 2147483647 AND
    disposition IN ('active','disabled','uninstalled') AND
    updated_at_ms >= 0
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_head_digest_check CHECK (
    length(lock_digest) = 64 AND
      lock_digest NOT GLOB '*[^0-9a-f]*' AND
    length(install_record_digest) = 64 AND
      install_record_digest NOT GLOB '*[^0-9a-f]*' AND
    length(event_digest) = 64 AND
      event_digest NOT GLOB '*[^0-9a-f]*'
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_lifecycle_head_event_uidx ON "QingLong3PluginPackageLifecycleHeads" (event_digest)`,
      `
CREATE TABLE "QingLong3PluginPackageLifecycleReceipts" (
  event_digest TEXT PRIMARY KEY NOT NULL,
  receipt_digest TEXT NOT NULL,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL,
  capability_status TEXT NOT NULL,
  task_count INTEGER NOT NULL,
  previous_active_vector_digest TEXT NOT NULL,
  current_active_vector_digest TEXT NOT NULL,
  current_tool_snapshot_digest TEXT NOT NULL,
  retained_source_count INTEGER NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  CONSTRAINT ql3_plugin_package_lifecycle_receipt_event_fk
    FOREIGN KEY (event_digest)
    REFERENCES "QingLong3PluginPackageLifecycleEvents" (event_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_receipt_snapshot_fk
    FOREIGN KEY (
      project_id, current_active_vector_digest, current_tool_snapshot_digest
    )
    REFERENCES "QingLong3ProjectToolDefinitionSnapshots" (
      project_id, active_vector_digest, snapshot_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_receipt_state_check CHECK (
    (
      action = 'disable' AND capability_status = 'withdrawn' AND
      previous_active_vector_digest <> current_active_vector_digest
    ) OR (
      action = 'enable' AND capability_status = 'restored' AND
      previous_active_vector_digest <> current_active_vector_digest
    ) OR (
      action = 'uninstall' AND capability_status = 'retired' AND
      task_count = 0 AND
      previous_active_vector_digest = current_active_vector_digest
    )
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_receipt_bounds_check CHECK (
    task_count BETWEEN 0 AND 128 AND
    retained_source_count BETWEEN 0 AND 128 AND
    committed_at_ms >= 0
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_receipt_digest_check CHECK (
    length(receipt_digest) = 64 AND
      receipt_digest NOT GLOB '*[^0-9a-f]*' AND
    length(previous_active_vector_digest) = 64 AND
      previous_active_vector_digest NOT GLOB '*[^0-9a-f]*' AND
    length(current_active_vector_digest) = 64 AND
      current_active_vector_digest NOT GLOB '*[^0-9a-f]*' AND
    length(current_tool_snapshot_digest) = 64 AND
      current_tool_snapshot_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_receipt_json_check CHECK (
    length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 524288 AND
    json_valid(receipt_json) AND json_type(receipt_json) = 'object' AND
    json_extract(receipt_json, '$.schema') =
      'qinglong/plugin-package-lifecycle-receipt@v1' AND
    json_extract(receipt_json, '$.eventDigest') = event_digest AND
    json_extract(receipt_json, '$.action') = action AND
    json_extract(receipt_json, '$.target.projectId') = project_id AND
    json_extract(receipt_json, '$.capability.status') = capability_status AND
    json_array_length(
      json_extract(receipt_json, '$.capability.taskTransitions')
    ) = task_count AND
    json_extract(
      receipt_json, '$.capability.previousActiveVectorDigest'
    ) = previous_active_vector_digest AND
    json_extract(
      receipt_json, '$.capability.currentActiveVectorDigest'
    ) = current_active_vector_digest AND
    json_extract(receipt_json, '$.capability.currentToolSnapshotDigest') =
      current_tool_snapshot_digest AND
    json_extract(receipt_json, '$.capability.retainedSourceCount') =
      retained_source_count AND
    json_extract(receipt_json, '$.committedAtMs') = committed_at_ms AND
    json_extract(receipt_json, '$.receiptDigest') = receipt_digest
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_lifecycle_receipt_uidx ON "QingLong3PluginPackageLifecycleReceipts" (receipt_digest)`,
      `CREATE INDEX ql3_plugin_package_lifecycle_receipt_snapshot_idx ON "QingLong3PluginPackageLifecycleReceipts" (project_id, current_active_vector_digest, event_digest)`,
      `
CREATE TABLE "QingLong3PluginPackageLifecycleTasks" (
  event_digest TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  previous_revision INTEGER NOT NULL,
  current_revision INTEGER NOT NULL,
  previous_content_digest TEXT NOT NULL,
  current_content_digest TEXT NOT NULL,
  previous_enabled INTEGER NOT NULL,
  current_enabled INTEGER NOT NULL,
  PRIMARY KEY (event_digest, task_id),
  CONSTRAINT ql3_plugin_package_lifecycle_task_receipt_fk
    FOREIGN KEY (event_digest)
    REFERENCES "QingLong3PluginPackageLifecycleReceipts" (event_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_task_previous_fk
    FOREIGN KEY (project_id, task_id, previous_revision)
    REFERENCES "QingLong3TaskDefinitionRevisions" (
      project_id, task_id, revision
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_task_current_fk
    FOREIGN KEY (project_id, task_id, current_revision)
    REFERENCES "QingLong3TaskDefinitionRevisions" (
      project_id, task_id, revision
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_task_transition_check CHECK (
    current_revision = previous_revision + 1 AND
    previous_enabled IN (0, 1) AND current_enabled IN (0, 1) AND
    previous_enabled <> current_enabled
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_task_digest_check CHECK (
    length(previous_content_digest) = 64 AND
      previous_content_digest NOT GLOB '*[^0-9a-f]*' AND
    length(current_content_digest) = 64 AND
      current_content_digest NOT GLOB '*[^0-9a-f]*'
  )
)
      `,
      `CREATE INDEX ql3_plugin_package_lifecycle_task_idx ON "QingLong3PluginPackageLifecycleTasks" (project_id, task_id, event_digest)`,
    ],
  });
