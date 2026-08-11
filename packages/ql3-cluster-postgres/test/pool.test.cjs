const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { types } = require('pg');
const {
  POSTGRES_AVAILABILITY_SQLSTATE_CLASSES,
  POSTGRES_AVAILABILITY_SQLSTATES,
  POSTGRES_AVAILABILITY_SYSTEM_ERROR_CODES,
  PgPoolBinding,
  createPostgresDatabaseOpener,
  isPostgresAvailabilityError,
} = require('../dist');

function options(overrides = {}) {
  return {
    role: 'runtime',
    connection: {
      connectionString: 'postgresql://ql3:secret@127.0.0.1:5432/ql3',
      tls: { mode: 'disable' },
    },
    onPoolError() {},
    ...overrides,
  };
}

test('creates and closes a pg.Pool without eagerly opening a connection', async () => {
  let passwordReads = 0;
  const openDatabase = createPostgresDatabaseOpener(
    options({
      connection: {
        host: '127.0.0.1',
        database: 'ql3',
        user: 'ql3',
        password() {
          passwordReads += 1;
          return 'secret';
        },
        tls: { mode: 'disable' },
      },
    }),
  );

  assert.equal(passwordReads, 0);
  const database = await openDatabase();
  assert.equal(passwordReads, 0);
  await Promise.all([database.close(), database.close()]);
  assert.equal(passwordReads, 0);
});

test('rejects connection-string TLS overrides and unsafe application names', () => {
  assert.throws(
    () =>
      createPostgresDatabaseOpener(
        options({
          connection: {
            connectionString:
              'postgresql://ql3:secret@127.0.0.1/ql3?sslmode=disable',
            tls: { mode: 'verify-full' },
          },
        }),
      ),
    /explicit tls option/,
  );
  assert.throws(
    () =>
      createPostgresDatabaseOpener(
        options({ pool: { applicationName: 'ql3 runtime -c role=admin' } }),
      ),
    /safe identifier/,
  );
  assert.throws(
    () =>
      createPostgresDatabaseOpener(
        options({
          connection: {
            connectionString: 'postgresql://ql3:secret@database.internal/ql3',
            tls: { mode: 'verify-full' },
          },
        }),
      ),
    /explicit DNS servername/,
  );
});

test('enforces role-specific bounded pool sizes', () => {
  assert.throws(
    () =>
      createPostgresDatabaseOpener(options({ pool: { maxConnections: 65 } })),
    /between 1 and 64/,
  );
  assert.throws(
    () =>
      createPostgresDatabaseOpener(
        options({
          role: 'migration',
          pool: { maxConnections: 5 },
        }),
      ),
    /between 1 and 4/,
  );
  for (const role of [
    'ai-maintenance',
    'ai-credential-tester',
    'automation-manager',
    'approval-manager',
    'run-manager',
    'worker-credential-manager',
    'worker-credential-executor',
  ]) {
    assert.doesNotThrow(() => createPostgresDatabaseOpener(options({ role })));
    assert.throws(
      () =>
        createPostgresDatabaseOpener(
          options({ role, pool: { maxConnections: 5 } }),
        ),
      /between 1 and 4/,
    );
  }
  assert.throws(
    () =>
      createPostgresDatabaseOpener(
        options({
          role: 'worker-ingress',
          pool: { maxConnections: 17 },
        }),
      ),
    /between 1 and 16/,
  );
  assert.throws(
    () =>
      createPostgresDatabaseOpener(
        options({
          role: 'admin',
          pool: { maxConnections: 5 },
        }),
      ),
    /between 1 and 4/,
  );
  assert.throws(
    () => createPostgresDatabaseOpener(options({ role: 'unknown' })),
    /database role is invalid/,
  );
});

test('keeps PostgreSQL bigint parsing as strings and omits pg-native', () => {
  assert.equal(types.getTypeParser(20)('9007199254740993'), '9007199254740993');
  assert.throws(() => require.resolve('pg-native'), {
    code: 'MODULE_NOT_FOUND',
  });
});

test('classifies only explicit PostgreSQL and transport availability codes', () => {
  assert.deepEqual(POSTGRES_AVAILABILITY_SQLSTATE_CLASSES, ['08']);
  for (const code of [
    ...POSTGRES_AVAILABILITY_SQLSTATES,
    ...POSTGRES_AVAILABILITY_SYSTEM_ERROR_CODES,
  ]) {
    assert.equal(
      isPostgresAvailabilityError(Object.assign(new Error(code), { code })),
      true,
      code,
    );
  }
  assert.equal(
    isPostgresAvailabilityError(
      Object.assign(new Error('vendor connection exception'), {
        code: '08999',
      }),
    ),
    true,
  );
  for (const code of ['23505', '40001', '40P01', '55P03', '57014']) {
    assert.equal(
      isPostgresAvailabilityError(Object.assign(new Error(code), { code })),
      false,
      code,
    );
  }
  assert.equal(isPostgresAvailabilityError(new Error('uncoded')), false);
  assert.equal(isPostgresAvailabilityError({ code: '08006' }), false);
});

test('reports query availability without replacing the original rejection', async () => {
  const connectionLost = Object.assign(new Error('connection lost'), {
    code: '08006',
  });
  const duplicate = Object.assign(new Error('duplicate'), { code: '23505' });
  const observed = [];
  let currentError = connectionLost;
  const pool = new PgPoolBinding(
    {
      async query() {
        throw currentError;
      },
    },
    (error) => {
      observed.push(error);
      throw new Error('availability listener failure');
    },
  );

  await assert.rejects(
    pool.query('SELECT 1'),
    (error) => error === connectionLost,
  );
  assert.deepEqual(observed, [connectionLost]);

  currentError = duplicate;
  await assert.rejects(pool.query('INSERT'), (error) => error === duplicate);
  assert.deepEqual(observed, [connectionLost]);
});

test('reports availability from connect and bound-client query failures', async () => {
  const connectError = Object.assign(new Error('network unreachable'), {
    code: 'ENETUNREACH',
  });
  const readOnlyError = Object.assign(new Error('read-only transaction'), {
    code: '25006',
  });
  const observed = [];
  let connectFails = true;
  const driverClient = Object.assign(new EventEmitter(), {
    async query() {
      throw readOnlyError;
    },
    release() {},
  });
  const pool = new PgPoolBinding(
    {
      async connect() {
        if (connectFails) throw connectError;
        return driverClient;
      },
    },
    (error) => observed.push(error),
  );

  await assert.rejects(pool.connect(), (error) => error === connectError);
  connectFails = false;
  const client = await pool.connect();
  await assert.rejects(
    client.query('SELECT 1'),
    (error) => error === readOnlyError,
  );
  client.release();
  assert.deepEqual(observed, [connectError, readOnlyError]);
});

test('contains checked-out client error events and removes its listener on release', async () => {
  const administratorShutdown = Object.assign(
    new Error('terminating connection due to administrator command'),
    { code: '57P01' },
  );
  const observed = [];
  let releases = 0;
  const driverClient = Object.assign(new EventEmitter(), {
    async query() {
      return { rows: [], rowCount: 0 };
    },
    release() {
      releases += 1;
    },
  });
  const pool = new PgPoolBinding(
    {
      async connect() {
        return driverClient;
      },
    },
    (error) => observed.push(error),
  );

  const client = await pool.connect();
  assert.equal(driverClient.listenerCount('error'), 1);
  assert.equal(driverClient.emit('error', administratorShutdown), true);
  assert.deepEqual(observed, [administratorShutdown]);

  client.release();
  assert.equal(releases, 1);
  assert.equal(driverClient.listenerCount('error'), 0);
});
