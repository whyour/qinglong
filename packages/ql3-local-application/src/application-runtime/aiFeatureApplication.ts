import { performance } from 'node:perf_hooks';

import type {
  ActiveModelGatewayCapability,
  ModelGatewayProfileAudit,
  ModelGatewayProviderAuthority,
} from '@qinglong/ai/profile';
import type { LocalModelInvocationFeatureTransition } from '@qinglong/ai/local-feature-activation';
import type { PluginPackagePromptExecutor } from '@qinglong/ai/plugin-package-prompt-executor';
import type {
  PluginPackagePromptOutputArtifactKeyProvider,
  PluginPackagePromptOutputArtifactReadAuthorizer,
} from '@qinglong/ai/plugin-package-prompt-output-artifact';
import type { PluginPackagePromptOutputCompletionCapability } from '@qinglong/ai/plugin-package-prompt-output-completion';
import type {
  PluginPackagePromptOutputArtifactRetentionStateReader,
  PluginPackagePromptOutputReadService,
} from '@qinglong/ai/plugin-package-prompt-output-read';
import type { PluginPackagePromptExecutionOutputReadService } from '@qinglong/ai/plugin-package-prompt-execution-output-read';

import { bootstrapLocalApplication } from './activation';
import type {
  LocalApplicationBootstrapOptions,
  LocalApplicationBootstrapResult,
  LocalApplicationProfile,
  LocalApplicationStopResult,
} from './contract';

const MIN_DRAIN_TIMEOUT_MS = 100;
const MAX_DRAIN_TIMEOUT_MS = 60_000;
const MIN_DRAIN_POLL_MS = 10;
const MAX_DRAIN_POLL_MS = 1_000;

export const LOCAL_AI_FEATURE_APPLICATION_STATES = [
  'application_disabled',
  'deployment_excluded',
  'schema_absent',
  'feature_inactive',
  'feature_active',
  'storage_ready',
  'recovery_ready',
  'active',
  'draining',
  'drain_timed_out',
  'stopped',
  'failed',
] as const;

export type LocalAiFeatureApplicationState =
  (typeof LOCAL_AI_FEATURE_APPLICATION_STATES)[number];

export interface LocalAiFeatureApplicationAudit {
  readonly profile: LocalApplicationProfile;
  readonly state: LocalAiFeatureApplicationState;
  readonly generation?: number;
  readonly recovered?: number;
  readonly alreadyCompleted?: number;
}

export type LocalAiFeatureDeploymentOptions =
  | Readonly<{
      deployment: 'excluded';
      audit: (
        record: Readonly<LocalAiFeatureApplicationAudit>,
      ) => void | Promise<void>;
    }>
  | Readonly<{
      deployment: 'installed';
      loadProviders: () => Promise<ModelGatewayProviderAuthority>;
      audit: (
        record: Readonly<LocalAiFeatureApplicationAudit>,
      ) => void | Promise<void>;
      maxConcurrent?: number;
      recoveryLimit?: number;
      drainTimeoutMs?: number;
      drainPollMs?: number;
      now?: () => number;
      promptOutputKeys?: PluginPackagePromptOutputArtifactKeyProvider;
      promptOutputRead?: Readonly<{
        authorizer: PluginPackagePromptOutputArtifactReadAuthorizer;
        retention: PluginPackagePromptOutputArtifactRetentionStateReader;
      }>;
    }>;

export interface BootstrapLocalAiFeatureApplicationOptions {
  readonly application: LocalApplicationBootstrapOptions;
  readonly ai: LocalAiFeatureDeploymentOptions;
}

type ActiveLocalApplication = Extract<
  LocalApplicationBootstrapResult,
  { status: 'active' }
>;

export type LocalAiFeatureStartupResult =
  | Readonly<{
      status: 'deployment_excluded' | 'schema_absent';
    }>
  | Readonly<{
      status: 'inactive';
      generation: number;
    }>
  | Readonly<{
      status: 'active';
      generation: number;
      capability: ActiveModelGatewayCapability;
      prompts: PluginPackagePromptExecutor;
      promptOutputs?: PluginPackagePromptOutputReadService;
      promptExecutionOutputs?: PluginPackagePromptExecutionOutputReadService;
    }>;

export type BootstrapLocalAiFeatureApplicationResult =
  | Readonly<{
      status: 'disabled';
      profile: LocalApplicationProfile;
      ai: Readonly<{ status: 'application_disabled' }>;
      stop(): Promise<'stopped'>;
    }>
  | Readonly<{
      status: 'active';
      profile: LocalApplicationProfile;
      application: Readonly<Omit<ActiveLocalApplication, 'stop'>>;
      ai: LocalAiFeatureStartupResult;
      stop(): Promise<LocalApplicationStopResult>;
    }>;

export class LocalAiFeatureApplicationUnavailableError extends Error {
  readonly code = 'LOCAL_AI_FEATURE_APPLICATION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('The local AI feature application is unavailable', options);
    this.name = 'LocalAiFeatureApplicationUnavailableError';
  }
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== [...expectedKeys].sort().join('\0')
  ) {
    throw new TypeError(`${label} shape is invalid`);
  }
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as number;
}

function assertOptions(value: BootstrapLocalAiFeatureApplicationOptions): void {
  exactObject(value, ['ai', 'application'], 'Local AI feature application');
  const ai = value.ai;
  if (!ai || typeof ai !== 'object' || Array.isArray(ai)) {
    throw new TypeError('Local AI feature deployment is invalid');
  }
  if (ai.deployment === 'excluded') {
    exactObject(ai, ['audit', 'deployment'], 'Excluded local AI feature');
  } else if (ai.deployment === 'installed') {
    const optionalKeys = [
      'drainPollMs',
      'drainTimeoutMs',
      'maxConcurrent',
      'now',
      'promptOutputKeys',
      'promptOutputRead',
      'recoveryLimit',
    ].filter((key) => Object.hasOwn(ai, key));
    exactObject(
      ai,
      ['audit', 'deployment', 'loadProviders', ...optionalKeys],
      'Installed local AI feature',
    );
    if (typeof ai.loadProviders !== 'function') {
      throw new TypeError('Local AI provider loader is invalid');
    }
    boundedInteger(
      ai.drainTimeoutMs,
      5_000,
      MIN_DRAIN_TIMEOUT_MS,
      MAX_DRAIN_TIMEOUT_MS,
      'Local AI drain timeout',
    );
    boundedInteger(
      ai.drainPollMs,
      25,
      MIN_DRAIN_POLL_MS,
      MAX_DRAIN_POLL_MS,
      'Local AI drain poll interval',
    );
    if (
      ai.maxConcurrent !== undefined &&
      (!Number.isSafeInteger(ai.maxConcurrent) ||
        ai.maxConcurrent < 1 ||
        ai.maxConcurrent > 64)
    ) {
      throw new TypeError('Local AI concurrency is invalid');
    }
    if (
      ai.recoveryLimit !== undefined &&
      (!Number.isSafeInteger(ai.recoveryLimit) ||
        ai.recoveryLimit < 1 ||
        ai.recoveryLimit > 128)
    ) {
      throw new TypeError('Local AI recovery limit is invalid');
    }
    if (ai.now !== undefined && typeof ai.now !== 'function') {
      throw new TypeError('Local AI clock is invalid');
    }
    if (
      ai.promptOutputKeys !== undefined &&
      (!ai.promptOutputKeys ||
        typeof ai.promptOutputKeys !== 'object' ||
        typeof ai.promptOutputKeys.active !== 'function' ||
        typeof ai.promptOutputKeys.resolve !== 'function')
    ) {
      throw new TypeError('Local Prompt output key provider is invalid');
    }
    if (ai.promptOutputRead !== undefined) {
      exactObject(
        ai.promptOutputRead,
        ['authorizer', 'retention'],
        'Local Prompt output read capability',
      );
      if (
        ai.promptOutputKeys === undefined ||
        !ai.promptOutputRead.authorizer ||
        typeof ai.promptOutputRead.authorizer.authorize !== 'function' ||
        !ai.promptOutputRead.retention ||
        typeof ai.promptOutputRead.retention.inspect !== 'function'
      ) {
        throw new TypeError('Local Prompt output read capability is invalid');
      }
    }
  } else {
    throw new TypeError('Local AI deployment state is invalid');
  }
  if (typeof ai.audit !== 'function') {
    throw new TypeError('Local AI application audit sink is invalid');
  }
}

async function bestEffortAudit(
  audit: LocalAiFeatureDeploymentOptions['audit'],
  record: Readonly<LocalAiFeatureApplicationAudit>,
): Promise<void> {
  try {
    await audit(record);
  } catch {
    // Diagnostics cannot replace activation or shutdown results.
  }
}

interface RawFeatureHead {
  readonly state: 'schema_absent' | 'inactive' | 'active';
  readonly generation: number;
  readonly transitionDigest: string | null;
}

function rawFeatureHead(client: {
  prepare(sql: string): {
    all(...values: unknown[]): Record<string, unknown>[];
    get(...values: unknown[]): Record<string, unknown> | undefined;
  };
}): Readonly<RawFeatureHead> {
  const schema = client
    .prepare(
      `SELECT name
         FROM sqlite_schema
        WHERE type = 'table'
          AND name IN (
            'ModelInvocationFeatureHead',
            'ModelInvocationFeatureTransitions'
          )
        ORDER BY name`,
    )
    .all();
  if (schema.length === 0) {
    return Object.freeze({
      state: 'schema_absent',
      generation: 0,
      transitionDigest: null,
    });
  }
  if (
    schema.length !== 2 ||
    schema[0]?.name !== 'ModelInvocationFeatureHead' ||
    schema[1]?.name !== 'ModelInvocationFeatureTransitions'
  ) {
    throw new LocalAiFeatureApplicationUnavailableError();
  }
  const rows = client
    .prepare(
      `SELECT generation, state, transition_digest AS "transitionDigest"
         FROM "ModelInvocationFeatureHead"
        WHERE feature_id = 'model-invocation'
        LIMIT 2`,
    )
    .all();
  if (rows.length === 0) {
    return Object.freeze({
      state: 'schema_absent',
      generation: 0,
      transitionDigest: null,
    });
  }
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    !Number.isSafeInteger(row.generation) ||
    (row.generation as number) < 1 ||
    (row.state !== 'active' && row.state !== 'inactive') ||
    typeof row.transitionDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.transitionDigest)
  ) {
    throw new LocalAiFeatureApplicationUnavailableError();
  }
  return Object.freeze({
    state: row.state,
    generation: row.generation as number,
    transitionDigest: row.transitionDigest,
  });
}

function sameActivation(
  expected: Readonly<LocalModelInvocationFeatureTransition>,
  observed: Readonly<LocalModelInvocationFeatureTransition> | null,
): boolean {
  return (
    observed?.state === 'active' &&
    observed.generation === expected.generation &&
    observed.transitionDigest === expected.transitionDigest
  );
}

function applicationView(
  application: ActiveLocalApplication,
): Readonly<Omit<ActiveLocalApplication, 'stop'>> {
  const { stop: _stop, ...view } = application;
  void _stop;
  return Object.freeze(view);
}

function oneOrAggregate(errors: unknown[], message: string): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Product composition for an optional local AI deployment. The base
 * application remains AI-free. Only an installed deployment with a durable
 * active head imports the AI runtime, recovers it, and reaches providers.
 */
export async function bootstrapLocalAiFeatureApplication(
  options: BootstrapLocalAiFeatureApplicationOptions,
): Promise<BootstrapLocalAiFeatureApplicationResult> {
  assertOptions(options);
  const application = await bootstrapLocalApplication(options.application);
  if (application.status === 'disabled') {
    await options.ai.audit({
      profile: application.profile,
      state: 'application_disabled',
    });
    return Object.freeze({
      status: 'disabled',
      profile: application.profile,
      ai: Object.freeze({ status: 'application_disabled' as const }),
      stop: application.stop,
    });
  }
  if (options.application.enabled !== true) {
    await application.stop();
    throw new LocalAiFeatureApplicationUnavailableError();
  }
  const applicationOptions = options.application;
  if (options.ai.deployment === 'excluded') {
    await options.ai.audit({
      profile: application.profile,
      state: 'deployment_excluded',
    });
    return Object.freeze({
      status: 'active',
      profile: application.profile,
      application: applicationView(application),
      ai: Object.freeze({ status: 'deployment_excluded' as const }),
      stop: application.stop,
    });
  }

  const aiOptions = options.ai;
  let featureDatabase:
    | Awaited<
        ReturnType<
          typeof import('@qinglong/local-sqlite/optional-feature-runtime')['openLocalSqliteOptionalFeatureRuntimeDatabase']
        >
      >
    | undefined;
  let featureOwnedByProfile = false;
  try {
    const { openLocalSqliteOptionalFeatureRuntimeDatabase } = await import(
      '@qinglong/local-sqlite/optional-feature-runtime'
    );
    featureDatabase = await openLocalSqliteOptionalFeatureRuntimeDatabase({
      databasePath:
        applicationOptions.storageMode === 'fresh'
          ? applicationOptions.databasePath
          : applicationOptions.targetPath,
      profile: applicationOptions.profile,
      ...(applicationOptions.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: applicationOptions.busyTimeoutMs }),
    });
    const head = rawFeatureHead(featureDatabase.authority.client);
    if (head.state !== 'active') {
      await featureDatabase.close();
      featureDatabase = undefined;
      await aiOptions.audit({
        profile: application.profile,
        state:
          head.state === 'schema_absent' ? 'schema_absent' : 'feature_inactive',
        ...(head.generation === 0 ? {} : { generation: head.generation }),
      });
      const ai: LocalAiFeatureStartupResult =
        head.state === 'schema_absent'
          ? Object.freeze({ status: 'schema_absent' as const })
          : Object.freeze({
              status: 'inactive' as const,
              generation: head.generation,
            });
      return Object.freeze({
        status: 'active',
        profile: application.profile,
        application: applicationView(application),
        ai,
        stop: application.stop,
      });
    }

    const [
      { LocalModelInvocationFeatureActivationRepository },
      { LocalModelInvocationRepository },
      { LocalModelPriceCatalogRepository },
      { bootstrapModelGatewayProfile },
      { LocalPluginPackagePromptAdmissionRepository },
      { PluginPackagePromptExecutor },
      { PluginPackagePromptOutputCompletionCoordinator },
    ] = await Promise.all([
      import('@qinglong/ai/local-feature-activation'),
      import('@qinglong/ai/local-model-invocation-storage'),
      import('@qinglong/ai/local-price-catalog-storage'),
      import('@qinglong/ai/profile'),
      import('@qinglong/ai/local-plugin-package-prompt-admission-storage'),
      import('@qinglong/ai/plugin-package-prompt-executor'),
      import('@qinglong/ai/plugin-package-prompt-output-completion'),
    ]);
    const activationRepository =
      new LocalModelInvocationFeatureActivationRepository(
        featureDatabase.authority.client,
      );
    const activation = activationRepository.findCurrent();
    if (
      !activation ||
      activation.state !== 'active' ||
      activation.generation !== head.generation ||
      activation.transitionDigest !== head.transitionDigest
    ) {
      throw new LocalAiFeatureApplicationUnavailableError();
    }
    await aiOptions.audit({
      profile: application.profile,
      state: 'feature_active',
      generation: activation.generation,
    });
    const repository = new LocalModelInvocationRepository(
      featureDatabase.authority,
    );
    const pricing = new LocalModelPriceCatalogRepository(
      featureDatabase.authority,
    );
    const activeDatabase = featureDatabase;
    let durableOutput:
      | PluginPackagePromptOutputCompletionCapability
      | undefined;
    const gateway = await bootstrapModelGatewayProfile({
      enabled: true,
      profile: application.profile,
      loadStorage: async () => {
        featureOwnedByProfile = true;
        return Object.freeze({
          repository,
          pricing,
          close: () => activeDatabase.close(),
        });
      },
      loadProviders: aiOptions.loadProviders,
      ...(aiOptions.promptOutputKeys === undefined
        ? {}
        : {
            createSuccessfulCompletion: (coordinator) => {
              durableOutput =
                new PluginPackagePromptOutputCompletionCoordinator({
                  coordinator,
                  keys: aiOptions.promptOutputKeys!,
                  ...(aiOptions.now === undefined ? {} : { now: aiOptions.now }),
                });
              return durableOutput;
            },
          }),
      confirmActive: async () => {
        await activeDatabase.authority.enqueue(
          async () => {
            if (
              !sameActivation(activation, activationRepository.findCurrent())
            ) {
              throw new LocalAiFeatureApplicationUnavailableError();
            }
          },
          () => new LocalAiFeatureApplicationUnavailableError(),
        );
      },
      audit: async (record: Readonly<ModelGatewayProfileAudit>) => {
        if (record.state === 'disabled') {
          throw new LocalAiFeatureApplicationUnavailableError();
        }
        await aiOptions.audit({
          profile: application.profile,
          state: record.state,
          generation: activation.generation,
          ...(record.recovered === undefined
            ? {}
            : { recovered: record.recovered }),
          ...(record.alreadyCompleted === undefined
            ? {}
            : { alreadyCompleted: record.alreadyCompleted }),
        });
      },
      ...(aiOptions.maxConcurrent === undefined
        ? {}
        : { maxConcurrent: aiOptions.maxConcurrent }),
      ...(aiOptions.recoveryLimit === undefined
        ? {}
        : { recoveryLimit: aiOptions.recoveryLimit }),
      ...(aiOptions.now === undefined ? {} : { now: aiOptions.now }),
    });
    if (gateway.status !== 'active') {
      throw new LocalAiFeatureApplicationUnavailableError();
    }
    const capability = gateway.capability;
    const prompts = new PluginPackagePromptExecutor({
      admissions: new LocalPluginPackagePromptAdmissionRepository(
        activeDatabase.authority,
      ),
      invocations: repository,
      gateway: capability,
      ...(durableOutput === undefined ? {} : { durableOutput }),
    });
    let promptOutputs: PluginPackagePromptOutputReadService | undefined;
    let promptExecutionOutputs:
      | PluginPackagePromptExecutionOutputReadService
      | undefined;
    if (aiOptions.promptOutputRead !== undefined) {
      const [
        { LocalPluginPackagePromptOutputArtifactRepository },
        { PluginPackagePromptOutputReadService },
        { PluginPackagePromptExecutionOutputReadService },
        { LocalPluginPackagePromptExecutionOutputReferenceRepository },
      ] = await Promise.all([
        import(
          '@qinglong/ai/local-plugin-package-prompt-output-artifact-storage'
        ),
        import('@qinglong/ai/plugin-package-prompt-output-read'),
        import('@qinglong/ai/plugin-package-prompt-execution-output-read'),
        import(
          '@qinglong/ai/local-plugin-package-prompt-execution-output-reference-storage'
        ),
      ]);
      promptOutputs = new PluginPackagePromptOutputReadService({
        artifacts: new LocalPluginPackagePromptOutputArtifactRepository(
          activeDatabase.authority,
        ),
        authorizer: aiOptions.promptOutputRead.authorizer,
        retention: aiOptions.promptOutputRead.retention,
        keys: aiOptions.promptOutputKeys!,
        ...(aiOptions.now === undefined ? {} : { now: aiOptions.now }),
      });
      promptExecutionOutputs =
        new PluginPackagePromptExecutionOutputReadService({
          references:
            new LocalPluginPackagePromptExecutionOutputReferenceRepository(
              activeDatabase.authority,
            ),
          outputs: promptOutputs,
        });
    }
    const drainTimeoutMs = boundedInteger(
      aiOptions.drainTimeoutMs,
      5_000,
      MIN_DRAIN_TIMEOUT_MS,
      MAX_DRAIN_TIMEOUT_MS,
      'Local AI drain timeout',
    );
    const drainPollMs = boundedInteger(
      aiOptions.drainPollMs,
      25,
      MIN_DRAIN_POLL_MS,
      MAX_DRAIN_POLL_MS,
      'Local AI drain poll interval',
    );
    let stopPromise: Promise<LocalApplicationStopResult> | undefined;
    return Object.freeze({
      status: 'active',
      profile: application.profile,
      application: applicationView(application),
      ai: Object.freeze({
        status: 'active' as const,
        generation: activation.generation,
        capability,
        prompts,
        ...(promptOutputs === undefined ? {} : { promptOutputs }),
        ...(promptExecutionOutputs === undefined
          ? {}
          : { promptExecutionOutputs }),
      }),
      stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          const errors: unknown[] = [];
          let timedOut = false;
          await bestEffortAudit(aiOptions.audit, {
            profile: application.profile,
            state: 'draining',
            generation: activation.generation,
          });
          try {
            const deadline = performance.now() + drainTimeoutMs;
            let result = await capability.stop();
            while (result === 'draining' && performance.now() < deadline) {
              await delay(
                Math.min(
                  drainPollMs,
                  Math.max(1, deadline - performance.now()),
                ),
              );
              result = await capability.stop();
            }
            timedOut = result === 'draining';
          } catch (error) {
            errors.push(error);
          }
          try {
            timedOut = (await application.stop()) === 'timed_out' || timedOut;
          } catch (error) {
            errors.push(error);
          }
          await bestEffortAudit(aiOptions.audit, {
            profile: application.profile,
            state: timedOut ? 'drain_timed_out' : 'stopped',
            generation: activation.generation,
          });
          if (errors.length > 0) {
            throw oneOrAggregate(
              errors,
              'Local AI feature application stop failed',
            );
          }
          return timedOut ? 'timed_out' : 'stopped';
        })();
        return stopPromise;
      },
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (featureDatabase && !featureOwnedByProfile) {
      try {
        await featureDatabase.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await application.stop();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    await bestEffortAudit(aiOptions.audit, {
      profile: application.profile,
      state: 'failed',
    });
    const cause =
      error instanceof LocalAiFeatureApplicationUnavailableError
        ? error
        : new LocalAiFeatureApplicationUnavailableError({
            cause: error instanceof Error ? error : undefined,
          });
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [cause, ...cleanupErrors],
        'Local AI feature activation failed and cleanup was incomplete',
      );
    }
    throw cause;
  }
}
