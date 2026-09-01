import {
  runProductionLocalApplicationCutoverProbe,
  type ProductionLocalApplicationCutoverProbeOptions,
} from '@qinglong/local-application/cutover-probe';

import {
  readLocalApiProcessConfig,
  type LocalApiProcessConfig,
} from './config';

export type ProductionLocalApiCutoverProbeOptions =
  ProductionLocalApplicationCutoverProbeOptions;

export interface ProductionLocalApiCutoverProbeAdapters {
  readonly readConfig: typeof readLocalApiProcessConfig;
  readonly runApplicationProbe: typeof runProductionLocalApplicationCutoverProbe;
}

function validateOptions(options: ProductionLocalApiCutoverProbeOptions): void {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.configFilePath !== 'string' ||
    typeof options.signals?.subscribe !== 'function' ||
    typeof options.emit !== 'function'
  ) {
    throw new TypeError(
      'Production Local API cutover probe options are invalid',
    );
  }
}

function validateAdapters(
  adapters: ProductionLocalApiCutoverProbeAdapters,
): void {
  if (
    !adapters ||
    typeof adapters !== 'object' ||
    Array.isArray(adapters) ||
    typeof adapters.readConfig !== 'function' ||
    typeof adapters.runApplicationProbe !== 'function'
  ) {
    throw new TypeError(
      'Production Local API cutover probe adapters are invalid',
    );
  }
}

/**
 * Binds the exact Local API entry configuration to the read-only adopted
 * Application probe. No listener, credential authority, scheduler, recovery
 * or write-capable database connection is opened in this mode.
 */
export async function runProductionLocalApiCutoverProbe(
  options: ProductionLocalApiCutoverProbeOptions,
  adapters: ProductionLocalApiCutoverProbeAdapters = {
    readConfig: readLocalApiProcessConfig,
    runApplicationProbe: runProductionLocalApplicationCutoverProbe,
  },
): Promise<'stopped'> {
  validateOptions(options);
  validateAdapters(adapters);
  const config: Readonly<LocalApiProcessConfig> = adapters.readConfig(
    options.configFilePath,
  );
  return adapters.runApplicationProbe({
    configFilePath: config.applicationConfigFilePath,
    signals: options.signals,
    emit: options.emit,
  });
}
