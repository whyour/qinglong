const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ClusterPromptOutputKeyRotationProcessConfigError,
  runClusterPromptOutputKeyRotationProcess,
} = require('../dist/prompt-output/key-management/promptOutputKeyRotationProcess.js');
const {
  pluginPackagePromptOutputKeyRotationMaterialProof,
} = require('@qinglong/ai/plugin-package-prompt-output-key-rotation');

function request() {
  return {
    rotationId: 'rotation-process-1',
    requestId: 'rotation-process-request-1',
    mutationId: 'rotation-process-mutation-1',
    expectedSecretUid: 'rotation-secret-uid-1',
    expectedActiveKeyId: 'key-before',
    expectedCatalogDigest: '1'.repeat(64),
    newKeyId: 'key-after',
  };
}

function fakeDatabase(material) {
  let preparation;
  let completion;
  let closed = 0;
  const client = {
    async query(sql, parameters = []) {
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
        };
      }
      if (sql.includes('key_rotation_preparations') && sql.includes('SELECT')) {
        return {
          rows: preparation
            ? [
                {
                  rotationId: preparation.rotationId,
                  requestId: preparation.requestId,
                  mutationId: preparation.mutationId,
                  expectedSecretUid: preparation.expectedSecretUid,
                  expectedActiveKeyId: preparation.expectedActiveKeyId,
                  expectedCatalogDigest: preparation.expectedCatalogDigest,
                  newKeyId: preparation.newKeyId,
                  materialProof: preparation.materialProof,
                  preparedAtMs: String(preparation.preparedAtMs),
                  preparationDigest: preparation.preparationDigest,
                  preparationJson: preparation,
                },
              ]
            : [],
        };
      }
      if (sql.includes('key_rotation_completions') && sql.includes('SELECT')) {
        return {
          rows: completion
            ? [
                {
                  rotationId: completion.rotationId,
                  requestId: completion.requestId,
                  mutationId: completion.mutationId,
                  preparationDigest: completion.preparationDigest,
                  generation: String(completion.generation),
                  previousActiveKeyId: completion.previousActiveKeyId,
                  activeKeyId: completion.activeKeyId,
                  catalogDigest: completion.catalogDigest,
                  materialProof: completion.materialProof,
                  completedAtMs: String(completion.completedAtMs),
                  completionDigest: completion.completionDigest,
                  completionJson: completion,
                },
              ]
            : [],
        };
      }
      if (
        sql.includes('INSERT INTO') &&
        sql.includes('key_rotation_preparations')
      ) {
        preparation = JSON.parse(parameters[10]);
      }
      if (
        sql.includes('INSERT INTO') &&
        sql.includes('key_rotation_completions')
      ) {
        completion = JSON.parse(parameters[11]);
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
    async query(sql, parameters) {
      return client.query(sql, parameters);
    },
  };
  return {
    database: {
      pool,
      async close() {
        closed += 1;
      },
    },
    get closed() {
      return closed;
    },
    get completion() {
      return completion;
    },
    materials: {
      async rotate(command) {
        return {
          generation: 2,
          previousActiveKeyId: command.expectedActiveKeyId,
          activeKeyId: command.newKeyId,
          catalogDigest: '2'.repeat(64),
          materialProof: pluginPackagePromptOutputKeyRotationMaterialProof(
            command.newKeyId,
            material,
          ),
        };
      },
    },
  };
}

test('Cluster rotation process commits content-free prepare and completion', async () => {
  const material = Buffer.alloc(32, 0x71);
  const fixture = fakeDatabase(material);
  const result = await runClusterPromptOutputKeyRotationProcess({
    database: { connection: { connectionString: 'postgres://unused' } },
    request: request(),
    material,
    materials: fixture.materials,
    openDatabase: async () => fixture.database,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.generation, 2);
  assert.equal(result.activeKeyId, 'key-after');
  assert.equal(result.readiness.keyRotationAppendOnly, true);
  assert.equal(fixture.closed, 1);
  const durable = JSON.stringify(fixture.completion);
  assert.equal(durable.includes(material.toString('base64url')), false);
  assert.equal(durable.includes(material.toString('hex')), false);
});

test('Cluster rotation process rejects invalid material before opening PostgreSQL', async () => {
  let opened = false;
  await assert.rejects(
    runClusterPromptOutputKeyRotationProcess({
      database: { connection: { connectionString: 'postgres://unused' } },
      request: request(),
      material: Buffer.alloc(31),
      materials: {
        async rotate() {
          throw new Error('unreachable');
        },
      },
      openDatabase: async () => {
        opened = true;
        throw new Error('must not open');
      },
    }),
    ClusterPromptOutputKeyRotationProcessConfigError,
  );
  assert.equal(opened, false);
});
