const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PluginPackagePromptOutputKeyRotationConflictError,
  PluginPackagePromptOutputKeyRotationCoordinator,
  PluginPackagePromptOutputKeyRotationUnavailableError,
  createPluginPackagePromptOutputKeyRotationCompletion,
  createPluginPackagePromptOutputKeyRotationPreparation,
  normalizePluginPackagePromptOutputKeyRotationCompletion,
  normalizePluginPackagePromptOutputKeyRotationPreparation,
  pluginPackagePromptOutputKeyRotationMaterialProof,
} = require('../dist/prompt-output/key-management/pluginPackagePromptOutputKeyRotation.js');

function request() {
  return {
    rotationId: 'rotation-001',
    requestId: 'request-001',
    mutationId: 'mutation-001',
    expectedSecretUid: 'secret-uid-001',
    expectedActiveKeyId: 'prompt-key-one',
    expectedCatalogDigest: '1'.repeat(64),
    newKeyId: 'prompt-key-two',
  };
}

function state(material) {
  return {
    generation: 2,
    previousActiveKeyId: 'prompt-key-one',
    activeKeyId: 'prompt-key-two',
    catalogDigest: '2'.repeat(64),
    materialProof: pluginPackagePromptOutputKeyRotationMaterialProof(
      'prompt-key-two',
      material,
    ),
  };
}

function memoryRepository(options = {}) {
  let record = null;
  let clock = 1_000;
  let failedAfterComplete = false;
  return {
    get record() {
      return record;
    },
    async find(rotationId) {
      return record?.preparation.rotationId === rotationId ? record : null;
    },
    async prepare(command) {
      const candidate = createPluginPackagePromptOutputKeyRotationPreparation({
        ...command,
        preparedAtMs: clock++,
      });
      if (record) {
        return { status: 'existing', preparation: record.preparation };
      }
      record = { preparation: candidate, completion: null };
      return { status: 'created', preparation: candidate };
    },
    async complete(command) {
      if (record.completion) {
        return { status: 'existing', completion: record.completion };
      }
      const completion = createPluginPackagePromptOutputKeyRotationCompletion({
        ...command,
        completedAtMs: clock++,
      });
      record = { ...record, completion };
      if (options.failOnceAfterComplete && !failedAfterComplete) {
        failedAfterComplete = true;
        throw new PluginPackagePromptOutputKeyRotationUnavailableError();
      }
      return { status: 'created', completion };
    },
  };
}

test('creates content-free rotation facts and exact replay skips material mutation', async () => {
  const material = Buffer.alloc(32, 0x42);
  const repository = memoryRepository();
  let rotations = 0;
  const coordinator = new PluginPackagePromptOutputKeyRotationCoordinator({
    repository,
    materials: {
      async rotate() {
        rotations += 1;
        return state(material);
      },
    },
  });

  const completed = await coordinator.rotate({ request: request(), material });
  assert.equal(completed.status, 'completed');
  assert.equal(rotations, 1);
  const replay = await coordinator.rotate({ request: request(), material });
  assert.equal(replay.status, 'existing');
  assert.equal(rotations, 1);
  assert.deepEqual(replay.completion, completed.completion);
  assert.deepEqual(
    normalizePluginPackagePromptOutputKeyRotationPreparation(
      completed.preparation,
    ),
    completed.preparation,
  );
  assert.deepEqual(
    normalizePluginPackagePromptOutputKeyRotationCompletion(
      completed.completion,
    ),
    completed.completion,
  );
  const durable = JSON.stringify(repository.record);
  assert.equal(durable.includes(material.toString('base64url')), false);
  assert.equal(durable.includes(material.toString('hex')), false);
});

test('resumes after preparation and converges after completion response loss', async () => {
  const material = Buffer.alloc(32, 0x51);
  const repository = memoryRepository({ failOnceAfterComplete: true });
  await repository.prepare({
    request: request(),
    materialProof: pluginPackagePromptOutputKeyRotationMaterialProof(
      request().newKeyId,
      material,
    ),
  });
  let rotations = 0;
  const coordinator = new PluginPackagePromptOutputKeyRotationCoordinator({
    repository,
    materials: {
      async rotate() {
        rotations += 1;
        return state(material);
      },
    },
  });

  await assert.rejects(
    coordinator.rotate({ request: request(), material }),
    PluginPackagePromptOutputKeyRotationUnavailableError,
  );
  assert.equal(rotations, 1);
  const replay = await coordinator.rotate({ request: request(), material });
  assert.equal(replay.status, 'existing');
  assert.equal(rotations, 1);
});

test('a prepared rotation rejects changed staged material and drifted successor', async () => {
  const original = Buffer.alloc(32, 0x61);
  const changed = Buffer.alloc(32, 0x62);
  const repository = memoryRepository();
  await repository.prepare({
    request: request(),
    materialProof: pluginPackagePromptOutputKeyRotationMaterialProof(
      request().newKeyId,
      original,
    ),
  });
  const coordinator = new PluginPackagePromptOutputKeyRotationCoordinator({
    repository,
    materials: {
      async rotate() {
        return state(original);
      },
    },
  });
  await assert.rejects(
    coordinator.rotate({ request: request(), material: changed }),
    PluginPackagePromptOutputKeyRotationConflictError,
  );

  const fresh = memoryRepository();
  const drifted = new PluginPackagePromptOutputKeyRotationCoordinator({
    repository: fresh,
    materials: {
      async rotate() {
        return {
          ...state(original),
          catalogDigest: '3'.repeat(64),
          activeKeyId: 'other-key',
        };
      },
    },
  });
  await assert.rejects(
    drifted.rotate({ request: request(), material: original }),
    PluginPackagePromptOutputKeyRotationConflictError,
  );
});
