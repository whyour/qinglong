const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const launcher = path.join(
  ROOT,
  'deploy/mcp/ql3-cluster-copilot/docker-stdio.sh',
);
const image = `registry.example/qinglong3-cluster-admin@sha256:${'a'.repeat(
  64,
)}`;

function fixture(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-copilot-mcp-launcher-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, 'private');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(privateRoot, { mode: 0o700 });
  fs.mkdirSync(bin, { mode: 0o700 });
  const capture = path.join(directory, 'docker-args');
  const docker = path.join(bin, 'docker');
  fs.writeFileSync(
    docker,
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
      QL3_COPILOT_MCP_IMAGE: image,
      QL3_COPILOT_MCP_PRIVATE_ROOT: fs.realpathSync(privateRoot),
      QL3_COPILOT_MCP_NETWORK: 'qinglong3-copilot-egress',
      QL3_COPILOT_MCP_RESOURCE_CLASS: 'compact',
    },
  };
}

function invoke(args, env) {
  return spawnSync(launcher, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
}

test('launches exact compact preflight with no ambient authority widening', (t) => {
  assert.equal(fs.statSync(launcher).mode & 0o777, 0o755);
  const value = fixture(t);
  const result = invoke(['check'], value.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(
    fs.readFileSync(value.capture, 'utf8').trimEnd().split('\n'),
    [
      'run',
      '--rm',
      '-i',
      '--pull',
      'never',
      '--init',
      '--read-only',
      '--network',
      'qinglong3-copilot-egress',
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
      '--mount',
      `type=bind,src=${value.privateRoot},dst=/var/run/secrets/qinglong3/copilot-mcp,readonly`,
      image,
      'copilot-mcp',
      '--check',
      '--config',
      '/var/run/secrets/qinglong3/copilot-mcp/mcp.json',
      '--concurrency-ceiling=1',
    ],
  );
});

test('binds standard serve resources and rejects tags or ambient networks', (t) => {
  const value = fixture(t);
  const served = invoke(['serve'], {
    ...value.env,
    QL3_COPILOT_MCP_RESOURCE_CLASS: 'standard',
  });
  assert.equal(served.status, 0, served.stderr);
  const args = fs.readFileSync(value.capture, 'utf8').trimEnd().split('\n');
  assert.equal(args.includes('--check'), false);
  assert.equal(args[args.indexOf('--memory') + 1], '512m');
  assert.equal(args[args.indexOf('--cpus') + 1], '1');
  assert.equal(args[args.indexOf('--pids-limit') + 1], '64');
  assert.equal(args.at(-1), '--concurrency-ceiling=4');

  fs.rmSync(value.capture);
  for (const environment of [
    { ...value.env, QL3_COPILOT_MCP_IMAGE: 'registry.example/qinglong:latest' },
    { ...value.env, QL3_COPILOT_MCP_NETWORK: 'host' },
  ]) {
    const rejected = invoke(['serve'], environment);
    assert.equal(rejected.status, 78);
    assert.equal(rejected.stdout, '');
    assert.deepEqual(JSON.parse(rejected.stderr), {
      schemaVersion: 1,
      component: 'qinglong3-cluster-copilot-mcp-launcher',
      event: 'launch_failed',
    });
    assert.equal(fs.existsSync(value.capture), false);
    assert.doesNotMatch(rejected.stderr, /registry|private|host/);
  }
});
