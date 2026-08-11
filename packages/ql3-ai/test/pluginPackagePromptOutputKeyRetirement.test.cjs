const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

const {
  InvalidPluginPackagePromptOutputKeyRetirementError,
  PluginPackagePromptOutputKeyRetirementConflictError,
  PluginPackagePromptOutputKeyRetirementCoordinator,
  PluginPackagePromptOutputKeyRetirementUnavailableError,
  createPluginPackagePromptOutputKeyRetirementCompletion,
  createPluginPackagePromptOutputKeyRetirementPreparation,
  normalizePluginPackagePromptOutputKeyRetirementCompletion,
  normalizePluginPackagePromptOutputKeyRetirementPreparation,
  pluginPackagePromptOutputKeyRetirementAbsenceProof,
} = require('../dist/prompt-output/key-management/pluginPackagePromptOutputKeyRetirement.js');

const digest = (value) => createHash('sha256').update(value).digest('hex');

function request() {
  return {
    keyId: 'prompt-output-key-old',
    retirementId: 'retire-prompt-output-key-old',
    requestId: 'request-retire-prompt-output-key-old',
    mutationId: 'mutation-retire-prompt-output-key-old',
  };
}

function harness(options = {}) {
  let record = null;
  let material = {
    state: options.materialState ?? 'inactive',
    keyId: request().keyId,
    catalogDigest: digest('catalog-before'),
    materialProof: digest('material-old'),
  };
  let retireCalls = 0;
  let failRetireResponse = options.failRetireResponse ?? false;
  let failCompleteResponse = options.failCompleteResponse ?? false;
  const repository = {
    async find() {
      return record;
    },
    async prepare(command) {
      if (options.liveArtifacts) {
        throw new PluginPackagePromptOutputKeyRetirementUnavailableError();
      }
      const preparation =
        createPluginPackagePromptOutputKeyRetirementPreparation({
          ...command,
          preparedAtMs: 100,
        });
      if (record) {
        assert.deepEqual(record.preparation, preparation);
        return { status: 'existing', preparation: record.preparation };
      }
      record = { preparation, completion: null };
      return { status: 'created', preparation };
    },
    async complete(command) {
      const completion = createPluginPackagePromptOutputKeyRetirementCompletion(
        {
          ...command,
          completedAtMs: 200,
        },
      );
      if (record.completion) {
        assert.deepEqual(record.completion, completion);
        return { status: 'existing', completion: record.completion };
      }
      record = { ...record, completion };
      if (failCompleteResponse) {
        failCompleteResponse = false;
        throw new Error('completion response lost');
      }
      return { status: 'created', completion };
    },
  };
  const materials = {
    async inspect() {
      return { ...material };
    },
    async retire(command) {
      retireCalls += 1;
      assert.equal(command.preparation.keyId, material.keyId);
      assert.equal(command.preparation.catalogDigest, material.catalogDigest);
      assert.equal(command.preparation.materialProof, material.materialProof);
      material = {
        state: 'absent',
        keyId: command.preparation.keyId,
        catalogDigest: digest('catalog-after'),
        absenceProof: pluginPackagePromptOutputKeyRetirementAbsenceProof(
          record.preparation,
          digest('catalog-after'),
        ),
      };
      if (failRetireResponse) {
        failRetireResponse = false;
        throw new Error('retirement response lost');
      }
      return { ...material };
    },
  };
  return {
    coordinator: new PluginPackagePromptOutputKeyRetirementCoordinator({
      repository,
      materials,
    }),
    record: () => record,
    retireCalls: () => retireCalls,
    setMaterial(next) {
      material = next;
    },
  };
}

test('normalizes exact content-free preparation and completion receipts', () => {
  const preparation = createPluginPackagePromptOutputKeyRetirementPreparation({
    ...request(),
    catalogDigest: digest('catalog'),
    materialProof: digest('material'),
    preparedAtMs: 100,
  });
  const completion = createPluginPackagePromptOutputKeyRetirementCompletion({
    preparation,
    retiredCatalogDigest: digest('retired-catalog'),
    absenceProof: digest('absence'),
    completedAtMs: 200,
  });
  assert.deepEqual(
    normalizePluginPackagePromptOutputKeyRetirementPreparation(preparation),
    preparation,
  );
  assert.deepEqual(
    normalizePluginPackagePromptOutputKeyRetirementCompletion(completion),
    completion,
  );
  assert.throws(
    () =>
      normalizePluginPackagePromptOutputKeyRetirementPreparation({
        ...preparation,
        widened: true,
      }),
    InvalidPluginPackagePromptOutputKeyRetirementError,
  );
});

test('prepares a durable fence before retiring inactive material', async () => {
  const value = harness();
  const retired = await value.coordinator.retire(request());
  assert.equal(retired.status, 'completed');
  assert.equal(value.retireCalls(), 1);
  assert.deepEqual(value.record(), {
    preparation: retired.preparation,
    completion: retired.completion,
  });
  assert.equal((await value.coordinator.retire(request())).status, 'existing');
  assert.equal(value.retireCalls(), 1);
});

test('rejects active material and live Artifact coverage', async () => {
  const active = harness({ materialState: 'active' });
  await assert.rejects(
    active.coordinator.retire(request()),
    PluginPackagePromptOutputKeyRetirementConflictError,
  );
  assert.equal(active.record(), null);
  const referenced = harness({ liveArtifacts: true });
  await assert.rejects(
    referenced.coordinator.retire(request()),
    PluginPackagePromptOutputKeyRetirementUnavailableError,
  );
  assert.equal(referenced.retireCalls(), 0);
});

test('recovers when material retirement succeeded but its response was lost', async () => {
  const value = harness({ failRetireResponse: true });
  await assert.rejects(
    value.coordinator.retire(request()),
    PluginPackagePromptOutputKeyRetirementUnavailableError,
  );
  assert.equal(value.record().completion, null);
  const recovered = await value.coordinator.retire(request());
  assert.equal(recovered.status, 'completed');
  assert.equal(value.retireCalls(), 1);
});

test('recovers completion response loss and rejects material drift', async () => {
  const responseLoss = harness({ failCompleteResponse: true });
  await assert.rejects(
    responseLoss.coordinator.retire(request()),
    PluginPackagePromptOutputKeyRetirementUnavailableError,
  );
  assert.equal(
    (await responseLoss.coordinator.retire(request())).status,
    'existing',
  );

  const drift = harness({ failRetireResponse: true });
  await assert.rejects(drift.coordinator.retire(request()));
  drift.setMaterial({
    state: 'absent',
    keyId: request().keyId,
    catalogDigest: digest('drifted-catalog'),
    absenceProof: digest('drifted-absence'),
  });
  await assert.rejects(
    drift.coordinator.retire(request()),
    PluginPackagePromptOutputKeyRetirementConflictError,
  );
});
