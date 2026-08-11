const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  LocalProcessController,
  createLocalProcessDurableHandle,
} = require('../dist');

const IDENTITY = Object.freeze({
  platform: 'linux',
  bootId: '11111111-2222-3333-4444-555555555555',
  pid: 1234,
  processGroupId: 1234,
  startTimeTicks: '987654',
});
const HANDLE = createLocalProcessDurableHandle('handle-1', IDENTITY);

function fixture(inspections) {
  let now = 0;
  const signals = [];
  let index = 0;
  const controller = new LocalProcessController({
    identityProvider: {
      async inspect(identity) {
        assert.deepEqual(identity, IDENTITY);
        return inspections[Math.min(index++, inspections.length - 1)];
      },
    },
    terminateGraceMs: 10,
    killGraceMs: 10,
    pollIntervalMs: 5,
    clock: { now: () => now },
    wait: async (delayMs) => {
      now += delayMs;
    },
    signalProcessGroup(processGroupId, signal) {
      signals.push({ processGroupId, signal });
    },
  });
  return { controller, signals };
}

test('stops only after exact durable identity inspection', async () => {
  const value = fixture([
    { status: 'running', identityPid: 1234 },
    { status: 'not_running', identityPid: 1234 },
  ]);
  assert.deepEqual(await value.controller.stop(HANDLE), {
    status: 'stopped',
    signal: 'SIGTERM',
  });
  assert.deepEqual(value.signals, [
    { processGroupId: 1234, signal: 'SIGTERM' },
  ]);
});

test('revalidates identity before escalating to SIGKILL', async () => {
  const value = fixture([
    { status: 'running', identityPid: 1234 },
    { status: 'running', identityPid: 1234 },
    { status: 'running', identityPid: 1234 },
    { status: 'running', identityPid: 1234 },
    { status: 'running', identityPid: 1234 },
    { status: 'not_running', identityPid: 1234 },
  ]);
  assert.deepEqual(await value.controller.stop(HANDLE), {
    status: 'stopped',
    signal: 'SIGKILL',
  });
  assert.deepEqual(value.signals, [
    { processGroupId: 1234, signal: 'SIGTERM' },
    { processGroupId: 1234, signal: 'SIGKILL' },
  ]);
});

test('does not escalate after identity is no longer running', async () => {
  const value = fixture([
    { status: 'running', identityPid: 1234 },
    { status: 'running', identityPid: 1234 },
    { status: 'running', identityPid: 1234 },
    { status: 'running', identityPid: 1234 },
    { status: 'not_running', identityPid: 1234 },
  ]);
  assert.deepEqual(await value.controller.stop(HANDLE), {
    status: 'stopped',
    signal: 'SIGTERM',
  });
  assert.deepEqual(value.signals, [
    { processGroupId: 1234, signal: 'SIGTERM' },
  ]);
});

test('rejects an unparseable handle without signaling', async () => {
  const value = fixture([{ status: 'running', identityPid: 1234 }]);
  assert.deepEqual(await value.controller.stop('not-a-durable-handle'), {
    status: 'unknown',
    reason: 'invalid_handle',
  });
  assert.deepEqual(value.signals, []);
});

test('maps identity provider failure to unknown without signaling', async () => {
  const signals = [];
  const controller = new LocalProcessController({
    identityProvider: {
      inspect: async () => Promise.reject(new Error('proc unavailable')),
    },
    signalProcessGroup(processGroupId, signal) {
      signals.push({ processGroupId, signal });
    },
  });
  assert.deepEqual(await controller.stop(HANDLE), {
    status: 'unknown',
    reason: 'provider_unavailable',
  });
  assert.deepEqual(signals, []);
});
