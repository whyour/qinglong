const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PostgresPluginPackageIdentityKeysetLedgerConflictError,
  PostgresPluginPackageIdentityKeysetLedgerRepository,
  PostgresPluginPackageIdentityKeysetLedgerUnavailableError,
} = require('../dist/entrypoints/packageManager');

function snapshot(generation, overrides = {}) {
  return {
    schemaVersion: 1,
    generation,
    digest: String.fromCharCode(64 + generation).repeat(43),
    issuer: 'https://identity.example.test/',
    audience: 'qinglong3-package-management',
    activeKeyIds: [`issuer-key-${generation}`],
    revokedKeyIds:
      generation === 1
        ? []
        : Array.from(
            { length: generation - 1 },
            (_, index) => `issuer-key-${index + 1}`,
          ),
    ...overrides,
  };
}

function fixture(authority = 'plugin-package-management') {
  let state;
  let loseCommitResponse = false;
  const queries = [];
  let releases = 0;
  const client = {
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.startsWith('INSERT')) {
        state ??= {
          generation: values[1],
          digest: values[2],
          issuer: values[3],
          audience: values[4],
          activeKeyIds: JSON.parse(values[5]),
          revokedKeyIds: JSON.parse(values[6]),
        };
      } else if (text.startsWith('SELECT')) {
        return { rows: state ? [{ ...state }] : [] };
      } else if (text.startsWith('UPDATE')) {
        state = {
          ...state,
          generation: values[1],
          digest: values[2],
          activeKeyIds: JSON.parse(values[3]),
          revokedKeyIds: JSON.parse(values[4]),
        };
      } else if (text === 'COMMIT' && loseCommitResponse) {
        loseCommitResponse = false;
        throw new Error('response lost after commit');
      }
      return { rows: [] };
    },
    release() {
      releases += 1;
    },
  };
  return {
    repository: new PostgresPluginPackageIdentityKeysetLedgerRepository({
      async connect() {
        return client;
      },
      async query() {
        throw new Error('pool query must not bypass the transaction client');
      },
    }, authority),
    queries,
    state: () => state,
    releases: () => releases,
    loseNextCommitResponse() {
      loseCommitResponse = true;
    },
  };
}

test('serializes first observation, exact replay and append-only rotation', async () => {
  const value = fixture();
  await value.repository.observe(snapshot(1));
  const writesAfterFirst = value.queries.filter(({ text }) =>
    text.startsWith('UPDATE'),
  ).length;
  await value.repository.observe(snapshot(1));
  assert.equal(
    value.queries.filter(({ text }) => text.startsWith('UPDATE')).length,
    writesAfterFirst,
  );
  await value.repository.observe(snapshot(2));
  assert.deepEqual(value.state(), {
    generation: 2,
    digest: 'B'.repeat(43),
    issuer: 'https://identity.example.test/',
    audience: 'qinglong3-package-management',
    activeKeyIds: ['issuer-key-2'],
    revokedKeyIds: ['issuer-key-1'],
  });
  assert.match(
    value.queries.find(({ text }) => text.startsWith('INSERT')).text,
    /clock_timestamp\(\)/,
  );
  assert.equal(value.releases(), 3);
});

test('isolates Plugin, Worker, automation, Approval and Run generations by authority key', async () => {
  const value = fixture('worker-credential-management');
  await value.repository.observe(
    snapshot(1, { audience: 'qinglong3-worker-credential-management' }),
  );
  const insert = value.queries.find(({ text }) => text.startsWith('INSERT'));
  assert.equal(insert.values[0], 'worker-credential-management');
  const automation = fixture('automation-management');
  await automation.repository.observe(
    snapshot(1, { audience: 'qinglong3-automation-management' }),
  );
  assert.equal(
    automation.queries.find(({ text }) => text.startsWith('INSERT')).values[0],
    'automation-management',
  );
  const approval = fixture('approval-management');
  await approval.repository.observe(
    snapshot(1, { audience: 'qinglong3-approval-management' }),
  );
  assert.equal(
    approval.queries.find(({ text }) => text.startsWith('INSERT')).values[0],
    'approval-management',
  );
  const run = fixture('run-management');
  await run.repository.observe(
    snapshot(1, { audience: 'qinglong3-run-management' }),
  );
  assert.equal(
    run.queries.find(({ text }) => text.startsWith('INSERT')).values[0],
    'run-management',
  );
  assert.throws(
    () => fixture('worker-credential-executor'),
    TypeError,
  );
});

test('rejects rollback, trust-domain rewrite and implicit key removal', async () => {
  const value = fixture();
  await value.repository.observe(snapshot(2));
  await assert.rejects(
    value.repository.observe(snapshot(1)),
    PostgresPluginPackageIdentityKeysetLedgerConflictError,
  );
  await assert.rejects(
    value.repository.observe(
      snapshot(3, { issuer: 'https://other.example.test/' }),
    ),
    PostgresPluginPackageIdentityKeysetLedgerConflictError,
  );
  await assert.rejects(
    value.repository.observe(
      snapshot(3, {
        activeKeyIds: ['issuer-key-3'],
        revokedKeyIds: [],
      }),
    ),
    PostgresPluginPackageIdentityKeysetLedgerConflictError,
  );
});

test('converges an ambiguous commit and validates bounded snapshots', async () => {
  const value = fixture();
  value.loseNextCommitResponse();
  await assert.rejects(
    value.repository.observe(snapshot(1)),
    PostgresPluginPackageIdentityKeysetLedgerUnavailableError,
  );
  await value.repository.observe(snapshot(1));
  assert.equal(value.state().generation, 1);
  await assert.rejects(
    value.repository.observe(
      snapshot(2, { activeKeyIds: ['issuer-key-2', 'issuer-key-2'] }),
    ),
    TypeError,
  );
  assert.throws(
    () =>
      new PostgresPluginPackageIdentityKeysetLedgerRepository({ query() {} }),
    TypeError,
  );
});
