require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  DEFAULT_LEGACY_TERMINATION_GRACE_MS,
  buildLegacyCronExecutionSpec,
} = require('../../back/runtime/adapters/legacy/legacyCronExecutionSpec');
const {
  InvalidExecutionSpecError,
} = require('../../back/runtime/domain/executorErrors');

function createInput(overrides = {}) {
  return {
    runId: '019f70f0-0000-7000-8000-000000000001',
    attemptId: '019f70f0-0000-7000-8000-000000000002',
    projectId: 'default',
    taskRevision: 'legacy-revision-1',
    cron: {
      id: 7,
      command: 'demo/script.js now',
    },
    realTime: false,
    ...overrides,
  };
}

test('builds the minimal legacy task.sh shell contract', () => {
  assert.deepEqual(buildLegacyCronExecutionSpec(createInput()), {
    runId: '019f70f0-0000-7000-8000-000000000001',
    attemptId: '019f70f0-0000-7000-8000-000000000002',
    projectId: 'default',
    taskId: 'legacy-cron:7',
    taskRevision: 'legacy-revision-1',
    command: {
      kind: 'shell',
      command: "real_time='false' no_tee='true' ID='7' task demo/script.js now",
      shell: '/bin/bash',
    },
    environmentPolicy: 'inherit',
    terminationGraceMs: DEFAULT_LEGACY_TERMINATION_GRACE_MS,
  });
});

test('preserves existing task/ql commands instead of adding a second prefix', () => {
  const task = buildLegacyCronExecutionSpec(
    createInput({ cron: { id: 8, command: ' task script.py now ' } }),
  );
  const ql = buildLegacyCronExecutionSpec(
    createInput({ cron: { id: 9, command: 'ql update' } }),
  );

  assert.match(task.command.command, / ID='8' task script\.py now$/);
  assert.match(ql.command.command, / ID='9' ql update$/);
});

test('quotes paths, hook commands, and log values without changing shell boundaries', () => {
  const spec = buildLegacyCronExecutionSpec(
    createInput({
      realTime: true,
      realLogPath: "folder with space/run's.log",
      noDelay: true,
      timeoutMs: 60_000,
      terminationGraceMs: 2_000,
      resourcePolicy: {
        memoryBytes: {
          value: 128 * 1024 * 1024,
          enforcement: 'best_effort',
        },
      },
      cron: {
        id: 10,
        command: "scripts/job.py now -- 'user value'",
        taskBefore: "echo 'before'\n echo second",
        taskAfter: 'echo after;\n echo done',
        workDirectory: "/data/project's worktree",
        logName: 'custom log',
      },
    }),
  );

  assert.equal(
    spec.command.command,
    "real_log_path='folder with space/run'\\''s.log' no_delay='true' real_time='true' no_tee='true' ID='10' log_name='custom log' task_before='echo '\\''before'\\''; echo second' task_after='echo after; echo done' work_dir='/data/project'\\''s worktree' task scripts/job.py now -- 'user value'",
  );
  assert.equal(spec.timeoutMs, 60_000);
  assert.equal(spec.terminationGraceMs, 2_000);
  assert.deepEqual(spec.resourcePolicy, {
    memoryBytes: {
      value: 128 * 1024 * 1024,
      enforcement: 'best_effort',
    },
  });
});

test('rejects invalid legacy ids and empty commands before execution', () => {
  assert.throws(
    () =>
      buildLegacyCronExecutionSpec(
        createInput({ cron: { id: 0, command: 'script.py' } }),
      ),
    InvalidExecutionSpecError,
  );
  assert.throws(
    () =>
      buildLegacyCronExecutionSpec(
        createInput({ cron: { id: 1, command: '   ' } }),
      ),
    InvalidExecutionSpecError,
  );
});
