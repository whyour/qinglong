'use strict';

const assert = require('node:assert/strict');
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
  WorkerProcessConfigError,
  loadWorkerProcessConfig,
} = require('@qinglong/worker-runtime/process-config');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ql3-worker-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capabilitiesFile = path.join(root, 'capabilities.json');
  await writeFile(
    capabilitiesFile,
    JSON.stringify({
      architecture: 'arm64',
      operatingSystem: 'linux',
      executors: ['local_process'],
      runtimes: [{ name: 'node', version: '24.18.0' }],
      labels: { site: 'edge-a' },
      capacity: {
        cpuCores: 2,
        memoryBytes: 512 * 1024 * 1024,
      },
      features: [],
    }),
  );
  await chmod(capabilitiesFile, 0o444);
  return {
    root,
    capabilitiesFile,
    environment: {
      QL3_WORKER_RUNTIME_ENABLED: 'true',
      QL_DEPLOYMENT_PROFILE: 'worker',
      QL3_WORKER_CAPACITY_PROFILE: 'edge',
      QL3_WORKER_ID: 'router-worker-1',
      QL3_WORKER_CONTROL_ORIGIN: 'https://control.example.internal:5801',
      QL3_WORKER_CAPABILITIES_FILE: capabilitiesFile,
      QL3_WORKER_JOURNAL_ROOT: path.join(root, 'journal'),
      QL3_WORKER_LOG_ROOT: path.join(root, 'logs'),
      QL3_WORKER_RECEIPT_ROOT: path.join(root, 'receipts'),
      QL3_WORKER_CERTIFICATE_STORE_ROOT: path.join(root, 'identity'),
      QL3_WORKER_TRUST_ANCHOR_FILE: path.join(root, 'ca.pem'),
      QL3_WORKER_CREDENTIAL_TOKEN_FILE: path.join(root, 'token'),
    },
  };
}

test('disabled Worker runtime does not read paths, credentials or capabilities', async () => {
  const reads = [];
  const environment = new Proxy(
    {
      QL3_WORKER_RUNTIME_ENABLED: 'false',
      QL_DEPLOYMENT_PROFILE: 'edge',
    },
    {
      get(target, property, receiver) {
        reads.push(String(property));
        if (
          /CAPABILITIES_FILE|TOKEN|_ROOT|LAUNCHER_PATH|IDENTITY/.test(
            String(property),
          )
        ) {
          throw new Error('disabled Worker read protected configuration');
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
  assert.deepEqual(await loadWorkerProcessConfig(environment), {
    enabled: false,
    profile: 'edge',
  });
  assert.equal(
    reads.some((name) =>
      /CAPABILITIES_FILE|TOKEN|_ROOT|LAUNCHER_PATH|IDENTITY/.test(name),
    ),
    false,
  );
});

test('loads canonical edge defaults and bounded node overrides', async (t) => {
  const current = await fixture(t);
  const edge = await loadWorkerProcessConfig(current.environment);
  assert.equal(edge.enabled, true);
  assert.equal(edge.profile, 'worker');
  assert.equal(edge.capacityProfile, 'edge');
  assert.equal(edge.workerId, 'router-worker-1');
  assert.equal(edge.origin, 'https://control.example.internal:5801');
  assert.deepEqual(edge.capabilities, {
    architecture: 'arm64',
    executors: ['local_process'],
    operatingSystem: 'linux',
    runtimes: [{ name: 'node', version: '24.18.0' }],
    labels: { site: 'edge-a' },
    capacity: {
      cpuCores: 2,
      memoryBytes: 512 * 1024 * 1024,
    },
    features: [],
  });
  assert.equal(edge.maxConcurrentRuns, 1);
  assert.deepEqual(edge.lifecycle, {
    cadenceMs: 2_000,
    leaseDurationMs: 45_000,
    heartbeatIntervalMs: 10_000,
    drainTimeoutMs: 60_000,
    drainPollMs: 500,
    requestTimeoutMs: 15_000,
    maximumJournalEntries: 64,
    maximumRecordsPerTick: 4,
    maximumSupervisionRecordsPerTick: 4,
  });

  const node = await loadWorkerProcessConfig({
    ...current.environment,
    QL3_WORKER_CAPACITY_PROFILE: 'node',
    QL3_WORKER_MAX_CONCURRENT_RUNS: '32',
    QL3_WORKER_MAXIMUM_JOURNAL_ENTRIES: '512',
    QL3_WORKER_IDENTITY_BOOTSTRAP_PRIVATE_KEY_FILE:
      path.join(current.root, 'client.key'),
    QL3_WORKER_IDENTITY_BOOTSTRAP_CERTIFICATE_FILE:
      path.join(current.root, 'client.crt'),
    QL3_WORKER_EXPECTED_CREDENTIAL_ID: 'worker_primary',
    QL3_WORKER_LAUNCHER_PATH: '/usr/local/bin/ql3-launcher',
    QL3_WORKER_LAUNCHER_SHA256: 'a'.repeat(64),
  });
  assert.equal(node.maxConcurrentRuns, 32);
  assert.equal(node.lifecycle.cadenceMs, 500);
  assert.equal(node.lifecycle.maximumJournalEntries, 512);
  assert.equal(node.identity.expectedCredentialId, 'worker_primary');
  assert.equal(
    node.identity.bootstrap.privateKeyFile,
    path.join(current.root, 'client.key'),
  );
  assert.deepEqual(node.executor, {
    launcherPath: '/usr/local/bin/ql3-launcher',
    expectedLauncherSha256: 'a'.repeat(64),
  });
});

test('rejects widened profiles, origins, heartbeat and filesystem configuration', async (t) => {
  const current = await fixture(t);
  for (const patch of [
    { QL_DEPLOYMENT_PROFILE: 'standalone' },
    { QL3_WORKER_CAPACITY_PROFILE: 'cluster' },
    { QL3_WORKER_ID: 'unsafe worker' },
    { QL3_WORKER_CONTROL_ORIGIN: 'http://control.internal' },
    { QL3_WORKER_CONTROL_ORIGIN: 'https://user@control.internal' },
    { QL3_WORKER_JOURNAL_ROOT: 'relative/journal' },
    { QL3_WORKER_HEARTBEAT_INTERVAL_MS: '30000' },
    { QL3_WORKER_MAX_CONCURRENT_RUNS: '5' },
    {
      QL3_WORKER_IDENTITY_BOOTSTRAP_PRIVATE_KEY_FILE:
        path.join(current.root, 'client.key'),
    },
    {
      QL3_WORKER_LAUNCHER_PATH: '/usr/local/bin/ql3-launcher',
    },
  ]) {
    await assert.rejects(
      loadWorkerProcessConfig({
        ...current.environment,
        ...patch,
      }),
      WorkerProcessConfigError,
    );
  }

  await chmod(current.capabilitiesFile, 0o666);
  await assert.rejects(
    loadWorkerProcessConfig(current.environment),
    WorkerProcessConfigError,
  );
});
