'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  executeClusterWorkerManagementClient,
  normalizeClusterWorkerManagementCommand,
} = require('@qinglong/cluster-admin/worker-management-client');
const {
  createWorkerSessionInspectionCommand,
  createWorkerSessionListCommand,
  formatWorkerSessionInspectionCard,
  formatWorkerSessionListCard,
  projectWorkerSessionInspection,
  projectWorkerSessionList,
} = require('@qinglong/cluster-admin/worker-management-product');

const fixtureRoot = path.resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls',
);
const detailedWorker = Object.freeze({
  workerId: 'worker-a',
  sessionId: 'session-a',
  generation: 2,
  sessionVersion: 5,
  lifecycle: 'online',
  compatibility: 'default_placement',
  architecture: 'arm64',
  supportTier: 'tier1',
  protocolVersion: '1.0.0',
  operatingSystem: 'linux',
  maxConcurrentRuns: 2,
  availableSlots: 1,
  registeredAtMs: 900,
  lastHeartbeatAtMs: 1_050,
  leaseExpiresAtMs: 2_000,
  updatedAtMs: 1_050,
  observedAtMs: 1_100,
  runtimes: Object.freeze([{ name: 'node', version: '24.18.0' }]),
  declaredCapacity: Object.freeze({
    cpuCores: 1,
    memoryBytes: 268_435_456,
    diskBytes: 1_073_741_824,
    gpuCount: 0,
  }),
});
const summaryWorker = Object.freeze(
  Object.fromEntries(
    Object.entries(detailedWorker).filter(
      ([key]) => key !== 'runtimes' && key !== 'declaredCapacity',
    ),
  ),
);

function response(result) {
  return Object.freeze({
    schemaVersion: 1,
    requestId: 'transport-request-must-not-project',
    result: Object.freeze(result),
  });
}

function privateFile(directory, name, value) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, value, { mode: 0o600 });
  return fs.realpathSync(filePath);
}

test('builds only immutable inspect and bounded list commands', () => {
  const inspect = createWorkerSessionInspectionCommand(
    'project-a',
    'worker-a',
    () => 'inspection-a',
  );
  assert.deepEqual(inspect, {
    schemaVersion: 1,
    operation: 'worker-session.inspect',
    request: {
      authorityProjectId: 'project-a',
      workerId: 'worker-a',
      inspectionId: 'inspection-a',
    },
  });
  assert.equal(Object.isFrozen(inspect), true);
  assert.equal(Object.isFrozen(inspect.request), true);

  const page = createWorkerSessionListCommand(
    'project-a',
    'worker-a',
    () => 'inspection-b',
  );
  assert.deepEqual(page.request, {
    authorityProjectId: 'project-a',
    afterWorkerId: 'worker-a',
    inspectionId: 'inspection-b',
  });
  assert.equal(Object.hasOwn(page.request, 'limit'), false);
  assert.throws(() => createWorkerSessionListCommand('../escape'));
  assert.throws(() =>
    normalizeClusterWorkerManagementCommand({
      schemaVersion: 1,
      operation: 'worker-credential.inspect',
      request: {
        actionRef: 'action-a',
        authorityProjectId: 'project-a',
        approvalRequestId: 'approval-a',
        inspectionId: 'inspection-a',
      },
    }),
  );
});

test('projects strict low-sensitive products without transport request identity', () => {
  const inspection = projectWorkerSessionInspection(
    'project-a',
    response({
      schemaVersion: 1,
      operation: 'worker-session.inspect',
      observedAtMs: 1_100,
      worker: detailedWorker,
    }),
  );
  assert.equal(inspection.schema, 'qinglong/worker-session-inspection@v1');
  assert.equal(inspection.found, true);
  assert.equal(inspection.worker.workerId, 'worker-a');
  assert.equal(Object.isFrozen(inspection.worker.runtimes), true);
  assert.doesNotMatch(
    JSON.stringify(inspection),
    /transport-request|inspectionId/,
  );
  assert.match(
    formatWorkerSessionInspectionCard(inspection),
    /slots available/,
  );

  const page = projectWorkerSessionList(
    'project-a',
    response({
      schemaVersion: 1,
      operation: 'worker-session.list',
      observedAtMs: 1_100,
      workers: [summaryWorker],
      nextCursor: 'worker-a',
    }),
  );
  assert.deepEqual(
    {
      schema: page.schema,
      count: page.count,
      nextAfterWorkerId: page.nextAfterWorkerId,
    },
    {
      schema: 'qinglong/worker-session-list@v1',
      count: 1,
      nextAfterWorkerId: 'worker-a',
    },
  );
  assert.match(formatWorkerSessionListCard(page), /worker-a  online/);
  assert.throws(() =>
    projectWorkerSessionInspection(
      'project-a',
      response({
        schemaVersion: 1,
        operation: 'worker-session.list',
        observedAtMs: 1_100,
        workers: [],
        nextCursor: null,
      }),
    ),
  );
});

test('requires the canonical Worker endpoint before making a connection', async (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-worker-product-client-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const caFile = privateFile(
    directory,
    'ca.pem',
    fs.readFileSync(path.join(fixtureRoot, 'ca-cert.pem')),
  );
  const clientCertificateFile = privateFile(
    directory,
    'client.crt',
    fs.readFileSync(path.join(fixtureRoot, 'client-cert.pem')),
  );
  const clientPrivateKeyFile = privateFile(
    directory,
    'client.key',
    fs.readFileSync(path.join(fixtureRoot, 'client-key.pem')),
  );
  const assertionFile = privateFile(
    directory,
    'assertion.jwt',
    'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl',
  );
  const command = createWorkerSessionListCommand(
    'project-a',
    undefined,
    () => 'inspection-a',
  );

  for (const [managementPath, expectedConnections] of [
    ['/api/v3/workers/management', 1],
    ['/api/v3/worker-credentials/management', 0],
  ]) {
    const configFile = privateFile(
      directory,
      `client-${expectedConnections}.json`,
      JSON.stringify({
        schemaVersion: 1,
        endpoint: `https://manager.example.test:8443${managementPath}`,
        servername: 'manager.example.test',
        caFile,
        clientCertificateFile,
        clientPrivateKeyFile,
        requestTimeoutMs: 1_000,
      }),
    );
    let connections = 0;
    await assert.rejects(
      executeClusterWorkerManagementClient(
        { configFile, assertionFile, command },
        {
          async connect() {
            connections += 1;
            throw new Error('stop-after-policy-validation');
          },
        },
      ),
    );
    assert.equal(connections, expectedConnections);
  }
});
