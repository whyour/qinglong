const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  normalizeLocalDeploymentLegacyReadinessCommand,
  proveLocalDeploymentLegacyReadiness,
} = require('../dist/deployment/localDeployment.js');
const {
  probeLegacySystemEndpoint,
} = require('../dist/deployment/cutover/legacy-readiness/probe.js');
const {
  advanceLocalCutoverInstanceHead,
  claimLocalCutoverInstance,
  readLocalCutoverInstanceHead,
} = require('../dist/deployment/cutover/instanceLineage.js');

function rootAcknowledgement() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function fixture(t, profile = 'edge', instanceId = `${profile}-legacy-1`) {
  const deploymentRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-legacy-readiness-')),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  fs.mkdirSync(path.join(deploymentRoot, 'service'), { mode: 0o700 });
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const identity = {
    options: { deploymentRoot },
    request: {
      cutoverId: `cutover-${instanceId}`,
      profile,
      instanceId,
      expectedActivationDigest: 'a'.repeat(64),
      requestedAtMs: 1_787_200_000_000,
    },
  };
  const uid = process.getuid();
  claimLocalCutoverInstance(identity, uid, '0'.repeat(64));
  const transitions = [
    ['legacy_stopped', 0, '1'.repeat(64)],
    ['target_active', 1, '2'.repeat(64)],
    ['target_stopped', 1, '3'.repeat(64)],
    ['rollback_prepared', 1, '4'.repeat(64)],
    ['legacy_restart_requested', 1, '5'.repeat(64)],
    ['legacy_running', 1, '6'.repeat(64)],
  ];
  let head;
  for (const [state, generation, sourceDigest] of transitions) {
    head = advanceLocalCutoverInstanceHead(
      identity,
      uid,
      state,
      generation,
      sourceDigest,
    );
  }
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.cutover.legacy-readiness-probe',
    options: {
      deploymentRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      cutoverId: identity.request.cutoverId,
      profile,
      instanceId,
      generation: 1,
      expectedActivationDigest: identity.request.expectedActivationDigest,
      expectedInstanceHeadDigest: head.headDigest,
      expectedLegacyRunningRecordDigest: '6'.repeat(64),
      legacyHttpPort: 5700,
      expectedLegacyVersion: '2.21.0',
      requestedAtMs: 1_787_200_030_000,
    },
  };
  return { command, deploymentRoot, head, uid };
}

test('normalizes a closed legacy readiness command', (t) => {
  const state = fixture(t);
  const normalized = normalizeLocalDeploymentLegacyReadinessCommand(
    state.command,
  );
  assert.equal(normalized.request.legacyHttpPort, 5700);
  assert.equal(normalized.request.expectedLegacyVersion, '2.21.0');
  assert.throws(
    () =>
      normalizeLocalDeploymentLegacyReadinessCommand({
        ...state.command,
        request: { ...state.command.request, endpoint: 'http://example.com' },
      }),
    /request shape is invalid/,
  );
  assert.throws(
    () =>
      normalizeLocalDeploymentLegacyReadinessCommand({
        ...state.command,
        request: { ...state.command.request, expectedLegacyVersion: '3.0.0' },
      }),
    /request identity is invalid/,
  );
  assert.throws(
    () =>
      normalizeLocalDeploymentLegacyReadinessCommand({
        ...state.command,
        request: { ...state.command.request, legacyHttpPort: 65_536 },
      }),
    /legacyHttpPort is invalid/,
  );
});

test('persists a legacy-ready receipt and replays without network authority', async (t) => {
  const state = fixture(t);
  let attempts = 0;
  let clock = state.command.request.requestedAtMs;
  const result = await proveLocalDeploymentLegacyReadiness(state.command, {
    now: () => clock,
    wait: async (milliseconds) => {
      clock += milliseconds;
    },
    async probe(input) {
      attempts += 1;
      assert.deepEqual(
        { host: input.host, port: input.port, path: input.path },
        { host: '127.0.0.1', port: 5700, path: '/api/system' },
      );
      return attempts < 3
        ? { ready: false, reason: 'not_initialized' }
        : { ready: true, initialized: true, version: '2.21.0' };
    },
  });
  assert.equal(result.status, 'prepared');
  assert.equal(result.state, 'legacy_ready');
  assert.equal(result.attempts, 3);
  assert.match(result.receiptDigest, /^[0-9a-f]{64}$/);
  const receiptPath = path.join(
    state.deploymentRoot,
    'service',
    'cutover-instances',
    state.command.request.instanceId,
    'legacy-readiness-g1.json',
  );
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.state, 'legacy_ready');
  assert.equal(receipt.endpoint.host, '127.0.0.1');
  assert.equal(receipt.endpoint.path, '/api/system');
  assert.equal(receipt.observedVersion, '2.21.0');
  assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
  const head = readLocalCutoverInstanceHead(
    state.deploymentRoot,
    state.command.request.instanceId,
    state.uid,
  );
  assert.equal(head.state, 'legacy_ready');
  assert.equal(head.previousHeadDigest, state.head.headDigest);
  assert.equal(head.sourceRecordDigest, result.receiptDigest);

  const replay = await proveLocalDeploymentLegacyReadiness(state.command, {
    async probe() {
      throw new Error('exact replay must not open loopback HTTP authority');
    },
  });
  assert.equal(replay.status, 'existing');
  assert.equal(replay.receiptDigest, result.receiptDigest);
  assert.equal(replay.instanceHeadDigest, result.instanceHeadDigest);
});

test('bounds an unavailable edge probe without mutating lineage', async (t) => {
  const state = fixture(t);
  let clock = state.command.request.requestedAtMs;
  let calls = 0;
  const result = await proveLocalDeploymentLegacyReadiness(state.command, {
    now: () => clock,
    wait: async (milliseconds) => {
      clock += milliseconds;
    },
    async probe() {
      calls += 1;
      return { ready: false, reason: 'unavailable' };
    },
  });
  assert.equal(result.status, 'not_ready');
  assert.equal(result.state, 'legacy_running');
  assert.equal(result.reason, 'unavailable');
  assert.equal(result.attempts, 60);
  assert.equal(calls, 60);
  assert.equal(
    readLocalCutoverInstanceHead(
      state.deploymentRoot,
      state.command.request.instanceId,
      state.uid,
    ).headDigest,
    state.head.headDigest,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        state.deploymentRoot,
        'service',
        'cutover-instances',
        state.command.request.instanceId,
        'legacy-readiness-g1.json',
      ),
    ),
    false,
  );
});

test('fails a version mismatch and stale head before durable mutation', async (t) => {
  const state = fixture(t);
  const mismatch = await proveLocalDeploymentLegacyReadiness(state.command, {
    async probe() {
      return { ready: true, initialized: true, version: '2.20.0' };
    },
  });
  assert.equal(mismatch.status, 'not_ready');
  assert.equal(mismatch.reason, 'version_mismatch');
  assert.equal(mismatch.attempts, 1);
  let calls = 0;
  await assert.rejects(
    proveLocalDeploymentLegacyReadiness(
      {
        ...state.command,
        request: {
          ...state.command.request,
          expectedInstanceHeadDigest: 'f'.repeat(64),
        },
      },
      {
        async probe() {
          calls += 1;
          return { ready: true, initialized: true, version: '2.21.0' };
        },
      },
    ),
    /lost the instance head compare-and-swap/,
  );
  assert.equal(calls, 0);
});

test('probes only the fixed loopback system endpoint with bounded parsing', async (t) => {
  const paths = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url);
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        code: 200,
        data: { isInitialized: true, version: '2.21.0' },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const result = await probeLegacySystemEndpoint({
    host: '127.0.0.1',
    port: address.port,
    path: '/api/system',
    timeoutMs: 2_000,
    maxResponseBytes: 32 * 1024,
  });
  assert.deepEqual(result, {
    ready: true,
    initialized: true,
    version: '2.21.0',
  });
  assert.deepEqual(paths, ['/api/system']);
});

test('rejects oversized and redirect responses without following them', async (t) => {
  let redirected = false;
  const server = http.createServer((request, response) => {
    if (request.url === '/redirected') {
      redirected = true;
      response.end('unexpected');
      return;
    }
    if (request.url === '/large') {
      response.end('x'.repeat(2_048));
      return;
    }
    response.writeHead(302, { location: '/redirected' });
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const redirect = await probeLegacySystemEndpoint({
    host: '127.0.0.1',
    port: address.port,
    path: '/api/system',
    timeoutMs: 2_000,
    maxResponseBytes: 1_024,
  });
  assert.deepEqual(redirect, { ready: false, reason: 'http_rejected' });
  assert.equal(redirected, false);
  const large = await probeLegacySystemEndpoint({
    host: '127.0.0.1',
    port: address.port,
    path: '/large',
    timeoutMs: 2_000,
    maxResponseBytes: 1_024,
  });
  assert.deepEqual(large, {
    ready: false,
    reason: 'response_too_large',
  });
});
