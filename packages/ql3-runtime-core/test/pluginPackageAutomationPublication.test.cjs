const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

const {
  assertPluginPackageAutomationPublicationSuccessor,
  createInitialPluginPackageAutomationPublication,
  createNextPluginPackageAutomationPublication,
  createPluginPackageAutomationLifecyclePublication,
  InvalidPluginPackageAutomationPublicationError,
  normalizePluginPackageAutomationPublication,
  PluginPackageAutomationPublicationConflictError,
  PluginPackageAutomationPublicationCoordinator,
  PluginPackageAutomationPublicationRecoveryCoordinator,
  PluginPackageAutomationPublicationUnavailableError,
  pluginPackageAutomationDefinitionsFromRevision,
  pluginPackageAutomationPublicationDigest,
} = require('../dist/plugin-package/pluginPackageAutomationPublication');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function automationFixture(namespace = 'automation-publication') {
  return pluginPackageTaskReconciliationFixture(namespace, {
    workflows: [
      {
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: 'daily',
        name: 'Daily workflow',
        enabled: true,
        steps: [
          {
            id: 'run',
            task: 'alpha',
            needs: [],
          },
        ],
      },
    ],
    prompts: [
      {
        schema: 'qinglong/plugin-package-prompt-resource@v1',
        id: 'greeting',
        name: 'Greeting prompt',
        template: 'Hello {{name}}',
        parameters: [
          {
            name: 'name',
            required: true,
          },
        ],
      },
    ],
  });
}

function automationCoordinatorAuthorities(
  namespace = 'automation-publication-coordinator',
) {
  const first = automationFixture(namespace);
  let generation = first.revision.generation;
  let head = null;
  let observations = 0;
  const revisions = new Map([
    [first.revision.generation.generationDigest, first.revision],
  ]);
  const publications = new Map();
  const generationSource = {
    async findActiveResourceGeneration() {
      observations += 1;
      return generation;
    },
  };
  const materializedRepository = {
    async find(generationDigest) {
      return revisions.get(generationDigest) ?? null;
    },
  };
  const repository = {
    async findCurrent() {
      return head;
    },
    async findByDigest(publicationDigest) {
      return publications.get(publicationDigest) ?? null;
    },
    async publish(publication) {
      const existing = publications.get(publication.publicationDigest);
      if (existing) return { status: 'existing', publication: existing };
      publications.set(publication.publicationDigest, publication);
      head = publication;
      return { status: 'created', publication };
    },
  };
  const coordinator = new PluginPackageAutomationPublicationCoordinator({
    generationSource,
    materializedRepository,
    repository,
    taskSpecSemanticRegistry: first.registry,
    now: () => 2_000 + observations,
  });
  return {
    first,
    coordinator,
    generationSource,
    materializedRepository,
    repository,
    revisions,
    get generation() {
      return generation;
    },
    set generation(value) {
      generation = value;
    },
    get head() {
      return head;
    },
  };
}

test('creates one deterministic publication for Workflow and Prompt definitions', () => {
  const value = automationFixture();
  const definitions = pluginPackageAutomationDefinitionsFromRevision(
    value.revision,
    value.registry,
  );
  assert.deepEqual(
    definitions.workflows.map(({ id }) => id),
    ['daily'],
  );
  assert.deepEqual(
    definitions.prompts.map(({ id }) => id),
    ['greeting'],
  );

  const publication = createInitialPluginPackageAutomationPublication(
    value.revision,
    value.registry,
    1_000,
  );
  assert.equal(publication.state, 'active');
  assert.equal(publication.version, 1);
  assert.equal(publication.previousPublicationDigest, null);
  assert.equal(publication.lifecycleEventDigest, null);
  assert.equal(
    publication.target.materializedRevisionDigest,
    value.revision.revisionDigest,
  );
  assert.equal(
    publication.publicationDigest,
    pluginPackageAutomationPublicationDigest(publication),
  );
  assert.deepEqual(
    normalizePluginPackageAutomationPublication(publication),
    publication,
  );
  assert.equal(
    createInitialPluginPackageAutomationPublication(
      value.revision,
      value.registry,
      1_000,
    ).publicationDigest,
    publication.publicationDigest,
  );
});

test('withdraws and restores the same immutable definitions through a digest chain', () => {
  const value = automationFixture('automation-lifecycle');
  const initial = createInitialPluginPackageAutomationPublication(
    value.revision,
    value.registry,
    1_000,
  );
  const disabledEventDigest = digest('disabled');
  const withdrawn = createPluginPackageAutomationLifecyclePublication({
    previous: initial,
    state: 'withdrawn',
    lifecycleEventDigest: disabledEventDigest,
    publishedAtMs: 1_001,
  });
  assert.equal(withdrawn.state, 'withdrawn');
  assert.equal(withdrawn.version, 2);
  assert.equal(
    withdrawn.previousPublicationDigest,
    initial.publicationDigest,
  );
  assert.equal(withdrawn.lifecycleEventDigest, disabledEventDigest);
  assert.deepEqual(withdrawn.definitions, initial.definitions);

  const enabledEventDigest = digest('enabled');
  const restored = createPluginPackageAutomationLifecyclePublication({
    previous: withdrawn,
    state: 'active',
    lifecycleEventDigest: enabledEventDigest,
    publishedAtMs: 1_002,
  });
  assert.equal(restored.state, 'active');
  assert.equal(restored.version, 3);
  assert.equal(
    restored.previousPublicationDigest,
    withdrawn.publicationDigest,
  );
  assert.equal(restored.lifecycleEventDigest, enabledEventDigest);
  assert.deepEqual(restored.definitions, initial.definitions);
});

test('replaces one active publication with the next materialized generation', () => {
  const first = automationFixture('automation-upgrade');
  const initial = createInitialPluginPackageAutomationPublication(
    first.revision,
    first.registry,
    1_000,
  );
  const second = pluginPackageTaskReconciliationFixture(first.namespace, {
    previous: first,
    tasks: [
      ['alpha', 'alpha-v2'],
      ['beta', 'beta'],
    ],
    workflows: [
      {
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: 'hourly',
        name: 'Hourly workflow',
        enabled: true,
        steps: [{ id: 'run', task: 'alpha', needs: [] }],
      },
    ],
    prompts: [
      {
        schema: 'qinglong/plugin-package-prompt-resource@v1',
        id: 'summary',
        name: 'Summary prompt',
        template: 'Summarize {{topic}}',
        parameters: [{ name: 'topic', required: true }],
      },
    ],
  });
  const next = createNextPluginPackageAutomationPublication(
    second.revision,
    second.registry,
    initial,
    1_100,
  );
  assert.equal(next.version, 2);
  assert.equal(next.state, 'active');
  assert.equal(next.lifecycleEventDigest, null);
  assert.equal(next.previousPublicationDigest, initial.publicationDigest);
  assert.equal(next.target.generation, 2);
  assert.deepEqual(
    next.definitions.workflows.map(({ id }) => id),
    ['hourly'],
  );
  assert.doesNotThrow(() =>
    assertPluginPackageAutomationPublicationSuccessor(initial, next),
  );
});

test('rejects tampering and invalid lifecycle transitions', () => {
  const value = automationFixture('automation-invalid');
  const initial = createInitialPluginPackageAutomationPublication(
    value.revision,
    value.registry,
    1_000,
  );
  assert.throws(
    () =>
      normalizePluginPackageAutomationPublication({
        ...initial,
        publishedAtMs: 1_001,
      }),
    /publicationDigest does not match publication/,
  );
  assert.throws(
    () =>
      createPluginPackageAutomationLifecyclePublication({
        previous: initial,
        state: 'active',
        lifecycleEventDigest: digest('same-state'),
        publishedAtMs: 1_001,
      }),
    /must toggle its state/,
  );
  assert.throws(
    () =>
      createPluginPackageAutomationLifecyclePublication({
        previous: initial,
        state: 'withdrawn',
        lifecycleEventDigest: digest('time-travel'),
        publishedAtMs: 999,
      }),
    /precedes the previous publication/,
  );
  assert.throws(
    () =>
      assertPluginPackageAutomationPublicationSuccessor(initial, {
        ...initial,
        version: 2,
        previousPublicationDigest: initial.publicationDigest,
        publicationDigest: pluginPackageAutomationPublicationDigest({
          ...initial,
          version: 2,
          previousPublicationDigest: initial.publicationDigest,
        }),
      }),
    /generation successor is invalid/,
  );
});

test('publishes an absent tombstone for a generation without automation', () => {
  const value = pluginPackageTaskReconciliationFixture('automation-empty');
  assert.equal(
    pluginPackageAutomationDefinitionsFromRevision(
      value.revision,
      value.registry,
    ),
    null,
  );
  const publication = createInitialPluginPackageAutomationPublication(
    value.revision,
    value.registry,
    1_000,
  );
  assert.equal(publication.state, 'absent');
  assert.equal(publication.version, 1);
  assert.deepEqual(publication.definitions, {
    workflows: [],
    prompts: [],
  });
  assert.throws(
    () =>
      createPluginPackageAutomationLifecyclePublication({
        previous: publication,
        state: 'active',
        lifecycleEventDigest: digest('invalid-absent-toggle'),
        publishedAtMs: 1_001,
      }),
    /must toggle its state/,
  );
});

test('chains active, absent and active across every Package generation', () => {
  const first = automationFixture('automation-tombstone-chain');
  const initial = createInitialPluginPackageAutomationPublication(
    first.revision,
    first.registry,
    1_000,
  );
  const second = pluginPackageTaskReconciliationFixture(first.namespace, {
    previous: first,
  });
  const absent = createNextPluginPackageAutomationPublication(
    second.revision,
    second.registry,
    initial,
    1_100,
  );
  assert.equal(absent.state, 'absent');
  assert.equal(absent.target.generation, 2);
  assert.deepEqual(absent.definitions, { workflows: [], prompts: [] });

  const third = pluginPackageTaskReconciliationFixture(first.namespace, {
    previous: second,
    workflows: [
      {
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: 'restored',
        name: 'Restored workflow',
        enabled: true,
        steps: [{ id: 'run', task: 'alpha', needs: [] }],
      },
    ],
  });
  const restored = createNextPluginPackageAutomationPublication(
    third.revision,
    third.registry,
    absent,
    1_200,
  );
  assert.equal(restored.state, 'active');
  assert.equal(restored.target.generation, 3);
  assert.equal(
    restored.previousPublicationDigest,
    absent.publicationDigest,
  );
  assert.deepEqual(
    restored.definitions.workflows.map(({ id }) => id),
    ['restored'],
  );
});

test('coordinator publishes each materialized generation and preserves lifecycle state on replay', async () => {
  const value = automationCoordinatorAuthorities();
  const initial = await value.coordinator.publishActive(
    value.first.projectId,
    value.first.packageName,
  );
  assert.equal(initial.status, 'current');
  assert.equal(initial.publication, 'created');
  assert.equal(initial.record.state, 'active');

  const withdrawn = createPluginPackageAutomationLifecyclePublication({
    previous: initial.record,
    state: 'withdrawn',
    lifecycleEventDigest: digest('coordinator-disabled'),
    publishedAtMs: 2_100,
  });
  await value.repository.publish(withdrawn);
  const replay = await value.coordinator.publishActive(
    value.first.projectId,
    value.first.packageName,
  );
  assert.equal(replay.status, 'current');
  assert.equal(replay.publication, 'existing');
  assert.equal(replay.record.state, 'withdrawn');

  const empty = pluginPackageTaskReconciliationFixture(value.first.namespace, {
    previous: value.first,
  });
  value.revisions.set(
    empty.revision.generation.generationDigest,
    empty.revision,
  );
  value.generation = empty.revision.generation;
  const tombstone = await value.coordinator.publishActive(
    value.first.projectId,
    value.first.packageName,
  );
  assert.equal(tombstone.status, 'current');
  assert.equal(tombstone.record.state, 'absent');
  assert.equal(tombstone.record.version, 3);
  assert.deepEqual(tombstone.record.definitions, {
    workflows: [],
    prompts: [],
  });
});

test('coordinator treats a final generation switch as superseded', async () => {
  const value = automationCoordinatorAuthorities(
    'automation-publication-superseded',
  );
  let observations = 0;
  const source = {
    async findActiveResourceGeneration() {
      observations += 1;
      return observations === 1 ? value.generation : null;
    },
  };
  const coordinator = new PluginPackageAutomationPublicationCoordinator({
    generationSource: source,
    materializedRepository: value.materializedRepository,
    repository: value.repository,
    taskSpecSemanticRegistry: value.first.registry,
    now: () => 3_000,
  });
  assert.deepEqual(
    await coordinator.publishActive(
      value.first.projectId,
      value.first.packageName,
    ),
    {
      status: 'superseded',
      generationDigest:
        value.first.revision.generation.generationDigest,
    },
  );
});

test('bounded automation recovery converges and classifies manual and retry failures', async () => {
  const value = automationCoordinatorAuthorities(
    'automation-publication-recovery',
  );
  let pending = [
    {
      projectId: value.first.projectId,
      packageName: value.first.packageName,
    },
  ];
  const source = {
    async listPendingPage({ limit }) {
      return {
        candidates: pending.slice(0, limit),
        truncated: false,
      };
    },
  };
  const publisher = Object.create(
    PluginPackageAutomationPublicationCoordinator.prototype,
  );
  publisher.publishActive = async (projectId, packageName) => {
    const result = await value.coordinator.publishActive(
      projectId,
      packageName,
    );
    if (result.status === 'current') pending = [];
    return result;
  };
  const recovery =
    new PluginPackageAutomationPublicationRecoveryCoordinator({
      source,
      publisher,
    });
  assert.deepEqual(
    await recovery.recover({ pageSize: 1, maxPages: 1 }),
    {
      pages: 1,
      scanned: 1,
      settled: 1,
      retry: 0,
      manualRequired: 0,
      superseded: 0,
      remaining: false,
      safeToAdmit: true,
    },
  );

  const failures = Object.create(
    PluginPackageAutomationPublicationCoordinator.prototype,
  );
  failures.publishActive = async (_projectId, packageName) => {
    if (packageName === 'manual') {
      throw new PluginPackageAutomationPublicationConflictError('conflict');
    }
    throw new PluginPackageAutomationPublicationUnavailableError();
  };
  const failedRecovery =
    new PluginPackageAutomationPublicationRecoveryCoordinator({
      source: {
        async listPendingPage({ limit }) {
          const candidates = [
            { projectId: value.first.projectId, packageName: 'manual' },
            { projectId: value.first.projectId, packageName: 'retry' },
          ].slice(0, limit);
          const truncated = limit < 2;
          const last = candidates.at(-1);
          return {
            candidates,
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
      publisher: failures,
    });
  const result = await failedRecovery.recover({
    pageSize: 2,
    maxPages: 1,
  });
  assert.equal(result.manualRequired, 1);
  assert.equal(result.retry, 1);
  assert.equal(result.remaining, true);
  assert.equal(result.safeToAdmit, false);
  await assert.rejects(
    () => failedRecovery.recover({ pageSize: 0 }),
    InvalidPluginPackageAutomationPublicationError,
  );
});
