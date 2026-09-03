#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  validateLocalApiCancellationLiveReport,
} = require('./ql3-local-api-cancellation-live-audit.cjs');

const ROOT = path.resolve(__dirname, '..');
const {
  preparePanelClient,
} = require('./lib/ql3-panel-run-control-live-client.cjs');
const NODE_IMAGE =
  'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d';

function fail(message) {
  throw new Error(
    `QingLong Local API cancellation live contract failed: ${message}`,
  );
}

function argumentsOf(argv) {
  if (argv.length !== 2)
    fail(
      'usage: --profile=edge|standalone --report=/absolute/private-report.json',
    );
  const values = Object.fromEntries(
    argv.map((argument) => {
      const match = /^--(profile|report)=(.+)$/.exec(argument);
      if (!match) fail(`unsupported argument ${argument}`);
      return [match[1], match[2]];
    }),
  );
  if (!['edge', 'standalone'].includes(values.profile))
    fail('profile is invalid');
  if (
    !path.isAbsolute(values.report ?? '') ||
    path.normalize(values.report) !== values.report ||
    path.parse(values.report).root === values.report ||
    fs.existsSync(values.report)
  )
    fail('report must be a fresh normalized absolute non-root path');
  const parent = fs.lstatSync(path.dirname(values.report));
  if (!parent.isDirectory() || parent.isSymbolicLink())
    fail('report parent must be a real directory');
  return Object.freeze(values);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      `${command} ${args[0]} failed: ${(result.stderr || result.stdout)
        .trim()
        .slice(0, 4096)}`,
    );
  }
  return result.stdout.trim();
}

function main(argv = process.argv.slice(2)) {
  const selected = argumentsOf(argv);
  if (process.env.QL3_LOCAL_API_CANCELLATION_LIVE !== '1') {
    fail('refusing to run Docker without QL3_LOCAL_API_CANCELLATION_LIVE=1');
  }
  const temporaryRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-local-api-cancel-live-')),
  );
  fs.chmodSync(temporaryRoot, 0o700);
  const artifactRoot = path.join(temporaryRoot, 'artifact');
  const evidenceRoot = path.join(temporaryRoot, 'evidence');
  fs.mkdirSync(evidenceRoot, { mode: 0o700 });
  try {
    preparePanelClient(ROOT, path.join(evidenceRoot, 'panel-client'));
    const artifactOutput = run(process.execPath, [
      path.join(ROOT, 'scripts/ql3-local-profile-artifact-audit.cjs'),
      `${selected.profile}-application-api`,
      `--output-directory=${artifactRoot}`,
    ]);
    const artifact = JSON.parse(artifactOutput.split(/\r?\n/).at(-1));
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const gid = typeof process.getgid === 'function' ? process.getgid() : null;
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid))
      fail('a POSIX identity is required');
    const memory = selected.profile === 'edge' ? '128m' : '256m';
    const pids = selected.profile === 'edge' ? '64' : '256';
    run('docker', [
      'run',
      '--rm',
      '--read-only',
      '--user',
      `${uid}:${gid}`,
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      memory,
      '--memory-swap',
      memory,
      '--cpus',
      '0.5',
      '--pids-limit',
      pids,
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,size=16m',
      '--volume',
      `${artifactRoot}:/opt/ql3-artifact:ro`,
      '--volume',
      `${path.join(ROOT, 'scripts')}:/opt/ql3-scripts:ro`,
      '--volume',
      `${evidenceRoot}:/evidence`,
      NODE_IMAGE,
      'node',
      '/opt/ql3-scripts/lib/ql3-local-api-cancellation-live-scenario.cjs',
      '/opt/ql3-artifact',
      '/evidence',
      selected.profile,
    ]);
    const scenario = JSON.parse(
      fs.readFileSync(path.join(evidenceRoot, 'report.json'), 'utf8'),
    );
    const report = Object.freeze({
      ...scenario,
      artifact: Object.freeze({
        profile: artifact.profile,
        bytes: artifact.artifactBytes,
        files: artifact.artifactFiles,
        loadedModules: artifact.loadedModuleCount,
        compatible: artifact.compatible,
      }),
    });
    const audit = validateLocalApiCancellationLiveReport(report);
    assert.deepEqual(audit.findings, []);
    fs.writeFileSync(selected.report, `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 2,
        profile: selected.profile,
        reportWritten: true,
        compatible: true,
      })}\n`,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error ? error.stack || error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = { argumentsOf };
