import type {
  GenerateRequest,
  ModelInvocationContext,
} from '../../model-gateway/model';
import type { ModelInvocationSuccessfulCompletionSink } from '../../model-gateway/gateway';
import type { ResolveModelInvocationOptions } from '../../model-invocation/modelInvocationResolution';
import type {
  ModelInvocationUsageLedgerQuery,
  ModelInvocationUsageLedgerSummaryQuery,
} from '../../usage/usageLedger';
import {
  MODEL_GATEWAY_PROFILES,
  ModelGatewayProfileDrainingError,
  ModelGatewayProfileUnavailableError,
  type ActiveModelGatewayCapability,
  type BootstrapModelGatewayProfileOptions,
  type BootstrapModelGatewayProfileResult,
  type ModelGatewayProviderAuthority,
  type ModelGatewayStorageAuthority,
} from './contracts';
import { bestEffortAudit, dispose } from './lifecycle';

const DEFAULT_PROFILE_BUDGETS = Object.freeze({
  edge: Object.freeze({ maxConcurrent: 1, recoveryLimit: 4 }),
  standalone: Object.freeze({ maxConcurrent: 4, recoveryLimit: 32 }),
  cluster: Object.freeze({ maxConcurrent: 32, recoveryLimit: 128 }),
});

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as number;
}

function assertOptions(options: BootstrapModelGatewayProfileOptions): void {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !MODEL_GATEWAY_PROFILES.includes(options.profile) ||
    (options.enabled !== undefined && typeof options.enabled !== 'boolean') ||
    typeof options.loadStorage !== 'function' ||
    typeof options.loadProviders !== 'function' ||
    (options.confirmActive !== undefined &&
      typeof options.confirmActive !== 'function') ||
    (options.createSuccessfulCompletion !== undefined &&
      typeof options.createSuccessfulCompletion !== 'function') ||
    typeof options.audit !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new TypeError('Model gateway Profile options are invalid');
  }
}

function assertStorage(
  value: ModelGatewayStorageAuthority,
): ModelGatewayStorageAuthority {
  const repository = value?.repository;
  if (
    !value ||
    typeof value !== 'object' ||
    !repository ||
    typeof repository.findStart !== 'function' ||
    typeof repository.findCompletion !== 'function' ||
    typeof repository.findResolution !== 'function' ||
    typeof repository.readAuthority !== 'function' ||
    typeof repository.listIncomplete !== 'function' ||
    typeof repository.admit !== 'function' ||
    typeof repository.complete !== 'function' ||
    typeof repository.resolve !== 'function' ||
    typeof repository.findUsage !== 'function' ||
    typeof repository.listProjectUsage !== 'function' ||
    typeof repository.summarizeProjectUsage !== 'function' ||
    typeof repository.findQuotaReservation !== 'function' ||
    typeof repository.findQuotaSettlement !== 'function' ||
    typeof repository.readQuotaWindowUsage !== 'function' ||
    typeof repository.findPriceQuote !== 'function' ||
    typeof repository.findPriceSettlement !== 'function' ||
    !value.pricing ||
    typeof value.pricing.resolve !== 'function' ||
    (value.close !== undefined && typeof value.close !== 'function')
  ) {
    throw new TypeError('Model gateway storage authority is invalid');
  }
  return value;
}

function assertProviders(
  value: ModelGatewayProviderAuthority,
): ModelGatewayProviderAuthority {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray(value.providers) ||
    !value.policies ||
    typeof value.policies.resolve !== 'function' ||
    (value.dispose !== undefined && typeof value.dispose !== 'function')
  ) {
    throw new TypeError('Model gateway provider authority is invalid');
  }
  return value;
}

/**
 * Profile-gated optional AI composition root. Disabled mode never invokes the
 * storage/provider loaders. Enabled mode proves durable storage and bounded
 * recovery before provider credentials become reachable.
 */
export async function bootstrapModelGatewayProfile(
  options: BootstrapModelGatewayProfileOptions,
): Promise<BootstrapModelGatewayProfileResult> {
  assertOptions(options);
  if (!(options.enabled ?? false)) {
    await options.audit({ profile: options.profile, state: 'disabled' });
    return Object.freeze({
      status: 'disabled',
      profile: options.profile,
      stop: async () => 'stopped' as const,
    });
  }

  const defaults = DEFAULT_PROFILE_BUDGETS[options.profile];
  const maxConcurrent = integer(
    options.maxConcurrent ?? defaults.maxConcurrent,
    1,
    64,
    'Model gateway Profile concurrency',
  );
  const recoveryLimit = integer(
    options.recoveryLimit ?? defaults.recoveryLimit,
    1,
    128,
    'Model gateway Profile recovery limit',
  );
  let storage: ModelGatewayStorageAuthority | undefined;
  let providers: ModelGatewayProviderAuthority | undefined;
  try {
    storage = await options.loadStorage();
    storage = assertStorage(storage);
    await options.audit({
      profile: options.profile,
      state: 'storage_ready',
      maxConcurrent,
      recoveryLimit,
    });

    const [coordinatorModule, { BoundedModelGateway }] = await Promise.all([
      import('../../model-invocation/durableModelInvocationCoordinator.js'),
      import('../../model-gateway/gateway.js'),
    ]);
    const recovery = await new coordinatorModule.DurableModelInvocationRecovery(
      storage.repository,
    ).recover(recoveryLimit);
    if (recovery.failed !== 0 || recovery.hasMore) {
      throw new ModelGatewayProfileUnavailableError();
    }
    await options.audit({
      profile: options.profile,
      state: 'recovery_ready',
      maxConcurrent,
      recoveryLimit,
      recovered: recovery.recovered,
      alreadyCompleted: recovery.alreadyCompleted,
    });

    providers = await options.loadProviders();
    providers = assertProviders(providers);
    const { DurableModelInvocationResolutionCoordinator } = await import(
      '../../model-invocation/modelInvocationResolution.js'
    );
    const coordinator = new coordinatorModule.DurableModelInvocationCoordinator(
      storage.repository,
    );
    const successfulCompletion =
      options.createSuccessfulCompletion?.(coordinator);
    if (
      successfulCompletion !== undefined &&
      (!successfulCompletion ||
        typeof successfulCompletion.record !== 'function')
    ) {
      throw new ModelGatewayProfileUnavailableError();
    }
    const gateway = new BoundedModelGateway({
      providers: providers.providers,
      policies: providers.policies,
      pricing: storage.pricing,
      audit: coordinator,
      ...(successfulCompletion === undefined ? {} : { successfulCompletion }),
      maxConcurrent,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const resolver = new DurableModelInvocationResolutionCoordinator(
      storage.repository,
    );
    let accepting = true;
    let activeOperations = 0;
    let stopPromise: Promise<'stopped'> | undefined;
    let drainingAudited = false;

    const auditDraining = async (): Promise<void> => {
      if (drainingAudited) return;
      drainingAudited = true;
      await options.audit({
        profile: options.profile,
        state: 'draining',
        maxConcurrent,
        recoveryLimit,
      });
    };
    const finalizeStop = (): Promise<'stopped'> => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        await dispose(providers!, 'dispose');
        await dispose(storage!, 'close');
        await options.audit({
          profile: options.profile,
          state: 'stopped',
          maxConcurrent,
          recoveryLimit,
        });
        return 'stopped' as const;
      })();
      return stopPromise;
    };
    const beginOperation = async (): Promise<void> => {
      if (!accepting) throw new ModelGatewayProfileDrainingError();
      if (options.confirmActive) {
        try {
          await options.confirmActive();
        } catch {
          accepting = false;
          await auditDraining();
          if (activeOperations === 0) await finalizeStop();
          throw new ModelGatewayProfileDrainingError();
        }
      }
      if (!accepting) throw new ModelGatewayProfileDrainingError();
      activeOperations += 1;
    };
    const finishOperation = (): void => {
      activeOperations -= 1;
      if (!accepting && activeOperations === 0) {
        void finalizeStop().catch(async () => {
          await bestEffortAudit(options.audit, {
            profile: options.profile,
            state: 'failed',
            maxConcurrent,
            recoveryLimit,
          });
        });
      }
    };

    const capability: ActiveModelGatewayCapability = Object.freeze({
      profile: options.profile,
      recovery,
      maxConcurrent,
      recoveryLimit,
      get accepting() {
        return accepting;
      },
      get activeOperations() {
        return activeOperations;
      },
      supportsSuccessfulCompletionSink(
        sink: ModelInvocationSuccessfulCompletionSink,
      ) {
        return gateway.supportsSuccessfulCompletionSink(sink);
      },
      async generate(
        request: GenerateRequest,
        context: ModelInvocationContext,
      ) {
        await beginOperation();
        try {
          return await gateway.generate(request, context);
        } finally {
          finishOperation();
        }
      },
      async *stream(request: GenerateRequest, context: ModelInvocationContext) {
        await beginOperation();
        try {
          yield* gateway.stream(request, context);
        } finally {
          finishOperation();
        }
      },
      async resolveUnknown(resolutionOptions: ResolveModelInvocationOptions) {
        await beginOperation();
        try {
          return await resolver.resolve(resolutionOptions);
        } finally {
          finishOperation();
        }
      },
      async listProjectUsage(query: ModelInvocationUsageLedgerQuery) {
        await beginOperation();
        try {
          return await storage!.repository.listProjectUsage(query);
        } finally {
          finishOperation();
        }
      },
      async summarizeProjectUsage(
        query: ModelInvocationUsageLedgerSummaryQuery,
      ) {
        await beginOperation();
        try {
          return await storage!.repository.summarizeProjectUsage(query);
        } finally {
          finishOperation();
        }
      },
      async readQuotaWindowUsage(projectId: string, atMs?: number) {
        await beginOperation();
        try {
          return await storage!.repository.readQuotaWindowUsage(
            projectId,
            atMs,
          );
        } finally {
          finishOperation();
        }
      },
      async findPriceQuote(invocationId: string) {
        await beginOperation();
        try {
          return await storage!.repository.findPriceQuote(invocationId);
        } finally {
          finishOperation();
        }
      },
      async findPriceSettlement(invocationId: string) {
        await beginOperation();
        try {
          return await storage!.repository.findPriceSettlement(invocationId);
        } finally {
          finishOperation();
        }
      },
      async stop() {
        accepting = false;
        if (activeOperations !== 0) {
          await auditDraining();
          return 'draining';
        }
        return finalizeStop();
      },
    });
    await options.audit({
      profile: options.profile,
      state: 'active',
      maxConcurrent,
      recoveryLimit,
      recovered: recovery.recovered,
      alreadyCompleted: recovery.alreadyCompleted,
    });
    return Object.freeze({
      status: 'active',
      profile: options.profile,
      capability,
    });
  } catch (cause) {
    if (providers) {
      try {
        await dispose(providers, 'dispose');
      } catch {
        // Preserve the activation failure.
      }
    }
    if (storage) {
      try {
        await dispose(storage, 'close');
      } catch {
        // Preserve the activation failure.
      }
    }
    await bestEffortAudit(options.audit, {
      profile: options.profile,
      state: 'failed',
      maxConcurrent,
      recoveryLimit,
    });
    throw cause instanceof ModelGatewayProfileUnavailableError
      ? cause
      : new ModelGatewayProfileUnavailableError({
          cause: cause instanceof Error ? cause : undefined,
        });
  }
}
