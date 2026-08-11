import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '../../../security/security';
import type { SecurityAuditRecord } from '../../../security/audit/securityAudit';
import type { RunCancellationReason, RunStatus } from '../../../run/run';
import type { StepRunKind, StepRunStatus } from '../../../run/stepRun';
import type {
  PluginPackageWorkflowAdmissionReceipt,
  PluginPackageWorkflowExecutionPlan,
} from '../pluginPackageWorkflowExecutionPlan';

export interface AuthorizedPluginPackageWorkflowAdmission {
  readonly plan: PluginPackageWorkflowExecutionPlan;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface PluginPackageWorkflowAdministrationRepository {
  findPlanByPlanId(
    planId: string,
  ): Promise<Readonly<PluginPackageWorkflowExecutionPlan> | null>;
  admitAuthorized(admission: AuthorizedPluginPackageWorkflowAdmission): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackageWorkflowAdmissionReceipt>;
    }>
  >;
}

export const PLUGIN_PACKAGE_WORKFLOW_CANCELLATION_STATUSES = [
  'accepted',
  'existing',
  'already_requested',
  'already_terminal',
] as const;

export type PluginPackageWorkflowCancellationStatus =
  (typeof PLUGIN_PACKAGE_WORKFLOW_CANCELLATION_STATUSES)[number];

export interface AuthorizedPluginPackageWorkflowCancellation {
  readonly projectId: string;
  readonly packageName: string;
  readonly runId: string;
  readonly mutationId: string;
  readonly runEventId: string;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface PluginPackageWorkflowCancellationResult {
  readonly status: PluginPackageWorkflowCancellationStatus;
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly runStatus: RunStatus;
  readonly runVersion: number;
  readonly eventSequence: number;
  readonly cancelRequestedAtMs?: number;
  readonly cancelReason?: RunCancellationReason;
}

export interface PluginPackageWorkflowCancellationRepository {
  requestUserCancellation(
    cancellation: AuthorizedPluginPackageWorkflowCancellation,
  ): Promise<Readonly<PluginPackageWorkflowCancellationResult>>;
}

export const PLUGIN_PACKAGE_WORKFLOW_RUN_INSPECTION_SCHEMA =
  'qinglong/plugin-package-workflow-run-inspection@v1' as const;

export interface AuthorizedPluginPackageWorkflowRunInspection {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface PluginPackageWorkflowRunInspectionResult {
  readonly schema: typeof PLUGIN_PACKAGE_WORKFLOW_RUN_INSPECTION_SCHEMA;
  readonly found: boolean;
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly run: Readonly<{
    status: RunStatus;
    version: number;
    eventSequence: number;
    createdAtMs: number;
    queuedAtMs: number | null;
    startedAtMs: number | null;
    finishedAtMs: number | null;
    cancelRequestedAtMs: number | null;
    cancelReason: RunCancellationReason | null;
  }> | null;
  readonly stepCount: number | null;
  readonly stepStatusCounts: Readonly<Record<StepRunStatus, number>> | null;
}

export interface PluginPackageWorkflowRunInspectionRepository {
  inspectRunAuthorized(
    inspection: AuthorizedPluginPackageWorkflowRunInspection,
  ): Promise<Readonly<PluginPackageWorkflowRunInspectionResult>>;
}

export const PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_SCHEMA =
  'qinglong/plugin-package-workflow-run-list@v1' as const;
export const DEFAULT_PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_PAGE_SIZE = 32;
export const MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_PAGE_SIZE = 64;

export interface PluginPackageWorkflowRunListCursor {
  readonly admittedAtMs: number;
  readonly runId: string;
}

export interface AuthorizedPluginPackageWorkflowRunList {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly limit: number;
  readonly after: Readonly<PluginPackageWorkflowRunListCursor> | null;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface PluginPackageWorkflowRunListItem {
  readonly runId: string;
  readonly status: RunStatus;
  readonly version: number;
  readonly eventSequence: number;
  readonly stepCount: number;
  readonly admittedAtMs: number;
  readonly queuedAtMs: number | null;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly cancelRequestedAtMs: number | null;
  readonly cancelReason: RunCancellationReason | null;
}

export interface PluginPackageWorkflowRunListResult {
  readonly schema: typeof PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_SCHEMA;
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly after: Readonly<PluginPackageWorkflowRunListCursor> | null;
  readonly runs: readonly Readonly<PluginPackageWorkflowRunListItem>[];
  readonly truncated: boolean;
  readonly next: Readonly<PluginPackageWorkflowRunListCursor> | null;
}

export interface PluginPackageWorkflowRunListRepository {
  listRunsAuthorized(
    query: AuthorizedPluginPackageWorkflowRunList,
  ): Promise<Readonly<PluginPackageWorkflowRunListResult>>;
}

export const PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_SCHEMA =
  'qinglong/plugin-package-workflow-step-run-list@v1' as const;
export const DEFAULT_PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_PAGE_SIZE = 32;
export const MAX_PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_PAGE_SIZE = 64;

export interface PluginPackageWorkflowStepRunCursor {
  readonly stepKey: string;
  readonly id: string;
}

export interface AuthorizedPluginPackageWorkflowStepRunList {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly limit: number;
  readonly after: Readonly<PluginPackageWorkflowStepRunCursor> | null;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface PluginPackageWorkflowStepRunListItem {
  readonly id: string;
  readonly parentStepRunId: string | null;
  readonly stepKey: string;
  readonly kind: StepRunKind;
  readonly required: boolean;
  readonly status: StepRunStatus;
  readonly version: number;
  readonly attemptCount: number;
  readonly readyAtMs: number | null;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly resultCode: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface PluginPackageWorkflowStepRunListResult {
  readonly schema: typeof PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_SCHEMA;
  readonly found: boolean;
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly stepRuns: readonly Readonly<PluginPackageWorkflowStepRunListItem>[];
  readonly truncated: boolean;
  readonly next: Readonly<PluginPackageWorkflowStepRunCursor> | null;
}

export interface PluginPackageWorkflowStepRunListRepository {
  listStepRunsAuthorized(
    query: AuthorizedPluginPackageWorkflowStepRunList,
  ): Promise<Readonly<PluginPackageWorkflowStepRunListResult>>;
}

export const PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_SCHEMA =
  'qinglong/plugin-package-workflow-run-event-list@v1' as const;
export const DEFAULT_PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_PAGE_SIZE = 32;
export const MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_PAGE_SIZE = 64;

export interface AuthorizedPluginPackageWorkflowRunEventList {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly limit: number;
  readonly afterSequence: number;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface PluginPackageWorkflowRunEventListItem {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly stepRunId: string | null;
  readonly createdAtMs: number;
}

export interface PluginPackageWorkflowRunEventListResult {
  readonly schema: typeof PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_SCHEMA;
  readonly found: boolean;
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly afterSequence: number;
  readonly headSequence: number | null;
  readonly events: readonly Readonly<PluginPackageWorkflowRunEventListItem>[];
  readonly truncated: boolean;
  readonly nextAfterSequence: number | null;
}

export interface PluginPackageWorkflowRunEventListRepository {
  listRunEventsAuthorized(
    query: AuthorizedPluginPackageWorkflowRunEventList,
  ): Promise<Readonly<PluginPackageWorkflowRunEventListResult>>;
}
