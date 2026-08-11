require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createLocalProcessDurableHandle,
} = require('../../back/runtime/adapters/local-process/localProcessIdentity');
const {
  LocalProcessPersistedExecutionController,
} = require('../../back/runtime/adapters/local-process/persistedLocalProcessController');

const IDENTITY = {
  platform: 'linux',
  bootId: '11111111-2222-3333-4444-555555555555',
  pid: 4321,
  processGroupId: 4321,
  startTimeTicks: '123456',
};
const HANDLE = createLocalProcessDurableHandle('handle-1', IDENTITY);

function controller(inspections, overrides = {}) {
  const signals = [];
  let index = 0;
  return {
    signals,
    value: new LocalProcessPersistedExecutionController({
      identityProvider: {
        async capture() {
          throw new Error('not used');
        },
        async inspect(identity) {
          assert.deepEqual(identity, IDENTITY);
          const status = inspections[Math.min(index, inspections.length - 1)];
          index += 1;
          return { status };
        },
      },
      sendSignal(pid, signal) {
        signals.push({ pid, signal });
      },
      graceMs: 10,
      pollIntervalMs: 5,
      sleep: async () => undefined,
      ...overrides,
    }),
  };
}

const REASON = { kind: 'user', requestedAtMs: 1_750_000_000_000 };

test('refuses malformed, PID-mismatched, and non-leader handles without signals', async () => {
  const instance = controller(['running']);
  assert.equal(
    (await instance.value.stop({ durableHandle: 'bad', reason: REASON }))
      .status,
    'invalid',
  );
  assert.equal(
    (
      await instance.value.stop({
        durableHandle: HANDLE,
        expectedPid: 9999,
        reason: REASON,
      })
    ).status,
    'pid_mismatch',
  );
  const nonLeader = createLocalProcessDurableHandle('handle-2', {
    ...IDENTITY,
    processGroupId: 4000,
  });
  assert.equal(
    (await instance.value.stop({ durableHandle: nonLeader, reason: REASON }))
      .status,
    'identity_mismatch',
  );
  assert.deepEqual(instance.signals, []);
});

test('sends TERM only when the persisted process exits during grace', async () => {
  const instance = controller(['running', 'exited']);
  const result = await instance.value.stop({
    durableHandle: HANDLE,
    expectedPid: 4321,
    reason: REASON,
  });
  assert.deepEqual(result, {
    status: 'termination_requested',
    termSignalSent: true,
    killSignalSent: false,
  });
  assert.deepEqual(instance.signals, [{ pid: -4321, signal: 'SIGTERM' }]);
});

test('revalidates identity before escalating a persistent process to KILL', async () => {
  const persistent = controller(['running', 'running', 'running', 'running']);
  const killed = await persistent.value.stop({
    durableHandle: HANDLE,
    reason: REASON,
  });
  assert.equal(killed.killSignalSent, true);
  assert.deepEqual(persistent.signals, [
    { pid: -4321, signal: 'SIGTERM' },
    { pid: -4321, signal: 'SIGKILL' },
  ]);

  const changed = controller([
    'running',
    'running',
    'running',
    'identity_mismatch',
  ]);
  const refused = await changed.value.stop({
    durableHandle: HANDLE,
    reason: REASON,
  });
  assert.equal(refused.status, 'identity_mismatch');
  assert.equal(refused.killSignalSent, false);
  assert.deepEqual(changed.signals, [{ pid: -4321, signal: 'SIGTERM' }]);
});

test('treats an already exited process and ESRCH as idempotent completion', async () => {
  const exited = controller(['exited']);
  assert.deepEqual(
    await exited.value.stop({ durableHandle: HANDLE, reason: REASON }),
    {
      status: 'already_exited',
      termSignalSent: false,
      killSignalSent: false,
    },
  );

  const noProcess = controller(['running'], {
    sendSignal() {
      const error = new Error('gone');
      error.code = 'ESRCH';
      throw error;
    },
  });
  assert.equal(
    (await noProcess.value.stop({ durableHandle: HANDLE, reason: REASON }))
      .status,
    'already_exited',
  );
});
