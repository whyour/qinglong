const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const launcher = path.join(
  ROOT,
  'deploy/console/ql3-cluster-copilot/docker-loopback.sh',
);
const image = `ghcr.io/example/qinglong3-cluster-admin@sha256:${'a'.repeat(
  64,
)}`;

function fixture(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-copilot-console-launcher-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, 'private');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(privateRoot, { mode: 0o700 });
  fs.mkdirSync(bin, { mode: 0o700 });
  const capture = path.join(directory, 'docker-args');
  fs.writeFileSync(
    path.join(bin, 'docker'),
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$QL3_TEST_DOCKER_ARGS"\n',
    { mode: 0o700 },
  );
  return {
    privateRoot: fs.realpathSync(privateRoot),
    capture,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      QL3_TEST_DOCKER_ARGS: capture,
      QL3_COPILOT_CONSOLE_IMAGE: image,
      QL3_COPILOT_CONSOLE_PRIVATE_ROOT: fs.realpathSync(privateRoot),
      QL3_COPILOT_CONSOLE_NETWORK: 'qinglong3-console-egress',
      QL3_COPILOT_CONSOLE_PORT: '5701',
      QL3_COPILOT_CONSOLE_RESOURCE_CLASS: 'compact',
    },
  };
}

function invoke(mode, env) {
  return spawnSync(launcher, [mode], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
}

test('runs compact preflight without opening or publishing the Console', (t) => {
  assert.equal(fs.statSync(launcher).mode & 0o777, 0o755);
  const value = fixture(t);
  const result = invoke('check', value.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(
    fs.readFileSync(value.capture, 'utf8').trimEnd().split('\n'),
    [
      'run',
      '--rm',
      '--pull',
      'never',
      '--init',
      '--read-only',
      '--network',
      'qinglong3-console-egress',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '10001:10001',
      '--pids-limit',
      '32',
      '--memory',
      '192m',
      '--cpus',
      '0.25',
      '--stop-timeout',
      '3',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=8m,mode=700,uid=10001,gid=10001',
      '--mount',
      `type=bind,src=${value.privateRoot},dst=/var/run/secrets/qinglong3/copilot-console,readonly`,
      image,
      'copilot-console',
      '--container-published-loopback',
      '--port=5701',
      '--config',
      '/var/run/secrets/qinglong3/copilot-console/client.json',
      '--credential',
      '/var/run/secrets/qinglong3/copilot-console/credential',
      '--session',
      '/var/run/secrets/qinglong3/copilot-console/session',
      '--check',
    ],
  );
});

test('publishes standard serve only on host loopback', (t) => {
  const value = fixture(t);
  const result = invoke('serve', {
    ...value.env,
    QL3_COPILOT_CONSOLE_RESOURCE_CLASS: 'standard',
  });
  assert.equal(result.status, 0, result.stderr);
  const args = fs.readFileSync(value.capture, 'utf8').trimEnd().split('\n');
  assert.equal(args.includes('--check'), false);
  assert.equal(args[args.indexOf('--memory') + 1], '512m');
  assert.equal(args[args.indexOf('--cpus') + 1], '1');
  assert.equal(args[args.indexOf('--pids-limit') + 1], '64');
  assert.equal(args[args.indexOf('--publish') + 1], '127.0.0.1:5701:5701/tcp');
});

test('adds optional Run management files only after an explicit enabled switch', (t) => {
  const value = fixture(t);
  const result = invoke('check', {
    ...value.env,
    QL3_COPILOT_CONSOLE_RUN_MANAGEMENT: 'enabled',
  });
  assert.equal(result.status, 0, result.stderr);
  const args = fs.readFileSync(value.capture, 'utf8').trimEnd().split('\n');
  assert.equal(
    args[args.indexOf('--run-management-config') + 1],
    '/var/run/secrets/qinglong3/copilot-console/run-management-client.json',
  );
  assert.equal(
    args[args.indexOf('--run-management-assertion') + 1],
    '/var/run/secrets/qinglong3/copilot-console/run-management-assertion.jwt',
  );
});

test('rejects mutable, ambient and malformed host inputs before Docker', (t) => {
  const value = fixture(t);
  for (const environment of [
    { ...value.env, QL3_COPILOT_CONSOLE_IMAGE: 'ghcr.io/example/admin:latest' },
    { ...value.env, QL3_COPILOT_CONSOLE_NETWORK: 'host' },
    { ...value.env, QL3_COPILOT_CONSOLE_PORT: '80' },
    {
      ...value.env,
      QL3_COPILOT_CONSOLE_PRIVATE_ROOT: `${value.privateRoot}:rw`,
    },
    { ...value.env, QL3_COPILOT_CONSOLE_RESOURCE_CLASS: 'unbounded' },
    { ...value.env, QL3_COPILOT_CONSOLE_RUN_MANAGEMENT: 'ambient' },
  ]) {
    const rejected = invoke('serve', environment);
    assert.equal(rejected.status, 78);
    assert.equal(rejected.stdout, '');
    assert.deepEqual(JSON.parse(rejected.stderr), {
      schemaVersion: 1,
      component: 'qinglong3-cluster-copilot-console-launcher',
      event: 'launch_failed',
    });
    assert.equal(fs.existsSync(value.capture), false);
    assert.doesNotMatch(rejected.stderr, /latest|host|private|unbounded/);
  }
});
