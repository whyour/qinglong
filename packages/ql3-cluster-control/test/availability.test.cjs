const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterControlAvailabilityFence,
} = require('@qinglong/cluster-control/availability');

test('signals one bound listener exactly once without a retry path', async () => {
  const fence = new ClusterControlAvailabilityFence();
  const reasons = [];
  const unsubscribe = fence.subscribe(async (error) => {
    reasons.push(error.message);
  });

  assert.equal(fence.status, 'available');
  assert.equal(await fence.signal(new Error('connection lost')), 'signaled');
  assert.equal(fence.status, 'unavailable');
  assert.equal(
    await fence.signal(new Error('second connection lost')),
    'already_unavailable',
  );
  assert.deepEqual(reasons, ['connection lost']);
  unsubscribe();
  unsubscribe();
  fence.dispose();
  assert.equal(fence.status, 'disposed');
  assert.equal(await fence.signal(new Error('after dispose')), 'disposed');
});

test('delivers an early signal when the single application listener binds', async () => {
  const fence = new ClusterControlAvailabilityFence();
  assert.equal(await fence.signal(new Error('early failure')), 'signaled');
  let reason;
  fence.subscribe((error) => {
    reason = error.message;
  });
  await Promise.resolve();
  assert.equal(reason, 'early failure');
  assert.throws(() => fence.subscribe(() => {}), /already bound/);
  await assert.rejects(() => fence.signal('invalid'), /error is invalid/);
});
