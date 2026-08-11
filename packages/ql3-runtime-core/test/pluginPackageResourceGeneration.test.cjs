const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidPluginPackageResourceGenerationError,
  PLUGIN_PACKAGE_RESOURCE_GENERATION_SCHEMA,
  createPluginPackageResourceGeneration,
  createPluginPackageResourceGenerationFromReferences,
  normalizePluginPackageResourceGeneration,
  pluginPackageResourceReferencesFromContents,
} = require('../dist/plugin-package/pluginPackageResourceGeneration');

const LOCK_DIGEST = 'a'.repeat(64);
const CONTENT_DIGEST = 'b'.repeat(64);

function input(overrides = {}) {
  return {
    installationId: 'install-001',
    projectId: 'default',
    packageName: 'example-monitor',
    lockDigest: LOCK_DIGEST,
    generation: 2,
    previousActiveLockDigest: 'c'.repeat(64),
    contentDigest: CONTENT_DIGEST,
    contents: {
      tasks: ['tasks/z.yaml', 'tasks/a.yaml'],
      workflows: ['workflows/daily.yaml'],
      prompts: ['prompts/report.md'],
      tools: ['tools/notify.json'],
    },
    ...overrides,
  };
}

test('creates one canonical bounded resource generation from manifest contents', () => {
  const generation = createPluginPackageResourceGeneration(input());
  assert.equal(generation.schema, PLUGIN_PACKAGE_RESOURCE_GENERATION_SCHEMA);
  assert.deepEqual(generation.resources, [
    { kind: 'prompt', path: 'prompts/report.md' },
    { kind: 'task', path: 'tasks/a.yaml' },
    { kind: 'task', path: 'tasks/z.yaml' },
    { kind: 'tool', path: 'tools/notify.json' },
    { kind: 'workflow', path: 'workflows/daily.yaml' },
  ]);
  assert.match(generation.generationDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(generation), true);
  assert.equal(Object.isFrozen(generation.resources), true);
  assert.equal(Object.isFrozen(generation.resources[0]), true);
  assert.deepEqual(
    normalizePluginPackageResourceGeneration(generation),
    generation,
  );
});

test('reconstructs the same generation from an immutable lock snapshot', () => {
  const fromContents = createPluginPackageResourceGeneration(input());
  const fromReferences = createPluginPackageResourceGenerationFromReferences({
    installationId: fromContents.installationId,
    projectId: fromContents.projectId,
    packageName: fromContents.packageName,
    lockDigest: fromContents.lockDigest,
    generation: fromContents.generation,
    previousActiveLockDigest: fromContents.previousActiveLockDigest,
    contentDigest: fromContents.contentDigest,
    resources: fromContents.resources,
  });
  assert.deepEqual(fromReferences, fromContents);
  assert.deepEqual(
    pluginPackageResourceReferencesFromContents(input().contents),
    fromContents.resources,
  );
});

test('fails closed on identity, order, path and digest drift', () => {
  const generation = createPluginPackageResourceGeneration(input());
  assert.throws(
    () =>
      normalizePluginPackageResourceGeneration({
        ...generation,
        projectId: 'other',
      }),
    /generation digest does not match/,
  );
  assert.throws(
    () =>
      createPluginPackageResourceGenerationFromReferences({
        ...input(),
        contents: undefined,
        resources: [...generation.resources].reverse(),
      }),
    InvalidPluginPackageResourceGenerationError,
  );
  assert.throws(
    () =>
      createPluginPackageResourceGeneration(
        input({
          contents: {
            tasks: [`tasks/${'x'.repeat(250)}`],
            workflows: [],
            prompts: [],
            tools: [],
          },
        }),
      ),
    /resource path is invalid/,
  );
  assert.throws(
    () =>
      normalizePluginPackageResourceGeneration({
        ...generation,
        generationDigest: 'f'.repeat(64),
      }),
    /generation digest does not match/,
  );
});

test('enforces the shared 256-resource budget and rejects duplicates', () => {
  const tasks = Array.from(
    { length: 256 },
    (_, index) => `tasks/${String(index).padStart(3, '0')}.yaml`,
  );
  const maximum = createPluginPackageResourceGeneration(
    input({
      generation: 1,
      previousActiveLockDigest: null,
      contents: { tasks, workflows: [], prompts: [], tools: [] },
    }),
  );
  assert.equal(maximum.resources.length, 256);
  assert.throws(
    () =>
      createPluginPackageResourceGeneration(
        input({
          contents: {
            tasks: [...tasks, 'tasks/overflow.yaml'],
            workflows: [],
            prompts: [],
            tools: [],
          },
        }),
      ),
    /task contents is invalid/,
  );
  assert.throws(
    () =>
      createPluginPackageResourceGeneration(
        input({
          contents: {
            tasks: ['tasks/duplicate.yaml', 'tasks/duplicate.yaml'],
            workflows: [],
            prompts: [],
            tools: [],
          },
        }),
      ),
    /resource path is duplicated/,
  );
  const sparse = new Array(1);
  assert.throws(
    () =>
      createPluginPackageResourceGeneration(
        input({
          contents: {
            tasks: sparse,
            workflows: [],
            prompts: [],
            tools: [],
          },
        }),
      ),
    /dense data array/,
  );
});

test('publishes generation authority only through its explicit subpath', () => {
  assert.equal(
    require('../dist').createPluginPackageResourceGeneration,
    undefined,
  );
  assert.equal(
    require('@qinglong/runtime-core/plugin-package-resource-generation')
      .createPluginPackageResourceGeneration,
    createPluginPackageResourceGeneration,
  );
});
