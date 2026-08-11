const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PluginPackageAutomationPublicationConflictError,
  createInitialPluginPackageAutomationPublication,
  createNextPluginPackageAutomationPublication,
} = require('../../packages/ql3-runtime-core/dist/plugin-package/pluginPackageAutomationPublication');
const {
  pluginPackageTaskReconciliationFixture,
} = require('./pluginPackageTaskReconciliationRepositoryContract.cjs');

function automationOptions(name = 'daily') {
  return {
    workflows: [
      {
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: name,
        name: `Workflow ${name}`,
        enabled: true,
        steps: [{ id: 'run', task: 'alpha', needs: [] }],
      },
    ],
    prompts: [
      {
        schema: 'qinglong/plugin-package-prompt-resource@v1',
        id: `${name}-prompt`,
        name: `Prompt ${name}`,
        template: 'Hello {{name}}',
        parameters: [{ name: 'name', required: true }],
      },
    ],
  };
}

function fixture(namespace, options = {}) {
  return pluginPackageTaskReconciliationFixture(namespace, {
    profile: options.profile,
    previous: options.previous,
    ...automationOptions(options.name),
  });
}

function registerPluginPackageAutomationPublicationRepositoryContract(options) {
  test(`${options.name} publishes and replays one exact current head`, async (t) => {
    const value = fixture(`${options.namespace}-initial`, {
      profile: options.profile,
      name: 'daily',
    });
    const harness = await options.createRepository(t, value);
    t.after(() => harness.close?.());
    await harness.materializedRepository.publish(value.revision);
    const publication = createInitialPluginPackageAutomationPublication(
      value.revision,
      value.registry,
      1_000,
    );
    const created = await harness.repository.publish(publication);
    assert.equal(created.status, 'created');
    assert.deepEqual(created.publication, publication);
    assert.equal((await harness.repository.publish(publication)).status, 'existing');
    assert.deepEqual(
      await harness.repository.findByDigest(publication.publicationDigest),
      publication,
    );
    assert.deepEqual(
      await harness.repository.findCurrent(value.projectId, value.packageName),
      publication,
    );
  });

  test(`${options.name} advances generations with one CAS publication chain`, async (t) => {
    const first = fixture(`${options.namespace}-upgrade`, {
      profile: options.profile,
      name: 'daily',
    });
    const harness = await options.createRepository(t, first);
    t.after(() => harness.close?.());
    await harness.materializedRepository.publish(first.revision);
    const initial = createInitialPluginPackageAutomationPublication(
      first.revision,
      first.registry,
      1_000,
    );
    await harness.repository.publish(initial);

    const second = fixture(first.namespace, {
      profile: options.profile,
      previous: first,
      name: 'hourly',
    });
    await harness.materializedRepository.publish(second.revision);
    const next = createNextPluginPackageAutomationPublication(
      second.revision,
      second.registry,
      initial,
      1_100,
    );
    assert.equal((await harness.repository.publish(next)).status, 'created');
    assert.deepEqual(
      await harness.repository.findCurrent(first.projectId, first.packageName),
      next,
    );
    assert.deepEqual(
      await harness.repository.findByDigest(initial.publicationDigest),
      initial,
    );

    const staleFork = createNextPluginPackageAutomationPublication(
      second.revision,
      second.registry,
      initial,
      1_101,
    );
    await assert.rejects(
      harness.repository.publish(staleFork),
      PluginPackageAutomationPublicationConflictError,
    );
    assert.deepEqual(
      await harness.repository.findCurrent(first.projectId, first.packageName),
      next,
    );
  });

  test(`${options.name} persists absent tombstones across Package generations`, async (t) => {
    const first = fixture(`${options.namespace}-tombstone`, {
      profile: options.profile,
      name: 'daily',
    });
    const harness = await options.createRepository(t, first);
    t.after(() => harness.close?.());
    await harness.materializedRepository.publish(first.revision);
    const initial = createInitialPluginPackageAutomationPublication(
      first.revision,
      first.registry,
      1_000,
    );
    await harness.repository.publish(initial);

    const second = pluginPackageTaskReconciliationFixture(first.namespace, {
      profile: options.profile,
      previous: first,
    });
    await harness.materializedRepository.publish(second.revision);
    const absent = createNextPluginPackageAutomationPublication(
      second.revision,
      second.registry,
      initial,
      1_100,
    );
    assert.equal(absent.state, 'absent');
    assert.equal((await harness.repository.publish(absent)).status, 'created');

    const third = fixture(first.namespace, {
      profile: options.profile,
      previous: second,
      name: 'restored',
    });
    await harness.materializedRepository.publish(third.revision);
    const restored = createNextPluginPackageAutomationPublication(
      third.revision,
      third.registry,
      absent,
      1_200,
    );
    assert.equal(restored.state, 'active');
    assert.equal((await harness.repository.publish(restored)).status, 'created');
    assert.deepEqual(
      await harness.repository.findCurrent(first.projectId, first.packageName),
      restored,
    );
    assert.deepEqual(
      await harness.repository.findByDigest(absent.publicationDigest),
      absent,
    );
  });
}

module.exports = {
  pluginPackageAutomationPublicationFixture: fixture,
  registerPluginPackageAutomationPublicationRepositoryContract,
};
