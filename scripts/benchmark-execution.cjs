// Microbenchmark of the process observer, not a container or scheduler benchmark.
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { observeChildProcess } = require('../back/shared/childProcess');

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const runsArg = args.find((arg) => arg.startsWith('--runs='));
const runs = runsArg ? Number(runsArg.slice(7)) : 30;
if (!Number.isInteger(runs) || runs < 3 || runs > 10000)
  throw new Error('runs must be between 3 and 10000');
const output = args.find((arg) => arg.startsWith('--output='))?.slice(9);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const scenarios = [
  { name: 'empty-node', command: '' },
  {
    name: 'log-1MiB',
    command: 'process.stdout.write("x".repeat(1024 * 1024))',
    bytes: 1024 * 1024,
  },
  { name: 'spawn-failure', shell: '/nonexistent-ql-benchmark-shell' },
];

(async () => {
  const report = {
    schema: 1,
    observerSha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync('back/shared/childProcess.ts'))
      .digest('hex'),
    benchmarkSha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(__filename))
      .digest('hex'),
    scope:
      'local process observer only; parent CPU excludes child CPU; no panel/container load measured',
    sourceCommit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain') !== '',
    lockfileSha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync('pnpm-lock.yaml'))
      .digest('hex'),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    timestamp: new Date().toISOString(),
    runs,
    scenarios: [],
  };
  for (const scenario of scenarios) {
    const samples = [];
    const cpuStart = process.cpuUsage();
    for (let index = 0; index < runs; index++) {
      const start = performance.now();
      let bytes = 0;
      const child = scenario.shell
        ? spawn('true', { shell: scenario.shell })
        : spawn(process.execPath, ['-e', scenario.command]);
      const result = await observeChildProcess(child, {
        onStdout: async (chunk) => {
          bytes += Buffer.byteLength(chunk);
        },
      }).completed;
      if (scenario.shell ? !result.error : result.error || result.code !== 0)
        throw new Error(`Unexpected result: ${scenario.name}`);
      if (bytes !== (scenario.bytes || 0))
        throw new Error(`Output loss: ${scenario.name}`);
      samples.push({
        wallMs: performance.now() - start,
        bytes,
        code: result.code,
        error: result.error?.message,
      });
    }
    const sorted = samples.map((sample) => sample.wallMs).sort((a, b) => a - b);
    const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
    report.scenarios.push({
      name: scenario.name,
      parentCpuMicros: process.cpuUsage(cpuStart),
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      ...(runs >= 100 ? { p99Ms: percentile(0.99) } : {}),
      samples,
    });
  }
  const json = JSON.stringify(report, null, 2) + '\n';
  if (output) fs.writeFileSync(output, json);
  else process.stdout.write(json);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
