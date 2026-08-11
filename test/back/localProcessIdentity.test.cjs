require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createLocalProcessDurableHandle,
  LinuxProcProcessIdentityProvider,
  LocalProcessPersistedExecutionInspector,
  MAX_LOCAL_PROCESS_DURABLE_HANDLE_BYTES,
  parseLocalProcessDurableHandle,
} = require('../../back/runtime/adapters/local-process/localProcessIdentity');
const {
  LocalProcessExecutor,
} = require('../../back/runtime/adapters/local-process/localProcessExecutor');

let idSequence = 900;

function nextId() {
  idSequence += 1;
  return `019f70f0-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
}

function identity(overrides = {}) {
  return {
    platform: 'linux',
    bootId: '11111111-2222-3333-4444-555555555555',
    pid: 4321,
    processGroupId: 4321,
    startTimeTicks: '987654321',
    ...overrides,
  };
}

function procStat({
  pid = 4321,
  processGroupId = 4321,
  startTimeTicks = '987654321',
  state = 'S',
} = {}) {
  const fields = Array(20).fill('0');
  fields[0] = state;
  fields[1] = '1';
  fields[2] = String(processGroupId);
  fields[19] = startTimeTicks;
  return `${pid} (node worker with spaces) ${fields.join(' ')}`;
}

function missingFile() {
  const error = new Error('not found');
  error.code = 'ENOENT';
  return error;
}

test('round-trips a bounded opaque Linux process identity', () => {
  const handleId = nextId();
  const durableHandle = createLocalProcessDurableHandle(handleId, identity());

  assert.ok(
    Buffer.byteLength(durableHandle) <= MAX_LOCAL_PROCESS_DURABLE_HANDLE_BYTES,
  );
  assert.deepEqual(parseLocalProcessDurableHandle(durableHandle), {
    handleId,
    identity: identity(),
  });
  assert.doesNotMatch(durableHandle, /node worker|command|environment/);
});

test('rejects malformed, oversized, and unsafe durable handles', () => {
  assert.equal(parseLocalProcessDurableHandle('legacy-uuid-only'), null);
  assert.equal(parseLocalProcessDurableHandle('ql3lp1.not+base64url'), null);
  assert.equal(
    parseLocalProcessDurableHandle(
      `ql3lp1.${'a'.repeat(MAX_LOCAL_PROCESS_DURABLE_HANDLE_BYTES)}`,
    ),
    null,
  );
  assert.throws(() =>
    createLocalProcessDurableHandle('invalid\0handle', identity()),
  );
  assert.throws(() =>
    createLocalProcessDurableHandle(nextId(), identity({ pid: 0 })),
  );
});

test('captures and verifies boot, start-time, and process-group identity', async () => {
  const files = new Map([
    [
      '/proc/sys/kernel/random/boot_id',
      '11111111-2222-3333-4444-555555555555\n',
    ],
    ['/proc/4321/stat', procStat()],
  ]);
  const provider = new LinuxProcProcessIdentityProvider({
    platform: 'linux',
    async readTextFile(path) {
      const value = files.get(path);
      if (value === undefined) throw missingFile();
      return value;
    },
  });

  const captured = await provider.capture(4321);
  assert.deepEqual(captured, identity());
  assert.deepEqual(await provider.inspect(captured), { status: 'running' });

  files.set('/proc/4321/stat', procStat({ startTimeTicks: '987654322' }));
  assert.deepEqual(await provider.inspect(captured), {
    status: 'identity_mismatch',
  });

  files.set('/proc/4321/stat', procStat({ state: 'Z' }));
  assert.deepEqual(await provider.inspect(captured), { status: 'exited' });

  files.delete('/proc/4321/stat');
  assert.deepEqual(await provider.inspect(captured), { status: 'exited' });
});

test('never accepts an identity from another boot or unsupported platform', async () => {
  const provider = new LinuxProcProcessIdentityProvider({
    platform: 'linux',
    async readTextFile(path) {
      if (path === '/proc/sys/kernel/random/boot_id') {
        return 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      }
      return procStat();
    },
  });
  assert.deepEqual(await provider.inspect(identity()), {
    status: 'identity_mismatch',
  });

  const unsupported = new LinuxProcProcessIdentityProvider({
    platform: 'darwin',
    async readTextFile() {
      throw new Error('must not read /proc');
    },
  });
  assert.equal(await unsupported.capture(4321), null);
  assert.deepEqual(await unsupported.inspect(identity()), {
    status: 'unsupported',
  });
});

test('classifies invalid persisted values before consulting the OS', async () => {
  let inspections = 0;
  const inspector = new LocalProcessPersistedExecutionInspector({
    async capture() {
      return null;
    },
    async inspect() {
      inspections += 1;
      return { status: 'running' };
    },
  });

  assert.deepEqual(await inspector.inspect('not-a-durable-handle'), {
    status: 'invalid',
  });
  assert.equal(inspections, 0);

  const durableHandle = createLocalProcessDurableHandle(nextId(), identity());
  assert.deepEqual(await inspector.inspect(durableHandle), {
    status: 'running',
    identityPid: 4321,
  });
  assert.equal(inspections, 1);
});

test(
  'LocalProcessExecutor exposes a durable identity without replacing its live handle',
  { timeout: 5_000 },
  async () => {
    const observed = identity();
    const executor = new LocalProcessExecutor({
      createHandleId: nextId,
      identityProvider: {
        async capture(pid) {
          return { ...observed, pid, processGroupId: pid };
        },
        async inspect() {
          return { status: 'running' };
        },
      },
    });
    const handle = await executor.start(
      {
        runId: nextId(),
        attemptId: nextId(),
        projectId: 'default',
        taskId: 'durable-handle-test',
        taskRevision: 'revision-1',
        command: {
          kind: 'argv',
          file: process.execPath,
          args: ['-e', 'setInterval(() => undefined, 1000)'],
        },
        environmentPolicy: 'isolated',
        terminationGraceMs: 100,
      },
      {
        environment: {},
        output: { async write() {} },
      },
    );

    const parsed = parseLocalProcessDurableHandle(handle.durableHandle);
    assert.equal(parsed.handleId, handle.id);
    assert.equal(parsed.identity.pid, handle.pid);
    assert.equal(parsed.identity.processGroupId, handle.pid);

    await executor.stop(handle, {
      kind: 'user',
      requestedAtMs: Date.now(),
    });
    assert.equal((await handle.completion).outcome, 'cancelled');
  },
);
