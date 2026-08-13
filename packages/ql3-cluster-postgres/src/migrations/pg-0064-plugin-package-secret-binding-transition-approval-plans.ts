import { CAPABILITIES_V62 } from './pg-0063-plugin-package-secret-binding-transition-receipts';
import { definePostgresSqlMigration } from './sqlMigration';

export const CAPABILITIES_V63 = CAPABILITIES_V62.replace(
  '"plugin_package_secret_binding_transition_receipt":1,',
  '"plugin_package_secret_binding_transition_approval_plan":1,"plugin_package_secret_binding_transition_receipt":1,',
);

export const pg0064PluginPackageSecretBindingTransitionApprovalPlansMigration =
  definePostgresSqlMigration({
    id: 'pg-0064-plugin-package-secret-binding-transition-approval-plans',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_secret_binding_transition_approval_plans" (
  action_ref varchar(255) PRIMARY KEY,
  approval_plan_digest char(64) NOT NULL,
  transition_digest char(64) NOT NULL,
  generation_digest char(64) NOT NULL,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  installation_id varchar(128) NOT NULL,
  lock_digest char(64) NOT NULL,
  generation integer NOT NULL,
  manifest_digest char(64) NOT NULL,
  previous_active_lock_digest char(64) NOT NULL,
  requested_by_type varchar(16) NOT NULL,
  requested_by_id varchar(255) NOT NULL,
  planned_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  plan_json jsonb NOT NULL,
  CONSTRAINT ql3_pp_secret_transition_plan_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_pp_secret_transition_plan_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "ql3"."plugin_package_installs" (installation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_pp_secret_transition_plan_identity_check CHECK (
    action_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' AND
    installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    generation BETWEEN 2 AND 2147483647 AND
    requested_by_type = 'user' AND
    octet_length(requested_by_id) BETWEEN 1 AND 255 AND
    requested_by_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ql3_pp_secret_transition_plan_digest_check CHECK (
    approval_plan_digest ~ '^[0-9a-f]{64}$' AND
    transition_digest ~ '^[0-9a-f]{64}$' AND
    generation_digest ~ '^[0-9a-f]{64}$' AND
    lock_digest ~ '^[0-9a-f]{64}$' AND
    manifest_digest ~ '^[0-9a-f]{64}$' AND
    previous_active_lock_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_pp_secret_transition_plan_time_check CHECK (
    planned_at_ms >= 0 AND expires_at_ms > planned_at_ms AND
    expires_at_ms - planned_at_ms <= 900000
  ),
  CONSTRAINT ql3_pp_secret_transition_plan_json_check CHECK (
    jsonb_typeof(plan_json) = 'object' AND
    octet_length(plan_json::text) BETWEEN 2 AND 229376 AND
    plan_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-secret-binding-transition-approval-plan@v1',
      'actionRef', action_ref,
      'approvalPlanDigest', approval_plan_digest,
      'requestedBy', jsonb_build_object(
        'type', requested_by_type,
        'id', requested_by_id
      ),
      'plannedAtMs', planned_at_ms,
      'expiresAtMs', expires_at_ms,
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
      )
    ) AND
    jsonb_typeof(plan_json #> '{transitionPlan,changes}') = 'array' AND
    jsonb_array_length(plan_json #> '{transitionPlan,changes}') BETWEEN 1 AND 64
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_pp_secret_transition_plan_digest_uidx ON "ql3"."plugin_package_secret_binding_transition_approval_plans" (approval_plan_digest)`,
      `CREATE UNIQUE INDEX ql3_pp_secret_transition_plan_target_uidx ON "ql3"."plugin_package_secret_binding_transition_approval_plans" (generation_digest)`,
      `CREATE INDEX ql3_pp_secret_transition_plan_expiry_idx ON "ql3"."plugin_package_secret_binding_transition_approval_plans" (expires_at_ms, action_ref)`,
      `
CREATE FUNCTION "ql3"."plugin_package_secret_binding_transition_snapshot"(
  p_project_id varchar,
  p_package_name varchar
)
RETURNS TABLE (
  next_record_json jsonb,
  next_lock_json jsonb,
  next_proposal_json jsonb,
  previous_record_json jsonb,
  previous_lock_json jsonb,
  previous_proposal_json jsonb,
  previous_binding_json jsonb,
  previous_attempt_generation integer,
  observed_at_ms bigint
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3
AS $ql3$
BEGIN
  IF NOT pg_has_role(session_user, 'ql3_package_manager', 'member') THEN
    RAISE EXCEPTION 'Package manager authority is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT current.record_json,
         current.lock_json,
         current_proposal.proposal_json,
         previous.record_json,
         previous.lock_json,
         previous_proposal.proposal_json,
         previous_binding.binding_json,
         (
           SELECT MAX(history.target_generation)
             FROM "ql3"."plugin_package_installs" AS history
            WHERE history.project_id = current.project_id
              AND history.package_name = current.package_name
              AND history.target_generation < current.target_generation
         ),
         floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
    FROM "ql3"."plugin_package_install_heads" AS head
    JOIN "ql3"."plugin_package_installs" AS current
      ON current.installation_id = head.installation_id
     AND current.project_id = head.project_id
     AND current.package_name = head.package_name
    JOIN "ql3"."plugin_package_admission_receipts" AS current_admission
      ON current_admission.installation_id = current.installation_id
    JOIN "ql3"."plugin_package_install_proposals" AS current_proposal
      ON current_proposal.action_ref = current_admission.action_ref
    JOIN "ql3"."plugin_package_installs" AS previous
      ON previous.project_id = current.project_id
     AND previous.package_name = current.package_name
     AND previous.lock_digest = current.previous_active_lock_digest
    JOIN "ql3"."plugin_package_admission_receipts" AS previous_admission
      ON previous_admission.installation_id = previous.installation_id
    JOIN "ql3"."plugin_package_install_proposals" AS previous_proposal
      ON previous_proposal.action_ref = previous_admission.action_ref
    LEFT JOIN "ql3"."plugin_package_secret_bindings" AS previous_binding
      ON previous_binding.installation_id = previous.installation_id
     AND previous_binding.project_id = previous.project_id
     AND previous_binding.package_name = previous.package_name
     AND previous_binding.lock_digest = previous.lock_digest
     AND previous_binding.generation = previous.target_generation
   WHERE head.project_id = p_project_id
     AND head.package_name = p_package_name
     AND current.state = 'staged'
     AND current.previous_active_lock_digest IS NOT NULL
     AND current.active_lock_digest = current.previous_active_lock_digest
     AND current.target_generation = (
       SELECT MAX(latest.target_generation)
         FROM "ql3"."plugin_package_installs" AS latest
        WHERE latest.project_id = current.project_id
          AND latest.package_name = current.package_name
     )
     AND previous.state = 'active'
     AND previous.active_lock_digest = previous.lock_digest
     AND NOT EXISTS (
       SELECT 1
         FROM "ql3"."plugin_package_secret_binding_transition_receipts" receipt
        WHERE receipt.project_id = current.project_id
          AND receipt.package_name = current.package_name
          AND receipt.generation = current.target_generation
     )
   FOR SHARE OF head, current, previous;
END
$ql3$
      `.trim(),
      `
CREATE FUNCTION "ql3"."create_plugin_package_secret_transition_plan"(
  p_plan_json jsonb
)
RETURNS varchar
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3
AS $ql3$
DECLARE
  existing_plan jsonb;
  inserted_action_ref varchar(255);
BEGIN
  IF NOT pg_has_role(session_user, 'ql3_package_manager', 'member') THEN
    RAISE EXCEPTION 'Package manager authority is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_plan_json ->> 'actionRef', 70513064)
  );
  SELECT plan_json INTO existing_plan
    FROM "ql3"."plugin_package_secret_binding_transition_approval_plans"
   WHERE action_ref = p_plan_json ->> 'actionRef'
   FOR SHARE;
  IF existing_plan IS NOT NULL THEN
    IF existing_plan = p_plan_json THEN RETURN 'existing'; END IF;
    RAISE EXCEPTION 'Secret transition actionRef is already bound'
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO "ql3"."plugin_package_secret_binding_transition_approval_plans" (
    action_ref, approval_plan_digest, transition_digest, generation_digest,
    project_id, package_name, installation_id, lock_digest, generation,
    manifest_digest, previous_active_lock_digest, requested_by_type,
    requested_by_id, planned_at_ms, expires_at_ms, plan_json
  )
  SELECT p_plan_json ->> 'actionRef',
         p_plan_json ->> 'approvalPlanDigest',
         p_plan_json #>> '{transitionPlan,transitionDigest}',
         p_plan_json #>> '{transitionPlan,nextTarget,generationDigest}',
         p_plan_json #>> '{transitionPlan,nextTarget,projectId}',
         p_plan_json #>> '{transitionPlan,nextTarget,packageName}',
         p_plan_json #>> '{transitionPlan,nextTarget,installationId}',
         p_plan_json #>> '{transitionPlan,nextTarget,lockDigest}',
         (p_plan_json #>> '{transitionPlan,nextTarget,generation}')::integer,
         p_plan_json #>> '{transitionPlan,nextTarget,manifestDigest}',
         p_plan_json #>> '{transitionPlan,previousActiveLockDigest}',
         p_plan_json #>> '{requestedBy,type}',
         p_plan_json #>> '{requestedBy,id}',
         (p_plan_json ->> 'plannedAtMs')::bigint,
         (p_plan_json ->> 'expiresAtMs')::bigint,
         p_plan_json
    FROM "ql3"."plugin_package_install_heads" head
    JOIN "ql3"."plugin_package_installs" install
      ON install.installation_id = head.installation_id
     AND install.project_id = head.project_id
     AND install.package_name = head.package_name
    JOIN "ql3"."plugin_package_installs" previous
      ON previous.project_id = install.project_id
     AND previous.package_name = install.package_name
     AND previous.lock_digest = install.previous_active_lock_digest
    LEFT JOIN "ql3"."plugin_package_secret_bindings" previous_binding
      ON previous_binding.installation_id = previous.installation_id
     AND previous_binding.project_id = previous.project_id
     AND previous_binding.package_name = previous.package_name
     AND previous_binding.lock_digest = previous.lock_digest
     AND previous_binding.generation = previous.target_generation
   WHERE head.project_id = p_plan_json #>> '{transitionPlan,nextTarget,projectId}'
     AND head.package_name = p_plan_json #>> '{transitionPlan,nextTarget,packageName}'
     AND install.installation_id = p_plan_json #>> '{transitionPlan,nextTarget,installationId}'
     AND install.lock_digest = p_plan_json #>> '{transitionPlan,nextTarget,lockDigest}'
     AND install.target_generation = (p_plan_json #>> '{transitionPlan,nextTarget,generation}')::integer
     AND install.lock_json ->> 'manifestDigest' = p_plan_json #>> '{transitionPlan,nextTarget,manifestDigest}'
     AND install.state = 'staged'
     AND install.previous_active_lock_digest = p_plan_json #>> '{transitionPlan,previousActiveLockDigest}'
     AND install.active_lock_digest = install.previous_active_lock_digest
     AND previous.installation_id = p_plan_json #>> '{transitionPlan,previousTarget,installationId}'
     AND previous.lock_digest = p_plan_json #>> '{transitionPlan,previousTarget,lockDigest}'
     AND previous.target_generation = (p_plan_json #>> '{transitionPlan,previousTarget,generation}')::integer
     AND previous.lock_json ->> 'manifestDigest' = p_plan_json #>> '{transitionPlan,previousTarget,manifestDigest}'
     AND previous.state = 'active'
     AND previous.active_lock_digest = previous.lock_digest
     AND (
       SELECT MAX(attempt.target_generation)
         FROM "ql3"."plugin_package_installs" attempt
        WHERE attempt.project_id = install.project_id
          AND attempt.package_name = install.package_name
          AND attempt.target_generation < install.target_generation
     ) = (p_plan_json #>> '{transitionPlan,previousAttemptGeneration}')::integer
     AND (
       (previous_binding.binding_json IS NULL AND
        p_plan_json #> '{transitionPlan,previousBinding}' = 'null'::jsonb) OR
       previous_binding.binding_json = p_plan_json #> '{transitionPlan,previousBinding}'
     )
     AND install.target_generation = (
       SELECT MAX(history.target_generation)
         FROM "ql3"."plugin_package_installs" history
        WHERE history.project_id = install.project_id
          AND history.package_name = install.package_name
     )
     AND NOT EXISTS (
       SELECT 1 FROM "ql3"."plugin_package_secret_binding_transition_receipts" receipt
        WHERE receipt.generation_digest = p_plan_json #>> '{transitionPlan,nextTarget,generationDigest}'
     )
  RETURNING action_ref INTO inserted_action_ref;
  IF inserted_action_ref IS NULL THEN
    RAISE EXCEPTION 'Secret transition target is not current staged generation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN 'created';
END
$ql3$
      `.trim(),
      `REVOKE ALL ON "ql3"."plugin_package_secret_binding_transition_approval_plans" FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress`,
      `GRANT SELECT ON "ql3"."plugin_package_secret_binding_transition_approval_plans" TO ql3_package_manager, ql3_package_executor`,
      `REVOKE ALL ON FUNCTION "ql3"."plugin_package_secret_binding_transition_snapshot"(varchar, varchar) FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress`,
      `GRANT EXECUTE ON FUNCTION "ql3"."plugin_package_secret_binding_transition_snapshot"(varchar, varchar) TO ql3_package_manager`,
      `REVOKE ALL ON FUNCTION "ql3"."create_plugin_package_secret_transition_plan"(jsonb) FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress`,
      `GRANT EXECUTE ON FUNCTION "ql3"."create_plugin_package_secret_transition_plan"(jsonb) TO ql3_package_manager`,
      `DO $ql3$ BEGIN UPDATE "ql3"."schema_capabilities" SET contract_version = 63, migration_id = 'pg-0064-plugin-package-secret-binding-transition-approval-plans', capabilities = '${CAPABILITIES_V63}'::jsonb, updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint WHERE contract_name = 'control-core' AND contract_version = 62 AND migration_id = 'pg-0063-plugin-package-secret-binding-transition-receipts' AND capabilities = '${CAPABILITIES_V62}'::jsonb; IF NOT FOUND THEN RAISE EXCEPTION 'control-core capability is not at version 62' USING ERRCODE = 'check_violation'; END IF; END $ql3$`,
    ],
  });
