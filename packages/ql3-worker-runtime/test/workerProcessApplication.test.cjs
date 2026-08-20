'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  WorkerProcessError,
  runProductionWorkerProcess,
} = require('@qinglong/worker-runtime/process');
const {
  remoteWorkerArchitectureForNodeRuntime,
  remoteWorkerSupportTierForArchitecture,
} = require('@qinglong/runtime-core/remote-dispatch');

async function environment(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ql3-worker-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capabilities = path.join(root, 'capabilities.json');
  const architecture = remoteWorkerArchitectureForNodeRuntime(
    process.arch, process.config.variables.arm_version,
  );
  await writeFile(capabilities, JSON.stringify({
    architecture,
    operatingSystem: 'linux',
    executors: ['remote-worker'],
    protocolVersion: '1.0.0',
    supportTier: remoteWorkerSupportTierForArchitecture(architecture),
  }));
  await chmod(capabilities, 0o444);
  return {
    QL3_WORKER_RUNTIME_ENABLED: 'true',
    QL_DEPLOYMENT_PROFILE: 'worker',
    QL3_WORKER_CAPACITY_PROFILE: 'node',
    QL3_WORKER_ID: 'node-worker-1',
    QL3_WORKER_CONTROL_ORIGIN: 'https://control.internal:5801',
    QL3_WORKER_CAPABILITIES_FILE: capabilities,
    QL3_WORKER_JOURNAL_ROOT: path.join(root, 'journal'),
    QL3_WORKER_LOG_ROOT: path.join(root, 'logs'),
    QL3_WORKER_RECEIPT_ROOT: path.join(root, 'receipts'),
    QL3_WORKER_CERTIFICATE_STORE_ROOT: path.join(root, 'identity'),
    QL3_WORKER_TRUST_ANCHOR_FILE: path.join(root, 'ca.pem'),
    QL3_WORKER_CREDENTIAL_TOKEN_FILE: path.join(root, 'token'),
    QL3_WORKER_DRAIN_TIMEOUT_MS: '1000',
  };
}

function signals(events) {
  return {
    subscribe(listener) {
      events.push('subscribe');
      queueMicrotask(() => listener('SIGTERM'));
      return () => events.push('unsubscribe');
    },
  };
}

test('assembles one product runtime and preserves authority across deferred drain', async (t) => {
  const events = [];
  const facts = [];
  const configured = await environment(t);
  let stopCalls = 0;
  const certificateRenewal = { async run() { return { status: 'not_due' }; } };
  const result = await runProductionWorkerProcess({
    environment: configured,
    signals: signals(events),
    emit(fact) {
      facts.push(fact);
    },
    async createCredentials(identity) {
      events.push(`credentials:${identity.certificateStoreRoot}`);
      return { async load() { throw new Error('not used'); } };
    },
    async createCertificateRenewal(config, credentials) {
      events.push(`renewal:${config.workerId}`);
      assert.equal(typeof credentials.load, 'function');
      return certificateRenewal;
    },
    async start(options) {
      events.push('start');
      assert.equal(options.enabled, true);
      assert.equal(options.profile, 'worker');
      assert.equal(options.capacityProfile, 'node');
      assert.equal(options.workerId, 'node-worker-1');
      assert.equal(options.maxConcurrentRuns, 8);
      assert.equal(options.heartbeatIntervalMs, 10_000);
      assert.equal(options.certificateRenewal, certificateRenewal);
      options.diagnostic({ code: 'certificate_renewal_failed' });
      return {
        status: 'active',
        async tick() {},
        async stop() {
          stopCalls += 1;
          events.push(`stop:${stopCalls}`);
          return stopCalls === 1 ? 'drain_timed_out' : 'stopped';
        },
      };
    },
    async waitBeforeStopRetry() {
      events.push('wait');
    },
  });
  assert.equal(result, 'stopped');
  assert.deepEqual(events, [
    'subscribe',
    `credentials:${path.dirname(configured.QL3_WORKER_JOURNAL_ROOT)}/identity`,
    'renewal:node-worker-1',
    'start',
    'stop:1',
    'wait',
    'stop:2',
    'unsubscribe',
  ]);
  assert.deepEqual(
    facts.map((fact) => fact.event),
    [
      'starting',
      'runtime_diagnostic',
      'active',
      'shutdown_requested',
      'shutdown_deferred',
      'stopped',
    ],
  );
  assert.equal(
    JSON.stringify(facts).includes(configured.QL3_WORKER_CREDENTIAL_TOKEN_FILE),
    false,
  );
});

test('retains the production process until an OS shutdown signal arrives', async (t) => {
  const configured = await environment(t);
  const childSource = String.raw`
    'use strict';
    const { runProductionWorkerProcess } = require(
      process.env.QL3_TEST_WORKER_RUNTIME_PATH
    );
    void runProductionWorkerProcess({
      environment: JSON.parse(process.env.QL3_TEST_WORKER_ENV),
      signals: {
        subscribe(listener) {
          const stop = () => listener('SIGTERM');
          process.once('SIGTERM', stop);
          return () => process.off('SIGTERM', stop);
        },
      },
      emit(event) {
        process.stdout.write(event.event + '\n');
      },
      async createCredentials() {
        return { async load() { throw new Error('not used'); } };
      },
      async start() {
        return {
          status: 'active',
          async tick() {},
          async stop() { return 'stopped'; },
        };
      },
    }).catch((error) => {
      process.stderr.write(String(error));
      process.exitCode = 1;
    });
  `;
  const child = spawn(process.execPath, ['-e', childSource], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      QL3_TEST_WORKER_ENV: JSON.stringify(configured),
      QL3_TEST_WORKER_RUNTIME_PATH: require.resolve(
        '@qinglong/worker-runtime/process',
      ),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  const activeDeadline = Date.now() + 5_000;
  while (!stdout.includes('active\n') && Date.now() < activeDeadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(stdout, /active\n/);

  const retained = await Promise.race([
    once(child, 'exit').then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 250)),
  ]);
  assert.equal(retained, true);

  const exited = once(child, 'exit');
  assert.equal(child.kill('SIGTERM'), true);
  const [exitCode, signal] = await exited;
  assert.equal(exitCode, 0);
  assert.equal(signal, null);
  assert.match(stdout, /shutdown_requested\nstopped\n/);
});

test('disabled process never creates credentials or starts the product runtime', async () => {
  let credentials = 0;
  let starts = 0;
  await assert.rejects(
    runProductionWorkerProcess({
      environment: {
        QL3_WORKER_RUNTIME_ENABLED: 'false',
        QL_DEPLOYMENT_PROFILE: 'edge',
      },
      signals: { subscribe() { return () => {}; } },
      emit() {},
      async createCredentials() {
        credentials += 1;
        return { async load() {} };
      },
      async start() {
        starts += 1;
        return { status: 'disabled', async stop() { return 'stopped'; } };
      },
    }),
    WorkerProcessError,
  );
  assert.equal(credentials, 0);
  assert.equal(starts, 0);
});
