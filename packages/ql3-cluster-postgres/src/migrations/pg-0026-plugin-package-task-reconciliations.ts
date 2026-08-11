import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V24 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V25 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0026PluginPackageTaskReconciliationsMigration =
  definePostgresSqlMigration({
    id: 'pg-0026-plugin-package-task-reconciliations',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_task_ownerships" (
  project_id varchar(128) NOT NULL,
  task_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  claimed_generation_digest char(64) NOT NULL,
  created_at_ms bigint NOT NULL,
  CONSTRAINT plugin_package_task_ownerships_pkey
    PRIMARY KEY (project_id, task_id),
  CONSTRAINT ql3_plugin_package_task_ownership_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_task_ownership_task_fk
    FOREIGN KEY (project_id, task_id)
    REFERENCES "ql3"."task_definitions" (project_id, task_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_task_ownership_identity_check CHECK (
    char_length(task_id) BETWEEN 1 AND 128 AND
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  CONSTRAINT ql3_plugin_package_task_ownership_digest_check CHECK (
    claimed_generation_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_task_ownership_namespace_check CHECK (
    task_id LIKE 'pkg:' || package_name || ':%'
  ),
  CONSTRAINT ql3_plugin_package_task_ownership_time_check CHECK (
    created_at_ms >= 0
  )
)
      `.trim(),
      `
CREATE INDEX ql3_plugin_package_task_ownership_package_idx
ON "ql3"."plugin_package_task_ownerships"
  (project_id, package_name, task_id)
      `.trim(),
      `
CREATE TABLE "ql3"."plugin_package_task_reconciliations" (
  generation_digest char(64) NOT NULL,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  generation integer NOT NULL,
  materialized_revision_digest char(64) NOT NULL,
  lock_digest char(64) NOT NULL,
  previous_lock_digest char(64),
  receipt_digest char(64) NOT NULL,
  receipt_json jsonb NOT NULL,
  committed_at_ms bigint NOT NULL,
  CONSTRAINT plugin_package_task_reconciliations_pkey
    PRIMARY KEY (generation_digest),
  CONSTRAINT ql3_plugin_package_task_reconciliation_materialized_fk
    FOREIGN KEY (generation_digest)
    REFERENCES "ql3"."plugin_package_materialized_revisions"
      (generation_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_task_reconciliation_identity_check CHECK (
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' AND
    generation BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_plugin_package_task_reconciliation_digest_check CHECK (
    generation_digest ~ '^[0-9a-f]{64}$' AND
    materialized_revision_digest ~ '^[0-9a-f]{64}$' AND
    lock_digest ~ '^[0-9a-f]{64}$' AND
    (previous_lock_digest IS NULL OR
      previous_lock_digest ~ '^[0-9a-f]{64}$') AND
    receipt_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_task_reconciliation_json_check CHECK (
    jsonb_typeof(receipt_json) = 'object' AND
    octet_length(receipt_json::text) BETWEEN 2 AND 8388608 AND
    receipt_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-task-reconciliation@v1',
      'generationDigest', generation_digest,
      'projectId', project_id,
      'packageName', package_name,
      'generation', generation,
      'materializedRevisionDigest', materialized_revision_digest,
      'lockDigest', lock_digest,
      'receiptDigest', receipt_digest
    )
  ),
  CONSTRAINT ql3_plugin_package_task_reconciliation_time_check CHECK (
    committed_at_ms >= 0
  )
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_plugin_package_task_reconciliation_generation_uidx
ON "ql3"."plugin_package_task_reconciliations"
  (project_id, package_name, generation)
      `.trim(),
      `
CREATE INDEX ql3_plugin_package_task_reconciliation_lock_idx
ON "ql3"."plugin_package_task_reconciliations"
  (lock_digest, generation_digest)
      `.trim(),
      `
CREATE TABLE "ql3"."plugin_package_task_reconciliation_items" (
  generation_digest char(64) NOT NULL,
  task_id varchar(128) NOT NULL,
  revision integer NOT NULL,
  disposition varchar(24) NOT NULL,
  content_digest char(64) NOT NULL,
  CONSTRAINT plugin_package_task_reconciliation_items_pkey
    PRIMARY KEY (generation_digest, task_id),
  CONSTRAINT ql3_plugin_package_task_reconciliation_item_reconciliation_fk
    FOREIGN KEY (generation_digest)
    REFERENCES "ql3"."plugin_package_task_reconciliations"
      (generation_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_task_reconciliation_item_identity_check CHECK (
    char_length(task_id) BETWEEN 1 AND 128 AND
    revision BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_plugin_package_task_reconciliation_item_disposition_check
    CHECK (disposition IN (
      'already_disabled','created','disabled','retained','updated'
    )),
  CONSTRAINT ql3_plugin_package_task_reconciliation_item_digest_check CHECK (
    content_digest ~ '^[0-9a-f]{64}$'
  )
)
      `.trim(),
      `
CREATE INDEX ql3_plugin_package_task_reconciliation_item_task_idx
ON "ql3"."plugin_package_task_reconciliation_items"
  (task_id, generation_digest)
      `.trim(),
      `
CREATE FUNCTION "ql3"."commit_plugin_package_task_reconciliation"(
  p_generation_digest char(64),
  p_materialized_revision_digest char(64),
  p_receipt jsonb,
  p_writes jsonb,
  p_execution_revisions jsonb
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3
AS $ql3$
DECLARE
  materialized "ql3"."plugin_package_materialized_revisions"%ROWTYPE;
  install_record "ql3"."plugin_package_installs"%ROWTYPE;
  previous_receipt jsonb;
  expected_ids text[];
  receipt_ids text[];
  write_ids text[];
  execution_ids text[];
  task_id_value text;
  item jsonb;
  write_value jsonb;
  definition jsonb;
  execution_value jsonb;
  resource_value jsonb;
  current_head "ql3"."task_definitions"%ROWTYPE;
  current_revision "ql3"."task_definition_revisions"%ROWTYPE;
  owner_package varchar(63);
  now_ms bigint;
BEGIN
  IF NOT pg_has_role(session_user, 'ql3_package_executor', 'member') THEN
    RAISE EXCEPTION 'Package Task reconciliation authority is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_generation_digest !~ '^[0-9a-f]{64}$'
     OR p_materialized_revision_digest !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(p_receipt) <> 'object'
     OR jsonb_typeof(p_writes) <> 'array'
     OR jsonb_typeof(p_execution_revisions) <> 'array'
     OR jsonb_array_length(p_writes) > 512
     OR jsonb_array_length(p_execution_revisions) > 512 THEN
    RAISE EXCEPTION 'invalid Package Task reconciliation input'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO materialized
  FROM "ql3"."plugin_package_materialized_revisions"
  WHERE generation_digest = p_generation_digest
  FOR KEY SHARE;
  IF NOT FOUND
     OR materialized.revision_digest <> p_materialized_revision_digest THEN
    RAISE EXCEPTION 'materialized revision fence changed'
      USING ERRCODE = 'serialization_failure';
  END IF;

  SELECT install.* INTO install_record
  FROM "ql3"."plugin_package_install_heads" AS head
  JOIN "ql3"."plugin_package_installs" AS install
    ON install.installation_id = head.installation_id
  WHERE head.project_id = materialized.project_id
    AND head.package_name = materialized.package_name
  FOR UPDATE OF install;
  IF NOT FOUND
     OR install_record.state <> 'active'
     OR install_record.installation_id <>
       materialized.revision_json #>> '{generation,installationId}'
     OR install_record.target_generation <> materialized.generation
     OR install_record.lock_digest <> materialized.lock_digest
     OR install_record.previous_active_lock_digest IS DISTINCT FROM
       NULLIF(materialized.revision_json #>> '{generation,previousActiveLockDigest}', '')
  THEN
    RAISE EXCEPTION 'active Package install fence changed'
      USING ERRCODE = 'serialization_failure';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ql3"."plugin_package_task_reconciliations"
    WHERE generation_digest = p_generation_digest
      AND receipt_json = p_receipt
  ) THEN
    RETURN false;
  ELSIF EXISTS (
    SELECT 1 FROM "ql3"."plugin_package_task_reconciliations"
    WHERE generation_digest = p_generation_digest
  ) THEN
    RAISE EXCEPTION 'generation receipt identity is already bound'
      USING ERRCODE = 'unique_violation';
  END IF;

  IF materialized.generation = 1 THEN
    IF materialized.revision_json #>> '{generation,previousActiveLockDigest}'
       IS NOT NULL THEN
      RAISE EXCEPTION 'first generation has a previous lock'
        USING ERRCODE = 'check_violation';
    END IF;
    previous_receipt := NULL;
  ELSE
    SELECT receipt_json INTO previous_receipt
    FROM "ql3"."plugin_package_task_reconciliations"
    WHERE project_id = materialized.project_id
      AND package_name = materialized.package_name
      AND generation = materialized.generation - 1
    FOR KEY SHARE;
    IF NOT FOUND
       OR previous_receipt ->> 'lockDigest' <>
         materialized.revision_json #>>
           '{generation,previousActiveLockDigest}' THEN
      RAISE EXCEPTION 'previous generation receipt is missing'
        USING ERRCODE = 'serialization_failure';
    END IF;
  END IF;

  IF p_receipt ->> 'schema' <>
       'qinglong/plugin-package-task-reconciliation@v1'
     OR p_receipt ->> 'generationDigest' <> p_generation_digest
     OR p_receipt ->> 'materializedRevisionDigest' <>
       p_materialized_revision_digest
     OR p_receipt ->> 'projectId' <> materialized.project_id
     OR p_receipt ->> 'packageName' <> materialized.package_name
     OR (p_receipt ->> 'generation')::integer <> materialized.generation
     OR p_receipt ->> 'lockDigest' <> materialized.lock_digest
     OR jsonb_typeof(p_receipt -> 'items') <> 'array'
     OR jsonb_array_length(p_receipt -> 'items') > 512 THEN
    RAISE EXCEPTION 'receipt does not match materialized generation'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT array_agg(value ORDER BY value) INTO expected_ids
  FROM (
    SELECT 'pkg:' || materialized.package_name || ':' ||
      (resource_json -> 'value' ->> 'id') AS value
    FROM jsonb_array_elements(materialized.revision_json -> 'resources')
      AS resources(resource_json)
    WHERE resource_json ->> 'kind' = 'task'
    UNION
    SELECT previous_item_json ->> 'taskId'
    FROM jsonb_array_elements(COALESCE(previous_receipt -> 'items', '[]'::jsonb))
      AS previous_items(previous_item_json)
  ) AS expected;
  expected_ids := COALESCE(expected_ids, ARRAY[]::text[]);

  SELECT array_agg(value ORDER BY value), count(DISTINCT value)
  INTO receipt_ids, now_ms
  FROM (
    SELECT receipt_item_json ->> 'taskId' AS value
    FROM jsonb_array_elements(p_receipt -> 'items')
      AS receipt_items(receipt_item_json)
  ) AS receipt_values;
  receipt_ids := COALESCE(receipt_ids, ARRAY[]::text[]);
  IF receipt_ids <> expected_ids
     OR now_ms <> cardinality(receipt_ids) THEN
    RAISE EXCEPTION 'receipt does not exactly cover the generation task set'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT array_agg(value ORDER BY value), count(DISTINCT value)
  INTO write_ids, now_ms
  FROM (
    SELECT write_entry_json -> 'definition' ->> 'taskId' AS value
    FROM jsonb_array_elements(p_writes) AS writes(write_entry_json)
  ) AS write_values;
  write_ids := COALESCE(write_ids, ARRAY[]::text[]);
  IF now_ms <> cardinality(write_ids)
     OR NOT write_ids <@ expected_ids THEN
    RAISE EXCEPTION 'writes are duplicated or outside the generation task set'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT array_agg(value ORDER BY value), count(DISTINCT value)
  INTO execution_ids, now_ms
  FROM (
    SELECT execution_entry_json ->> 'taskId' AS value
    FROM jsonb_array_elements(p_execution_revisions)
      AS executions(execution_entry_json)
  ) AS execution_values;
  execution_ids := COALESCE(execution_ids, ARRAY[]::text[]);
  IF now_ms <> cardinality(execution_ids)
     OR NOT execution_ids <@ write_ids THEN
    RAISE EXCEPTION 'execution revisions are duplicated or unbound'
      USING ERRCODE = 'check_violation';
  END IF;

  FOREACH task_id_value IN ARRAY expected_ids LOOP
    SELECT receipt_item_json INTO item
    FROM jsonb_array_elements(p_receipt -> 'items')
      AS receipt_items(receipt_item_json)
    WHERE receipt_item_json ->> 'taskId' = task_id_value;
    SELECT write_entry_json INTO write_value
    FROM jsonb_array_elements(p_writes) AS writes(write_entry_json)
    WHERE write_entry_json -> 'definition' ->> 'taskId' = task_id_value;
    definition := write_value -> 'definition';
    SELECT resource_json -> 'value' INTO resource_value
    FROM jsonb_array_elements(materialized.revision_json -> 'resources')
      AS resources(resource_json)
    WHERE resource_json ->> 'kind' = 'task'
      AND 'pkg:' || materialized.package_name || ':' ||
        (resource_json -> 'value' ->> 'id') = task_id_value;

    SELECT * INTO current_head
    FROM "ql3"."task_definitions"
    WHERE project_id = materialized.project_id AND task_id = task_id_value
    FOR UPDATE;
    IF FOUND THEN
      SELECT * INTO current_revision
      FROM "ql3"."task_definition_revisions"
      WHERE project_id = current_head.project_id
        AND task_id = current_head.task_id
        AND revision = current_head.current_revision;
      SELECT package_name INTO owner_package
      FROM "ql3"."plugin_package_task_ownerships"
      WHERE project_id = current_head.project_id
        AND task_id = current_head.task_id;
      IF owner_package IS DISTINCT FROM materialized.package_name THEN
        RAISE EXCEPTION 'TaskDefinition ownership collision'
          USING ERRCODE = 'unique_violation';
      END IF;
    ELSE
      current_revision := NULL;
      owner_package := NULL;
    END IF;

    IF item ->> 'disposition' IN ('created','updated','disabled') THEN
      IF write_value IS NULL
         OR item ->> 'contentDigest' <> definition ->> 'contentDigest'
         OR (item ->> 'revision')::integer <>
           (definition ->> 'revision')::integer
         OR write_value -> 'command' ->> 'projectId' <>
           materialized.project_id
         OR write_value -> 'command' ->> 'taskId' <> task_id_value
         OR write_value -> 'command' ->> 'mutationId' <>
           definition ->> 'mutationId' THEN
        RAISE EXCEPTION 'receipt write binding is invalid'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF write_value IS NOT NULL THEN
      RAISE EXCEPTION 'non-mutating receipt item has a write'
        USING ERRCODE = 'check_violation';
    END IF;

    IF resource_value IS NOT NULL THEN
      IF item ->> 'disposition' NOT IN ('created','retained','updated') THEN
        RAISE EXCEPTION 'active materialized Task has an invalid disposition'
          USING ERRCODE = 'check_violation';
      END IF;
      IF write_value IS NOT NULL AND (
        definition ->> 'projectId' <> materialized.project_id OR
        definition ->> 'taskId' <> task_id_value OR
        definition ->> 'name' <> resource_value ->> 'name' OR
        definition -> 'description' IS DISTINCT FROM
          resource_value -> 'description' OR
        definition ->> 'kind' <> resource_value ->> 'kind' OR
        definition -> 'spec' IS DISTINCT FROM resource_value -> 'spec' OR
        definition -> 'labels' IS DISTINCT FROM resource_value -> 'labels' OR
        definition -> 'enabled' IS DISTINCT FROM resource_value -> 'enabled'
      ) THEN
        RAISE EXCEPTION 'Task write differs from materialized resource'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF item ->> 'disposition' NOT IN ('already_disabled','disabled') THEN
        RAISE EXCEPTION 'removed Task has an invalid disposition'
          USING ERRCODE = 'check_violation';
      END IF;
      IF item ->> 'disposition' = 'disabled' AND (
        current_revision IS NULL OR
        definition ->> 'name' <> current_revision.name OR
        definition -> 'description' IS DISTINCT FROM
          to_jsonb(current_revision.description) OR
        definition ->> 'kind' <> current_revision.kind OR
        definition -> 'spec' IS DISTINCT FROM current_revision.spec_json OR
        definition -> 'labels' IS DISTINCT FROM current_revision.labels_json OR
        definition -> 'enabled' <> 'false'
      ) THEN
        RAISE EXCEPTION 'removed Task disable write is invalid'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    IF write_value IS NULL THEN
      IF current_revision IS NULL
         OR (item ->> 'revision')::integer <> current_revision.revision
         OR item ->> 'contentDigest' <> current_revision.content_digest THEN
        RAISE EXCEPTION 'retained Task head changed'
          USING ERRCODE = 'serialization_failure';
      END IF;
    ELSIF current_revision IS NULL THEN
      IF item ->> 'disposition' <> 'created'
         OR write_value -> 'command' -> 'expectedRevision' <> 'null'::jsonb
         OR (definition ->> 'revision')::integer <> 1 THEN
        RAISE EXCEPTION 'Task create CAS is invalid'
          USING ERRCODE = 'serialization_failure';
      END IF;
    ELSIF item ->> 'disposition' = 'created'
       OR (write_value -> 'command' ->> 'expectedRevision')::integer <>
         current_revision.revision
       OR (definition ->> 'revision')::integer <>
         current_revision.revision + 1 THEN
      RAISE EXCEPTION 'Task update CAS is invalid'
        USING ERRCODE = 'serialization_failure';
    END IF;

    execution_value := NULL;
    SELECT execution_entry_json INTO execution_value
    FROM jsonb_array_elements(p_execution_revisions)
      AS executions(execution_entry_json)
    WHERE execution_entry_json ->> 'taskId' = task_id_value;
    IF write_value IS NOT NULL
       AND definition -> 'enabled' = 'true'::jsonb
       AND definition ->> 'kind' = 'command'
       AND definition #>> '{spec,schema}' = 'qinglong/command@v1' THEN
      IF execution_value IS NULL
         OR (execution_value ->> 'sourceRevision')::integer <>
           (definition ->> 'revision')::integer
         OR execution_value ->> 'sourceContentDigest' <>
           definition ->> 'contentDigest' THEN
        RAISE EXCEPTION 'required execution revision is missing'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF execution_value IS NOT NULL THEN
      RAISE EXCEPTION 'unexpected execution revision'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  FOREACH task_id_value IN ARRAY write_ids LOOP
    SELECT write_entry_json INTO write_value
    FROM jsonb_array_elements(p_writes) AS writes(write_entry_json)
    WHERE write_entry_json -> 'definition' ->> 'taskId' = task_id_value;
    definition := write_value -> 'definition';
    IF write_value -> 'command' -> 'expectedRevision' = 'null'::jsonb THEN
      INSERT INTO "ql3"."task_definitions" (
        project_id, task_id, current_revision, created_at_ms, updated_at_ms
      ) VALUES (
        definition ->> 'projectId', definition ->> 'taskId', 1,
        (definition ->> 'createdAtMs')::bigint,
        (definition ->> 'updatedAtMs')::bigint
      );
      INSERT INTO "ql3"."plugin_package_task_ownerships" (
        project_id, task_id, package_name,
        claimed_generation_digest, created_at_ms
      ) VALUES (
        materialized.project_id, task_id_value, materialized.package_name,
        p_generation_digest, now_ms
      );
    END IF;
    INSERT INTO "ql3"."task_definition_revisions" (
      project_id, task_id, revision, mutation_id, name, description, kind,
      spec_json, labels_json, enabled, content_digest, created_at_ms
    ) VALUES (
      definition ->> 'projectId', definition ->> 'taskId',
      (definition ->> 'revision')::integer,
      (definition ->> 'mutationId')::uuid,
      definition ->> 'name', definition ->> 'description',
      definition ->> 'kind', definition -> 'spec', definition -> 'labels',
      (definition ->> 'enabled')::boolean, definition ->> 'contentDigest',
      (definition ->> 'updatedAtMs')::bigint
    );
    SELECT execution_entry_json INTO execution_value
    FROM jsonb_array_elements(p_execution_revisions)
      AS executions(execution_entry_json)
    WHERE execution_entry_json ->> 'taskId' = task_id_value;
    IF execution_value IS NOT NULL THEN
      INSERT INTO "ql3"."task_execution_revisions" (
        project_id, task_id, source_revision, task_revision,
        source_content_digest, executor_type, plan_schema, plan_json,
        content_digest, created_at_ms
      ) VALUES (
        execution_value ->> 'projectId', execution_value ->> 'taskId',
        (execution_value ->> 'sourceRevision')::integer,
        execution_value ->> 'taskRevision',
        execution_value ->> 'sourceContentDigest',
        execution_value ->> 'executorType',
        execution_value ->> 'planSchema',
        execution_value -> 'planJson',
        execution_value ->> 'contentDigest',
        (execution_value ->> 'createdAtMs')::bigint
      );
    END IF;
    IF write_value -> 'command' -> 'expectedRevision' <> 'null'::jsonb THEN
      UPDATE "ql3"."task_definitions" AS task_head
      SET current_revision = (definition ->> 'revision')::integer,
          updated_at_ms = (definition ->> 'updatedAtMs')::bigint
      WHERE task_head.project_id = materialized.project_id
        AND task_head.task_id = task_id_value
        AND task_head.current_revision =
          (write_value -> 'command' ->> 'expectedRevision')::integer;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Task head changed while committing'
          USING ERRCODE = 'serialization_failure';
      END IF;
    END IF;
  END LOOP;

  INSERT INTO "ql3"."plugin_package_task_reconciliations" (
    generation_digest, project_id, package_name, generation,
    materialized_revision_digest, lock_digest, previous_lock_digest,
    receipt_digest, receipt_json, committed_at_ms
  ) VALUES (
    p_generation_digest, materialized.project_id, materialized.package_name,
    materialized.generation, p_materialized_revision_digest,
    materialized.lock_digest,
    NULLIF(p_receipt ->> 'previousLockDigest', ''),
    p_receipt ->> 'receiptDigest', p_receipt,
    (p_receipt ->> 'committedAtMs')::bigint
  );
  INSERT INTO "ql3"."plugin_package_task_reconciliation_items" (
    generation_digest, task_id, revision, disposition, content_digest
  )
  SELECT p_generation_digest, receipt_item_json ->> 'taskId',
    (receipt_item_json ->> 'revision')::integer,
    receipt_item_json ->> 'disposition',
    receipt_item_json ->> 'contentDigest'
  FROM jsonb_array_elements(p_receipt -> 'items')
    AS receipt_items(receipt_item_json);
  RETURN true;
END
$ql3$
      `.trim(),
      `
REVOKE ALL
ON "ql3"."plugin_package_task_ownerships",
   "ql3"."plugin_package_task_reconciliations",
   "ql3"."plugin_package_task_reconciliation_items"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT
ON "ql3"."plugin_package_task_ownerships"
TO ql3_admin, ql3_package_executor
      `.trim(),
      `
GRANT SELECT
ON "ql3"."plugin_package_task_reconciliations",
   "ql3"."plugin_package_task_reconciliation_items",
   "ql3"."task_definitions",
   "ql3"."task_definition_revisions",
   "ql3"."task_execution_revisions"
TO ql3_package_executor
      `.trim(),
      `
REVOKE ALL
ON FUNCTION "ql3"."commit_plugin_package_task_reconciliation"(
  char(64), char(64), jsonb, jsonb, jsonb
)
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_worker_ingress
      `.trim(),
      `
GRANT EXECUTE
ON FUNCTION "ql3"."commit_plugin_package_task_reconciliation"(
  char(64), char(64), jsonb, jsonb, jsonb
)
TO ql3_package_executor
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 25,
      migration_id = 'pg-0026-plugin-package-task-reconciliations',
      capabilities = '${CAPABILITIES_V25}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 24
    AND migration_id = 'pg-0025-plugin-package-materialized-revisions'
    AND capabilities = '${CAPABILITIES_V24}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 24'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
