const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runtimeModuleGraph,
  moduleCycles,
} = require('../helpers/runtime-module-graph.cjs');
const graph = runtimeModuleGraph('back');

test('cron and shared libraries do not import service implementations or the orphan reporter', () => {
  for (const [file, dependencies] of graph) {
    if (
      !/^back\/(cron|shared)\//.test(file) ||
      file === 'back/shared/managedExit.cjs'
    )
      continue;
    for (const dependency of dependencies) {
      assert.ok(
        !dependency.startsWith('back/services/'),
        file + ' -> ' + dependency,
      );
      assert.notEqual(dependency, 'back/shared/managedExit.cjs', file);
      if (file.startsWith('back/shared/'))
        assert.ok(
          !dependency.startsWith('back/cron/'),
          file + ' -> ' + dependency,
        );
    }
  }
});

test('runtime imports involving cron, services and shared have no circular dependency', () => {
  const cycles = moduleCycles(graph).filter((cycle) =>
    cycle.some((file) => /^back\/(cron|services|shared)\//.test(file)),
  );
  assert.deepEqual(cycles, []);
});

test('receipt storage and schema installation do not load the execution coordinator', () => {
  assert.deepEqual([...graph.get('back/cron/settlement/exitReceipt.cjs')], []);
  assert.deepEqual([...graph.get('back/cron/schema.ts')], []);
  assert.ok(
    graph.get('back/data/schemaMigrations.ts').has('back/cron/schema.ts'),
  );
  assert.ok(
    !graph.get('back/data/schemaMigrations.ts').has('back/cron/history.ts'),
  );
});
