import type {
  createLocalPluginPackageWorkflowAdministrationService,
  establishAuthenticatedLocalCommand,
  openLocalSqlitePluginPackageWorkflowAdministrationDatabase,
  PluginPackageWorkflowRunEventListResult,
  PluginPackageWorkflowRunInspectionResult,
  PluginPackageWorkflowRunListResult,
  PluginPackageWorkflowStepRunListResult,
} from './contractAuthority';

export interface LocalPluginPackageWorkflowCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: 'edge' | 'standalone';
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

export interface LocalPluginPackageWorkflowCommandRequestBase {
  readonly projectId: string;
  readonly packageName: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly failureAuditEventId: string;
}

export interface InspectLocalPluginPackageWorkflowCommand {
  readonly schemaVersion: 1;
  readonly operation: 'workflow.inspect';
  readonly options: LocalPluginPackageWorkflowCommandOptions;
  readonly request: LocalPluginPackageWorkflowCommandRequestBase;
}

export interface StartLocalPluginPackageWorkflowCommand {
  readonly schemaVersion: 1;
  readonly operation: 'workflow.start';
  readonly options: LocalPluginPackageWorkflowCommandOptions;
  readonly request: LocalPluginPackageWorkflowCommandRequestBase & {
    readonly workflowId: string;
    readonly planId: string;
    readonly runId: string;
    readonly stepRunIds: Readonly<Record<string, string>>;
  };
}

export interface CancelLocalPluginPackageWorkflowCommand {
  readonly schemaVersion: 1;
  readonly operation: 'workflow.cancel';
  readonly options: LocalPluginPackageWorkflowCommandOptions;
  readonly request: LocalPluginPackageWorkflowCommandRequestBase & {
    readonly runId: string;
    readonly mutationId: string;
    readonly runEventId: string;
  };
}

export interface InspectLocalPluginPackageWorkflowRunCommand {
  readonly schemaVersion: 1;
  readonly operation: 'workflow.run.inspect';
  readonly options: LocalPluginPackageWorkflowCommandOptions;
  readonly request: LocalPluginPackageWorkflowCommandRequestBase & {
    readonly workflowId: string;
    readonly runId: string;
  };
}

export interface ListLocalPluginPackageWorkflowRunsCommand {
  readonly schemaVersion: 1;
  readonly operation: 'workflow.run.list';
  readonly options: LocalPluginPackageWorkflowCommandOptions;
  readonly request: LocalPluginPackageWorkflowCommandRequestBase & {
    readonly workflowId: string;
    readonly limit: number;
    readonly after: Readonly<{ admittedAtMs: number; runId: string }> | null;
  };
}

export interface ListLocalPluginPackageWorkflowStepRunsCommand {
  readonly schemaVersion: 1;
  readonly operation: 'workflow.step.list';
  readonly options: LocalPluginPackageWorkflowCommandOptions;
  readonly request: LocalPluginPackageWorkflowCommandRequestBase & {
    readonly workflowId: string;
    readonly runId: string;
    readonly limit: number;
    readonly after: Readonly<{ stepKey: string; id: string }> | null;
  };
}

export interface ListLocalPluginPackageWorkflowRunEventsCommand {
  readonly schemaVersion: 1;
  readonly operation: 'workflow.event.list';
  readonly options: LocalPluginPackageWorkflowCommandOptions;
  readonly request: LocalPluginPackageWorkflowCommandRequestBase & {
    readonly workflowId: string;
    readonly runId: string;
    readonly limit: number;
    readonly afterSequence: number;
  };
}

export type LocalPluginPackageWorkflowCommand =
  | InspectLocalPluginPackageWorkflowCommand
  | InspectLocalPluginPackageWorkflowRunCommand
  | ListLocalPluginPackageWorkflowRunsCommand
  | ListLocalPluginPackageWorkflowStepRunsCommand
  | ListLocalPluginPackageWorkflowRunEventsCommand
  | StartLocalPluginPackageWorkflowCommand
  | CancelLocalPluginPackageWorkflowCommand;

export type LocalPluginPackageWorkflowCommandResult =
  | Readonly<{
      schemaVersion: 1;
      operation: 'workflow.inspect';
      projectId: string;
      packageName: string;
      found: boolean;
      publicationState: 'active' | 'withdrawn' | 'absent' | null;
      workflows: readonly Readonly<{
        id: string;
        name: string;
        enabled: boolean;
        steps: readonly Readonly<{
          id: string;
          task: string;
          needs: readonly string[];
        }>[];
      }>[];
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'workflow.run.inspect';
      projectId: string;
      packageName: string;
      workflowId: string;
      runId: string;
      found: boolean;
      run: PluginPackageWorkflowRunInspectionResult['run'];
      stepCount: number | null;
      stepStatusCounts: PluginPackageWorkflowRunInspectionResult['stepStatusCounts'];
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'workflow.run.list';
      projectId: string;
      packageName: string;
      workflowId: string;
      after: PluginPackageWorkflowRunListResult['after'];
      runs: PluginPackageWorkflowRunListResult['runs'];
      truncated: boolean;
      next: PluginPackageWorkflowRunListResult['next'];
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'workflow.step.list';
      projectId: string;
      packageName: string;
      workflowId: string;
      runId: string;
      found: boolean;
      stepRuns: PluginPackageWorkflowStepRunListResult['stepRuns'];
      truncated: boolean;
      next: PluginPackageWorkflowStepRunListResult['next'];
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'workflow.event.list';
      projectId: string;
      packageName: string;
      workflowId: string;
      runId: string;
      found: boolean;
      afterSequence: number;
      headSequence: number | null;
      events: PluginPackageWorkflowRunEventListResult['events'];
      truncated: boolean;
      nextAfterSequence: number | null;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'workflow.start';
      status: 'created' | 'existing';
      projectId: string;
      packageName: string;
      workflowId: string;
      runId: string;
      stepCount: number;
      admittedAtMs: number;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'workflow.cancel';
      status:
        | 'accepted'
        | 'existing'
        | 'already_requested'
        | 'already_terminal';
      projectId: string;
      packageName: string;
      workflowId: string;
      runId: string;
      runStatus: string;
      runVersion: number;
      eventSequence: number;
      cancelRequestedAtMs?: number;
      cancelReason?: string;
    }>;

export interface LocalPluginPackageWorkflowCommandRunner {
  run(
    commandFilePath: string,
  ): Promise<LocalPluginPackageWorkflowCommandResult>;
}

export interface LocalPluginPackageWorkflowCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqlitePluginPackageWorkflowAdministrationDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly createService: typeof createLocalPluginPackageWorkflowAdministrationService;
  readonly now: () => number;
}

export class LocalPluginPackageWorkflowCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_WORKFLOW_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(
      `Local Plugin Package Workflow command configuration is invalid: ${message}`,
    );
    this.name = 'LocalPluginPackageWorkflowCommandConfigurationError';
  }
}
