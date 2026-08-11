import { defineLocalSqliteMigration } from './sqlMigration';

export const local0085PluginPackageWorkflowRunListIndexMigration =
  defineLocalSqliteMigration({
    id: '0085-plugin-package-workflow-run-list-index',
    statements: [
      `CREATE INDEX ql3_plugin_package_workflow_admission_workflow_history_idx ON "QingLong3PluginPackageWorkflowAdmissions" (project_id, package_name, workflow_id, admitted_at_ms, run_id)`,
    ],
  });
