import { defineLocalSqliteMigration } from './sqlMigration';

export const local0041PluginPackageAdmissionReceiptsMigration =
  defineLocalSqliteMigration({
    id: '0041-plugin-package-admission-receipts',
    statements: [
      `
CREATE TABLE "QingLong3PluginPackageAdmissionReceipts" (
  dispatch_id TEXT PRIMARY KEY,
  dispatch_digest TEXT NOT NULL,
  approval_request_id TEXT NOT NULL,
  action_ref TEXT NOT NULL,
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  lock_digest TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  mutation_digest TEXT NOT NULL,
  audit_event_id TEXT NOT NULL,
  admitted_at_ms INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  receipt_digest TEXT NOT NULL,
  CONSTRAINT ql3_plugin_package_admission_dispatch_fk
    FOREIGN KEY (dispatch_id)
    REFERENCES "QingLong3ApprovedActionDispatches" (dispatch_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_admission_request_fk
    FOREIGN KEY (approval_request_id)
    REFERENCES "QingLong3ApprovalRequests" (request_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_admission_project_fk
    FOREIGN KEY (project_id) REFERENCES "QingLong3Projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_admission_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "QingLong3PluginPackageInstalls" (installation_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_admission_audit_fk
    FOREIGN KEY (audit_event_id)
    REFERENCES "QingLong3SecurityAuditEvents" (event_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_admission_identity_check CHECK (
    length(dispatch_id) BETWEEN 1 AND 128 AND
    length(approval_request_id) BETWEEN 1 AND 128 AND
    length(action_ref) BETWEEN 1 AND 255 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(package_name) BETWEEN 1 AND 64 AND
    length(installation_id) BETWEEN 1 AND 128 AND
    length(mutation_id) BETWEEN 1 AND 128 AND
    length(audit_event_id) = 36
  ),
  CONSTRAINT ql3_plugin_package_admission_digest_check CHECK (
    length(dispatch_digest) = 64 AND
      dispatch_digest NOT GLOB '*[^0-9a-f]*' AND
    length(lock_digest) = 64 AND lock_digest NOT GLOB '*[^0-9a-f]*' AND
    length(record_digest) = 64 AND record_digest NOT GLOB '*[^0-9a-f]*' AND
    length(mutation_digest) = 64 AND
      mutation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_plugin_package_admission_json_check CHECK (
    length(receipt_json) BETWEEN 2 AND 65536 AND
    json_valid(receipt_json) AND json_type(receipt_json) = 'object' AND
    json_extract(receipt_json, '$.schema') =
      'qinglong/plugin-package-admission-receipt@v1' AND
    json_extract(receipt_json, '$.dispatchId') = dispatch_id AND
    json_extract(receipt_json, '$.dispatchDigest') = dispatch_digest AND
    json_extract(receipt_json, '$.approvalRequestId') = approval_request_id AND
    json_extract(receipt_json, '$.actionRef') = action_ref AND
    json_extract(receipt_json, '$.projectId') = project_id AND
    json_extract(receipt_json, '$.packageName') = package_name AND
    json_extract(receipt_json, '$.installationId') = installation_id AND
    json_extract(receipt_json, '$.lockDigest') = lock_digest AND
    json_extract(receipt_json, '$.recordDigest') = record_digest AND
    json_extract(receipt_json, '$.mutationId') = mutation_id AND
    json_extract(receipt_json, '$.mutationDigest') = mutation_digest AND
    json_extract(receipt_json, '$.auditEventId') = audit_event_id AND
    json_extract(receipt_json, '$.admittedAtMs') = admitted_at_ms AND
    json_extract(receipt_json, '$.receiptDigest') = receipt_digest
  ),
  CONSTRAINT ql3_plugin_package_admission_time_check
    CHECK (admitted_at_ms >= 0)
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_admission_install_uidx ON "QingLong3PluginPackageAdmissionReceipts" (installation_id)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_admission_audit_uidx ON "QingLong3PluginPackageAdmissionReceipts" (audit_event_id)`,
      `CREATE INDEX ql3_plugin_package_admission_project_idx ON "QingLong3PluginPackageAdmissionReceipts" (project_id, admitted_at_ms, dispatch_id)`,
    ],
  });
