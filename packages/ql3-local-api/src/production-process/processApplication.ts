import {
  runProductionLocalApplicationProcess,
  type LocalApplicationProcessEvent,
  type LocalApplicationProcessSignalSource,
} from '@qinglong/local-application/process';
import type { LocalApplicationStopResult } from '@qinglong/local-application';

import {
  createLocalApiProductSurface,
  type LocalApiProductSurfaceEvent,
} from '../application-runtime/localApiProductSurface';
import {
  readLocalApiProcessConfig,
  type LocalApiProcessConfig,
} from './config';

export interface ProductionLocalApiProcessOptions {
  readonly configFilePath: string;
  readonly signals: LocalApplicationProcessSignalSource;
  readonly emit: (
    event: Readonly<LocalApplicationProcessEvent | LocalApiProductSurfaceEvent>,
  ) => void | Promise<void>;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
}

export interface ProductionLocalApiProcessAdapters {
  readonly readConfig: typeof readLocalApiProcessConfig;
  readonly runApplication: typeof runProductionLocalApplicationProcess;
}

function validateOptions(options: ProductionLocalApiProcessOptions): void {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.configFilePath !== 'string' ||
    typeof options.signals?.subscribe !== 'function' ||
    typeof options.emit !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.randomUuid !== undefined &&
      typeof options.randomUuid !== 'function')
  ) {
    throw new TypeError('Production Local API process options are invalid');
  }
}

function validateAdapters(adapters: ProductionLocalApiProcessAdapters): void {
  if (
    !adapters ||
    typeof adapters !== 'object' ||
    Array.isArray(adapters) ||
    typeof adapters.readConfig !== 'function' ||
    typeof adapters.runApplication !== 'function'
  ) {
    throw new TypeError('Production Local API process adapters are invalid');
  }
}

export async function runProductionLocalApiProcess(
  options: ProductionLocalApiProcessOptions,
  adapters: ProductionLocalApiProcessAdapters = {
    readConfig: readLocalApiProcessConfig,
    runApplication: runProductionLocalApplicationProcess,
  },
): Promise<LocalApplicationStopResult> {
  validateOptions(options);
  validateAdapters(adapters);
  const config: Readonly<LocalApiProcessConfig> = adapters.readConfig(
    options.configFilePath,
  );
  const surface = createLocalApiProductSurface(config, {
    emit: options.emit,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.randomUuid === undefined
      ? {}
      : { randomUuid: options.randomUuid }),
  });
  return adapters.runApplication({
    configFilePath: config.applicationConfigFilePath,
    signals: options.signals,
    emit: options.emit,
    productSurface: surface,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
