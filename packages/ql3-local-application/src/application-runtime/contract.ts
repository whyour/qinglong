import type {
  LocalAdoptedProfileBootstrapOptions,
  LocalAdoptedProfileBootstrapResult,
} from '@qinglong/local-admin/adopted-profile';
import type {
  LocalProfileStorageAudit,
  LocalProfileStorageBootstrapResult,
} from '@qinglong/local-sqlite/profile';
import type { LocalRunStartupRecoverySummary } from '@qinglong/local-execution/recovery';
import type { LocalWorkflowTaskStartupRecoverySummary } from '@qinglong/local-execution/recovery';
import type { LocalCompletionReceiptCleanupSummary } from '@qinglong/local-process';
import type {
  LocalExecutionControlCycleSummary,
  LocalExecutionDrainSummary,
} from '@qinglong/local-execution/control';
import type { PluginPackageStageProvider } from '@qinglong/runtime-core/plugin-package-installation';
import type { PluginPackageRecoveryCycleResult } from '@qinglong/runtime-core/plugin-package-recovery';
import type { PluginPackageAutomationPublicationRecoveryCycleResult } from '@qinglong/runtime-core/plugin-package-automation-publication';
import type { PluginPackageTaskPublicationRecoveryCycleResult } from '@qinglong/runtime-core/plugin-package-task-publication';
import type { ProjectToolDefinitionSnapshotRecoveryCycleResult } from '@qinglong/runtime-core/project-tool-definition-snapshot';
import type {
  RunAttemptLogReadRequest,
  RunAttemptLogReadResult,
} from '@qinglong/runtime-core/run-attempt-log-read';

export type LocalApplicationProfile = 'edge' | 'standalone';

export type LocalApplicationActivationState =
  | 'disabled'
  | 'storage_ready'
  | 'plugin_packages_recovered'
  | 'plugin_package_tasks_published'
  | 'plugin_package_automations_published'
  | 'plugin_package_tools_snapshotted'
  | 'secrets_ready'
  | 'runs_recovered'
  | 'receipts_reconciled'
  | 'execution_control_degraded'
  | 'scheduler_degraded'
  | 'recovered'
  | 'lifecycles_started'
  | 'active'
  | 'draining'
  | 'failed'
  | 'stopped';

export type LocalApplicationStopResult = 'stopped' | 'timed_out';

export interface LocalApplicationProductSurfaceAuthority {
  readonly profile: LocalApplicationProfile;
  readonly runs: Pick<
    ReadyFreshStorage['runs'],
    'findRunById' | 'listEvents' | 'listRunsByProject'
  >;
  readonly stepRuns: Awaited<ReturnType<ReadyFreshStorage['stepRunReader']>>;
  readonly runCancellation: Awaited<
    ReturnType<ReadyFreshStorage['runCancellationRepository']>
  >;
  readonly taskStart: Awaited<
    ReturnType<ReadyFreshStorage['taskStartRepository']>
  >;
  readonly taskDefinitions: Pick<
    ReadyFreshStorage['taskDefinitions'],
    'findCurrentTaskDefinition' | 'listTaskDefinitions'
  >;
  readonly runAttemptLogRead: Readonly<{
    read(
      request: Readonly<RunAttemptLogReadRequest>,
    ): Promise<RunAttemptLogReadResult>;
  }>;
  readonly apiCredentials: ReadyFreshStorage['apiCredentials'];
  readonly ownerPepper: ReadyFreshStorage['ownerPepper'];
  readonly projectPolicy: ReadyFreshStorage['projectPolicy'];
  readonly securityAudit: ReadyFreshStorage['securityAudit'];
}

export interface LocalApplicationProductSurfaceLifecycle {
  stopAndDrain(): Promise<LocalApplicationStopResult>;
}

export interface LocalApplicationProductSurface {
  start(
    authority: Readonly<LocalApplicationProductSurfaceAuthority>,
  ): Promise<Readonly<LocalApplicationProductSurfaceLifecycle>>;
}

export interface LocalApplicationPluginPackageRecoveryOptions {
  readonly stageProvider: PluginPackageStageProvider;
  readonly stagingRoot: string;
  readonly activationRoot: string;
  readonly now: () => number;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly taskPublicationPageSize?: number;
  readonly taskPublicationMaxPages?: number;
}

type ReadyAdoptedStorage = Extract<
  LocalAdoptedProfileBootstrapResult,
  { status: 'adopted_storage_ready' }
>;
type ReadyFreshStorage = Extract<
  LocalProfileStorageBootstrapResult,
  { status: 'storage_ready' }
>;

export interface LocalApplicationActivationAudit {
  readonly profile: LocalApplicationProfile;
  readonly state: LocalApplicationActivationState;
  readonly runRecovery?: LocalRunStartupRecoverySummary;
  readonly workflowTaskRecovery?: LocalWorkflowTaskStartupRecoverySummary;
  readonly receiptCleanup?: LocalCompletionReceiptCleanupSummary;
  readonly executionControl?: LocalExecutionControlCycleSummary;
  readonly executionDrain?: LocalExecutionDrainSummary;
  readonly pluginPackageRecovery?: PluginPackageRecoveryCycleResult;
  readonly pluginPackageTaskPublicationRecovery?: PluginPackageTaskPublicationRecoveryCycleResult;
  readonly pluginPackageAutomationPublicationRecovery?: PluginPackageAutomationPublicationRecoveryCycleResult;
  readonly pluginPackageToolSnapshotRecovery?: ProjectToolDefinitionSnapshotRecoveryCycleResult;
}

export interface LocalApplicationDisabledBootstrapOptions {
  readonly enabled?: false;
  readonly profile: LocalApplicationProfile;
  readonly applicationAudit: (
    record: LocalApplicationActivationAudit,
  ) => void | Promise<void>;
}

interface LocalApplicationEnabledBootstrapCommon {
  readonly enabled: true;
  readonly profile: LocalApplicationProfile;
  readonly receiptRoot: string;
  readonly artifactRoot: string;
  readonly secretKeyringPath: string;
  readonly pluginPackages: LocalApplicationPluginPackageRecoveryOptions;
  readonly productSurface?: LocalApplicationProductSurface;
  readonly applicationAudit: (
    record: LocalApplicationActivationAudit,
  ) => void | Promise<void>;
}

export interface LocalApplicationAdoptedBootstrapOptions
  extends LocalApplicationEnabledBootstrapCommon,
    Omit<LocalAdoptedProfileBootstrapOptions, 'enabled' | 'profile'> {
  readonly storageMode?: 'adopted';
}

export interface LocalApplicationFreshBootstrapOptions
  extends LocalApplicationEnabledBootstrapCommon {
  readonly storageMode: 'fresh';
  readonly databasePath: string;
  readonly busyTimeoutMs?: number;
  readonly audit: (record: LocalProfileStorageAudit) => void | Promise<void>;
}

export type LocalApplicationEnabledBootstrapOptions =
  | LocalApplicationAdoptedBootstrapOptions
  | LocalApplicationFreshBootstrapOptions;

export type LocalApplicationBootstrapOptions =
  | LocalApplicationDisabledBootstrapOptions
  | LocalApplicationEnabledBootstrapOptions;

export type LocalApplicationBootstrapResult =
  | {
      readonly status: 'disabled';
      readonly profile: LocalApplicationProfile;
      stop(): Promise<'stopped'>;
    }
  | {
      readonly status: 'active';
      readonly profile: LocalApplicationProfile;
      readonly evidence:
        | ReadyAdoptedStorage['evidence']
        | ReadyFreshStorage['evidence'];
      readonly runs: ReadyAdoptedStorage['runs'] | ReadyFreshStorage['runs'];
      readonly runRecovery: LocalRunStartupRecoverySummary;
      readonly workflowTaskRecovery: LocalWorkflowTaskStartupRecoverySummary;
      readonly receiptCleanup: LocalCompletionReceiptCleanupSummary;
      readonly executionControl: LocalExecutionControlCycleSummary;
      readonly pluginPackageRecovery: PluginPackageRecoveryCycleResult;
      readonly pluginPackageTaskPublicationRecovery: PluginPackageTaskPublicationRecoveryCycleResult;
      readonly pluginPackageAutomationPublicationRecovery: PluginPackageAutomationPublicationRecoveryCycleResult;
      readonly pluginPackageToolSnapshotRecovery: ProjectToolDefinitionSnapshotRecoveryCycleResult;
      stop(): Promise<LocalApplicationStopResult>;
    };
