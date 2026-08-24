#!/usr/bin/env node

// Keep the deployment binary beside its composition authority.
import {
  applyLocalDeploymentComposeCommandFile,
  authorizeLocalServiceManagerLegacyRollbackCommandFile,
  collectLocalDeploymentComposeEvidenceCommitCommandFile,
  collectLocalDeploymentComposeEvidencePrepareCommandFile,
  consumeLocalServiceManagerOutcomeCommandFile,
  consumeLocalServiceManagerCutoverOutcomeCommandFile,
  consumeLocalServiceManagerLegacyRollbackCommandFile,
  inspectLocalDeploymentStatusCommandFile,
  preflightLocalDeploymentComposeCommandFile,
  prepareLocalServiceManagerIntentCommandFile,
  prepareLocalServiceManagerLegacyRollbackCommandFile,
  prepareLocalReconciliationCaptureCommandFile,
  prepareLocalReconciliationPlanCommandFile,
  prepareLocalReconciliationReviewCommandFile,
  commitLocalReconciliationCaptureCommandFile,
  commitLocalReconciliationPlanCommandFile,
  commitLocalReconciliationReviewCommandFile,
  verifyLocalReconciliationCaptureCommandFile,
  verifyLocalReconciliationPlanCommandFile,
  verifyLocalReconciliationReviewCommandFile,
  prepareLocalReconciliationApplicationCommandFile,
  commitLocalReconciliationApplicationCommandFile,
  verifyLocalReconciliationApplicationCommandFile,
  planLocalReconciliationAutomationCommandFile,
  verifyLocalReconciliationAutomationPlanCommandFile,
  prepareLocalReconciliationAutomationDecisionCommandFile,
  commitLocalReconciliationAutomationDecisionCommandFile,
  verifyLocalReconciliationAutomationDecisionCommandFile,
  applyLocalReconciliationAutomationCommandFile,
  verifyLocalReconciliationAutomationApplyCommandFile,
  rollbackLocalReconciliationAutomationApplyCommandFile,
  planLocalReconciliationSecretConfigCommandFile,
  verifyLocalReconciliationSecretConfigPlanCommandFile,
  prepareLocalReconciliationSecretConfigDecisionCommandFile,
  commitLocalReconciliationSecretConfigDecisionCommandFile,
  verifyLocalReconciliationSecretConfigDecisionCommandFile,
  applyLocalReconciliationSecretConfigCommandFile,
  verifyLocalReconciliationSecretConfigApplyCommandFile,
  rollbackLocalReconciliationSecretConfigApplyCommandFile,
  preserveLocalReconciliationRunHistoryCommandFile,
  verifyLocalReconciliationRunHistoryCommandFile,
  completeLocalReconciliationCommandFile,
  verifyLocalReconciliationCompletionCommandFile,
  writeLocalReconciliationReviewDiagnosticsCommandFile,
  prepareLocalDeploymentCommandFile,
  proveLocalDeploymentLegacyReadinessCommandFile,
  restoreLocalDeploymentComposeCommitCommandFile,
  restoreLocalDeploymentComposePrepareCommandFile,
  runLocalDeploymentAdoptedBundleCommandFile,
  runLocalDeploymentCutoverManualCommandFile,
  runLocalDeploymentLegacyRollbackCommandFile,
  runLocalDeploymentDockerTargetCommandFile,
  stopLocalDeploymentDockerTargetCommandFile,
  stopLegacyDockerForLocalDeploymentCommandFile,
  switchLocalDeploymentComposeRevisionCommandFile,
} from './localDeployment';

const USAGE =
  'Usage: ql3-local-deploy <prepare|adopted-prepare|adopted-verify|status|service-intent-prepare|service-outcome-consume|service-cutover-consume|service-legacy-rollback-prepare|service-legacy-rollback-authorize|service-legacy-rollback-consume|cutover-legacy-stop|cutover-target-start|cutover-target-restart|cutover-target-stop|cutover-legacy-rollback-prepare|cutover-legacy-rollback-commit|cutover-legacy-readiness-probe|cutover-manual-diagnose|cutover-manual-resolution-prepare|cutover-manual-resolution-commit|reconciliation-capture-prepare|reconciliation-capture-commit|reconciliation-capture-verify|reconciliation-plan-prepare|reconciliation-plan-commit|reconciliation-plan-verify|reconciliation-review-prepare|reconciliation-review-diagnostics|reconciliation-review-commit|reconciliation-review-verify|reconciliation-application-prepare|reconciliation-application-commit|reconciliation-application-verify|reconciliation-automation-plan|reconciliation-automation-verify|reconciliation-automation-decision-prepare|reconciliation-automation-decision-commit|reconciliation-automation-decision-verify|reconciliation-automation-apply|reconciliation-automation-apply-verify|reconciliation-automation-apply-rollback|reconciliation-secret-config-plan|reconciliation-secret-config-verify|reconciliation-secret-config-decision-prepare|reconciliation-secret-config-decision-commit|reconciliation-secret-config-decision-verify|reconciliation-secret-config-apply|reconciliation-secret-config-apply-verify|reconciliation-secret-config-apply-rollback|reconciliation-run-history-preserve|reconciliation-run-history-verify|reconciliation-complete|reconciliation-complete-verify|compose-revision|compose-preflight|compose-apply|compose-restore-prepare|compose-restore-commit|compose-evidence-collect-prepare|compose-evidence-collect-commit> --command-file /absolute/private-command.json';

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (
    argv.length !== 3 ||
    (argv[0] !== 'prepare' &&
      argv[0] !== 'adopted-prepare' &&
      argv[0] !== 'adopted-verify' &&
      argv[0] !== 'status' &&
      argv[0] !== 'service-intent-prepare' &&
      argv[0] !== 'service-outcome-consume' &&
      argv[0] !== 'service-cutover-consume' &&
      argv[0] !== 'service-legacy-rollback-prepare' &&
      argv[0] !== 'service-legacy-rollback-authorize' &&
      argv[0] !== 'service-legacy-rollback-consume' &&
      argv[0] !== 'cutover-legacy-stop' &&
      argv[0] !== 'cutover-target-start' &&
      argv[0] !== 'cutover-target-restart' &&
      argv[0] !== 'cutover-target-stop' &&
      argv[0] !== 'cutover-legacy-rollback-prepare' &&
      argv[0] !== 'cutover-legacy-rollback-commit' &&
      argv[0] !== 'cutover-legacy-readiness-probe' &&
      argv[0] !== 'cutover-manual-diagnose' &&
      argv[0] !== 'cutover-manual-resolution-prepare' &&
      argv[0] !== 'cutover-manual-resolution-commit' &&
      argv[0] !== 'reconciliation-capture-prepare' &&
      argv[0] !== 'reconciliation-capture-commit' &&
      argv[0] !== 'reconciliation-capture-verify' &&
      argv[0] !== 'reconciliation-plan-prepare' &&
      argv[0] !== 'reconciliation-plan-commit' &&
      argv[0] !== 'reconciliation-plan-verify' &&
      argv[0] !== 'reconciliation-review-prepare' &&
      argv[0] !== 'reconciliation-review-diagnostics' &&
      argv[0] !== 'reconciliation-review-commit' &&
      argv[0] !== 'reconciliation-review-verify' &&
      argv[0] !== 'reconciliation-application-prepare' &&
      argv[0] !== 'reconciliation-application-commit' &&
      argv[0] !== 'reconciliation-application-verify' &&
      argv[0] !== 'reconciliation-automation-plan' &&
      argv[0] !== 'reconciliation-automation-verify' &&
      argv[0] !== 'reconciliation-automation-decision-prepare' &&
      argv[0] !== 'reconciliation-automation-decision-commit' &&
      argv[0] !== 'reconciliation-automation-decision-verify' &&
      argv[0] !== 'reconciliation-automation-apply' &&
      argv[0] !== 'reconciliation-automation-apply-verify' &&
      argv[0] !== 'reconciliation-automation-apply-rollback' &&
      argv[0] !== 'reconciliation-secret-config-plan' &&
      argv[0] !== 'reconciliation-secret-config-verify' &&
      argv[0] !== 'reconciliation-secret-config-decision-prepare' &&
      argv[0] !== 'reconciliation-secret-config-decision-commit' &&
      argv[0] !== 'reconciliation-secret-config-decision-verify' &&
      argv[0] !== 'reconciliation-secret-config-apply' &&
      argv[0] !== 'reconciliation-secret-config-apply-verify' &&
      argv[0] !== 'reconciliation-secret-config-apply-rollback' &&
      argv[0] !== 'reconciliation-run-history-preserve' &&
      argv[0] !== 'reconciliation-run-history-verify' &&
      argv[0] !== 'reconciliation-complete' &&
      argv[0] !== 'reconciliation-complete-verify' &&
      argv[0] !== 'compose-revision' &&
      argv[0] !== 'compose-preflight' &&
      argv[0] !== 'compose-apply' &&
      argv[0] !== 'compose-restore-prepare' &&
      argv[0] !== 'compose-restore-commit' &&
      argv[0] !== 'compose-evidence-collect-prepare' &&
      argv[0] !== 'compose-evidence-collect-commit') ||
    argv[1] !== '--command-file'
  ) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_LOCAL_DEPLOYMENT_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const output = await (argv[0] === 'prepare'
      ? prepareLocalDeploymentCommandFile(argv[2]!)
      : argv[0] === 'adopted-prepare' || argv[0] === 'adopted-verify'
      ? runLocalDeploymentAdoptedBundleCommandFile(
          argv[2]!,
          argv[0] === 'adopted-prepare'
            ? 'local.deployment.adopted.prepare'
            : 'local.deployment.adopted.verify',
        )
      : argv[0] === 'status'
      ? inspectLocalDeploymentStatusCommandFile(argv[2]!)
      : argv[0] === 'service-intent-prepare'
      ? prepareLocalServiceManagerIntentCommandFile(argv[2]!)
      : argv[0] === 'service-outcome-consume'
      ? consumeLocalServiceManagerOutcomeCommandFile(argv[2]!)
      : argv[0] === 'service-cutover-consume'
      ? consumeLocalServiceManagerCutoverOutcomeCommandFile(argv[2]!)
      : argv[0] === 'service-legacy-rollback-prepare'
      ? prepareLocalServiceManagerLegacyRollbackCommandFile(argv[2]!)
      : argv[0] === 'service-legacy-rollback-authorize'
      ? authorizeLocalServiceManagerLegacyRollbackCommandFile(argv[2]!)
      : argv[0] === 'service-legacy-rollback-consume'
      ? consumeLocalServiceManagerLegacyRollbackCommandFile(argv[2]!)
      : argv[0] === 'cutover-legacy-stop'
      ? stopLegacyDockerForLocalDeploymentCommandFile(argv[2]!)
      : argv[0] === 'cutover-target-start' ||
        argv[0] === 'cutover-target-restart'
      ? runLocalDeploymentDockerTargetCommandFile(argv[2]!)
      : argv[0] === 'cutover-target-stop'
      ? stopLocalDeploymentDockerTargetCommandFile(argv[2]!)
      : argv[0] === 'cutover-legacy-rollback-prepare' ||
        argv[0] === 'cutover-legacy-rollback-commit'
      ? runLocalDeploymentLegacyRollbackCommandFile(
          argv[2]!,
          argv[0] === 'cutover-legacy-rollback-prepare'
            ? 'local.deployment.cutover.legacy-rollback-prepare'
            : 'local.deployment.cutover.legacy-rollback-commit',
        )
      : argv[0] === 'cutover-legacy-readiness-probe'
      ? proveLocalDeploymentLegacyReadinessCommandFile(argv[2]!)
      : argv[0] === 'cutover-manual-diagnose' ||
        argv[0] === 'cutover-manual-resolution-prepare' ||
        argv[0] === 'cutover-manual-resolution-commit'
      ? runLocalDeploymentCutoverManualCommandFile(
          argv[2]!,
          argv[0] === 'cutover-manual-diagnose'
            ? 'local.deployment.cutover.manual-diagnose'
            : argv[0] === 'cutover-manual-resolution-prepare'
            ? 'local.deployment.cutover.manual-resolution-prepare'
            : 'local.deployment.cutover.manual-resolution-commit',
        )
      : argv[0] === 'reconciliation-capture-prepare'
      ? prepareLocalReconciliationCaptureCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-capture-commit'
      ? commitLocalReconciliationCaptureCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-capture-verify'
      ? verifyLocalReconciliationCaptureCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-plan-prepare'
      ? prepareLocalReconciliationPlanCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-plan-commit'
      ? commitLocalReconciliationPlanCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-plan-verify'
      ? verifyLocalReconciliationPlanCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-review-prepare'
      ? prepareLocalReconciliationReviewCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-review-diagnostics'
      ? writeLocalReconciliationReviewDiagnosticsCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-review-commit'
      ? commitLocalReconciliationReviewCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-review-verify'
      ? verifyLocalReconciliationReviewCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-application-prepare'
      ? prepareLocalReconciliationApplicationCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-application-commit'
      ? commitLocalReconciliationApplicationCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-application-verify'
      ? verifyLocalReconciliationApplicationCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-automation-plan'
      ? planLocalReconciliationAutomationCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-automation-verify'
      ? verifyLocalReconciliationAutomationPlanCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-automation-decision-prepare'
      ? prepareLocalReconciliationAutomationDecisionCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-automation-decision-commit'
      ? commitLocalReconciliationAutomationDecisionCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-automation-decision-verify'
      ? verifyLocalReconciliationAutomationDecisionCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-automation-apply'
      ? applyLocalReconciliationAutomationCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-automation-apply-verify'
      ? verifyLocalReconciliationAutomationApplyCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-automation-apply-rollback'
      ? rollbackLocalReconciliationAutomationApplyCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-secret-config-plan'
      ? planLocalReconciliationSecretConfigCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-secret-config-verify'
      ? verifyLocalReconciliationSecretConfigPlanCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-secret-config-decision-prepare'
      ? prepareLocalReconciliationSecretConfigDecisionCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-secret-config-decision-commit'
      ? commitLocalReconciliationSecretConfigDecisionCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-secret-config-decision-verify'
      ? verifyLocalReconciliationSecretConfigDecisionCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-secret-config-apply'
      ? applyLocalReconciliationSecretConfigCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-secret-config-apply-verify'
      ? verifyLocalReconciliationSecretConfigApplyCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-secret-config-apply-rollback'
      ? rollbackLocalReconciliationSecretConfigApplyCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-run-history-preserve'
      ? preserveLocalReconciliationRunHistoryCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-run-history-verify'
      ? verifyLocalReconciliationRunHistoryCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-complete'
      ? completeLocalReconciliationCommandFile(argv[2]!)
      : argv[0] === 'reconciliation-complete-verify'
      ? verifyLocalReconciliationCompletionCommandFile(argv[2]!)
      : argv[0] === 'compose-revision'
      ? switchLocalDeploymentComposeRevisionCommandFile(argv[2]!)
      : argv[0] === 'compose-preflight'
      ? preflightLocalDeploymentComposeCommandFile(argv[2]!)
      : argv[0] === 'compose-apply'
      ? applyLocalDeploymentComposeCommandFile(argv[2]!)
      : argv[0] === 'compose-restore-prepare'
      ? restoreLocalDeploymentComposePrepareCommandFile(argv[2]!)
      : argv[0] === 'compose-restore-commit'
      ? restoreLocalDeploymentComposeCommitCommandFile(argv[2]!)
      : argv[0] === 'compose-evidence-collect-prepare'
      ? collectLocalDeploymentComposeEvidencePrepareCommandFile(argv[2]!)
      : collectLocalDeploymentComposeEvidenceCommitCommandFile(argv[2]!));
    process.stdout.write(`${JSON.stringify(output)}\n`);
    if (
      argv[0] === 'compose-apply' &&
      'status' in output &&
      output.status !== 'active'
    ) {
      process.exitCode = 2;
    }
  } catch (error) {
    const candidate = error as {
      readonly code?: unknown;
      readonly name?: unknown;
    };
    process.stderr.write(
      `${JSON.stringify({
        code:
          typeof candidate.code === 'string'
            ? candidate.code
            : 'QL3_LOCAL_DEPLOYMENT_FAILED',
        name: typeof candidate.name === 'string' ? candidate.name : 'Error',
      })}\n`,
    );
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
