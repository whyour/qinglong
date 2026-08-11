'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createWorkerSessionHeartbeatRequestBody,
  createWorkerSessionHeartbeatResponseBody,
  createWorkerSessionRegisterRequestBody,
  createWorkerSessionRegisterResponseBody,
  createWorkerSessionTransitionRequestBody,
  createWorkerSessionTransitionResponseBody,
  parseWorkerSessionHeartbeatRequestBody,
  parseWorkerSessionHeartbeatResponseBody,
  parseWorkerSessionRegisterRequestBody,
  parseWorkerSessionRegisterResponseBody,
  parseWorkerSessionTransitionRequestBody,
  parseWorkerSessionTransitionResponseBody,
} = require('@qinglong/runtime-core/worker-session-transport');

const authority = Object.freeze({
  workerId: 'edge-1',
  sessionId: '018f5c64-9b9d-7f1a-8c2d-1234567890ac',
});
const capabilitiesJson = '{}';
const capabilitiesHash =
  '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

function record(overrides = {}) {
  return {
    ...authority,
    generation: 2,
    status: 'online',
    version: 3,
    capabilitiesJson,
    capabilitiesHash,
    maxConcurrentRuns: 2,
    availableSlots: 1,
    registeredAtMs: 10,
    lastHeartbeatAtMs: 20,
    leaseExpiresAtMs: 50_000,
    updatedAtMs: 20,
    ...overrides,
  };
}

test('round-trips exact path-bound Session register wire', () => {
  const request = createWorkerSessionRegisterRequestBody({
    ...authority,
    capabilitiesJson,
    capabilitiesHash,
    maxConcurrentRuns: 2,
    availableSlots: 1,
    leaseDurationMs: 30_000,
  });
  assert.equal('workerId' in request, false);
  assert.deepEqual(parseWorkerSessionRegisterRequestBody(request, authority), {
    ...authority,
    capabilitiesJson,
    capabilitiesHash,
    maxConcurrentRuns: 2,
    availableSlots: 1,
    leaseDurationMs: 30_000,
  });
  const response = createWorkerSessionRegisterResponseBody({
    worker: record(),
    replacedSession: false,
  });
  assert.deepEqual(parseWorkerSessionRegisterResponseBody(response), response);
});

test('round-trips heartbeat and transition without duplicating path identity', () => {
  const heartbeat = createWorkerSessionHeartbeatRequestBody({
    ...authority,
    generation: 2,
    expectedVersion: 3,
    availableSlots: 1,
    leaseDurationMs: 30_000,
  });
  assert.equal('sessionId' in heartbeat, false);
  assert.deepEqual(
    parseWorkerSessionHeartbeatRequestBody(heartbeat, authority),
    { ...authority, generation: 2, expectedVersion: 3,
      availableSlots: 1, leaseDurationMs: 30_000 },
  );
  const transition = createWorkerSessionTransitionRequestBody({
    ...authority,
    generation: 2,
    expectedVersion: 4,
    status: 'draining',
  });
  assert.deepEqual(
    parseWorkerSessionTransitionRequestBody(transition, authority),
    { ...authority, generation: 2, expectedVersion: 4, status: 'draining' },
  );
  assert.deepEqual(
    parseWorkerSessionHeartbeatResponseBody(
      createWorkerSessionHeartbeatResponseBody(record()),
    ).status,
    'online',
  );
  assert.deepEqual(
    parseWorkerSessionTransitionResponseBody(
      createWorkerSessionTransitionResponseBody(record({
        status: 'draining', availableSlots: 0,
      })),
    ).status,
    'draining',
  );
});

test('rejects schema, field, capability and response authority drift', () => {
  const request = createWorkerSessionRegisterRequestBody({
    ...authority,
    capabilitiesJson,
    capabilitiesHash,
    maxConcurrentRuns: 2,
    availableSlots: 1,
    leaseDurationMs: 30_000,
  });
  assert.throws(
    () => parseWorkerSessionRegisterRequestBody(
      { ...request, workerId: authority.workerId }, authority,
    ),
    /shape is invalid/,
  );
  assert.throws(
    () => parseWorkerSessionRegisterRequestBody(
      { ...request, capabilitiesHash: 'a'.repeat(64) }, authority,
    ),
    /register command is invalid/,
  );
  const response = createWorkerSessionRegisterResponseBody({
    worker: record(), replacedSession: false,
  });
  assert.throws(
    () => parseWorkerSessionRegisterResponseBody({
      ...response, sessionId: 'wrong',
    }),
    /response authority is invalid/,
  );
  assert.throws(
    () => parseWorkerSessionHeartbeatResponseBody({
      ...createWorkerSessionHeartbeatResponseBody(record()), extra: true,
    }),
    /shape is invalid/,
  );
});
