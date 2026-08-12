import { auditMigrationStreamHistory } from '@qinglong/runtime-core/migration-stream';
import type { DatabaseSync } from 'node:sqlite';
import { localSqliteMigrationManifest } from '../migration/migrationManifest';
import { LocalSqliteMigrationStreamStore } from '../migration/migrationStreamStore';
import {
  LOCAL_STEP_RUN_REFERENCE_TRIGGERS,
  normalizeLocalSqliteSchemaSql,
} from '../run/stepRunSchemaContract';

export const LOCAL_SQLITE_CONTRACT_NAME = 'local-control-core';
export const LOCAL_SQLITE_CONTRACT_VERSION = 46;

const PLUGIN_PACKAGE_AUTOMATION_DISPOSITION_TRIGGERS = Object.freeze([
  Object.freeze({
    name: 'ql3_plugin_package_automation_lifecycle_disposition_insert',
    tableName: 'QingLong3PluginPackageLifecycleEvents',
    sql: `CREATE TRIGGER ql3_plugin_package_automation_lifecycle_disposition_insert AFTER INSERT ON "QingLong3PluginPackageLifecycleEvents" BEGIN INSERT OR IGNORE INTO "QingLong3PluginPackageAutomationDispositionEvents" (event_digest, event_kind) VALUES (NEW.event_digest, 'lifecycle'); END`,
  }),
  Object.freeze({
    name: 'ql3_plugin_package_automation_quarantine_disposition_insert',
    tableName: 'QingLong3PluginPackageQuarantineEvents',
    sql: `CREATE TRIGGER ql3_plugin_package_automation_quarantine_disposition_insert AFTER INSERT ON "QingLong3PluginPackageQuarantineEvents" BEGIN INSERT OR IGNORE INTO "QingLong3PluginPackageAutomationDispositionEvents" (event_digest, event_kind) VALUES (NEW.event_digest, 'quarantine'); END`,
  }),
]);

const OPTIONAL_FEATURE_TABLE_NAMES = new Set([
  'QingLong3AiSchemaMigrations',
  'ModelInvocationStarts',
  'ModelInvocationCompletions',
  'ModelInvocationResolutions',
  'ModelInvocationUsageLedger',
  'ModelInvocationQuotaReservations',
  'ModelInvocationQuotaSettlements',
  'ModelInvocationPriceQuotes',
  'ModelInvocationPriceSettlements',
  'ModelInvocationPromptAdmissions',
  'ModelInvocationPromptFinalizations',
  'ModelInvocationPromptOutputArtifacts',
  'ModelInvocationPromptOutputArtifactTombstones',
  'ModelPriceCatalogPublications',
  'ModelPriceCatalogHeads',
  'ModelPriceCatalogAuthorizations',
  'ModelInvocationFeatureTransitions',
  'ModelInvocationFeatureHead',
]);

const REQUIRED_SCHEMA = Object.freeze({
  QingLong3SchemaMigrations: Object.freeze({
    columns: Object.freeze([
      'migration_id',
      'stream_id',
      'dialect',
      'checksum',
      'applied_at_ms',
    ]),
    indexes: Object.freeze([]),
  }),
  QingLong3SchemaCapabilities: Object.freeze({
    columns: Object.freeze([
      'contract_name',
      'contract_version',
      'migration_id',
      'capabilities',
      'updated_at_ms',
    ]),
    indexes: Object.freeze([]),
  }),
  Runs: Object.freeze({
    columns: Object.freeze([
      'id',
      'project_id',
      'task_id',
      'task_revision',
      'task_name',
      'task_snapshot_ref',
      'legacy_cron_id',
      'parent_run_id',
      'retry_of_run_id',
      'trigger_id',
      'trigger_type',
      'execution_origin',
      'execution_owner',
      'triggered_by',
      'request_id',
      'scheduled_for_ms',
      'status',
      'version',
      'event_sequence',
      'priority',
      'idempotency_key',
      'input_ref',
      'output_ref',
      'created_at_ms',
      'queued_at_ms',
      'started_at_ms',
      'finished_at_ms',
      'cancel_requested_at_ms',
      'cancel_reason',
      'error_code',
      'error_summary',
    ]),
    indexes: Object.freeze([
      'ql3_local_runs_project_idempotency_uidx',
      'ql3_local_runs_project_created_idx',
      'ql3_local_runs_task_created_idx',
      'ql3_local_runs_cancel_requested_idx',
      'ql3_local_runs_lost_retry_idx',
      'ql3_local_runs_dispatch_idx',
    ]),
  }),
  StepRuns: Object.freeze({
    columns: Object.freeze([
      'id',
      'run_id',
      'parent_step_run_id',
      'step_key',
      'kind',
      'definition_ref',
      'definition_digest',
      'required',
      'status',
      'version',
      'attempt_count',
      'input_ref',
      'output_ref',
      'approval_request_id',
      'ready_at_ms',
      'started_at_ms',
      'finished_at_ms',
      'result_code',
      'error_summary',
      'created_at_ms',
      'updated_at_ms',
      'last_mutation_id',
      'step_run_digest',
      'step_run_json',
    ]),
    indexes: Object.freeze([
      'ql3_step_runs_run_id_uidx',
      'ql3_step_runs_run_step_uidx',
      'ql3_step_runs_run_status_idx',
      'ql3_step_runs_recovery_idx',
    ]),
  }),
  RunAttempts: Object.freeze({
    columns: Object.freeze([
      'id',
      'run_id',
      'step_run_id',
      'attempt',
      'status',
      'executor_type',
      'worker_id',
      'worker_session_id',
      'worker_generation',
      'executor_handle',
      'pid',
      'log_artifact_id',
      'lease_token',
      'lease_token_digest',
      'lease_generation',
      'lease_version',
      'lease_expires_at_ms',
      'offer_id',
      'deadline_at_ms',
      'callback_token_hash',
      'callback_sequence',
      'created_at_ms',
      'started_at_ms',
      'finished_at_ms',
      'exit_code',
      'error_code',
      'error_summary',
    ]),
    indexes: Object.freeze([
      'ql3_local_attempts_run_attempt_uidx',
      'ql3_local_attempts_run_status_idx',
      'ql3_local_attempts_lease_idx',
      'ql3_local_attempts_deadline_idx',
      'ql3_run_log_retention_candidate_idx',
    ]),
  }),
  RunEvents: Object.freeze({
    columns: Object.freeze([
      'id',
      'run_id',
      'sequence',
      'type',
      'dedupe_key',
      'actor_type',
      'actor_id',
      'attempt_id',
      'step_run_id',
      'payload',
      'created_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_local_events_run_sequence_uidx',
      'ql3_local_events_run_dedupe_uidx',
      'ql3_local_events_run_created_idx',
    ]),
  }),
  StepRunMutations: Object.freeze({
    columns: Object.freeze([
      'mutation_id',
      'mutation_digest',
      'run_id',
      'step_run_id',
      'step_run_digest',
      'event_id',
      'event_sequence',
      'run_version',
      'step_run_json',
      'committed_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_step_run_mutations_event_uidx',
      'ql3_step_run_mutations_step_idx',
    ]),
  }),
  ToolExecutionTraceAnchors: Object.freeze({
    columns: Object.freeze([
      'trace_id',
      'span_id',
      'parent_span_id',
      'project_id',
      'run_id',
      'step_run_id',
      'invocation_plan_digest',
      'binding_digest',
      'adapter_digest',
      'redaction_contract_digest',
      'audit_contract_digest',
      'created_at_ms',
      'trace_digest',
      'trace_json',
    ]),
    indexes: Object.freeze([
      'ql3_tool_execution_trace_run_idx',
      'ql3_tool_execution_trace_step_idx',
    ]),
  }),
  ToolExecutionAuditReceipts: Object.freeze({
    columns: Object.freeze([
      'event_id',
      'project_id',
      'run_id',
      'step_run_id',
      'trace_id',
      'span_id',
      'trace_digest',
      'invocation_plan_digest',
      'binding_digest',
      'audit_record_digest',
      'created_at_ms',
      'receipt_digest',
      'audit_json',
      'receipt_json',
    ]),
    indexes: Object.freeze([
      'ql3_tool_execution_audit_trace_uidx',
      'ql3_tool_execution_audit_run_idx',
      'ql3_tool_execution_audit_step_idx',
    ]),
  }),
  ToolExecutionStartBarriers: Object.freeze({
    columns: Object.freeze([
      'start_id',
      'project_id',
      'run_id',
      'step_run_id',
      'started_step_run_version',
      'step_run_mutation_id',
      'run_event_id',
      'trace_id',
      'span_id',
      'audit_event_id',
      'command_digest',
      'barrier_digest',
      'started_at_ms',
      'barrier_json',
    ]),
    indexes: Object.freeze([
      'ql3_tool_start_step_version_uidx',
      'ql3_tool_start_mutation_uidx',
      'ql3_tool_start_event_uidx',
      'ql3_tool_start_trace_uidx',
      'ql3_tool_start_audit_uidx',
      'ql3_tool_start_run_time_idx',
    ]),
  }),
  ToolInvocationInputArtifacts: Object.freeze({
    columns: Object.freeze([
      'artifact_id',
      'project_id',
      'action_ref',
      'input_digest',
      'invocation_action_digest',
      'artifact_digest',
      'key_id',
      'algorithm',
      'plaintext_bytes',
      'sealed_at_ms',
      'artifact_json',
    ]),
    indexes: Object.freeze([
      'ql3_tool_input_artifact_action_uidx',
      'ql3_tool_input_artifact_start_binding_uidx',
      'ql3_tool_input_artifact_project_time_idx',
    ]),
  }),
  ToolInvocationPreviewArtifacts: Object.freeze({
    columns: Object.freeze([
      'artifact_id',
      'project_id',
      'action_ref',
      'action_digest',
      'preview_digest',
      'redaction_contract_digest',
      'artifact_digest',
      'byte_length',
      'sealed_at_ms',
      'artifact_json',
    ]),
    indexes: Object.freeze([
      'ql3_tool_preview_artifact_action_uidx',
      'ql3_tool_preview_artifact_action_digest_uidx',
      'ql3_tool_preview_artifact_start_binding_uidx',
      'ql3_tool_preview_artifact_project_time_idx',
    ]),
  }),
  ToolExecutionStartArtifactBindings: Object.freeze({
    columns: Object.freeze([
      'start_id',
      'project_id',
      'action_ref',
      'input_artifact_id',
      'input_artifact_digest',
      'input_digest',
      'preview_artifact_id',
      'preview_artifact_digest',
      'action_digest',
      'preview_digest',
      'redaction_contract_digest',
      'bound_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_tool_start_artifact_input_idx',
      'ql3_tool_start_artifact_preview_idx',
    ]),
  }),
  ToolExecutionCompletions: Object.freeze({
    columns: Object.freeze([
      'start_id',
      'artifact_id',
      'project_id',
      'run_id',
      'step_run_id',
      'started_step_run_version',
      'completed_step_run_version',
      'barrier_digest',
      'adapter_digest',
      'output_digest',
      'execution_result_digest',
      'artifact_digest',
      'key_id',
      'algorithm',
      'plaintext_bytes',
      'step_run_mutation_id',
      'step_run_mutation_digest',
      'completed_step_run_digest',
      'run_event_id',
      'completed_at_ms',
      'completion_digest',
      'artifact_json',
      'completion_json',
    ]),
    indexes: Object.freeze([
      'ql3_tool_completion_artifact_uidx',
      'ql3_tool_completion_mutation_uidx',
      'ql3_tool_completion_event_uidx',
      'ql3_tool_completion_step_version_uidx',
      'ql3_tool_completion_project_time_idx',
    ]),
  }),
  ToolExecutionFailureCompletions: Object.freeze({
    columns: Object.freeze([
      'start_id',
      'project_id',
      'run_id',
      'step_run_id',
      'started_step_run_version',
      'completed_step_run_version',
      'barrier_digest',
      'adapter_digest',
      'outcome',
      'result_code',
      'error_summary',
      'step_run_mutation_id',
      'step_run_mutation_digest',
      'completed_step_run_digest',
      'run_event_id',
      'completed_at_ms',
      'completion_digest',
      'completion_json',
    ]),
    indexes: Object.freeze([
      'ql3_tool_failure_completion_mutation_uidx',
      'ql3_tool_failure_completion_event_uidx',
      'ql3_tool_failure_completion_step_version_uidx',
      'ql3_tool_failure_completion_project_time_idx',
    ]),
  }),
  ToolResultKeyCatalogGenerations: Object.freeze({
    columns: Object.freeze([
      'authority',
      'generation',
      'previous_generation',
      'previous_catalog_digest',
      'active_key_id',
      'mutation_kind',
      'mutation_id',
      'catalog_digest',
      'command_digest',
      'committed_at_ms',
      'catalog_json',
    ]),
    indexes: Object.freeze(['ql3_tool_result_key_catalog_current_idx']),
  }),
  ToolExecutionResultKeyBindings: Object.freeze({
    columns: Object.freeze([
      'start_id',
      'artifact_id',
      'artifact_digest',
      'catalog_authority',
      'catalog_generation',
      'catalog_digest',
      'key_id',
      'material_proof',
      'binding_digest',
    ]),
    indexes: Object.freeze(['ql3_tool_result_key_binding_catalog_idx']),
  }),
  ToolExecutionResultRekeyOverlays: Object.freeze({
    columns: Object.freeze([
      'overlay_id',
      'artifact_id',
      'source_binding_digest',
      'revision',
      'previous_overlay_digest',
      'from_key_id',
      'target_catalog_authority',
      'target_catalog_generation',
      'target_catalog_digest',
      'target_key_id',
      'target_material_proof',
      'mutation_id',
      'command_digest',
      'overlay_digest',
      'rekeyed_at_ms',
      'overlay_json',
    ]),
    indexes: Object.freeze([
      'ql3_tool_result_rekey_artifact_idx',
      'ql3_tool_result_rekey_target_idx',
    ]),
  }),
  ToolExecutionResultRekeyHeads: Object.freeze({
    columns: Object.freeze([
      'artifact_id',
      'revision',
      'overlay_id',
      'overlay_digest',
      'target_catalog_generation',
      'target_catalog_digest',
      'target_key_id',
      'updated_at_ms',
    ]),
    indexes: Object.freeze(['ql3_tool_result_rekey_head_target_idx']),
  }),
  ToolResultKeyRetirementReceipts: Object.freeze({
    columns: Object.freeze([
      'receipt_digest',
      'catalog_authority',
      'catalog_generation',
      'catalog_digest',
      'key_id',
      'material_proof',
      'mutation_id',
      'command_digest',
      'binding_count',
      'overlay_head_count',
      'uncovered_binding_count',
      'uncovered_overlay_head_count',
      'coverage_digest',
      'created_at_ms',
      'receipt_json',
    ]),
    indexes: Object.freeze(['ql3_tool_result_key_retirement_catalog_idx']),
  }),
  RunRetryPolicies: Object.freeze({
    columns: Object.freeze([
      'run_id',
      'max_attempts',
      'retry_on_lost',
      'safety',
      'backoff_base_ms',
      'backoff_max_ms',
      'next_attempt_at_ms',
      'version',
      'created_at_ms',
      'updated_at_ms',
    ]),
    indexes: Object.freeze(['ql3_local_retry_due_idx']),
  }),
  LocalCompletionReceiptJournal: Object.freeze({
    columns: Object.freeze([
      'attempt_id',
      'run_id',
      'state',
      'quarantine_ref',
      'purge_after_ms',
      'registered_at_ms',
      'updated_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_local_receipt_journal_scan_idx',
      'ql3_local_receipt_journal_purge_idx',
    ]),
  }),
  QingLong3RunAttemptLogArtifactTombstones: Object.freeze({
    columns: Object.freeze([
      'log_artifact_id',
      'project_id',
      'run_id',
      'attempt_id',
      'executor_type',
      'finished_at_ms',
      'eligible_at_ms',
      'retired_at_ms',
      'disposition',
      'byte_length',
      'truncated',
      'maximum_bytes',
      'truncation_observed_at_ms',
      'record_digest',
    ]),
    indexes: Object.freeze([
      'ql3_run_log_tombstone_attempt_uidx',
      'ql3_run_log_tombstone_retired_idx',
    ]),
  }),
  QingLong3RunAttemptLogRetentionState: Object.freeze({
    columns: Object.freeze([
      'maintenance_id',
      'cursor_finished_at_ms',
      'cursor_attempt_id',
      'updated_at_ms',
    ]),
    indexes: Object.freeze([]),
  }),
  QingLong3LocalExecutionContextRecipes: Object.freeze({
    columns: Object.freeze([
      'context_ref',
      'environment_json',
      'content_digest',
      'created_at_ms',
    ]),
    indexes: Object.freeze([]),
  }),
  QingLong3LocalTaskExecutionRevisions: Object.freeze({
    columns: Object.freeze([
      'project_id',
      'task_id',
      'task_revision',
      'executor_type',
      'command_json',
      'working_directory',
      'timeout_ms',
      'context_ref',
      'content_digest',
      'created_at_ms',
    ]),
    indexes: Object.freeze([]),
  }),
  QingLong3LocalSecretEnvelopes: Object.freeze({
    columns: Object.freeze([
      'project_id',
      'secret_name',
      'version',
      'mutation_id',
      'key_id',
      'algorithm',
      'nonce',
      'ciphertext',
      'auth_tag',
      'created_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_local_secret_mutation_uidx',
      'ql3_local_secret_current_idx',
      'ql3_local_secret_key_usage_idx',
    ]),
  }),
  QingLong3Projects: Object.freeze({
    columns: Object.freeze([
      'id',
      'name',
      'slug',
      'status',
      'version',
      'created_at_ms',
      'updated_at_ms',
    ]),
    indexes: Object.freeze(['ql3_local_projects_slug_uidx']),
  }),
  QingLong3TaskDefinitions: Object.freeze({
    columns: Object.freeze([
      'project_id',
      'task_id',
      'current_revision',
      'created_at_ms',
      'updated_at_ms',
    ]),
    indexes: Object.freeze([]),
  }),
  QingLong3TaskDefinitionRevisions: Object.freeze({
    columns: Object.freeze([
      'project_id',
      'task_id',
      'revision',
      'mutation_id',
      'name',
      'description',
      'kind',
      'spec_json',
      'labels_json',
      'enabled',
      'content_digest',
      'created_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_task_definition_revisions_mutation_uidx',
      'ql3_task_definition_revisions_project_kind_idx',
    ]),
  }),
  QingLong3Triggers: Object.freeze({
    columns: Object.freeze([
      'project_id',
      'trigger_id',
      'task_id',
      'current_revision',
      'created_at_ms',
      'updated_at_ms',
    ]),
    indexes: Object.freeze(['ql3_triggers_task_uidx']),
  }),
  QingLong3TriggerRevisions: Object.freeze({
    columns: Object.freeze([
      'project_id',
      'trigger_id',
      'revision',
      'mutation_id',
      'task_id',
      'task_revision',
      'task_content_digest',
      'spec_json',
      'enabled',
      'content_digest',
      'created_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_trigger_revisions_mutation_uidx',
      'ql3_trigger_revisions_project_enabled_idx',
      'ql3_trigger_revisions_task_idx',
    ]),
  }),
  QingLong3LocalTriggerSchedules: Object.freeze({
    columns: Object.freeze([
      'project_id',
      'trigger_id',
      'trigger_revision',
      'next_fire_at_ms',
      'last_scheduled_at_ms',
      'state_version',
      'updated_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_local_trigger_schedules_due_idx',
      'ql3_local_trigger_schedules_initialize_idx',
    ]),
  }),
  QingLong3ApprovalRequests: Object.freeze({
    columns: Object.freeze([
      'request_id',
      'project_id',
      'version',
      'state',
      'action_type',
      'action_ref',
      'action_digest',
      'preview_digest',
      'requested_by_type',
      'requested_by_id',
      'decision_id',
      'consumption_id',
      'dispatch_id',
      'expires_at_ms',
      'request_json',
      'request_digest',
      'updated_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_approval_requests_decision_uidx',
      'ql3_approval_requests_consumption_uidx',
      'ql3_approval_requests_dispatch_uidx',
      'ql3_approval_requests_pending_idx',
      'ql3_approval_requests_project_idx',
    ]),
  }),
  QingLong3ApprovedActionDispatches: Object.freeze({
    columns: Object.freeze([
      'dispatch_id',
      'approval_request_id',
      'project_id',
      'action_type',
      'action_ref',
      'action_digest',
      'preview_digest',
      'dispatch_json',
      'dispatch_digest',
      'created_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_approved_action_dispatch_request_uidx',
      'ql3_approved_action_dispatch_lifecycle_uidx',
      'ql3_approved_action_dispatch_project_idx',
    ]),
  }),
  QingLong3ApprovedActionExecutions: Object.freeze({
    columns: Object.freeze([
      'dispatch_id',
      'dispatch_digest',
      'project_id',
      'status',
      'version',
      'attempt_count',
      'max_attempts',
      'eligible_at_ms',
      'next_attempt_at_ms',
      'lease_owner',
      'lease_token',
      'lease_expires_at_ms',
      'started_at_ms',
      'result_mutation_id',
      'result_code',
      'result_digest',
      'completed_at_ms',
      'created_at_ms',
      'updated_at_ms',
      'execution_json',
      'execution_digest',
    ]),
    indexes: Object.freeze([
      'ql3_approved_action_execution_due_idx',
      'ql3_approved_action_execution_recovery_idx',
      'ql3_approved_action_execution_project_idx',
    ]),
  }),
  QingLong3PluginPackageInstallProposals: Object.freeze({
    columns: Object.freeze([
      'action_ref',
      'project_id',
      'action_type',
      'permission',
      'action_digest',
      'preview_digest',
      'proposed_by_type',
      'proposed_by_id',
      'fence_project_version',
      'fence_binding_version',
      'created_at_ms',
      'proposal_json',
      'proposal_digest',
    ]),
    indexes: Object.freeze(['ql3_plugin_package_proposal_project_idx']),
  }),
  QingLong3PluginPackageAdmissionReceipts: Object.freeze({
    columns: Object.freeze([
      'dispatch_id',
      'dispatch_digest',
      'approval_request_id',
      'action_ref',
      'project_id',
      'package_name',
      'installation_id',
      'lock_digest',
      'record_digest',
      'mutation_id',
      'mutation_digest',
      'audit_event_id',
      'admitted_at_ms',
      'receipt_json',
      'receipt_digest',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_admission_install_uidx',
      'ql3_plugin_package_admission_audit_uidx',
      'ql3_plugin_package_admission_project_idx',
    ]),
  }),
  QingLong3PluginPackageInstalls: Object.freeze({
    columns: Object.freeze([
      'installation_id',
      'project_id',
      'package_name',
      'package_version',
      'operation',
      'lock_digest',
      'target_generation',
      'previous_active_lock_digest',
      'active_lock_digest',
      'state',
      'version',
      'last_mutation_id',
      'last_mutation_digest',
      'lock_json',
      'record_json',
      'record_digest',
      'created_at_ms',
      'updated_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_installs_recovery_idx',
      'ql3_plugin_package_installs_project_history_idx',
      'ql3_plugin_package_installs_snapshot_source_uidx',
      'ql3_plugin_package_installs_quarantine_target_uidx',
    ]),
  }),
  QingLong3PluginPackageInstallHeads: Object.freeze({
    columns: Object.freeze(['project_id', 'package_name', 'installation_id']),
    indexes: Object.freeze(['ql3_plugin_package_install_heads_install_uidx']),
  }),
  QingLong3PluginPackageInstallMutations: Object.freeze({
    columns: Object.freeze([
      'installation_id',
      'mutation_id',
      'mutation_digest',
      'resulting_record_digest',
      'occurred_at_ms',
    ]),
    indexes: Object.freeze(['ql3_plugin_package_install_mutations_result_idx']),
  }),
  QingLong3PluginPackageQuarantineEvents: Object.freeze({
    columns: Object.freeze([
      'event_digest',
      'mutation_id',
      'revocation_receipt_digest',
      'impact_digest',
      'project_id',
      'package_name',
      'installation_id',
      'lock_digest',
      'install_state',
      'install_version',
      'install_record_digest',
      'active_lock_digest',
      'proposer_type',
      'proposer_id',
      'confirmer_type',
      'confirmer_id',
      'authorization_mode',
      'reason_code',
      'occurred_at_ms',
      'event_json',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_quarantine_mutation_uidx',
      'ql3_plugin_package_quarantine_target_uidx',
      'ql3_plugin_package_quarantine_lock_idx',
      'ql3_plugin_package_quarantine_project_idx',
    ]),
  }),
  QingLong3PluginPackageWithdrawalReceipts: Object.freeze({
    columns: Object.freeze([
      'event_digest',
      'receipt_digest',
      'project_id',
      'capability_status',
      'task_count',
      'previous_active_vector_digest',
      'current_active_vector_digest',
      'current_tool_snapshot_digest',
      'retained_source_count',
      'committed_at_ms',
      'receipt_json',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_withdrawal_receipt_uidx',
      'ql3_plugin_package_withdrawal_snapshot_idx',
    ]),
  }),
  QingLong3PluginPackageWithdrawalTasks: Object.freeze({
    columns: Object.freeze([
      'event_digest',
      'project_id',
      'task_id',
      'previous_revision',
      'disabled_revision',
      'previous_content_digest',
      'disabled_content_digest',
    ]),
    indexes: Object.freeze(['ql3_plugin_package_withdrawal_task_task_idx']),
  }),
  QingLong3PluginPackageLifecycleEvents: Object.freeze({
    columns: Object.freeze([
      'event_digest',
      'mutation_id',
      'dispatch_id',
      'approved_action_type',
      'action',
      'project_id',
      'package_name',
      'installation_id',
      'lock_digest',
      'install_version',
      'install_record_digest',
      'expected_version',
      'expected_disposition',
      'expected_event_digest',
      'generation_digest',
      'materialized_revision_digest',
      'current_tool_snapshot_digest',
      'reference_graph_digest',
      'impact_digest',
      'action_digest',
      'requested_by_type',
      'requested_by_id',
      'approved_by_type',
      'approved_by_id',
      'authorization_mode',
      'occurred_at_ms',
      'event_json',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_lifecycle_mutation_uidx',
      'ql3_plugin_package_lifecycle_dispatch_uidx',
      'ql3_plugin_package_lifecycle_target_version_uidx',
      'ql3_plugin_package_lifecycle_project_idx',
    ]),
  }),
  QingLong3PluginPackageLifecycleHeads: Object.freeze({
    columns: Object.freeze([
      'project_id',
      'package_name',
      'installation_id',
      'lock_digest',
      'install_record_digest',
      'version',
      'disposition',
      'event_digest',
      'updated_at_ms',
    ]),
    indexes: Object.freeze(['ql3_plugin_package_lifecycle_head_event_uidx']),
  }),
  QingLong3PluginPackageLifecycleReceipts: Object.freeze({
    columns: Object.freeze([
      'event_digest',
      'receipt_digest',
      'project_id',
      'action',
      'capability_status',
      'task_count',
      'previous_active_vector_digest',
      'current_active_vector_digest',
      'current_tool_snapshot_digest',
      'retained_source_count',
      'committed_at_ms',
      'receipt_json',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_lifecycle_receipt_uidx',
      'ql3_plugin_package_lifecycle_receipt_snapshot_idx',
    ]),
  }),
  QingLong3PluginPackageLifecycleTasks: Object.freeze({
    columns: Object.freeze([
      'event_digest',
      'project_id',
      'task_id',
      'previous_revision',
      'current_revision',
      'previous_content_digest',
      'current_content_digest',
      'previous_enabled',
      'current_enabled',
    ]),
    indexes: Object.freeze(['ql3_plugin_package_lifecycle_task_idx']),
  }),
  QingLong3PluginPackageAutomationPublications: Object.freeze({
    columns: Object.freeze([
      'publication_digest',
      'project_id',
      'package_name',
      'installation_id',
      'lock_digest',
      'generation',
      'generation_digest',
      'materialized_revision_digest',
      'state',
      'version',
      'previous_publication_digest',
      'lifecycle_event_digest',
      'published_at_ms',
      'publication_json',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_automation_publication_version_uidx',
      'ql3_plugin_package_automation_publication_previous_uidx',
      'ql3_plugin_package_automation_publication_generation_idx',
    ]),
  }),
  QingLong3PluginPackageAutomationDispositionEvents: Object.freeze({
    columns: Object.freeze(['event_digest', 'event_kind']),
    indexes: Object.freeze([]),
  }),
  QingLong3PluginPackageAutomationPublicationHeads: Object.freeze({
    columns: Object.freeze([
      'project_id',
      'package_name',
      'publication_digest',
      'generation_digest',
      'state',
      'version',
      'updated_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_automation_publication_head_digest_uidx',
    ]),
  }),
  QingLong3PluginPackageWorkflowAdmissions: Object.freeze({
    columns: Object.freeze([
      'plan_digest',
      'plan_id',
      'run_id',
      'project_id',
      'package_name',
      'installation_id',
      'lock_digest',
      'generation',
      'generation_digest',
      'materialized_revision_digest',
      'publication_digest',
      'workflow_id',
      'workflow_definition_digest',
      'step_count',
      'admitted_at_ms',
      'final_run_version',
      'final_run_event_sequence',
      'receipt_digest',
      'plan_json',
      'receipt_json',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_workflow_admission_plan_uidx',
      'ql3_plugin_package_workflow_admission_run_uidx',
      'ql3_plugin_package_workflow_admission_receipt_uidx',
      'ql3_plugin_package_workflow_admission_plan_run_uidx',
      'ql3_plugin_package_workflow_admission_target_idx',
      'ql3_plugin_package_workflow_admission_workflow_history_idx',
    ]),
  }),
  QingLong3PluginPackageWorkflowAdmissionSteps: Object.freeze({
    columns: Object.freeze([
      'plan_digest',
      'run_id',
      'step_key',
      'step_run_id',
      'task_id',
      'task_definition_ref',
      'task_definition_digest',
      'needs_json',
      'initial_status',
      'mutation_id',
      'event_id',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_workflow_admission_step_run_uidx',
      'ql3_plugin_package_workflow_admission_step_mutation_uidx',
      'ql3_plugin_package_workflow_admission_step_event_uidx',
      'ql3_plugin_package_workflow_admission_step_task_idx',
    ]),
  }),
  QingLong3PluginPackageWorkflowTaskAttemptAdmissions: Object.freeze({
    columns: Object.freeze([
      'receipt_digest',
      'attempt_id',
      'plan_digest',
      'run_id',
      'step_run_id',
      'step_run_version',
      'step_run_digest',
      'generation_digest',
      'resource_task_id',
      'task_reconciliation_receipt_digest',
      'project_id',
      'task_id',
      'task_revision',
      'task_definition_digest',
      'executor_type',
      'execution_digest',
      'attempt_number',
      'event_id',
      'run_version',
      'run_event_sequence',
      'admitted_at_ms',
      'receipt_json',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_workflow_task_attempt_admission_attempt_uidx',
      'ql3_plugin_package_workflow_task_attempt_admission_event_uidx',
      'ql3_plugin_package_workflow_task_attempt_admission_epoch_uidx',
      'ql3_plugin_package_workflow_task_attempt_admission_number_uidx',
      'ql3_plugin_package_workflow_task_attempt_admission_candidate_idx',
    ]),
  }),
  QingLong3PluginPackageMaterializedRevisions: Object.freeze({
    columns: Object.freeze([
      'generation_digest',
      'project_id',
      'package_name',
      'generation',
      'lock_digest',
      'manifest_digest',
      'revision_digest',
      'revision_json',
      'created_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_materialized_revision_generation_uidx',
      'ql3_plugin_package_materialized_revision_lock_idx',
      'ql3_plugin_package_materialized_revision_snapshot_source_uidx',
    ]),
  }),
  QingLong3PluginPackageSecretBindings: Object.freeze({
    columns: Object.freeze([
      'generation_digest',
      'project_id',
      'package_name',
      'installation_id',
      'lock_digest',
      'generation',
      'manifest_digest',
      'authority_kind',
      'evidence_digest',
      'bound_at_ms',
      'binding_digest',
      'binding_json',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_secret_binding_generation_uidx',
      'ql3_plugin_package_secret_binding_digest_uidx',
      'ql3_plugin_package_secret_binding_install_idx',
    ]),
  }),
  QingLong3ProjectToolDefinitionSnapshots: Object.freeze({
    columns: Object.freeze([
      'project_id',
      'active_vector_digest',
      'definitions_digest',
      'snapshot_digest',
      'snapshot_json',
      'committed_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_project_tool_definition_snapshot_digest_uidx',
      'ql3_project_tool_definition_snapshot_withdrawal_uidx',
      'ql3_project_tool_definition_snapshot_current_idx',
    ]),
  }),
  QingLong3ProjectToolDefinitionSnapshotSources: Object.freeze({
    columns: Object.freeze([
      'project_id',
      'active_vector_digest',
      'package_name',
      'installation_id',
      'generation',
      'generation_digest',
      'lock_digest',
      'revision_digest',
    ]),
    indexes: Object.freeze([
      'ql3_project_tool_definition_snapshot_source_generation_idx',
      'ql3_project_tool_definition_snapshot_source_install_idx',
    ]),
  }),
  QingLong3PluginPackageTaskOwnerships: Object.freeze({
    columns: Object.freeze([
      'project_id',
      'task_id',
      'package_name',
      'claimed_generation_digest',
      'created_at_ms',
    ]),
    indexes: Object.freeze(['ql3_plugin_package_task_ownership_package_idx']),
  }),
  QingLong3PluginPackageTaskReconciliations: Object.freeze({
    columns: Object.freeze([
      'generation_digest',
      'project_id',
      'package_name',
      'generation',
      'materialized_revision_digest',
      'lock_digest',
      'previous_lock_digest',
      'receipt_digest',
      'receipt_json',
      'committed_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_task_reconciliation_generation_uidx',
      'ql3_plugin_package_task_reconciliation_receipt_uidx',
      'ql3_plugin_package_task_reconciliation_lock_idx',
    ]),
  }),
  QingLong3PluginPackageTaskReconciliationItems: Object.freeze({
    columns: Object.freeze([
      'generation_digest',
      'task_id',
      'revision',
      'disposition',
      'content_digest',
    ]),
    indexes: Object.freeze([
      'ql3_plugin_package_task_reconciliation_item_task_idx',
    ]),
  }),
  QingLong3ProjectRoleBindings: Object.freeze({
    columns: Object.freeze([
      'project_id',
      'subject_type',
      'subject_id',
      'version',
      'state',
      'role',
      'mutation_id',
      'changed_by_type',
      'changed_by_id',
      'created_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_local_bindings_mutation_uidx',
      'ql3_local_bindings_current_idx',
      'ql3_local_bindings_project_idx',
    ]),
  }),
  QingLong3SecurityAuditEvents: Object.freeze({
    columns: Object.freeze([
      'event_id',
      'request_id',
      'operation_id',
      'project_id',
      'subject_type',
      'subject_id',
      'authentication_id',
      'outcome',
      'reasons_json',
      'fence_project_version',
      'fence_binding_version',
      'occurred_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_local_audit_project_time_idx',
      'ql3_local_audit_subject_time_idx',
    ]),
  }),
  QingLong3ProjectAdministrationMutations: Object.freeze({
    columns: Object.freeze([
      'mutation_id',
      'operation',
      'authority_project_id',
      'project_id',
      'project_name',
      'project_slug',
      'project_status',
      'project_version',
      'expected_previous_version',
      'changed_by_type',
      'changed_by_id',
      'initial_owner_binding_version',
      'audit_event_id',
      'project_created_at_ms',
      'created_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_project_admin_project_version_uidx',
      'ql3_project_admin_authority_time_idx',
    ]),
  }),
  QingLong3SecurityAuditCompactions: Object.freeze({
    columns: Object.freeze([
      'mutation_id',
      'request_id',
      'authority_project_id',
      'retention_ms',
      'eligible_before_ms',
      'batch_limit',
      'deleted_count',
      'deleted_payload_bytes',
      'first_occurred_at_ms',
      'first_event_id',
      'last_occurred_at_ms',
      'last_event_id',
      'records_digest',
      'audit_event_id',
      'created_at_ms',
    ]),
    indexes: Object.freeze(['ql3_audit_compaction_authority_time_idx']),
  }),
  QingLong3LegacyAdoptions: Object.freeze({
    columns: Object.freeze([
      'mutation_id',
      'decision_id',
      'project_id',
      'profile',
      'plan_digest',
      'inventory_digest',
      'decision_digest',
      'receipt_digest',
      'authorization_file_digest',
      'publication_digest',
      'row_count',
      'adopted_task_count',
      'adopted_trigger_count',
      'skipped_count',
      'audit_event_id',
      'created_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_legacy_adoptions_decision_uidx',
      'ql3_legacy_adoptions_project_time_idx',
    ]),
  }),
  QingLong3IdentitySubjects: Object.freeze({
    columns: Object.freeze([
      'subject_type',
      'subject_id',
      'status',
      'version',
      'created_at_ms',
      'updated_at_ms',
    ]),
    indexes: Object.freeze(['ql3_local_identity_status_idx']),
  }),
  QingLong3ApiCredentials: Object.freeze({
    columns: Object.freeze([
      'credential_id',
      'version',
      'state',
      'subject_type',
      'subject_id',
      'secret_digest',
      'created_at_ms',
      'not_before_at_ms',
      'expires_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_local_credentials_current_idx',
      'ql3_local_credentials_subject_idx',
    ]),
  }),
  QingLong3ApiCredentialPepperBindings: Object.freeze({
    columns: Object.freeze([
      'credential_id',
      'credential_version',
      'pepper_key_id',
    ]),
    indexes: Object.freeze([
      'ql3_local_credential_pepper_key_idx',
      'ql3_local_credential_pepper_binding_triple_uidx',
    ]),
  }),
  QingLong3IdentityAdministrationMutations: Object.freeze({
    columns: Object.freeze([
      'mutation_id',
      'project_id',
      'operation',
      'subject_type',
      'subject_id',
      'subject_version',
      'expected_previous_version',
      'status',
      'changed_by_type',
      'changed_by_id',
      'audit_event_id',
      'identity_created_at_ms',
      'created_at_ms',
    ]),
    indexes: Object.freeze(['ql3_identity_admin_subject_idx']),
  }),
  QingLong3ApiCredentialAdministrationMutations: Object.freeze({
    columns: Object.freeze([
      'mutation_id',
      'project_id',
      'operation',
      'credential_id',
      'credential_version',
      'expected_previous_version',
      'subject_type',
      'subject_id',
      'subject_status',
      'state',
      'pepper_key_id',
      'secret_digest',
      'not_before_at_ms',
      'expires_at_ms',
      'delivery_digest',
      'changed_by_type',
      'changed_by_id',
      'audit_event_id',
      'created_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_credential_admin_credential_idx',
      'ql3_credential_admin_subject_idx',
    ]),
  }),
  QingLong3ApiCredentialDeliveryAcknowledgements: Object.freeze({
    columns: Object.freeze([
      'credential_mutation_id',
      'acknowledgement_mutation_id',
      'project_id',
      'delivery_digest',
      'acknowledged_by_type',
      'acknowledged_by_id',
      'audit_event_id',
      'acknowledged_at_ms',
    ]),
    indexes: Object.freeze(['ql3_credential_delivery_ack_project_idx']),
  }),
  QingLong3LocalOwnerPepperKeys: Object.freeze({
    columns: Object.freeze([
      'pepper_key_id',
      'material_digest',
      'backup_digest',
      'state',
      'version',
      'register_mutation_id',
      'activate_mutation_id',
      'retire_mutation_id',
      'registered_at_ms',
      'activated_at_ms',
      'retired_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_local_owner_pepper_register_mutation_uidx',
      'ql3_local_owner_pepper_single_active_uidx',
      'ql3_local_owner_pepper_state_idx',
    ]),
  }),
  QingLong3LocalOwnerPepperActivations: Object.freeze({
    columns: Object.freeze([
      'generation',
      'mutation_id',
      'expected_generation',
      'previous_pepper_key_id',
      'active_pepper_key_id',
      'material_digest',
      'backup_digest',
      'activated_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_local_owner_pepper_activation_mutation_uidx',
      'ql3_local_owner_pepper_activation_key_idx',
    ]),
  }),
  QingLong3LocalIdentityProvisionings: Object.freeze({
    columns: Object.freeze([
      'slot',
      'mutation_id',
      'request_id',
      'subject_type',
      'subject_id',
      'credential_id',
      'credential_version',
      'issuer_authentication_id',
      'issuer_authenticated_at_ms',
      'issuer_expires_at_ms',
      'audit_event_id',
      'created_at_ms',
    ]),
    indexes: Object.freeze([
      'ql3_local_provisioning_mutation_uidx',
      'ql3_local_provisioning_subject_uidx',
      'ql3_local_provisioning_credential_uidx',
    ]),
  }),
  QingLong3LocalOwnerBootstrapChallenges: Object.freeze({
    columns: Object.freeze([
      'project_id',
      'version',
      'issue_mutation_id',
      'issue_request_id',
      'challenge_id',
      'token_digest',
      'issuer_authentication_id',
      'issuer_authenticated_at_ms',
      'issuer_expires_at_ms',
      'issued_at_ms',
      'expires_at_ms',
      'issue_audit_event_id',
      'consumed_at_ms',
      'claim_mutation_id',
      'claim_request_id',
      'claimed_subject_type',
      'claimed_subject_id',
      'credential_id',
      'credential_version',
      'claim_authentication_id',
      'claim_authenticated_at_ms',
      'claim_expires_at_ms',
      'claim_assurance',
      'claim_audit_event_id',
    ]),
    indexes: Object.freeze([
      'ql3_local_owner_challenge_issue_mutation_uidx',
      'ql3_local_owner_challenge_id_uidx',
      'ql3_local_owner_challenge_claim_mutation_uidx',
      'ql3_local_owner_challenge_current_idx',
      'ql3_local_owner_challenge_expiry_idx',
    ]),
  }),
  QingLong3LocalOwnerDeliveryAcknowledgements: Object.freeze({
    columns: Object.freeze([
      'mutation_id',
      'kind',
      'request_id',
      'project_id',
      'subject_id',
      'credential_id',
      'challenge_id',
      'fact_digest',
      'delivery_digest',
      'ttl_ms',
      'acknowledged_at_ms',
      'provisioning_mutation_id',
      'challenge_mutation_id',
    ]),
    indexes: Object.freeze([]),
  }),
  QingLong3LocalOwnerDeliveryAcknowledgementGc: Object.freeze({
    columns: Object.freeze([
      'gc_mutation_id',
      'gc_request_id',
      'acknowledgement_mutation_id',
      'acknowledgement_kind',
      'delivery_digest',
      'acknowledged_at_ms',
      'acknowledgement_semantic_digest',
      'bridge_clear_evidence_digest',
      'retention_policy_version',
      'replay_retention_ms',
      'audit_retention_ms',
      'retention_policy_digest',
      'retention_eligible_at_ms',
      'compacted_at_ms',
      'audit_event_id',
      'provisioning_mutation_id',
      'challenge_mutation_id',
    ]),
    indexes: Object.freeze([
      'ql3_local_owner_delivery_ack_gc_ack_uidx',
      'ql3_local_owner_delivery_ack_gc_compacted_idx',
    ]),
  }),
  QingLong3LocalOwnerCredentialRecoveries: Object.freeze({
    columns: Object.freeze([
      'issue_mutation_id',
      'issue_request_id',
      'subject_type',
      'subject_id',
      'previous_credential_id',
      'previous_credential_version',
      'replacement_credential_id',
      'replacement_credential_version',
      'state',
      'issued_at_ms',
      'issue_audit_event_id',
      'delivery_digest',
      'acknowledged_at_ms',
      'complete_mutation_id',
      'complete_request_id',
      'revoked_credential_version',
      'completed_at_ms',
      'complete_audit_event_id',
    ]),
    indexes: Object.freeze([
      'ql3_local_owner_recovery_open_subject_uidx',
      'ql3_local_owner_recovery_replacement_uidx',
      'ql3_local_owner_recovery_complete_mutation_uidx',
      'ql3_local_owner_recovery_previous_idx',
    ]),
  }),
  QingLong3LocalOwnerPepperMaterialGc: Object.freeze({
    columns: Object.freeze([
      'prepare_mutation_id',
      'prepare_request_id',
      'pepper_key_id',
      'material_digest',
      'backup_material_digest',
      'active_pepper_key_id',
      'active_generation',
      'active_material_digest',
      'retention_policy_version',
      'acknowledgement_retention_ms',
      'audit_retention_ms',
      'backup_retention_ms',
      'retention_policy_digest',
      'references_inspected_at_ms',
      'retention_eligible_at_ms',
      'prepared_at_ms',
      'prepare_audit_event_id',
      'state',
      'complete_mutation_id',
      'complete_request_id',
      'destruction_proof_digest',
      'completed_at_ms',
      'complete_audit_event_id',
    ]),
    indexes: Object.freeze([
      'ql3_local_owner_pepper_gc_key_uidx',
      'ql3_local_owner_pepper_gc_open_uidx',
      'ql3_local_owner_pepper_gc_complete_mutation_uidx',
      'ql3_local_owner_pepper_gc_state_idx',
    ]),
  }),
});

interface NameRow {
  name: unknown;
}

interface TriggerRow {
  name: unknown;
  table_name: unknown;
  sql: unknown;
}

interface CapabilityRow {
  contract_name: unknown;
  contract_version: unknown;
  migration_id: unknown;
  capabilities: unknown;
  updated_at_ms: unknown;
}

export interface LocalSqliteReadinessEvidence {
  readonly contractName: typeof LOCAL_SQLITE_CONTRACT_NAME;
  readonly contractVersion: typeof LOCAL_SQLITE_CONTRACT_VERSION;
  readonly sqliteVersion: string;
  readonly migrationIds: readonly string[];
  readonly tableCount: number;
  readonly journalMode: string;
}

export class LocalSqliteReadinessError extends Error {
  readonly code = 'LOCAL_SQLITE_NOT_READY';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local SQLite is not ready: ${message}`);
    this.name = 'LocalSqliteReadinessError';
  }
}

function names(rows: readonly NameRow[], label: string): string[] {
  const values = rows.map((row) => row.name);
  if (values.some((value) => typeof value !== 'string')) {
    throw new LocalSqliteReadinessError(`${label} catalog is invalid`);
  }
  return (values as string[]).sort();
}

function pragmaNameList(
  client: DatabaseSync,
  pragma: 'table_info' | 'index_list',
  tableName: string,
): string[] {
  if (!(tableName in REQUIRED_SCHEMA)) {
    throw new LocalSqliteReadinessError('table identity is invalid');
  }
  return names(
    client
      .prepare(`PRAGMA ${pragma}("${tableName}")`)
      .all() as unknown as NameRow[],
    `${tableName} ${pragma}`,
  );
}

function assertRequiredSchema(client: DatabaseSync): number {
  const tables = names(
    client
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as unknown as NameRow[],
    'table',
  );
  for (const [tableName, contract] of Object.entries(REQUIRED_SCHEMA)) {
    if (!tables.includes(tableName)) {
      throw new LocalSqliteReadinessError(
        `required table ${tableName} is missing`,
      );
    }
    const columns = pragmaNameList(client, 'table_info', tableName);
    for (const column of contract.columns) {
      if (!columns.includes(column)) {
        throw new LocalSqliteReadinessError(
          `required column ${tableName}.${column} is missing`,
        );
      }
    }
    const indexes = pragmaNameList(client, 'index_list', tableName);
    for (const indexName of contract.indexes) {
      if (!indexes.includes(indexName)) {
        throw new LocalSqliteReadinessError(
          `required index ${indexName} is missing`,
        );
      }
    }
  }
  const ownedTableNames = Object.keys(REQUIRED_SCHEMA);
  const triggerRows = client
    .prepare(
      `SELECT name, tbl_name AS table_name, sql
       FROM sqlite_schema
       WHERE type = 'trigger' AND
         tbl_name IN (${ownedTableNames.map(() => '?').join(', ')})
       ORDER BY name`,
    )
    .all(...ownedTableNames) as unknown as TriggerRow[];
  const expectedTriggers = [
    ...LOCAL_STEP_RUN_REFERENCE_TRIGGERS,
    ...PLUGIN_PACKAGE_AUTOMATION_DISPOSITION_TRIGGERS,
  ].sort((left, right) => left.name.localeCompare(right.name));
  if (
    triggerRows.length !== expectedTriggers.length ||
    triggerRows.some((row, index) => {
      const expected = expectedTriggers[index]!;
      return (
        row.name !== expected.name ||
        row.table_name !== expected.tableName ||
        typeof row.sql !== 'string' ||
        normalizeLocalSqliteSchemaSql(row.sql) !==
          normalizeLocalSqliteSchemaSql(expected.sql)
      );
    })
  ) {
    throw new LocalSqliteReadinessError(
      'reviewed trigger contract is incompatible',
    );
  }
  return tables.filter((table) => !OPTIONAL_FEATURE_TABLE_NAMES.has(table))
    .length;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw new LocalSqliteReadinessError(`${field} is invalid`);
  }
  return value;
}

function assertPluginPackageQuarantineIntegrity(client: DatabaseSync): void {
  const invalid = client
    .prepare(
      `SELECT 1
       FROM "QingLong3PluginPackageWithdrawalReceipts" AS receipt
       JOIN "QingLong3PluginPackageQuarantineEvents" AS quarantine
         ON quarantine.event_digest = receipt.event_digest
       WHERE receipt.project_id <> quarantine.project_id
          OR receipt.committed_at_ms < quarantine.occurred_at_ms
          OR receipt.task_count <> (
            SELECT COUNT(*)
            FROM "QingLong3PluginPackageWithdrawalTasks" AS task
            WHERE task.event_digest = receipt.event_digest
          )
          OR EXISTS (
            SELECT 1
            FROM "QingLong3PluginPackageWithdrawalTasks" AS task
            JOIN "QingLong3TaskDefinitionRevisions" AS previous
              ON previous.project_id = task.project_id
             AND previous.task_id = task.task_id
             AND previous.revision = task.previous_revision
            JOIN "QingLong3TaskDefinitionRevisions" AS disabled
              ON disabled.project_id = task.project_id
             AND disabled.task_id = task.task_id
             AND disabled.revision = task.disabled_revision
            WHERE task.event_digest = receipt.event_digest
              AND (
                task.project_id <> receipt.project_id OR
                task.previous_content_digest <> previous.content_digest OR
                task.disabled_content_digest <> disabled.content_digest
              )
          )
          OR (
            receipt.capability_status = 'withdrawn' AND (
              receipt.retained_source_count <> (
                SELECT COUNT(*)
                FROM "QingLong3ProjectToolDefinitionSnapshotSources" AS source
                WHERE source.project_id = receipt.project_id
                  AND source.active_vector_digest =
                    receipt.current_active_vector_digest
              ) OR EXISTS (
                SELECT 1
                FROM "QingLong3ProjectToolDefinitionSnapshotSources" AS source
                WHERE source.project_id = receipt.project_id
                  AND source.active_vector_digest =
                    receipt.current_active_vector_digest
                  AND source.package_name = quarantine.package_name
                  AND source.lock_digest = quarantine.lock_digest
              )
            )
          )
       LIMIT 1`,
    )
    .get();
  if (invalid) {
    throw new LocalSqliteReadinessError(
      'Plugin Package quarantine evidence is inconsistent',
    );
  }
}

function assertPluginPackageLifecycleIntegrity(client: DatabaseSync): void {
  const invalidEvent = client
    .prepare(
      `SELECT 1
       FROM "QingLong3PluginPackageLifecycleEvents" AS event
       LEFT JOIN "QingLong3ApprovedActionDispatches" AS dispatch
         ON dispatch.dispatch_id = event.dispatch_id
       LEFT JOIN "QingLong3PluginPackageLifecycleReceipts" AS receipt
         ON receipt.event_digest = event.event_digest
       LEFT JOIN "QingLong3PluginPackageLifecycleEvents" AS previous_event
         ON previous_event.event_digest = event.expected_event_digest
       LEFT JOIN "QingLong3PluginPackageMaterializedRevisions" AS materialized
         ON materialized.project_id = event.project_id
        AND materialized.package_name = event.package_name
        AND materialized.lock_digest = event.lock_digest
        AND materialized.generation_digest = event.generation_digest
        AND materialized.revision_digest =
          event.materialized_revision_digest
       WHERE dispatch.dispatch_id IS NULL
          OR dispatch.project_id <> event.project_id
          OR dispatch.action_type <> event.approved_action_type
          OR dispatch.action_digest <> event.action_digest
          OR dispatch.preview_digest <> event.impact_digest
          OR json_extract(
            dispatch.dispatch_json, '$.action.permission'
          ) <> 'package.manage'
          OR json_extract(
            dispatch.dispatch_json, '$.requestedBy.type'
          ) <> event.requested_by_type
          OR json_extract(
            dispatch.dispatch_json, '$.requestedBy.id'
          ) <> event.requested_by_id
          OR json_extract(
            dispatch.dispatch_json, '$.approvedBy.type'
          ) <> event.approved_by_type
          OR json_extract(
            dispatch.dispatch_json, '$.approvedBy.id'
          ) <> event.approved_by_id
          OR event.occurred_at_ms < json_extract(
            dispatch.dispatch_json, '$.approvedAtMs'
          )
          OR event.occurred_at_ms > json_extract(
            dispatch.dispatch_json, '$.expiresAtMs'
          )
          OR receipt.event_digest IS NULL
          OR receipt.project_id <> event.project_id
          OR receipt.action <> event.action
          OR receipt.committed_at_ms < event.occurred_at_ms
          OR materialized.generation_digest IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM "QingLong3ProjectToolDefinitionSnapshots" AS before_snapshot
            WHERE before_snapshot.project_id = event.project_id
              AND before_snapshot.snapshot_digest =
                event.current_tool_snapshot_digest
          )
          OR (
            event.expected_version > 0 AND (
              previous_event.event_digest IS NULL OR
              previous_event.project_id <> event.project_id OR
              previous_event.package_name <> event.package_name OR
              previous_event.installation_id <> event.installation_id OR
              previous_event.lock_digest <> event.lock_digest OR
              previous_event.install_record_digest <>
                event.install_record_digest OR
              previous_event.expected_version + 1 <>
                event.expected_version OR
              CASE previous_event.action
                WHEN 'disable' THEN 'disabled'
                WHEN 'enable' THEN 'active'
                WHEN 'uninstall' THEN 'uninstalled'
              END <> event.expected_disposition
            )
          )
          OR receipt.task_count <> (
            SELECT COUNT(*)
            FROM "QingLong3PluginPackageLifecycleTasks" AS task
            WHERE task.event_digest = event.event_digest
          )
          OR receipt.task_count <>
            json_array_length(
              json_extract(event.event_json, '$.impact.taskIds')
            )
          OR EXISTS (
            SELECT 1
            FROM json_each(
              event.event_json, '$.impact.taskIds'
            ) AS impact_task
            WHERE typeof(impact_task.value) <> 'text'
               OR NOT EXISTS (
                 SELECT 1
                 FROM "QingLong3PluginPackageLifecycleTasks" AS task
                 WHERE task.event_digest = event.event_digest
                   AND task.task_id = impact_task.value
               )
          )
          OR EXISTS (
            SELECT 1
            FROM "QingLong3PluginPackageLifecycleTasks" AS task
            JOIN "QingLong3TaskDefinitionRevisions" AS previous_revision
              ON previous_revision.project_id = task.project_id
             AND previous_revision.task_id = task.task_id
             AND previous_revision.revision = task.previous_revision
            JOIN "QingLong3TaskDefinitionRevisions" AS current_revision
              ON current_revision.project_id = task.project_id
             AND current_revision.task_id = task.task_id
             AND current_revision.revision = task.current_revision
            WHERE task.event_digest = event.event_digest
              AND (
                task.project_id <> event.project_id OR
                task.previous_content_digest <>
                  previous_revision.content_digest OR
                task.current_content_digest <>
                  current_revision.content_digest OR
                task.previous_enabled <> previous_revision.enabled OR
                task.current_enabled <> current_revision.enabled OR
                (
                  event.action = 'disable' AND
                  (
                    task.previous_enabled <> 1 OR
                    task.current_enabled <> 0
                  )
                ) OR
                (
                  event.action = 'enable' AND
                  (
                    task.previous_enabled <> 0 OR
                    task.current_enabled <> 1
                  )
                ) OR
                event.action = 'uninstall'
              )
          )
          OR (
            event.action = 'uninstall' AND (
              receipt.task_count <> 0 OR
              json_array_length(
                json_extract(
                  event.event_json, '$.impact.blockingReferences'
                )
              ) <> 0
            )
          )
       LIMIT 1`,
    )
    .get();
  if (invalidEvent) {
    throw new LocalSqliteReadinessError(
      'Plugin Package lifecycle event evidence is inconsistent',
    );
  }

  const invalidHead = client
    .prepare(
      `SELECT 1
       FROM "QingLong3PluginPackageLifecycleHeads" AS head
       LEFT JOIN "QingLong3PluginPackageLifecycleEvents" AS event
         ON event.event_digest = head.event_digest
       LEFT JOIN "QingLong3PluginPackageLifecycleReceipts" AS receipt
         ON receipt.event_digest = head.event_digest
       WHERE event.event_digest IS NULL
          OR receipt.event_digest IS NULL
          OR head.project_id <> event.project_id
          OR head.package_name <> event.package_name
          OR head.installation_id <> event.installation_id
          OR head.lock_digest <> event.lock_digest
          OR head.install_record_digest <> event.install_record_digest
          OR head.version <> event.expected_version + 1
          OR head.disposition <> CASE event.action
            WHEN 'disable' THEN 'disabled'
            WHEN 'enable' THEN 'active'
            WHEN 'uninstall' THEN 'uninstalled'
          END
          OR head.updated_at_ms <> receipt.committed_at_ms
          OR json_extract(
            receipt.receipt_json, '$.target.packageName'
          ) <> head.package_name
          OR json_extract(
            receipt.receipt_json, '$.target.installationId'
          ) <> head.installation_id
          OR json_extract(
            receipt.receipt_json, '$.target.lockDigest'
          ) <> head.lock_digest
          OR json_extract(
            receipt.receipt_json, '$.target.installVersion'
          ) <> event.install_version
          OR json_extract(
            receipt.receipt_json, '$.target.installRecordDigest'
          ) <> head.install_record_digest
          OR json_extract(
            receipt.receipt_json, '$.lifecycle.projectId'
          ) <> head.project_id
          OR json_extract(
            receipt.receipt_json, '$.lifecycle.packageName'
          ) <> head.package_name
          OR json_extract(
            receipt.receipt_json, '$.lifecycle.installationId'
          ) <> head.installation_id
          OR json_extract(
            receipt.receipt_json, '$.lifecycle.lockDigest'
          ) <> head.lock_digest
          OR json_extract(
            receipt.receipt_json, '$.lifecycle.installRecordDigest'
          ) <> head.install_record_digest
          OR json_extract(
            receipt.receipt_json, '$.lifecycle.version'
          ) <> head.version
          OR json_extract(
            receipt.receipt_json, '$.lifecycle.disposition'
          ) <> head.disposition
          OR json_extract(
            receipt.receipt_json, '$.lifecycle.eventDigest'
          ) <> head.event_digest
          OR json_extract(
            receipt.receipt_json, '$.lifecycle.updatedAtMs'
          ) <> head.updated_at_ms
          OR EXISTS (
            SELECT 1
            FROM "QingLong3PluginPackageLifecycleEvents" AS later
            WHERE later.project_id = head.project_id
              AND later.package_name = head.package_name
              AND later.installation_id = head.installation_id
              AND later.lock_digest = head.lock_digest
              AND later.expected_version >= head.version
          )
       LIMIT 1`,
    )
    .get();
  if (invalidHead) {
    throw new LocalSqliteReadinessError(
      'Plugin Package lifecycle head evidence is inconsistent',
    );
  }

  const invalidCapability = client
    .prepare(
      `SELECT 1
       FROM "QingLong3PluginPackageLifecycleReceipts" AS receipt
       JOIN "QingLong3PluginPackageLifecycleEvents" AS event
         ON event.event_digest = receipt.event_digest
       WHERE receipt.retained_source_count <> (
            SELECT COUNT(*)
            FROM "QingLong3ProjectToolDefinitionSnapshotSources" AS source
            WHERE source.project_id = receipt.project_id
              AND source.active_vector_digest =
                receipt.current_active_vector_digest
          )
          OR NOT EXISTS (
            SELECT 1
            FROM "QingLong3ProjectToolDefinitionSnapshots" AS previous_snapshot
            WHERE previous_snapshot.project_id = receipt.project_id
              AND previous_snapshot.active_vector_digest =
                receipt.previous_active_vector_digest
          )
          OR (
            event.action IN ('disable','uninstall') AND EXISTS (
              SELECT 1
              FROM "QingLong3ProjectToolDefinitionSnapshotSources" AS source
              WHERE source.project_id = receipt.project_id
                AND source.active_vector_digest =
                  receipt.current_active_vector_digest
                AND source.package_name = event.package_name
                AND source.installation_id = event.installation_id
                AND source.lock_digest = event.lock_digest
            )
          )
          OR (
            event.action = 'enable' AND NOT EXISTS (
              SELECT 1
              FROM "QingLong3ProjectToolDefinitionSnapshotSources" AS source
              WHERE source.project_id = receipt.project_id
                AND source.active_vector_digest =
                  receipt.current_active_vector_digest
                AND source.package_name = event.package_name
                AND source.installation_id = event.installation_id
                AND source.generation_digest = event.generation_digest
                AND source.lock_digest = event.lock_digest
                AND source.revision_digest =
                  event.materialized_revision_digest
            )
          )
       LIMIT 1`,
    )
    .get();
  if (invalidCapability) {
    throw new LocalSqliteReadinessError(
      'Plugin Package lifecycle capability evidence is inconsistent',
    );
  }
}

function assertPluginPackageAutomationPublicationIntegrity(
  client: DatabaseSync,
): void {
  const invalid = client
    .prepare(
      `SELECT 1
       FROM "QingLong3PluginPackageAutomationPublications" AS publication
       LEFT JOIN "QingLong3PluginPackageMaterializedRevisions" AS materialized
         ON materialized.generation_digest = publication.generation_digest
       LEFT JOIN "QingLong3PluginPackageAutomationPublications" AS previous
         ON previous.publication_digest =
           publication.previous_publication_digest
       LEFT JOIN "QingLong3PluginPackageAutomationDispositionEvents"
         AS disposition
         ON disposition.event_digest = publication.lifecycle_event_digest
       LEFT JOIN "QingLong3PluginPackageLifecycleEvents" AS lifecycle
         ON lifecycle.event_digest = publication.lifecycle_event_digest
        AND disposition.event_kind = 'lifecycle'
       LEFT JOIN "QingLong3PluginPackageQuarantineEvents" AS quarantine
         ON quarantine.event_digest = publication.lifecycle_event_digest
        AND disposition.event_kind = 'quarantine'
       WHERE materialized.generation_digest IS NULL
          OR materialized.project_id <> publication.project_id
          OR materialized.package_name <> publication.package_name
          OR materialized.generation <> publication.generation
          OR materialized.lock_digest <> publication.lock_digest
          OR materialized.revision_digest <>
            publication.materialized_revision_digest
          OR (
            publication.version > 1 AND (
              previous.publication_digest IS NULL OR
              previous.project_id <> publication.project_id OR
              previous.package_name <> publication.package_name OR
              previous.version + 1 <> publication.version OR
              previous.published_at_ms > publication.published_at_ms
            )
          )
          OR (
            publication.lifecycle_event_digest IS NULL AND
            publication.version > 1 AND (
              publication.state NOT IN ('active', 'absent') OR
              previous.generation >= publication.generation OR
              previous.installation_id = publication.installation_id OR
              previous.lock_digest = publication.lock_digest OR
              previous.generation_digest = publication.generation_digest OR
              previous.materialized_revision_digest =
                publication.materialized_revision_digest
            )
          )
          OR (
            publication.lifecycle_event_digest IS NOT NULL AND (
              disposition.event_digest IS NULL OR
              disposition.event_kind = 'lifecycle' AND (
                lifecycle.event_digest IS NULL OR
                lifecycle.project_id <> publication.project_id OR
                lifecycle.package_name <> publication.package_name OR
                lifecycle.installation_id <> publication.installation_id OR
                lifecycle.lock_digest <> publication.lock_digest OR
                lifecycle.generation_digest <> publication.generation_digest OR
                lifecycle.materialized_revision_digest <>
                  publication.materialized_revision_digest
              ) OR
              disposition.event_kind = 'quarantine' AND (
                quarantine.event_digest IS NULL OR
                quarantine.project_id <> publication.project_id OR
                quarantine.package_name <> publication.package_name OR
                quarantine.installation_id <> publication.installation_id OR
                quarantine.lock_digest <> publication.lock_digest OR
                publication.state <> 'withdrawn'
              ) OR
              previous.installation_id <> publication.installation_id OR
              previous.lock_digest <> publication.lock_digest OR
              previous.generation_digest <> publication.generation_digest OR
              previous.materialized_revision_digest <>
                publication.materialized_revision_digest OR
              json_extract(
                previous.publication_json, '$.definitions'
              ) <> json_extract(
                publication.publication_json, '$.definitions'
              ) OR
              NOT (
                previous.state = 'active' AND
                  publication.state = 'withdrawn' OR
                previous.state = 'withdrawn' AND
                  publication.state = 'active'
              )
            )
          )
       LIMIT 1`,
    )
    .get();
  const invalidHead = client
    .prepare(
      `SELECT 1
       FROM "QingLong3PluginPackageAutomationPublicationHeads" AS head
       LEFT JOIN "QingLong3PluginPackageAutomationPublications" AS publication
         ON publication.publication_digest = head.publication_digest
       WHERE publication.publication_digest IS NULL
          OR publication.project_id <> head.project_id
          OR publication.package_name <> head.package_name
          OR publication.generation_digest <> head.generation_digest
          OR publication.state <> head.state
          OR publication.version <> head.version
          OR publication.published_at_ms <> head.updated_at_ms
       LIMIT 1`,
    )
    .get();
  if (invalid || invalidHead) {
    throw new LocalSqliteReadinessError(
      'Plugin Package automation publication evidence is inconsistent',
    );
  }
}

function assertPluginPackageWorkflowAdmissionIntegrity(
  client: DatabaseSync,
): void {
  const invalidAdmission = client
    .prepare(
      `SELECT 1
       FROM "QingLong3PluginPackageWorkflowAdmissions" AS admission
       LEFT JOIN "Runs" AS run ON run.id = admission.run_id
       LEFT JOIN "QingLong3PluginPackageAutomationPublications" AS publication
         ON publication.publication_digest = admission.publication_digest
       LEFT JOIN "RunEvents" AS admitted_event
         ON admitted_event.run_id = admission.run_id
        AND admitted_event.sequence = 1
       WHERE run.id IS NULL
          OR publication.publication_digest IS NULL
          OR publication.project_id <> admission.project_id
          OR publication.package_name <> admission.package_name
          OR publication.installation_id <> admission.installation_id
          OR publication.lock_digest <> admission.lock_digest
          OR publication.generation <> admission.generation
          OR publication.generation_digest <> admission.generation_digest
          OR publication.materialized_revision_digest <>
            admission.materialized_revision_digest
          OR run.project_id <> admission.project_id
          OR run.task_id <> admission.workflow_id
          OR run.task_revision <> admission.publication_digest
          OR run.task_snapshot_ref <>
            'plugin-package:' || admission.publication_digest ||
              ':workflow:' || admission.workflow_id
          OR run.trigger_type <> 'plugin_package_workflow'
          OR run.execution_origin <> 'system'
          OR run.execution_owner <> 'runtime'
          OR run.request_id <> admission.plan_id
          OR run.status NOT IN (
            'running', 'succeeded', 'failed', 'cancelled', 'timed_out'
          )
          OR run.version < admission.final_run_version
          OR run.event_sequence <> run.version
          OR run.priority <> 0
          OR run.idempotency_key <>
            'plugin-package-workflow:' || admission.plan_id
          OR run.created_at_ms <> admission.admitted_at_ms
          OR run.started_at_ms <> admission.admitted_at_ms
          OR admitted_event.id IS NULL
          OR admitted_event.type <> 'workflow.admitted'
          OR admitted_event.actor_type <> 'system'
          OR admitted_event.step_run_id IS NOT NULL
          OR admitted_event.created_at_ms <> admission.admitted_at_ms
          OR json_extract(admitted_event.payload, '$.planId') <>
            admission.plan_id
          OR json_extract(admitted_event.payload, '$.planDigest') <>
            admission.plan_digest
          OR json_extract(admitted_event.payload, '$.publicationDigest') <>
            admission.publication_digest
          OR json_extract(admitted_event.payload, '$.workflowId') <>
            admission.workflow_id
          OR json_extract(
            admitted_event.payload, '$.workflowDefinitionDigest'
          ) <> admission.workflow_definition_digest
          OR json_extract(admitted_event.payload, '$.stepCount') <>
            admission.step_count
          OR (
            SELECT COUNT(*)
            FROM "QingLong3PluginPackageWorkflowAdmissionSteps" AS step
            WHERE step.plan_digest = admission.plan_digest
          ) <> admission.step_count
          OR (
            SELECT COUNT(*) FROM "StepRuns" AS step_run
            WHERE step_run.run_id = admission.run_id
          ) <> admission.step_count
          OR (
            SELECT COUNT(*) FROM "RunEvents" AS event
            WHERE event.run_id = admission.run_id
          ) < admission.step_count + 1
          OR (
            SELECT COUNT(*) FROM "StepRunMutations" AS mutation
            WHERE mutation.run_id = admission.run_id
          ) < admission.step_count
       LIMIT 1`,
    )
    .get();
  const invalidStep = client
    .prepare(
      `SELECT 1
       FROM "QingLong3PluginPackageWorkflowAdmissionSteps" AS step
       JOIN "QingLong3PluginPackageWorkflowAdmissions" AS admission
         ON admission.plan_digest = step.plan_digest
        AND admission.run_id = step.run_id
       LEFT JOIN "StepRuns" AS step_run
         ON step_run.run_id = step.run_id
        AND step_run.id = step.step_run_id
       LEFT JOIN "StepRunMutations" AS mutation
         ON mutation.mutation_id = step.mutation_id
       LEFT JOIN "RunEvents" AS event ON event.id = step.event_id
       WHERE step_run.id IS NULL
          OR mutation.mutation_id IS NULL
          OR event.id IS NULL
          OR step_run.step_key <> step.step_key
          OR step_run.kind <> 'task'
          OR step_run.definition_ref <> step.task_definition_ref
          OR step_run.definition_digest <> step.task_definition_digest
          OR step_run.required <> 1
          OR mutation.run_id <> step.run_id
          OR mutation.step_run_id <> step.step_run_id
          OR mutation.event_id <> step.event_id
          OR mutation.event_sequence <> event.sequence
          OR mutation.run_version <> event.sequence
          OR json_extract(mutation.step_run_json, '$.status') <>
            step.initial_status
          OR json_extract(mutation.step_run_json, '$.version') <> 1
          OR json_extract(mutation.step_run_json, '$.attemptCount') <> 0
          OR json_extract(mutation.step_run_json, '$.lastMutationId') <>
            step.mutation_id
          OR json_extract(mutation.step_run_json, '$.stepRunDigest') <>
            mutation.step_run_digest
          OR event.run_id <> step.run_id
          OR event.step_run_id <> step.step_run_id
          OR event.type <> 'step.created'
          OR event.actor_type <> 'system'
          OR event.created_at_ms <> admission.admitted_at_ms
          OR NOT EXISTS (
            SELECT 1 FROM json_each(admission.plan_json, '$.steps') AS planned
            WHERE json_extract(planned.value, '$.stepKey') = step.step_key
              AND json_extract(planned.value, '$.stepRunId') =
                step.step_run_id
              AND json_extract(planned.value, '$.taskId') = step.task_id
              AND json_extract(planned.value, '$.taskDefinitionRef') =
                step.task_definition_ref
              AND json_extract(planned.value, '$.taskDefinitionDigest') =
                step.task_definition_digest
              AND json_extract(planned.value, '$.needs') =
                json(step.needs_json)
              AND json_extract(planned.value, '$.initialStatus') =
                step.initial_status
          )
          OR NOT EXISTS (
            SELECT 1
            FROM json_each(admission.receipt_json, '$.steps') AS receipt_step
            WHERE json_extract(receipt_step.value, '$.stepKey') =
                step.step_key
              AND json_extract(receipt_step.value, '$.stepRunId') =
                step.step_run_id
              AND json_extract(receipt_step.value, '$.stepRunDigest') =
                mutation.step_run_digest
              AND json_extract(receipt_step.value, '$.mutationId') =
                step.mutation_id
              AND json_extract(receipt_step.value, '$.eventId') =
                step.event_id
          )
       LIMIT 1`,
    )
    .get();
  if (invalidAdmission || invalidStep) {
    throw new LocalSqliteReadinessError(
      'Plugin Package Workflow admission evidence is inconsistent',
    );
  }
}

function assertPluginPackageWorkflowTaskAttemptAdmissionIntegrity(
  client: DatabaseSync,
): void {
  const invalid = client
    .prepare(
      `SELECT 1
       FROM "QingLong3PluginPackageWorkflowTaskAttemptAdmissions" AS admission
       LEFT JOIN "QingLong3PluginPackageWorkflowAdmissions" AS workflow
         ON workflow.plan_digest = admission.plan_digest
        AND workflow.run_id = admission.run_id
       LEFT JOIN "Runs" AS run ON run.id = admission.run_id
       LEFT JOIN "StepRuns" AS step
         ON step.run_id = admission.run_id
        AND step.id = admission.step_run_id
       LEFT JOIN "RunAttempts" AS attempt
         ON attempt.id = admission.attempt_id
       LEFT JOIN "RunEvents" AS event
         ON event.id = admission.event_id
       LEFT JOIN "QingLong3PluginPackageTaskReconciliations"
         AS reconciliation
         ON reconciliation.generation_digest = admission.generation_digest
        AND reconciliation.receipt_digest =
          admission.task_reconciliation_receipt_digest
       LEFT JOIN "QingLong3PluginPackageTaskReconciliationItems" AS item
         ON item.generation_digest = admission.generation_digest
        AND item.task_id = admission.task_id
       LEFT JOIN "QingLong3LocalTaskExecutionRevisions" AS execution
         ON execution.project_id = admission.project_id
        AND execution.task_id = admission.task_id
        AND execution.task_revision = admission.task_revision
       WHERE workflow.plan_digest IS NULL
          OR run.id IS NULL
          OR step.id IS NULL
          OR attempt.id IS NULL
          OR event.id IS NULL
          OR reconciliation.generation_digest IS NULL
          OR item.task_id IS NULL
          OR execution.task_id IS NULL
          OR workflow.generation_digest <> admission.generation_digest
          OR workflow.project_id <> admission.project_id
          OR admission.task_id <>
            'pkg:' || workflow.package_name || ':' ||
              admission.resource_task_id
          OR item.revision NOT IN (
            CAST(
              substr(
                admission.task_revision,
                length('qltd:v1:') + 1,
                instr(
                  substr(
                    admission.task_revision,
                    length('qltd:v1:') + 1
                  ),
                  ':'
                ) - 1
              ) AS INTEGER
            )
          )
          OR admission.task_revision <>
            'qltd:v1:' || item.revision || ':' || item.content_digest
          OR item.disposition NOT IN ('created', 'retained', 'updated')
          OR item.content_digest <> admission.task_definition_digest
          OR execution.executor_type <> admission.executor_type
          OR execution.content_digest <> admission.execution_digest
          OR attempt.run_id <> admission.run_id
          OR attempt.step_run_id <> admission.step_run_id
          OR attempt.attempt <> admission.attempt_number
          OR attempt.executor_type <> admission.executor_type
          OR attempt.created_at_ms <> admission.admitted_at_ms
          OR event.run_id <> admission.run_id
          OR event.sequence <> admission.run_event_sequence
          OR event.type <> 'workflow.task_attempt_admitted'
          OR event.dedupe_key <> admission.event_id
          OR event.actor_type <> 'system'
          OR event.attempt_id <> admission.attempt_id
          OR event.step_run_id <> admission.step_run_id
          OR event.created_at_ms <> admission.admitted_at_ms
          OR json_extract(event.payload, '$.planDigest') <>
            admission.plan_digest
          OR json_extract(event.payload, '$.stepRunId') <>
            admission.step_run_id
          OR json_extract(event.payload, '$.stepRunVersion') <>
            admission.step_run_version
          OR json_extract(event.payload, '$.resourceTaskId') <>
            admission.resource_task_id
          OR json_extract(event.payload, '$.taskId') <> admission.task_id
          OR json_extract(event.payload, '$.taskRevision') <>
            admission.task_revision
          OR json_extract(event.payload, '$.executorType') <>
            admission.executor_type
          OR json_extract(event.payload, '$.executionDigest') <>
            admission.execution_digest
          OR json_extract(event.payload, '$.attemptNumber') <>
            admission.attempt_number
          OR run.version < admission.run_version
          OR run.event_sequence <> run.version
          OR step.version < admission.step_run_version
          OR NOT EXISTS (
            SELECT 1
            FROM "QingLong3PluginPackageWorkflowAdmissionSteps" AS source
            WHERE source.plan_digest = admission.plan_digest
              AND source.run_id = admission.run_id
              AND source.step_run_id = admission.step_run_id
              AND source.task_id = admission.resource_task_id
          )
          OR NOT EXISTS (
            SELECT 1 FROM "StepRunMutations" AS historical
            WHERE historical.run_id = admission.run_id
              AND historical.step_run_id = admission.step_run_id
              AND historical.step_run_digest = admission.step_run_digest
              AND json_extract(
                historical.step_run_json, '$.version'
              ) = admission.step_run_version
          )
       LIMIT 1`,
    )
    .get();
  if (invalid) {
    throw new LocalSqliteReadinessError(
      'Plugin Package Workflow Task Attempt admission evidence is inconsistent',
    );
  }
}

export async function auditLocalSqliteReadiness(
  client: DatabaseSync,
): Promise<LocalSqliteReadinessEvidence> {
  try {
    const quickCheck = client.prepare('PRAGMA quick_check(1)').get() as
      | Record<string, unknown>
      | undefined;
    if (!quickCheck || Object.values(quickCheck)[0] !== 'ok') {
      throw new LocalSqliteReadinessError('quick_check failed');
    }
    if (
      client.prepare('SELECT * FROM pragma_foreign_key_check LIMIT 1').get()
    ) {
      throw new LocalSqliteReadinessError('foreign_key_check failed');
    }
    const history = await new LocalSqliteMigrationStreamStore(client).listAll();
    auditMigrationStreamHistory(history, localSqliteMigrationManifest);
    if (history.length !== localSqliteMigrationManifest.migrations.length) {
      throw new LocalSqliteReadinessError('migration history is incomplete');
    }
    const capability = client
      .prepare(
        `SELECT contract_name, contract_version, migration_id,
                capabilities, updated_at_ms
         FROM "QingLong3SchemaCapabilities"
         WHERE contract_name = ?`,
      )
      .get(LOCAL_SQLITE_CONTRACT_NAME) as CapabilityRow | undefined;
    if (
      !capability ||
      capability.contract_name !== LOCAL_SQLITE_CONTRACT_NAME ||
      capability.contract_version !== LOCAL_SQLITE_CONTRACT_VERSION ||
      capability.migration_id !==
        '0091-plugin-package-secret-bindings' ||
      typeof capability.capabilities !== 'string' ||
      capability.capabilities !==
        '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1,"local_dispatch_plan":1,"local_secret_envelope":1,"local_project_policy":1,"local_project_administration":1,"local_security_audit":1,"local_security_audit_compaction":1,"local_secret_authorized_mutation":1,"local_identity":1,"local_api_credential":1,"local_identity_provisioning":1,"local_identity_credential_administration":1,"local_owner_bootstrap":1,"local_owner_delivery_acknowledgement":1,"api_credential_pepper_binding":1,"local_owner_pepper_catalog":1,"local_owner_credential_recovery":1,"local_owner_pepper_reference_inspection":1,"local_owner_pepper_material_gc":1,"local_owner_delivery_acknowledgement_gc":1,"task_definition":1,"local_execution_revision_digest":1,"trigger_definition":1,"legacy_adoption_ledger":1,"local_scheduler_admission":1,"plugin_package_install":1,"approved_action":1,"plugin_package_admission":1,"approved_action_execution":1,"plugin_package_proposal":1,"plugin_package_materialized_revision":1,"plugin_package_secret_binding":1,"plugin_package_task_reconciliation":1,"project_tool_definition_snapshot":1,"step_run":1,"tool_execution_evidence":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_failure_completion":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"plugin_package_quarantine":1,"plugin_package_lifecycle":1,"plugin_package_automation_publication":1,"plugin_package_automation_security_withdrawal":1,"plugin_package_workflow_admission":1,"plugin_package_workflow_run_list":1,"run_attempt_log_retention":1,"plugin_package_workflow_task_attempt_admission":1}' ||
      typeof capability.updated_at_ms !== 'number' ||
      !Number.isSafeInteger(capability.updated_at_ms) ||
      capability.updated_at_ms < 0
    ) {
      throw new LocalSqliteReadinessError('schema capability is incompatible');
    }
    assertPluginPackageQuarantineIntegrity(client);
    assertPluginPackageLifecycleIntegrity(client);
    assertPluginPackageAutomationPublicationIntegrity(client);
    assertPluginPackageWorkflowAdmissionIntegrity(client);
    assertPluginPackageWorkflowTaskAttemptAdmissionIntegrity(client);
    const sqliteVersionRow = client
      .prepare('SELECT sqlite_version() AS version')
      .get() as { version?: unknown } | undefined;
    const journalModeRow = client.prepare('PRAGMA journal_mode').get() as
      | { journal_mode?: unknown }
      | undefined;
    return Object.freeze({
      contractName: LOCAL_SQLITE_CONTRACT_NAME,
      contractVersion: LOCAL_SQLITE_CONTRACT_VERSION,
      sqliteVersion: requiredText(sqliteVersionRow?.version, 'SQLite version'),
      migrationIds: Object.freeze(history.map((entry) => entry.migrationId)),
      tableCount: assertRequiredSchema(client),
      journalMode: requiredText(journalModeRow?.journal_mode, 'journal mode'),
    });
  } catch (error) {
    if (error instanceof LocalSqliteReadinessError) throw error;
    throw new LocalSqliteReadinessError('audit failed', error);
  }
}
