import type {
  ModelPriceCatalogManagementDecisionMode,
  PublishModelPriceCatalogRequest,
  TransitionModelPriceCatalogRequest,
} from '../../pricing/modelPriceCatalogManagement';
import {
  MODEL_GATEWAY_PROFILES,
  ModelPriceCatalogManagementProfileDrainingError,
  ModelPriceCatalogManagementProfileUnavailableError,
  type ActiveModelPriceCatalogManagementCapability,
  type BootstrapModelPriceCatalogManagementProfileOptions,
  type BootstrapModelPriceCatalogManagementProfileResult,
  type ModelGatewayProfile,
  type ModelPriceCatalogManagementAuthority,
} from './contracts';
import {
  bestEffortAudit,
  closeModelPriceCatalogManagementAuthority,
} from './lifecycle';

function modelPriceCatalogManagementDecisionMode(
  profile: ModelGatewayProfile,
): ModelPriceCatalogManagementDecisionMode {
  return profile === 'cluster' ? 'separation_of_duty' : 'human_confirmation';
}

function assertModelPriceCatalogManagementProfileOptions(
  options: BootstrapModelPriceCatalogManagementProfileOptions,
): void {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !MODEL_GATEWAY_PROFILES.includes(options.profile) ||
    (options.enabled !== undefined && typeof options.enabled !== 'boolean') ||
    typeof options.loadAuthority !== 'function' ||
    typeof options.audit !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new TypeError(
      'Model price catalog management Profile options are invalid',
    );
  }
}

function assertModelPriceCatalogManagementAuthority(
  value: ModelPriceCatalogManagementAuthority,
  profile: ModelGatewayProfile,
): ModelPriceCatalogManagementAuthority {
  const repository = value?.repository;
  if (
    !value ||
    typeof value !== 'object' ||
    !repository ||
    typeof repository.findPublication !== 'function' ||
    typeof repository.findCurrent !== 'function' ||
    typeof repository.findAuthorization !== 'function' ||
    typeof repository.publishAuthorized !== 'function' ||
    typeof repository.transitionAuthorized !== 'function' ||
    !value.authorizer ||
    typeof value.authorizer.authorize !== 'function' ||
    (value.quota !== undefined &&
      (!value.quota || typeof value.quota.consume !== 'function')) ||
    (profile === 'cluster' && !value.quota) ||
    (value.close !== undefined && typeof value.close !== 'function')
  ) {
    throw new TypeError('Model price catalog management authority is invalid');
  }
  return value;
}


/**
 * Optional management composition root shared by constrained and clustered
 * Profiles. Disabled mode is loader-free. Cluster mode is fail-closed unless
 * quota and separation-of-duty authorities are both available.
 */
export async function bootstrapModelPriceCatalogManagementProfile(
  options: BootstrapModelPriceCatalogManagementProfileOptions,
): Promise<BootstrapModelPriceCatalogManagementProfileResult> {
  assertModelPriceCatalogManagementProfileOptions(options);
  const decisionMode = modelPriceCatalogManagementDecisionMode(options.profile);
  if (!(options.enabled ?? false)) {
    await options.audit({
      profile: options.profile,
      state: 'disabled',
      decisionMode,
    });
    return Object.freeze({
      status: 'disabled',
      profile: options.profile,
      decisionMode,
      stop: async () => 'stopped' as const,
    });
  }

  let authority: ModelPriceCatalogManagementAuthority | undefined;
  try {
    authority = await options.loadAuthority();
    authority = assertModelPriceCatalogManagementAuthority(
      authority,
      options.profile,
    );
    await options.audit({
      profile: options.profile,
      state: 'authority_ready',
      decisionMode,
    });
    const { createModelPriceCatalogManagementService } = await import(
      '../../pricing/modelPriceCatalogManagement.js'
    );
    const service = createModelPriceCatalogManagementService(
      authority.repository,
      {
        decisionMode,
        authorizer: authority.authorizer,
        ...(authority.quota === undefined ? {} : { quota: authority.quota }),
        ...(options.now === undefined ? {} : { now: options.now }),
      },
    );
    let accepting = true;
    let activeOperations = 0;
    let stopPromise: Promise<'stopped'> | undefined;
    let drainingAudited = false;

    const capability: ActiveModelPriceCatalogManagementCapability =
      Object.freeze({
        profile: options.profile,
        decisionMode,
        get accepting() {
          return accepting;
        },
        get activeOperations() {
          return activeOperations;
        },
        async publish(request: Readonly<PublishModelPriceCatalogRequest>) {
          if (!accepting) {
            throw new ModelPriceCatalogManagementProfileDrainingError();
          }
          activeOperations += 1;
          try {
            return await service.publish(request);
          } finally {
            activeOperations -= 1;
          }
        },
        async transition(
          request: Readonly<TransitionModelPriceCatalogRequest>,
        ) {
          if (!accepting) {
            throw new ModelPriceCatalogManagementProfileDrainingError();
          }
          activeOperations += 1;
          try {
            return await service.transition(request);
          } finally {
            activeOperations -= 1;
          }
        },
        async stop() {
          accepting = false;
          if (activeOperations !== 0) {
            if (!drainingAudited) {
              drainingAudited = true;
              await options.audit({
                profile: options.profile,
                state: 'draining',
                decisionMode,
              });
            }
            return 'draining';
          }
          if (stopPromise) return stopPromise;
          stopPromise = (async () => {
            await closeModelPriceCatalogManagementAuthority(authority!);
            await options.audit({
              profile: options.profile,
              state: 'stopped',
              decisionMode,
            });
            return 'stopped' as const;
          })();
          return stopPromise;
        },
      });
    await options.audit({
      profile: options.profile,
      state: 'active',
      decisionMode,
    });
    return Object.freeze({
      status: 'active',
      profile: options.profile,
      decisionMode,
      capability,
    });
  } catch (cause) {
    if (authority) {
      try {
        await closeModelPriceCatalogManagementAuthority(authority);
      } catch {
        // Preserve the activation failure.
      }
    }
    await bestEffortAudit(options.audit, {
      profile: options.profile,
      state: 'failed',
      decisionMode,
    });
    throw cause instanceof ModelPriceCatalogManagementProfileUnavailableError
      ? cause
      : new ModelPriceCatalogManagementProfileUnavailableError({
          cause: cause instanceof Error ? cause : undefined,
        });
  }
}
