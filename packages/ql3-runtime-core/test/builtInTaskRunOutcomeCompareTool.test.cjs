const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  BUILTIN_TASK_RUN_OUTCOME_COMPARE_ADAPTER,
  BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL,
  BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL_DEFINITION,
  BuiltInTaskRunOutcomeCompareToolAdapter,
  BuiltInTaskRunOutcomeCompareToolUnavailableError,
  InvalidBuiltInTaskRunOutcomeCompareToolError,
  TASK_RUN_OUTCOME_SEARCH_LIMIT,
  createBuiltInTaskRunOutcomeCompareToolHandlerBinding,
  executeBuiltInTaskRunOutcomeCompareTool,
} = require('../dist/tool-execution/builtin-run-compare/builtInTaskRunOutcomeCompareTool');
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
    projectId: 'project-outcomes',
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
    ...overrides,
  };
}

function windowRecord(value) {
  return {
    id: value.id,
    projectId: value.projectId,
    taskId: value.taskId,
    status: value.status,
    createdAtMs: value.createdAtMs,
  };
}

function fixture(records, window, calls = []) {
  return {
    windows: {
      async listRecentRunsByTask(query) {
        calls.push({ type: 'window', query });
        return window;
      },
    },
    runs: {
      async findRunById(runId) {
        calls.push({ type: 'point', runId });
        return records.get(runId) ?? null;
      },
    },
  };
}

function snapshot(
  definition = BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL_DEFINITION,
) {
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'install-qinglong-outcome-compare',
    projectId: 'project-outcomes',
    packageName: 'qinglong',
    lockDigest: DIGEST_A,
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: DIGEST_B,
    resources: [],
  });
  return createProjectToolDefinitionSnapshot({
    projectId: 'project-outcomes',
    contributions: [
      {
        generation,
        revisionDigest: DIGEST_C,
        definitions: [definition],
      },
    ],
  });
}

test('selects and compares the latest succeeded and failed Runs in one fixed Task window', async () => {
  const calls = [];
  const succeeded = run('run-success');
  const failed = run('run-failure', {
    taskRevision: 'task-backup@5',
    status: 'failed',
    version: 6,
    eventSequence: 12,
    createdAtMs: 2_000,
    queuedAtMs: 2_040,
    startedAtMs: 2_100,
    finishedAtMs: 2_350,
  });
  const ignored = run('run-running', {
    status: 'running',
    createdAtMs: 3_000,
  });
  const value = fixture(
    new Map([
      [succeeded.id, succeeded],
      [failed.id, failed],
    ]),
    [windowRecord(ignored), windowRecord(failed), windowRecord(succeeded)],
    calls,
  );
  const output = await executeBuiltInTaskRunOutcomeCompareTool(
    value.windows,
    value.runs,
    'project-outcomes',
    { taskId: 'task-backup' },
  );

  assert.deepEqual(calls, [
    {
      type: 'window',
      query: {
        projectId: 'project-outcomes',
        taskId: 'task-backup',
        limit: 65,
      },
    },
    { type: 'point', runId: 'run-success' },
    { type: 'point', runId: 'run-failure' },
  ]);
  assert.equal(output.taskId, 'task-backup');
  assert.equal(output.baselineOutcome, 'succeeded');
  assert.equal(output.candidateOutcome, 'failed');
  assert.equal(output.baseline.id, 'run-success');
  assert.equal(output.candidate.id, 'run-failure');
  assert.deepEqual(output.changedFields, ['taskRevision', 'status']);
  assert.equal(output.queueDelayDeltaMs, 20);
  assert.equal(output.executionDurationDeltaMs, 150);
  assert.equal(output.totalDurationDeltaMs, 200);
  assert.deepEqual(output.selection, {
    windowLimit: 64,
    searchedRunCount: 3,
    hasOlderRuns: false,
    complete: true,
    order: 'created_at_desc_id_desc',
  });
  assert.equal(
    output.consistency,
    'bounded_task_window_then_ordered_point_reads',
  );
  assert.equal(output.baseline.requestId, undefined);

  const registry = projectToolDefinitionRegistry(snapshot());
  assert.deepEqual(
    registry.normalizeOutput(
      BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL.name,
      BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL.version,
      output,
    ),
    output,
  );
});

test('reports an incomplete fixed window without exposing pagination', async () => {
  const calls = [];
  const rows = Array.from(
    { length: TASK_RUN_OUTCOME_SEARCH_LIMIT + 1 },
    (_, index) =>
      windowRecord(
        run(`run-${String(100 - index).padStart(3, '0')}`, {
          status: 'running',
          createdAtMs: 10_000 - index,
        }),
      ),
  );
  const value = fixture(new Map(), rows, calls);
  const output = await executeBuiltInTaskRunOutcomeCompareTool(
    value.windows,
    value.runs,
    'project-outcomes',
    { taskId: 'task-backup' },
  );

  assert.deepEqual(output.baseline, { found: false });
  assert.deepEqual(output.candidate, { found: false });
  assert.equal(output.comparable, false);
  assert.deepEqual(output.selection, {
    windowLimit: 64,
    searchedRunCount: 64,
    hasOlderRuns: true,
    complete: false,
    order: 'created_at_desc_id_desc',
  });
  assert.equal(calls.length, 1);
  assert.equal(
    BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL_DEFINITION.inputSchema.properties
      .after,
    undefined,
  );
  assert.equal(
    BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL_DEFINITION.inputSchema.properties
      .limit,
    undefined,
  );
});

test('fails closed on foreign, unordered, corrupt, disappearing, and unavailable records', async () => {
  const valid = windowRecord(run('run-valid'));
  for (const window of [
    [{ ...valid, projectId: 'other-project' }],
    [valid, { ...valid, id: 'run-newer', createdAtMs: 2_000 }],
    [{ ...valid, status: 'invented' }],
  ]) {
    const value = fixture(new Map(), window);
    await assert.rejects(
      executeBuiltInTaskRunOutcomeCompareTool(
        value.windows,
        value.runs,
        'project-outcomes',
        { taskId: 'task-backup' },
      ),
      BuiltInTaskRunOutcomeCompareToolUnavailableError,
    );
  }

  const missing = fixture(new Map(), [valid]);
  await assert.rejects(
    executeBuiltInTaskRunOutcomeCompareTool(
      missing.windows,
      missing.runs,
      'project-outcomes',
      { taskId: 'task-backup' },
    ),
    BuiltInTaskRunOutcomeCompareToolUnavailableError,
  );

  await assert.rejects(
    executeBuiltInTaskRunOutcomeCompareTool(
      {
        async listRecentRunsByTask() {
          throw new Error('private DSN must not escape');
        },
      },
      fixture(new Map(), []).runs,
      'project-outcomes',
      { taskId: 'task-backup' },
    ),
    BuiltInTaskRunOutcomeCompareToolUnavailableError,
  );
});

test('rejects aliases and binds the reviewed retry-safe database-read adapter', async () => {
  const empty = fixture(new Map(), []);
  await assert.rejects(
    executeBuiltInTaskRunOutcomeCompareTool(
      empty.windows,
      empty.runs,
      'project-outcomes',
      { taskId: 'task-backup', after: 'cursor' },
    ),
    InvalidBuiltInTaskRunOutcomeCompareToolError,
  );

  const currentSnapshot = snapshot();
  const binding = createBuiltInTaskRunOutcomeCompareToolHandlerBinding(
    currentSnapshot,
    ['edge', 'standalone', 'cluster-control'],
  );
  assert.deepEqual(binding.tool, BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL);
  assert.deepEqual(binding.adapter, BUILTIN_TASK_RUN_OUTCOME_COMPARE_ADAPTER);
  assert.deepEqual(binding.authorities, ['database.read']);

  const adapter = new BuiltInTaskRunOutcomeCompareToolAdapter(
    binding,
    'edge',
    projectToolDefinitionRegistry(currentSnapshot),
    empty.windows,
    empty.runs,
  );
  assert.equal(adapter.recoveryMode, 'retry_safe_read');
  const output = await adapter.execute(
    { projectId: 'project-outcomes' },
    { taskId: 'task-backup' },
  );
  assert.equal(output.selection.complete, true);

  assert.throws(
    () =>
      new BuiltInTaskRunOutcomeCompareToolAdapter(
        { ...binding, authorities: ['database.read', 'network.client'] },
        'edge',
        projectToolDefinitionRegistry(currentSnapshot),
        empty.windows,
        empty.runs,
      ),
    /handler authority is invalid/,
  );
});

test('publishes only explicit outcome comparison subpaths and keeps the root unchanged', () => {
  const tool = require('@qinglong/runtime-core/builtin-task-run-outcome-compare-tool');
  const projection = require('@qinglong/runtime-core/builtin-task-run-outcome-compare-projection');
  const window = require('@qinglong/runtime-core/task-run-outcome-window');
  const root = require('@qinglong/runtime-core');

  assert.equal(
    tool.BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL.name,
    'qinglong.task.runs.compare',
  );
  assert.equal(projection.TASK_RUN_OUTCOME_SEARCH_LIMIT, 64);
  assert.equal(window.MAX_TASK_RUN_OUTCOME_WINDOW_STORAGE_LIMIT, 65);
  assert.equal(root.BUILTIN_TASK_RUN_OUTCOME_COMPARE_TOOL, undefined);
  assert.equal(root.executeBuiltInTaskRunOutcomeCompareTool, undefined);
});
