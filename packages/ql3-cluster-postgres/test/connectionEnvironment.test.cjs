const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PostgresConnectionEnvironmentError,
  loadPostgresConnectionEnvironment,
} = require('../dist/entrypoints/runtime.js');

const KEYS = Object.freeze({
  connectionString: 'POSTGRES_URL',
  host: 'POSTGRES_HOST',
  port: 'POSTGRES_PORT',
  database: 'POSTGRES_DATABASE',
  user: 'POSTGRES_USER',
  password: 'POSTGRES_PASSWORD',
});

test('loads a legacy URL without exposing TLS query overrides', () => {
  assert.deepEqual(
    loadPostgresConnectionEnvironment(
      {
        POSTGRES_URL:
          'postgresql://ql3_runtime:secret@postgres-rw.internal:5432/qinglong',
      },
      KEYS,
    ),
    {
      connectionString:
        'postgresql://ql3_runtime:secret@postgres-rw.internal:5432/qinglong',
    },
  );
  assert.throws(
    () =>
      loadPostgresConnectionEnvironment(
        {
          POSTGRES_URL:
            'postgresql://ql3_runtime:secret@postgres-rw.internal/qinglong?sslmode=disable',
        },
        KEYS,
      ),
    /TLS query parameters are forbidden/,
  );
});

test('loads an exact discrete operator credential with the default port', () => {
  assert.deepEqual(
    loadPostgresConnectionEnvironment(
      {
        POSTGRES_HOST: 'ql3-postgres-rw.qinglong3-system.svc',
        POSTGRES_DATABASE: 'qinglong',
        POSTGRES_USER: 'ql3_runtime',
        POSTGRES_PASSWORD: 'secret',
      },
      KEYS,
    ),
    {
      host: 'ql3-postgres-rw.qinglong3-system.svc',
      port: 5432,
      database: 'qinglong',
      user: 'ql3_runtime',
      password: 'secret',
    },
  );
});

test('rejects mixed, partial, unbounded and unsafe discrete credentials', () => {
  for (const environment of [
    {
      POSTGRES_URL: 'postgresql://ql3_runtime:secret@database/qinglong',
      POSTGRES_HOST: 'database',
    },
    {
      POSTGRES_HOST: 'database',
      POSTGRES_DATABASE: 'qinglong',
      POSTGRES_USER: 'ql3_runtime',
    },
    {
      POSTGRES_HOST: 'database',
      POSTGRES_PORT: '0',
      POSTGRES_DATABASE: 'qinglong',
      POSTGRES_USER: 'ql3_runtime',
      POSTGRES_PASSWORD: 'secret',
    },
    {
      POSTGRES_HOST: 'database',
      POSTGRES_DATABASE: 'qinglong',
      POSTGRES_USER: 'role-with-hyphen',
      POSTGRES_PASSWORD: 'secret',
    },
    {
      POSTGRES_HOST: 'database',
      POSTGRES_DATABASE: 'qinglong',
      POSTGRES_USER: 'ql3_runtime',
      POSTGRES_PASSWORD: 'line\nbreak',
    },
  ]) {
    assert.throws(
      () => loadPostgresConnectionEnvironment(environment, KEYS),
      PostgresConnectionEnvironmentError,
    );
  }
});
