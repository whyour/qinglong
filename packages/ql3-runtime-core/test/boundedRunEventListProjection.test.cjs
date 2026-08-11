const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const {
  BoundedRunEventListProjectionUnavailableError,
  DEFAULT_BOUNDED_RUN_EVENT_LIST_LIMIT,
  InvalidBoundedRunEventListProjectionError,
  MAX_BOUNDED_RUN_EVENT_LIST_LIMIT,
  executeBoundedRunEventListProjection,
} = require('../dist/run/projection/boundedRunEventListProjection.js');

function run(projectId = 'prj_default') {
  return Object.freeze({ id: 'run-1', projectId });
}

function event(sequence, overrides = {}) {
  return Object.freeze({
    id: `event-${sequence}`,
    runId: 'run-1',
    sequence,
    type: `run.event.${sequence}`,
    dedupeKey: `private-dedupe-${sequence}`,
    actorType: 'system',
    actorId: 'private-actor',
    payload: Object.freeze({ secret: 'must-not-cross-projection' }),
    createdAtMs: 1_000 + sequence,
    ...overrides,
  });
}

test('projects one bounded payload-free page and validates the sentinel row', async () => {
  const calls = [];
  const result = await executeBoundedRunEventListProjection(
    {
      async findRunById(runId) {
        calls.push(['run', runId]);
        return run();
      },
      async listEvents(runId, options) {
        calls.push(['events', runId, options]);
        return [event(3), event(5), event(8)];
      },
    },
    'prj_default',
    'run-1',
    { afterSequence: 2, limit: 2 },
  );
  assert.deepEqual(calls, [
    ['run', 'run-1'],
    ['events', 'run-1', { afterSequence: 2, limit: 3 }],
  ]);
  assert.deepEqual(result, {
    found: true,
    events: [
      {
        sequence: 3,
        type: 'run.event.3',
        actorType: 'system',
        createdAtMs: 1_003,
      },
      {
        sequence: 5,
        type: 'run.event.5',
        actorType: 'system',
        createdAtMs: 1_005,
      },
    ],
    hasMore: true,
    nextAfterSequence: 5,
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('uses default and maximum bounds and preserves an empty-page cursor', async () => {
  const calls = [];
  const reader = {
    async findRunById() {
      return run();
    },
    async listEvents(_runId, options) {
      calls.push(options);
      return [];
    },
  };
  assert.deepEqual(
    await executeBoundedRunEventListProjection(
      reader,
      'prj_default',
      'run-1',
      {},
    ),
    { found: true, events: [], hasMore: false, nextAfterSequence: 0 },
  );
  assert.deepEqual(
    await executeBoundedRunEventListProjection(reader, 'prj_default', 'run-1', {
      afterSequence: 7,
      limit: MAX_BOUNDED_RUN_EVENT_LIST_LIMIT,
    }),
    { found: true, events: [], hasMore: false, nextAfterSequence: 7 },
  );
  assert.deepEqual(calls, [
    { afterSequence: 0, limit: DEFAULT_BOUNDED_RUN_EVENT_LIST_LIMIT + 1 },
    { afterSequence: 7, limit: MAX_BOUNDED_RUN_EVENT_LIST_LIMIT + 1 },
  ]);
});

test('masks absence and Project mismatch without reading events', async () => {
  for (const value of [null, run('prj_other')]) {
    let reads = 0;
    const result = await executeBoundedRunEventListProjection(
      {
        async findRunById() {
          return value;
        },
        async listEvents() {
          reads += 1;
          return [];
        },
      },
      'prj_default',
      'run-1',
      { afterSequence: 7 },
    );
    assert.deepEqual(result, {
      found: false,
      events: [],
      hasMore: false,
      nextAfterSequence: 7,
    });
    assert.equal(reads, 0);
  }
});

test('fails closed on invalid input, repository failure and corrupt ordering', async () => {
  const reader = {
    async findRunById() {
      return run();
    },
    async listEvents() {
      return [];
    },
  };
  for (const input of [
    null,
    { afterSequence: -1 },
    { limit: 0 },
    { limit: 65 },
    { extra: true },
  ]) {
    await assert.rejects(
      executeBoundedRunEventListProjection(
        reader,
        'prj_default',
        'run-1',
        input,
      ),
      InvalidBoundedRunEventListProjectionError,
    );
  }
  for (const rows of [
    [event(2), event(1)],
    [event(1), event(1)],
    [event(1, { runId: 'run-other' })],
    [event(1, { actorType: 'invented' })],
    [event(1), event(2, { type: '' })],
  ]) {
    await assert.rejects(
      executeBoundedRunEventListProjection(
        {
          async findRunById() {
            return run();
          },
          async listEvents() {
            return rows;
          },
        },
        'prj_default',
        'run-1',
        { limit: 1 },
      ),
      BoundedRunEventListProjectionUnavailableError,
    );
  }
  await assert.rejects(
    executeBoundedRunEventListProjection(
      {
        async findRunById() {
          throw new Error('offline');
        },
        async listEvents() {
          return [];
        },
      },
      'prj_default',
      'run-1',
      {},
    ),
    BoundedRunEventListProjectionUnavailableError,
  );
});

test('leaf import does not load Tool Registry or SemVer', () => {
  const entry = path.resolve(
    __dirname,
    '../dist/run/projection/boundedRunEventListProjection.js',
  );
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(entry)});
       const loaded = Object.keys(require.cache);
       if (loaded.some((value) => /node_modules[\\\\/]semver(?:[\\\\/]|$)/.test(value))) process.exit(2);
       if (loaded.some((value) => /tool-execution[\\\\/]tool-registry/.test(value))) process.exit(3);
       process.stdout.write(String(loaded.length));`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Number(result.stdout) <= 4);
});
