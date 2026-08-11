require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  workerRegistryMigration,
} = require('../../back/migrations/0008-worker-registry');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeWorkerRegistryRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/workerRegistryRepository');
const {
  BoundWorkerControlPlaneClient,
  WorkerControlService,
  WorkerPrincipalMismatchError,
} = require('../../back/runtime/application/workerControlService');
const {
  WorkerFenceRejectedError,
  WorkerSessionConflictError,
  hashWorkerCapabilities,
  normalizeWorkerCapabilities,
  parseWorkerCapabilities,
  serializeWorkerCapabilities,
} = require('../../back/runtime/domain/worker');

const SESSION_1 = '019f7500-0000-7000-8000-000000000001';
const SESSION_2 = '019f7500-0000-7000-8000-000000000002';

function capabilities(overrides = {}) {
  return {
    architecture: 'arm64',
    operatingSystem: 'linux',
    executors: ['local_process'],
    runtimes: [
      { name: 'node', version: '24.14.0' },
      { name: 'python', version: '3.12.2' },
    ],
    labels: { region: 'home', tier: 'edge' },
    capacity: {
      cpuCores: 2,
      memoryBytes: 512 * 1024 * 1024,
      diskBytes: 8 * 1024 * 1024 * 1024,
    },
    features: ['direct_file_log'],
    ...overrides,
  };
}

async function fixture(t) {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [workerRegistryMigration],
    logger: { info() {} },
  });
  let nowMs = 1_000;
  const repository = new LegacySequelizeWorkerRegistryRepository(database);
  const service = new WorkerControlService(repository, {
    leaseDurationMs: 5_000,
    clock: { now: () => nowMs },
  });
  return {
    repository,
    service,
    setNow(value) {
      nowMs = value;
    },
    client(workerId) {
      return new BoundWorkerControlPlaneClient(service, { workerId });
    },
  };
}

test('normalizes a bounded canonical capability snapshot', () => {
  const first = serializeWorkerCapabilities(capabilities());
  const second = serializeWorkerCapabilities(
    capabilities({
      executors: ['local_process'],
      runtimes: [
        { name: 'python', version: '3.12.2' },
        { name: 'node', version: '24.14.0' },
      ],
      labels: { tier: 'edge', region: 'home' },
    }),
  );
  assert.equal(first, second);
  assert.equal(hashWorkerCapabilities(first), hashWorkerCapabilities(second));
  assert.deepEqual(parseWorkerCapabilities(first), capabilities());

  assert.throws(
    () => normalizeWorkerCapabilities({ ...capabilities(), command: 'secret' }),
    /fields do not match/,
  );
  assert.throws(
    () =>
      normalizeWorkerCapabilities({
        ...capabilities(),
        executors: ['local_process', 'local_process'],
      }),
    /duplicates/,
  );
  assert.throws(
    () =>
      normalizeWorkerCapabilities({
        ...capabilities(),
        labels: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`key-${index}`, 'value']),
        ),
      }),
    /at most 32/,
  );
});

test('registers idempotently, fences replaced sessions, and preserves drain', async (t) => {
  const context = await fixture(t);
  const client = context.client('worker-a');
  const request = {
    workerId: 'worker-a',
    sessionId: SESSION_1,
    capabilities: capabilities(),
    maxConcurrentRuns: 2,
    availableSlots: 2,
  };
  const first = await client.register(request);
  assert.equal(first.generation, 1);
  assert.equal(first.version, 0);
  assert.equal(first.leaseExpiresAtMs, 6_000);

  context.setNow(2_000);
  assert.deepEqual(await client.register(request), first);
  await assert.rejects(
    client.register({ ...request, availableSlots: 1 }),
    WorkerSessionConflictError,
  );

  const replacement = await client.register({
    ...request,
    sessionId: SESSION_2,
  });
  assert.equal(replacement.generation, 2);
  assert.equal(replacement.version, 1);
  await assert.rejects(
    client.heartbeat({
      workerId: 'worker-a',
      sessionId: SESSION_1,
      generation: 1,
      expectedVersion: 0,
      availableSlots: 2,
    }),
    (error) =>
      error instanceof WorkerFenceRejectedError &&
      error.reason === 'session_mismatch',
  );

  context.setNow(2_500);
  const heartbeat = await client.heartbeat({
    workerId: 'worker-a',
    sessionId: SESSION_2,
    generation: 2,
    expectedVersion: 1,
    availableSlots: 1,
  });
  assert.equal(heartbeat.version, 2);
  assert.equal(heartbeat.availableSlots, 1);
  assert.equal(heartbeat.leaseExpiresAtMs, 7_500);

  context.setNow(3_000);
  const draining = await client.drain({
    workerId: 'worker-a',
    sessionId: SESSION_2,
    generation: 2,
    expectedVersion: 2,
  });
  assert.equal(draining.status, 'draining');
  assert.equal(draining.availableSlots, 0);

  context.setNow(3_500);
  const drainedHeartbeat = await client.heartbeat({
    workerId: 'worker-a',
    sessionId: SESSION_2,
    generation: 2,
    expectedVersion: 3,
    availableSlots: 2,
  });
  assert.equal(drainedHeartbeat.status, 'draining');
  assert.equal(drainedHeartbeat.availableSlots, 0);

  context.setNow(4_000);
  const offline = await client.disconnect({
    workerId: 'worker-a',
    sessionId: SESSION_2,
    generation: 2,
    expectedVersion: 4,
  });
  assert.equal(offline.status, 'offline');
  await assert.rejects(
    client.heartbeat({
      workerId: 'worker-a',
      sessionId: SESSION_2,
      generation: 2,
      expectedVersion: 5,
      availableSlots: 0,
    }),
    (error) =>
      error instanceof WorkerFenceRejectedError && error.reason === 'offline',
  );
});

test('queries only live available Workers with a bounded stable cursor', async (t) => {
  const context = await fixture(t);
  for (const [index, workerId] of [
    'worker-a',
    'worker-b',
    'worker-c',
  ].entries()) {
    await context.client(workerId).register({
      workerId,
      sessionId: `019f7500-0000-7000-8000-${String(index + 10).padStart(
        12,
        '0',
      )}`,
      capabilities: capabilities(),
      maxConcurrentRuns: 1,
      availableSlots: workerId === 'worker-b' ? 0 : 1,
    });
  }

  context.setNow(2_000);
  const firstPage = await context.service.listAvailable({ limit: 1 });
  assert.deepEqual(
    firstPage.workers.map((worker) => worker.id),
    ['worker-a'],
  );
  assert.equal(firstPage.truncated, true);
  const secondPage = await context.service.listAvailable({
    afterWorkerId: firstPage.nextCursor,
    limit: 1,
  });
  assert.deepEqual(
    secondPage.workers.map((worker) => worker.id),
    ['worker-c'],
  );
  assert.equal(secondPage.truncated, false);

  context.setNow(6_000);
  assert.deepEqual((await context.service.listAvailable()).workers, []);
  await assert.rejects(
    context.service.listAvailable({ limit: 65 }),
    /MAX_AVAILABLE_WORKER_PAGE_SIZE/,
  );
});

test('binds Worker identity at the authenticated transport boundary', async (t) => {
  const context = await fixture(t);
  await assert.rejects(
    context.service.register(
      { workerId: 'worker-a' },
      {
        workerId: 'worker-b',
        sessionId: SESSION_1,
        capabilities: capabilities(),
        maxConcurrentRuns: 1,
        availableSlots: 1,
      },
    ),
    WorkerPrincipalMismatchError,
  );
  assert.equal(await context.repository.findById('worker-b'), null);
});

test('serializes two control-plane connections racing to replace one Worker', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-workers-'));
  const storage = path.join(root, 'workers.sqlite');
  const databases = [
    new Sequelize({ dialect: 'sqlite', storage, logging: false }),
    new Sequelize({ dialect: 'sqlite', storage, logging: false }),
  ];
  t.after(async () => {
    await Promise.all(databases.map((database) => database.close()));
    await fs.rm(root, { recursive: true, force: true });
  });
  await runMigrations({
    database: databases[0],
    migrationModel: defineSchemaMigrationModel(databases[0]),
    migrations: [workerRegistryMigration],
    logger: { info() {} },
  });
  for (const database of databases) {
    await database.query('PRAGMA journal_mode=WAL');
    await database.query('PRAGMA busy_timeout=1000');
  }
  const services = databases.map(
    (database) =>
      new WorkerControlService(
        new LegacySequelizeWorkerRegistryRepository(database),
        { leaseDurationMs: 5_000, clock: { now: () => 1_000 } },
      ),
  );
  const requests = [SESSION_1, SESSION_2].map((sessionId) => ({
    workerId: 'worker-race',
    sessionId,
    capabilities: capabilities(),
    maxConcurrentRuns: 1,
    availableSlots: 1,
  }));
  const registered = await Promise.all(
    services.map((service, index) =>
      new BoundWorkerControlPlaneClient(service, {
        workerId: 'worker-race',
      }).register(requests[index]),
    ),
  );
  assert.deepEqual(
    registered.map((worker) => worker.generation).sort(),
    [1, 2],
  );
  const repository = new LegacySequelizeWorkerRegistryRepository(databases[0]);
  const current = await repository.findById('worker-race');
  assert.equal(current.generation, 2);
  const stale = registered.find((worker) => worker.generation === 1);
  await assert.rejects(
    repository.heartbeat({
      workerId: stale.id,
      sessionId: stale.sessionId,
      generation: stale.generation,
      expectedVersion: stale.version,
      availableSlots: 1,
      heartbeatAtMs: 2_000,
      leaseExpiresAtMs: 7_000,
    }),
    WorkerFenceRejectedError,
  );
});
