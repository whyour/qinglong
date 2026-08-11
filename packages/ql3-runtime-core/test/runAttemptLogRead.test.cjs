const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidRunAttemptLogReadError,
  MAX_RUN_ATTEMPT_LOG_READ_BYTES,
  RunAttemptLogReadService,
  RunAttemptLogReadUnavailableError,
  normalizeRunAttemptLogReadRange,
} = require('../dist/run/log-read/runAttemptLogRead.js');

function run(overrides = {}) {
  return {
    id: 'run_123',
    projectId: 'prj_default',
    taskId: 'task_1',
    taskRevision: 'revision_1',
    triggerType: 'task_start',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'running',
    version: 2,
    eventSequence: 2,
    priority: 0,
    createdAtMs: 1,
    ...overrides,
  };
}

function attempt(overrides = {}) {
  return {
    id: 'attempt_123',
    runId: 'run_123',
    attempt: 1,
    status: 'running',
    executorType: 'local_process',
    logArtifactId: `local-${'a'.repeat(30)}`,
    callbackSequence: 0,
    createdAtMs: 1,
    ...overrides,
  };
}

function service(overrides = {}) {
  const calls = [];
  const runs = overrides.runs ?? {
    async findRunById() {
      return run();
    },
    async findAttemptById() {
      return attempt();
    },
  };
  const reader = overrides.reader ?? {
    async read(identity, range, signal) {
      calls.push({ identity, range, signal });
      return {
        status: 'available',
        content: Buffer.from('log'),
        start: range.offset,
        endExclusive: range.offset + 3,
        totalBytes: range.offset + 5,
        nextOffset: range.offset + 3,
        truncation: { truncated: false, maximumBytes: 1024, observedAtMs: 9 },
      };
    },
  };
  return {
    calls,
    value: new RunAttemptLogReadService(
      runs,
      reader,
      {
        executorType: overrides.executorType ?? 'local_process',
        artifactIdPattern:
          overrides.artifactIdPattern ?? /^local-[a-f0-9]{30}$/,
        maximumReadBytes: overrides.maximumReadBytes ?? 32 * 1024,
        ...(overrides.activeMissingIsPending === undefined
          ? {}
          : { activeMissingIsPending: overrides.activeMissingIsPending }),
      },
      overrides.retention,
    ),
  };
}

function request(overrides = {}) {
  return {
    projectId: 'prj_default',
    runId: 'run_123',
    attemptId: 'attempt_123',
    range: { offset: 4, length: 16 },
    ...overrides,
  };
}

test('normalizes only bounded safe ranges', () => {
  assert.deepEqual(normalizeRunAttemptLogReadRange({ offset: 0, length: 1 }), {
    offset: 0,
    length: 1,
  });
  assert.deepEqual(
    normalizeRunAttemptLogReadRange({
      offset: Number.MAX_SAFE_INTEGER,
      length: MAX_RUN_ATTEMPT_LOG_READ_BYTES,
    }),
    { offset: Number.MAX_SAFE_INTEGER, length: MAX_RUN_ATTEMPT_LOG_READ_BYTES },
  );
  for (const range of [
    { offset: -1, length: 1 },
    { offset: 0.5, length: 1 },
    { offset: 0, length: 0 },
    { offset: 0, length: MAX_RUN_ATTEMPT_LOG_READ_BYTES + 1 },
  ]) {
    assert.throws(
      () => normalizeRunAttemptLogReadRange(range),
      InvalidRunAttemptLogReadError,
    );
  }
});

test('validates Project, Run, Attempt, owner and executor before storage access', async () => {
  const cases = [
    { run: null },
    { run: run({ projectId: 'prj_other' }) },
    { run: run({ executionOwner: 'legacy' }) },
    { attempt: null },
    { attempt: attempt({ runId: 'run_other' }) },
    { attempt: attempt({ executorType: 'remote_worker' }) },
    { attempt: attempt({ logArtifactId: `wlog-${'a'.repeat(30)}` }) },
  ];
  for (const values of cases) {
    let reads = 0;
    const { value } = service({
      runs: {
        async findRunById() {
          return values.run === undefined ? run() : values.run;
        },
        async findAttemptById() {
          return values.attempt === undefined ? attempt() : values.attempt;
        },
      },
      reader: {
        async read() {
          reads += 1;
          return { status: 'missing' };
        },
      },
    });
    assert.deepEqual(await value.read(request()), { status: 'not_found' });
    assert.equal(reads, 0);
  }
});

test('returns pending before Artifact binding and for active remote publication lag', async () => {
  const unbound = service({
    runs: {
      async findRunById() {
        return run();
      },
      async findAttemptById() {
        return attempt({ logArtifactId: undefined });
      },
    },
  });
  assert.deepEqual(await unbound.value.read(request()), {
    status: 'pending',
    projectId: 'prj_default',
    runId: 'run_123',
    attemptId: 'attempt_123',
  });
  assert.equal(unbound.calls.length, 0);

  const remote = service({
    executorType: 'remote_worker',
    artifactIdPattern: /^wlog-[a-f0-9]{30}$/,
    activeMissingIsPending: true,
    runs: {
      async findRunById() {
        return run();
      },
      async findAttemptById() {
        return attempt({
          executorType: 'remote_worker',
          logArtifactId: `wlog-${'b'.repeat(30)}`,
        });
      },
    },
    reader: {
      async read() {
        return { status: 'missing' };
      },
    },
  });
  assert.equal((await remote.value.read(request())).status, 'pending');
});

test('returns a validated bounded snapshot without copying storage bytes', async () => {
  const content = Buffer.from('log');
  const abort = new AbortController();
  const { value, calls } = service({
    reader: {
      async read(identity, range, signal) {
        assert.equal(signal, abort.signal);
        return {
          status: 'available',
          content,
          start: 4,
          endExclusive: 7,
          totalBytes: 9,
          nextOffset: 7,
          truncation: {
            truncated: true,
            maximumBytes: 64 * 1024,
            observedAtMs: 10,
          },
        };
      },
    },
  });
  const result = await value.read(request({ signal: abort.signal }));
  assert.equal(result.status, 'available');
  assert.equal(result.content, content);
  assert.equal(result.nextOffset, 7);
  assert.deepEqual(result.truncation, {
    truncated: true,
    maximumBytes: 64 * 1024,
    observedAtMs: 10,
  });
  assert.equal(calls.length, 0);
});

test('returns a durable retirement before storage and rechecks after a missing read', async () => {
  const {
    createRunAttemptLogRetirementRecord,
  } = require('../dist/run/log-retention/runAttemptLogRetention.js');
  const tombstone = createRunAttemptLogRetirementRecord({
    projectId: 'prj_default',
    runId: 'run_123',
    attemptId: 'attempt_123',
    logArtifactId: `local-${'a'.repeat(30)}`,
    executorType: 'local_process',
    finishedAtMs: 10,
    eligibleAtMs: 20,
    retiredAtMs: 30,
    disposition: 'deleted',
    byteLength: 42,
    truncation: { truncated: false, maximumBytes: 1024, observedAtMs: 9 },
  });
  let inspections = 0;
  let reads = 0;
  const before = service({
    retention: {
      async inspect() {
        inspections += 1;
        return { status: 'retired', record: tombstone };
      },
    },
    reader: {
      async read() {
        reads += 1;
        return { status: 'missing' };
      },
    },
  });
  assert.deepEqual(await before.value.read(request()), {
    status: 'retired',
    projectId: 'prj_default',
    runId: 'run_123',
    attemptId: 'attempt_123',
    logArtifactId: `local-${'a'.repeat(30)}`,
    retiredAtMs: 30,
    byteLength: 42,
    truncation: { truncated: false, maximumBytes: 1024, observedAtMs: 9 },
  });
  assert.equal(inspections, 1);
  assert.equal(reads, 0);

  inspections = 0;
  const after = service({
    retention: {
      async inspect() {
        inspections += 1;
        return inspections === 1
          ? { status: 'active' }
          : { status: 'retired', record: tombstone };
      },
    },
    reader: {
      async read() {
        return { status: 'missing' };
      },
    },
  });
  assert.equal((await after.value.read(request())).status, 'retired');
  assert.equal(inspections, 2);
});

test('fails closed on malformed storage results and dependency failures', async () => {
  const malformed = service({
    reader: {
      async read() {
        return {
          status: 'available',
          content: Buffer.from('too-long'),
          start: 4,
          endExclusive: 12,
          totalBytes: 9,
          truncation: { truncated: 'unknown' },
        };
      },
    },
  });
  await assert.rejects(
    malformed.value.read(request()),
    RunAttemptLogReadUnavailableError,
  );

  const failed = service({
    runs: {
      async findRunById() {
        throw new Error('database detail');
      },
      async findAttemptById() {
        return null;
      },
    },
  });
  await assert.rejects(
    failed.value.read(request()),
    RunAttemptLogReadUnavailableError,
  );
});
