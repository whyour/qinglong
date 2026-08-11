import path from 'path';
import config from '../../../config';
import Logger from '../../../loaders/logger';
import {
  activateManualPrimaryRuntime,
  type ManualPrimaryActivationAudit,
  type ManualPrimaryActivationStack,
} from '../../application/manualPrimaryRuntimeActivation';
import { installManualPrimaryExecutionRouter } from '../../compatibility/manualPrimaryExecutionBridge';
import type { RuntimeRolloutPolicy } from '../../domain/runtimeRollout';
import { parseDeploymentProfile } from '../../domain/deploymentProfile';
import type { RuntimeRolloutLoadResult } from '../../ports/runtimeRolloutLoader';
import { loadRuntimeRolloutManifest } from '../fs/runtimeRolloutManifestLoader';
import type { DefaultManualPrimaryActivationOptions } from './defaultManualPrimaryActivation';

export const DEFAULT_RUNTIME_ROLLOUT_MANIFEST_FILE = 'qinglong3-rollout.json';

interface DefaultManualPrimaryStackModule {
  createDefaultManualPrimaryActivationStack(
    rollout: RuntimeRolloutPolicy,
    options?: DefaultManualPrimaryActivationOptions,
  ): ManualPrimaryActivationStack;
}

export interface BootstrapDefaultManualPrimaryRuntimeOptions
  extends DefaultManualPrimaryActivationOptions {
  load?: () => Promise<RuntimeRolloutLoadResult>;
  loadStack?: () => Promise<DefaultManualPrimaryStackModule>;
  install?: typeof installManualPrimaryExecutionRouter;
  audit?: (record: ManualPrimaryActivationAudit) => void | Promise<void>;
}

/**
 * Lightweight HTTP-worker bootstrap. Heavy Runtime adapters are imported only
 * after an accepted manifest explicitly selects manual Primary ownership.
 */
export async function bootstrapDefaultManualPrimaryRuntime(
  options: BootstrapDefaultManualPrimaryRuntimeOptions = {},
) {
  const sourcePath = path.join(
    config.configPath,
    DEFAULT_RUNTIME_ROLLOUT_MANIFEST_FILE,
  );
  const load = await (
    options.load ?? (() => loadRuntimeRolloutManifest(sourcePath))
  )();
  const selected =
    load.status === 'accepted' && load.policy.modeFor('manual') === 'primary';
  const audit =
    options.audit ??
    ((record: ManualPrimaryActivationAudit) => {
      Logger.info(`[runtime-activation] ${JSON.stringify(record)}`);
    });
  let stackModule: DefaultManualPrimaryStackModule | undefined;
  if (selected) {
    try {
      stackModule = await (
        options.loadStack ?? (() => import('./defaultManualPrimaryActivation'))
      )();
    } catch (error) {
      try {
        await audit({ ...load.audit, activation: 'failed' });
      } catch {
        // Preserve the module load error without exposing manifest contents.
      }
      throw error;
    }
  }
  const activationOptions: DefaultManualPrimaryActivationOptions = {
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
    ...(options.completion === undefined
      ? {}
      : { completion: options.completion }),
    ...(options.cancellation === undefined
      ? {}
      : { cancellation: options.cancellation }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  };

  return activateManualPrimaryRuntime({
    load: async () => load,
    create(rollout) {
      if (!stackModule) {
        throw new Error('Primary stack was not loaded for the selected policy');
      }
      return stackModule.createDefaultManualPrimaryActivationStack(rollout, {
        ...activationOptions,
        deploymentProfile:
          options.deploymentProfile ??
          parseDeploymentProfile(process.env.QL_DEPLOYMENT_PROFILE),
      });
    },
    install: options.install ?? installManualPrimaryExecutionRouter,
    audit,
  });
}
