#!/usr/bin/env node

const path = require('node:path');
const { performance } = require('node:perf_hooks');

const MIB = 1024 * 1024;
const PROFILES = Object.freeze(['edge', 'standalone', 'cluster']);
const args = new Map(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf('=');
    return separator === -1
      ? [argument, true]
      : [argument.slice(0, separator), argument.slice(separator + 1)];
  }),
);

function numericArgument(name) {
  const raw = args.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('AI Profile benchmark requires Node.js 24 or newer');
  }
  const beforeModules = new Set(Object.keys(require.cache));
  const rssBeforeBytes = process.memoryUsage().rss;
  const loadedAt = performance.now();
  const {
    bootstrapModelGatewayProfile,
    bootstrapModelPriceCatalogManagementProfile,
  } = require(path.resolve(
    __dirname,
    '../packages/ql3-ai/dist/profile/profileComposition.js',
  ));
  const moduleLoadMs = performance.now() - loadedAt;
  const rssAfterBytes = process.memoryUsage().rss;
  const loadedModules = Object.keys(require.cache).filter(
    (modulePath) => !beforeModules.has(modulePath),
  );

  const disabledProfiles = [];
  for (const profile of PROFILES) {
    let storageLoads = 0;
    let providerLoads = 0;
    let managementAuthorityLoads = 0;
    const states = [];
    const managementStates = [];
    const startedAt = performance.now();
    const result = await bootstrapModelGatewayProfile({
      enabled: false,
      profile,
      async loadStorage() {
        storageLoads += 1;
        throw new Error('disabled AI Profile opened storage');
      },
      async loadProviders() {
        providerLoads += 1;
        throw new Error('disabled AI Profile loaded provider credentials');
      },
      audit(record) {
        states.push(record.state);
      },
    });
    const gatewayDurationMs = performance.now() - startedAt;
    const managementStartedAt = performance.now();
    const managementResult = await bootstrapModelPriceCatalogManagementProfile({
      enabled: false,
      profile,
      async loadAuthority() {
        managementAuthorityLoads += 1;
        throw new Error('disabled price catalog management loaded authority');
      },
      audit(record) {
        managementStates.push(record.state);
      },
    });
    const managementDurationMs = performance.now() - managementStartedAt;
    if (
      result.status !== 'disabled' ||
      (await result.stop()) !== 'stopped' ||
      managementResult.status !== 'disabled' ||
      (await managementResult.stop()) !== 'stopped' ||
      storageLoads !== 0 ||
      providerLoads !== 0 ||
      managementAuthorityLoads !== 0 ||
      JSON.stringify(states) !== JSON.stringify(['disabled']) ||
      JSON.stringify(managementStates) !== JSON.stringify(['disabled'])
    ) {
      throw new Error(`${profile} disabled AI boundary widened`);
    }
    disabledProfiles.push({
      profile,
      gatewayDurationMs: Number(gatewayDurationMs.toFixed(3)),
      managementDurationMs: Number(managementDurationMs.toFixed(3)),
      storageLoads,
      providerLoads,
      managementAuthorityLoads,
      states,
      managementStates,
    });
  }

  const report = {
    schemaVersion: 1,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    moduleLoad: {
      durationMs: Number(moduleLoadMs.toFixed(3)),
      loadedModuleCount: loadedModules.length,
      rssBeforeBytes,
      rssAfterBytes,
      rssDeltaBytes: Math.max(0, rssAfterBytes - rssBeforeBytes),
    },
    disabledProfiles,
  };
  const maxRssDeltaMb = numericArgument('--max-rss-delta-mb');
  const maxDisabledActivationMs = numericArgument(
    '--max-disabled-activation-ms',
  );
  const violations = [];
  if (
    maxRssDeltaMb !== undefined &&
    report.moduleLoad.rssDeltaBytes > maxRssDeltaMb * MIB
  ) {
    violations.push(
      `module RSS delta ${report.moduleLoad.rssDeltaBytes} exceeded ${maxRssDeltaMb} MiB`,
    );
  }
  if (
    maxDisabledActivationMs !== undefined &&
    disabledProfiles.some(
      ({ gatewayDurationMs, managementDurationMs }) =>
        gatewayDurationMs > maxDisabledActivationMs ||
        managementDurationMs > maxDisabledActivationMs,
    )
  ) {
    violations.push(
      `disabled activation exceeded ${maxDisabledActivationMs}ms`,
    );
  }
  report.gates = {
    maxRssDeltaMb: maxRssDeltaMb ?? null,
    maxDisabledActivationMs: maxDisabledActivationMs ?? null,
    passed: violations.length === 0,
    violations,
  };
  process.stdout.write(
    `${JSON.stringify(report, null, args.has('--json') ? 0 : 2)}\n`,
  );
  if (violations.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `ql3 AI Profile benchmark failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
