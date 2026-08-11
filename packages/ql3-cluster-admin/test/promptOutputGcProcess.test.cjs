const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  pluginPackagePromptOutputArtifactRetentionPolicyDigest,
} = require('@qinglong/ai/plugin-package-prompt-output-artifact');
const {
  ClusterPromptOutputGcProcessConfigError,
  runClusterPromptOutputGcProcess,
} = require('../dist/prompt-output/retention/promptOutputGcProcess');

function catalog() {
  const policy = { revision: 'retention-v1', retentionMs: 3_600_000 };
  return {
    schemaVersion: 1,
    policies: [
      {
        projectId: 'project-a',
        policy,
        policyDigest:
          pluginPackagePromptOutputArtifactRetentionPolicyDigest(policy),
      },
    ],
  };
}

test('runs one bounded page through the maintenance-only PostgreSQL authority', async () => {
  const statements = [];
  let closed = false;
  const pool = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql.includes('current_user AS "currentUser"')) {
        return {
          rows: [
            {
              currentUser: 'ql3_ai_maintenance',
              maintenanceAuthority: true,
              schemaAuthority: true,
              artifactDeleteOnly: true,
              tombstoneAppendOnly: true,
              keyRetirementAppendOnly: true,
              keyRotationAppendOnly: true,
              terminalEvidenceReadOnly: true,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('clock_timestamp()')) {
        return { rows: [{ observedAtMs: '1000' }], rowCount: 1 };
      }
      if (sql.includes('SELECT artifact_id AS "artifactId"')) {
        assert.deepEqual(values, [1000, 5]);
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async connect() {
      throw new Error('empty scan must not acquire a transaction client');
    },
  };
  const result = await runClusterPromptOutputGcProcess({
    database: { connection: { host: 'postgres.example.test' } },
    retentionPolicyCatalog: catalog(),
    limit: 4,
    async openDatabase() {
      return {
        pool,
        async close() {
          closed = true;
        },
      };
    },
  });
  assert.deepEqual(
    {
      scanned: result.scanned,
      tombstoned: result.tombstoned,
      skipped: result.skipped,
      hasMore: result.hasMore,
    },
    { scanned: 0, tombstoned: 0, skipped: 0, hasMore: false },
  );
  assert.equal(result.readiness.maintenanceAuthority, true);
  assert.equal(statements.length, 3);
  assert.equal(closed, true);
});

test('rejects a rewritten policy before opening PostgreSQL', async () => {
  let opened = false;
  const invalid = catalog();
  invalid.policies[0].policyDigest = '0'.repeat(64);
  await assert.rejects(
    runClusterPromptOutputGcProcess({
      database: { connection: { host: 'postgres.example.test' } },
      retentionPolicyCatalog: invalid,
      async openDatabase() {
        opened = true;
        throw new Error('must not open');
      },
    }),
    ClusterPromptOutputGcProcessConfigError,
  );
  assert.equal(opened, false);
});
