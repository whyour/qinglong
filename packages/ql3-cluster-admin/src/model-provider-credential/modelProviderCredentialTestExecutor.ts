import { performance } from 'node:perf_hooks';

/** One-shot model-provider credential connectivity executor. */
import {
  createModelProviderCredentialTestResult,
  type ModelProviderCredentialTestAllowlist,
  type ModelProviderCredentialTestExecution,
  type ModelProviderCredentialTestPlan,
  type ModelProviderCredentialTestResult,
} from '@qinglong/ai/model-provider-credential-test-connection';
import {
  ModelProviderCredentialTestExecutionUnavailableError,
  type BeginModelProviderCredentialTestExecutionInput,
  type ModelProviderCredentialTestExecutionRepository,
} from '@qinglong/ai/postgres-model-provider-credential-test-connection';
import { OpenAiCompatibleProvider } from '@qinglong/ai/openai-compatible';
import {
  BoundModelProviderCredentialProvider,
  type ModelProviderCredentialAuditSink,
  type ModelProviderCredentialBindingSource,
  type ModelProviderSecretMaterialProvider,
} from '@qinglong/ai/provider-credential';

export interface ExecuteModelProviderCredentialTestInput
  extends BeginModelProviderCredentialTestExecutionInput {}

interface ModelProviderCredentialTestExecutorEvidence {
  readonly plan: Readonly<ModelProviderCredentialTestPlan>;
  readonly execution: Readonly<ModelProviderCredentialTestExecution>;
}

export type ExecuteModelProviderCredentialTestResult =
  | Readonly<
      ModelProviderCredentialTestExecutorEvidence & {
        status: 'completed' | 'existing';
        result: Readonly<ModelProviderCredentialTestResult>;
      }
    >
  | Readonly<
      ModelProviderCredentialTestExecutorEvidence & {
        status: 'outcome_unknown';
        result: null;
      }
    >;

export interface ModelProviderCredentialTestExecutor {
  execute(
    input: Readonly<ExecuteModelProviderCredentialTestInput>,
  ): Promise<Readonly<ExecuteModelProviderCredentialTestResult>>;
}

export interface ModelProviderCredentialTestExecutorOptions {
  readonly repository: ModelProviderCredentialTestExecutionRepository;
  readonly credentials: ModelProviderCredentialBindingSource &
    ModelProviderCredentialAuditSink;
  readonly secrets: ModelProviderSecretMaterialProvider;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly transportReady?: (
    baseUrl: string,
    signal: AbortSignal,
  ) => Promise<void>;
}

export class ModelProviderCredentialTestExecutorConfigurationError extends TypeError {
  readonly code =
    'MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTOR_CONFIGURATION_INVALID';

  constructor() {
    super('Model provider credential test executor configuration is invalid');
    this.name = 'ModelProviderCredentialTestExecutorConfigurationError';
  }
}

export class ModelProviderCredentialTestExecutorUnavailableError extends Error {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTOR_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Model provider credential test executor is unavailable', options);
    this.name = 'ModelProviderCredentialTestExecutorUnavailableError';
  }
}

function exact(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function currentTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ModelProviderCredentialTestExecutorUnavailableError();
  }
  return value;
}

function elapsedMs(startedAt: number, monotonicNow: () => number): number {
  const value = monotonicNow() - startedAt;
  if (!Number.isFinite(value) || value < 0) {
    throw new ModelProviderCredentialTestExecutorUnavailableError();
  }
  return Math.floor(value);
}

async function completeExactly(
  repository: ModelProviderCredentialTestExecutionRepository,
  result: Readonly<ModelProviderCredentialTestResult>,
): Promise<void> {
  try {
    await repository.complete(result);
  } catch (error) {
    if (
      !(error instanceof ModelProviderCredentialTestExecutionUnavailableError)
    ) {
      throw error;
    }
    await repository.complete(result);
  }
}

export function createModelProviderCredentialTestExecutor(
  options: ModelProviderCredentialTestExecutorOptions,
): Readonly<ModelProviderCredentialTestExecutor> {
  const expectedKeys = ['credentials', 'repository', 'secrets'];
  if (options?.fetch !== undefined) expectedKeys.push('fetch');
  if (options?.monotonicNow !== undefined) expectedKeys.push('monotonicNow');
  if (options?.now !== undefined) expectedKeys.push('now');
  if (options?.transportReady !== undefined)
    expectedKeys.push('transportReady');
  if (
    !exact(options, expectedKeys) ||
    typeof options.repository?.beginExecution !== 'function' ||
    typeof options.repository?.complete !== 'function' ||
    typeof options.credentials?.resolveModelProviderCredentialBinding !==
      'function' ||
    typeof options.credentials?.record !== 'function' ||
    typeof options.secrets?.resolveProjectSecretMaterial !== 'function' ||
    (options.fetch !== undefined && typeof options.fetch !== 'function') ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.monotonicNow !== undefined &&
      typeof options.monotonicNow !== 'function') ||
    (options.transportReady !== undefined &&
      typeof options.transportReady !== 'function')
  ) {
    throw new ModelProviderCredentialTestExecutorConfigurationError();
  }
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const credentials = new BoundModelProviderCredentialProvider({
    bindings: options.credentials,
    secrets: options.secrets,
    audit: options.credentials,
    now,
  });

  return Object.freeze({
    async execute(input: Readonly<ExecuteModelProviderCredentialTestInput>) {
      if (!exact(input, ['allowlist', 'executionId', 'testId'])) {
        throw new ModelProviderCredentialTestExecutorConfigurationError();
      }
      const begun = await options.repository.beginExecution(input);
      if (begun.status === 'existing') {
        return begun.result === null
          ? Object.freeze({
              status: 'outcome_unknown' as const,
              plan: begun.plan,
              execution: begun.execution,
              result: null,
            })
          : Object.freeze({
              status: 'existing' as const,
              plan: begun.plan,
              execution: begun.execution,
              result: begun.result,
            });
      }

      const startedAt = monotonicNow();
      if (!Number.isFinite(startedAt) || startedAt < 0) {
        throw new ModelProviderCredentialTestExecutorUnavailableError();
      }
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        begun.plan.endpoint.deadlineMs,
      );
      timeout.unref?.();
      let outcome: 'reachable' | 'unreachable' = 'unreachable';
      let modelCount: number | null = null;
      try {
        await options.transportReady?.(
          begun.plan.endpoint.baseUrl,
          controller.signal,
        );
        const provider = new OpenAiCompatibleProvider({
          type: begun.plan.provider,
          baseUrl: begun.plan.endpoint.baseUrl,
          credentials,
          maxResponseBytes: begun.plan.endpoint.maxResponseBytes,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        const models = await provider.listModels({
          projectId: begun.plan.projectId,
          requestId: begun.execution.executionId,
          signal: controller.signal,
        });
        if (
          !controller.signal.aborted &&
          models.length <= begun.plan.endpoint.maxModels &&
          elapsedMs(startedAt, monotonicNow) <= begun.plan.endpoint.deadlineMs
        ) {
          outcome = 'reachable';
          modelCount = models.length;
        }
      } catch {
        outcome = 'unreachable';
        modelCount = null;
      } finally {
        clearTimeout(timeout);
      }
      const durationMs = Math.min(
        begun.plan.endpoint.deadlineMs,
        elapsedMs(startedAt, monotonicNow),
      );
      const result = createModelProviderCredentialTestResult({
        executionId: begun.execution.executionId,
        testId: begun.plan.testId,
        planDigest: begun.plan.planDigest,
        outcome,
        modelCount,
        durationMs,
        completedAtMs: currentTime(now),
      });
      try {
        await completeExactly(options.repository, result);
      } catch (error) {
        throw new ModelProviderCredentialTestExecutorUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      return Object.freeze({
        status: 'completed' as const,
        plan: begun.plan,
        execution: begun.execution,
        result,
      });
    },
  });
}
