import type { OpenPostgresDatabase, PostgresPool } from '@qinglong/runtime-core';
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';

import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../migration/modelInvocationMigration';
import type { ExecutePluginPackagePromptResult, PluginPackagePromptExecutor } from '../pluginPackagePromptExecutor';
import type {
  PreparePluginPackagePromptOutputIntent,
  PluginPackagePromptExecutionPolicyFence,
} from '../pluginPackagePromptExecution';
import type {
  PluginPackagePromptOutputArtifactKeyProvider,
  PluginPackagePromptOutputArtifactReadAuthorizer,
} from '../../prompt-output/pluginPackagePromptOutputArtifact';
import type {
  PluginPackagePromptOutputArtifactRetentionStateReader,
  PluginPackagePromptOutputReadService,
} from '../../prompt-output/pluginPackagePromptOutputRead';
import type { PluginPackagePromptExecutionOutputReadService } from '../../prompt-output/pluginPackagePromptExecutionOutputRead';
import type {
  ActiveModelGatewayCapability,
  ModelGatewayProfileAudit,
  ModelGatewayProviderAuthority,
} from '../../profile/profileComposition';
import type { DurableModelInvocationCoordinator } from '../../model-invocation/durableModelInvocationCoordinator';
import type { ModelInvocationSuccessfulCompletionSink } from '../../model-gateway/gateway';
import type { PluginPackagePromptCatalogCapability } from '../pluginPackagePromptCatalog';
import type { PluginPackagePromptExecutionInspectionRepository } from '../pluginPackagePromptExecutionInspection';

export interface PostgresPluginPackagePromptExecutionCommand {
  readonly projectId: string;
  readonly packageName: string;
  readonly promptId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly auditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policyFence: Readonly<PluginPackagePromptExecutionPolicyFence>;
  readonly parameters: Readonly<Record<string, string>>;
  readonly provider: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly deadlineAtMs: number;
  readonly plannedAtMs: number;
  readonly output?: Readonly<PreparePluginPackagePromptOutputIntent>;
  readonly signal?: AbortSignal;
}

export interface PostgresPluginPackagePromptExecutionCapability {
  execute(
    command: Readonly<PostgresPluginPackagePromptExecutionCommand>,
  ): Promise<Readonly<ExecutePluginPackagePromptResult>>;
}

export interface PostgresPluginPackagePromptReadinessReport {
  readonly schema: typeof POSTGRES_MODEL_INVOCATION_SCHEMA;
  readonly migrationStreamId: string;
  readonly migrationCount: number;
  readonly currentUser: string;
  readonly runtimeAuthority: true;
  readonly appendOnly: true;
}

export type BootstrapPostgresPluginPackagePromptApplicationOptions =
  | Readonly<{
      enabled?: false;
      audit: (
        record: Readonly<ModelGatewayProfileAudit>,
      ) => void | Promise<void>;
    }>
  | Readonly<{
      enabled: true;
      openDatabase: OpenPostgresDatabase;
      loadProviders: () => Promise<ModelGatewayProviderAuthority>;
      audit: (
        record: Readonly<ModelGatewayProfileAudit>,
      ) => void | Promise<void>;
      assertReady?: (
        pool: PostgresPool,
      ) => Promise<Readonly<PostgresPluginPackagePromptReadinessReport>>;
      confirmActive?: () => void | Promise<void>;
      maxConcurrent?: number;
      recoveryLimit?: number;
      now?: () => number;
      createAdditionalSuccessfulCompletion?: (
        coordinator: DurableModelInvocationCoordinator,
      ) => ModelInvocationSuccessfulCompletionSink;
      promptOutputKeys?: PluginPackagePromptOutputArtifactKeyProvider;
      promptOutputRead?: Readonly<{
        authorizer: PluginPackagePromptOutputArtifactReadAuthorizer;
        retention?: PluginPackagePromptOutputArtifactRetentionStateReader;
      }>;
    }>;

export type BootstrapPostgresPluginPackagePromptApplicationResult =
  | Readonly<{
      status: 'disabled';
      profile: 'cluster';
      stop(): Promise<'stopped'>;
    }>
  | Readonly<{
      status: 'active';
      profile: 'cluster';
      readiness: Readonly<PostgresPluginPackagePromptReadinessReport>;
      capability: ActiveModelGatewayCapability;
      prompts: PluginPackagePromptExecutor;
      promptCatalog: PluginPackagePromptCatalogCapability;
      promptExecutions: PostgresPluginPackagePromptExecutionCapability;
      promptExecutionInspections: PluginPackagePromptExecutionInspectionRepository;
      promptOutputs?: PluginPackagePromptOutputReadService;
      promptExecutionOutputs?: PluginPackagePromptExecutionOutputReadService;
      stop(): Promise<'draining' | 'stopped'>;
    }>;

export class PostgresPluginPackagePromptApplicationUnavailableError extends Error {
  readonly code = 'POSTGRES_PLUGIN_PACKAGE_PROMPT_APPLICATION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('The PostgreSQL Package Prompt application is unavailable', options);
    this.name = 'PostgresPluginPackagePromptApplicationUnavailableError';
  }
}

export function unavailable(
  cause?: unknown,
): PostgresPluginPackagePromptApplicationUnavailableError {
  return new PostgresPluginPackagePromptApplicationUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}
