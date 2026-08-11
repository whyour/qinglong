'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  REMOTE_RUN_ACTIVATION_DELIVERY_SCHEMA,
  createRemoteRunActivationResponseBody,
  parseRemoteRunActivationResponse,
} = require('@qinglong/runtime-core/remote-activation-delivery');

function result(overrides = {}) {
  return {
    status: 'applied',
    snapshot: {
      runId: 'run-1',
      attemptId: 'attempt-1',
      runStatus: 'dispatching',
      attemptStatus: 'starting',
      leaseVersion: 4,
      leaseGeneration: 3,
      callbackSequence: 0,
      deadlineAtMs: 35_000,
    },
    ...overrides,
  };
}

test('round-trips one exact versioned activation response', () => {
  const body = createRemoteRunActivationResponseBody(result());
  assert.deepEqual(body, {
    schema: REMOTE_RUN_ACTIVATION_DELIVERY_SCHEMA,
    ...result(),
  });
  assert.deepEqual(
    parseRemoteRunActivationResponse(JSON.stringify(body)),
    result(),
  );
  assert.equal(Object.isFrozen(body), true);
  assert.equal(Object.isFrozen(body.snapshot), true);
});

test('rejects schema drift, unknown fields and incomplete terminal snapshots', () => {
  const body = createRemoteRunActivationResponseBody(result());
  assert.throws(
    () => parseRemoteRunActivationResponse(JSON.stringify({
      ...body,
      schema: 'qinglong/remote-run-activation@v2',
    })),
    /response schema is invalid/,
  );
  assert.throws(
    () => parseRemoteRunActivationResponse(JSON.stringify({
      ...body,
      capability: 'must-not-cross-wire',
    })),
    /response shape is invalid/,
  );
  assert.throws(
    () => createRemoteRunActivationResponseBody({
      status: 'already_terminal',
      snapshot: {},
    }),
    /snapshot shape is invalid/,
  );
});

test('bounds response bytes, status values and optional diagnostic fields', () => {
  assert.throws(
    () => parseRemoteRunActivationResponse(Buffer.alloc(16 * 1024 + 1)),
    /response byte size/,
  );
  assert.throws(
    () => createRemoteRunActivationResponseBody(result({
      snapshot: { ...result().snapshot, deadlineAtMs: -1 },
    })),
    /deadlineAtMs is invalid/,
  );
  assert.throws(
    () => createRemoteRunActivationResponseBody(result({ status: 'unknown' })),
    /status is invalid/,
  );
  assert.throws(
    () => createRemoteRunActivationResponseBody(result({
      status: 'already_running',
    })),
    /status and snapshot state disagree/,
  );
  assert.throws(
    () => createRemoteRunActivationResponseBody(result({
      snapshot: {
        ...result().snapshot,
        executorHandle: 'x'.repeat(513),
      },
    })),
    /executorHandle is invalid/,
  );
});
