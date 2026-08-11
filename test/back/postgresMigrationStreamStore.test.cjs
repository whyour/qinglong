require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PostgresMigrationLeaderUnavailableError,
  PostgresMigrationStreamStore,
} = require('../../back/migrations/adapters/postgresMigrationStreamStore');
const {
  runMigrationStream,
} = require('../../back/migrations/core/migrationStream');

const CHECKSUM = 'a'.repeat(64);

function createPool(lockResults = [true, true]) {
  const records = new Map();
  const calls = [];
  let released = 0;
  let lockIndex = 0;

  function selectRecord(values, source) {
    const record = source.get(values[0]);
    return { rows: record ? [{ ...record }] : [] };
  }

  return {
    calls,
    records,
    get released() {
      return released;
    },
    pool: {
      async query(text, values = []) {
        calls.push({ scope: 'pool', text, values: [...values] });
        if (text.startsWith('SELECT\n  stream_id')) {
          if (values.length === 0) {
            return {
              rows: [...records.values()].map((record) => ({ ...record })),
            };
          }
          return selectRecord(values, records);
        }
        throw new Error(`unexpected pool query: ${text}`);
      },
      async connect() {
        let staged = null;
        return {
          async query(text, values = []) {
            calls.push({ scope: 'client', text, values: [...values] });
            if (text === 'BEGIN') {
              staged = new Map(
                [...records].map(([id, record]) => [id, { ...record }]),
              );
              return { rows: [] };
            }
            if (text === 'COMMIT') {
              records.clear();
              for (const [id, record] of staged) records.set(id, record);
              staged = null;
              return { rows: [] };
            }
            if (text === 'ROLLBACK') {
              staged = null;
              return { rows: [] };
            }
            if (text.startsWith('SELECT set_config')) return { rows: [] };
            if (text.startsWith('SELECT pg_try_advisory_xact_lock')) {
              return { rows: [{ acquired: lockResults[lockIndex++] ?? true }] };
            }
            if (text.startsWith('CREATE SCHEMA')) return { rows: [] };
            if (text.startsWith('CREATE TABLE')) return { rows: [] };
            if (text.startsWith('SELECT\n  stream_id')) {
              return selectRecord(values, staged);
            }
            if (text.startsWith('INSERT INTO')) {
              const [migrationId, streamId, dialect, checksum, appliedAtMs] =
                values;
              staged.set(migrationId, {
                migrationId,
                streamId,
                dialect,
                checksum,
                appliedAtMs: String(appliedAtMs),
              });
              return { rows: [], rowCount: 1 };
            }
            if (text === 'CREATE TABLE ql3.run_probe(id integer)') {
              return { rows: [] };
            }
            throw new Error(`unexpected client query: ${text}`);
          },
          release() {
            released += 1;
          },
        };
      },
    },
  };
}

function stream(up) {
  return {
    id: 'postgresql-main',
    dialect: 'postgresql',
    migrationIdScheme: 'postgres-prefixed',
    checksumScheme: 'sha256',
    migrations: [
      {
        id: 'pg-0001-schema-history',
        checksum: CHECKSUM,
        up,
      },
    ],
  };
}

test('serializes PostgreSQL history bootstrap and migration in advisory-lock transactions', async () => {
  const state = createPool();
  let upCalls = 0;
  await runMigrationStream({
    stream: stream(async (context) => {
      upCalls += 1;
      await context.query('CREATE TABLE ql3.run_probe(id integer)');
    }),
    store: new PostgresMigrationStreamStore(state.pool),
    clock: () => 123,
  });

  assert.equal(upCalls, 1);
  assert.equal(state.released, 2);
  assert.deepEqual(state.records.get('pg-0001-schema-history'), {
    migrationId: 'pg-0001-schema-history',
    streamId: 'postgresql-main',
    dialect: 'postgresql',
    checksum: CHECKSUM,
    appliedAtMs: '123',
  });
  assert.equal(
    state.calls.filter(({ text }) =>
      text.startsWith('SELECT pg_try_advisory_xact_lock'),
    ).length,
    2,
  );
  assert.equal(state.calls.filter(({ text }) => text === 'COMMIT').length, 2);
});

test('fails closed before migration work when another migration leader owns the lock', async () => {
  const state = createPool([true, false]);
  let upCalls = 0;
  await assert.rejects(
    runMigrationStream({
      stream: stream(async () => {
        upCalls += 1;
      }),
      store: new PostgresMigrationStreamStore(state.pool),
    }),
    PostgresMigrationLeaderUnavailableError,
  );
  assert.equal(upCalls, 0);
  assert.equal(state.records.size, 0);
  assert.equal(state.calls.filter(({ text }) => text === 'ROLLBACK').length, 1);
  assert.equal(state.released, 2);
});

test('rolls PostgreSQL migration work and history back together', async () => {
  const state = createPool();
  await assert.rejects(
    runMigrationStream({
      stream: stream(async () => {
        throw new Error('migration work failed');
      }),
      store: new PostgresMigrationStreamStore(state.pool),
    }),
    /migration work failed/,
  );
  assert.equal(state.records.size, 0);
  assert.equal(state.calls.filter(({ text }) => text === 'ROLLBACK').length, 1);
});
