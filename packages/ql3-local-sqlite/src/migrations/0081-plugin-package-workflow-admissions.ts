import { defineLocalSqliteMigration } from './sqlMigration';

export const local0081PluginPackageWorkflowAdmissionsMigration =
  defineLocalSqliteMigration({
    id: '0081-plugin-package-workflow-admissions',
    statements: [
      `
CREATE TABLE "QingLong3PluginPackageWorkflowAdmissions" (
  plan_digest TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  lock_digest TEXT NOT NULL,
  generation INTEGER NOT NULL,
  generation_digest TEXT NOT NULL,
  materialized_revision_digest TEXT NOT NULL,
  publication_digest TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_definition_digest TEXT NOT NULL,
  step_count INTEGER NOT NULL,
  admitted_at_ms INTEGER NOT NULL,
  final_run_version INTEGER NOT NULL,
  final_run_event_sequence INTEGER NOT NULL,
  receipt_digest TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  CONSTRAINT ql3_plugin_package_workflow_admission_run_fk
    FOREIGN KEY (run_id) REFERENCES "Runs" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_admission_publication_fk
    FOREIGN KEY (publication_digest)
    REFERENCES "QingLong3PluginPackageAutomationPublications" (
      publication_digest
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_admission_identity_check CHECK (
    length(plan_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(package_name) BETWEEN 1 AND 63 AND
    length(installation_id) BETWEEN 1 AND 128 AND
    length(workflow_id) BETWEEN 1 AND 63 AND
    generation BETWEEN 1 AND 2147483647 AND
    step_count BETWEEN 1 AND 128 AND
    admitted_at_ms >= 0 AND
    final_run_version = step_count + 1 AND
    final_run_event_sequence = step_count + 1
  ),
  CONSTRAINT ql3_plugin_package_workflow_admission_digest_check CHECK (
    length(plan_digest) = 64 AND
      plan_digest NOT GLOB '*[^0-9a-f]*' AND
    length(lock_digest) = 64 AND
      lock_digest NOT GLOB '*[^0-9a-f]*' AND
    length(generation_digest) = 64 AND
      generation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(materialized_revision_digest) = 64 AND
      materialized_revision_digest NOT GLOB '*[^0-9a-f]*' AND
    length(publication_digest) = 64 AND
      publication_digest NOT GLOB '*[^0-9a-f]*' AND
    length(workflow_definition_digest) = 64 AND
      workflow_definition_digest NOT GLOB '*[^0-9a-f]*' AND
    length(receipt_digest) = 64 AND
      receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_plugin_package_workflow_admission_plan_json_check CHECK (
    length(CAST(plan_json AS BLOB)) BETWEEN 2 AND 262144 AND
    json_valid(plan_json) AND json_type(plan_json) = 'object' AND
    json_extract(plan_json, '$.schema') =
      'qinglong/plugin-package-workflow-execution-plan@v1' AND
    json_extract(plan_json, '$.planId') = plan_id AND
    json_extract(plan_json, '$.planDigest') = plan_digest AND
    json_extract(plan_json, '$.runId') = run_id AND
    json_extract(plan_json, '$.target.projectId') = project_id AND
    json_extract(plan_json, '$.target.packageName') = package_name AND
    json_extract(plan_json, '$.target.installationId') = installation_id AND
    json_extract(plan_json, '$.target.lockDigest') = lock_digest AND
    json_extract(plan_json, '$.target.generation') = generation AND
    json_extract(plan_json, '$.target.generationDigest') =
      generation_digest AND
    json_extract(plan_json, '$.target.materializedRevisionDigest') =
      materialized_revision_digest AND
    json_extract(plan_json, '$.target.publicationDigest') =
      publication_digest AND
    json_extract(plan_json, '$.target.workflowId') = workflow_id AND
    json_extract(plan_json, '$.target.workflowDefinitionDigest') =
      workflow_definition_digest AND
    json_extract(plan_json, '$.plannedAtMs') = admitted_at_ms AND
    json_array_length(json_extract(plan_json, '$.steps')) = step_count
  ),
  CONSTRAINT ql3_plugin_package_workflow_admission_receipt_json_check CHECK (
    length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 262144 AND
    json_valid(receipt_json) AND json_type(receipt_json) = 'object' AND
    json_extract(receipt_json, '$.schema') =
      'qinglong/plugin-package-workflow-admission-receipt@v1' AND
    json_extract(receipt_json, '$.planId') = plan_id AND
    json_extract(receipt_json, '$.planDigest') = plan_digest AND
    json_extract(receipt_json, '$.runId') = run_id AND
    json_extract(receipt_json, '$.publicationDigest') =
      publication_digest AND
    json_extract(receipt_json, '$.workflowId') = workflow_id AND
    json_extract(receipt_json, '$.admittedAtMs') = admitted_at_ms AND
    json_extract(receipt_json, '$.finalRunVersion') =
      final_run_version AND
    json_extract(receipt_json, '$.finalRunEventSequence') =
      final_run_event_sequence AND
    json_extract(receipt_json, '$.receiptDigest') = receipt_digest AND
    json_array_length(json_extract(receipt_json, '$.steps')) = step_count
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_workflow_admission_plan_uidx ON "QingLong3PluginPackageWorkflowAdmissions" (plan_id)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_workflow_admission_run_uidx ON "QingLong3PluginPackageWorkflowAdmissions" (run_id)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_workflow_admission_receipt_uidx ON "QingLong3PluginPackageWorkflowAdmissions" (receipt_digest)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_workflow_admission_plan_run_uidx ON "QingLong3PluginPackageWorkflowAdmissions" (plan_digest, run_id)`,
      `CREATE INDEX ql3_plugin_package_workflow_admission_target_idx ON "QingLong3PluginPackageWorkflowAdmissions" (project_id, package_name, admitted_at_ms, plan_digest)`,
      `
CREATE TABLE "QingLong3PluginPackageWorkflowAdmissionSteps" (
  plan_digest TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_definition_ref TEXT NOT NULL,
  task_definition_digest TEXT NOT NULL,
  needs_json TEXT NOT NULL,
  initial_status TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (plan_digest, step_key),
  CONSTRAINT ql3_plugin_package_workflow_admission_step_admission_fk
    FOREIGN KEY (plan_digest, run_id)
    REFERENCES "QingLong3PluginPackageWorkflowAdmissions" (
      plan_digest, run_id
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_admission_step_run_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "StepRuns" (run_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_admission_step_mutation_fk
    FOREIGN KEY (mutation_id) REFERENCES "StepRunMutations" (mutation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_admission_step_event_fk
    FOREIGN KEY (event_id) REFERENCES "RunEvents" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_admission_step_identity_check CHECK (
    length(run_id) BETWEEN 1 AND 128 AND
    length(step_key) BETWEEN 1 AND 63 AND
    length(step_run_id) BETWEEN 1 AND 128 AND
    length(task_id) BETWEEN 1 AND 63 AND
    length(CAST(task_definition_ref AS BLOB)) BETWEEN 1 AND 512 AND
    length(mutation_id) BETWEEN 1 AND 128 AND
    length(event_id) BETWEEN 1 AND 128 AND
    initial_status IN ('pending','ready')
  ),
  CONSTRAINT ql3_plugin_package_workflow_admission_step_digest_check CHECK (
    length(plan_digest) = 64 AND
      plan_digest NOT GLOB '*[^0-9a-f]*' AND
    length(task_definition_digest) = 64 AND
      task_definition_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_plugin_package_workflow_admission_step_needs_check CHECK (
    length(CAST(needs_json AS BLOB)) BETWEEN 2 AND 8192 AND
    json_valid(needs_json) AND json_type(needs_json) = 'array' AND
    json_array_length(needs_json) BETWEEN 0 AND 127
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_workflow_admission_step_run_uidx ON "QingLong3PluginPackageWorkflowAdmissionSteps" (step_run_id)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_workflow_admission_step_mutation_uidx ON "QingLong3PluginPackageWorkflowAdmissionSteps" (mutation_id)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_workflow_admission_step_event_uidx ON "QingLong3PluginPackageWorkflowAdmissionSteps" (event_id)`,
      `CREATE INDEX ql3_plugin_package_workflow_admission_step_task_idx ON "QingLong3PluginPackageWorkflowAdmissionSteps" (task_id, task_definition_digest, plan_digest)`,
    ],
  });
