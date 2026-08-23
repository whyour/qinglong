// Deployment composition lives with its concrete deployment capabilities.
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import {
  currentIdentity,
  normalizeLocalDeploymentPrepareCommand,
  type LocalDeploymentPrepareResult,
} from './foundation/contract';
import {
  initialComposeImageSelection,
  preflightActiveComposeImageSelection,
  switchLocalDeploymentComposeRevision,
  switchLocalDeploymentComposeRevisionCommandFile,
} from './compose/composeRevision';
import {
  preflightLocalDeploymentCompose,
  preflightLocalDeploymentComposeCommandFile,
} from './compose/composePreflight';
import {
  applyLocalDeploymentCompose,
  applyLocalDeploymentComposeCommandFile,
} from './compose/composeApply';
import {
  restoreLocalDeploymentCompose,
  restoreLocalDeploymentComposeCommitCommandFile,
  restoreLocalDeploymentComposeCommandFile,
  restoreLocalDeploymentComposePrepareCommandFile,
} from './compose/composeRestore';
import {
  collectLocalDeploymentComposeEvidence,
  collectLocalDeploymentComposeEvidenceCommitCommandFile,
  collectLocalDeploymentComposeEvidencePrepareCommandFile,
} from './compose/composeEvidenceCollection';
import {
  ensurePrivateDirectory,
  preflightPublishedFile,
  publishExactFile,
} from './foundation/files';
import {
  applicationConfiguration,
  deploymentPaths,
  descriptor,
  setupCommand,
} from './foundation/render';
import { executeLocalSetup } from '../lifecycle/localSetup';
import {
  inspectLocalDeploymentStatus,
  inspectLocalDeploymentStatusCommandFile,
} from './localDeploymentStatus';
import {
  stopLegacyDockerForLocalDeployment,
  stopLegacyDockerForLocalDeploymentCommandFile,
} from './cutover/legacyStop';
import {
  runLocalDeploymentDockerTarget,
  runLocalDeploymentDockerTargetCommandFile,
} from './cutover/target-run/targetRun';
import {
  runLocalDeploymentCutoverManualCommand,
  runLocalDeploymentCutoverManualCommandFile,
} from './cutover/manual-resolution/manualResolution';
import {
  stopLocalDeploymentDockerTarget,
  stopLocalDeploymentDockerTargetCommandFile,
} from './cutover/targetStop';
import {
  runLocalDeploymentLegacyRollback,
  runLocalDeploymentLegacyRollbackCommandFile,
} from './cutover/legacyRollback';
import {
  proveLocalDeploymentLegacyReadiness,
  proveLocalDeploymentLegacyReadinessCommandFile,
} from './cutover/legacy-readiness/probe';
import {
  consumeLocalServiceManagerOutcome,
  consumeLocalServiceManagerOutcomeCommandFile,
  prepareLocalServiceManagerIntent,
  prepareLocalServiceManagerIntentCommandFile,
} from './service-manager/serviceManagerIntent';
import {
  consumeLocalServiceManagerCutoverOutcome,
  consumeLocalServiceManagerCutoverOutcomeCommandFile,
} from './service-manager/serviceCutoverConsumer';
import {
  prepareLocalServiceManagerLegacyRollback,
  prepareLocalServiceManagerLegacyRollbackCommandFile,
} from './service-manager/legacy-rollback/preparation';
import {
  authorizeLocalServiceManagerLegacyRollback,
  authorizeLocalServiceManagerLegacyRollbackCommandFile,
  consumeLocalServiceManagerLegacyRollback,
  consumeLocalServiceManagerLegacyRollbackCommandFile,
} from './service-manager/legacy-rollback/consumer';
import {
  prepareLocalReconciliationCapture,
  prepareLocalReconciliationCaptureCommandFile,
} from './reconciliation/preparation';
import {
  commitLocalReconciliationCapture,
  commitLocalReconciliationCaptureCommandFile,
  verifyLocalReconciliationCapture,
  verifyLocalReconciliationCaptureCommandFile,
} from './reconciliation/bundle';
import {
  commitLocalReconciliationPlan,
  commitLocalReconciliationPlanCommandFile,
  prepareLocalReconciliationPlan,
  prepareLocalReconciliationPlanCommandFile,
  verifyLocalReconciliationPlan,
  verifyLocalReconciliationPlanCommandFile,
} from './reconciliation/planning/preparation';
import {
  prepareLocalReconciliationReview,
  prepareLocalReconciliationReviewCommandFile,
  writeLocalReconciliationReviewDiagnostics,
  writeLocalReconciliationReviewDiagnosticsCommandFile,
} from './reconciliation/review/preparation';
import {
  commitLocalReconciliationReview,
  commitLocalReconciliationReviewCommandFile,
  verifyLocalReconciliationReview,
  verifyLocalReconciliationReviewCommandFile,
} from './reconciliation/review/completion';
import {
  commitLocalReconciliationApplication,
  commitLocalReconciliationApplicationCommandFile,
  prepareLocalReconciliationApplication,
  prepareLocalReconciliationApplicationCommandFile,
  verifyLocalReconciliationApplication,
  verifyLocalReconciliationApplicationCommandFile,
} from './reconciliation/application/coordinator';
import {
  planLocalReconciliationAutomation,
  planLocalReconciliationAutomationCommandFile,
  verifyLocalReconciliationAutomationPlan,
  verifyLocalReconciliationAutomationPlanCommandFile,
} from './reconciliation/application/automation/coordinator';
import {
  commitLocalReconciliationAutomationDecision,
  commitLocalReconciliationAutomationDecisionCommandFile,
  prepareLocalReconciliationAutomationDecision,
  prepareLocalReconciliationAutomationDecisionCommandFile,
  readLocalReconciliationAutomationDecisionTerminal,
  verifyLocalReconciliationAutomationDecision,
  verifyLocalReconciliationAutomationDecisionCommandFile,
} from './reconciliation/application/automation/decisionCoordinator';
import {
  applyLocalReconciliationAutomation,
  applyLocalReconciliationAutomationCommandFile,
  rollbackLocalReconciliationAutomationApply,
  rollbackLocalReconciliationAutomationApplyCommandFile,
  verifyLocalReconciliationAutomationApply,
  verifyLocalReconciliationAutomationApplyCommandFile,
} from './reconciliation/application/automation/applyCoordinator';
import {
  preserveLocalReconciliationRunHistory,
  preserveLocalReconciliationRunHistoryCommandFile,
  readLocalReconciliationRunHistoryTerminal,
  verifyLocalReconciliationRunHistory,
  verifyLocalReconciliationRunHistoryCommandFile,
} from './reconciliation/application/run-history/coordinator';
import {
  completeLocalReconciliation,
  completeLocalReconciliationCommandFile,
  verifyLocalReconciliationCompletion,
  verifyLocalReconciliationCompletionCommandFile,
} from './reconciliation/completion/coordinator';

export {
  commitLocalReconciliationPlan,
  commitLocalReconciliationPlanCommandFile,
  prepareLocalReconciliationPlan,
  prepareLocalReconciliationPlanCommandFile,
  verifyLocalReconciliationPlan,
  verifyLocalReconciliationPlanCommandFile,
  prepareLocalReconciliationReview,
  prepareLocalReconciliationReviewCommandFile,
  writeLocalReconciliationReviewDiagnostics,
  writeLocalReconciliationReviewDiagnosticsCommandFile,
  commitLocalReconciliationReview,
  commitLocalReconciliationReviewCommandFile,
  verifyLocalReconciliationReview,
  verifyLocalReconciliationReviewCommandFile,
  prepareLocalReconciliationApplication,
  prepareLocalReconciliationApplicationCommandFile,
  commitLocalReconciliationApplication,
  commitLocalReconciliationApplicationCommandFile,
  verifyLocalReconciliationApplication,
  verifyLocalReconciliationApplicationCommandFile,
  planLocalReconciliationAutomation,
  planLocalReconciliationAutomationCommandFile,
  verifyLocalReconciliationAutomationPlan,
  verifyLocalReconciliationAutomationPlanCommandFile,
  prepareLocalReconciliationAutomationDecision,
  prepareLocalReconciliationAutomationDecisionCommandFile,
  readLocalReconciliationAutomationDecisionTerminal,
  commitLocalReconciliationAutomationDecision,
  commitLocalReconciliationAutomationDecisionCommandFile,
  verifyLocalReconciliationAutomationDecision,
  verifyLocalReconciliationAutomationDecisionCommandFile,
  applyLocalReconciliationAutomation,
  applyLocalReconciliationAutomationCommandFile,
  verifyLocalReconciliationAutomationApply,
  verifyLocalReconciliationAutomationApplyCommandFile,
  rollbackLocalReconciliationAutomationApply,
  rollbackLocalReconciliationAutomationApplyCommandFile,
  preserveLocalReconciliationRunHistory,
  preserveLocalReconciliationRunHistoryCommandFile,
  readLocalReconciliationRunHistoryTerminal,
  verifyLocalReconciliationRunHistory,
  verifyLocalReconciliationRunHistoryCommandFile,
  completeLocalReconciliation,
  completeLocalReconciliationCommandFile,
  verifyLocalReconciliationCompletion,
  verifyLocalReconciliationCompletionCommandFile,
};

export {
  normalizeLocalReconciliationCompleteCommand,
  normalizeLocalReconciliationCompletionVerifyCommand,
  type LocalReconciliationCompleteCommand,
  type LocalReconciliationCompletionAutomationBinding,
  type LocalReconciliationCompletionAutomationOptions,
  type LocalReconciliationCompletionOptions,
  type LocalReconciliationCompletionRunHistoryBinding,
  type LocalReconciliationCompletionRunHistoryOptions,
  type LocalReconciliationCompletionResult,
  type LocalReconciliationCompletionVerifyCommand,
} from './reconciliation/completion/contract';
export { type LocalReconciliationCompletionDependencies } from './reconciliation/completion/coordinator';
export {
  normalizeLocalReconciliationCompletionReceipt,
  type LocalReconciliationCompletionDomainEvidence,
  type LocalReconciliationCompletionReceipt,
} from './reconciliation/completion/evidence';

export {
  normalizeLocalReconciliationAutomationApplyCommand,
  normalizeLocalReconciliationAutomationApplyRollbackCommand,
  normalizeLocalReconciliationAutomationApplyVerifyCommand,
  type LocalReconciliationAutomationApplyCommand,
  type LocalReconciliationAutomationApplyOptions,
  type LocalReconciliationAutomationApplyResult,
  type LocalReconciliationAutomationApplyRollbackCommand,
  type LocalReconciliationAutomationApplyVerifyCommand,
} from './reconciliation/application/automation/applyContract';
export { type LocalReconciliationAutomationApplyDependencies } from './reconciliation/application/automation/applyCoordinator';

export {
  normalizeLocalReconciliationRunHistoryPreserveCommand,
  normalizeLocalReconciliationRunHistoryVerifyCommand,
  type LocalReconciliationRunHistoryOptions,
  type LocalReconciliationRunHistoryPreserveCommand,
  type LocalReconciliationRunHistoryResult,
  type LocalReconciliationRunHistoryVerifyCommand,
} from './reconciliation/application/run-history/contract';
export {
  type LocalReconciliationRunHistoryDependencies,
  type LocalReconciliationRunHistoryTerminal,
} from './reconciliation/application/run-history/coordinator';
export {
  normalizeLocalReconciliationRunHistoryPreservationReceipt,
  type LocalReconciliationRunHistoryPreservationReceipt,
} from './reconciliation/application/run-history/evidence';

export {
  normalizeLocalReconciliationApplicationCommitCommand,
  normalizeLocalReconciliationApplicationPrepareCommand,
  normalizeLocalReconciliationApplicationVerifyCommand,
  type LocalReconciliationApplicationCommitCommand,
  type LocalReconciliationApplicationOptions,
  type LocalReconciliationApplicationPrepareCommand,
  type LocalReconciliationApplicationPrepareResult,
  type LocalReconciliationApplicationTerminalResult,
  type LocalReconciliationApplicationVerifyCommand,
} from './reconciliation/application/contract';
export {
  localReconciliationApplicationDirectory,
  normalizeLocalReconciliationApplicationIntent,
  readLocalReconciliationApplicationIntent,
  type LocalReconciliationApplicationDependencies,
  type LocalReconciliationApplicationIntent,
} from './reconciliation/application/coordinator';
export {
  normalizeLocalReconciliationApplicationPlan,
  normalizeLocalReconciliationApplicationPlanReceipt,
  type LocalReconciliationApplicationDatabaseDecisionSummary,
  type LocalReconciliationApplicationDomainAction,
  type LocalReconciliationApplicationDomainSummary,
  type LocalReconciliationApplicationPlan,
  type LocalReconciliationApplicationPlanReceipt,
} from './reconciliation/application/plan';
export {
  normalizeLocalReconciliationAutomationPlanCommand,
  normalizeLocalReconciliationAutomationVerifyCommand,
  type LocalReconciliationAutomationOptions,
  type LocalReconciliationAutomationPlanCommand,
  type LocalReconciliationAutomationPlanResult,
  type LocalReconciliationAutomationVerifyCommand,
} from './reconciliation/application/automation/contract';
export { type LocalReconciliationAutomationPlanDependencies } from './reconciliation/application/automation/coordinator';
export {
  normalizeLocalReconciliationAutomationDecisionCommitCommand,
  normalizeLocalReconciliationAutomationDecisionPrepareCommand,
  normalizeLocalReconciliationAutomationDecisionVerifyCommand,
  type LocalReconciliationAutomationDecisionCommitCommand,
  type LocalReconciliationAutomationDecisionCommitOptions,
  type LocalReconciliationAutomationDecisionOptions,
  type LocalReconciliationAutomationDecisionPrepareCommand,
  type LocalReconciliationAutomationDecisionPrepareResult,
  type LocalReconciliationAutomationDecisionTerminalResult,
  type LocalReconciliationAutomationDecisionVerifyCommand,
} from './reconciliation/application/automation/decisionContract';
export { type LocalReconciliationAutomationDecisionDependencies } from './reconciliation/application/automation/decisionCoordinator';
export {
  MAX_EDGE_LOCAL_RECONCILIATION_AUTOMATION_PLAN_BYTES,
  MAX_STANDALONE_LOCAL_RECONCILIATION_AUTOMATION_PLAN_BYTES,
  normalizeLocalReconciliationAutomationPlanReceipt,
  type LocalReconciliationAutomationPlanFooter,
  type LocalReconciliationAutomationPlanHeader,
  type LocalReconciliationAutomationPlanReceipt,
  type LocalReconciliationAutomationPlanRow,
  type LocalReconciliationAutomationPlanSummary,
  type LocalReconciliationAutomationRowRequirement,
} from './reconciliation/application/automation/rowPlan';

export {
  LocalDeploymentConfigurationError,
  normalizeLocalDeploymentComposeApplyCommand,
  normalizeLocalDeploymentComposeEvidenceCollectionCommand,
  normalizeLocalDeploymentComposePreflightCommand,
  normalizeLocalDeploymentComposeRestoreCommand,
  normalizeLocalDeploymentComposeRevisionCommand,
  normalizeLocalDeploymentPrepareCommand,
  normalizeLocalDeploymentStatusCommand,
  type LocalDeploymentComposeApplyCommand,
  type LocalDeploymentComposeApplyResult,
  type LocalDeploymentComposeEvidenceCollectionCommand,
  type LocalDeploymentComposeEvidenceCollectionCommitCommand,
  type LocalDeploymentComposeEvidenceCollectionPrepareCommand,
  type LocalDeploymentComposeEvidenceCollectionResult,
  type LocalDeploymentComposePreflightCommand,
  type LocalDeploymentComposePreflightResult,
  type LocalDeploymentComposeRestoreCommand,
  type LocalDeploymentComposeRestoreCommitCommand,
  type LocalDeploymentComposeRestorePrepareCommand,
  type LocalDeploymentComposeRestoreResult,
  type LocalDeploymentComposeRevisionCommand,
  type LocalDeploymentComposeRevisionResult,
  type LocalDeploymentPrepareCommand,
  type LocalDeploymentPrepareResult,
  type LocalDeploymentStatusCommand,
  type LocalDeploymentStatusResult,
} from './foundation/contract';
export {
  normalizeLocalReconciliationCapturePrepareCommand,
  normalizeLocalReconciliationCaptureCommitCommand,
  normalizeLocalReconciliationCaptureVerifyCommand,
  type LocalReconciliationCaptureCommitCommand,
  type LocalReconciliationCapturePrepareCommand,
  type LocalReconciliationCapturePrepareResult,
  type LocalReconciliationCaptureTerminalResult,
  type LocalReconciliationCaptureVerifyCommand,
  type LocalReconciliationStoppedAuthority,
} from './reconciliation/contract';
export {
  LOCAL_RECONCILIATION_DIAGNOSTIC_FACT_KINDS,
  normalizeLocalReconciliationReviewDiagnosticsCommand,
  normalizeLocalReconciliationReviewPrepareCommand,
  type LocalReconciliationDiagnosticFactKind,
  type LocalReconciliationReviewDiagnosticsCommand,
  type LocalReconciliationReviewDiagnosticsResult,
  type LocalReconciliationReviewOptions,
  type LocalReconciliationReviewPrepareCommand,
  type LocalReconciliationReviewPrepareResult,
} from './reconciliation/review/contract';
export {
  MAX_LOCAL_RECONCILIATION_REVIEW_AUTHORIZATION_LIFETIME_MS,
  normalizeLocalReconciliationReviewCommitCommand,
  normalizeLocalReconciliationReviewVerifyCommand,
  type LocalReconciliationReviewCommitCommand,
  type LocalReconciliationReviewCommitOptions,
  type LocalReconciliationReviewTerminalResult,
  type LocalReconciliationReviewVerifyCommand,
} from './reconciliation/review/completionContract';
export { type LocalReconciliationReviewCompletionDependencies } from './reconciliation/review/completion';
export {
  LOCAL_RECONCILIATION_REVIEW_DISPOSITIONS,
  LOCAL_RECONCILIATION_REVIEW_REASONS,
  MAX_EDGE_LOCAL_RECONCILIATION_REVIEW_DECISION_BYTES,
  MAX_STANDALONE_LOCAL_RECONCILIATION_REVIEW_DECISION_BYTES,
  type LocalReconciliationReviewDecision,
  type LocalReconciliationReviewDecisionHeader,
  type LocalReconciliationReviewDisposition,
  type LocalReconciliationReviewReason,
} from './reconciliation/review/decisionFile';
export {
  MAX_LOCAL_RECONCILIATION_REVIEW_ISSUER_KEYS,
  LocalReconciliationReviewIssuerKeyringFileProvider,
  ensureLocalReconciliationReviewIssuerKeyring,
  type LocalReconciliationReviewIssuerKeyringSummary,
} from './reconciliation/review/issuerKeyring';
export {
  normalizeLocalReconciliationReview,
  normalizeLocalReconciliationReviewReceipt,
  type LocalReconciliationReview,
  type LocalReconciliationReviewReceipt,
} from './reconciliation/review/terminalEvidence';
export {
  localReconciliationReviewDirectory,
  normalizeLocalReconciliationReviewIntent,
  readLocalReconciliationReviewIntent,
  type LocalReconciliationReviewDependencies,
  type LocalReconciliationReviewIntent,
} from './reconciliation/review/preparation';
export {
  type LocalReconciliationDiagnosticDecisionRequirement,
  type LocalReconciliationDiagnosticFact,
  type LocalReconciliationDiagnosticPage,
  type LocalReconciliationDiagnosticReason,
} from './reconciliation/review/diagnostics';
export {
  LOCAL_RECONCILIATION_PLAN_DOMAINS,
  normalizeLocalReconciliationPlanCommitCommand,
  normalizeLocalReconciliationPlanPrepareCommand,
  normalizeLocalReconciliationPlanVerifyCommand,
  type LocalReconciliationPlanCommitCommand,
  type LocalReconciliationPlanDisposition,
  type LocalReconciliationPlanDomain,
  type LocalReconciliationPlanPrepareCommand,
  type LocalReconciliationPlanPrepareResult,
  type LocalReconciliationPlanTerminalResult,
  type LocalReconciliationPlanVerifyCommand,
} from './reconciliation/planning/contract';
export {
  localReconciliationPlanDirectory,
  normalizeLocalReconciliationPlanIntent,
  readLocalReconciliationPlanIntent,
  type LocalReconciliationPlanDependencies,
  type LocalReconciliationPlanIntent,
} from './reconciliation/planning/preparation';
export {
  normalizeLocalReconciliationPlan,
  normalizeLocalReconciliationPlanReceipt,
  type LocalReconciliationPlan,
  type LocalReconciliationPlanDatabaseSummary,
  type LocalReconciliationPlanDomainSummary,
  type LocalReconciliationPlanReceipt,
} from './reconciliation/planning/plan';
export {
  localReconciliationCaptureDirectory,
  localReconciliationCaptureIntentPath,
  normalizeLocalReconciliationCaptureIntent,
  readLocalReconciliationCaptureIntent,
  type LocalReconciliationCaptureIntent,
} from './reconciliation/preparation';
export {
  normalizeLocalReconciliationCaptureManifest,
  normalizeLocalReconciliationCaptureReceipt,
  type LocalReconciliationCaptureDependencies,
  type LocalReconciliationCaptureManifest,
  type LocalReconciliationCaptureReceipt,
} from './reconciliation/bundle';
export {
  prepareLocalDeploymentAdoptedBundle,
  runLocalDeploymentAdoptedBundleCommandFile,
  verifyLocalDeploymentAdoptedBundle,
  type LocalDeploymentAdoptedBundleResult,
} from './adopted-bundle/adoptedBundle';
export {
  normalizeLocalDeploymentAdoptedBundleCommand,
  type LocalDeploymentAdoptedBundleCommand,
  type LocalDeploymentAdoptedBundleOperation,
} from './adopted-bundle/contract';
export {
  type LocalComposeReleaseAuthority,
  type LocalComposeReleaseSelectionInput,
} from './compose/releaseSelection';
export {
  normalizeLocalDeploymentLegacyStopCommand,
  type LocalDeploymentLegacyStopCommand,
  type LocalDeploymentLegacyStopResult,
} from './cutover/contract';
export {
  normalizeLocalDeploymentTargetRunCommand,
  type LocalDeploymentTargetRunCommand,
  type LocalDeploymentTargetRunOperation,
  type LocalDeploymentTargetRunResult,
} from './cutover/target-run/targetRunContract';
export {
  normalizeLocalDeploymentTargetStopCommand,
  type LocalDeploymentTargetReconciliationDisposition,
  type LocalDeploymentTargetStopCommand,
  type LocalDeploymentTargetStopResult,
} from './cutover/targetStopContract';
export { type LocalDeploymentTargetStopDependencies } from './cutover/targetStop';
export {
  EMPTY_ROLLBACK_PREPARATION_DIGEST,
  normalizeLocalDeploymentLegacyRollbackCommand,
  type LocalDeploymentLegacyRollbackCommand,
  type LocalDeploymentLegacyRollbackOperation,
  type LocalDeploymentLegacyRollbackResult,
} from './cutover/legacyRollbackContract';
export { type LocalDeploymentLegacyRollbackDependencies } from './cutover/legacyRollback';
export {
  normalizeLocalDeploymentLegacyReadinessCommand,
  type LocalDeploymentLegacyReadinessCommand,
} from './cutover/legacy-readiness/contract';
export {
  type LocalDeploymentLegacyReadinessDependencies,
  type LocalDeploymentLegacyReadinessResult,
  type LocalLegacyReadinessObservation,
  type LocalLegacyReadinessProbeInput,
  type LocalLegacyReadinessReason,
} from './cutover/legacy-readiness/probe';
export {
  EMPTY_RESOLUTION_DIGEST,
  normalizeLocalDeploymentCutoverManualCommand,
  type LocalDeploymentCutoverManualCommand,
  type LocalDeploymentCutoverManualOperation,
} from './cutover/manual-resolution/manualResolutionContract';
export {
  type LocalDeploymentCutoverManualDependencies,
  type LocalDeploymentCutoverManualResult,
  type LocalDeploymentCutoverObservationState,
} from './cutover/manual-resolution/manualResolution';
export {
  applyLocalDeploymentCompose,
  applyLocalDeploymentComposeCommandFile,
  collectLocalDeploymentComposeEvidence,
  collectLocalDeploymentComposeEvidenceCommitCommandFile,
  collectLocalDeploymentComposeEvidencePrepareCommandFile,
  inspectLocalDeploymentStatus,
  inspectLocalDeploymentStatusCommandFile,
  preflightLocalDeploymentCompose,
  preflightLocalDeploymentComposeCommandFile,
  restoreLocalDeploymentCompose,
  restoreLocalDeploymentComposeCommitCommandFile,
  restoreLocalDeploymentComposeCommandFile,
  restoreLocalDeploymentComposePrepareCommandFile,
  runLocalDeploymentCutoverManualCommand,
  runLocalDeploymentCutoverManualCommandFile,
  runLocalDeploymentLegacyRollback,
  runLocalDeploymentLegacyRollbackCommandFile,
  proveLocalDeploymentLegacyReadiness,
  proveLocalDeploymentLegacyReadinessCommandFile,
  runLocalDeploymentDockerTarget,
  runLocalDeploymentDockerTargetCommandFile,
  switchLocalDeploymentComposeRevision,
  switchLocalDeploymentComposeRevisionCommandFile,
  stopLegacyDockerForLocalDeployment,
  stopLegacyDockerForLocalDeploymentCommandFile,
  stopLocalDeploymentDockerTarget,
  stopLocalDeploymentDockerTargetCommandFile,
  consumeLocalServiceManagerOutcome,
  consumeLocalServiceManagerOutcomeCommandFile,
  consumeLocalServiceManagerCutoverOutcome,
  consumeLocalServiceManagerCutoverOutcomeCommandFile,
  prepareLocalServiceManagerIntent,
  prepareLocalServiceManagerIntentCommandFile,
  prepareLocalServiceManagerLegacyRollback,
  prepareLocalServiceManagerLegacyRollbackCommandFile,
  authorizeLocalServiceManagerLegacyRollback,
  authorizeLocalServiceManagerLegacyRollbackCommandFile,
  consumeLocalServiceManagerLegacyRollback,
  consumeLocalServiceManagerLegacyRollbackCommandFile,
  prepareLocalReconciliationCapture,
  prepareLocalReconciliationCaptureCommandFile,
  commitLocalReconciliationCapture,
  commitLocalReconciliationCaptureCommandFile,
  verifyLocalReconciliationCapture,
  verifyLocalReconciliationCaptureCommandFile,
};
export {
  localServiceManagerIntentDigest,
  normalizeLocalServiceBridgeCommand,
  normalizeLocalServiceManagerIntent,
  type LocalServiceBridgeCommand,
  type LocalServiceManagerIntent,
} from './service-manager/serviceBridgeContract';
export {
  normalizeLocalServiceManagerOutcome,
  type LocalServiceManagerOutcome,
} from './service-manager/serviceOutcomeContract';
export {
  type LocalServiceManagerIntentPrepareCommand,
  type LocalServiceManagerIntentPrepareResult,
  type LocalServiceManagerOutcomeConsumeCommand,
  type LocalServiceManagerOutcomeConsumeResult,
} from './service-manager/serviceManagerIntent';
export {
  type LocalServiceManagerCutoverConsumeCommand,
  type LocalServiceManagerCutoverConsumeResult,
  type LocalServiceManagerCutoverDependencies,
} from './service-manager/serviceCutoverConsumer';
export {
  type LocalServiceManagerCutoverEvidence,
  type LocalServiceManagerCutoverRecord,
  type LocalServiceManagerCutoverState,
} from './service-manager/serviceCutoverJournal';
export {
  localServiceManagerLegacyRollbackPreparationPath,
  normalizeLocalServiceManagerLegacyRollbackPreparation,
  type LocalServiceManagerLegacyRollbackPreparation,
  type LocalServiceManagerLegacyRollbackPrepareCommand,
  type LocalServiceManagerLegacyRollbackPrepareResult,
} from './service-manager/legacy-rollback/preparation';
export {
  normalizeLocalServiceManagerLegacyRollbackCompletion,
  type LocalServiceManagerLegacyRollbackAuthorizeCommand,
  type LocalServiceManagerLegacyRollbackAuthorizeResult,
  type LocalServiceManagerLegacyRollbackCompletion,
  type LocalServiceManagerLegacyRollbackConsumeCommand,
  type LocalServiceManagerLegacyRollbackConsumeResult,
} from './service-manager/legacy-rollback/consumer';
export {
  localServiceManagerLegacyCompletionPath,
  localServiceManagerLegacyDescriptorPath,
  localServiceManagerLegacyStartAuthorizationPath,
  localServiceManagerLegacyStartOutcomePath,
  localServiceManagerTargetDescriptorPath,
  normalizeLocalServiceManagerLegacyRollbackBridgeCommand,
  normalizeLocalServiceManagerLegacyStartAuthorization,
  normalizeLocalServiceManagerLegacyStartOutcome,
  type LocalServiceManagerLegacyRollbackBridgeCommand,
  type LocalServiceManagerLegacyRollbackBridgeResult,
  type LocalServiceManagerLegacyStartAuthorization,
  type LocalServiceManagerLegacyStartOutcome,
} from './service-manager/legacy-rollback/contract';

export async function prepareLocalDeployment(
  input: unknown,
): Promise<Readonly<LocalDeploymentPrepareResult>> {
  const command = normalizeLocalDeploymentPrepareCommand(input);
  const identity = currentIdentity();
  const paths = deploymentPaths(command.options.deploymentRoot);
  const directories = [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [paths.ownerPepperKeyring, 'ownerPepperKeyringDirectory'],
    [paths.ownerPepperBackup, 'ownerPepperBackupDirectory'],
    [paths.receipts, 'receiptRoot'],
    [paths.artifacts, 'artifactRoot'],
    [paths.pluginStaging, 'pluginStagingRoot'],
    [paths.pluginActivation, 'pluginActivationRoot'],
    [paths.service, 'serviceDescriptorRoot'],
    ...(command.options.service.kind === 'compose'
      ? ([
          [paths.composeRevisions, 'composeRevisionRoot'],
          [paths.composeRollouts, 'composeRolloutRoot'],
          [paths.composeRolloutBackups, 'composeRolloutBackupRoot'],
          [paths.composeRestores, 'composeRestoreRoot'],
          [paths.composeRestoreSafeguards, 'composeRestoreSafeguardRoot'],
          [paths.composeEvidenceCollections, 'composeEvidenceCollectionRoot'],
          [paths.composeCollectedEvidence, 'composeCollectedEvidenceRoot'],
          [
            paths.composeCollectedRolloutBackups,
            'composeCollectedRolloutBackupRoot',
          ],
          [
            paths.composeCollectedRestoreSafeguards,
            'composeCollectedRestoreSafeguardRoot',
          ],
        ] as const)
      : []),
  ] as const;
  const directoryStatuses = directories.map(([directory, label]) =>
    ensurePrivateDirectory(directory, identity.uid, label),
  );
  const applicationConfig = applicationConfiguration(command, paths);
  const serviceDescriptor = descriptor(
    command,
    paths.applicationConfig,
    identity.uid,
    identity.gid,
  );
  const descriptorPath = path.join(paths.service, serviceDescriptor.fileName);
  const composeSelection =
    command.options.service.kind === 'compose'
      ? initialComposeImageSelection(command)
      : undefined;

  preflightPublishedFile(
    paths.applicationConfig,
    applicationConfig,
    0o600,
    identity.uid,
    'application configuration',
  );
  preflightPublishedFile(
    descriptorPath,
    serviceDescriptor.contents,
    serviceDescriptor.mode,
    identity.uid,
    'service descriptor',
  );
  if (composeSelection !== undefined) {
    preflightPublishedFile(
      path.join(paths.composeRevisions, '1.yaml'),
      composeSelection,
      0o600,
      identity.uid,
      'initial compose revision',
    );
    preflightActiveComposeImageSelection(
      paths.composeSelection,
      paths.composeRevisions,
      composeSelection,
      identity.uid,
    );
  }

  const setup = await executeLocalSetup(setupCommand(command, paths));
  const applicationStatus = publishExactFile(
    paths.applicationConfig,
    applicationConfig,
    0o600,
    identity.uid,
    'application configuration',
  );
  const serviceStatus = publishExactFile(
    descriptorPath,
    serviceDescriptor.contents,
    serviceDescriptor.mode,
    identity.uid,
    'service descriptor',
  );
  const composeRevisionStatus =
    composeSelection === undefined
      ? 'existing'
      : publishExactFile(
          path.join(paths.composeRevisions, '1.yaml'),
          composeSelection,
          0o600,
          identity.uid,
          'initial compose revision',
        );
  const composeSelectionStatus =
    composeSelection === undefined
      ? 'existing'
      : preflightActiveComposeImageSelection(
          paths.composeSelection,
          paths.composeRevisions,
          composeSelection,
          identity.uid,
        ) === 'existing'
      ? 'existing'
      : publishExactFile(
          paths.composeSelection,
          composeSelection,
          0o600,
          identity.uid,
          'active compose selection',
        );
  const createdDirectories = directoryStatuses.filter(
    (status) => status === 'prepared',
  ).length;
  const prepared =
    createdDirectories > 0 ||
    setup.status === 'prepared' ||
    applicationStatus === 'prepared' ||
    serviceStatus === 'prepared';
  const deploymentPrepared =
    prepared ||
    composeSelectionStatus === 'prepared' ||
    composeRevisionStatus === 'prepared';

  return Object.freeze({
    schemaVersion: 1 as const,
    status: deploymentPrepared ? ('prepared' as const) : ('existing' as const),
    profile: command.options.profile,
    service: Object.freeze({
      kind: command.options.service.kind,
      status: serviceStatus,
    }),
    applicationConfiguration: Object.freeze({
      schema: 'qinglong/local-application-process@v2' as const,
      status: applicationStatus,
    }),
    directories: Object.freeze({
      created: createdDirectories,
      existing: directoryStatuses.length - createdDirectories,
    }),
    setup,
  });
}

export function prepareLocalDeploymentCommandFile(
  filePath: string,
): Promise<Readonly<LocalDeploymentPrepareResult>> {
  return prepareLocalDeployment(readPrivateLocalCommandFile(filePath));
}
