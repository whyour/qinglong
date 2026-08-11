#!/usr/bin/env node

const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

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
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

const modulePath = path.resolve(
  __dirname,
  '../static/build/runtime/adapters/local-process/localProcessExecutor.js',
);
const rssBeforeModuleLoad = process.memoryUsage().rss;
let LocalProcessExecutor;
try {
  ({ LocalProcessExecutor } = require(modulePath));
} catch (error) {
  throw new Error(
    `Compiled QingLong 3.0 runtime was not found. Run pnpm build:back first. (${error.message})`,
  );
}
const rssAfterModuleLoad = process.memoryUsage().rss;

let idSequence = 400;
function nextId() {
  idSequence += 1;
  return `019f7100-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
}

function createSpec(overrides = {}) {
  return {
    runId: nextId(),
    attemptId: nextId(),
    projectId: 'benchmark',
    taskId: 'edge-executor-benchmark',
    taskRevision: 'benchmark-v1',
    command: {
      kind: 'argv',
      file: process.execPath,
      args: ['-e', 'process.exit(0)'],
    },
    environmentPolicy: 'isolated',
    terminationGraceMs: 100,
    ...overrides,
  };
}

function createCountingSink() {
  const metrics = { bytes: 0, lines: 0, writes: 0 };
  return {
    metrics,
    context: {
      environment: {},
      output: {
        async write(output) {
          metrics.bytes += output.chunk.byteLength;
          metrics.writes += 1;
          for (const byte of output.chunk) {
            if (byte === 10) metrics.lines += 1;
          }
        },
      },
    },
  };
}

async function measuredExecution(executor, name, spec, context) {
  const baselineRssBytes = process.memoryUsage().rss;
  let peakRssBytes = baselineRssBytes;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 5);
  sampler.unref?.();
  const startedAt = performance.now();
  try {
    const handle = await executor.start(spec, context);
    const result = await handle.completion;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    return {
      name,
      durationMs: Number((performance.now() - startedAt).toFixed(3)),
      baselineRssBytes,
      peakRssBytes,
      peakRssDeltaBytes: Math.max(0, peakRssBytes - baselineRssBytes),
      outcome: result.outcome,
      exitCode: result.exitCode,
    };
  } finally {
    clearInterval(sampler);
  }
}

async function main() {
  const executor = new LocalProcessExecutor({ createHandleId: nextId });

  const noopOutput = createCountingSink();
  const noop = await measuredExecution(
    executor,
    'single_noop',
    createSpec(),
    noopOutput.context,
  );

  const logOutput = createCountingSink();
  const log = await measuredExecution(
    executor,
    'stdout_10000_lines',
    createSpec({
      command: {
        kind: 'argv',
        file: process.execPath,
        args: [
          '-e',
          "for (let i = 0; i < 10000; i += 1) process.stdout.write(String(i).padStart(5, '0') + ' ql3-edge-benchmark\\n')",
        ],
      },
    }),
    logOutput.context,
  );
  log.output = logOutput.metrics;

  const cancelOutput = createCountingSink();
  const cancelHandle = await executor.start(
    createSpec({
      command: {
        kind: 'argv',
        file: process.execPath,
        args: ['-e', 'setInterval(() => undefined, 1000)'],
      },
    }),
    cancelOutput.context,
  );
  await delay(10);
  const cancelStartedAt = performance.now();
  const stop = await executor.stop(cancelHandle, {
    kind: 'user',
    requestedAtMs: Date.now(),
  });
  const cancelResult = await cancelHandle.completion;
  const cancellation = {
    durationMs: Number((performance.now() - cancelStartedAt).toFixed(3)),
    outcome: cancelResult.outcome,
    termSignalSent: stop.termSignalSent,
    killSignalSent: stop.killSignalSent,
  };

  if (noop.outcome !== 'succeeded' || log.outcome !== 'succeeded') {
    throw new Error('Executor smoke workload did not succeed');
  }
  if (log.output.lines !== 10_000) {
    throw new Error(
      `Executor output benchmark expected 10000 lines, observed ${log.output.lines}`,
    );
  }
  if (cancellation.outcome !== 'cancelled') {
    throw new Error('Executor cancellation workload was not cancelled');
  }

  const report = {
    schemaVersion: 1,
    profile: 'edge',
    generatedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    moduleLoad: {
      rssBeforeBytes: rssBeforeModuleLoad,
      rssAfterBytes: rssAfterModuleLoad,
      rssDeltaBytes: Math.max(0, rssAfterModuleLoad - rssBeforeModuleLoad),
    },
    cases: [noop, log],
    cancellation,
  };

  const maxRssDeltaMb = numericArgument('--max-rss-delta-mb');
  const maxCancelMs = numericArgument('--max-cancel-ms');
  const observedPeakDeltaBytes = Math.max(
    report.moduleLoad.rssDeltaBytes,
    ...report.cases.map((item) => item.peakRssDeltaBytes),
  );
  const violations = [];
  if (
    maxRssDeltaMb !== undefined &&
    observedPeakDeltaBytes > maxRssDeltaMb * 1024 * 1024
  ) {
    violations.push(
      `peak RSS delta ${observedPeakDeltaBytes} exceeded ${maxRssDeltaMb} MiB`,
    );
  }
  if (maxCancelMs !== undefined && cancellation.durationMs > maxCancelMs) {
    violations.push(
      `cancellation ${cancellation.durationMs}ms exceeded ${maxCancelMs}ms`,
    );
  }
  report.gates = {
    maxRssDeltaMb: maxRssDeltaMb ?? null,
    maxCancelMs: maxCancelMs ?? null,
    passed: violations.length === 0,
    violations,
  };

  if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  if (violations.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`ql3 edge benchmark failed: ${error.message}\n`);
  process.exitCode = 1;
});
