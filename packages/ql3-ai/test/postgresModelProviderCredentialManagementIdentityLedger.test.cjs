const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PostgresModelProviderCredentialManagementIdentityLedgerConflictError,
  PostgresModelProviderCredentialManagementIdentityLedgerRepository,
  PostgresModelProviderCredentialManagementIdentityLedgerUnavailableError,
  PostgresModelProviderCredentialManagerNotReadyError,
  assertPostgresModelProviderCredentialManagerReady,
} = require('../dist/model-provider-credential/postgresModelProviderCredentialManagementIdentityLedger.js');
const {
  POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID,
  postgresModelInvocationMigrationDefinition,
} = require('@qinglong/ai/model-invocation-migration');

function snapshot(generation, overrides = {}) {
  return {
    schemaVersion: 1,
    generation,
    digest: String.fromCharCode(64 + generation).repeat(43),
    issuer: 'https://identity.example.test/',
    audience: 'qinglong3-model-provider-credential-management',
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

function fixture() {
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
    repository:
      new PostgresModelProviderCredentialManagementIdentityLedgerRepository({
        async connect() {
          return client;
        },
        async query() {
          throw new Error('pool query must not bypass transaction client');
        },
      }),
    queries,
    state: () => state,
    releases: () => releases,
    loseNextCommitResponse() {
      loseCommitResponse = true;
    },
  };
}

test('serializes exact identity observation and forward-only rotation', async () => {
  const value = fixture();
  await value.repository.observe(snapshot(1));
  await value.repository.observe(snapshot(1));
  await value.repository.observe(snapshot(2));
  assert.deepEqual(value.state(), {
    generation: 2,
    digest: 'B'.repeat(43),
    issuer: 'https://identity.example.test/',
    audience: 'qinglong3-model-provider-credential-management',
    activeKeyIds: ['issuer-key-2'],
    revokedKeyIds: ['issuer-key-1'],
  });
  const insert = value.queries.find(({ text }) => text.startsWith('INSERT'));
  assert.equal(insert.values[0], 'model-provider-credential-management');
  assert.match(insert.text, /clock_timestamp\(\)/);
  assert.equal(value.releases(), 3);
});

test('rejects rollback, trust-domain drift and implicit key removal', async () => {
  const value = fixture();
  await value.repository.observe(snapshot(2));
  await assert.rejects(
    value.repository.observe(snapshot(1)),
    PostgresModelProviderCredentialManagementIdentityLedgerConflictError,
  );
  await assert.rejects(
    value.repository.observe(
      snapshot(3, { issuer: 'https://other.example.test/' }),
    ),
    PostgresModelProviderCredentialManagementIdentityLedgerConflictError,
  );
  await assert.rejects(
    value.repository.observe(
      snapshot(3, { activeKeyIds: ['issuer-key-3'], revokedKeyIds: [] }),
    ),
    PostgresModelProviderCredentialManagementIdentityLedgerConflictError,
  );
});

test('converges a lost commit response without accepting malformed keys', async () => {
  const value = fixture();
  value.loseNextCommitResponse();
  await assert.rejects(
    value.repository.observe(snapshot(1)),
    PostgresModelProviderCredentialManagementIdentityLedgerUnavailableError,
  );
  await value.repository.observe(snapshot(1));
  assert.equal(value.state().generation, 1);
  await assert.rejects(
    value.repository.observe(
      snapshot(2, { activeKeyIds: ['issuer-key-2', 'issuer-key-2'] }),
    ),
    TypeError,
  );
});

test('readiness binds exact migration history and least-privilege primary authority', async () => {
  const history = postgresModelInvocationMigrationDefinition.migrations.map(
    ({ id, checksum }) => ({
      migrationId: id,
      streamId: POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      dialect: 'postgresql',
      checksum,
    }),
  );
  const queries = [];
  const report = await assertPostgresModelProviderCredentialManagerReady({
    async query(text) {
      queries.push(text);
      return queries.length === 1
        ? { rows: history }
        : {
            rows: [
              {
                currentUser: 'ql3_ai_credential_manager',
                writablePrimary: true,
                managerAuthority: true,
                leastPrivilege: true,
              },
            ],
          };
    },
  });
  assert.equal(report.ready, true);
  assert.equal(
    report.migrationIds.at(-1),
    'pg-9019-ai-copilot-failure-diagnosis-tool-unlocks',
  );
  assert.match(
    queries[1],
    /model_provider_credential_management_identity_keyset_ledger/,
  );
  assert.match(queries[1], /model_provider_credential_test_plans/);
  assert.match(queries[1], /model_provider_credential_test_quota_buckets/);
  assert.match(queries[1], /model_invocation_prompt_output_artifacts/);
  await assert.rejects(
    assertPostgresModelProviderCredentialManagerReady({
      async query() {
        return { rows: [] };
      },
    }),
    PostgresModelProviderCredentialManagerNotReadyError,
  );
});
