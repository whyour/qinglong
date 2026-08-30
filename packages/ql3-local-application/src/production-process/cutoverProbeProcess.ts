import { inspectLocalSqliteReadinessPath } from '@qinglong/local-sqlite/readiness-inspection';

import type {
  LocalApplicationProcessEvent,
  LocalApplicationProcessSignal,
  ProductionLocalApplicationProcessOptions,
} from './processApplication';
import { verifyLocalApplicationCutoverCommitment } from './cutoverCommitment';
import { verifyLocalApplicationLegacyDataCommitment } from './legacyDataApplicationCommitment';
import { loadLocalApplicationProcessConfig } from './processConfig';
import { recordLocalApplicationShutdownReceipt } from './shutdownReceipt';
import { recordLocalApplicationStartupReceipt } from './startupReceipt';

export type ProductionLocalApplicationCutoverProbeOptions = Pick<
  ProductionLocalApplicationProcessOptions,
  'configFilePath' | 'emit' | 'signals'
>;

export class LocalApplicationCutoverProbeError extends Error {
  readonly code = 'QL3_LOCAL_APPLICATION_CUTOVER_PROBE_INVALID';

  constructor(message: string) {
    super(`Local application cutover probe is invalid: ${message}`);
    this.name = 'LocalApplicationCutoverProbeError';
  }
}

function event(
  config: Readonly<{
    instanceId: string;
    profile: 'edge' | 'standalone';
  }>,
  values: Omit<
    LocalApplicationProcessEvent,
    'component' | 'instanceId' | 'profile' | 'schemaVersion'
  >,
): Readonly<LocalApplicationProcessEvent> {
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-local-application',
    instanceId: config.instanceId,
    profile: config.profile,
    ...values,
  });
}

/**
 * Proves that one adopted target is readable by this exact application image
 * while recovery, scheduling, execution and product admission remain frozen.
 * The probe owns no write-capable database connection.
 */
export async function runProductionLocalApplicationCutoverProbe(
  options: ProductionLocalApplicationCutoverProbeOptions,
): Promise<'stopped'> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.configFilePath !== 'string' ||
    typeof options.emit !== 'function' ||
    typeof options.signals?.subscribe !== 'function'
  ) {
    throw new TypeError('Local application cutover probe options are invalid');
  }
  const config = loadLocalApplicationProcessConfig(options.configFilePath);
  if (config.storage.mode !== 'adopted') {
    throw new LocalApplicationCutoverProbeError(
      'only adopted storage can be probed',
    );
  }
  verifyLocalApplicationLegacyDataCommitment(config);
  verifyLocalApplicationCutoverCommitment(config);

  let resolveSignal:
    | ((signal: LocalApplicationProcessSignal) => void)
    | undefined;
  const requestedSignal = new Promise<LocalApplicationProcessSignal>(
    (resolve) => {
      resolveSignal = resolve;
    },
  );
  let acceptedSignal = false;
  const unsubscribe = options.signals.subscribe((signal) => {
    if (acceptedSignal) return;
    acceptedSignal = true;
    resolveSignal?.(signal);
  });
  const keepAlive = setInterval(() => undefined, 2_147_483_647);

  try {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await inspectLocalSqliteReadinessPath({
      databasePath: config.storage.targetPath,
      profile: config.profile,
      ...(config.storage.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: config.storage.busyTimeoutMs }),
    });
    await options.emit(
      event(config, {
        level: 'info',
        event: 'cutover_probe_storage_ready',
      }),
    );
    const startupReceipt = recordLocalApplicationStartupReceipt({
      configFilePath: options.configFilePath,
      instanceId: config.instanceId,
      profile: config.profile,
      aiStatus: 'deployment_excluded',
    });
    if (startupReceipt === undefined) {
      throw new LocalApplicationCutoverProbeError(
        'a Linux startup receipt is required',
      );
    }
    await options.emit(
      event(config, {
        level: 'info',
        event: 'cutover_probe_active',
        aiStatus: 'deployment_excluded',
      }),
    );
    const signal = await requestedSignal;
    await options.emit(
      event(config, {
        level: 'info',
        event: 'shutdown_requested',
        signal,
      }),
    );
    recordLocalApplicationShutdownReceipt({
      configFilePath: options.configFilePath,
      instanceId: config.instanceId,
      profile: config.profile,
      signal,
      startupReceiptDigest: startupReceipt.sha256,
    });
    await options.emit(
      event(config, {
        level: 'info',
        event: 'cutover_probe_stopped',
        stopResult: 'stopped',
      }),
    );
    return 'stopped';
  } finally {
    clearInterval(keepAlive);
    unsubscribe();
    resolveSignal = undefined;
  }
}
