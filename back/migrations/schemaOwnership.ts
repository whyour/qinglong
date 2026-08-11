import { legacyColumnOwnership } from './0001-legacy-columns';
import {
  RUN_ATTEMPT_TABLE,
  RUN_EVENT_TABLE,
  RUN_TABLE,
  runSchemaManifest,
} from './0002-run-schema';
import {
  RUNNING_INSTANCE_TABLE,
  runningInstanceRunReferenceManifest,
} from './0003-running-instance-run-reference';
import { runCancellationRequestManifest } from './0004-run-cancellation-request';
import {
  RUN_CANCELLATION_DISPATCH_TABLE,
  runCancellationDispatchManifest,
} from './0005-run-cancellation-dispatch';
import { runAttemptDeadlineManifest } from './0006-run-attempt-deadline';
import {
  COMPLETION_RECEIPT_JOURNAL_TABLE,
  completionReceiptJournalManifest,
} from './0007-completion-receipt-journal';
import {
  WORKER_REGISTRY_TABLE,
  workerRegistryManifest,
} from './0008-worker-registry';
import {
  RUN_DISPATCH_LEASE_TABLE,
  runDispatchLeaseManifest,
} from './0009-run-dispatch-lease';
import { runDispatchCandidateManifest } from './0010-run-dispatch-candidates';
import {
  RUN_RETRY_POLICY_TABLE,
  runRetryPolicyManifest,
} from './0011-run-retry-policy';
import {
  TASK_EXECUTION_REVISION_TABLE,
  taskExecutionRevisionManifest,
} from './0012-task-execution-revisions';
import {
  LOCAL_EXECUTION_CONTEXT_RECIPE_TABLE,
  localExecutionContextRecipeManifest,
} from './0013-local-execution-context-recipes';
import {
  LOCAL_SECRET_ENVELOPE_TABLE,
  localSecretEnvelopeManifest,
} from './0014-local-secret-envelopes';
import {
  LOCAL_ARTIFACT_RETENTION_TABLE,
  localArtifactRetentionManifest,
} from './0015-local-artifact-retention';
import {
  LOCAL_ARTIFACT_MAINTENANCE_CURSOR_TABLE,
  localArtifactMaintenanceCursorManifest,
} from './0016-local-artifact-maintenance-cursor';
import {
  PROJECT_ROLE_BINDING_TABLE,
  PROJECT_TABLE,
  projectPolicyManifest,
} from './0017-project-policy';
import {
  PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE,
  projectOwnerBootstrapManifest,
} from './0018-project-owner-bootstrap';
import {
  IDENTITY_AUTHENTICATION_BINDING_TABLE,
  IDENTITY_SUBJECT_TABLE,
  identityDirectoryManifest,
} from './0019-identity-directory';
import {
  APPROVAL_REQUEST_TABLE,
  APPROVED_ACTION_DISPATCH_TABLE,
  approvalRequestManifest,
} from './0020-approval-requests';
import {
  APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
  approvedActionDispatchExecutionManifest,
} from './0021-approved-action-dispatch-executions';
import {
  APPROVED_ACTION_RECOVERY_CONTROL_TABLE,
  APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
  approvedActionRecoveryManifest,
} from './0022-approved-action-recovery';
import {
  APPROVED_RUN_ACTION_RECEIPT_TABLE,
  approvedRunActionReceiptManifest,
} from './0023-approved-run-action-receipts';
import {
  APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE,
  approvedActionRecoveryAuthorizationManifest,
} from './0024-approved-action-recovery-authorization';

export type SchemaOwnershipMode = 'full' | 'extension' | 'unmanaged-legacy';

export interface SqliteTableOwnership {
  name: string;
  mode: SchemaOwnershipMode;
  requiredColumns: readonly string[];
}

export interface SqliteIndexOwnership {
  name: string;
}

export interface SqliteSchemaOwnershipManifest {
  version: 1;
  database: 'database.sqlite';
  migrationIds: readonly string[];
  tables: readonly SqliteTableOwnership[];
  indexes: readonly SqliteIndexOwnership[];
  constraints: readonly string[];
  unknownObjectPolicy: 'preserve-and-report';
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function indexName(definition: string): string {
  const boundary = definition.indexOf('(');
  return boundary === -1 ? definition : definition.slice(0, boundary);
}

function legacyColumns(table: string): string[] {
  return legacyColumnOwnership
    .filter((definition) => definition.table === table)
    .map((definition) => definition.column);
}

export const sqliteSchemaOwnership: SqliteSchemaOwnershipManifest = {
  version: 1,
  database: 'database.sqlite',
  migrationIds: [
    '0001-legacy-columns',
    '0002-run-schema',
    '0003-running-instance-run-reference',
    '0004-run-cancellation-request',
    '0005-run-cancellation-dispatch',
    '0006-run-attempt-deadline',
    '0007-completion-receipt-journal',
    '0008-worker-registry',
    '0009-run-dispatch-lease',
    '0010-run-dispatch-candidates',
    '0011-run-retry-policy',
    '0012-task-execution-revisions',
    '0013-local-execution-context-recipes',
    '0014-local-secret-envelopes',
    '0015-local-artifact-retention',
    '0016-local-artifact-maintenance-cursor',
    '0017-project-policy',
    '0018-project-owner-bootstrap',
    '0019-identity-directory',
    '0020-approval-requests',
    '0021-approved-action-dispatch-executions',
    '0022-approved-action-recovery',
    '0023-approved-run-action-receipts',
    '0024-approved-action-recovery-authorization',
  ],
  tables: [
    {
      name: 'SchemaMigrations',
      mode: 'full',
      requiredColumns: ['id', 'checksum', 'applied_at'],
    },
    {
      name: 'Apps',
      mode: 'unmanaged-legacy',
      requiredColumns: [],
    },
    {
      name: 'Auths',
      mode: 'unmanaged-legacy',
      requiredColumns: [],
    },
    {
      name: 'CrontabStats',
      mode: 'unmanaged-legacy',
      requiredColumns: [],
    },
    {
      name: 'Dependences',
      mode: 'unmanaged-legacy',
      requiredColumns: [],
    },
    {
      name: 'CrontabViews',
      mode: 'extension',
      requiredColumns: legacyColumns('CrontabViews'),
    },
    {
      name: 'Subscriptions',
      mode: 'extension',
      requiredColumns: legacyColumns('Subscriptions'),
    },
    {
      name: 'Crontabs',
      mode: 'extension',
      requiredColumns: legacyColumns('Crontabs'),
    },
    {
      name: 'Envs',
      mode: 'extension',
      requiredColumns: legacyColumns('Envs'),
    },
    {
      name: RUN_TABLE,
      mode: 'full',
      requiredColumns: unique([
        ...runSchemaManifest.tables.Runs,
        ...Object.keys(runCancellationRequestManifest.columns),
      ]),
    },
    {
      name: RUN_ATTEMPT_TABLE,
      mode: 'full',
      requiredColumns: unique([
        ...runSchemaManifest.tables.RunAttempts,
        ...Object.keys(runAttemptDeadlineManifest.columns),
      ]),
    },
    {
      name: RUN_EVENT_TABLE,
      mode: 'full',
      requiredColumns: runSchemaManifest.tables.RunEvents,
    },
    {
      name: RUNNING_INSTANCE_TABLE,
      mode: 'extension',
      requiredColumns: Object.keys(runningInstanceRunReferenceManifest.columns),
    },
    {
      name: RUN_CANCELLATION_DISPATCH_TABLE,
      mode: 'full',
      requiredColumns: runCancellationDispatchManifest.columns,
    },
    {
      name: COMPLETION_RECEIPT_JOURNAL_TABLE,
      mode: 'full',
      requiredColumns: completionReceiptJournalManifest.columns,
    },
    {
      name: WORKER_REGISTRY_TABLE,
      mode: 'full',
      requiredColumns: workerRegistryManifest.columns,
    },
    {
      name: RUN_DISPATCH_LEASE_TABLE,
      mode: 'full',
      requiredColumns: runDispatchLeaseManifest.columns,
    },
    {
      name: RUN_RETRY_POLICY_TABLE,
      mode: 'full',
      requiredColumns: runRetryPolicyManifest.columns,
    },
    {
      name: TASK_EXECUTION_REVISION_TABLE,
      mode: 'full',
      requiredColumns: taskExecutionRevisionManifest.columns,
    },
    {
      name: LOCAL_EXECUTION_CONTEXT_RECIPE_TABLE,
      mode: 'full',
      requiredColumns: localExecutionContextRecipeManifest.columns,
    },
    {
      name: LOCAL_SECRET_ENVELOPE_TABLE,
      mode: 'full',
      requiredColumns: localSecretEnvelopeManifest.columns,
    },
    {
      name: LOCAL_ARTIFACT_RETENTION_TABLE,
      mode: 'full',
      requiredColumns: localArtifactRetentionManifest.columns,
    },
    {
      name: LOCAL_ARTIFACT_MAINTENANCE_CURSOR_TABLE,
      mode: 'full',
      requiredColumns: localArtifactMaintenanceCursorManifest.columns,
    },
    {
      name: PROJECT_TABLE,
      mode: 'full',
      requiredColumns: projectPolicyManifest.tables.Projects,
    },
    {
      name: PROJECT_ROLE_BINDING_TABLE,
      mode: 'full',
      requiredColumns: projectPolicyManifest.tables.ProjectRoleBindings,
    },
    {
      name: PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE,
      mode: 'full',
      requiredColumns: projectOwnerBootstrapManifest.columns,
    },
    {
      name: IDENTITY_SUBJECT_TABLE,
      mode: 'full',
      requiredColumns: identityDirectoryManifest.tables.IdentitySubjects,
    },
    {
      name: IDENTITY_AUTHENTICATION_BINDING_TABLE,
      mode: 'full',
      requiredColumns:
        identityDirectoryManifest.tables.IdentityAuthenticationBindings,
    },
    {
      name: APPROVAL_REQUEST_TABLE,
      mode: 'full',
      requiredColumns: approvalRequestManifest.tables.ApprovalRequests,
    },
    {
      name: APPROVED_ACTION_DISPATCH_TABLE,
      mode: 'full',
      requiredColumns: approvalRequestManifest.tables.ApprovedActionDispatches,
    },
    {
      name: APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
      mode: 'full',
      requiredColumns: approvedActionDispatchExecutionManifest.columns,
    },
    {
      name: APPROVED_ACTION_RECOVERY_CONTROL_TABLE,
      mode: 'full',
      requiredColumns:
        approvedActionRecoveryManifest.tables.ApprovedActionRecoveryControls,
    },
    {
      name: APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
      mode: 'full',
      requiredColumns:
        approvedActionRecoveryManifest.tables.ApprovedActionRecoveryResolutions,
    },
    {
      name: APPROVED_RUN_ACTION_RECEIPT_TABLE,
      mode: 'full',
      requiredColumns: approvedRunActionReceiptManifest.columns,
    },
    {
      name: APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE,
      mode: 'full',
      requiredColumns: approvedActionRecoveryAuthorizationManifest.columns,
    },
  ],
  indexes: unique([
    ...runSchemaManifest.indexes,
    ...runningInstanceRunReferenceManifest.indexes.map(indexName),
    ...runCancellationRequestManifest.indexes.map(indexName),
    ...runCancellationDispatchManifest.indexes.map(indexName),
    ...runAttemptDeadlineManifest.indexes.map(indexName),
    ...completionReceiptJournalManifest.indexes.map(indexName),
    ...workerRegistryManifest.indexes.map(indexName),
    ...runDispatchLeaseManifest.indexes.map(indexName),
    ...runDispatchCandidateManifest.indexes.map(indexName),
    ...runRetryPolicyManifest.indexes.map(indexName),
    ...taskExecutionRevisionManifest.indexes.map(indexName),
    ...localExecutionContextRecipeManifest.indexes.map(indexName),
    ...localSecretEnvelopeManifest.indexes.map(indexName),
    ...localArtifactRetentionManifest.indexes.map(indexName),
    ...localArtifactMaintenanceCursorManifest.indexes.map(indexName),
    ...projectPolicyManifest.indexes.map(indexName),
    ...projectOwnerBootstrapManifest.indexes.map(indexName),
    ...identityDirectoryManifest.indexes.map(indexName),
    ...approvalRequestManifest.indexes.map(indexName),
    ...approvedActionDispatchExecutionManifest.indexes.map(indexName),
    ...approvedActionRecoveryManifest.indexes.map(indexName),
    ...approvedRunActionReceiptManifest.indexes.map(indexName),
    ...approvedActionRecoveryAuthorizationManifest.indexes.map(indexName),
  ]).map((name) => ({ name })),
  constraints: unique([
    ...runSchemaManifest.constraints,
    ...runCancellationDispatchManifest.constraints,
    ...completionReceiptJournalManifest.constraints,
    ...workerRegistryManifest.constraints,
    ...runDispatchLeaseManifest.constraints,
    ...runRetryPolicyManifest.constraints,
    ...taskExecutionRevisionManifest.constraints,
    ...localExecutionContextRecipeManifest.constraints,
    ...localSecretEnvelopeManifest.constraints,
    ...localArtifactRetentionManifest.constraints,
    ...localArtifactMaintenanceCursorManifest.constraints,
    ...projectPolicyManifest.constraints,
    ...projectOwnerBootstrapManifest.constraints,
    ...identityDirectoryManifest.constraints,
    ...approvalRequestManifest.constraints,
    ...approvedActionDispatchExecutionManifest.constraints,
    ...approvedActionRecoveryManifest.constraints,
    ...approvedRunActionReceiptManifest.constraints,
    ...approvedActionRecoveryAuthorizationManifest.constraints,
  ]),
  unknownObjectPolicy: 'preserve-and-report',
};
