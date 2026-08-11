import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V22 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_proposal":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V23 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_proposal":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0024PluginPackageIdentityKeysetLedgerMigration =
  definePostgresSqlMigration({
    id: 'pg-0024-plugin-package-identity-keyset-ledger',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_identity_keyset_ledger" (
  authority varchar(64) NOT NULL,
  generation bigint NOT NULL,
  digest varchar(43) NOT NULL,
  issuer varchar(512) NOT NULL,
  audience varchar(256) NOT NULL,
  active_key_ids jsonb NOT NULL,
  revoked_key_ids jsonb NOT NULL,
  updated_at_ms bigint NOT NULL,
  CONSTRAINT plugin_package_identity_keyset_ledger_pkey
    PRIMARY KEY (authority),
  CONSTRAINT ql3_plugin_package_identity_keyset_authority_check
    CHECK (authority = 'plugin-package-management'),
  CONSTRAINT ql3_plugin_package_identity_keyset_generation_check
    CHECK (generation >= 1 AND updated_at_ms >= 0),
  CONSTRAINT ql3_plugin_package_identity_keyset_digest_check
    CHECK (digest ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT ql3_plugin_package_identity_keyset_trust_domain_check
    CHECK (
      char_length(issuer) BETWEEN 1 AND 512
      AND issuer !~ '[[:cntrl:]]'
      AND char_length(audience) BETWEEN 1 AND 256
      AND audience !~ '[[:cntrl:]]'
    ),
  CONSTRAINT ql3_plugin_package_identity_keyset_keys_check
    CHECK (
      jsonb_typeof(active_key_ids) = 'array'
      AND jsonb_array_length(active_key_ids) BETWEEN 1 AND 8
      AND octet_length(active_key_ids::text) BETWEEN 3 AND 8192
      AND jsonb_typeof(revoked_key_ids) = 'array'
      AND jsonb_array_length(revoked_key_ids) BETWEEN 0 AND 64
      AND octet_length(revoked_key_ids::text) BETWEEN 2 AND 16384
    )
)
      `.trim(),
      `
REVOKE ALL
ON "ql3"."plugin_package_identity_keyset_ledger"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT, INSERT, UPDATE
ON "ql3"."plugin_package_identity_keyset_ledger"
TO ql3_package_manager
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 23,
      migration_id = 'pg-0024-plugin-package-identity-keyset-ledger',
      capabilities = '${CAPABILITIES_V23}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 22
    AND migration_id = 'pg-0023-plugin-package-management-quota'
    AND capabilities = '${CAPABILITIES_V22}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 22'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
