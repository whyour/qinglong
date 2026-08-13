const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PostgresSchemaReadinessError,
  assertPostgresAdminSchemaReady,
  assertPostgresApprovalManagerSchemaReady,
  assertPostgresRunManagerSchemaReady,
  assertPostgresAutomationManagerSchemaReady,
  assertPostgresPackageExecutorSchemaReady,
  assertPostgresPackageManagerSchemaReady,
  assertPostgresSchemaReady,
  assertPostgresWorkerCredentialExecutorSchemaReady,
  assertPostgresWorkerCredentialManagerSchemaReady,
  assertPostgresWorkerIngressSchemaReady,
} = require('../dist/schema/schemaReadiness');
const {
  postgresqlControlSchemaContract,
} = require('../dist/schema/schemaContract');
const { postgresqlMainMigrationStream } = require('../dist/migrations');

function validHistory() {
  return postgresqlMainMigrationStream.migrations.map((migration, index) => ({
    streamId: 'postgresql-main',
    dialect: 'postgresql',
    migrationId: migration.id,
    checksum: migration.checksum,
    appliedAtMs: index + 1,
  }));
}

function validPrivileges() {
  const expected = {
    schema_migrations: [true, false, false, false],
    schema_capabilities: [true, false, false, false],
    projects: [true, true, true, false],
    task_definitions: [true, false, false, false],
    task_definition_revisions: [true, false, false, false],
    task_execution_revisions: [true, false, false, false],
    triggers: [true, false, false, false],
    trigger_revisions: [true, false, false, false],
    trigger_schedules: [true, false, true, false],
    project_role_bindings: [true, true, false, false],
    identity_subjects: [true, false, false, false],
    api_credentials: [true, false, false, false],
    security_audit_events: [false, true, false, false],
    identity_subject_mutations: [false, false, false, false],
    api_credential_mutations: [false, false, false, false],
    runs: [true, true, true, false],
    step_runs: [true, true, true, false],
    tool_execution_trace_anchors: [true, true, false, false],
    tool_execution_audit_receipts: [true, true, false, false],
    tool_execution_start_barriers: [true, true, false, false],
    tool_execution_start_artifact_bindings: [true, true, false, false],
    tool_execution_completions: [true, true, false, false],
    tool_execution_failure_completions: [true, true, false, false],
    tool_result_key_catalog_generations: [true, false, false, false],
    tool_execution_result_key_bindings: [true, true, false, false],
    tool_execution_result_rekey_overlays: [true, false, false, false],
    tool_execution_result_rekey_heads: [true, false, false, false],
    tool_result_key_retirement_receipts: [false, false, false, false],
    tool_invocation_input_artifacts: [true, true, false, false],
    tool_invocation_preview_artifacts: [true, true, false, false],
    run_attempts: [true, true, true, false],
    run_attempt_log_retention_controls: [true, true, true, true],
    run_attempt_log_artifact_tombstones: [true, true, false, false],
    worker_sessions: [true, true, true, false],
    run_dispatch_leases: [true, true, true, false],
    worker_credentials: [false, false, false, false],
    worker_credential_management_plans: [false, false, false, false],
    worker_credential_mutations: [false, false, false, false],
    worker_credential_deliveries: [false, false, false, false],
    worker_credential_stage_discards: [false, false, false, false],
    plugin_package_installs: [false, false, false, false],
    plugin_package_install_heads: [false, false, false, false],
    plugin_package_install_mutations: [false, false, false, false],
    plugin_package_materialized_revisions: [false, false, false, false],
    plugin_package_secret_bindings: [false, false, false, false],
    plugin_package_secret_binding_approval_plans: [false, false, false, false],
    plugin_package_secret_binding_transition_approval_plans: [
      false,
      false,
      false,
      false,
    ],
    plugin_package_secret_binding_transition_receipts: [
      false,
      false,
      false,
      false,
    ],
    project_tool_definition_snapshots: [false, false, false, false],
    project_tool_definition_snapshot_sources: [false, false, false, false],
    plugin_package_quarantine_events: [false, false, false, false],
    plugin_package_withdrawal_receipts: [false, false, false, false],
    plugin_package_withdrawal_tasks: [false, false, false, false],
    plugin_package_lifecycle_events: [false, false, false, false],
    plugin_package_lifecycle_heads: [false, false, false, false],
    plugin_package_lifecycle_receipts: [false, false, false, false],
    plugin_package_lifecycle_tasks: [false, false, false, false],
    plugin_package_lifecycle_plans: [false, false, false, false],
    plugin_package_automation_publications: [true, false, false, false],
    plugin_package_automation_disposition_events: [false, false, false, false],
    plugin_package_automation_publication_heads: [true, false, false, false],
    plugin_package_workflow_admissions: [true, true, false, false],
    plugin_package_workflow_admission_steps: [true, true, false, false],
    plugin_package_workflow_task_attempt_admissions: [true, true, false, false],
    plugin_package_publisher_provenance: [false, false, false, false],
    plugin_package_publisher_revocation_receipts: [false, false, false, false],
    plugin_package_publisher_revocation_impacts: [false, false, false, false],
    plugin_package_publisher_revocation_impact_items: [
      false,
      false,
      false,
      false,
    ],
    plugin_package_publisher_trust_snapshots: [false, false, false, false],
    plugin_package_publisher_trust_heads: [false, false, false, false],
    plugin_package_publisher_revocation_proposals: [false, false, false, false],
    plugin_package_publisher_trust_transition_proposals: [
      false,
      false,
      false,
      false,
    ],
    plugin_package_publisher_trust_transition_receipts: [
      false,
      false,
      false,
      false,
    ],
    plugin_package_task_ownerships: [false, false, false, false],
    plugin_package_task_reconciliations: [false, false, false, false],
    plugin_package_task_reconciliation_items: [false, false, false, false],
    approval_requests: [false, false, false, false],
    approved_action_dispatches: [false, false, false, false],
    approved_action_executions: [false, false, false, false],
    plugin_package_install_proposals: [false, false, false, false],
    plugin_package_management_quota_buckets: [false, false, false, false],
    plugin_package_identity_keyset_ledger: [false, false, false, false],
    worker_credential_management_quota_buckets: [false, false, false, false],
    plugin_package_admission_receipts: [false, false, false, false],
    worker_execution_attestations: [true, false, false, false],
    run_recovery_controls: [true, true, true, false],
    run_events: [true, true, false, false],
    step_run_mutations: [true, true, false, false],
    run_retry_policies: [true, true, true, false],
  };
  return Object.entries(expected).map(
    ([
      tableName,
      [selectAllowed, insertAllowed, updateAllowed, deleteAllowed],
    ]) => ({
      tableName,
      selectAllowed,
      insertAllowed,
      updateAllowed,
      deleteAllowed,
      isOwner: false,
    }),
  );
}

function validAdminPrivileges() {
  const expected = {
    schema_migrations: [true, false, false, false],
    schema_capabilities: [true, false, false, false],
    projects: [true, false, false, false],
    task_definitions: [false, false, false, false],
    task_definition_revisions: [false, false, false, false],
    task_execution_revisions: [false, false, false, false],
    triggers: [false, false, false, false],
    trigger_revisions: [false, false, false, false],
    trigger_schedules: [false, false, false, false],
    project_role_bindings: [false, false, false, false],
    identity_subjects: [true, true, true, false],
    api_credentials: [true, true, false, false],
    security_audit_events: [true, true, false, false],
    identity_subject_mutations: [true, true, false, false],
    api_credential_mutations: [true, true, false, false],
    runs: [false, false, false, false],
    step_runs: [false, false, false, false],
    tool_execution_trace_anchors: [false, false, false, false],
    tool_execution_audit_receipts: [false, false, false, false],
    tool_execution_start_barriers: [false, false, false, false],
    tool_execution_start_artifact_bindings: [false, false, false, false],
    tool_execution_completions: [true, false, false, false],
    tool_execution_failure_completions: [false, false, false, false],
    tool_result_key_catalog_generations: [true, true, false, false],
    tool_execution_result_key_bindings: [true, false, false, false],
    tool_execution_result_rekey_overlays: [true, true, false, false],
    tool_execution_result_rekey_heads: [true, true, true, false],
    tool_result_key_retirement_receipts: [true, true, false, false],
    tool_invocation_input_artifacts: [false, false, false, false],
    tool_invocation_preview_artifacts: [false, false, false, false],
    run_attempts: [false, false, false, false],
    run_attempt_log_retention_controls: [false, false, false, false],
    run_attempt_log_artifact_tombstones: [false, false, false, false],
    worker_sessions: [false, false, false, false],
    run_dispatch_leases: [false, false, false, false],
    worker_credentials: [true, true, true, false],
    worker_credential_management_plans: [false, false, false, false],
    worker_credential_mutations: [true, true, false, false],
    worker_credential_deliveries: [true, true, false, false],
    worker_credential_stage_discards: [true, true, false, false],
    plugin_package_installs: [false, false, false, false],
    plugin_package_install_heads: [false, false, false, false],
    plugin_package_install_mutations: [false, false, false, false],
    plugin_package_materialized_revisions: [false, false, false, false],
    plugin_package_secret_bindings: [false, false, false, false],
    plugin_package_secret_binding_approval_plans: [false, false, false, false],
    plugin_package_secret_binding_transition_approval_plans: [
      false,
      false,
      false,
      false,
    ],
    plugin_package_secret_binding_transition_receipts: [
      false,
      false,
      false,
      false,
    ],
    project_tool_definition_snapshots: [false, false, false, false],
    project_tool_definition_snapshot_sources: [false, false, false, false],
    plugin_package_quarantine_events: [false, false, false, false],
    plugin_package_withdrawal_receipts: [false, false, false, false],
    plugin_package_withdrawal_tasks: [false, false, false, false],
    plugin_package_lifecycle_events: [false, false, false, false],
    plugin_package_lifecycle_heads: [false, false, false, false],
    plugin_package_lifecycle_receipts: [false, false, false, false],
    plugin_package_lifecycle_tasks: [false, false, false, false],
    plugin_package_lifecycle_plans: [false, false, false, false],
    plugin_package_automation_publications: [false, false, false, false],
    plugin_package_automation_disposition_events: [false, false, false, false],
    plugin_package_automation_publication_heads: [false, false, false, false],
    plugin_package_workflow_admissions: [false, false, false, false],
    plugin_package_workflow_admission_steps: [false, false, false, false],
    plugin_package_workflow_task_attempt_admissions: [
      false,
      false,
      false,
      false,
    ],
    plugin_package_publisher_provenance: [false, false, false, false],
    plugin_package_publisher_revocation_receipts: [false, false, false, false],
    plugin_package_publisher_revocation_impacts: [false, false, false, false],
    plugin_package_publisher_revocation_impact_items: [
      false,
      false,
      false,
      false,
    ],
    plugin_package_publisher_trust_snapshots: [false, false, false, false],
    plugin_package_publisher_trust_heads: [false, false, false, false],
    plugin_package_publisher_revocation_proposals: [false, false, false, false],
    plugin_package_publisher_trust_transition_proposals: [
      false,
      false,
      false,
      false,
    ],
    plugin_package_publisher_trust_transition_receipts: [
      false,
      false,
      false,
      false,
    ],
    plugin_package_task_ownerships: [true, false, false, false],
    plugin_package_task_reconciliations: [false, false, false, false],
    plugin_package_task_reconciliation_items: [false, false, false, false],
    approval_requests: [false, false, false, false],
    approved_action_dispatches: [false, false, false, false],
    approved_action_executions: [false, false, false, false],
    plugin_package_install_proposals: [false, false, false, false],
    plugin_package_management_quota_buckets: [false, false, false, false],
    plugin_package_identity_keyset_ledger: [false, false, false, false],
    worker_credential_management_quota_buckets: [false, false, false, false],
    plugin_package_admission_receipts: [false, false, false, false],
    worker_execution_attestations: [false, false, false, false],
    run_recovery_controls: [false, false, false, false],
    run_events: [false, false, false, false],
    step_run_mutations: [false, false, false, false],
    run_retry_policies: [false, false, false, false],
  };
  return Object.entries(expected).map(
    ([
      tableName,
      [selectAllowed, insertAllowed, updateAllowed, deleteAllowed],
    ]) => ({
      tableName,
      selectAllowed,
      insertAllowed,
      updateAllowed,
      deleteAllowed,
      isOwner: false,
    }),
  );
}

function packagePrivileges(kind) {
  return postgresqlControlSchemaContract.tables.map(({ name: tableName }) => {
    const manager = kind === 'manager';
    const readable = new Set([
      'schema_migrations',
      'schema_capabilities',
      'projects',
      'project_role_bindings',
      'security_audit_events',
      'plugin_package_install_proposals',
      'plugin_package_publisher_trust_snapshots',
      'plugin_package_publisher_trust_heads',
      'plugin_package_publisher_revocation_proposals',
      'plugin_package_publisher_trust_transition_proposals',
      'plugin_package_publisher_trust_transition_receipts',
      'plugin_package_lifecycle_plans',
      'plugin_package_secret_binding_approval_plans',
      'plugin_package_secret_binding_transition_approval_plans',
      'plugin_package_automation_publications',
      'plugin_package_automation_publication_heads',
      ...(manager
        ? [
            'approval_requests',
            'plugin_package_management_quota_buckets',
            'plugin_package_identity_keyset_ledger',
            'plugin_package_publisher_trust_heads',
          ]
        : [
            'approval_requests',
            'approved_action_dispatches',
            'approved_action_executions',
            'plugin_package_installs',
            'plugin_package_install_heads',
            'plugin_package_install_mutations',
            'plugin_package_materialized_revisions',
            'plugin_package_secret_bindings',
            'plugin_package_secret_binding_transition_receipts',
            'project_tool_definition_snapshots',
            'project_tool_definition_snapshot_sources',
            'plugin_package_admission_receipts',
            'plugin_package_task_ownerships',
            'plugin_package_task_reconciliations',
            'plugin_package_task_reconciliation_items',
            'plugin_package_quarantine_events',
            'plugin_package_withdrawal_receipts',
            'plugin_package_withdrawal_tasks',
            'plugin_package_lifecycle_events',
            'plugin_package_lifecycle_heads',
            'plugin_package_lifecycle_receipts',
            'plugin_package_lifecycle_tasks',
            'plugin_package_publisher_provenance',
            'plugin_package_publisher_revocation_receipts',
            'plugin_package_publisher_revocation_impacts',
            'plugin_package_publisher_revocation_impact_items',
            'task_definitions',
            'task_definition_revisions',
            'task_execution_revisions',
          ]),
    ]);
    const insertable = manager
      ? new Set([
          'security_audit_events',
          'plugin_package_install_proposals',
          'approval_requests',
          'plugin_package_management_quota_buckets',
          'plugin_package_identity_keyset_ledger',
          'plugin_package_publisher_trust_snapshots',
          'plugin_package_publisher_trust_heads',
          'plugin_package_publisher_revocation_proposals',
          'plugin_package_publisher_trust_transition_proposals',
        ])
      : new Set([
          'security_audit_events',
          'approved_action_dispatches',
          'approved_action_executions',
          'plugin_package_installs',
          'plugin_package_install_heads',
          'plugin_package_install_mutations',
          'plugin_package_materialized_revisions',
          'plugin_package_secret_bindings',
          'plugin_package_secret_binding_transition_receipts',
          'plugin_package_automation_publications',
          'plugin_package_automation_publication_heads',
          'project_tool_definition_snapshots',
          'project_tool_definition_snapshot_sources',
          'plugin_package_lifecycle_plans',
          'plugin_package_admission_receipts',
          'plugin_package_publisher_provenance',
          'plugin_package_publisher_revocation_receipts',
          'plugin_package_publisher_revocation_impacts',
          'plugin_package_publisher_revocation_impact_items',
          'plugin_package_publisher_trust_snapshots',
          'plugin_package_publisher_trust_transition_receipts',
        ]);
    const updateable = manager
      ? new Set([
          'approval_requests',
          'plugin_package_management_quota_buckets',
          'plugin_package_identity_keyset_ledger',
        ])
      : new Set([
          'approval_requests',
          'approved_action_executions',
          'plugin_package_installs',
          'plugin_package_install_heads',
          'plugin_package_automation_publication_heads',
          'plugin_package_publisher_trust_heads',
        ]);
    return {
      tableName,
      selectAllowed: readable.has(tableName),
      insertAllowed: insertable.has(tableName),
      updateAllowed: updateable.has(tableName),
      deleteAllowed: false,
      isOwner: false,
    };
  });
}

function validWorkerIngressPrivileges() {
  const readable = new Set([
    'schema_migrations',
    'schema_capabilities',
    'run_attempts',
    'run_dispatch_leases',
    'worker_credentials',
    'worker_sessions',
    'worker_execution_attestations',
    'worker_credential_deliveries',
  ]);
  return postgresqlControlSchemaContract.tables.map(({ name: tableName }) => ({
    tableName,
    selectAllowed: readable.has(tableName),
    insertAllowed: [
      'security_audit_events',
      'worker_sessions',
      'worker_execution_attestations',
      'worker_credential_deliveries',
    ].includes(tableName),
    updateAllowed: tableName === 'worker_sessions',
    deleteAllowed: false,
    isOwner: false,
  }));
}

function automationManagerPrivileges() {
  const readable = new Set([
    'schema_migrations',
    'schema_capabilities',
    'projects',
    'project_role_bindings',
    'plugin_package_task_ownerships',
    'plugin_package_identity_keyset_ledger',
    'security_audit_events',
    'task_definitions',
    'task_definition_revisions',
    'task_execution_revisions',
    'triggers',
    'trigger_revisions',
    'trigger_schedules',
  ]);
  const insertable = new Set([
    'security_audit_events',
    'task_definitions',
    'task_definition_revisions',
    'task_execution_revisions',
    'triggers',
    'trigger_revisions',
    'trigger_schedules',
    'plugin_package_identity_keyset_ledger',
  ]);
  return postgresqlControlSchemaContract.tables.map(({ name: tableName }) => ({
    tableName,
    selectAllowed: readable.has(tableName),
    insertAllowed: insertable.has(tableName),
    updateAllowed: [
      'task_definitions',
      'triggers',
      'trigger_schedules',
      'plugin_package_identity_keyset_ledger',
    ].includes(tableName),
    deleteAllowed: false,
    isOwner: false,
  }));
}

function approvalManagerPrivileges() {
  const readable = new Set([
    'schema_migrations',
    'schema_capabilities',
    'projects',
    'project_role_bindings',
    'security_audit_events',
    'approval_requests',
    'tool_invocation_preview_artifacts',
    'plugin_package_identity_keyset_ledger',
  ]);
  return postgresqlControlSchemaContract.tables.map(({ name: tableName }) => ({
    tableName,
    selectAllowed: readable.has(tableName),
    insertAllowed:
      tableName === 'security_audit_events' ||
      tableName === 'plugin_package_identity_keyset_ledger',
    updateAllowed:
      tableName === 'approval_requests' ||
      tableName === 'plugin_package_identity_keyset_ledger',
    deleteAllowed: false,
    isOwner: false,
  }));
}

function runManagerPrivileges() {
  const readable = new Set([
    'schema_migrations',
    'schema_capabilities',
    'projects',
    'project_role_bindings',
    'task_definitions',
    'task_definition_revisions',
    'task_execution_revisions',
    'runs',
    'run_attempts',
    'run_events',
    'security_audit_events',
    'plugin_package_identity_keyset_ledger',
  ]);
  return postgresqlControlSchemaContract.tables.map(({ name: tableName }) => ({
    tableName,
    selectAllowed: readable.has(tableName),
    insertAllowed: [
      'runs',
      'run_attempts',
      'run_events',
      'security_audit_events',
      'plugin_package_identity_keyset_ledger',
    ].includes(tableName),
    updateAllowed: tableName === 'plugin_package_identity_keyset_ledger',
    deleteAllowed: false,
    isOwner: false,
  }));
}

function workerCredentialPrivileges(kind) {
  const manager = kind === 'manager';
  const readable = new Set([
    'schema_migrations',
    'schema_capabilities',
    'projects',
    'project_role_bindings',
    'security_audit_events',
    'approval_requests',
    'worker_credential_management_plans',
    ...(manager
      ? [
          'worker_credential_management_quota_buckets',
          'plugin_package_identity_keyset_ledger',
        ]
      : []),
    ...(manager
      ? []
      : [
          'approved_action_dispatches',
          'approved_action_executions',
          'worker_credentials',
          'worker_credential_mutations',
          'worker_credential_deliveries',
          'worker_credential_stage_discards',
        ]),
  ]);
  const insertable = new Set(
    manager
      ? [
          'security_audit_events',
          'approval_requests',
          'worker_credential_management_plans',
          'worker_credential_management_quota_buckets',
          'plugin_package_identity_keyset_ledger',
        ]
      : [
          'security_audit_events',
          'approved_action_dispatches',
          'approved_action_executions',
          'worker_credentials',
          'worker_credential_mutations',
          'worker_credential_deliveries',
          'worker_credential_stage_discards',
        ],
  );
  return postgresqlControlSchemaContract.tables.map(({ name: tableName }) => ({
    tableName,
    selectAllowed: readable.has(tableName),
    insertAllowed: insertable.has(tableName),
    updateAllowed:
      tableName === 'approval_requests' ||
      (manager &&
        (tableName === 'worker_credential_management_quota_buckets' ||
          tableName === 'plugin_package_identity_keyset_ledger')) ||
      (!manager && tableName === 'approved_action_executions'),
    deleteAllowed: false,
    isOwner: false,
  }));
}

function queryable(overrides = {}) {
  const contract = postgresqlControlSchemaContract;
  return {
    async query(text) {
      if (text.includes("current_setting('server_version_num')")) {
        return {
          rows: [
            {
              serverVersionNum: overrides.serverVersionNum ?? '160014',
              currentUser: overrides.currentUser ?? 'ql3_runtime',
              inRecovery: overrides.inRecovery ?? false,
              transactionReadOnly: overrides.transactionReadOnly ?? 'off',
            },
          ],
        };
      }
      if (text.includes('FROM "ql3"."schema_migrations"')) {
        return { rows: overrides.history ?? validHistory() };
      }
      if (text.includes('FROM "ql3"."schema_capabilities"')) {
        return {
          rows: [
            overrides.capability ?? {
              contractName: 'control-core',
              contractVersion: contract.contractVersion,
              migrationId: contract.migrationId,
              capabilities: contract.capabilities,
            },
          ],
        };
      }
      if (text.includes('FROM pg_catalog.pg_roles')) {
        return {
          rows: [
            {
              canLogin: true,
              superuser: overrides.superuser ?? false,
              createDatabase: false,
              createRole: false,
              replication: false,
              bypassRowLevelSecurity: false,
              databaseConnect: true,
            },
          ],
        };
      }
      if (text.includes('FROM pg_class tables')) {
        const rows = contract.tables.flatMap((table) =>
          table.columns.map((columnName) => ({
            tableName: table.name,
            columnName,
          })),
        );
        if (overrides.extraTable) {
          rows.push({ tableName: overrides.extraTable, columnName: 'id' });
        }
        return { rows };
      }
      if (text.includes('FROM pg_indexes')) {
        return {
          rows: [
            ...contract.indexes.map((indexName) => ({ indexName })),
            ...(overrides.extraIndex
              ? [{ indexName: overrides.extraIndex }]
              : []),
          ],
        };
      }
      if (text.includes('FROM pg_constraint')) {
        return {
          rows: [
            ...contract.checks.map((constraintName) => ({
              constraintName,
              constraintType: 'check',
            })),
            ...contract.foreignKeys.map((constraintName) => ({
              constraintName,
              constraintType: 'foreign_key',
            })),
            ...(overrides.extraConstraint
              ? [
                  {
                    constraintName: overrides.extraConstraint,
                    constraintType: 'check',
                  },
                ]
              : []),
          ],
        };
      }
      if (text.includes('has_function_privilege')) {
        return {
          rows:
            overrides.functionPrivileges ??
            contract.functions.map(({ name: functionName }) => ({
              functionName,
              executeAllowed:
                overrides.functionMode === 'package-manager'
                  ? [
                      'create_plugin_package_secret_transition_plan',
                      'create_plugin_package_secret_binding_approval_plan',
                      'lock_approval_policy_fence',
                      'plugin_package_secret_binding_planning_snapshot',
                      'plugin_package_secret_binding_transition_snapshot',
                    ].includes(functionName)
                  : overrides.functionMode === 'manager'
                  ? functionName === 'lock_approval_policy_fence'
                  : overrides.functionMode === 'run-manager'
                  ? functionName === 'lock_run_management_policy_fence'
                  : overrides.functionMode === 'executor'
                  ? [
                      'commit_plugin_package_lifecycle',
                      'commit_plugin_package_quarantine',
                      'commit_plugin_package_task_reconciliation',
                      'lock_active_plugin_package_project',
                      'lock_approval_policy_fence',
                      'plugin_package_lifecycle_blocking_runs',
                    ].includes(functionName)
                  : overrides.functionMode === 'none'
                  ? false
                  : [
                      'plugin_package_automation_start_allowed',
                      'plugin_package_workflow_admission_snapshot',
                      'plugin_package_workflow_task_attempt_snapshot',
                      'plugin_package_run_start_allowed',
                      'plugin_package_tool_start_allowed',
                      'lock_run_management_policy_fence',
                    ].includes(functionName),
              isOwner: false,
            })),
        };
      }
      if (text.includes('FROM pg_proc routines')) {
        return {
          rows: contract.functions.map((definition) => ({
            functionName: definition.name,
            identityArguments: definition.identityArguments,
            owner: definition.owner,
            securityDefiner: definition.securityDefiner,
            volatility: definition.volatility,
            configuration: definition.configuration,
            publicExecute: false,
          })),
        };
      }
      if (text.includes('FROM pg_trigger triggers')) {
        return {
          rows: contract.triggers
            .filter(({ name }) => name !== overrides.missingTrigger)
            .map((definition) => ({
              triggerName: definition.name,
              tableName: definition.tableName,
              functionName: definition.functionName,
              enabled:
                definition.name === overrides.disabledTrigger ? 'D' : 'O',
            })),
        };
      }
      if (text.includes('has_schema_privilege')) {
        return {
          rows: [
            {
              schemaUsage: true,
              schemaCreate: overrides.schemaCreate ?? false,
            },
          ],
        };
      }
      if (text.includes('has_column_privilege')) {
        assert.match(text, /format\('%I\.%I', \$1::text, 'runs'\)/);
        const columns = contract.tables.find(
          ({ name }) => name === 'runs',
        ).columns;
        const allowed = new Set([
          'cancel_requested_at_ms',
          'cancel_reason',
          'version',
          'event_sequence',
        ]);
        return {
          rows:
            overrides.runManagerColumnPrivileges ??
            columns.map((columnName) => ({
              columnName,
              updateAllowed: allowed.has(columnName),
            })),
        };
      }
      if (text.includes('has_table_privilege')) {
        return { rows: overrides.privileges ?? validPrivileges() };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

test('accepts the exact PostgreSQL control schema and least-privilege runtime role', async () => {
  const report = await assertPostgresSchemaReady(queryable());
  assert.deepEqual(report, {
    ready: true,
    writablePrimary: true,
    serverVersionNum: 160014,
    serverMajor: 16,
    currentUser: 'ql3_runtime',
    contractName: 'control-core',
    contractVersion: 63,
    migrationIds: [
      'pg-0001-schema-capability',
      'pg-0002-run-core',
      'pg-0003-run-retry-policy',
      'pg-0004-project-policy',
      'pg-0005-api-credential-security-audit',
      'pg-0006-identity-credential-administration',
      'pg-0007-cluster-recovery-indexes',
      'pg-0008-run-recovery-claims',
      'pg-0009-worker-session-run-lease',
      'pg-0010-worker-ingress-attestation',
      'pg-0011-api-credential-pepper-binding',
      'pg-0012-task-trigger-definitions',
      'pg-0013-task-execution-revisions',
      'pg-0014-cluster-scheduler-admission',
      'pg-0015-worker-credential-delivery-ledger',
      'pg-0016-worker-credential-stage-discard-ledger',
      'pg-0017-database-role-grants',
      'pg-0018-plugin-package-installs',
      'pg-0019-approved-actions',
      'pg-0020-plugin-package-admission-receipts',
      'pg-0021-approved-action-executions-and-package-proposals',
      'pg-0022-plugin-package-authority-split',
      'pg-0023-plugin-package-management-quota',
      'pg-0024-plugin-package-identity-keyset-ledger',
      'pg-0025-plugin-package-materialized-revisions',
      'pg-0026-plugin-package-task-reconciliations',
      'pg-0027-project-tool-definition-snapshots',
      'pg-0028-step-runs',
      'pg-0029-tool-execution-evidence',
      'pg-0030-tool-execution-start-barriers',
      'pg-0031-tool-invocation-artifacts',
      'pg-0032-tool-execution-artifact-bindings',
      'pg-0033-tool-execution-completions',
      'pg-0034-tool-execution-failure-completions',
      'pg-0035-tool-result-key-catalog',
      'pg-0036-tool-result-rekey-overlays',
      'pg-0037-plugin-package-quarantine',
      'pg-0038-plugin-package-publisher-provenance',
      'pg-0039-plugin-package-publisher-trust-authority',
      'pg-0040-plugin-package-publisher-trust-transitions',
      'pg-0041-plugin-package-lifecycle',
      'pg-0042-plugin-package-lifecycle-plans',
      'pg-0043-plugin-package-automation-publications',
      'pg-0044-plugin-package-automation-start-guard',
      'pg-0045-plugin-package-workflow-admissions',
      'pg-0046-plugin-package-workflow-task-attempt-admissions',
      'pg-0047-worker-credential-management-plans',
      'pg-0048-worker-credential-preapproved-activation',
      'pg-0049-worker-credential-execution-receipts',
      'pg-0050-worker-credential-management-boundary',
      'pg-0051-automation-management-boundary',
      'pg-0052-automation-management-identity-keyset-ledger',
      'pg-0053-plugin-package-workflow-run-list-index',
      'pg-0054-approval-management-boundary',
      'pg-0055-run-attempt-log-retention',
      'pg-0056-run-management-boundary',
      'pg-0057-run-management-stop-boundary',
      'pg-0058-plugin-package-automation-disposition-events',
      'pg-0059-plugin-package-secret-bindings',
      'pg-0060-plugin-package-secret-materialization-guard',
      'pg-0061-plugin-package-secret-binding-approval-plans',
      'pg-0062-plugin-package-secret-binding-target-guard',
      'pg-0063-plugin-package-secret-binding-transition-receipts',
      'pg-0064-plugin-package-secret-binding-transition-approval-plans',
    ],
  });
});

test('rejects a standby or read-only endpoint before schema inspection', async () => {
  await assert.rejects(
    assertPostgresSchemaReady(queryable({ inRecovery: true })),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'server_not_writable_primary' &&
      error.facts.includes('in-recovery:true'),
  );
  await assert.rejects(
    assertPostgresSchemaReady(queryable({ transactionReadOnly: 'on' })),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'server_not_writable_primary' &&
      error.facts.includes('transaction-read-only:on'),
  );
});

test('accepts the exact schema and isolated least-privilege admin role', async () => {
  const report = await assertPostgresAdminSchemaReady(
    queryable({
      currentUser: 'ql3_admin',
      privileges: validAdminPrivileges(),
      functionMode: 'none',
    }),
  );
  assert.equal(report.currentUser, 'ql3_admin');
  assert.equal(report.contractVersion, 63);
  assert.equal(
    report.migrationIds.at(-1),
    'pg-0064-plugin-package-secret-binding-transition-approval-plans',
  );
});

test('accepts the isolated least-privilege automation manager role', async () => {
  const report = await assertPostgresAutomationManagerSchemaReady(
    queryable({
      currentUser: 'ql3_automation_manager',
      privileges: automationManagerPrivileges(),
      functionMode: 'none',
    }),
  );
  assert.equal(report.currentUser, 'ql3_automation_manager');
  assert.equal(report.contractVersion, 63);
  assert.equal(
    report.migrationIds.at(-1),
    'pg-0064-plugin-package-secret-binding-transition-approval-plans',
  );

  const widened = automationManagerPrivileges();
  widened.find(({ tableName }) => tableName === 'runs').selectAllowed = true;
  await assert.rejects(
    assertPostgresAutomationManagerSchemaReady(
      queryable({
        currentUser: 'ql3_automation_manager',
        privileges: widened,
        functionMode: 'none',
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'automation_manager_role_invalid' &&
      error.facts.includes('table-privileges:runs'),
  );
});

test('accepts the isolated least-privilege human Approval manager role', async () => {
  const report = await assertPostgresApprovalManagerSchemaReady(
    queryable({
      currentUser: 'ql3_approval_manager',
      privileges: approvalManagerPrivileges(),
      functionMode: 'manager',
    }),
  );
  assert.equal(report.currentUser, 'ql3_approval_manager');
  assert.equal(report.contractVersion, 63);
  assert.equal(
    report.migrationIds.at(-1),
    'pg-0064-plugin-package-secret-binding-transition-approval-plans',
  );

  const widened = approvalManagerPrivileges();
  widened.find(
    ({ tableName }) => tableName === 'tool_invocation_input_artifacts',
  ).selectAllowed = true;
  await assert.rejects(
    assertPostgresApprovalManagerSchemaReady(
      queryable({
        currentUser: 'ql3_approval_manager',
        privileges: widened,
        functionMode: 'manager',
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'approval_manager_role_invalid' &&
      error.facts.includes('table-privileges:tool_invocation_input_artifacts'),
  );
});

test('accepts the isolated least-privilege Run manager role', async () => {
  const report = await assertPostgresRunManagerSchemaReady(
    queryable({
      currentUser: 'ql3_run_manager',
      privileges: runManagerPrivileges(),
      functionMode: 'run-manager',
    }),
  );
  assert.equal(report.currentUser, 'ql3_run_manager');
  assert.equal(report.contractVersion, 63);
  assert.equal(
    report.migrationIds.at(-1),
    'pg-0064-plugin-package-secret-binding-transition-approval-plans',
  );

  const widened = runManagerPrivileges();
  widened.find(({ tableName }) => tableName === 'runs').updateAllowed = true;
  await assert.rejects(
    assertPostgresRunManagerSchemaReady(
      queryable({
        currentUser: 'ql3_run_manager',
        privileges: widened,
        functionMode: 'run-manager',
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'run_manager_role_invalid' &&
      error.facts.includes('table-privileges:runs'),
  );

  const widenedColumns = postgresqlControlSchemaContract.tables
    .find(({ name }) => name === 'runs')
    .columns.map((columnName) => ({
      columnName,
      updateAllowed: [
        'cancel_requested_at_ms',
        'cancel_reason',
        'version',
        'event_sequence',
        'status',
      ].includes(columnName),
    }));
  await assert.rejects(
    assertPostgresRunManagerSchemaReady(
      queryable({
        currentUser: 'ql3_run_manager',
        privileges: runManagerPrivileges(),
        functionMode: 'run-manager',
        runManagerColumnPrivileges: widenedColumns,
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'run_manager_role_invalid' &&
      error.facts.includes('column-update-privilege:runs.status'),
  );
});

test('accepts isolated Package manager and executor roles', async () => {
  const manager = await assertPostgresPackageManagerSchemaReady(
    queryable({
      currentUser: 'ql3_package_manager',
      privileges: packagePrivileges('manager'),
      functionMode: 'package-manager',
    }),
  );
  assert.equal(manager.currentUser, 'ql3_package_manager');

  const executor = await assertPostgresPackageExecutorSchemaReady(
    queryable({
      currentUser: 'ql3_package_executor',
      privileges: packagePrivileges('executor'),
      functionMode: 'executor',
    }),
  );
  assert.equal(executor.currentUser, 'ql3_package_executor');
});

test('accepts isolated Worker credential manager and executor roles', async () => {
  const manager = await assertPostgresWorkerCredentialManagerSchemaReady(
    queryable({
      currentUser: 'ql3_worker_credential_manager',
      privileges: workerCredentialPrivileges('manager'),
      functionMode: 'manager',
    }),
  );
  assert.equal(manager.currentUser, 'ql3_worker_credential_manager');

  const executor = await assertPostgresWorkerCredentialExecutorSchemaReady(
    queryable({
      currentUser: 'ql3_worker_credential_executor',
      privileges: workerCredentialPrivileges('executor'),
      functionMode: 'manager',
    }),
  );
  assert.equal(executor.currentUser, 'ql3_worker_credential_executor');
});

test('rejects over-privileged Worker credential authority roles', async () => {
  const managerPrivileges = workerCredentialPrivileges('manager');
  managerPrivileges.find(
    ({ tableName }) => tableName === 'worker_credentials',
  ).selectAllowed = true;
  await assert.rejects(
    assertPostgresWorkerCredentialManagerSchemaReady(
      queryable({
        currentUser: 'ql3_worker_credential_manager',
        privileges: managerPrivileges,
        functionMode: 'manager',
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'worker_credential_manager_role_invalid' &&
      error.facts.includes('table-privileges:worker_credentials'),
  );

  await assert.rejects(
    assertPostgresWorkerCredentialExecutorSchemaReady(
      queryable({
        currentUser: 'ql3_worker_credential_executor',
        privileges: workerCredentialPrivileges('executor'),
        functionMode: 'executor',
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'worker_credential_executor_role_invalid' &&
      error.facts.includes(
        'function-privileges:commit_plugin_package_lifecycle',
      ),
  );
});

test('accepts the exact schema and isolated Worker ingress role', async () => {
  const report = await assertPostgresWorkerIngressSchemaReady(
    queryable({
      currentUser: 'ql3_worker_ingress',
      privileges: validWorkerIngressPrivileges(),
      functionMode: 'none',
    }),
  );
  assert.equal(report.currentUser, 'ql3_worker_ingress');
  assert.equal(report.contractVersion, 63);
  assert.equal(
    report.migrationIds.at(-1),
    'pg-0064-plugin-package-secret-binding-transition-approval-plans',
  );
});

test('rejects unsupported server versions and capability drift', async () => {
  await assert.rejects(
    assertPostgresSchemaReady(queryable({ serverVersionNum: '150018' })),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'server_version_unsupported',
  );
  await assert.rejects(
    assertPostgresSchemaReady(
      queryable({
        capability: {
          contractName: 'control-core',
          contractVersion: 7,
          migrationId: 'pg-0005-api-credential-security-audit',
          capabilities: {
            api_credential: 1,
            project_policy: 1,
            run_core: 1,
            run_retry_policy: 1,
            security_audit: 1,
          },
        },
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'capability_invalid',
  );
});

test('rejects unknown ql3 objects and an over-privileged runtime role', async () => {
  await assert.rejects(
    assertPostgresSchemaReady(
      queryable({
        extraTable: 'plugin_state',
        extraIndex: 'plugin_state_pkey',
        extraConstraint: 'plugin_state_payload_check',
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'schema_contract_invalid' &&
      error.facts.includes('unknown-table:plugin_state') &&
      error.facts.includes('unknown-check:plugin_state_payload_check'),
  );
  await assert.rejects(
    assertPostgresSchemaReady(queryable({ schemaCreate: true })),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'runtime_role_invalid',
  );
  await assert.rejects(
    assertPostgresSchemaReady(queryable({ superuser: true })),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'runtime_role_invalid' &&
      error.facts.includes('role-security'),
  );
  await assert.rejects(
    assertPostgresSchemaReady(
      queryable({
        functionPrivileges: [
          {
            functionName: 'lock_active_plugin_package_project',
            executeAllowed: true,
            isOwner: false,
          },
        ],
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'runtime_role_invalid' &&
      error.facts.includes(
        'function-privileges:lock_active_plugin_package_project',
      ),
  );
});

test('fails closed when a reviewed Package Secret trigger is missing or disabled', async () => {
  await assert.rejects(
    assertPostgresSchemaReady(
      queryable({
        missingTrigger: 'ql3_plugin_package_secret_binding_target_guard',
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'schema_contract_invalid' &&
      error.facts.includes(
        'missing-trigger:ql3_plugin_package_secret_binding_target_guard',
      ),
  );
  await assert.rejects(
    assertPostgresSchemaReady(
      queryable({
        disabledTrigger: 'ql3_plugin_package_secret_materialization_guard',
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'schema_contract_invalid' &&
      error.facts.includes(
        'trigger-contract:ql3_plugin_package_secret_materialization_guard',
      ),
  );
});

test('preserves database availability errors for the outer readiness layer', async () => {
  const unavailable = new Error('database unavailable');
  let calls = 0;
  await assert.rejects(
    assertPostgresSchemaReady({
      async query() {
        calls += 1;
        if (calls === 1) {
          return {
            rows: [
              {
                serverVersionNum: '160014',
                currentUser: 'ql3_runtime',
                inRecovery: false,
                transactionReadOnly: 'off',
              },
            ],
          };
        }
        throw unavailable;
      },
    }),
    (error) => error === unavailable,
  );
});
