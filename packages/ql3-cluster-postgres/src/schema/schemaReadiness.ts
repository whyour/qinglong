import {
  readPostgresMigrationHistory,
  type PostgresMigrationQueryable,
} from '../migrations/postgresMigrationStreamStore';
import { auditMigrationStreamHistory } from '@qinglong/runtime-core';
import { postgresqlMainMigrationManifest } from '../migration/migrationManifest';
import {
  postgresqlControlSchemaContract,
  type PostgresSchemaContract,
} from './schemaContract';

export const POSTGRES_SCHEMA_READINESS_ERROR_CODES = [
  'server_version_unsupported',
  'server_not_writable_primary',
  'migration_history_invalid',
  'capability_invalid',
  'schema_contract_invalid',
  'runtime_role_invalid',
  'admin_role_invalid',
  'automation_manager_role_invalid',
  'approval_manager_role_invalid',
  'run_manager_role_invalid',
  'package_manager_role_invalid',
  'package_executor_role_invalid',
  'worker_credential_manager_role_invalid',
  'worker_credential_executor_role_invalid',
  'worker_ingress_role_invalid',
] as const;

export type PostgresSchemaReadinessErrorCode =
  (typeof POSTGRES_SCHEMA_READINESS_ERROR_CODES)[number];

export class PostgresSchemaReadinessError extends Error {
  constructor(
    readonly code: PostgresSchemaReadinessErrorCode,
    readonly facts: readonly string[] = [],
  ) {
    super(`PostgreSQL schema is not ready: ${code}`);
    this.name = 'PostgresSchemaReadinessError';
  }
}

export interface PostgresSchemaReadinessReport {
  readonly ready: true;
  readonly writablePrimary: true;
  readonly serverVersionNum: number;
  readonly serverMajor: number;
  readonly currentUser: string;
  readonly contractName: string;
  readonly contractVersion: number;
  readonly migrationIds: readonly string[];
}

interface ServerRow extends Record<string, unknown> {
  serverVersionNum: unknown;
  currentUser: unknown;
  inRecovery: unknown;
  transactionReadOnly: unknown;
}

interface CapabilityRow extends Record<string, unknown> {
  contractName: unknown;
  contractVersion: unknown;
  migrationId: unknown;
  capabilities: unknown;
}

interface ColumnRow extends Record<string, unknown> {
  tableName: unknown;
  columnName: unknown;
}

interface IndexRow extends Record<string, unknown> {
  indexName: unknown;
}

interface ConstraintRow extends Record<string, unknown> {
  constraintName: unknown;
  constraintType: unknown;
}

interface FunctionRow extends Record<string, unknown> {
  functionName: unknown;
  identityArguments: unknown;
  owner: unknown;
  securityDefiner: unknown;
  volatility: unknown;
  configuration: unknown;
  publicExecute: unknown;
}

interface TriggerRow extends Record<string, unknown> {
  triggerName: unknown;
  tableName: unknown;
  functionName: unknown;
  enabled: unknown;
}

interface SchemaPrivilegeRow extends Record<string, unknown> {
  schemaUsage: unknown;
  schemaCreate: unknown;
}

interface RoleSecurityRow extends Record<string, unknown> {
  canLogin: unknown;
  superuser: unknown;
  createDatabase: unknown;
  createRole: unknown;
  replication: unknown;
  bypassRowLevelSecurity: unknown;
  databaseConnect: unknown;
}

interface TablePrivilegeRow extends Record<string, unknown> {
  tableName: unknown;
  selectAllowed: unknown;
  insertAllowed: unknown;
  updateAllowed: unknown;
  deleteAllowed: unknown;
  isOwner: unknown;
}

interface FunctionPrivilegeRow extends Record<string, unknown> {
  functionName: unknown;
  executeAllowed: unknown;
  isOwner: unknown;
}

interface ColumnPrivilegeRow extends Record<string, unknown> {
  columnName: unknown;
  updateAllowed: unknown;
}

const REQUIRED_RUNTIME_PRIVILEGES = Object.freeze({
  schema_migrations: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  schema_capabilities: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  projects: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: false,
  }),
  plugin_package_installs: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_install_heads: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_install_mutations: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_materialized_revisions: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_secret_bindings: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_secret_binding_approval_plans: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_secret_binding_transition_approval_plans: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_secret_binding_transition_receipts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  project_tool_definition_snapshots: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  project_tool_definition_snapshot_sources: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_quarantine_events: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_withdrawal_receipts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_withdrawal_tasks: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_lifecycle_events: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_lifecycle_heads: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_lifecycle_receipts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_lifecycle_tasks: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_lifecycle_plans: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_automation_publications: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_automation_disposition_events: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_automation_publication_heads: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_workflow_admissions: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  plugin_package_workflow_admission_steps: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  plugin_package_workflow_task_attempt_admissions: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_provenance: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_revocation_receipts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_revocation_impacts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_revocation_impact_items: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_trust_snapshots: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_trust_heads: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_revocation_proposals: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_trust_transition_proposals: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_trust_transition_receipts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_task_ownerships: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_task_reconciliations: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_task_reconciliation_items: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  approval_requests: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  approved_action_dispatches: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  approved_action_executions: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  approved_action_manual_recovery_resolutions: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_install_proposals: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_management_quota_buckets: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_identity_keyset_ledger: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  worker_credential_management_quota_buckets: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_admission_receipts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  task_definitions: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  task_definition_revisions: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  task_execution_revisions: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  triggers: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  trigger_revisions: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  trigger_schedules: Object.freeze({
    select: true,
    insert: false,
    update: true,
    delete: false,
  }),
  project_role_bindings: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  identity_subjects: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  api_credentials: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  security_audit_events: Object.freeze({
    select: false,
    insert: true,
    update: false,
    delete: false,
  }),
  identity_subject_mutations: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  api_credential_mutations: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  runs: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: false,
  }),
  step_runs: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: false,
  }),
  tool_execution_trace_anchors: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  tool_execution_audit_receipts: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  tool_execution_start_barriers: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  tool_execution_start_artifact_bindings: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  tool_execution_completions: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  tool_execution_failure_completions: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  tool_result_key_catalog_generations: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  tool_execution_result_key_bindings: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  tool_execution_result_rekey_overlays: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  tool_execution_result_rekey_heads: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  tool_result_key_retirement_receipts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  tool_invocation_input_artifacts: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  tool_invocation_preview_artifacts: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  run_attempts: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: false,
  }),
  run_attempt_log_retention_controls: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: true,
  }),
  run_attempt_log_artifact_tombstones: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  worker_sessions: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: false,
  }),
  run_dispatch_leases: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: false,
  }),
  worker_credentials: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  worker_credential_management_plans: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  worker_credential_mutations: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  worker_credential_deliveries: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  worker_credential_stage_discards: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  worker_execution_attestations: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  run_recovery_controls: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: false,
  }),
  run_events: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  step_run_mutations: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  run_retry_policies: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: false,
  }),
});

const REQUIRED_ADMIN_PRIVILEGES = Object.freeze({
  schema_migrations: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  schema_capabilities: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  projects: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_installs: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_install_heads: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_install_mutations: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_materialized_revisions: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_secret_bindings: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_secret_binding_approval_plans: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_secret_binding_transition_approval_plans: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_secret_binding_transition_receipts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  project_tool_definition_snapshots: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  project_tool_definition_snapshot_sources: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_quarantine_events: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_withdrawal_receipts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_withdrawal_tasks: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_lifecycle_events: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_lifecycle_heads: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_lifecycle_receipts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_lifecycle_tasks: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_lifecycle_plans: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_automation_publications: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_automation_disposition_events: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_automation_publication_heads: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_workflow_admissions: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_workflow_admission_steps: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_workflow_task_attempt_admissions: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_provenance: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_revocation_receipts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_revocation_impacts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_revocation_impact_items: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_trust_snapshots: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_trust_heads: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_revocation_proposals: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_trust_transition_proposals: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_publisher_trust_transition_receipts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_task_ownerships: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_task_reconciliations: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_task_reconciliation_items: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  approval_requests: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  approved_action_dispatches: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  approved_action_executions: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  approved_action_manual_recovery_resolutions: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_install_proposals: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_management_quota_buckets: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_identity_keyset_ledger: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  worker_credential_management_quota_buckets: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  plugin_package_admission_receipts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  task_definitions: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  task_definition_revisions: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  task_execution_revisions: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  triggers: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  trigger_revisions: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  trigger_schedules: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  project_role_bindings: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  identity_subjects: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: false,
  }),
  api_credentials: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  security_audit_events: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  identity_subject_mutations: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  api_credential_mutations: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  runs: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  step_runs: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  tool_execution_trace_anchors: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  tool_execution_audit_receipts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  tool_execution_start_barriers: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  tool_execution_start_artifact_bindings: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  tool_execution_completions: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  tool_execution_failure_completions: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  tool_result_key_catalog_generations: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  tool_execution_result_key_bindings: Object.freeze({
    select: true,
    insert: false,
    update: false,
    delete: false,
  }),
  tool_execution_result_rekey_overlays: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  tool_execution_result_rekey_heads: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: false,
  }),
  tool_result_key_retirement_receipts: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  tool_invocation_input_artifacts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  tool_invocation_preview_artifacts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  run_attempts: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  run_attempt_log_retention_controls: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  run_attempt_log_artifact_tombstones: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  worker_sessions: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  run_dispatch_leases: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  worker_credentials: Object.freeze({
    select: true,
    insert: true,
    update: true,
    delete: false,
  }),
  worker_credential_management_plans: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  worker_credential_mutations: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  worker_credential_deliveries: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  worker_credential_stage_discards: Object.freeze({
    select: true,
    insert: true,
    update: false,
    delete: false,
  }),
  worker_execution_attestations: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  run_recovery_controls: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  run_events: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  step_run_mutations: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
  run_retry_policies: Object.freeze({
    select: false,
    insert: false,
    update: false,
    delete: false,
  }),
});

type RequiredPrivileges = Readonly<
  Record<
    string,
    Readonly<{
      select: boolean;
      insert: boolean;
      update: boolean;
      delete: boolean;
    }>
  >
>;

type RequiredFunctionPrivileges = Readonly<Record<string, boolean>>;

const NO_TABLE_PRIVILEGES = Object.freeze({
  select: false,
  insert: false,
  update: false,
  delete: false,
});

const REQUIRED_PACKAGE_MANAGER_PRIVILEGES: RequiredPrivileges = Object.freeze(
  Object.fromEntries(
    postgresqlControlSchemaContract.tables.map(({ name }) => [
      name,
      Object.freeze(
        name === 'schema_migrations' ||
          name === 'schema_capabilities' ||
          name === 'projects' ||
          name === 'project_role_bindings' ||
          name === 'plugin_package_lifecycle_plans' ||
          name === 'plugin_package_secret_binding_approval_plans' ||
          name === 'plugin_package_secret_binding_transition_approval_plans' ||
          name === 'plugin_package_automation_publications' ||
          name === 'plugin_package_automation_publication_heads' ||
          name === 'plugin_package_publisher_trust_transition_receipts'
          ? { ...NO_TABLE_PRIVILEGES, select: true }
          : name === 'security_audit_events' ||
            name === 'plugin_package_install_proposals' ||
            name === 'plugin_package_publisher_trust_snapshots' ||
            name === 'plugin_package_publisher_trust_heads' ||
            name === 'plugin_package_publisher_revocation_proposals' ||
            name === 'plugin_package_publisher_trust_transition_proposals'
          ? { ...NO_TABLE_PRIVILEGES, select: true, insert: true }
          : name === 'approval_requests'
          ? {
              ...NO_TABLE_PRIVILEGES,
              select: true,
              insert: true,
              update: true,
            }
          : name === 'plugin_package_management_quota_buckets' ||
            name === 'plugin_package_identity_keyset_ledger'
          ? {
              ...NO_TABLE_PRIVILEGES,
              select: true,
              insert: true,
              update: true,
            }
          : NO_TABLE_PRIVILEGES,
      ),
    ]),
  ),
);

const REQUIRED_PACKAGE_EXECUTOR_PRIVILEGES: RequiredPrivileges = Object.freeze(
  Object.fromEntries(
    postgresqlControlSchemaContract.tables.map(({ name }) => [
      name,
      Object.freeze(
        name === 'schema_migrations' ||
          name === 'schema_capabilities' ||
          name === 'projects' ||
          name === 'project_role_bindings' ||
          name === 'plugin_package_install_proposals' ||
          name === 'plugin_package_secret_binding_approval_plans' ||
          name === 'plugin_package_secret_binding_transition_approval_plans' ||
          name === 'plugin_package_publisher_revocation_proposals' ||
          name === 'plugin_package_publisher_trust_transition_proposals'
          ? { ...NO_TABLE_PRIVILEGES, select: true }
          : name === 'security_audit_events' ||
            name === 'approved_action_dispatches' ||
            name === 'plugin_package_install_mutations' ||
            name === 'plugin_package_materialized_revisions' ||
            name === 'plugin_package_secret_bindings' ||
            name === 'plugin_package_secret_binding_transition_receipts' ||
            name === 'project_tool_definition_snapshots' ||
            name === 'project_tool_definition_snapshot_sources' ||
            name === 'plugin_package_lifecycle_plans' ||
            name === 'plugin_package_automation_publications' ||
            name === 'plugin_package_admission_receipts' ||
            name === 'plugin_package_publisher_trust_transition_receipts'
          ? { ...NO_TABLE_PRIVILEGES, select: true, insert: true }
          : name === 'approval_requests'
          ? { ...NO_TABLE_PRIVILEGES, select: true, update: true }
          : name === 'approved_action_executions' ||
            name === 'plugin_package_installs' ||
            name === 'plugin_package_install_heads' ||
            name === 'plugin_package_automation_publication_heads'
          ? {
              ...NO_TABLE_PRIVILEGES,
              select: true,
              insert: true,
              update: true,
            }
          : name === 'plugin_package_publisher_trust_heads'
          ? {
              ...NO_TABLE_PRIVILEGES,
              select: true,
              update: true,
            }
          : name === 'plugin_package_publisher_trust_snapshots'
          ? {
              ...NO_TABLE_PRIVILEGES,
              select: true,
              insert: true,
            }
          : name === 'plugin_package_task_ownerships' ||
            name === 'plugin_package_task_reconciliations' ||
            name === 'plugin_package_task_reconciliation_items' ||
            name === 'task_definitions' ||
            name === 'task_definition_revisions' ||
            name === 'task_execution_revisions'
          ? { ...NO_TABLE_PRIVILEGES, select: true }
          : name === 'plugin_package_quarantine_events' ||
            name === 'plugin_package_withdrawal_receipts' ||
            name === 'plugin_package_withdrawal_tasks' ||
            name === 'plugin_package_lifecycle_events' ||
            name === 'plugin_package_lifecycle_heads' ||
            name === 'plugin_package_lifecycle_receipts' ||
            name === 'plugin_package_lifecycle_tasks'
          ? { ...NO_TABLE_PRIVILEGES, select: true }
          : name === 'plugin_package_publisher_provenance' ||
            name === 'plugin_package_publisher_revocation_receipts' ||
            name === 'plugin_package_publisher_revocation_impacts' ||
            name === 'plugin_package_publisher_revocation_impact_items'
          ? { ...NO_TABLE_PRIVILEGES, select: true, insert: true }
          : NO_TABLE_PRIVILEGES,
      ),
    ]),
  ),
);

const REQUIRED_WORKER_INGRESS_PRIVILEGES: RequiredPrivileges = Object.freeze(
  Object.fromEntries(
    postgresqlControlSchemaContract.tables.map(({ name }) => [
      name,
      Object.freeze(
        name === 'schema_migrations' || name === 'schema_capabilities'
          ? { ...NO_TABLE_PRIVILEGES, select: true }
          : name === 'security_audit_events'
          ? { ...NO_TABLE_PRIVILEGES, insert: true }
          : name === 'run_attempts' ||
            name === 'run_dispatch_leases' ||
            name === 'worker_credentials'
          ? { ...NO_TABLE_PRIVILEGES, select: true }
          : name === 'worker_sessions'
          ? { ...NO_TABLE_PRIVILEGES, select: true, insert: true, update: true }
          : name === 'worker_credential_deliveries'
          ? { ...NO_TABLE_PRIVILEGES, select: true, insert: true }
          : name === 'worker_execution_attestations'
          ? { ...NO_TABLE_PRIVILEGES, select: true, insert: true }
          : NO_TABLE_PRIVILEGES,
      ),
    ]),
  ),
);

const REQUIRED_AUTOMATION_MANAGER_PRIVILEGES: RequiredPrivileges =
  Object.freeze(
    Object.fromEntries(
      postgresqlControlSchemaContract.tables.map(({ name }) => [
        name,
        Object.freeze(
          name === 'schema_migrations' ||
            name === 'schema_capabilities' ||
            name === 'projects' ||
            name === 'project_role_bindings' ||
            name === 'plugin_package_task_ownerships'
            ? { ...NO_TABLE_PRIVILEGES, select: true }
            : name === 'plugin_package_identity_keyset_ledger'
            ? {
                ...NO_TABLE_PRIVILEGES,
                select: true,
                insert: true,
                update: true,
              }
            : name === 'security_audit_events' ||
              name === 'task_definition_revisions' ||
              name === 'task_execution_revisions' ||
              name === 'trigger_revisions'
            ? { ...NO_TABLE_PRIVILEGES, select: true, insert: true }
            : name === 'task_definitions' ||
              name === 'triggers' ||
              name === 'trigger_schedules'
            ? {
                ...NO_TABLE_PRIVILEGES,
                select: true,
                insert: true,
                update: true,
              }
            : NO_TABLE_PRIVILEGES,
        ),
      ]),
    ),
  );

const REQUIRED_APPROVAL_MANAGER_PRIVILEGES: RequiredPrivileges = Object.freeze(
  Object.fromEntries(
    postgresqlControlSchemaContract.tables.map(({ name }) => [
      name,
      Object.freeze(
        name === 'schema_migrations' ||
          name === 'schema_capabilities' ||
          name === 'projects' ||
          name === 'project_role_bindings' ||
          name === 'tool_invocation_preview_artifacts' ||
          name === 'approved_action_dispatches' ||
          name === 'approved_action_executions' ||
          name === 'approved_action_manual_recovery_resolutions'
          ? { ...NO_TABLE_PRIVILEGES, select: true }
          : name === 'security_audit_events'
          ? { ...NO_TABLE_PRIVILEGES, select: true, insert: true }
          : name === 'approval_requests'
          ? { ...NO_TABLE_PRIVILEGES, select: true, update: true }
          : name === 'plugin_package_identity_keyset_ledger'
          ? {
              ...NO_TABLE_PRIVILEGES,
              select: true,
              insert: true,
              update: true,
            }
          : NO_TABLE_PRIVILEGES,
      ),
    ]),
  ),
);

const REQUIRED_RUN_MANAGER_PRIVILEGES: RequiredPrivileges = Object.freeze(
  Object.fromEntries(
    postgresqlControlSchemaContract.tables.map(({ name }) => [
      name,
      Object.freeze(
        name === 'schema_migrations' ||
          name === 'schema_capabilities' ||
          name === 'projects' ||
          name === 'project_role_bindings' ||
          name === 'task_definitions' ||
          name === 'task_definition_revisions' ||
          name === 'task_execution_revisions'
          ? { ...NO_TABLE_PRIVILEGES, select: true }
          : name === 'runs' ||
            name === 'run_attempts' ||
            name === 'run_events' ||
            name === 'security_audit_events'
          ? { ...NO_TABLE_PRIVILEGES, select: true, insert: true }
          : name === 'plugin_package_identity_keyset_ledger'
          ? {
              ...NO_TABLE_PRIVILEGES,
              select: true,
              insert: true,
              update: true,
            }
          : NO_TABLE_PRIVILEGES,
      ),
    ]),
  ),
);

const REQUIRED_WORKER_CREDENTIAL_MANAGER_PRIVILEGES: RequiredPrivileges =
  Object.freeze(
    Object.fromEntries(
      postgresqlControlSchemaContract.tables.map(({ name }) => [
        name,
        Object.freeze(
          name === 'schema_migrations' ||
            name === 'schema_capabilities' ||
            name === 'projects' ||
            name === 'project_role_bindings'
            ? { ...NO_TABLE_PRIVILEGES, select: true }
            : name === 'worker_credential_management_plans' ||
              name === 'security_audit_events'
            ? { ...NO_TABLE_PRIVILEGES, select: true, insert: true }
            : name === 'approval_requests'
            ? {
                ...NO_TABLE_PRIVILEGES,
                select: true,
                insert: true,
                update: true,
              }
            : name === 'worker_credential_management_quota_buckets' ||
              name === 'plugin_package_identity_keyset_ledger'
            ? {
                ...NO_TABLE_PRIVILEGES,
                select: true,
                insert: true,
                update: true,
              }
            : NO_TABLE_PRIVILEGES,
        ),
      ]),
    ),
  );

const REQUIRED_WORKER_CREDENTIAL_EXECUTOR_PRIVILEGES: RequiredPrivileges =
  Object.freeze(
    Object.fromEntries(
      postgresqlControlSchemaContract.tables.map(({ name }) => [
        name,
        Object.freeze(
          name === 'schema_migrations' ||
            name === 'schema_capabilities' ||
            name === 'projects' ||
            name === 'project_role_bindings' ||
            name === 'worker_credential_management_plans'
            ? { ...NO_TABLE_PRIVILEGES, select: true }
            : name === 'security_audit_events' ||
              name === 'approved_action_dispatches' ||
              name === 'approved_action_executions' ||
              name === 'worker_credentials' ||
              name === 'worker_credential_mutations' ||
              name === 'worker_credential_deliveries' ||
              name === 'worker_credential_stage_discards'
            ? name === 'approved_action_executions'
              ? {
                  ...NO_TABLE_PRIVILEGES,
                  select: true,
                  insert: true,
                  update: true,
                }
              : { ...NO_TABLE_PRIVILEGES, select: true, insert: true }
            : name === 'approval_requests'
            ? { ...NO_TABLE_PRIVILEGES, select: true, update: true }
            : NO_TABLE_PRIVILEGES,
        ),
      ]),
    ),
  );

const NO_FUNCTION_PRIVILEGES: RequiredFunctionPrivileges = Object.freeze(
  Object.fromEntries(
    postgresqlControlSchemaContract.functions.map(({ name }) => [name, false]),
  ),
);

const REQUIRED_ADMIN_FUNCTION_PRIVILEGES: RequiredFunctionPrivileges =
  NO_FUNCTION_PRIVILEGES;

const REQUIRED_RUNTIME_FUNCTION_PRIVILEGES: RequiredFunctionPrivileges =
  Object.freeze({
    create_plugin_package_secret_transition_plan: false,
    create_plugin_package_secret_binding_approval_plan: false,
    commit_plugin_package_lifecycle: false,
    commit_plugin_package_quarantine: false,
    commit_plugin_package_task_reconciliation: false,
    enforce_plugin_package_secret_materialization: false,
    enforce_plugin_package_secret_binding_target: false,
    enforce_plugin_package_secret_binding_transition_receipt_target: false,
    enforce_plugin_package_stage_provenance: false,
    lock_active_plugin_package_project: false,
    lock_approval_policy_fence: false,
    lock_run_management_policy_fence: true,
    plugin_package_automation_start_allowed: true,
    plugin_package_workflow_admission_snapshot: true,
    plugin_package_workflow_task_attempt_snapshot: true,
    plugin_package_lifecycle_blocking_runs: false,
    plugin_package_run_start_allowed: true,
    plugin_package_secret_binding_planning_snapshot: false,
    plugin_package_secret_binding_transition_snapshot: false,
    plugin_package_tool_start_allowed: true,
    register_plugin_package_automation_disposition_event: false,
    resolve_approved_action_manual_recovery: false,
  });

const REQUIRED_PACKAGE_MANAGER_FUNCTION_PRIVILEGES: RequiredFunctionPrivileges =
  Object.freeze({
    create_plugin_package_secret_transition_plan: true,
    create_plugin_package_secret_binding_approval_plan: true,
    commit_plugin_package_lifecycle: false,
    commit_plugin_package_quarantine: false,
    commit_plugin_package_task_reconciliation: false,
    enforce_plugin_package_secret_materialization: false,
    enforce_plugin_package_secret_binding_target: false,
    enforce_plugin_package_secret_binding_transition_receipt_target: false,
    enforce_plugin_package_stage_provenance: false,
    lock_active_plugin_package_project: false,
    lock_approval_policy_fence: true,
    lock_run_management_policy_fence: false,
    plugin_package_automation_start_allowed: false,
    plugin_package_workflow_admission_snapshot: false,
    plugin_package_workflow_task_attempt_snapshot: false,
    plugin_package_lifecycle_blocking_runs: false,
    plugin_package_run_start_allowed: false,
    plugin_package_secret_binding_planning_snapshot: true,
    plugin_package_secret_binding_transition_snapshot: true,
    plugin_package_tool_start_allowed: false,
    register_plugin_package_automation_disposition_event: false,
    resolve_approved_action_manual_recovery: false,
  });

const REQUIRED_PACKAGE_EXECUTOR_FUNCTION_PRIVILEGES: RequiredFunctionPrivileges =
  Object.freeze({
    create_plugin_package_secret_transition_plan: false,
    create_plugin_package_secret_binding_approval_plan: false,
    commit_plugin_package_lifecycle: true,
    commit_plugin_package_quarantine: true,
    commit_plugin_package_task_reconciliation: true,
    enforce_plugin_package_secret_materialization: false,
    enforce_plugin_package_secret_binding_target: false,
    enforce_plugin_package_secret_binding_transition_receipt_target: false,
    enforce_plugin_package_stage_provenance: false,
    lock_active_plugin_package_project: true,
    lock_approval_policy_fence: true,
    lock_run_management_policy_fence: false,
    plugin_package_automation_start_allowed: false,
    plugin_package_workflow_admission_snapshot: false,
    plugin_package_workflow_task_attempt_snapshot: false,
    plugin_package_lifecycle_blocking_runs: true,
    plugin_package_run_start_allowed: false,
    plugin_package_secret_binding_planning_snapshot: false,
    plugin_package_secret_binding_transition_snapshot: false,
    plugin_package_tool_start_allowed: false,
    register_plugin_package_automation_disposition_event: false,
    resolve_approved_action_manual_recovery: false,
  });

const REQUIRED_WORKER_CREDENTIAL_FUNCTION_PRIVILEGES: RequiredFunctionPrivileges =
  Object.freeze({
    ...NO_FUNCTION_PRIVILEGES,
    lock_approval_policy_fence: true,
  });

const REQUIRED_APPROVAL_MANAGER_FUNCTION_PRIVILEGES: RequiredFunctionPrivileges =
  Object.freeze({
    ...NO_FUNCTION_PRIVILEGES,
    lock_approval_policy_fence: true,
    resolve_approved_action_manual_recovery: true,
  });

const REQUIRED_RUN_MANAGER_FUNCTION_PRIVILEGES: RequiredFunctionPrivileges =
  Object.freeze({
    ...NO_FUNCTION_PRIVILEGES,
    lock_run_management_policy_fence: true,
  });

function safeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function exactJsonObject(
  actual: unknown,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    return false;
  }
  const actualObject = actual as Record<string, unknown>;
  const actualKeys = sorted(Object.keys(actualObject));
  const expectedKeys = sorted(Object.keys(expected));
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key, index) =>
        key === expectedKeys[index] && actualObject[key] === expected[key],
    )
  );
}

async function readServer(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract,
): Promise<{
  writablePrimary: true;
  serverVersionNum: number;
  serverMajor: number;
  currentUser: string;
}> {
  const result = await queryable.query<ServerRow>(
    `
SELECT
  current_setting('server_version_num') AS "serverVersionNum",
  current_user AS "currentUser",
  pg_is_in_recovery() AS "inRecovery",
  current_setting('transaction_read_only') AS "transactionReadOnly"
  `.trim(),
  );
  const row = result.rows[0];
  const serverVersionNum = safeInteger(row?.serverVersionNum);
  const currentUser = row?.currentUser;
  const inRecovery = row?.inRecovery;
  const transactionReadOnly = row?.transactionReadOnly;
  const serverMajor =
    serverVersionNum === null ? null : Math.floor(serverVersionNum / 10_000);
  if (
    result.rows.length !== 1 ||
    serverVersionNum === null ||
    serverMajor === null ||
    serverMajor < contract.minimumServerMajor ||
    serverMajor > contract.maximumServerMajor ||
    typeof currentUser !== 'string' ||
    currentUser.length === 0
  ) {
    throw new PostgresSchemaReadinessError('server_version_unsupported', [
      String(serverVersionNum ?? 'invalid'),
    ]);
  }
  if (inRecovery !== false || transactionReadOnly !== 'off') {
    throw new PostgresSchemaReadinessError('server_not_writable_primary', [
      `in-recovery:${String(inRecovery)}`,
      `transaction-read-only:${String(transactionReadOnly)}`,
    ]);
  }
  return {
    writablePrimary: true,
    serverVersionNum,
    serverMajor,
    currentUser,
  };
}

async function assertHistory(
  queryable: PostgresMigrationQueryable,
): Promise<readonly string[]> {
  const history = await readPostgresMigrationHistory(queryable);
  try {
    auditMigrationStreamHistory(history, postgresqlMainMigrationManifest);
    return Object.freeze(history.map(({ migrationId }) => migrationId));
  } catch (error) {
    throw new PostgresSchemaReadinessError('migration_history_invalid', [
      error instanceof Error ? error.name : 'UnknownError',
    ]);
  }
}

async function assertCapability(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract,
): Promise<void> {
  const result = await queryable.query<CapabilityRow>(
    `
SELECT
  contract_name AS "contractName",
  contract_version AS "contractVersion",
  migration_id AS "migrationId",
  capabilities
FROM "${contract.schema}"."schema_capabilities"
WHERE contract_name = $1
    `.trim(),
    [contract.contractName],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    row.contractName !== contract.contractName ||
    safeInteger(row.contractVersion) !== contract.contractVersion ||
    row.migrationId !== contract.migrationId ||
    !exactJsonObject(row.capabilities, contract.capabilities)
  ) {
    throw new PostgresSchemaReadinessError('capability_invalid');
  }
}

async function assertSchemaContract(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract,
): Promise<void> {
  const [
    columnsResult,
    indexesResult,
    constraintsResult,
    functionsResult,
    triggersResult,
  ] = await Promise.all([
    queryable.query<ColumnRow>(
      `
SELECT
  tables.relname AS "tableName",
  columns.attname AS "columnName"
FROM pg_class tables
JOIN pg_namespace schemas ON schemas.oid = tables.relnamespace
JOIN pg_attribute columns ON columns.attrelid = tables.oid
WHERE schemas.nspname = $1
  AND tables.relkind IN ('r', 'p')
  AND columns.attnum > 0
  AND NOT columns.attisdropped
ORDER BY tables.relname, columns.attnum
      `.trim(),
      [contract.schema],
    ),
    queryable.query<IndexRow>(
      `
SELECT indexname AS "indexName"
FROM pg_indexes
WHERE schemaname = $1
ORDER BY indexname
      `.trim(),
      [contract.schema],
    ),
    queryable.query<ConstraintRow>(
      `
SELECT
  constraints.conname AS "constraintName",
  CASE constraints.contype
    WHEN 'c' THEN 'check'
    WHEN 'f' THEN 'foreign_key'
  END AS "constraintType"
FROM pg_constraint constraints
JOIN pg_class tables ON tables.oid = constraints.conrelid
JOIN pg_namespace schemas ON schemas.oid = tables.relnamespace
WHERE schemas.nspname = $1
  AND constraints.contype IN ('c', 'f')
ORDER BY constraints.contype, constraints.conname
      `.trim(),
      [contract.schema],
    ),
    queryable.query<FunctionRow>(
      `
SELECT
  routines.proname AS "functionName",
  pg_get_function_identity_arguments(routines.oid) AS "identityArguments",
  pg_get_userbyid(routines.proowner) AS "owner",
  routines.prosecdef AS "securityDefiner",
  CASE routines.provolatile
    WHEN 'v' THEN 'volatile'
    WHEN 's' THEN 'stable'
    WHEN 'i' THEN 'immutable'
  END AS "volatility",
  COALESCE(routines.proconfig, ARRAY[]::text[]) AS "configuration",
  EXISTS (
    SELECT 1
    FROM aclexplode(
      COALESCE(
        routines.proacl,
        acldefault('f', routines.proowner)
      )
    ) AS privileges
    WHERE privileges.grantee = 0
      AND privileges.privilege_type = 'EXECUTE'
  ) AS "publicExecute"
FROM pg_proc routines
JOIN pg_namespace schemas ON schemas.oid = routines.pronamespace
WHERE schemas.nspname = $1
ORDER BY routines.proname, pg_get_function_identity_arguments(routines.oid)
      `.trim(),
      [contract.schema],
    ),
    queryable.query<TriggerRow>(
      `
SELECT
  triggers.tgname AS "triggerName",
  tables.relname AS "tableName",
  routines.proname AS "functionName",
  triggers.tgenabled AS "enabled"
FROM pg_trigger triggers
JOIN pg_class tables ON tables.oid = triggers.tgrelid
JOIN pg_namespace schemas ON schemas.oid = tables.relnamespace
JOIN pg_proc routines ON routines.oid = triggers.tgfoid
WHERE schemas.nspname = $1
  AND NOT triggers.tgisinternal
  AND triggers.tgname = ANY($2::text[])
ORDER BY triggers.tgname
        `.trim(),
      [contract.schema, contract.triggers.map(({ name }) => name)],
    ),
  ]);
  const actualTables = new Map<string, Set<string>>();
  for (const row of columnsResult.rows) {
    if (
      typeof row.tableName !== 'string' ||
      typeof row.columnName !== 'string'
    ) {
      throw new PostgresSchemaReadinessError('schema_contract_invalid');
    }
    const columns = actualTables.get(row.tableName) ?? new Set<string>();
    columns.add(row.columnName);
    actualTables.set(row.tableName, columns);
  }
  const expectedTables = new Map(
    contract.tables.map((table) => [table.name, new Set(table.columns)]),
  );
  const findings: string[] = [];
  for (const [tableName, expectedColumns] of expectedTables) {
    const actualColumns = actualTables.get(tableName);
    if (!actualColumns) {
      findings.push(`missing-table:${tableName}`);
      continue;
    }
    for (const column of expectedColumns) {
      if (!actualColumns.has(column)) {
        findings.push(`missing-column:${tableName}.${column}`);
      }
    }
    for (const column of actualColumns) {
      if (!expectedColumns.has(column)) {
        findings.push(`unknown-column:${tableName}.${column}`);
      }
    }
  }
  for (const tableName of actualTables.keys()) {
    if (!expectedTables.has(tableName))
      findings.push(`unknown-table:${tableName}`);
  }
  const actualIndexes = new Set<string>();
  for (const row of indexesResult.rows) {
    if (typeof row.indexName !== 'string') {
      throw new PostgresSchemaReadinessError('schema_contract_invalid');
    }
    actualIndexes.add(row.indexName);
  }
  const expectedIndexes = new Set(contract.indexes);
  for (const index of expectedIndexes) {
    if (!actualIndexes.has(index)) findings.push(`missing-index:${index}`);
  }
  for (const index of actualIndexes) {
    if (!expectedIndexes.has(index)) findings.push(`unknown-index:${index}`);
  }
  const actualChecks = new Set<string>();
  const actualForeignKeys = new Set<string>();
  for (const row of constraintsResult.rows) {
    if (
      typeof row.constraintName !== 'string' ||
      (row.constraintType !== 'check' && row.constraintType !== 'foreign_key')
    ) {
      throw new PostgresSchemaReadinessError('schema_contract_invalid');
    }
    const target =
      row.constraintType === 'check' ? actualChecks : actualForeignKeys;
    target.add(row.constraintName);
  }
  for (const check of contract.checks) {
    if (!actualChecks.has(check)) findings.push(`missing-check:${check}`);
  }
  for (const check of actualChecks) {
    if (!contract.checks.includes(check))
      findings.push(`unknown-check:${check}`);
  }
  for (const foreignKey of contract.foreignKeys) {
    if (!actualForeignKeys.has(foreignKey)) {
      findings.push(`missing-foreign-key:${foreignKey}`);
    }
  }
  for (const foreignKey of actualForeignKeys) {
    if (!contract.foreignKeys.includes(foreignKey)) {
      findings.push(`unknown-foreign-key:${foreignKey}`);
    }
  }
  const actualFunctions = new Map<
    string,
    {
      identityArguments: string;
      owner: string;
      securityDefiner: boolean;
      volatility: string;
      configuration: readonly string[];
      publicExecute: boolean;
    }
  >();
  for (const row of functionsResult.rows) {
    if (
      typeof row.functionName !== 'string' ||
      typeof row.identityArguments !== 'string' ||
      typeof row.owner !== 'string' ||
      typeof row.securityDefiner !== 'boolean' ||
      typeof row.volatility !== 'string' ||
      !Array.isArray(row.configuration) ||
      row.configuration.some((value) => typeof value !== 'string') ||
      typeof row.publicExecute !== 'boolean'
    ) {
      throw new PostgresSchemaReadinessError('schema_contract_invalid');
    }
    actualFunctions.set(`${row.functionName}(${row.identityArguments})`, {
      identityArguments: row.identityArguments,
      owner: row.owner,
      securityDefiner: row.securityDefiner,
      volatility: row.volatility,
      configuration: row.configuration as string[],
      publicExecute: row.publicExecute,
    });
  }
  const expectedFunctions = new Set<string>();
  for (const expected of contract.functions) {
    const identity = `${expected.name}(${expected.identityArguments})`;
    expectedFunctions.add(identity);
    const actual = actualFunctions.get(identity);
    if (!actual) {
      findings.push(`missing-function:${identity}`);
      continue;
    }
    if (
      actual.owner !== expected.owner ||
      actual.securityDefiner !== expected.securityDefiner ||
      actual.volatility !== expected.volatility ||
      actual.publicExecute !== false ||
      JSON.stringify(actual.configuration) !==
        JSON.stringify(expected.configuration)
    ) {
      findings.push(`function-contract:${identity}`);
    }
  }
  for (const identity of actualFunctions.keys()) {
    if (!expectedFunctions.has(identity)) {
      findings.push(`unknown-function:${identity}`);
    }
  }
  const actualTriggers = new Map<string, TriggerRow>();
  for (const row of triggersResult.rows) {
    if (
      typeof row.triggerName !== 'string' ||
      typeof row.tableName !== 'string' ||
      typeof row.functionName !== 'string' ||
      typeof row.enabled !== 'string'
    ) {
      throw new PostgresSchemaReadinessError('schema_contract_invalid');
    }
    actualTriggers.set(row.triggerName, row);
  }
  for (const expected of contract.triggers) {
    const actual = actualTriggers.get(expected.name);
    if (!actual) {
      findings.push(`missing-trigger:${expected.name}`);
      continue;
    }
    if (
      actual.tableName !== expected.tableName ||
      actual.functionName !== expected.functionName ||
      actual.enabled !== 'O'
    ) {
      findings.push(`trigger-contract:${expected.name}`);
    }
  }
  if (actualTriggers.size !== contract.triggers.length) {
    findings.push('trigger-contract-row-count');
  }
  if (findings.length > 0) {
    throw new PostgresSchemaReadinessError(
      'schema_contract_invalid',
      sorted(findings),
    );
  }
}

async function assertRole(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract,
  requiredPrivileges: RequiredPrivileges,
  requiredFunctionPrivileges: RequiredFunctionPrivileges,
  errorCode:
    | 'runtime_role_invalid'
    | 'admin_role_invalid'
    | 'automation_manager_role_invalid'
    | 'approval_manager_role_invalid'
    | 'run_manager_role_invalid'
    | 'package_manager_role_invalid'
    | 'package_executor_role_invalid'
    | 'worker_credential_manager_role_invalid'
    | 'worker_credential_executor_role_invalid'
    | 'worker_ingress_role_invalid',
): Promise<void> {
  const roleResult = await queryable.query<RoleSecurityRow>(
    `
SELECT
  rolcanlogin AS "canLogin",
  rolsuper AS "superuser",
  rolcreatedb AS "createDatabase",
  rolcreaterole AS "createRole",
  rolreplication AS "replication",
  rolbypassrls AS "bypassRowLevelSecurity",
  has_database_privilege(current_user, current_database(), 'CONNECT') AS "databaseConnect"
FROM pg_catalog.pg_roles
WHERE rolname = current_user
    `.trim(),
  );
  const schemaResult = await queryable.query<SchemaPrivilegeRow>(
    `
SELECT
  has_schema_privilege(current_user, $1, 'USAGE') AS "schemaUsage",
  has_schema_privilege(current_user, $1, 'CREATE') AS "schemaCreate"
    `.trim(),
    [contract.schema],
  );
  const schema = schemaResult.rows[0];
  const tableNames = Object.keys(requiredPrivileges);
  const tableResult = await queryable.query<TablePrivilegeRow>(
    `
SELECT
  requested.table_name AS "tableName",
  has_table_privilege(current_user, format('%I.%I', $1, requested.table_name), 'SELECT') AS "selectAllowed",
  has_table_privilege(current_user, format('%I.%I', $1, requested.table_name), 'INSERT') AS "insertAllowed",
  has_table_privilege(current_user, format('%I.%I', $1, requested.table_name), 'UPDATE') AS "updateAllowed",
  has_table_privilege(current_user, format('%I.%I', $1, requested.table_name), 'DELETE') AS "deleteAllowed",
  pg_get_userbyid(classes.relowner) = current_user AS "isOwner"
FROM unnest($2::text[]) AS requested(table_name)
JOIN pg_namespace namespaces ON namespaces.nspname = $1
JOIN pg_class classes
  ON classes.relnamespace = namespaces.oid
 AND classes.relname = requested.table_name
ORDER BY requested.table_name
    `.trim(),
    [contract.schema, tableNames],
  );
  const functionNames = contract.functions.map(({ name }) => name);
  const functionIdentityArguments = contract.functions.map(
    ({ identityArguments }) => identityArguments,
  );
  const functionResult = await queryable.query<FunctionPrivilegeRow>(
    `
SELECT
  requested.function_name AS "functionName",
  has_function_privilege(current_user, routines.oid, 'EXECUTE') AS "executeAllowed",
  pg_get_userbyid(routines.proowner) = current_user AS "isOwner"
FROM unnest($2::text[], $3::text[])
  AS requested(function_name, identity_arguments)
JOIN pg_namespace namespaces ON namespaces.nspname = $1
JOIN pg_proc routines
  ON routines.pronamespace = namespaces.oid
 AND routines.proname = requested.function_name
 AND pg_get_function_identity_arguments(routines.oid) =
   requested.identity_arguments
ORDER BY requested.function_name
    `.trim(),
    [contract.schema, functionNames, functionIdentityArguments],
  );
  const findings: string[] = [];
  const role = roleResult.rows[0];
  if (
    roleResult.rows.length !== 1 ||
    role?.canLogin !== true ||
    role?.superuser !== false ||
    role?.createDatabase !== false ||
    role?.createRole !== false ||
    role?.replication !== false ||
    role?.bypassRowLevelSecurity !== false ||
    role?.databaseConnect !== true
  ) {
    findings.push('role-security');
  }
  if (
    schemaResult.rows.length !== 1 ||
    schema?.schemaUsage !== true ||
    schema?.schemaCreate !== false
  ) {
    findings.push('schema-privileges');
  }
  const privilegesByTable = new Map(
    tableResult.rows.map((row) => [row.tableName, row]),
  );
  for (const tableName of tableNames) {
    const expected = requiredPrivileges[tableName]!;
    const actual = privilegesByTable.get(tableName);
    if (
      !actual ||
      actual.selectAllowed !== expected.select ||
      actual.insertAllowed !== expected.insert ||
      actual.updateAllowed !== expected.update ||
      actual.deleteAllowed !== expected.delete ||
      actual.isOwner !== false
    ) {
      findings.push(`table-privileges:${tableName}`);
    }
  }
  if (privilegesByTable.size !== tableNames.length) {
    findings.push('table-privilege-row-count');
  }
  const privilegesByFunction = new Map(
    functionResult.rows.map((row) => [row.functionName, row]),
  );
  for (const [functionName, executeAllowed] of Object.entries(
    requiredFunctionPrivileges,
  )) {
    const actual = privilegesByFunction.get(functionName);
    if (
      !actual ||
      actual.executeAllowed !== executeAllowed ||
      actual.isOwner !== false
    ) {
      findings.push(`function-privileges:${functionName}`);
    }
  }
  if (
    privilegesByFunction.size !== Object.keys(requiredFunctionPrivileges).length
  ) {
    findings.push('function-privilege-row-count');
  }
  if (findings.length > 0) {
    throw new PostgresSchemaReadinessError(errorCode, sorted(findings));
  }
}

async function assertRunManagerColumnPrivileges(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract,
): Promise<void> {
  const run = contract.tables.find(({ name }) => name === 'runs');
  if (!run) {
    throw new PostgresSchemaReadinessError('run_manager_role_invalid', [
      'missing-runs-contract',
    ]);
  }
  const result = await queryable.query<ColumnPrivilegeRow>(
    `
SELECT
  requested.column_name AS "columnName",
  has_column_privilege(
    current_user,
    format('%I.%I', $1::text, 'runs'),
    requested.column_name,
    'UPDATE'
  ) AS "updateAllowed"
FROM unnest($2::text[]) AS requested(column_name)
ORDER BY requested.column_name
    `.trim(),
    [contract.schema, run.columns],
  );
  const allowed = new Set([
    'cancel_requested_at_ms',
    'cancel_reason',
    'version',
    'event_sequence',
  ]);
  const actual = new Map(result.rows.map((row) => [row.columnName, row]));
  const findings: string[] = [];
  for (const columnName of run.columns) {
    const row = actual.get(columnName);
    if (!row || row.updateAllowed !== allowed.has(columnName)) {
      findings.push(`column-update-privilege:runs.${columnName}`);
    }
  }
  if (actual.size !== run.columns.length) {
    findings.push('column-privilege-row-count:runs');
  }
  if (findings.length > 0) {
    throw new PostgresSchemaReadinessError(
      'run_manager_role_invalid',
      sorted(findings),
    );
  }
}

export async function assertPostgresSchemaReady(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract = postgresqlControlSchemaContract,
): Promise<PostgresSchemaReadinessReport> {
  const server = await readServer(queryable, contract);
  const migrationIds = await assertHistory(queryable);
  await assertCapability(queryable, contract);
  await assertSchemaContract(queryable, contract);
  await assertRole(
    queryable,
    contract,
    REQUIRED_RUNTIME_PRIVILEGES,
    REQUIRED_RUNTIME_FUNCTION_PRIVILEGES,
    'runtime_role_invalid',
  );
  return Object.freeze({
    ready: true,
    ...server,
    contractName: contract.contractName,
    contractVersion: contract.contractVersion,
    migrationIds,
  });
}

export async function assertPostgresAdminSchemaReady(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract = postgresqlControlSchemaContract,
): Promise<PostgresSchemaReadinessReport> {
  const server = await readServer(queryable, contract);
  const migrationIds = await assertHistory(queryable);
  await assertCapability(queryable, contract);
  await assertSchemaContract(queryable, contract);
  await assertRole(
    queryable,
    contract,
    REQUIRED_ADMIN_PRIVILEGES,
    REQUIRED_ADMIN_FUNCTION_PRIVILEGES,
    'admin_role_invalid',
  );
  return Object.freeze({
    ready: true,
    ...server,
    contractName: contract.contractName,
    contractVersion: contract.contractVersion,
    migrationIds,
  });
}

export async function assertPostgresWorkerIngressSchemaReady(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract = postgresqlControlSchemaContract,
): Promise<PostgresSchemaReadinessReport> {
  const server = await readServer(queryable, contract);
  const migrationIds = await assertHistory(queryable);
  await assertCapability(queryable, contract);
  await assertSchemaContract(queryable, contract);
  await assertRole(
    queryable,
    contract,
    REQUIRED_WORKER_INGRESS_PRIVILEGES,
    NO_FUNCTION_PRIVILEGES,
    'worker_ingress_role_invalid',
  );
  return Object.freeze({
    ready: true,
    ...server,
    contractName: contract.contractName,
    contractVersion: contract.contractVersion,
    migrationIds,
  });
}

export async function assertPostgresAutomationManagerSchemaReady(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract = postgresqlControlSchemaContract,
): Promise<PostgresSchemaReadinessReport> {
  const server = await readServer(queryable, contract);
  const migrationIds = await assertHistory(queryable);
  await assertCapability(queryable, contract);
  await assertSchemaContract(queryable, contract);
  await assertRole(
    queryable,
    contract,
    REQUIRED_AUTOMATION_MANAGER_PRIVILEGES,
    NO_FUNCTION_PRIVILEGES,
    'automation_manager_role_invalid',
  );
  return Object.freeze({
    ready: true,
    ...server,
    contractName: contract.contractName,
    contractVersion: contract.contractVersion,
    migrationIds,
  });
}

export async function assertPostgresApprovalManagerSchemaReady(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract = postgresqlControlSchemaContract,
): Promise<PostgresSchemaReadinessReport> {
  const server = await readServer(queryable, contract);
  const migrationIds = await assertHistory(queryable);
  await assertCapability(queryable, contract);
  await assertSchemaContract(queryable, contract);
  await assertRole(
    queryable,
    contract,
    REQUIRED_APPROVAL_MANAGER_PRIVILEGES,
    REQUIRED_APPROVAL_MANAGER_FUNCTION_PRIVILEGES,
    'approval_manager_role_invalid',
  );
  return Object.freeze({
    ready: true,
    ...server,
    contractName: contract.contractName,
    contractVersion: contract.contractVersion,
    migrationIds,
  });
}

export async function assertPostgresRunManagerSchemaReady(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract = postgresqlControlSchemaContract,
): Promise<PostgresSchemaReadinessReport> {
  const server = await readServer(queryable, contract);
  const migrationIds = await assertHistory(queryable);
  await assertCapability(queryable, contract);
  await assertSchemaContract(queryable, contract);
  await assertRole(
    queryable,
    contract,
    REQUIRED_RUN_MANAGER_PRIVILEGES,
    REQUIRED_RUN_MANAGER_FUNCTION_PRIVILEGES,
    'run_manager_role_invalid',
  );
  await assertRunManagerColumnPrivileges(queryable, contract);
  return Object.freeze({
    ready: true,
    ...server,
    contractName: contract.contractName,
    contractVersion: contract.contractVersion,
    migrationIds,
  });
}

export async function assertPostgresPackageManagerSchemaReady(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract = postgresqlControlSchemaContract,
): Promise<PostgresSchemaReadinessReport> {
  const server = await readServer(queryable, contract);
  const migrationIds = await assertHistory(queryable);
  await assertCapability(queryable, contract);
  await assertSchemaContract(queryable, contract);
  await assertRole(
    queryable,
    contract,
    REQUIRED_PACKAGE_MANAGER_PRIVILEGES,
    REQUIRED_PACKAGE_MANAGER_FUNCTION_PRIVILEGES,
    'package_manager_role_invalid',
  );
  return Object.freeze({
    ready: true,
    ...server,
    contractName: contract.contractName,
    contractVersion: contract.contractVersion,
    migrationIds,
  });
}

export async function assertPostgresPackageExecutorSchemaReady(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract = postgresqlControlSchemaContract,
): Promise<PostgresSchemaReadinessReport> {
  const server = await readServer(queryable, contract);
  const migrationIds = await assertHistory(queryable);
  await assertCapability(queryable, contract);
  await assertSchemaContract(queryable, contract);
  await assertRole(
    queryable,
    contract,
    REQUIRED_PACKAGE_EXECUTOR_PRIVILEGES,
    REQUIRED_PACKAGE_EXECUTOR_FUNCTION_PRIVILEGES,
    'package_executor_role_invalid',
  );
  return Object.freeze({
    ready: true,
    ...server,
    contractName: contract.contractName,
    contractVersion: contract.contractVersion,
    migrationIds,
  });
}

export async function assertPostgresWorkerCredentialManagerSchemaReady(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract = postgresqlControlSchemaContract,
): Promise<PostgresSchemaReadinessReport> {
  const server = await readServer(queryable, contract);
  const migrationIds = await assertHistory(queryable);
  await assertCapability(queryable, contract);
  await assertSchemaContract(queryable, contract);
  await assertRole(
    queryable,
    contract,
    REQUIRED_WORKER_CREDENTIAL_MANAGER_PRIVILEGES,
    REQUIRED_WORKER_CREDENTIAL_FUNCTION_PRIVILEGES,
    'worker_credential_manager_role_invalid',
  );
  return Object.freeze({
    ready: true,
    ...server,
    contractName: contract.contractName,
    contractVersion: contract.contractVersion,
    migrationIds,
  });
}

export async function assertPostgresWorkerCredentialExecutorSchemaReady(
  queryable: PostgresMigrationQueryable,
  contract: PostgresSchemaContract = postgresqlControlSchemaContract,
): Promise<PostgresSchemaReadinessReport> {
  const server = await readServer(queryable, contract);
  const migrationIds = await assertHistory(queryable);
  await assertCapability(queryable, contract);
  await assertSchemaContract(queryable, contract);
  await assertRole(
    queryable,
    contract,
    REQUIRED_WORKER_CREDENTIAL_EXECUTOR_PRIVILEGES,
    REQUIRED_WORKER_CREDENTIAL_FUNCTION_PRIVILEGES,
    'worker_credential_executor_role_invalid',
  );
  return Object.freeze({
    ready: true,
    ...server,
    contractName: contract.contractName,
    contractVersion: contract.contractVersion,
    migrationIds,
  });
}
