import { CAPABILITIES_V59 } from './pg-0060-plugin-package-secret-materialization-guard';
import { definePostgresSqlMigration } from './sqlMigration';

export const CAPABILITIES_V60 = CAPABILITIES_V59.replace(
  '"plugin_package_secret_binding":1,',
  '"plugin_package_secret_binding":1,"plugin_package_secret_binding_approval_plan":1,',
);

export const pg0061PluginPackageSecretBindingApprovalPlansMigration =
  definePostgresSqlMigration({
    id: 'pg-0061-plugin-package-secret-binding-approval-plans',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_secret_binding_approval_plans" (
  action_ref varchar(255) PRIMARY KEY,
  approval_plan_digest char(64) NOT NULL,
  binding_plan_digest char(64) NOT NULL,
  generation_digest char(64) NOT NULL,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  installation_id varchar(128) NOT NULL,
  lock_digest char(64) NOT NULL,
  generation integer NOT NULL,
  manifest_digest char(64) NOT NULL,
  requested_by_type varchar(16) NOT NULL,
  requested_by_id varchar(255) NOT NULL,
  planned_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  plan_json jsonb NOT NULL,
  CONSTRAINT ql3_plugin_package_secret_binding_approval_plan_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_secret_binding_approval_plan_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "ql3"."plugin_package_installs" (installation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_secret_binding_approval_plan_identity_check CHECK (
    action_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' AND
    installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    generation BETWEEN 1 AND 2147483647 AND
    requested_by_type = 'user' AND
    octet_length(requested_by_id) BETWEEN 1 AND 255 AND
    requested_by_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ql3_plugin_package_secret_binding_approval_plan_digest_check CHECK (
    approval_plan_digest ~ '^[0-9a-f]{64}$' AND
    binding_plan_digest ~ '^[0-9a-f]{64}$' AND
    generation_digest ~ '^[0-9a-f]{64}$' AND
    lock_digest ~ '^[0-9a-f]{64}$' AND
    manifest_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_secret_binding_approval_plan_time_check CHECK (
    planned_at_ms >= 0 AND
    expires_at_ms > planned_at_ms AND
    expires_at_ms - planned_at_ms <= 900000
  ),
  CONSTRAINT ql3_plugin_package_secret_binding_approval_plan_json_check CHECK (
    jsonb_typeof(plan_json) = 'object' AND
    octet_length(plan_json::text) BETWEEN 2 AND 98304 AND
    plan_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-secret-binding-approval-plan@v1',
      'actionRef', action_ref,
      'approvalPlanDigest', approval_plan_digest,
      'requestedBy', jsonb_build_object(
        'type', requested_by_type,
        'id', requested_by_id
      ),
      'expiresAtMs', expires_at_ms,
      'bindingPlan', jsonb_build_object(
        'schema', 'qinglong/plugin-package-secret-binding-plan@v1',
        'planDigest', binding_plan_digest,
        'plannedAtMs', planned_at_ms,
        'target', jsonb_build_object(
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
    jsonb_typeof(plan_json #> '{bindingPlan,entries}') = 'array' AND
    jsonb_array_length(plan_json #> '{bindingPlan,entries}') BETWEEN 1 AND 64
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_secret_binding_approval_plan_digest_uidx ON "ql3"."plugin_package_secret_binding_approval_plans" (approval_plan_digest)`,
      `CREATE INDEX ql3_plugin_package_secret_binding_approval_plan_target_idx ON "ql3"."plugin_package_secret_binding_approval_plans" (project_id, package_name, generation, action_ref)`,
      `CREATE INDEX ql3_plugin_package_secret_binding_approval_plan_expiry_idx ON "ql3"."plugin_package_secret_binding_approval_plans" (expires_at_ms, action_ref)`,
      `
CREATE FUNCTION "ql3"."plugin_package_secret_binding_planning_snapshot"(
  p_project_id varchar,
  p_package_name varchar
)
RETURNS TABLE (
  record_json jsonb,
  lock_json jsonb,
  proposal_json jsonb,
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
  IF p_project_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR
     p_package_name !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' THEN
    RAISE EXCEPTION 'Package planning identity is invalid'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  SELECT install.record_json,
         install.lock_json,
         proposal.proposal_json,
         floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
    FROM "ql3"."plugin_package_install_heads" AS head
    JOIN "ql3"."plugin_package_installs" AS install
      ON install.installation_id = head.installation_id
    JOIN "ql3"."plugin_package_admission_receipts" AS admission
      ON admission.installation_id = install.installation_id
    JOIN "ql3"."plugin_package_install_proposals" AS proposal
      ON proposal.action_ref = admission.action_ref
    LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
      ON quarantine.project_id = install.project_id
     AND quarantine.package_name = install.package_name
     AND quarantine.installation_id = install.installation_id
     AND quarantine.lock_digest = install.lock_digest
    LEFT JOIN "ql3"."plugin_package_lifecycle_heads" AS lifecycle
      ON lifecycle.project_id = install.project_id
     AND lifecycle.package_name = install.package_name
     AND lifecycle.installation_id = install.installation_id
     AND lifecycle.lock_digest = install.lock_digest
   WHERE head.project_id = p_project_id
     AND head.package_name = p_package_name
     AND install.state = 'active'
     AND install.active_lock_digest = install.lock_digest
     AND quarantine.event_digest IS NULL
     AND COALESCE(lifecycle.disposition, 'active') = 'active'
     AND NOT EXISTS (
       SELECT 1
         FROM "ql3"."plugin_package_secret_bindings" AS binding
        WHERE binding.project_id = install.project_id
          AND binding.package_name = install.package_name
          AND binding.generation = install.target_generation
     )
   FOR SHARE OF head, install;
END
$ql3$
      `.trim(),
      `
CREATE FUNCTION "ql3"."create_plugin_package_secret_binding_approval_plan"(
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
  IF jsonb_typeof(p_plan_json) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Secret binding approval plan is invalid'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF COALESCE(p_plan_json ->> 'actionRef', '') !~
       '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' THEN
    RAISE EXCEPTION 'Secret binding approval actionRef is invalid'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_plan_json ->> 'actionRef', 70513061)
  );

  SELECT plan_json INTO existing_plan
    FROM "ql3"."plugin_package_secret_binding_approval_plans"
   WHERE action_ref = p_plan_json ->> 'actionRef'
   FOR SHARE;
  IF existing_plan IS NOT NULL THEN
    IF existing_plan = p_plan_json THEN
      RETURN 'existing';
    END IF;
    RAISE EXCEPTION 'Secret binding approval actionRef is already bound'
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO "ql3"."plugin_package_secret_binding_approval_plans" (
    action_ref, approval_plan_digest, binding_plan_digest,
    generation_digest, project_id, package_name, installation_id,
    lock_digest, generation, manifest_digest, requested_by_type,
    requested_by_id, planned_at_ms, expires_at_ms, plan_json
  )
  SELECT
    p_plan_json ->> 'actionRef',
    p_plan_json ->> 'approvalPlanDigest',
    p_plan_json #>> '{bindingPlan,planDigest}',
    p_plan_json #>> '{bindingPlan,target,generationDigest}',
    p_plan_json #>> '{bindingPlan,target,projectId}',
    p_plan_json #>> '{bindingPlan,target,packageName}',
    p_plan_json #>> '{bindingPlan,target,installationId}',
    p_plan_json #>> '{bindingPlan,target,lockDigest}',
    (p_plan_json #>> '{bindingPlan,target,generation}')::integer,
    p_plan_json #>> '{bindingPlan,target,manifestDigest}',
    p_plan_json #>> '{requestedBy,type}',
    p_plan_json #>> '{requestedBy,id}',
    (p_plan_json #>> '{bindingPlan,plannedAtMs}')::bigint,
    (p_plan_json ->> 'expiresAtMs')::bigint,
    p_plan_json
  FROM "ql3"."plugin_package_install_heads" AS head
  JOIN "ql3"."plugin_package_installs" AS install
    ON install.installation_id = head.installation_id
   AND install.project_id = head.project_id
   AND install.package_name = head.package_name
  LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
    ON quarantine.project_id = install.project_id
   AND quarantine.package_name = install.package_name
   AND quarantine.installation_id = install.installation_id
   AND quarantine.lock_digest = install.lock_digest
  LEFT JOIN "ql3"."plugin_package_lifecycle_heads" AS lifecycle
    ON lifecycle.project_id = install.project_id
   AND lifecycle.package_name = install.package_name
   AND lifecycle.installation_id = install.installation_id
   AND lifecycle.lock_digest = install.lock_digest
  WHERE head.project_id = p_plan_json #>> '{bindingPlan,target,projectId}'
    AND head.package_name = p_plan_json #>> '{bindingPlan,target,packageName}'
    AND install.installation_id =
        p_plan_json #>> '{bindingPlan,target,installationId}'
    AND install.lock_digest =
        p_plan_json #>> '{bindingPlan,target,lockDigest}'
    AND install.target_generation =
        (p_plan_json #>> '{bindingPlan,target,generation}')::integer
    AND install.lock_json ->> 'manifestDigest' =
        p_plan_json #>> '{bindingPlan,target,manifestDigest}'
    AND install.state = 'active'
    AND install.active_lock_digest = install.lock_digest
    AND quarantine.event_digest IS NULL
    AND COALESCE(lifecycle.disposition, 'active') = 'active'
    AND NOT EXISTS (
      SELECT 1
        FROM "ql3"."plugin_package_secret_bindings" AS binding
       WHERE binding.generation_digest =
             p_plan_json #>> '{bindingPlan,target,generationDigest}'
          OR (
            binding.project_id = install.project_id AND
            binding.package_name = install.package_name AND
            binding.generation = install.target_generation
          )
    )
  RETURNING action_ref INTO inserted_action_ref;

  IF inserted_action_ref IS NULL THEN
    RAISE EXCEPTION 'Secret binding target is not the current unbound generation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN 'created';
END
$ql3$
      `.trim(),
      `REVOKE ALL ON "ql3"."plugin_package_secret_binding_approval_plans" FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress`,
      `GRANT SELECT ON "ql3"."plugin_package_secret_binding_approval_plans" TO ql3_package_manager`,
      `GRANT SELECT ON "ql3"."plugin_package_secret_binding_approval_plans" TO ql3_package_executor`,
      `REVOKE ALL ON FUNCTION "ql3"."plugin_package_secret_binding_planning_snapshot"(varchar, varchar) FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress`,
      `REVOKE ALL ON FUNCTION "ql3"."create_plugin_package_secret_binding_approval_plan"(jsonb) FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress`,
      `GRANT EXECUTE ON FUNCTION "ql3"."plugin_package_secret_binding_planning_snapshot"(varchar, varchar) TO ql3_package_manager`,
      `GRANT EXECUTE ON FUNCTION "ql3"."create_plugin_package_secret_binding_approval_plan"(jsonb) TO ql3_package_manager`,
      `DO $ql3$ BEGIN UPDATE "ql3"."schema_capabilities" SET contract_version = 60, migration_id = 'pg-0061-plugin-package-secret-binding-approval-plans', capabilities = '${CAPABILITIES_V60}'::jsonb, updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint WHERE contract_name = 'control-core' AND contract_version = 59 AND migration_id = 'pg-0060-plugin-package-secret-materialization-guard' AND capabilities = '${CAPABILITIES_V59}'::jsonb; IF NOT FOUND THEN RAISE EXCEPTION 'control-core capability is not at version 59' USING ERRCODE = 'check_violation'; END IF; END $ql3$`,
    ],
  });
