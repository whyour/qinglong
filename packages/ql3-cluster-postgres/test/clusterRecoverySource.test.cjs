const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PostgresClusterControlRecoverySource } = require('../dist/entrypoints/runtime');

function sourceWith(rows, observations = []) {
  return new PostgresClusterControlRecoverySource({
    async query(text, values) {
      observations.push({ text, values });
      return { rows };
    },
  });
}

test('reads Run and Attempt recovery candidates through one bounded query', async () => {
  const observations = [];
  const source = sourceWith(
    [
      {
        observedAtMs: '100',
        kind: 'run',
        id: 'run-1',
        runId: 'run-1',
        status: 'running',
        createdAtMs: '10',
      },
      {
        observedAtMs: '100',
        kind: 'attempt',
        id: 'attempt-1',
        runId: 'run-1',
        status: 'starting',
        createdAtMs: 11,
      },
      {
        observedAtMs: '100',
        kind: 'run',
        id: 'run-2',
        runId: 'run-2',
        status: 'created',
        createdAtMs: 12,
      },
    ],
    observations,
  );

  assert.deepEqual(await source.listOutstanding(2), {
    observedAtMs: 100,
    candidates: [
      {
        kind: 'run',
        id: 'run-1',
        runId: 'run-1',
        status: 'running',
        createdAtMs: 10,
      },
      {
        kind: 'attempt',
        id: 'attempt-1',
        runId: 'run-1',
        status: 'starting',
        createdAtMs: 11,
      },
    ],
    hasMore: true,
  });
  assert.deepEqual(observations[0].values, [3]);
  assert.match(observations[0].text, /WITH observation AS/);
  assert.match(observations[0].text, /statement_timestamp\(\)/);
  assert.match(observations[0].text, /LIMIT \$1/);
  assert.match(observations[0].text, /execution_owner = 'runtime'/);
  assert.match(
    observations[0].text,
    /trigger_type <> 'plugin_package_workflow'/,
  );
  assert.match(observations[0].text, /attempt_candidates/);
  assert.match(
    observations[0].text,
    /plugin_package_workflow_task_attempt_admissions/,
  );
  assert.match(
    observations[0].text,
    /attempt_run\.trigger_type = 'plugin_package_workflow'/,
  );
  assert.match(
    observations[0].text,
    /workflow_task\.attempt_id = attempt\.id/,
  );
  assert.match(
    observations[0].text,
    /lease_expires_at_ms > observation\.observed_at_ms/,
  );
  assert.match(
    observations[0].text,
    /lease_expires_at_ms <= observation\.observed_at_ms/,
  );
  assert.match(observations[0].text, /INNER JOIN "ql3"\."runs" AS attempt_run/);
  assert.match(observations[0].text, /attempt_run\.status = 'queued'/);
  assert.match(
    observations[0].text,
    /attempt\.executor_type = 'remote_worker'/,
  );
  assert.match(observations[0].text, /attempt\.callback_sequence = 0/);
  assert.match(
    observations[0].text,
    /newer_attempt\.attempt > attempt\.attempt/,
  );
});

test('rejects unbounded page sizes before touching PostgreSQL', async () => {
  let queries = 0;
  const source = sourceWith([], {
    push() {
      queries += 1;
    },
  });
  await assert.rejects(source.listOutstanding(0), /between 1 and 128/);
  await assert.rejects(source.listOutstanding(129), /between 1 and 128/);
  assert.equal(queries, 0);
});

test('fails closed on malformed or terminal PostgreSQL rows', async () => {
  await assert.rejects(
    sourceWith([
      {
        observedAtMs: '100',
        kind: 'run',
        id: 'run-1',
        runId: 'run-1',
        status: 'succeeded',
        createdAtMs: 1,
      },
    ]).listOutstanding(1),
    /kind or status is invalid/,
  );
  await assert.rejects(
    sourceWith([
      {
        observedAtMs: '100',
        kind: 'attempt',
        id: 'attempt-1',
        runId: 'run-1',
        status: 'running',
        createdAtMs: '9007199254740992',
      },
    ]).listOutstanding(1),
    /createdAtMs is invalid/,
  );
});

test('represents an empty page without losing the database observation', async () => {
  const source = sourceWith([
    {
      observedAtMs: '100',
      kind: null,
      id: null,
      runId: null,
      status: null,
      createdAtMs: null,
    },
  ]);
  assert.deepEqual(await source.listOutstanding(1), {
    observedAtMs: 100,
    candidates: [],
    hasMore: false,
  });
});
