require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const {
  observeLegacyChildProcess,
} = require('../../back/runtime/compatibility/observeLegacyChildProcess');

function recordingObservation() {
  const facts = [];
  return {
    facts,
    observation: {
      spawned(fact) {
        facts.push(['spawned', fact]);
      },
      running(fact) {
        facts.push(['running', fact]);
      },
      startFailed(fact) {
        facts.push(['start_failed', fact]);
      },
      exited(fact) {
        facts.push(['exited', fact]);
      },
      cancelled(fact) {
        facts.push(['cancelled', fact]);
      },
    },
  };
}

test('observes an existing child lifecycle without creating another process', () => {
  const child = new EventEmitter();
  child.pid = 4242;
  const { facts, observation } = recordingObservation();
  const timestamps = [100, 101];

  observeLegacyChildProcess(child, observation, {
    now: () => timestamps.shift(),
    logArtifactId: 'legacy-log-1',
  });
  child.emit('spawn');
  child.emit('exit', 0, null);

  assert.deepEqual(facts, [
    [
      'spawned',
      {
        atMs: 100,
        pid: 4242,
        executorHandle: 'legacy-local:4242',
        logArtifactId: 'legacy-log-1',
      },
    ],
    ['running', { atMs: 100 }],
    ['exited', { atMs: 101, exitCode: 0 }],
  ]);
});

test('maps child errors and signals to bounded observation facts', () => {
  const child = new EventEmitter();
  const { facts, observation } = recordingObservation();
  const timestamps = [200, 201];

  observeLegacyChildProcess(child, observation, {
    now: () => timestamps.shift(),
  });
  child.emit('error', new Error('must not leak'));
  child.emit('exit', null, 'SIGTERM');

  assert.deepEqual(facts, [
    ['start_failed', { atMs: 200, errorCode: 'LEGACY_PROCESS_ERROR' }],
    ['exited', { atMs: 201, exitCode: null, signal: 'SIGTERM' }],
  ]);
});
