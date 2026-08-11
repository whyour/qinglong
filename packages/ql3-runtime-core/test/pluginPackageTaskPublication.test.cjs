const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidPluginPackageTaskPublicationError,
  PluginPackageTaskPublicationConflictError,
  PluginPackageTaskPublicationCoordinator,
  PluginPackageTaskPublicationRecoveryCoordinator,
  PluginPackageTaskPublicationUnavailableError,
} = require('../dist/plugin-package/pluginPackageTaskPublication');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');

function authorities(namespace) {
  const fixture = pluginPackageTaskReconciliationFixture(namespace);
  let generation = fixture.revision.generation;
  let durableRevision = null;
  let durableReceipt = null;
  let openCount = 0;
  const bytesByPath = new Map([
    ['package.json', fixture.manifestBytes],
    ...fixture.resourceEntries.map(({ reference, bytes }) => [
      reference.path,
      bytes,
    ]),
  ]);
  const generationSource = {
    async findActiveResourceGeneration() {
      return generation;
    },
  };
  const materializedRepository = {
    async find(digest) {
      return durableRevision?.generation.generationDigest === digest
        ? durableRevision
        : null;
    },
    async publish(revision) {
      const status = durableRevision === null ? 'created' : 'existing';
      durableRevision ??= revision;
      return { status, revision: durableRevision };
    },
  };
  const reconciliationRepository = {
    async find(digest) {
      return durableReceipt?.generationDigest === digest ? durableReceipt : null;
    },
    async reconcile(revision) {
      const status = durableReceipt === null ? 'created' : 'existing';
      durableReceipt ??= Object.freeze({
        schema: 'qinglong/plugin-package-task-reconciliation@v1',
        projectId: revision.generation.projectId,
        packageName: revision.generation.packageName,
        generation: revision.generation.generation,
        generationDigest: revision.generation.generationDigest,
        materializedRevisionDigest: revision.revisionDigest,
        lockDigest: revision.generation.lockDigest,
        previousLockDigest: revision.generation.previousActiveLockDigest,
        committedAtMs: 1,
        items: Object.freeze([]),
        receiptDigest: 'a'.repeat(64),
      });
      return { status, receipt: durableReceipt };
    },
  };
  const coordinator = new PluginPackageTaskPublicationCoordinator({
    generationSource,
    lockSource: {
      async findLock(digest) {
        return digest === fixture.lock.lockDigest ? fixture.lock : null;
      },
    },
    byteSource: {
      async open() {
        openCount += 1;
        let closed = false;
        return {
          async read(path, maximumBytes) {
            assert.equal(closed, false);
            const value = bytesByPath.get(path);
            assert.ok(value);
            assert.ok(value.byteLength <= maximumBytes);
            return value;
          },
          close() {
            closed = true;
          },
        };
      },
    },
    materializedRepository,
    reconciliationRepository,
    taskSpecSemanticRegistry: fixture.registry,
  });
  return {
    fixture,
    coordinator,
    materializedRepository,
    reconciliationRepository,
    get generation() {
      return generation;
    },
    set generation(value) {
      generation = value;
    },
    get openCount() {
      return openCount;
    },
  };
}

test('materializes, durably publishes and reconciles one active generation', async () => {
  const value = authorities('task-publication-create');
  const created = await value.coordinator.publishActive(
    value.fixture.projectId,
    value.fixture.packageName,
  );
  assert.equal(created.status, 'current');
  assert.equal(created.materialized, 'created');
  assert.equal(created.reconciled, 'created');
  assert.equal(value.openCount, 1);

  const replay = await value.coordinator.publishActive(
    value.fixture.projectId,
    value.fixture.packageName,
  );
  assert.equal(replay.status, 'current');
  assert.equal(replay.materialized, 'existing');
  assert.equal(replay.reconciled, 'existing');
  assert.equal(value.openCount, 1);
});

test('reports a final generation switch without treating the old receipt as current', async () => {
  const value = authorities('task-publication-switch');
  let observations = 0;
  const original =
    value.coordinator;
  const source = {
    async findActiveResourceGeneration() {
      observations += 1;
      return observations < 4 ? value.generation : null;
    },
  };
  const switched = new PluginPackageTaskPublicationCoordinator({
    generationSource: source,
    lockSource: {
      async findLock() {
        return value.fixture.lock;
      },
    },
    byteSource: {
      async open() {
        return {
          async read(path) {
            if (path === 'package.json') return value.fixture.manifestBytes;
            return value.fixture.resourceEntries.find(
              ({ reference }) => reference.path === path,
            ).bytes;
          },
          close() {},
        };
      },
    },
    materializedRepository: value.materializedRepository,
    reconciliationRepository: value.reconciliationRepository,
    taskSpecSemanticRegistry: value.fixture.registry,
  });
  assert.ok(original);
  assert.deepEqual(
    await switched.publishActive(
      value.fixture.projectId,
      value.fixture.packageName,
    ),
    {
      status: 'superseded',
      generationDigest: value.fixture.revision.generation.generationDigest,
    },
  );
});

test('bounded recovery converges pending candidates and probes from the start', async () => {
  const value = authorities('task-publication-recovery');
  let pending = [
    {
      projectId: value.fixture.projectId,
      packageName: value.fixture.packageName,
    },
  ];
  const source = {
    async listPendingPage({ limit, after }) {
      const candidates = pending
        .filter(
          (candidate) =>
            !after ||
            candidate.projectId > after.projectId ||
            (candidate.projectId === after.projectId &&
              candidate.packageName > after.packageName),
        )
        .slice(0, limit);
      return { candidates, truncated: false };
    },
  };
  const publisher = {
    async publishActive(projectId, packageName) {
      const result = await value.coordinator.publishActive(projectId, packageName);
      if (result.status === 'current') pending = [];
      return result;
    },
  };
  Object.setPrototypeOf(
    publisher,
    Object.getPrototypeOf(value.coordinator),
  );
  const recovery = new PluginPackageTaskPublicationRecoveryCoordinator({
    source,
    publisher,
  });
  assert.deepEqual(await recovery.recover({ pageSize: 1, maxPages: 1 }), {
    pages: 1,
    scanned: 1,
    settled: 1,
    retry: 0,
    manualRequired: 0,
    superseded: 0,
    remaining: false,
    safeToAdmit: true,
  });
});

test('recovery keeps conflicts manual and availability failures retryable', async () => {
  const fixture = pluginPackageTaskReconciliationFixture(
    'task-publication-errors',
  );
  const candidates = [
    { projectId: fixture.projectId, packageName: fixture.packageName },
    { projectId: fixture.projectId, packageName: 'package-z-retry' },
  ];
  const publisher = Object.create(
    PluginPackageTaskPublicationCoordinator.prototype,
  );
  publisher.publishActive = async (_projectId, packageName) => {
    if (packageName === fixture.packageName) {
      throw new PluginPackageTaskPublicationConflictError('conflict');
    }
    throw new PluginPackageTaskPublicationUnavailableError();
  };
  const recovery = new PluginPackageTaskPublicationRecoveryCoordinator({
    source: {
      async listPendingPage({ limit }) {
        const page = candidates.slice(0, limit);
        const truncated = candidates.length > limit;
        const last = page.at(-1);
        return {
          candidates: page,
          truncated,
          ...(truncated
            ? {
                next: {
                  projectId: last.projectId,
                  packageName: last.packageName,
                },
              }
            : {}),
        };
      },
    },
    publisher,
  });
  const result = await recovery.recover({ pageSize: 2, maxPages: 1 });
  assert.equal(result.manualRequired, 1);
  assert.equal(result.retry, 1);
  assert.equal(result.remaining, true);
  assert.equal(result.safeToAdmit, false);
  await assert.rejects(
    () => recovery.recover({ pageSize: 0 }),
    InvalidPluginPackageTaskPublicationError,
  );
});
