// End-to-end task latency; isolated fixtures, no real panel or network access.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createContext } = require('../dist/local/context');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ql-latency-')));
const samples = 15;
try {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const context = createContext({ root }, { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, no_tee: 'true' });
  for (const directory of ['dir_shell', 'dir_preload', 'dir_config', 'dir_scripts', 'dir_log'])
    fs.mkdirSync(context.paths[directory], { recursive: true });
  fs.mkdirSync(path.join(root, 'static/build'), { recursive: true });
  for (const name of ['task.sh', 'otask.sh', 'share.sh', 'api.sh', 'env.sh'])
    fs.copyFileSync(path.resolve(__dirname, '../../shell', name), path.join(context.paths.dir_shell, name));
  fs.cpSync(path.resolve(__dirname, '../../shell/lang'), path.join(context.paths.dir_shell, 'lang'), { recursive: true });
  fs.writeFileSync(path.join(root, 'static/build/token.js'), 'process.stdout.write("fixture-token")');
  for (const name of ['file_env', 'list_crontab_user', 'file_task_before', 'file_task_after'])
    fs.writeFileSync(context.paths[name], '');
  fs.writeFileSync(context.paths.file_config_user, 'no_tee=true\n');
  const results = [];
  for (const delaySeconds of [0, 1]) {
    fs.writeFileSync(path.join(context.paths.dir_scripts, 'fixture.sh'),
      `${delaySeconds ? `sleep ${delaySeconds}\n` : ''}printf completed > "$BENCH_MARKER"\n`);
    const values = { shell: [], typescript: [] };
    for (let round = -2; round < samples; round++) {
      for (const kind of round % 2 === 0 ? ['shell', 'typescript'] : ['typescript', 'shell']) {
        const marker = path.join(root, 'marker');
        fs.rmSync(marker, { force: true });
        const start = performance.now();
        const child = spawnSync(kind === 'shell' ? '/bin/bash' : process.execPath,
          kind === 'shell'
            ? [path.join(context.paths.dir_shell, 'task.sh'), 'fixture.sh', 'now']
            : [path.resolve(__dirname, '../dist/runner.js'), '--root', root, 'fixture.sh', 'now'],
          { cwd: root, env: { ...context.env, BENCH_MARKER: marker }, encoding: 'utf8', timeout: 15000 });
        const elapsed = performance.now() - start;
        if (child.status !== 0 || !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== 'completed')
          throw new Error(`${kind} fixture failed: ${child.error || child.stderr || child.stdout}`);
        if (round >= 0) values[kind].push(elapsed);
      }
    }
    const summary = {};
    for (const [kind, times] of Object.entries(values)) {
      const sorted = [...times].sort((a, b) => a - b);
      summary[kind] = { medianMs: +sorted[7].toFixed(2), p95Ms: +sorted[14].toFixed(2), samplesMs: times.map(x => +x.toFixed(2)) };
    }
    results.push({ delaySeconds, ...summary });
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, samples,
    warmupsPerScenario: 2, method: 'Alternating fresh processes; same Shell script, config, hooks and log settings. Stub pnpm probe/token helper; no task ID or API reporting. Wall time includes process startup and cleanup. Not API, download, upgrade or scheduler throughput.', results }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
