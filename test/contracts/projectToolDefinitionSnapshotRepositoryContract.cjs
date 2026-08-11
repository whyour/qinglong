const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createProjectToolDefinitionSnapshot,
  projectToolDefinitionSnapshotContribution,
  InvalidProjectToolDefinitionSnapshotError,
  ProjectToolDefinitionSnapshotConflictError,
} = require('../../packages/ql3-runtime-core/dist/tool-execution/tool-registry/projectToolDefinitionSnapshot');
const {
  createBuiltInTaskSpecSemanticRegistry,
} = require('../../packages/ql3-runtime-core/dist/task-definition/taskSpecSemantic');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
} = require('./pluginPackageTaskReconciliationRepositoryContract.cjs');

function snapshotFor(value) {
  return createProjectToolDefinitionSnapshot({
    projectId: value.projectId,
    contributions: [
      projectToolDefinitionSnapshotContribution(value.revision, value.registry),
    ],
  });
}

async function pendingProjectIds(repository) {
  const projects = [];
  let after;
  for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
    const page = await repository.listPendingProjectPage({
      limit: 64,
      ...(after ? { after } : {}),
    });
    projects.push(...page.projectIds);
    if (!page.truncated) return projects;
    after = page.next;
  }
  throw new Error('snapshot pending Project contract did not converge');
}

function registerProjectToolDefinitionSnapshotRepositoryContract(options) {
  test(`${options.name}: publishes and exactly replays an empty active vector`, async (t) => {
    const projectId = `${options.namespace}-empty`;
    const registry = createBuiltInTaskSpecSemanticRegistry();
    const harness = await options.createRepository(t, { projectId, registry });
    t.after(() => harness.close?.());
    const snapshot = createProjectToolDefinitionSnapshot({
      projectId,
      contributions: [],
    });

    assert.deepEqual(
      await harness.repository.listActiveSourcePage({
        projectId,
        limit: 1,
      }),
      { sources: [], truncated: false },
    );
    assert.equal(
      (await pendingProjectIds(harness.repository)).includes(projectId),
      true,
    );
    assert.equal(await harness.repository.findCurrent(projectId), null);
    const created = await harness.repository.publish(snapshot);
    assert.equal(created.status, 'created');
    assert.deepEqual(created.record.snapshot, snapshot);
    assert.ok(Number.isSafeInteger(created.record.committedAtMs));
    const replay = await harness.repository.publish(snapshot);
    assert.equal(replay.status, 'existing');
    assert.deepEqual(replay.record, created.record);
    assert.deepEqual(
      await harness.repository.findCurrent(projectId),
      created.record,
    );
    assert.equal(
      (await pendingProjectIds(harness.repository)).includes(projectId),
      false,
    );
  });

  test(`${options.name}: binds one active Package to its immutable revision`, async (t) => {
    const value = pluginPackageTaskReconciliationFixture(
      `${options.namespace}-active`,
      { profile: options.profile },
    );
    const harness = await options.createRepository(t, value);
    t.after(() => harness.close?.());
    await activateInstall(harness.installRepository, value);
    await harness.materializedRepository.publish(value.revision);
    const snapshot = snapshotFor(value);

    const sourcePage = await harness.repository.listActiveSourcePage({
      projectId: value.projectId,
      limit: 1,
    });
    assert.deepEqual(sourcePage, {
      sources: snapshot.sources,
      truncated: false,
    });
    assert.equal(
      (await pendingProjectIds(harness.repository)).includes(value.projectId),
      true,
    );
    const created = await harness.repository.publish(snapshot);
    assert.equal(created.status, 'created');
    assert.deepEqual(
      await harness.repository.findCurrent(value.projectId),
      created.record,
    );
    assert.deepEqual(created.record.snapshot.sources, [
      {
        installationId: value.install.active.installationId,
        packageName: value.packageName,
        generation: value.generation,
        generationDigest: value.revision.generation.generationDigest,
        lockDigest: value.lock.lockDigest,
        revisionDigest: value.revision.revisionDigest,
      },
    ]);
    assert.equal(
      (await pendingProjectIds(harness.repository)).includes(value.projectId),
      false,
    );
    await options.assertDurableSource?.(harness, value, created.record);
  });

  test(`${options.name}: keeps the old snapshot during staging and fails closed after activation`, async (t) => {
    const first = pluginPackageTaskReconciliationFixture(
      `${options.namespace}-upgrade`,
      { profile: options.profile },
    );
    const harness = await options.createRepository(t, first);
    t.after(() => harness.close?.());
    await activateInstall(harness.installRepository, first);
    await harness.materializedRepository.publish(first.revision);
    const firstSnapshot = snapshotFor(first);
    const firstRecord = (await harness.repository.publish(firstSnapshot))
      .record;

    const second = pluginPackageTaskReconciliationFixture(first.namespace, {
      profile: options.profile,
      previous: first,
      tasks: [['alpha', 'next']],
    });
    await harness.materializedRepository.publish(second.revision);
    await harness.installRepository.create(second.install.create);
    assert.deepEqual(
      await harness.repository.findCurrent(first.projectId),
      firstRecord,
    );
    await harness.installRepository.commit(second.install.commits[0]);
    await harness.installRepository.commit(second.install.commits[1]);
    assert.deepEqual(
      await harness.repository.findCurrent(first.projectId),
      firstRecord,
    );
    assert.deepEqual(
      (
        await harness.repository.listActiveSourcePage({
          projectId: first.projectId,
          limit: 1,
        })
      ).sources,
      firstRecord.snapshot.sources,
    );
    await harness.installRepository.commit(second.install.commits[2]);

    assert.equal(await harness.repository.findCurrent(first.projectId), null);
    assert.deepEqual(
      (
        await harness.repository.listActiveSourcePage({
          projectId: first.projectId,
          limit: 1,
        })
      ).sources,
      secondSnapshotSources(second),
    );
    assert.equal(
      (await pendingProjectIds(harness.repository)).includes(first.projectId),
      true,
    );
    await assert.rejects(
      harness.repository.publish(firstSnapshot),
      ProjectToolDefinitionSnapshotConflictError,
    );

    const secondSnapshot = snapshotFor(second);
    const secondRecord = (await harness.repository.publish(secondSnapshot))
      .record;
    assert.deepEqual(
      await harness.repository.findCurrent(first.projectId),
      secondRecord,
    );
    assert.notEqual(
      firstRecord.snapshot.activeVectorDigest,
      secondRecord.snapshot.activeVectorDigest,
    );
    assert.equal(
      (await pendingProjectIds(harness.repository)).includes(first.projectId),
      false,
    );
  });

  test(`${options.name}: rejects invalid Project identity`, async (t) => {
    const projectId = `${options.namespace}-invalid`;
    const registry = createBuiltInTaskSpecSemanticRegistry();
    const harness = await options.createRepository(t, { projectId, registry });
    t.after(() => harness.close?.());
    await assert.rejects(
      Promise.resolve().then(() =>
        harness.repository.findCurrent('project\0invalid'),
      ),
      InvalidProjectToolDefinitionSnapshotError,
    );
  });
}

function secondSnapshotSources(value) {
  return snapshotFor(value).sources;
}

module.exports = {
  registerProjectToolDefinitionSnapshotRepositoryContract,
  projectToolDefinitionSnapshotForFixture: snapshotFor,
};
