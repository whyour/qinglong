import { runSchemaMigration } from './0002-run-schema';
import { runningInstanceRunReferenceMigration } from './0003-running-instance-run-reference';
import { runCancellationRequestMigration } from './0004-run-cancellation-request';
import { runCancellationDispatchMigration } from './0005-run-cancellation-dispatch';
import { runAttemptDeadlineMigration } from './0006-run-attempt-deadline';
import { completionReceiptJournalMigration } from './0007-completion-receipt-journal';
import { workerRegistryMigration } from './0008-worker-registry';
import { runDispatchLeaseMigration } from './0009-run-dispatch-lease';
import { runDispatchCandidateMigration } from './0010-run-dispatch-candidates';
import { runRetryPolicyMigration } from './0011-run-retry-policy';
import { taskExecutionRevisionMigration } from './0012-task-execution-revisions';
import { localExecutionContextRecipeMigration } from './0013-local-execution-context-recipes';
import { localSecretEnvelopeMigration } from './0014-local-secret-envelopes';
import { localArtifactRetentionMigration } from './0015-local-artifact-retention';
import { localArtifactMaintenanceCursorMigration } from './0016-local-artifact-maintenance-cursor';
import { projectPolicyMigration } from './0017-project-policy';
import { projectOwnerBootstrapMigration } from './0018-project-owner-bootstrap';
import { identityDirectoryMigration } from './0019-identity-directory';
import { approvalRequestMigration } from './0020-approval-requests';
import { approvedActionDispatchExecutionMigration } from './0021-approved-action-dispatch-executions';
import { approvedActionRecoveryMigration } from './0022-approved-action-recovery';
import { approvedRunActionReceiptMigration } from './0023-approved-run-action-receipts';
import { approvedActionRecoveryAuthorizationMigration } from './0024-approved-action-recovery-authorization';
import { legacyColumnsMigration } from './0001-legacy-columns';
import type { Migration } from './types';

export const migrations: Migration[] = [
  legacyColumnsMigration,
  runSchemaMigration,
  runningInstanceRunReferenceMigration,
  runCancellationRequestMigration,
  runCancellationDispatchMigration,
  runAttemptDeadlineMigration,
  completionReceiptJournalMigration,
  workerRegistryMigration,
  runDispatchLeaseMigration,
  runDispatchCandidateMigration,
  runRetryPolicyMigration,
  taskExecutionRevisionMigration,
  localExecutionContextRecipeMigration,
  localSecretEnvelopeMigration,
  localArtifactRetentionMigration,
  localArtifactMaintenanceCursorMigration,
  projectPolicyMigration,
  projectOwnerBootstrapMigration,
  identityDirectoryMigration,
  approvalRequestMigration,
  approvedActionDispatchExecutionMigration,
  approvedActionRecoveryMigration,
  approvedRunActionReceiptMigration,
  approvedActionRecoveryAuthorizationMigration,
];
