import { Buffer } from 'node:buffer';
import { basename, dirname } from 'node:path';

import {
  CopilotFailureDiagnosisApplicationService,
  type CopilotFailureDiagnosisApplicationDependencies,
} from '@qinglong/ai/failure-diagnosis-application';
import type { PrepareCopilotFailureDiagnosisModelIntent } from '@qinglong/ai/failure-diagnosis-execution-admission';
import {
  CopilotFailureDiagnosisModelCompletionCoordinator,
  executeCopilotFailureDiagnosisModel,
  type CopilotFailureDiagnosisToolResultReader,
} from '@qinglong/ai/failure-diagnosis-model-execution';
import {
  executeCopilotFailureDiagnosisTool,
  restoreCopilotFailureDiagnosisTrustedToolAuthority,
} from '@qinglong/ai/failure-diagnosis-tool-execution';
import { PostgresCopilotFailureDiagnosisAdmissionRepository } from '@qinglong/ai/postgres-failure-diagnosis-admission-storage';
import { PostgresCopilotFailureDiagnosisModelRepository } from '@qinglong/ai/postgres-failure-diagnosis-model-execution-storage';
import { PostgresCopilotFailureDiagnosisToolUnlockRepository } from '@qinglong/ai/postgres-failure-diagnosis-tool-execution-storage';
import type { ActiveModelGatewayCapability } from '@qinglong/ai/profile';
import {
  PostgresProjectPolicyRepository,
  PostgresProjectToolDefinitionSnapshotRepository,
  PostgresRunAttemptLogRetentionClaimRepository,
  PostgresRunRepository,
  PostgresStepRunRepository,
  PostgresToolExecutionCompletionRepository,
  PostgresToolExecutionFailureCompletionRepository,
  PostgresToolExecutionStartBarrierRepository,
  PostgresToolInvocationArtifactRepository,
  PostgresToolResultKeyCatalogReader,
  PostgresToolResultRekeyReader,
  type QingLongPostgresPool,
} from '@qinglong/cluster-postgres/runtime';
import {
  BuiltInRunLogExcerptToolAdapter,
} from '@qinglong/runtime-core/builtin-run-log-excerpt-tool';
import type { RunAttemptLogReadPort } from '@qinglong/runtime-core/builtin-run-log-excerpt-projection';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import { RunAttemptLogReadService } from '@qinglong/runtime-core/run-attempt-log-read';
import { openTrustedToolSuccessCompletion } from '@qinglong/runtime-core/trusted-tool-completion';
import { TrustedToolExecutionAdapterRegistry } from '@qinglong/runtime-core/trusted-tool-execution';

import type { ClusterRemoteWorkerArtifactStore } from '../../remote-execution/remoteWorkerCompletionService';
import { PrivateProjectedFileReader } from '../../security/privateProjectedFile';
import { createClusterToolInvocationProjectedKeyring } from '../../trusted-tool/key-management/toolInvocationProjectedKeyring';
import { createClusterToolResultProjectedKeyring } from '../../trusted-tool/key-management/toolResultProjectedKeyring';
import { createClusterCopilotFailureDiagnosisOutputProjectedKeyring } from '../../copilot/failure-diagnosis/outputProjectedKeyring';

export const CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CONFIG_SCHEMA =
  'qinglong/cluster-copilot-failure-diagnosis-config@v1' as const;
export const MAX_CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CONFIG_BYTES = 16 * 1024;

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_BOUNDARIES = ['on_device', 'external'] as const;
const RESPONSE_LANGUAGES = ['en', 'zh-CN'] as const;
const EGRESS_SCHEMA = 'qinglong/copilot-model-egress-policy@v1' as const;

export interface ClusterCopilotFailureDiagnosisConfig {
  readonly schema: typeof CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CONFIG_SCHEMA;
  readonly provider: string;
  readonly model: string;
  readonly modelBoundary: 'on_device' | 'external';
  readonly responseLanguage: 'en' | 'zh-CN';
  readonly maxOutputTokens: number;
  readonly executionTimeoutMs: number;
  readonly egressPolicy: PrepareCopilotFailureDiagnosisModelIntent['egressPolicy'];
}

export interface ClusterCopilotFailureDiagnosisProjection {
  readonly configFile: string;
  readonly invocationKeyringRootDirectory: string;
  readonly resultKeyringRootDirectory: string;
  readonly outputKeyringRootDirectory: string;
}

export interface CreateProductionClusterCopilotFailureDiagnosisOptions {
  readonly pool: QingLongPostgresPool;
  readonly gateway: ActiveModelGatewayCapability;
  readonly prepared: PreparedClusterCopilotFailureDiagnosisProjection;
  readonly successfulCompletion: CopilotFailureDiagnosisModelCompletionCoordinator;
  readonly artifactStore: ClusterRemoteWorkerArtifactStore;
}

export interface PreparedClusterCopilotFailureDiagnosisProjection {
  readonly config: Readonly<ClusterCopilotFailureDiagnosisConfig>;
  readonly invocationKeys: Awaited<
    ReturnType<typeof createClusterToolInvocationProjectedKeyring>
  >;
  readonly resultKeys: Awaited<
    ReturnType<typeof createClusterToolResultProjectedKeyring>
  >;
  readonly outputKeys: Awaited<
    ReturnType<typeof createClusterCopilotFailureDiagnosisOutputProjectedKeyring>
  >;
}

export class ClusterCopilotFailureDiagnosisCompositionError extends Error {
  readonly code = 'QL3_CLUSTER_COPILOT_FAILURE_DIAGNOSIS_COMPOSITION_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`Cluster Copilot failure diagnosis composition is invalid: ${message}`, options);
    this.name = 'ClusterCopilotFailureDiagnosisCompositionError';
  }
}

function invalid(message: string, cause?: unknown): never {
  throw new ClusterCopilotFailureDiagnosisCompositionError(message, {
    cause: cause instanceof Error ? cause : undefined,
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    return invalid(`${label} shape is invalid`);
  }
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function normalizeClusterCopilotFailureDiagnosisConfig(
  value: unknown,
): Readonly<ClusterCopilotFailureDiagnosisConfig> {
  const candidate = record(value, 'configuration');
  exactKeys(
    candidate,
    [
      'egressPolicy',
      'executionTimeoutMs',
      'maxOutputTokens',
      'model',
      'modelBoundary',
      'provider',
      'responseLanguage',
      'schema',
    ],
    'configuration',
  );
  if (candidate.schema !== CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CONFIG_SCHEMA) {
    return invalid('schema is invalid');
  }
  if (!MODEL_BOUNDARIES.includes(candidate.modelBoundary as never)) {
    return invalid('model boundary is invalid');
  }
  if (!RESPONSE_LANGUAGES.includes(candidate.responseLanguage as never)) {
    return invalid('response language is invalid');
  }
  const egress = record(candidate.egressPolicy, 'egress policy');
  exactKeys(
    egress,
    [
      'maxInputBytes',
      'maxOutputTokens',
      'potentiallySensitiveDataBoundaries',
      'revision',
      'schema',
    ],
    'egress policy',
  );
  if (egress.schema !== EGRESS_SCHEMA) return invalid('egress schema is invalid');
  const selected = egress.potentiallySensitiveDataBoundaries;
  if (
    !Array.isArray(selected) ||
    selected.length < 1 ||
    selected.length > MODEL_BOUNDARIES.length ||
    selected.some((entry) => !MODEL_BOUNDARIES.includes(entry as never)) ||
    new Set(selected).size !== selected.length ||
    MODEL_BOUNDARIES.filter((entry) => selected.includes(entry)).some(
      (entry, index) => entry !== selected[index],
    ) ||
    !selected.includes(candidate.modelBoundary)
  ) {
    return invalid('egress model boundaries are invalid');
  }
  const egressMaxOutputTokens = integer(
    egress.maxOutputTokens,
    1,
    4_096,
    'egress max output tokens',
  );
  const maxOutputTokens = integer(
    candidate.maxOutputTokens,
    1,
    egressMaxOutputTokens,
    'max output tokens',
  );
  return Object.freeze({
    schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CONFIG_SCHEMA,
    provider: identity(candidate.provider, 'provider'),
    model: identity(candidate.model, 'model'),
    modelBoundary: candidate.modelBoundary as 'on_device' | 'external',
    responseLanguage: candidate.responseLanguage as 'en' | 'zh-CN',
    maxOutputTokens,
    executionTimeoutMs: integer(
      candidate.executionTimeoutMs,
      1,
      5 * 60_000,
      'execution timeout',
    ),
    egressPolicy: Object.freeze({
      schema: EGRESS_SCHEMA,
      revision: identity(egress.revision, 'egress revision'),
      potentiallySensitiveDataBoundaries: Object.freeze([...selected]) as (
        | 'on_device'
        | 'external'
      )[],
      maxInputBytes: integer(
        egress.maxInputBytes,
        1,
        64 * 1024,
        'egress max input bytes',
      ),
      maxOutputTokens: egressMaxOutputTokens,
    }),
  });
}

export function canonicalClusterCopilotFailureDiagnosisConfig(
  value: unknown,
): Buffer {
  return Buffer.from(
    `${JSON.stringify(normalizeClusterCopilotFailureDiagnosisConfig(value))}\n`,
    'utf8',
  );
}

export async function loadClusterCopilotFailureDiagnosisConfig(
  configFile: string,
): Promise<Readonly<ClusterCopilotFailureDiagnosisConfig>> {
  let bytes: Buffer | undefined;
  let canonical: Buffer | undefined;
  try {
    const reader = new PrivateProjectedFileReader({
      rootDirectory: dirname(configFile),
      minimumBytes: 1,
      maximumBytes: MAX_CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CONFIG_BYTES,
      access: 'read_only_keyring',
    });
    bytes = await reader.read(basename(configFile));
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    const config = normalizeClusterCopilotFailureDiagnosisConfig(parsed);
    canonical = canonicalClusterCopilotFailureDiagnosisConfig(config);
    if (!canonical.equals(bytes)) return invalid('file is not canonical');
    return config;
  } catch (cause) {
    return cause instanceof ClusterCopilotFailureDiagnosisCompositionError
      ? invalid(cause.message, cause)
      : invalid('projected configuration is unavailable', cause);
  } finally {
    bytes?.fill(0);
    canonical?.fill(0);
  }
}

function modelIntent(
  config: Readonly<ClusterCopilotFailureDiagnosisConfig>,
): Readonly<PrepareCopilotFailureDiagnosisModelIntent> {
  return Object.freeze({
    provider: config.provider,
    model: config.model,
    modelBoundary: config.modelBoundary,
    responseLanguage: config.responseLanguage,
    maxOutputTokens: config.maxOutputTokens,
    egressPolicy: config.egressPolicy,
  });
}

export async function prepareProductionClusterCopilotFailureDiagnosisProjection(
  projection: ClusterCopilotFailureDiagnosisProjection,
): Promise<Readonly<PreparedClusterCopilotFailureDiagnosisProjection>> {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
    return invalid('projection is invalid');
  }
  const [config, invocationKeys, resultKeys, outputKeys] = await Promise.all([
    loadClusterCopilotFailureDiagnosisConfig(projection.configFile),
    createClusterToolInvocationProjectedKeyring({
      rootDirectory: projection.invocationKeyringRootDirectory,
    }),
    createClusterToolResultProjectedKeyring({
      rootDirectory: projection.resultKeyringRootDirectory,
    }),
    createClusterCopilotFailureDiagnosisOutputProjectedKeyring({
      rootDirectory: projection.outputKeyringRootDirectory,
    }),
  ]);
  return Object.freeze({ config, invocationKeys, resultKeys, outputKeys });
}

export async function createProductionClusterCopilotFailureDiagnosis(
  options: CreateProductionClusterCopilotFailureDiagnosisOptions,
): Promise<Readonly<CopilotFailureDiagnosisApplicationService>> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.pool?.query !== 'function' ||
    typeof options.pool?.connect !== 'function' ||
    typeof options.gateway?.generate !== 'function' ||
    typeof options.gateway?.supportsSuccessfulCompletionSink !== 'function' ||
    typeof options.successfulCompletion?.begin !== 'function' ||
    typeof options.successfulCompletion?.record !== 'function' ||
    !options.prepared ||
    typeof options.artifactStore?.readLogRange !== 'function'
  ) {
    return invalid('dependencies are unavailable');
  }
  if (
    !options.gateway.supportsSuccessfulCompletionSink(
      options.successfulCompletion,
    )
  ) {
    return invalid('shared Model completion authority is unavailable');
  }
  const { config, invocationKeys, resultKeys } = options.prepared;
  const admissions = new PostgresCopilotFailureDiagnosisAdmissionRepository(
    options.pool,
  );
  const snapshots = new PostgresProjectToolDefinitionSnapshotRepository(
    options.pool,
  );
  const runs = new PostgresRunRepository(options.pool);
  const artifacts = new PostgresToolInvocationArtifactRepository(options.pool);
  const stepRuns = new PostgresStepRunRepository(options.pool);
  const barriers = new PostgresToolExecutionStartBarrierRepository(options.pool);
  const completions = new PostgresToolExecutionCompletionRepository(options.pool);
  const failureCompletions =
    new PostgresToolExecutionFailureCompletionRepository(options.pool);
  const resultKeyCatalog = new PostgresToolResultKeyCatalogReader(options.pool);
  const resultRekeys = new PostgresToolResultRekeyReader(options.pool);
  const unlocks = new PostgresCopilotFailureDiagnosisToolUnlockRepository(
    options.pool,
  );
  const models = new PostgresCopilotFailureDiagnosisModelRepository(options.pool);
  const logReader = new RunAttemptLogReadService(
    runs,
    Object.freeze({
      read: options.artifactStore.readLogRange.bind(options.artifactStore),
    }),
    {
      executorType: 'remote_worker',
      artifactIdPattern: /^wlog-[a-f0-9]{30}$/,
      maximumReadBytes: 256 * 1024,
      activeMissingIsPending: true,
    },
    new PostgresRunAttemptLogRetentionClaimRepository(options.pool),
  );
  const logs: RunAttemptLogReadPort = Object.freeze({
    read: logReader.read.bind(logReader),
  });
  const successfulCompletion = options.successfulCompletion;
  const toolResults: CopilotFailureDiagnosisToolResultReader = Object.freeze({
    async open(requestId: string, startId: string) {
      const plan = await admissions.findPlanByRequestId(requestId);
      if (!plan) return invalid('diagnosis plan is unavailable');
      const snapshot = await snapshots.findCurrent(plan.projectId);
      if (!snapshot) return invalid('Tool snapshot is unavailable');
      const authority = restoreCopilotFailureDiagnosisTrustedToolAuthority(
        plan,
        snapshot.snapshot,
      );
      const definitions = authority.bindings.definitionRegistry();
      const adapters = new TrustedToolExecutionAdapterRegistry(
        authority.bindings,
        [
          new BuiltInRunLogExcerptToolAdapter(
            authority.binding,
            'cluster-control',
            definitions,
            logs,
          ),
        ],
      );
      return openTrustedToolSuccessCompletion(startId, {
        completions,
        barriers,
        resultKeyCatalog,
        resultRekeys,
        resultKeys,
        adapters,
      });
    },
  });
  const policy = new ProjectPolicyEngine(
    new PostgresProjectPolicyRepository(options.pool),
  );
  const tool = Object.freeze({
    admissions,
    snapshots,
    artifacts,
    invocationKeys,
    resultKeys,
    stepRuns,
    runs,
    barriers,
    completions,
    failureCompletions,
    resultKeyCatalog,
    resultRekeys,
    logs,
    unlocks,
  });
  const model = Object.freeze({
    admissions,
    unlocks,
    toolResults,
    modelInvocations: models,
    outputs: models,
    gateway: options.gateway,
    successfulCompletion,
    finalizations: models,
  });
  const dependencies: CopilotFailureDiagnosisApplicationDependencies = {
    admissions,
    snapshots,
    runs,
    artifacts,
    invocationKeys,
    authorizer: policy,
    tool,
    model,
    executeTool: executeCopilotFailureDiagnosisTool,
    executeModel: executeCopilotFailureDiagnosisModel,
    modelIntent: modelIntent(config),
    executionTimeoutMs: config.executionTimeoutMs,
  };
  return new CopilotFailureDiagnosisApplicationService(dependencies);
}
