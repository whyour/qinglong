import {
  POSTGRESQL_MAIN_MIGRATION_STREAM_ID,
  type PostgresMigrationContext,
} from './postgresMigrationStreamStore';
import type { MigrationStreamDefinition } from '@qinglong/runtime-core';
import { pg0001SchemaCapabilityMigration } from './pg-0001-schema-capability';
import { pg0002RunCoreMigration } from './pg-0002-run-core';
import { pg0003RunRetryPolicyMigration } from './pg-0003-run-retry-policy';
import { pg0004ProjectPolicyMigration } from './pg-0004-project-policy';
import { pg0005ApiCredentialSecurityAuditMigration } from './pg-0005-api-credential-security-audit';
import { pg0006IdentityCredentialAdministrationMigration } from './pg-0006-identity-credential-administration';
import { pg0007ClusterRecoveryIndexesMigration } from './pg-0007-cluster-recovery-indexes';
import { pg0008RunRecoveryClaimsMigration } from './pg-0008-run-recovery-claims';
import { pg0009WorkerSessionRunLeaseMigration } from './pg-0009-worker-session-run-lease';
import { pg0010WorkerIngressAttestationMigration } from './pg-0010-worker-ingress-attestation';
import { pg0011ApiCredentialPepperBindingMigration } from './pg-0011-api-credential-pepper-binding';
import { pg0012TaskTriggerDefinitionsMigration } from './pg-0012-task-trigger-definitions';
import { pg0013TaskExecutionRevisionsMigration } from './pg-0013-task-execution-revisions';
import { pg0014ClusterSchedulerAdmissionMigration } from './pg-0014-cluster-scheduler-admission';
import { pg0015WorkerCredentialDeliveryLedgerMigration } from './pg-0015-worker-credential-delivery-ledger';
import { pg0016WorkerCredentialStageDiscardLedgerMigration } from './pg-0016-worker-credential-stage-discard-ledger';
import { pg0017DatabaseRoleGrantsMigration } from './pg-0017-database-role-grants';
import { pg0018PluginPackageInstallsMigration } from './pg-0018-plugin-package-installs';
import { pg0019ApprovedActionsMigration } from './pg-0019-approved-actions';
import { pg0020PluginPackageAdmissionReceiptsMigration } from './pg-0020-plugin-package-admission-receipts';
import { pg0021ApprovedActionExecutionsAndPackageProposalsMigration } from './pg-0021-approved-action-executions-and-package-proposals';
import { pg0022PluginPackageAuthoritySplitMigration } from './pg-0022-plugin-package-authority-split';
import { pg0023PluginPackageManagementQuotaMigration } from './pg-0023-plugin-package-management-quota';
import { pg0024PluginPackageIdentityKeysetLedgerMigration } from './pg-0024-plugin-package-identity-keyset-ledger';
import { pg0025PluginPackageMaterializedRevisionsMigration } from './pg-0025-plugin-package-materialized-revisions';
import { pg0026PluginPackageTaskReconciliationsMigration } from './pg-0026-plugin-package-task-reconciliations';
import { pg0027ProjectToolDefinitionSnapshotsMigration } from './pg-0027-project-tool-definition-snapshots';
import { pg0028StepRunsMigration } from './pg-0028-step-runs';
import { pg0029ToolExecutionEvidenceMigration } from './pg-0029-tool-execution-evidence';
import { pg0030ToolExecutionStartBarriersMigration } from './pg-0030-tool-execution-start-barriers';
import { pg0031ToolInvocationArtifactsMigration } from './pg-0031-tool-invocation-artifacts';
import { pg0032ToolExecutionArtifactBindingsMigration } from './pg-0032-tool-execution-artifact-bindings';
import { pg0033ToolExecutionCompletionsMigration } from './pg-0033-tool-execution-completions';
import { pg0034ToolExecutionFailureCompletionsMigration } from './pg-0034-tool-execution-failure-completions';
import { pg0035ToolResultKeyCatalogMigration } from './pg-0035-tool-result-key-catalog';
import { pg0036ToolResultRekeyOverlaysMigration } from './pg-0036-tool-result-rekey-overlays';
import { pg0037PluginPackageQuarantineMigration } from './pg-0037-plugin-package-quarantine';
import { pg0038PluginPackagePublisherProvenanceMigration } from './pg-0038-plugin-package-publisher-provenance';
import { pg0039PluginPackagePublisherTrustAuthorityMigration } from './pg-0039-plugin-package-publisher-trust-authority';
import { pg0040PluginPackagePublisherTrustTransitionsMigration } from './pg-0040-plugin-package-publisher-trust-transitions';
import { pg0041PluginPackageLifecycleMigration } from './pg-0041-plugin-package-lifecycle';
import { pg0042PluginPackageLifecyclePlansMigration } from './pg-0042-plugin-package-lifecycle-plans';
import { pg0043PluginPackageAutomationPublicationsMigration } from './pg-0043-plugin-package-automation-publications';
import { pg0044PluginPackageAutomationStartGuardMigration } from './pg-0044-plugin-package-automation-start-guard';
import { pg0045PluginPackageWorkflowAdmissionsMigration } from './pg-0045-plugin-package-workflow-admissions';
import { pg0046PluginPackageWorkflowTaskAttemptAdmissionsMigration } from './pg-0046-plugin-package-workflow-task-attempt-admissions';
import { pg0047WorkerCredentialManagementPlansMigration } from './pg-0047-worker-credential-management-plans';
import { pg0048WorkerCredentialPreapprovedActivationMigration } from './pg-0048-worker-credential-preapproved-activation';
import { pg0049WorkerCredentialExecutionReceiptsMigration } from './pg-0049-worker-credential-execution-receipts';
import { pg0050WorkerCredentialManagementBoundaryMigration } from './pg-0050-worker-credential-management-boundary';
import { pg0051AutomationManagementBoundaryMigration } from './pg-0051-automation-management-boundary';
import { pg0052AutomationManagementIdentityKeysetLedgerMigration } from './pg-0052-automation-management-identity-keyset-ledger';
import { pg0053PluginPackageWorkflowRunListIndexMigration } from './pg-0053-plugin-package-workflow-run-list-index';
import { pg0054ApprovalManagementBoundaryMigration } from './pg-0054-approval-management-boundary';
import { pg0055RunAttemptLogRetentionMigration } from './pg-0055-run-attempt-log-retention';
import { pg0056RunManagementBoundaryMigration } from '../run-management/pg-0056-run-management-boundary';
import { pg0057RunManagementStopBoundaryMigration } from '../run-management/pg-0057-run-management-stop-boundary';
import { pg0058PluginPackageAutomationDispositionEventsMigration } from './pg-0058-plugin-package-automation-disposition-events';
import { pg0059PluginPackageSecretBindingsMigration } from './pg-0059-plugin-package-secret-bindings';
import { pg0060PluginPackageSecretMaterializationGuardMigration } from './pg-0060-plugin-package-secret-materialization-guard';
import { pg0061PluginPackageSecretBindingApprovalPlansMigration } from './pg-0061-plugin-package-secret-binding-approval-plans';
import { pg0062PluginPackageSecretBindingTargetGuardMigration } from './pg-0062-plugin-package-secret-binding-target-guard';
import { pg0063PluginPackageSecretBindingTransitionReceiptsMigration } from './pg-0063-plugin-package-secret-binding-transition-receipts';
import { pg0064PluginPackageSecretBindingTransitionApprovalPlansMigration } from './pg-0064-plugin-package-secret-binding-transition-approval-plans';

export const postgresqlMainMigrationStream: MigrationStreamDefinition<PostgresMigrationContext> =
  Object.freeze({
    id: POSTGRESQL_MAIN_MIGRATION_STREAM_ID,
    dialect: 'postgresql',
    migrationIdScheme: 'postgres-prefixed',
    checksumScheme: 'sha256',
    migrations: Object.freeze([
      pg0001SchemaCapabilityMigration,
      pg0002RunCoreMigration,
      pg0003RunRetryPolicyMigration,
      pg0004ProjectPolicyMigration,
      pg0005ApiCredentialSecurityAuditMigration,
      pg0006IdentityCredentialAdministrationMigration,
      pg0007ClusterRecoveryIndexesMigration,
      pg0008RunRecoveryClaimsMigration,
      pg0009WorkerSessionRunLeaseMigration,
      pg0010WorkerIngressAttestationMigration,
      pg0011ApiCredentialPepperBindingMigration,
      pg0012TaskTriggerDefinitionsMigration,
      pg0013TaskExecutionRevisionsMigration,
      pg0014ClusterSchedulerAdmissionMigration,
      pg0015WorkerCredentialDeliveryLedgerMigration,
      pg0016WorkerCredentialStageDiscardLedgerMigration,
      pg0017DatabaseRoleGrantsMigration,
      pg0018PluginPackageInstallsMigration,
      pg0019ApprovedActionsMigration,
      pg0020PluginPackageAdmissionReceiptsMigration,
      pg0021ApprovedActionExecutionsAndPackageProposalsMigration,
      pg0022PluginPackageAuthoritySplitMigration,
      pg0023PluginPackageManagementQuotaMigration,
      pg0024PluginPackageIdentityKeysetLedgerMigration,
      pg0025PluginPackageMaterializedRevisionsMigration,
      pg0026PluginPackageTaskReconciliationsMigration,
      pg0027ProjectToolDefinitionSnapshotsMigration,
      pg0028StepRunsMigration,
      pg0029ToolExecutionEvidenceMigration,
      pg0030ToolExecutionStartBarriersMigration,
      pg0031ToolInvocationArtifactsMigration,
      pg0032ToolExecutionArtifactBindingsMigration,
      pg0033ToolExecutionCompletionsMigration,
      pg0034ToolExecutionFailureCompletionsMigration,
      pg0035ToolResultKeyCatalogMigration,
      pg0036ToolResultRekeyOverlaysMigration,
      pg0037PluginPackageQuarantineMigration,
      pg0038PluginPackagePublisherProvenanceMigration,
      pg0039PluginPackagePublisherTrustAuthorityMigration,
      pg0040PluginPackagePublisherTrustTransitionsMigration,
      pg0041PluginPackageLifecycleMigration,
      pg0042PluginPackageLifecyclePlansMigration,
      pg0043PluginPackageAutomationPublicationsMigration,
      pg0044PluginPackageAutomationStartGuardMigration,
      pg0045PluginPackageWorkflowAdmissionsMigration,
      pg0046PluginPackageWorkflowTaskAttemptAdmissionsMigration,
      pg0047WorkerCredentialManagementPlansMigration,
      pg0048WorkerCredentialPreapprovedActivationMigration,
      pg0049WorkerCredentialExecutionReceiptsMigration,
      pg0050WorkerCredentialManagementBoundaryMigration,
      pg0051AutomationManagementBoundaryMigration,
      pg0052AutomationManagementIdentityKeysetLedgerMigration,
      pg0053PluginPackageWorkflowRunListIndexMigration,
      pg0054ApprovalManagementBoundaryMigration,
      pg0055RunAttemptLogRetentionMigration,
      pg0056RunManagementBoundaryMigration,
      pg0057RunManagementStopBoundaryMigration,
      pg0058PluginPackageAutomationDispositionEventsMigration,
      pg0059PluginPackageSecretBindingsMigration,
      pg0060PluginPackageSecretMaterializationGuardMigration,
      pg0061PluginPackageSecretBindingApprovalPlansMigration,
      pg0062PluginPackageSecretBindingTargetGuardMigration,
      pg0063PluginPackageSecretBindingTransitionReceiptsMigration,
      pg0064PluginPackageSecretBindingTransitionApprovalPlansMigration,
    ]),
  });
