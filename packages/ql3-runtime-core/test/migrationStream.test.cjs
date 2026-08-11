const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  auditMigrationStreamHistory,
  InvalidMigrationStreamError,
  MigrationStreamAheadOfCodeError,
  MigrationStreamChecksumMismatchError,
  MigrationStreamHistoryCorruptionError,
  runMigrationStream,
} = require('@qinglong/runtime-core/migration-stream');

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
    initial.map((record) => [record.migrationId, { ...record }]),
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
            if (staged.has(record.migrationId)) throw new Error('duplicate');
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

test('applies one prefixed migration atomically and replays it exactly once', async () => {
  const state = memoryStore();
  const logs = [];
  let calls = 0;
  const definition = stream([
    {
      id: 'pg-0001-schema-history',
      checksum: CHECKSUM_A,
      async up(context) {
        calls += 1;
        context.statements.push('create schema metadata');
      },
    },
  ]);
  await runMigrationStream({
    stream: definition,
    store: state.store,
    clock: () => 100,
    logger: { info: (message) => logs.push(message) },
  });
  await runMigrationStream({ stream: definition, store: state.store });
  assert.equal(calls, 1);
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

test('rejects checksum drift, ahead history and non-prefix gaps', async () => {
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
  const record = (migrationId, checksum = CHECKSUM_A) => ({
    streamId: 'postgresql-main',
    dialect: 'postgresql',
    migrationId,
    checksum,
    appliedAtMs: 1,
  });
  await assert.rejects(
    runMigrationStream({
      stream: stream([{ ...first, checksum: CHECKSUM_B }]),
      store: memoryStore([record(first.id)]).store,
    }),
    MigrationStreamChecksumMismatchError,
  );
  await assert.rejects(
    runMigrationStream({
      stream: stream([first, second]),
      store: memoryStore([record('pg-0003-ahead')]).store,
    }),
    MigrationStreamAheadOfCodeError,
  );
  await assert.rejects(
    runMigrationStream({
      stream: stream([first, second]),
      store: memoryStore([record(second.id, second.checksum)]).store,
    }),
    MigrationStreamHistoryCorruptionError,
  );
});

test('rolls migration work and history back together', async () => {
  const state = memoryStore();
  await assert.rejects(
    runMigrationStream({
      stream: stream([
        {
          id: 'pg-0001-schema-history',
          checksum: CHECKSUM_A,
          async up() {
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

test('validates stream identity and immutable migration shape before storage', async () => {
  const state = memoryStore();
  for (const definition of [
    { ...stream([]), id: 'PostgreSQL' },
    { ...stream([]), migrationIdScheme: 'sqlite-numbered' },
    stream([{ id: '0001', checksum: CHECKSUM_A, async up() {} }]),
    stream([{ id: 'pg-0001', checksum: 'short', async up() {} }]),
  ]) {
    await assert.rejects(
      runMigrationStream({ stream: definition, store: state.store }),
      InvalidMigrationStreamError,
    );
  }
  assert.equal(state.ensured, 0);
});

test('audits a metadata-only manifest but requires executable steps to migrate', async () => {
  const manifest = stream([
    { id: 'pg-0001-schema-history', checksum: CHECKSUM_A },
  ]);
  const history = [
    {
      streamId: manifest.id,
      dialect: manifest.dialect,
      migrationId: manifest.migrations[0].id,
      checksum: manifest.migrations[0].checksum,
      appliedAtMs: 1,
    },
  ];
  assert.deepEqual(
    [...auditMigrationStreamHistory(history, manifest)],
    ['pg-0001-schema-history'],
  );
  await assert.rejects(
    runMigrationStream({ stream: manifest, store: memoryStore().store }),
    InvalidMigrationStreamError,
  );
});
