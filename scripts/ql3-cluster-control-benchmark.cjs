#!/usr/bin/env node

const path = require('node:path');
const { performance } = require('node:perf_hooks');

const MIB = 1024 * 1024;
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
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 24) {
    throw new Error('cluster-control benchmark requires Node.js 24 or newer');
  }
  const modulePath = path.resolve(
    __dirname,
    '../packages/ql3-cluster-control/dist/application-runtime/clusterControlRuntime.js',
  );
  const rssBeforeBytes = process.memoryUsage().rss;
  const loadedAt = performance.now();
  const { bootstrapClusterControlRuntime } = require(modulePath);
  const rssAfterBytes = process.memoryUsage().rss;
  const moduleLoadMs = performance.now() - loadedAt;

  let databaseOpenCount = 0;
  let assemblyCount = 0;
  const auditStates = [];
  const startedAt = performance.now();
  const activation = await bootstrapClusterControlRuntime({
    enabled: false,
    profile: 'cluster-control',
    async openDatabase() {
      databaseOpenCount += 1;
      throw new Error('disabled cluster-control opened PostgreSQL');
    },
    create() {
      assemblyCount += 1;
      throw new Error('disabled cluster-control assembled a runtime stack');
    },
    audit(record) {
      auditStates.push(record.state);
    },
  });
  const disabledActivationMs = performance.now() - startedAt;
  if (activation.status !== 'disabled') {
    throw new Error(
      'cluster-control disabled benchmark unexpectedly activated',
    );
  }
  if ((await activation.stop()) !== 'stopped') {
    throw new Error('cluster-control disabled stop did not converge');
  }
  if (
    databaseOpenCount !== 0 ||
    assemblyCount !== 0 ||
    auditStates.length !== 1 ||
    auditStates[0] !== 'disabled'
  ) {
    throw new Error(
      'cluster-control disabled boundary widened during benchmark',
    );
  }

  const report = {
    schemaVersion: 1,
    profile: 'cluster-control',
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    moduleLoad: {
      durationMs: Number(moduleLoadMs.toFixed(3)),
      rssBeforeBytes,
      rssAfterBytes,
      rssDeltaBytes: Math.max(0, rssAfterBytes - rssBeforeBytes),
    },
    disabledActivation: {
      durationMs: Number(disabledActivationMs.toFixed(3)),
      databaseOpenCount,
      assemblyCount,
      auditStates,
    },
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
    report.disabledActivation.durationMs > maxDisabledActivationMs
  ) {
    violations.push(
      `disabled activation ${report.disabledActivation.durationMs}ms exceeded ${maxDisabledActivationMs}ms`,
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
    `ql3 cluster-control benchmark failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
