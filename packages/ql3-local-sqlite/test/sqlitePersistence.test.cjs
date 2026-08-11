const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createSqlitePersistencePrimitives,
  isSqliteDriverError,
  sqliteDriverErrorCode,
  sqliteDriverErrorMessage,
  sqliteDriverErrorNumber,
} = require('../dist/storage/sqlitePersistence');
const runPersistence = require('../dist/run/runPersistence');
const securityPersistence = require('../dist/security/securityPersistence');

class AdapterError extends Error {}

function primitives() {
  return createSqlitePersistencePrimitives({
    invalidRowValue: (property) => new AdapterError(`invalid:${property}`),
    invalidJson: (property) => new AdapterError(`json:${property}`),
    unsupportedRowValue: (property) =>
      new AdapterError(`unsupported:${property}`),
    duplicateIdentityRows: () => new AdapterError('duplicate'),
    mapDriverError: (error) => new AdapterError('driver', { cause: error }),
  });
}

test('domain-neutral row primitives preserve scalar, JSON and blob semantics', () => {
  const persistence = primitives();
  const source = Uint8Array.from([1, 2, 3]);
  const row = {
    text: 'value',
    empty: '',
    absent: null,
    integer: 42,
    unsafe: Number.MAX_SAFE_INTEGER + 1,
    enabled: 1,
    disabled: 0,
    json: '{"ok":true}',
    brokenJson: '{',
    blob: source,
    state: 'ready',
  };

  assert.equal(persistence.requiredString(row, 'text'), 'value');
  assert.equal(persistence.optionalString(row, 'empty'), '');
  assert.equal(persistence.optionalString(row, 'absent'), undefined);
  assert.equal(persistence.requiredInteger(row, 'integer'), 42);
  assert.equal(persistence.optionalInteger(row, 'absent'), undefined);
  assert.equal(persistence.requiredBoolean(row, 'enabled'), true);
  assert.equal(persistence.requiredBoolean(row, 'disabled'), false);
  assert.deepEqual(persistence.requiredJson(row, 'json'), { ok: true });
  assert.equal(
    persistence.requiredEnum(row, 'state', ['ready', 'done']),
    'ready',
  );
  const blob = persistence.requiredBlob(row, 'blob');
  assert.deepEqual(blob, Buffer.from([1, 2, 3]));
  source[0] = 9;
  assert.deepEqual(blob, Buffer.from([1, 2, 3]));

  assert.throws(
    () => persistence.requiredString(row, 'empty'),
    /invalid:empty/,
  );
  assert.throws(
    () => persistence.requiredInteger(row, 'unsafe'),
    /invalid:unsafe/,
  );
  assert.throws(
    () => persistence.requiredJson(row, 'brokenJson'),
    /json:brokenJson/,
  );
  assert.throws(
    () => persistence.requiredEnum(row, 'state', ['done']),
    /unsupported:state/,
  );
});

test('domain-neutral query primitives delegate all errors to the boundary contract', () => {
  const persistence = primitives();
  const expected = [{ id: 'one' }];
  const client = {
    prepare(sql) {
      assert.equal(sql, 'SELECT ?');
      return {
        all(...values) {
          assert.deepEqual(values, ['one']);
          return expected;
        },
      };
    },
  };

  assert.deepEqual(
    persistence.queryRows(client, 'SELECT ?', ['one']),
    expected,
  );
  assert.equal(persistence.singleRow(expected), expected[0]);
  assert.equal(persistence.singleRow([]), null);
  assert.throws(
    () => persistence.singleRow([expected[0], { id: 'two' }]),
    /duplicate/,
  );

  const driverFailure = new Error('sqlite failure');
  const failingClient = {
    prepare() {
      throw driverFailure;
    },
  };
  assert.throws(
    () => persistence.queryRows(failingClient, 'SELECT 1'),
    (error) =>
      error instanceof AdapterError &&
      error.message === 'driver' &&
      error.cause === driverFailure,
  );
});

test('SQLite driver observation remains domain neutral', () => {
  const error = Object.assign(new Error('busy'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 5,
  });
  assert.equal(sqliteDriverErrorCode(error), 'ERR_SQLITE_ERROR');
  assert.equal(sqliteDriverErrorNumber(error), 5);
  assert.equal(sqliteDriverErrorMessage(error), 'busy');
  assert.equal(isSqliteDriverError(error), true);
  assert.equal(isSqliteDriverError(new Error('other')), false);
  assert.equal(sqliteDriverErrorMessage('other'), '');
});

test('Run and Security adapters freeze the existing corruption contract', () => {
  for (const persistence of [runPersistence, securityPersistence]) {
    assert.throws(
      () => persistence.requiredString({ value: '' }, 'value'),
      (error) =>
        error.name === 'RunRepositoryConstraintError' &&
        error.message === 'Local SQLite Run row has an invalid value',
    );
    assert.throws(
      () => persistence.requiredBlob({ value: 'not-a-blob' }, 'value'),
      (error) =>
        error.name === 'RunRepositoryConstraintError' &&
        error.message === 'Local SQLite row has an invalid value',
    );
    assert.throws(
      () => persistence.singleRow([{ id: 'one' }, { id: 'two' }]),
      (error) =>
        error.name === 'RunRepositoryConstraintError' &&
        error.message ===
          'Local SQLite Run repository returned duplicate identity rows',
    );

    const constraint = persistence.mapSqliteError({
      code: 'ERR_SQLITE_CONSTRAINT',
    });
    assert.equal(constraint.name, 'RunRepositoryConstraintError');
    assert.equal(
      constraint.message,
      'Local SQLite Run repository constraint violation',
    );
    assert.equal(
      persistence.mapSqliteError({ errcode: 5 }).name,
      'RunRepositoryBusyError',
    );
    assert.equal(
      persistence.mapSqliteError(new Error('other')).name,
      'RunRepositoryOperationError',
    );
  }
});
