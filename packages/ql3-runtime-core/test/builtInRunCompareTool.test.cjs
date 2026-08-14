const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  BUILTIN_RUN_COMPARE_ADAPTER,
  BUILTIN_RUN_COMPARE_TOOL,
  BUILTIN_RUN_COMPARE_TOOL_DEFINITION,
  BuiltInRunCompareToolAdapter,
  BuiltInRunCompareToolUnavailableError,
  InvalidBuiltInRunCompareToolError,
  createBuiltInRunCompareToolHandlerBinding,
  executeBuiltInRunCompareTool,
} = require('../dist/tool-execution/builtin-run-compare/builtInRunCompareTool');
const {
  createPluginPackageResourceGenerationFromReferences,
} = require('../dist/plugin-package/pluginPackageResourceGeneration');
const {
  createProjectToolDefinitionSnapshot,
  projectToolDefinitionRegistry,
} = require('../dist/tool-execution/tool-registry/projectToolDefinitionSnapshot');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

function run(id, overrides = {}) {
  return {
    id,
    projectId: 'project-compare',
    taskId: 'task-backup',
    taskRevision: 'task-backup@4',
    triggerType: 'schedule',
    executionOrigin: 'scheduled_system',
    executionOwner: 'runtime',
    status: 'succeeded',
    version: 4,
    eventSequence: 8,
    priority: 10,
    createdAtMs: 1_000,
    queuedAtMs: 1_020,
    startedAtMs: 1_050,
    finishedAtMs: 1_150,
    requestId: 'must-not-cross-tool-output',
    inputRef: 'artifact:must-not-cross-tool-output',
    ...overrides,
  };
}

function repository(records, calls = []) {
  return {
    async findRunById(runId) {
      calls.push(runId);
      return records.get(runId) ?? null;
    },
  };
}

function snapshot(definition = BUILTIN_RUN_COMPARE_TOOL_DEFINITION) {
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'install-qinglong-compare',
    projectId: 'project-compare',
    packageName: 'qinglong',
    lockDigest: DIGEST_A,
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: DIGEST_B,
    resources: [],
  });
  return createProjectToolDefinitionSnapshot({
    projectId: 'project-compare',
    contributions: [
      {
        generation,
        revisionDigest: DIGEST_C,
        definitions: [definition],
      },
    ],
  });
}

test('compares two ordered Project-scoped Run point reads with bounded deltas', async () => {
  const calls = [];
  const baseline = run('run-success');
  const candidate = run('run-failure', {
    taskRevision: 'task-backup@5',
    status: 'failed',
    version: 6,
    eventSequence: 12,
    createdAtMs: 2_000,
    queuedAtMs: 2_040,
    startedAtMs: 2_100,
    finishedAtMs: 2_350,
    requestId: 'must-also-not-cross-tool-output',
  });
  const output = await executeBuiltInRunCompareTool(
    repository(
      new Map([
        [baseline.id, baseline],
        [candidate.id, candidate],
      ]),
      calls,
    ),
    'project-compare',
    { baselineRunId: baseline.id, candidateRunId: candidate.id },
  );

  assert.deepEqual(calls, ['run-success', 'run-failure']);
  assert.equal(output.comparable, true);
  assert.equal(output.sameTask, true);
  assert.equal(output.sameTaskRevision, false);
  assert.deepEqual(output.changedFields, ['taskRevision', 'status']);
  assert.equal(Object.isFrozen(output.changedFields), true);
  assert.equal(output.queueDelayDeltaMs, 20);
  assert.equal(output.executionDurationDeltaMs, 150);
  assert.equal(output.totalDurationDeltaMs, 200);
  assert.equal(output.consistency, 'ordered_independent_point_reads');
  assert.equal(output.baseline.requestId, undefined);
  assert.equal(output.candidate.inputRef, undefined);

  const registry = projectToolDefinitionRegistry(snapshot());
  assert.deepEqual(
    registry.normalizeOutput(
      BUILTIN_RUN_COMPARE_TOOL.name,
      BUILTIN_RUN_COMPARE_TOOL.version,
      output,
    ),
    output,
  );
});

test('does not compare an absent or cross-Project Run and omits duration claims', async () => {
  const output = await executeBuiltInRunCompareTool(
    repository(
      new Map([
        ['run-visible', run('run-visible')],
        [
          'run-foreign',
          run('run-foreign', { projectId: 'project-someone-else' }),
        ],
      ]),
    ),
    'project-compare',
    { baselineRunId: 'run-visible', candidateRunId: 'run-foreign' },
  );

  assert.equal(output.baseline.found, true);
  assert.deepEqual(output.candidate, { found: false });
  assert.equal(output.comparable, false);
  assert.equal(output.sameTask, false);
  assert.equal(output.sameTaskRevision, false);
  assert.deepEqual(output.changedFields, []);
  assert.equal(output.queueDelayDeltaMs, undefined);
  assert.equal(output.executionDurationDeltaMs, undefined);
  assert.equal(output.totalDurationDeltaMs, undefined);

  const invalidTimeline = await executeBuiltInRunCompareTool(
    repository(
      new Map([
        ['run-baseline', run('run-baseline')],
        [
          'run-reversed',
          run('run-reversed', { startedAtMs: 3_000, finishedAtMs: 2_900 }),
        ],
      ]),
    ),
    'project-compare',
    { baselineRunId: 'run-baseline', candidateRunId: 'run-reversed' },
  );
  assert.equal(invalidTimeline.comparable, true);
  assert.equal(invalidTimeline.executionDurationDeltaMs, undefined);
});

test('rejects aliases, unknown input, malformed records, and repository failure', async () => {
  const runs = repository(new Map());
  await assert.rejects(
    executeBuiltInRunCompareTool(runs, 'project-compare', {
      baselineRunId: 'same-run',
      candidateRunId: 'same-run',
    }),
    InvalidBuiltInRunCompareToolError,
  );
  await assert.rejects(
    executeBuiltInRunCompareTool(runs, 'project-compare', {
      baselineRunId: 'run-a',
      candidateRunId: 'run-b',
      injected: true,
    }),
    InvalidBuiltInRunCompareToolError,
  );
  await assert.rejects(
    executeBuiltInRunCompareTool(
      repository(
        new Map([
          ['run-a', run('run-a')],
          ['run-b', run('run-b', { version: -1 })],
        ]),
      ),
      'project-compare',
      { baselineRunId: 'run-a', candidateRunId: 'run-b' },
    ),
    BuiltInRunCompareToolUnavailableError,
  );
  await assert.rejects(
    executeBuiltInRunCompareTool(
      {
        async findRunById() {
          throw new Error('database DSN must not escape');
        },
      },
      'project-compare',
      { baselineRunId: 'run-a', candidateRunId: 'run-b' },
    ),
    BuiltInRunCompareToolUnavailableError,
  );
});

test('binds the exact reviewed definition to a retry-safe database-read adapter', async () => {
  const currentSnapshot = snapshot();
  const binding = createBuiltInRunCompareToolHandlerBinding(currentSnapshot, [
    'edge',
    'standalone',
    'cluster-control',
  ]);
  assert.deepEqual(binding.tool, BUILTIN_RUN_COMPARE_TOOL);
  assert.deepEqual(binding.adapter, BUILTIN_RUN_COMPARE_ADAPTER);
  assert.deepEqual(binding.authorities, ['database.read']);

  const definitions = projectToolDefinitionRegistry(currentSnapshot);
  const adapter = new BuiltInRunCompareToolAdapter(
    binding,
    'edge',
    definitions,
    repository(
      new Map([
        ['run-a', run('run-a')],
        ['run-b', run('run-b', { status: 'failed' })],
      ]),
    ),
  );
  assert.equal(adapter.recoveryMode, 'retry_safe_read');
  const output = await adapter.execute(
    { projectId: 'project-compare' },
    { baselineRunId: 'run-a', candidateRunId: 'run-b' },
  );
  assert.deepEqual(output.changedFields, ['status']);

  const changed = {
    ...BUILTIN_RUN_COMPARE_TOOL_DEFINITION,
    description: 'unreviewed changed definition',
  };
  assert.throws(
    () =>
      createBuiltInRunCompareToolHandlerBinding(snapshot(changed), ['edge']),
    InvalidBuiltInRunCompareToolError,
  );
  assert.throws(
    () =>
      new BuiltInRunCompareToolAdapter(
        { ...binding, authorities: ['database.read', 'network.client'] },
        'edge',
        definitions,
        repository(new Map()),
      ),
    /handler authority is invalid/,
  );
});

test('publishes only explicit compare subpaths and keeps runtime-core root unchanged', () => {
  const tool = require('@qinglong/runtime-core/builtin-run-compare-tool');
  const projection = require('@qinglong/runtime-core/builtin-run-compare-projection');
  const root = require('@qinglong/runtime-core');

  assert.equal(tool.BUILTIN_RUN_COMPARE_TOOL.name, 'qinglong.run.compare');
  assert.equal(
    projection.BUILTIN_RUN_COMPARE_TOOL.name,
    'qinglong.run.compare',
  );
  assert.equal(root.BUILTIN_RUN_COMPARE_TOOL, undefined);
  assert.equal(root.executeBuiltInRunCompareTool, undefined);
});
