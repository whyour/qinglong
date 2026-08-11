import { defineLocalSqliteMigration } from './sqlMigration';

export const local0083PluginPackageWorkflowTaskAttemptAdmissionsMigration =
  defineLocalSqliteMigration({
    id: '0083-plugin-package-workflow-task-attempt-admissions',
    statements: [
      `CREATE UNIQUE INDEX ql3_plugin_package_task_reconciliation_receipt_uidx ON "QingLong3PluginPackageTaskReconciliations" (generation_digest, receipt_digest)`,
      `
CREATE TABLE "QingLong3PluginPackageWorkflowTaskAttemptAdmissions" (
  receipt_digest TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  step_run_version INTEGER NOT NULL,
  step_run_digest TEXT NOT NULL,
  generation_digest TEXT NOT NULL,
  resource_task_id TEXT NOT NULL,
  task_reconciliation_receipt_digest TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_revision TEXT NOT NULL,
  task_definition_digest TEXT NOT NULL,
  executor_type TEXT NOT NULL,
  execution_digest TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  run_version INTEGER NOT NULL,
  run_event_sequence INTEGER NOT NULL,
  admitted_at_ms INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_plan_fk
    FOREIGN KEY (plan_digest, run_id)
    REFERENCES "QingLong3PluginPackageWorkflowAdmissions" (
      plan_digest, run_id
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "StepRuns" (run_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_attempt_fk
    FOREIGN KEY (attempt_id) REFERENCES "RunAttempts" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_event_fk
    FOREIGN KEY (event_id) REFERENCES "RunEvents" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_reconciliation_fk
    FOREIGN KEY (
      generation_digest, task_reconciliation_receipt_digest
    ) REFERENCES "QingLong3PluginPackageTaskReconciliations" (
      generation_digest, receipt_digest
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_execution_fk
    FOREIGN KEY (project_id, task_id, task_revision)
    REFERENCES "QingLong3LocalTaskExecutionRevisions" (
      project_id, task_id, task_revision
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_identity_check
    CHECK (
      length(attempt_id) BETWEEN 1 AND 128 AND
      length(run_id) BETWEEN 1 AND 128 AND
      length(step_run_id) BETWEEN 1 AND 128 AND
      length(resource_task_id) BETWEEN 1 AND 128 AND
      length(project_id) BETWEEN 1 AND 128 AND
      length(task_id) BETWEEN 1 AND 128 AND
      length(task_revision) BETWEEN 1 AND 128 AND
      length(event_id) BETWEEN 1 AND 128 AND
      executor_type = 'local_process'
    ),
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_counter_check
    CHECK (
      step_run_version BETWEEN 1 AND 2147483647 AND
      attempt_number BETWEEN 1 AND 8192 AND
      run_version BETWEEN 1 AND 2147483647 AND
      run_event_sequence = run_version AND
      admitted_at_ms >= 0
    ),
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_digest_check
    CHECK (
      length(receipt_digest) = 64 AND
        receipt_digest NOT GLOB '*[^0-9a-f]*' AND
      length(plan_digest) = 64 AND
        plan_digest NOT GLOB '*[^0-9a-f]*' AND
      length(step_run_digest) = 64 AND
        step_run_digest NOT GLOB '*[^0-9a-f]*' AND
      length(generation_digest) = 64 AND
        generation_digest NOT GLOB '*[^0-9a-f]*' AND
      length(task_reconciliation_receipt_digest) = 64 AND
        task_reconciliation_receipt_digest NOT GLOB '*[^0-9a-f]*' AND
      length(task_definition_digest) = 64 AND
        task_definition_digest NOT GLOB '*[^0-9a-f]*' AND
      length(execution_digest) = 64 AND
        execution_digest NOT GLOB '*[^0-9a-f]*'
    ),
  CONSTRAINT ql3_plugin_package_workflow_task_attempt_admission_json_check
    CHECK (
      length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 16384 AND
      json_valid(receipt_json) AND json_type(receipt_json) = 'object' AND
      json_extract(receipt_json, '$.schema') =
        'qinglong/plugin-package-workflow-task-attempt-admission@v1' AND
      json_extract(receipt_json, '$.receiptDigest') = receipt_digest AND
      json_extract(receipt_json, '$.attemptId') = attempt_id AND
      json_extract(receipt_json, '$.planDigest') = plan_digest AND
      json_extract(receipt_json, '$.runId') = run_id AND
      json_extract(receipt_json, '$.stepRunId') = step_run_id AND
      json_extract(receipt_json, '$.stepRunVersion') = step_run_version AND
      json_extract(receipt_json, '$.stepRunDigest') = step_run_digest AND
      json_extract(receipt_json, '$.resourceTaskId') = resource_task_id AND
      json_extract(
        receipt_json, '$.taskReconciliationReceiptDigest'
      ) = task_reconciliation_receipt_digest AND
      json_extract(receipt_json, '$.taskId') = task_id AND
      json_extract(receipt_json, '$.taskRevision') = task_revision AND
      json_extract(receipt_json, '$.taskDefinitionDigest') =
        task_definition_digest AND
      json_extract(receipt_json, '$.executorType') = executor_type AND
      json_extract(receipt_json, '$.executionDigest') = execution_digest AND
      json_extract(receipt_json, '$.attemptNumber') = attempt_number AND
      json_extract(receipt_json, '$.eventId') = event_id AND
      json_extract(receipt_json, '$.runVersion') = run_version AND
      json_extract(receipt_json, '$.runEventSequence') =
        run_event_sequence AND
      json_extract(receipt_json, '$.admittedAtMs') = admitted_at_ms
    )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_workflow_task_attempt_admission_attempt_uidx ON "QingLong3PluginPackageWorkflowTaskAttemptAdmissions" (attempt_id)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_workflow_task_attempt_admission_event_uidx ON "QingLong3PluginPackageWorkflowTaskAttemptAdmissions" (event_id)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_workflow_task_attempt_admission_epoch_uidx ON "QingLong3PluginPackageWorkflowTaskAttemptAdmissions" (run_id, step_run_id, step_run_version)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_workflow_task_attempt_admission_number_uidx ON "QingLong3PluginPackageWorkflowTaskAttemptAdmissions" (run_id, attempt_number)`,
      `CREATE INDEX ql3_plugin_package_workflow_task_attempt_admission_candidate_idx ON "QingLong3PluginPackageWorkflowTaskAttemptAdmissions" (run_id, step_run_id, admitted_at_ms)`,
    ],
  });
