require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidMigrationStreamError,
  MigrationStreamAheadOfCodeError,
  MigrationStreamChecksumMismatchError,
  MigrationStreamHistoryCorruptionError,
  runMigrationStream,
} = require('../../back/migrations/core/migrationStream');

const CHECKSUM_A = 'a'.repeat(64);
const CHECKSUM_B = 'b'.repeat(64);

function stream(migrations) {
  return {
    id: 'postgresql-main',
    dialect: 'postgresql',
    migrationIdScheme: 'postgres-prefixed',
    checksumScheme: 'sha256',
    migrations,
  };
}

function memoryStore(initial = []) {
  const records = new Map(
    initial.map((record) => [record.migrationId, record]),
  );
  let ensured = 0;
  return {
    records,
    get ensured() {
      return ensured;
    },
    store: {
      async ensureHistory() {
        ensured += 1;
      },
      async listAll() {
        return [...records.values()].map((record) => ({ ...record }));
      },
      async findById(id) {
        const record = records.get(id);
        return record ? { ...record } : null;
      },
      async transaction(work) {
        const staged = new Map(
          [...records].map(([id, record]) => [id, { ...record }]),
        );
        const result = await work({
          context: { statements: [] },
          async findById(id) {
            const record = staged.get(id);
            return record ? { ...record } : null;
          },
          async insert(record) {
            if (staged.has(record.migrationId)) {
              throw new Error('duplicate migration history');
            }
            staged.set(record.migrationId, { ...record });
          },
        });
        records.clear();
        for (const [id, record] of staged) records.set(id, record);
        return result;
      },
    },
  };
}

test('runs one prefixed migration atomically and replays without running up', async () => {
  const state = memoryStore();
  const statements = [];
  const logs = [];
  let calls = 0;
  const definition = stream([
    {
      id: 'pg-0001-schema-history',
      checksum: CHECKSUM_A,
      async up(context) {
        calls += 1;
        context.statements.push('create schema metadata');
        statements.push(...context.statements);
      },
    },
  ]);
  await runMigrationStream({
    stream: definition,
    store: state.store,
    clock: () => 100,
    logger: {
      info(message) {
        logs.push(message);
      },
    },
  });
  await runMigrationStream({
    stream: definition,
    store: state.store,
    clock: () => 200,
  });
  assert.equal(calls, 1);
  assert.deepEqual(statements, ['create schema metadata']);
  assert.equal(state.ensured, 2);
  assert.deepEqual(
    [...state.records.values()],
    [
      {
        streamId: 'postgresql-main',
        dialect: 'postgresql',
        migrationId: 'pg-0001-schema-history',
        checksum: CHECKSUM_A,
        appliedAtMs: 100,
      },
    ],
  );
  assert.deepEqual(logs, [
    '[migration:postgresql-main] Applied pg-0001-schema-history',
  ]);
});

test('rejects checksum drift and corrupt dialect history before migration work', async () => {
  const migrationId = 'pg-0001-schema-history';
  const mismatch = memoryStore([
    {
      streamId: 'postgresql-main',
      dialect: 'postgresql',
      migrationId,
      checksum: CHECKSUM_A,
      appliedAtMs: 1,
    },
  ]);
  await assert.rejects(
    runMigrationStream({
      stream: stream([
        { id: migrationId, checksum: CHECKSUM_B, async up() {} },
      ]),
      store: mismatch.store,
    }),
    (error) => {
      assert.ok(error instanceof MigrationStreamChecksumMismatchError);
      assert.equal(error.migrationId, migrationId);
      assert.equal(error.databaseChecksum, CHECKSUM_A);
      assert.equal(error.codeChecksum, CHECKSUM_B);
      assert.equal(
        error.message,
        `Migration checksum mismatch: ${migrationId} ` +
          `(database=${CHECKSUM_A}, code=${CHECKSUM_B})`,
      );
      return true;
    },
  );

  const corrupt = memoryStore([
    {
      streamId: 'postgresql-main',
      dialect: 'sqlite',
      migrationId,
      checksum: CHECKSUM_A,
      appliedAtMs: 1,
    },
  ]);
  await assert.rejects(
    runMigrationStream({
      stream: stream([
        { id: migrationId, checksum: CHECKSUM_A, async up() {} },
      ]),
      store: corrupt.store,
    }),
    MigrationStreamHistoryCorruptionError,
  );
});

test('rolls migration work and history back together when up fails', async () => {
  const state = memoryStore();
  await assert.rejects(
    runMigrationStream({
      stream: stream([
        {
          id: 'pg-0001-schema-history',
          checksum: CHECKSUM_A,
          async up(context) {
            context.statements.push('partial ddl');
            throw new Error('ddl failed');
          },
        },
      ]),
      store: state.store,
    }),
    /ddl failed/,
  );
  assert.equal(state.records.size, 0);
});

test('rechecks history inside the transaction for a concurrent leader winner', async () => {
  const migrationId = 'pg-0001-schema-history';
  const winner = {
    streamId: 'postgresql-main',
    dialect: 'postgresql',
    migrationId,
    checksum: CHECKSUM_A,
    appliedAtMs: 10,
  };
  let outsideReads = 0;
  let upCalls = 0;
  const store = {
    async ensureHistory() {},
    async listAll() {
      return [];
    },
    async findById() {
      outsideReads += 1;
      return null;
    },
    async transaction(work) {
      return work({
        context: {},
        async findById() {
          return winner;
        },
        async insert() {
          throw new Error('unreachable');
        },
      });
    },
  };
  await runMigrationStream({
    stream: stream([
      {
        id: migrationId,
        checksum: CHECKSUM_A,
        async up() {
          upCalls += 1;
        },
      },
    ]),
    store,
  });
  assert.equal(outsideReads, 1);
  assert.equal(upCalls, 0);
});

test('rejects ahead and non-prefix history before new migration work', async () => {
  const first = {
    id: 'pg-0001-schema-history',
    checksum: CHECKSUM_A,
    async up() {},
  };
  const second = {
    id: 'pg-0002-run-core',
    checksum: CHECKSUM_B,
    async up() {},
  };
  const ahead = memoryStore([
    {
      streamId: 'postgresql-main',
      dialect: 'postgresql',
      migrationId: 'pg-0003-ahead',
      checksum: CHECKSUM_A,
      appliedAtMs: 1,
    },
  ]);
  await assert.rejects(
    runMigrationStream({ stream: stream([first, second]), store: ahead.store }),
    MigrationStreamAheadOfCodeError,
  );

  const gap = memoryStore([
    {
      streamId: 'postgresql-main',
      dialect: 'postgresql',
      migrationId: second.id,
      checksum: second.checksum,
      appliedAtMs: 2,
    },
  ]);
  await assert.rejects(
    runMigrationStream({ stream: stream([first, second]), store: gap.store }),
    MigrationStreamHistoryCorruptionError,
  );
});

test('validates stream identity, immutable checksum and unique prefixed ids first', async () => {
  const state = memoryStore();
  for (const definition of [
    { ...stream([]), id: 'PostgreSQL' },
    { ...stream([]), migrationIdScheme: 'sqlite-numbered' },
    { ...stream([]), checksumScheme: 'unknown' },
    stream([{ id: '0001', checksum: CHECKSUM_A, async up() {} }]),
    stream([{ id: 'pg-0001', checksum: 'short', async up() {} }]),
    stream([
      { id: 'pg-0001', checksum: CHECKSUM_A, async up() {} },
      { id: 'pg-0001', checksum: CHECKSUM_A, async up() {} },
    ]),
  ]) {
    await assert.rejects(
      runMigrationStream({ stream: definition, store: state.store }),
      InvalidMigrationStreamError,
    );
  }
  assert.equal(state.ensured, 0);
});

test('accepts the frozen numbered SQLite stream without rewriting its ids', async () => {
  const state = memoryStore();
  await runMigrationStream({
    stream: {
      id: 'sqlite-main',
      dialect: 'sqlite',
      migrationIdScheme: 'sqlite-numbered',
      checksumScheme: 'legacy-opaque',
      migrations: [
        {
          id: '0001-legacy-columns',
          checksum: 'legacy checksum v1',
          async up() {},
        },
      ],
    },
    store: state.store,
    clock: () => 1,
  });
  assert.equal(
    state.records.get('0001-legacy-columns').migrationId,
    '0001-legacy-columns',
  );
  assert.equal(
    state.records.get('0001-legacy-columns').checksum,
    'legacy checksum v1',
  );
});
