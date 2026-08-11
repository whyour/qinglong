require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const {
  LocalProcessExecutor,
} = require('../../back/runtime/adapters/local-process/localProcessExecutor');
const {
  PosixProcessTerminator,
} = require('../../back/runtime/adapters/local-process/processTerminator');
const {
  ExecutorCapabilityUnavailableError,
  ExecutorHandleNotFoundError,
  ExecutorStartError,
  InvalidExecutionSpecError,
} = require('../../back/runtime/domain/executorErrors');

let idSequence = 300;

function nextId() {
  idSequence += 1;
  return `019f70e0-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
}

function createSpec(overrides = {}) {
  return {
    runId: nextId(),
    attemptId: nextId(),
    projectId: 'default',
    taskId: 'executor-contract-test',
    taskRevision: 'revision-1',
    command: {
      kind: 'argv',
      file: process.execPath,
      args: ['-e', "process.stdout.write('ok')"],
    },
    environmentPolicy: 'isolated',
    terminationGraceMs: 100,
    ...overrides,
  };
}

function createOutputCollector(write) {
  const chunks = { stdout: [], stderr: [] };
  return {
    chunks,
    context: {
      environment: {},
      output: {
        async write(output) {
          chunks[output.stream].push(Buffer.from(output.chunk));
          await write?.(output);
        },
      },
    },
    text(stream) {
      return Buffer.concat(chunks[stream]).toString('utf8');
    },
  };
}

test(
  'executes argv commands and drains ordered stdout/stderr before completion',
  { timeout: 5_000 },
  async () => {
    const executor = new LocalProcessExecutor({ createHandleId: nextId });
    const output = createOutputCollector(async () => delay(2));
    const handle = await executor.start(
      createSpec({
        command: {
          kind: 'argv',
          file: process.execPath,
          args: [
            '-e',
            "process.stdout.write('stdout-value'); process.stderr.write('stderr-value')",
          ],
        },
      }),
      output.context,
    );

    assert.ok(handle.pid > 0);
    assert.equal(handle.executorType, 'local_process');
    const result = await handle.completion;
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.exitCode, 0);
    assert.equal(output.text('stdout'), 'stdout-value');
    assert.equal(output.text('stderr'), 'stderr-value');
    assert.deepEqual(await executor.inspect(handle), {
      status: 'exited',
      result,
    });
  },
);

test(
  'supports explicit shell compatibility commands and stable non-zero results',
  { timeout: 5_000 },
  async () => {
    const executor = new LocalProcessExecutor({ createHandleId: nextId });
    const output = createOutputCollector();
    const handle = await executor.start(
      createSpec({
        command: {
          kind: 'shell',
          command: "printf 'shell-stdout'; printf 'shell-stderr' >&2; exit 7",
          shell: '/bin/bash',
        },
      }),
      output.context,
    );

    const result = await handle.completion;
    assert.equal(result.outcome, 'failed');
    assert.equal(result.exitCode, 7);
    assert.equal(result.errorCode, 'PROCESS_EXIT_NON_ZERO');
    assert.equal(output.text('stdout'), 'shell-stdout');
    assert.equal(output.text('stderr'), 'shell-stderr');
  },
);

test(
  'honors isolated environment and an authorized working directory',
  { timeout: 5_000 },
  async () => {
    const previous = process.env.QL3_PARENT_ONLY_VALUE;
    process.env.QL3_PARENT_ONLY_VALUE = 'must-not-leak';
    try {
      const executor = new LocalProcessExecutor({ createHandleId: nextId });
      const output = createOutputCollector();
      output.context.environment = { QL3_SUPPLIED_VALUE: 'visible' };
      const handle = await executor.start(
        createSpec({
          workingDirectory: process.cwd(),
          command: {
            kind: 'argv',
            file: process.execPath,
            args: [
              '-e',
              'process.stdout.write(JSON.stringify({ cwd: process.cwd(), supplied: process.env.QL3_SUPPLIED_VALUE, inherited: process.env.QL3_PARENT_ONLY_VALUE }))',
            ],
          },
        }),
        output.context,
      );

      assert.equal((await handle.completion).outcome, 'succeeded');
      assert.deepEqual(JSON.parse(output.text('stdout')), {
        cwd: process.cwd(),
        supplied: 'visible',
      });
    } finally {
      if (previous === undefined) delete process.env.QL3_PARENT_ONLY_VALUE;
      else process.env.QL3_PARENT_ONLY_VALUE = previous;
    }
  },
);

test(
  'applies output backpressure without buffering the complete process output',
  { timeout: 10_000 },
  async () => {
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const executor = new LocalProcessExecutor({ createHandleId: nextId });
    const output = createOutputCollector(async () => {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      await delay(1);
      activeWrites -= 1;
    });
    const handle = await executor.start(
      createSpec({
        command: {
          kind: 'argv',
          file: process.execPath,
          args: [
            '-e',
            "for (let i = 0; i < 1000; i += 1) process.stdout.write('x'.repeat(1024))",
          ],
        },
      }),
      output.context,
    );

    assert.equal((await handle.completion).outcome, 'succeeded');
    assert.equal(output.text('stdout').length, 1_024_000);
    assert.equal(maximumActiveWrites, 1);
  },
);

test(
  'continues draining output and reports a bounded diagnostic when the sink fails',
  { timeout: 5_000 },
  async () => {
    const executor = new LocalProcessExecutor({ createHandleId: nextId });
    let writes = 0;
    const context = {
      environment: {},
      output: {
        async write() {
          writes += 1;
          throw new Error('sink contains potentially sensitive details');
        },
      },
    };
    const handle = await executor.start(
      createSpec({
        command: {
          kind: 'argv',
          file: process.execPath,
          args: [
            '-e',
            "for (let i = 0; i < 200; i += 1) process.stdout.write('x'.repeat(1024))",
          ],
        },
      }),
      context,
    );

    const result = await handle.completion;
    assert.equal(result.outcome, 'succeeded');
    assert.equal(writes, 1);
    assert.deepEqual(result.diagnostics, [
      {
        code: 'OUTPUT_SINK_FAILED',
        summary: 'Execution output sink failed; output may be incomplete',
      },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /potentially sensitive/);
  },
);

test(
  'cancels a process group and keeps repeated stop calls idempotent',
  { timeout: 5_000 },
  async () => {
    const executor = new LocalProcessExecutor({ createHandleId: nextId });
    const output = createOutputCollector();
    const handle = await executor.start(
      createSpec({
        command: {
          kind: 'argv',
          file: process.execPath,
          args: ['-e', 'setInterval(() => undefined, 1000)'],
        },
      }),
      output.context,
    );

    const stopResult = await executor.stop(handle, {
      kind: 'user',
      requestedAtMs: Date.now(),
    });
    const result = await handle.completion;
    assert.deepEqual(stopResult, {
      status: 'termination_requested',
      termSignalSent: true,
      killSignalSent: false,
    });
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.signal, 'SIGTERM');
    assert.deepEqual(
      await executor.stop(handle, {
        kind: 'user',
        requestedAtMs: Date.now(),
      }),
      {
        status: 'already_exited',
        termSignalSent: false,
        killSignalSent: false,
      },
    );
  },
);

test(
  'escalates ignored timeout termination to SIGKILL and reports timed_out',
  { timeout: 5_000 },
  async () => {
    const executor = new LocalProcessExecutor({ createHandleId: nextId });
    const output = createOutputCollector();
    const handle = await executor.start(
      createSpec({
        // The complete test suite runs files concurrently; leave enough time
        // for the child Node process to install its SIGTERM handler first.
        timeoutMs: 1_000,
        terminationGraceMs: 30,
        command: {
          kind: 'argv',
          file: process.execPath,
          args: [
            '-e',
            "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)",
          ],
        },
      }),
      output.context,
    );

    const result = await handle.completion;
    assert.equal(result.outcome, 'timed_out');
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(result.errorCode, 'EXECUTION_TIMED_OUT');
  },
);

test(
  'observes AbortSignal cancellation without leaking listeners into completion',
  { timeout: 5_000 },
  async () => {
    const controller = new AbortController();
    const executor = new LocalProcessExecutor({ createHandleId: nextId });
    const output = createOutputCollector();
    output.context.signal = controller.signal;
    const handle = await executor.start(
      createSpec({
        command: {
          kind: 'argv',
          file: process.execPath,
          args: ['-e', 'setInterval(() => undefined, 1000)'],
        },
      }),
      output.context,
    );

    controller.abort();
    assert.equal((await handle.completion).outcome, 'cancelled');
  },
);

test('rejects unsupported required limits and invalid specs before spawn', async () => {
  const executor = new LocalProcessExecutor({ createHandleId: nextId });
  const output = createOutputCollector();

  await assert.rejects(
    executor.start(
      createSpec({
        resourcePolicy: {
          memoryBytes: { value: 64 * 1024 * 1024, enforcement: 'required' },
        },
      }),
      output.context,
    ),
    ExecutorCapabilityUnavailableError,
  );
  await assert.rejects(
    executor.start(
      createSpec({ workingDirectory: 'relative/path' }),
      output.context,
    ),
    InvalidExecutionSpecError,
  );

  const bestEffort = await executor.start(
    createSpec({
      resourcePolicy: {
        memoryBytes: {
          value: 64 * 1024 * 1024,
          enforcement: 'best_effort',
        },
        networkIsolation: 'best_effort',
      },
    }),
    output.context,
  );
  assert.deepEqual((await bestEffort.completion).diagnostics, [
    {
      code: 'RESOURCE_POLICY_BEST_EFFORT_UNAVAILABLE',
      summary:
        'Best-effort capabilities were unavailable: memoryLimit, networkIsolation',
    },
  ]);
});

test('maps spawn failures and rejects handles owned by another executor', async () => {
  const executor = new LocalProcessExecutor({ createHandleId: nextId });
  const output = createOutputCollector();
  await assert.rejects(
    executor.start(
      createSpec({
        command: {
          kind: 'argv',
          file: '/path/that/does/not/exist/ql3-command',
          args: [],
        },
      }),
      output.context,
    ),
    ExecutorStartError,
  );

  await assert.rejects(
    executor.inspect({
      id: nextId(),
      executorType: 'local_process',
      runId: nextId(),
      attemptId: nextId(),
      startedAtMs: Date.now(),
      completion: Promise.resolve({
        outcome: 'lost',
        startedAtMs: Date.now(),
        finishedAtMs: Date.now(),
      }),
    }),
    ExecutorHandleNotFoundError,
  );
});

test('process terminator stops after TERM or escalates after the grace window', async () => {
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const signals = [];
  const graceful = new PosixProcessTerminator((pid, signal) => {
    signals.push([pid, signal]);
    if (signal === 'SIGTERM') resolveClosed();
  });
  assert.deepEqual(
    await graceful.terminate({
      pid: 42,
      processGroup: true,
      graceMs: 50,
      closed,
    }),
    {
      alreadyExited: false,
      termSignalSent: true,
      killSignalSent: false,
    },
  );
  assert.deepEqual(signals, [[-42, 'SIGTERM']]);

  const escalatedSignals = [];
  const escalated = new PosixProcessTerminator((pid, signal) => {
    escalatedSignals.push([pid, signal]);
  });
  assert.deepEqual(
    await escalated.terminate({
      pid: 43,
      processGroup: false,
      graceMs: 1,
      closed: new Promise(() => undefined),
    }),
    {
      alreadyExited: false,
      termSignalSent: true,
      killSignalSent: true,
    },
  );
  assert.deepEqual(escalatedSignals, [
    [43, 'SIGTERM'],
    [43, 'SIGKILL'],
  ]);
});
