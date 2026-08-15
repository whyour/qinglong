import type { ModelGatewayProfileAudit } from '@qinglong/ai/profile';
import type { DurableModelInvocationCoordinator } from '@qinglong/ai/durable-model-invocation';
import { CopilotFailureDiagnosisModelCompletionCoordinator } from '@qinglong/ai/failure-diagnosis-model-execution';
import type { CopilotFailureDiagnosisApplicationService } from '@qinglong/ai/failure-diagnosis-application';
import type { CopilotFailureDiagnosisCancellationService } from '@qinglong/ai/failure-diagnosis-cancellation';
import { BoundModelProviderCredentialProvider } from '@qinglong/ai/provider-credential';
import { PostgresModelProviderCredentialReader } from '@qinglong/ai/postgres-model-provider-credential-storage';
import { loadProjectedModelGatewayProviderAuthority } from '@qinglong/ai/projected-model-gateway-authority';
import { createProjectedModelProviderSecretMaterialProvider } from '@qinglong/ai/projected-model-provider-secret-material';
import { createPluginPackagePromptOutputProjectedKeyring } from '@qinglong/ai/plugin-package-prompt-output-projected-keyring';
import {
  bootstrapPostgresPluginPackagePromptApplication,
  type BootstrapPostgresPluginPackagePromptApplicationResult,
} from '@qinglong/ai/postgres-plugin-package-prompt-application';
import { createPostgresDatabaseOpener } from '@qinglong/cluster-postgres/runtime';
import { PostgresProjectPolicyRepository } from '@qinglong/cluster-postgres/project-policy';
import type { ClusterControlStopResult } from '@qinglong/runtime-core';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';

import type { ClusterControlApplicationResult } from './application';
import type {
  ClusterControlEnvironment,
  EnabledClusterControlConfig,
} from '../production-process/config';
import {
  startProductionClusterControlApplication,
  type ProductionClusterControlApplicationOptions,
} from './productionApplication';
import {
  createProductionClusterCopilotFailureDiagnosis,
  prepareProductionClusterCopilotFailureDiagnosisProjection,
  type ClusterCopilotFailureDiagnosisProjection,
  type CreateProductionClusterCopilotFailureDiagnosisOptions,
} from './copilot/failureDiagnosisComposition';
import {
  createProductionClusterCopilotFailureDiagnosisReadService,
  type CreateProductionClusterCopilotFailureDiagnosisReadServiceOptions,
} from './copilot/failureDiagnosisReadComposition';
import {
  createProductionClusterCopilotFailureDiagnosisCancellation,
  type CreateProductionClusterCopilotFailureDiagnosisCancellationOptions,
} from './copilot/failureDiagnosisCancellationComposition';

export interface EnabledProductionClusterAiConfig {
  readonly enabled: true;
  readonly providerAuthorityFile: string;
  readonly secretRootDirectory: string;
  readonly promptOutputKeyringRootDirectory?: string;
  readonly copilot?: Readonly<ClusterCopilotFailureDiagnosisProjection>;
  readonly maxConcurrent: number;
  readonly recoveryLimit: number;
  readonly databaseMaxConnections: number;
}

export interface ProductionClusterAiControlApplicationOptions {
  readonly control: ProductionClusterControlApplicationOptions;
  readonly ai: EnabledProductionClusterAiConfig;
  readonly audit: (
    record: Readonly<ModelGatewayProfileAudit>,
  ) => void | Promise<void>;
  readonly startControl?: typeof startProductionClusterControlApplication;
  readonly bootstrapPrompt?: typeof bootstrapPostgresPluginPackagePromptApplication;
  readonly createCopilot?: (
    options: CreateProductionClusterCopilotFailureDiagnosisOptions,
  ) => Promise<Readonly<CopilotFailureDiagnosisApplicationService>>;
  readonly createCopilotRead?: (
    options: CreateProductionClusterCopilotFailureDiagnosisReadServiceOptions,
  ) => ReturnType<
    typeof createProductionClusterCopilotFailureDiagnosisReadService
  >;
  readonly createCopilotCancellation?: (
    options: CreateProductionClusterCopilotFailureDiagnosisCancellationOptions,
  ) => Readonly<CopilotFailureDiagnosisCancellationService>;
  readonly openAiDatabase?: ReturnType<typeof createPostgresDatabaseOpener>;
}

export type ProductionClusterAiControlApplicationResult = Extract<
  ClusterControlApplicationResult,
  { readonly status: 'active' }
> &
  Readonly<{ copilot?: Readonly<CopilotFailureDiagnosisApplicationService> }>;

export class ProductionClusterAiConfigError extends TypeError {
  readonly code = 'QL3_CLUSTER_AI_CONFIG_INVALID';

  constructor(message: string) {
    super(`Cluster AI configuration is invalid: ${message}`);
    this.name = 'ProductionClusterAiConfigError';
  }
}

function booleanValue(
  environment: ClusterControlEnvironment,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = environment[name];
  if (value === undefined || value === '') return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ProductionClusterAiConfigError(`${name} must be true or false`);
}

function boundedInteger(
  environment: ClusterControlEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = environment[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ProductionClusterAiConfigError(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProductionClusterAiConfigError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function requiredPath(
  environment: ClusterControlEnvironment,
  name: string,
): string {
  const value = environment[name];
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    value.length > 4096 ||
    !value.startsWith('/') ||
    /[\0\r\n]/.test(value)
  ) {
    throw new ProductionClusterAiConfigError(`${name} is invalid`);
  }
  return value;
}

/** Parsed only by the explicit AI process entrypoint; the default CLI ignores it. */
export function loadProductionClusterAiConfig(
  environment: ClusterControlEnvironment,
): EnabledProductionClusterAiConfig {
  if (
    !environment ||
    typeof environment !== 'object' ||
    Array.isArray(environment) ||
    !booleanValue(environment, 'QL3_CLUSTER_AI_ENABLED', false)
  ) {
    throw new ProductionClusterAiConfigError(
      'QL3_CLUSTER_AI_ENABLED must be true',
    );
  }
  const promptOutputEnabled = booleanValue(
    environment,
    'QL3_CLUSTER_AI_PROMPT_OUTPUT_ENABLED',
    false,
  );
  const copilotEnabled = booleanValue(
    environment,
    'QL3_CLUSTER_AI_COPILOT_ENABLED',
    false,
  );
  return Object.freeze({
    enabled: true,
    providerAuthorityFile: requiredPath(
      environment,
      'QL3_CLUSTER_AI_PROVIDER_AUTHORITY_FILE',
    ),
    secretRootDirectory: requiredPath(
      environment,
      'QL3_CLUSTER_AI_SECRET_ROOT',
    ),
    ...(promptOutputEnabled
      ? {
          promptOutputKeyringRootDirectory: requiredPath(
            environment,
            'QL3_CLUSTER_AI_PROMPT_OUTPUT_KEYRING_ROOT',
          ),
        }
      : {}),
    ...(copilotEnabled
      ? {
          copilot: Object.freeze({
            configFile: requiredPath(
              environment,
              'QL3_CLUSTER_AI_COPILOT_CONFIG_FILE',
            ),
            invocationKeyringRootDirectory: requiredPath(
              environment,
              'QL3_CLUSTER_AI_COPILOT_INVOCATION_KEYRING_ROOT',
            ),
            resultKeyringRootDirectory: requiredPath(
              environment,
              'QL3_CLUSTER_AI_COPILOT_RESULT_KEYRING_ROOT',
            ),
            outputKeyringRootDirectory: requiredPath(
              environment,
              'QL3_CLUSTER_AI_COPILOT_OUTPUT_KEYRING_ROOT',
            ),
          }),
        }
      : {}),
    maxConcurrent: boundedInteger(
      environment,
      'QL3_CLUSTER_AI_MAX_CONCURRENT',
      4,
      1,
      64,
    ),
    recoveryLimit: boundedInteger(
      environment,
      'QL3_CLUSTER_AI_RECOVERY_LIMIT',
      32,
      1,
      128,
    ),
    databaseMaxConnections: boundedInteger(
      environment,
      'QL3_CLUSTER_AI_DATABASE_MAX_CONNECTIONS',
      4,
      1,
      16,
    ),
  });
}

function aiDatabaseOpener(
  control: EnabledClusterControlConfig,
  ai: EnabledProductionClusterAiConfig,
  onUnavailable: (error: Error) => void,
) {
  return createPostgresDatabaseOpener({
    role: 'runtime',
    connection: control.database.connection,
    pool: {
      ...control.database.pool,
      applicationName: 'qinglong-cluster-ai',
      maxConnections: ai.databaseMaxConnections,
    },
    onPoolError: onUnavailable,
  });
}

/**
 * Explicit AI-enabled composition root. It keeps the normal control image and
 * process AI-free while sharing the reviewed authentication/Policy pipeline
 * and route registry when the separate AI image entrypoint is selected.
 */
export async function startProductionClusterAiControlApplication(
  options: ProductionClusterAiControlApplicationOptions,
): Promise<ProductionClusterAiControlApplicationResult> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.audit !== 'function'
  ) {
    throw new TypeError(
      'Production Cluster AI application options are invalid',
    );
  }
  const startControl =
    options.startControl ?? startProductionClusterControlApplication;
  const bootstrapPrompt =
    options.bootstrapPrompt ?? bootstrapPostgresPluginPackagePromptApplication;
  const createCopilot =
    options.createCopilot ?? createProductionClusterCopilotFailureDiagnosis;
  const createCopilotRead =
    options.createCopilotRead ??
    createProductionClusterCopilotFailureDiagnosisReadService;
  const createCopilotCancellation =
    options.createCopilotCancellation ??
    createProductionClusterCopilotFailureDiagnosisCancellation;
  if (
    typeof startControl !== 'function' ||
    typeof bootstrapPrompt !== 'function' ||
    typeof createCopilot !== 'function' ||
    typeof createCopilotRead !== 'function' ||
    typeof createCopilotCancellation !== 'function' ||
    (options.openAiDatabase !== undefined &&
      typeof options.openAiDatabase !== 'function')
  ) {
    throw new TypeError(
      'Production Cluster AI application factories are invalid',
    );
  }
  const copilotArtifactStore = options.control.workerIngress?.artifactStore;
  if (
    options.ai.copilot !== undefined &&
    typeof copilotArtifactStore?.readLogRange !== 'function'
  ) {
    throw new TypeError(
      'Cluster Copilot requires the bounded Worker log Artifact read capability',
    );
  }
  const secretMaterial =
    await createProjectedModelProviderSecretMaterialProvider({
      rootDirectory: options.ai.secretRootDirectory,
    });
  const promptOutputKeys =
    options.ai.promptOutputKeyringRootDirectory === undefined
      ? undefined
      : await createPluginPackagePromptOutputProjectedKeyring({
          rootDirectory: options.ai.promptOutputKeyringRootDirectory,
        });
  const preparedCopilot =
    options.ai.copilot === undefined
      ? undefined
      : await prepareProductionClusterCopilotFailureDiagnosisProjection(
          options.ai.copilot,
        );
  let aiDatabase:
    | Awaited<ReturnType<ReturnType<typeof createPostgresDatabaseOpener>>>
    | undefined;
  let resolveAiUnavailable: ((error: Error) => void) | undefined;
  let aiUnavailableError: Error | undefined;
  const aiUnavailable = new Promise<Error>((resolve) => {
    resolveAiUnavailable = resolve;
  });
  const onAiUnavailable = (error: Error): void => {
    aiUnavailableError ??= error;
    resolveAiUnavailable?.(aiUnavailableError);
    resolveAiUnavailable = undefined;
  };
  let promptApplication:
    | BootstrapPostgresPluginPackagePromptApplicationResult
    | undefined;
  let controlApplication: ClusterControlApplicationResult | undefined;
  let copilotApplication:
    | Readonly<CopilotFailureDiagnosisApplicationService>
    | undefined;
  let copilotReadApplication:
    | ReturnType<
        typeof createProductionClusterCopilotFailureDiagnosisReadService
      >
    | undefined;
  let copilotCancellationApplication:
    | Readonly<CopilotFailureDiagnosisCancellationService>
    | undefined;
  let copilotSuccessfulCompletion:
    | CopilotFailureDiagnosisModelCompletionCoordinator
    | undefined;
  let stopPromise: Promise<ClusterControlStopResult> | undefined;
  let promptOutputPolicy: ProjectPolicyEngine | undefined;
  const promptOutputReadAuthorizer = Object.freeze({
    async authorize(
      request: Readonly<{
        principal: Parameters<ProjectPolicyEngine['authorize']>[0];
        projectId: string;
      }>,
    ) {
      if (!aiDatabase) {
        throw new Error(
          'Cluster AI database is unavailable during output read',
        );
      }
      promptOutputPolicy ??= new ProjectPolicyEngine(
        new PostgresProjectPolicyRepository(aiDatabase.pool),
      );
      const decision = await promptOutputPolicy.authorize(
        request.principal,
        request.projectId,
        'artifact.read',
      );
      return decision.effect === 'allow'
        ? Object.freeze({ effect: 'allow' as const })
        : Object.freeze({
            effect: decision.effect,
            reasonCode: 'artifact_read_denied',
          });
    },
  });
  const stop = async (): Promise<ClusterControlStopResult> => {
    stopPromise ??= (async () => {
      const controlResult =
        controlApplication?.status === 'active'
          ? await controlApplication.stop()
          : 'stopped';
      const promptResult = await promptApplication?.stop();
      return controlResult === 'stopped' &&
        (promptResult === undefined || promptResult === 'stopped')
        ? 'stopped'
        : 'timed_out';
    })();
    return stopPromise;
  };
  try {
    const openDatabase =
      options.openAiDatabase ??
      aiDatabaseOpener(options.control.config, options.ai, onAiUnavailable);
    promptApplication = await bootstrapPrompt({
      enabled: true,
      async openDatabase() {
        if (aiDatabase) {
          throw new Error('Cluster AI database was opened more than once');
        }
        aiDatabase = await openDatabase();
        return aiDatabase;
      },
      async loadProviders() {
        if (!aiDatabase) {
          throw new Error(
            'Cluster AI database is unavailable during provider load',
          );
        }
        const credentialStorage = new PostgresModelProviderCredentialReader(
          aiDatabase.pool,
        );
        const credentials = new BoundModelProviderCredentialProvider({
          bindings: credentialStorage,
          secrets: secretMaterial,
          audit: credentialStorage,
        });
        return loadProjectedModelGatewayProviderAuthority({
          configFile: options.ai.providerAuthorityFile,
          credentials,
        });
      },
      audit: options.audit,
      maxConcurrent: options.ai.maxConcurrent,
      recoveryLimit: options.ai.recoveryLimit,
      ...(promptOutputKeys === undefined
        ? {}
        : {
            promptOutputKeys,
            promptOutputRead: { authorizer: promptOutputReadAuthorizer },
          }),
      ...(preparedCopilot === undefined
        ? {}
        : {
            createAdditionalSuccessfulCompletion(
              coordinator: DurableModelInvocationCoordinator,
            ) {
              if (copilotSuccessfulCompletion) {
                throw new Error(
                  'Cluster Copilot completion was created more than once',
                );
              }
              copilotSuccessfulCompletion =
                new CopilotFailureDiagnosisModelCompletionCoordinator({
                  coordinator,
                  keys: preparedCopilot.outputKeys,
                });
              return copilotSuccessfulCompletion;
            },
          }),
    });
    if (promptApplication.status !== 'active') {
      throw new Error('Cluster AI Prompt application did not activate');
    }
    if (preparedCopilot !== undefined) {
      if (
        !copilotSuccessfulCompletion ||
        !aiDatabase ||
        !copilotArtifactStore
      ) {
        throw new Error('Cluster Copilot shared authorities did not activate');
      }
      copilotApplication = await createCopilot({
        pool: aiDatabase.pool,
        gateway: promptApplication.capability,
        prepared: preparedCopilot,
        successfulCompletion: copilotSuccessfulCompletion,
        artifactStore: copilotArtifactStore,
      });
      copilotReadApplication = createCopilotRead({
        pool: aiDatabase.pool,
        prepared: preparedCopilot,
      });
      copilotCancellationApplication = createCopilotCancellation({
        pool: aiDatabase.pool,
      });
    }
    controlApplication = await startControl({
      ...options.control,
      promptCatalog: {
        capability: promptApplication.promptCatalog,
      },
      promptExecution: {
        capability: promptApplication.promptExecutions,
      },
      promptExecutionInspection: {
        capability: promptApplication.promptExecutionInspections,
      },
      ...(promptApplication.promptOutputs === undefined
        ? {}
        : {
            promptOutputRead: {
              capability: promptApplication.promptOutputs,
            },
          }),
      ...(promptApplication.promptExecutionOutputs === undefined
        ? {}
        : {
            promptExecutionOutputRead: {
              capability: promptApplication.promptExecutionOutputs,
            },
          }),
      ...(copilotApplication === undefined ||
      copilotReadApplication === undefined ||
      copilotCancellationApplication === undefined
        ? {}
        : {
            copilotFailureDiagnosis: {
              capability: copilotApplication,
              readCapability: copilotReadApplication,
              cancellationCapability: copilotCancellationApplication,
            },
          }),
    });
    if (controlApplication.status !== 'active') {
      throw new Error('AI-enabled cluster-control did not activate');
    }
    const activeControl = controlApplication;
    return Object.freeze({
      status: 'active' as const,
      address: activeControl.address,
      evidence: activeControl.evidence,
      recovery: activeControl.recovery,
      unavailable: Promise.race([activeControl.unavailable, aiUnavailable]),
      availabilityStatus() {
        return aiUnavailableError
          ? 'unavailable'
          : activeControl.availabilityStatus();
      },
      ...(copilotApplication === undefined
        ? {}
        : { copilot: copilotApplication }),
      stop,
    });
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}
