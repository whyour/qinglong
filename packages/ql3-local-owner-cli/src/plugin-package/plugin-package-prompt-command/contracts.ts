import type {
  establishAuthenticatedLocalCommand,
  LocalSqliteOptionalFeatureRuntimeDatabase,
  ModelGatewayProviderAuthority,
  openLocalSqliteOptionalFeatureRuntimeDatabase,
  PluginPackagePromptCatalogItem,
  PluginPackagePromptExecutionInspection,
  PluginPackagePromptExecutionOutputReadResult,
  PluginPackagePromptOutputArtifactReference,
} from './contractAuthority';

export interface LocalPluginPackagePromptInspectCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: 'edge' | 'standalone';
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

export interface LocalPluginPackagePromptCommandOptions
  extends LocalPluginPackagePromptInspectCommandOptions {
  readonly secretKeyringPath: string;
  readonly providerAuthorityFilePath: string;
  readonly promptOutputKeyringPath?: string;
}

export interface LocalPluginPackagePromptOutputCommandOptions
  extends LocalPluginPackagePromptInspectCommandOptions {
  readonly promptOutputKeyringPath: string;
}

export type LocalPluginPackagePromptOutputIntent =
  | Readonly<{ mode: 'live_only' }>
  | Readonly<{
      mode: 'durable_artifact';
      retentionPolicy: Readonly<{
        revision: string;
        retentionMs: number;
      }>;
    }>;

export interface ExecuteLocalPluginPackagePromptCommand {
  readonly schemaVersion: 1;
  readonly operation: 'prompt.execute';
  readonly options: LocalPluginPackagePromptCommandOptions;
  readonly request: Readonly<{
    projectId: string;
    packageName: string;
    promptId: string;
    requestId: string;
    traceId: string;
    auditEventId: string;
    failureAuditEventId: string;
    parameters: Readonly<Record<string, string>>;
    provider: string;
    model: string;
    maxOutputTokens: number;
    temperature?: number;
    timeoutMs: number;
    output: Readonly<LocalPluginPackagePromptOutputIntent>;
  }>;
}

export interface InspectLocalPluginPackagePromptCommand {
  readonly schemaVersion: 1;
  readonly operation: 'prompt.inspect';
  readonly options: LocalPluginPackagePromptInspectCommandOptions;
  readonly request: Readonly<{
    projectId: string;
    packageName: string;
    requestId: string;
    auditEventId: string;
    failureAuditEventId: string;
  }>;
}

export interface InspectLocalPluginPackagePromptExecutionCommand {
  readonly schemaVersion: 1;
  readonly operation: 'prompt.execution.inspect';
  readonly options: LocalPluginPackagePromptInspectCommandOptions;
  readonly request: Readonly<{
    projectId: string;
    packageName: string;
    promptId: string;
    executionRequestId: string;
    requestId: string;
    auditEventId: string;
    failureAuditEventId: string;
  }>;
}

export interface ReadLocalPluginPackagePromptExecutionOutputCommand {
  readonly schemaVersion: 1;
  readonly operation: 'prompt.execution.output.read';
  readonly options: LocalPluginPackagePromptOutputCommandOptions;
  readonly request: Readonly<{
    projectId: string;
    packageName: string;
    promptId: string;
    executionRequestId: string;
    requestId: string;
    auditEventId: string;
    failureAuditEventId: string;
  }>;
}

export type LocalPluginPackagePromptCommand =
  | ExecuteLocalPluginPackagePromptCommand
  | InspectLocalPluginPackagePromptCommand
  | InspectLocalPluginPackagePromptExecutionCommand
  | ReadLocalPluginPackagePromptExecutionOutputCommand;

export type LocalPluginPackagePromptCommandResult =
  | Readonly<{
      schemaVersion: 1;
      operation: 'prompt.inspect';
      projectId: string;
      packageName: string;
      found: boolean;
      publicationState: 'active' | 'withdrawn' | 'absent' | null;
      prompts: readonly Readonly<PluginPackagePromptCatalogItem>[];
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'prompt.execution.inspect';
      projectId: string;
      packageName: string;
      promptId: string;
      executionRequestId: string;
      found: boolean;
      execution: Readonly<PluginPackagePromptExecutionInspection> | null;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'prompt.execution.output.read';
      projectId: string;
      packageName: string;
      promptId: string;
      executionRequestId: string;
      status: 'not_found';
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'prompt.execution.output.read';
      projectId: string;
      packageName: string;
      promptId: string;
      executionRequestId: string;
      status: 'available';
      reference: Readonly<PluginPackagePromptOutputArtifactReference>;
      result: Extract<
        PluginPackagePromptExecutionOutputReadResult,
        {
          status: 'available';
        }
      >['result'];
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'prompt.execute';
      status: 'executed' | 'resumed' | 'existing';
      projectId: string;
      packageName: string;
      promptId: string;
      requestId: string;
      invocationId: string;
      runId: string;
      stepRunId: string;
      planDigest: string;
      receiptDigest: string;
      finalizationDigest: string;
      runStatus: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
      result: Readonly<{
        provider: string;
        model: string;
        text: string;
        finishReason: string;
        usage: Readonly<{
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          costMicros?: number;
        }>;
      }> | null;
      outputArtifact?: Readonly<PluginPackagePromptOutputArtifactReference>;
    }>;

export interface LocalPluginPackagePromptCommandRunner {
  run(commandFilePath: string): Promise<LocalPluginPackagePromptCommandResult>;
}

export interface LocalPluginPackagePromptCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteOptionalFeatureRuntimeDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly loadProviders: (
    options: Readonly<{
      database: LocalSqliteOptionalFeatureRuntimeDatabase;
      command: Readonly<ExecuteLocalPluginPackagePromptCommand>;
      now: () => number;
    }>,
  ) => Promise<ModelGatewayProviderAuthority>;
  readonly now: () => number;
}

export class LocalPluginPackagePromptCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_PROMPT_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(
      `Local Plugin Package Prompt command configuration is invalid: ${message}`,
    );
    this.name = 'LocalPluginPackagePromptCommandConfigurationError';
  }
}

export class LocalPluginPackagePromptAuthenticationError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_PROMPT_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Local Plugin Package Prompt requires a current strong User');
    this.name = 'LocalPluginPackagePromptAuthenticationError';
  }
}

export class LocalPluginPackagePromptAuthorizationError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_PROMPT_FORBIDDEN';

  constructor() {
    super('Local Plugin Package Prompt is not authorized');
    this.name = 'LocalPluginPackagePromptAuthorizationError';
  }
}

export class LocalPluginPackagePromptNotFoundError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_PROMPT_NOT_FOUND';

  constructor() {
    super('Active Plugin Package Prompt is not available');
    this.name = 'LocalPluginPackagePromptNotFoundError';
  }
}

export class LocalPluginPackagePromptUnavailableError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_PROMPT_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Local Plugin Package Prompt is unavailable', options);
    this.name = 'LocalPluginPackagePromptUnavailableError';
  }
}
