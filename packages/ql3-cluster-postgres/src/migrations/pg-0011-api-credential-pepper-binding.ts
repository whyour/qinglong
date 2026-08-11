import { definePostgresSqlMigration } from './sqlMigration';

export const pg0011ApiCredentialPepperBindingMigration =
  definePostgresSqlMigration({
    id: 'pg-0011-api-credential-pepper-binding',
    statements: [
      `
ALTER TABLE "ql3"."api_credentials"
ADD COLUMN pepper_key_id varchar(64) NOT NULL DEFAULT 'legacy-v1'
      `.trim(),
      `
ALTER TABLE "ql3"."api_credentials"
ADD CONSTRAINT ql3_api_credentials_pepper_key_id_check
CHECK (pepper_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$')
      `.trim(),
      `
ALTER TABLE "ql3"."api_credentials"
ALTER COLUMN pepper_key_id DROP DEFAULT
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 10,
      migration_id = 'pg-0011-api-credential-pepper-binding',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_recovery":1,"cluster_recovery_claim":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"worker_attestation":1,"worker_credential":1,"worker_session":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 9
    AND migration_id = 'pg-0010-worker-ingress-attestation'
    AND capabilities = '{"api_credential":1,"api_credential_admin":1,"cluster_recovery":1,"cluster_recovery_claim":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"worker_attestation":1,"worker_credential":1,"worker_session":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 9'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
