import {
  runMigrationStream,
  type MigrationStreamDefinition,
} from '@qinglong/runtime-core/migration-stream';
import type { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
} from '../storage/config';
import { local0001RunCoreMigration } from '../migrations/0001-run-core';
import { local0002CapabilityMigration } from '../migrations/0002-capability';
import { local0003CompletionReceiptJournalMigration } from '../migrations/0003-completion-receipt-journal';
import { local0004CapabilityV2Migration } from '../migrations/0004-capability-v2';
import { local0005LocalDispatchPlanMigration } from '../migrations/0005-local-dispatch-plan';
import { local0006CapabilityV3Migration } from '../migrations/0006-capability-v3';
import { local0007LocalSecretEnvelopesMigration } from '../migrations/0007-local-secret-envelopes';
import { local0008CapabilityV4Migration } from '../migrations/0008-capability-v4';
import { local0009LocalProjectPolicyAuditMigration } from '../migrations/0009-local-project-policy-audit';
import { local0010CapabilityV5Migration } from '../migrations/0010-capability-v5';
import { local0011LocalIdentityCredentialMigration } from '../migrations/0011-local-identity-credential';
import { local0012CapabilityV6Migration } from '../migrations/0012-capability-v6';
import { local0013LocalOwnerBootstrapMigration } from '../migrations/0013-local-owner-bootstrap';
import { local0014CapabilityV7Migration } from '../migrations/0014-capability-v7';
import { local0015LocalOwnerDeliveryAcknowledgementsMigration } from '../migrations/0015-local-owner-delivery-acknowledgements';
import { local0016CapabilityV8Migration } from '../migrations/0016-capability-v8';
import { local0017ApiCredentialPepperBindingsMigration } from '../migrations/0017-api-credential-pepper-bindings';
import { local0018CapabilityV9Migration } from '../migrations/0018-capability-v9';
import { local0019LocalOwnerPepperCatalogMigration } from '../migrations/0019-local-owner-pepper-catalog';
import { local0020CapabilityV10Migration } from '../migrations/0020-capability-v10';
import { local0021LocalOwnerCredentialRecoveryMigration } from '../migrations/0021-local-owner-credential-recovery';
import { local0022CapabilityV11Migration } from '../migrations/0022-capability-v11';
import { local0023LocalOwnerPepperMaterialGcMigration } from '../migrations/0023-local-owner-pepper-material-gc';
import { local0024CapabilityV12Migration } from '../migrations/0024-capability-v12';
import { local0025LocalOwnerDeliveryAcknowledgementGcMigration } from '../migrations/0025-local-owner-delivery-acknowledgement-gc';
import { local0026CapabilityV13Migration } from '../migrations/0026-capability-v13';
import { local0027TaskDefinitionsMigration } from '../migrations/0027-task-definitions';
import { local0028CapabilityV14Migration } from '../migrations/0028-capability-v14';
import { local0029LocalExecutionRevisionDigestMigration } from '../migrations/0029-local-execution-revision-digest';
import { local0030CapabilityV15Migration } from '../migrations/0030-capability-v15';
import { local0031TriggerDefinitionsMigration } from '../migrations/0031-trigger-definitions';
import { local0032CapabilityV16Migration } from '../migrations/0032-capability-v16';
import { local0033LegacyAdoptionLedgerMigration } from '../migrations/0033-legacy-adoption-ledger';
import { local0034CapabilityV17Migration } from '../migrations/0034-capability-v17';
import { local0035LocalSchedulerMigration } from '../migrations/0035-local-scheduler';
import { local0036CapabilityV18Migration } from '../migrations/0036-capability-v18';
import { local0037PluginPackageInstallsMigration } from '../migrations/0037-plugin-package-installs';
import { local0038CapabilityV19Migration } from '../migrations/0038-capability-v19';
import { local0039ApprovedActionsMigration } from '../migrations/0039-approved-actions';
import { local0040CapabilityV20Migration } from '../migrations/0040-capability-v20';
import { local0041PluginPackageAdmissionReceiptsMigration } from '../migrations/0041-plugin-package-admission-receipts';
import { local0042CapabilityV21Migration } from '../migrations/0042-capability-v21';
import { local0043ApprovedActionExecutionsAndPackageProposalsMigration } from '../migrations/0043-approved-action-executions-and-package-proposals';
import { local0044CapabilityV22Migration } from '../migrations/0044-capability-v22';
import { local0045PluginPackageMaterializedRevisionsMigration } from '../migrations/0045-plugin-package-materialized-revisions';
import { local0046CapabilityV23Migration } from '../migrations/0046-capability-v23';
import { local0047PluginPackageTaskReconciliationsMigration } from '../migrations/0047-plugin-package-task-reconciliations';
import { local0048CapabilityV24Migration } from '../migrations/0048-capability-v24';
import { local0049ProjectToolDefinitionSnapshotsMigration } from '../migrations/0049-project-tool-definition-snapshots';
import { local0050CapabilityV25Migration } from '../migrations/0050-capability-v25';
import { local0051StepRunsMigration } from '../migrations/0051-step-runs';
import { local0052CapabilityV26Migration } from '../migrations/0052-capability-v26';
import { local0053ToolExecutionEvidenceMigration } from '../migrations/0053-tool-execution-evidence';
import { local0054CapabilityV27Migration } from '../migrations/0054-capability-v27';
import { local0055ToolExecutionStartBarriersMigration } from '../migrations/0055-tool-execution-start-barriers';
import { local0056CapabilityV28Migration } from '../migrations/0056-capability-v28';
import { local0057ToolInvocationArtifactsMigration } from '../migrations/0057-tool-invocation-artifacts';
import { local0058CapabilityV29Migration } from '../migrations/0058-capability-v29';
import { local0059ToolExecutionArtifactBindingsMigration } from '../migrations/0059-tool-execution-artifact-bindings';
import { local0060CapabilityV30Migration } from '../migrations/0060-capability-v30';
import { local0061ToolExecutionCompletionsMigration } from '../migrations/0061-tool-execution-completions';
import { local0062CapabilityV31Migration } from '../migrations/0062-capability-v31';
import { local0063ToolExecutionFailureCompletionsMigration } from '../migrations/0063-tool-execution-failure-completions';
import { local0064CapabilityV32Migration } from '../migrations/0064-capability-v32';
import { local0065ToolResultKeyCatalogMigration } from '../migrations/0065-tool-result-key-catalog';
import { local0066CapabilityV33Migration } from '../migrations/0066-capability-v33';
import { local0067ToolResultRekeyOverlaysMigration } from '../migrations/0067-tool-result-rekey-overlays';
import { local0068CapabilityV34Migration } from '../migrations/0068-capability-v34';
import { local0069PluginPackageQuarantineMigration } from '../migrations/0069-plugin-package-quarantine';
import { local0070CapabilityV35Migration } from '../migrations/0070-capability-v35';
import { local0071LocalIdentityCredentialAdministrationMigration } from '../migrations/0071-local-identity-credential-administration';
import { local0072CapabilityV36Migration } from '../migrations/0072-capability-v36';
import { local0073LocalProjectAdministrationMigration } from '../migrations/0073-local-project-administration';
import { local0074CapabilityV37Migration } from '../migrations/0074-capability-v37';
import { local0075SecurityAuditCompactionsMigration } from '../migrations/0075-security-audit-compactions';
import { local0076CapabilityV38Migration } from '../migrations/0076-capability-v38';
import { local0077PluginPackageLifecycleMigration } from '../migrations/0077-plugin-package-lifecycle';
import { local0078CapabilityV39Migration } from '../migrations/0078-capability-v39';
import { local0079PluginPackageAutomationPublicationsMigration } from '../migrations/0079-plugin-package-automation-publications';
import { local0080CapabilityV40Migration } from '../migrations/0080-capability-v40';
import { local0081PluginPackageWorkflowAdmissionsMigration } from '../migrations/0081-plugin-package-workflow-admissions';
import { local0082CapabilityV41Migration } from '../migrations/0082-capability-v41';
import { local0083PluginPackageWorkflowTaskAttemptAdmissionsMigration } from '../migrations/0083-plugin-package-workflow-task-attempt-admissions';
import { local0084CapabilityV42Migration } from '../migrations/0084-capability-v42';
import { local0085PluginPackageWorkflowRunListIndexMigration } from '../migrations/0085-plugin-package-workflow-run-list-index';
import { local0086CapabilityV43Migration } from '../migrations/0086-capability-v43';
import { local0087RunAttemptLogRetentionMigration } from '../migrations/0087-run-attempt-log-retention';
import { local0088CapabilityV44Migration } from '../migrations/0088-capability-v44';
import { local0089PluginPackageAutomationDispositionEventsMigration } from '../migrations/0089-plugin-package-automation-disposition-events';
import { local0090CapabilityV45Migration } from '../migrations/0090-capability-v45';
import { local0091PluginPackageSecretBindingsMigration } from '../migrations/0091-plugin-package-secret-bindings';
import { local0092CapabilityV46Migration } from '../migrations/0092-capability-v46';
import { local0093PluginPackageSecretMaterializationGuardMigration } from '../migrations/0093-plugin-package-secret-materialization-guard';
import { local0094CapabilityV47Migration } from '../migrations/0094-capability-v47';
import type { LocalSqliteMigrationContext } from '../migrations/sqlMigration';
import {
  LOCAL_SQLITE_MIGRATION_STREAM_ID,
  LocalSqliteMigrationStreamStore,
} from './migrationStreamStore';
import { localSqliteMigrationManifest } from './migrationManifest';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../readiness/readiness';

export interface LocalSqliteMigrationResult {
  readonly readiness: LocalSqliteReadinessEvidence;
}

export const localSqliteMigrationDefinition: MigrationStreamDefinition<LocalSqliteMigrationContext> =
  Object.freeze({
    id: LOCAL_SQLITE_MIGRATION_STREAM_ID,
    dialect: 'sqlite',
    migrationIdScheme: 'sqlite-numbered',
    checksumScheme: 'sha256',
    migrations: Object.freeze([
      local0001RunCoreMigration,
      local0002CapabilityMigration,
      local0003CompletionReceiptJournalMigration,
      local0004CapabilityV2Migration,
      local0005LocalDispatchPlanMigration,
      local0006CapabilityV3Migration,
      local0007LocalSecretEnvelopesMigration,
      local0008CapabilityV4Migration,
      local0009LocalProjectPolicyAuditMigration,
      local0010CapabilityV5Migration,
      local0011LocalIdentityCredentialMigration,
      local0012CapabilityV6Migration,
      local0013LocalOwnerBootstrapMigration,
      local0014CapabilityV7Migration,
      local0015LocalOwnerDeliveryAcknowledgementsMigration,
      local0016CapabilityV8Migration,
      local0017ApiCredentialPepperBindingsMigration,
      local0018CapabilityV9Migration,
      local0019LocalOwnerPepperCatalogMigration,
      local0020CapabilityV10Migration,
      local0021LocalOwnerCredentialRecoveryMigration,
      local0022CapabilityV11Migration,
      local0023LocalOwnerPepperMaterialGcMigration,
      local0024CapabilityV12Migration,
      local0025LocalOwnerDeliveryAcknowledgementGcMigration,
      local0026CapabilityV13Migration,
      local0027TaskDefinitionsMigration,
      local0028CapabilityV14Migration,
      local0029LocalExecutionRevisionDigestMigration,
      local0030CapabilityV15Migration,
      local0031TriggerDefinitionsMigration,
      local0032CapabilityV16Migration,
      local0033LegacyAdoptionLedgerMigration,
      local0034CapabilityV17Migration,
      local0035LocalSchedulerMigration,
      local0036CapabilityV18Migration,
      local0037PluginPackageInstallsMigration,
      local0038CapabilityV19Migration,
      local0039ApprovedActionsMigration,
      local0040CapabilityV20Migration,
      local0041PluginPackageAdmissionReceiptsMigration,
      local0042CapabilityV21Migration,
      local0043ApprovedActionExecutionsAndPackageProposalsMigration,
      local0044CapabilityV22Migration,
      local0045PluginPackageMaterializedRevisionsMigration,
      local0046CapabilityV23Migration,
      local0047PluginPackageTaskReconciliationsMigration,
      local0048CapabilityV24Migration,
      local0049ProjectToolDefinitionSnapshotsMigration,
      local0050CapabilityV25Migration,
      local0051StepRunsMigration,
      local0052CapabilityV26Migration,
      local0053ToolExecutionEvidenceMigration,
      local0054CapabilityV27Migration,
      local0055ToolExecutionStartBarriersMigration,
      local0056CapabilityV28Migration,
      local0057ToolInvocationArtifactsMigration,
      local0058CapabilityV29Migration,
      local0059ToolExecutionArtifactBindingsMigration,
      local0060CapabilityV30Migration,
      local0061ToolExecutionCompletionsMigration,
      local0062CapabilityV31Migration,
      local0063ToolExecutionFailureCompletionsMigration,
      local0064CapabilityV32Migration,
      local0065ToolResultKeyCatalogMigration,
      local0066CapabilityV33Migration,
      local0067ToolResultRekeyOverlaysMigration,
      local0068CapabilityV34Migration,
      local0069PluginPackageQuarantineMigration,
      local0070CapabilityV35Migration,
      local0071LocalIdentityCredentialAdministrationMigration,
      local0072CapabilityV36Migration,
      local0073LocalProjectAdministrationMigration,
      local0074CapabilityV37Migration,
      local0075SecurityAuditCompactionsMigration,
      local0076CapabilityV38Migration,
      local0077PluginPackageLifecycleMigration,
      local0078CapabilityV39Migration,
      local0079PluginPackageAutomationPublicationsMigration,
      local0080CapabilityV40Migration,
      local0081PluginPackageWorkflowAdmissionsMigration,
      local0082CapabilityV41Migration,
      local0083PluginPackageWorkflowTaskAttemptAdmissionsMigration,
      local0084CapabilityV42Migration,
      local0085PluginPackageWorkflowRunListIndexMigration,
      local0086CapabilityV43Migration,
      local0087RunAttemptLogRetentionMigration,
      local0088CapabilityV44Migration,
      local0089PluginPackageAutomationDispositionEventsMigration,
      local0090CapabilityV45Migration,
      local0091PluginPackageSecretBindingsMigration,
      local0092CapabilityV46Migration,
      local0093PluginPackageSecretMaterializationGuardMigration,
      local0094CapabilityV47Migration,
    ]),
  });

function assertReviewedManifestMatchesDefinition(): void {
  const generated = localSqliteMigrationDefinition.migrations.map(
    ({ id, checksum }) => ({ id, checksum }),
  );
  if (
    localSqliteMigrationManifest.id !== localSqliteMigrationDefinition.id ||
    localSqliteMigrationManifest.dialect !==
      localSqliteMigrationDefinition.dialect ||
    JSON.stringify(localSqliteMigrationManifest.migrations) !==
      JSON.stringify(generated)
  ) {
    throw new Error(
      'Local SQLite executable migrations do not match the reviewed runtime manifest',
    );
  }
}

assertReviewedManifestMatchesDefinition();

export async function migrateLocalSqliteDatabase(
  client: DatabaseSync,
): Promise<void> {
  await runMigrationStream({
    stream: localSqliteMigrationDefinition,
    store: new LocalSqliteMigrationStreamStore(client),
  });
}

export { localSqliteMigrationManifest };

/** Short-lived migration authority; long-lived Profile hosts must not import it. */
export async function migrateLocalSqlitePath(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteMigrationResult> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, true);
  const client = openLocalSqliteClient(options, false);
  try {
    await migrateLocalSqliteDatabase(client);
    fs.chmodSync(options.databasePath, 0o600);
    return Object.freeze({
      readiness: await auditLocalSqliteReadiness(client),
    });
  } finally {
    client.close();
  }
}
