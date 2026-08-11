const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createClusterControlAuthenticationShield,
} = require('../dist/authentication/authenticationShield.js');

function shield(overrides = {}) {
  let currentTime = 1000;
  const instance = createClusterControlAuthenticationShield({
    windowMs: 1000,
    maxRequestsPerPeer: 1,
    maxRequestsGlobal: 3,
    maxTrackedPeers: 2,
    now: () => currentTime,
    ...overrides,
  });
  return {
    instance,
    advance(milliseconds) {
      currentTime += milliseconds;
    },
    setTime(value) {
      currentTime = value;
    },
  };
}

function assertAllowed(result) {
  assert.equal(result.allowed, true);
  assert.equal(typeof result.refund, 'function');
  return result;
}

test('bounds per-peer and aggregate attempts in a process-local window', () => {
  const { instance } = shield();

  assertAllowed(instance.consume('192.0.2.10'));
  assert.deepEqual(instance.consume('192.0.2.10'), {
    allowed: false,
    reason: 'peer',
    retryAfterMs: 1000,
  });
  assertAllowed(instance.consume('192.0.2.11'));
  assert.deepEqual(instance.consume('192.0.2.12'), {
    allowed: false,
    reason: 'global',
    retryAfterMs: 1000,
  });
  instance.close();
});

test('keeps peer state bounded and reclaims expired windows lazily', () => {
  const clock = shield({ maxRequestsGlobal: 20 });

  assertAllowed(clock.instance.consume('192.0.2.10'));
  assertAllowed(clock.instance.consume('192.0.2.11'));
  assert.deepEqual(clock.instance.consume('192.0.2.12'), {
    allowed: false,
    reason: 'capacity',
    retryAfterMs: 1000,
  });
  clock.advance(1000);
  assertAllowed(clock.instance.consume('192.0.2.12'));
  clock.instance.close();
});

test('fails closed on a broken monotonic clock and after disposal', () => {
  const clock = shield({ maxRequestsPerPeer: 20, maxRequestsGlobal: 20 });
  assertAllowed(clock.instance.consume(undefined));
  clock.setTime(999);
  assert.deepEqual(clock.instance.consume(undefined), {
    allowed: false,
    reason: 'clock',
    retryAfterMs: 1000,
  });
  clock.instance.close();
  assert.deepEqual(clock.instance.consume('192.0.2.10'), {
    allowed: false,
    reason: 'clock',
    retryAfterMs: 1000,
  });
});

test('refunds only the exact successful authentication attempt once', () => {
  const { instance } = shield({
    maxRequestsPerPeer: 1,
    maxRequestsGlobal: 1,
  });
  const first = assertAllowed(instance.consume('192.0.2.10'));
  assert.deepEqual(instance.consume('192.0.2.10'), {
    allowed: false,
    reason: 'global',
    retryAfterMs: 1000,
  });

  first.refund();
  first.refund();
  const second = assertAllowed(instance.consume('192.0.2.10'));
  second.refund();
  assertAllowed(instance.consume('192.0.2.11'));
  instance.close();
});

test('a delayed refund cannot alter a replacement window', () => {
  const clock = shield({
    maxRequestsPerPeer: 1,
    maxRequestsGlobal: 1,
  });
  const expired = assertAllowed(clock.instance.consume('192.0.2.10'));
  clock.advance(1000);
  assertAllowed(clock.instance.consume('192.0.2.10'));

  expired.refund();
  assert.deepEqual(clock.instance.consume('192.0.2.11'), {
    allowed: false,
    reason: 'global',
    retryAfterMs: 1000,
  });
  clock.instance.close();
});
