const test = require('node:test');
const assert = require('node:assert/strict');
const { dashboardSnapshot } = require('../../back/shared/dashboardSnapshot');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a backwards wall clock cannot extend the display snapshot lifetime', async (t) => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const db = {};
  let calls = 0;
  assert.equal(await dashboardSnapshot(db, 'today', async () => ++calls), 1);
  now -= 60000;
  await sleep(1100);
  assert.equal(await dashboardSnapshot(db, 'today', async () => ++calls), 2);
});

test('eight viewers share one computation and a bounded snapshot; day/database changes and failures refresh', async () => {
  const db = {};
  let calls = 0,
    release;
  const compute = () => {
    calls++;
    return new Promise((r) => {
      release = r;
    });
  };
  const pending = Array.from({ length: 8 }, () =>
    dashboardSnapshot(db, 'today', compute),
  );
  await sleep(0);
  assert.equal(calls, 1);
  release({ count: 50000 });
  assert.deepEqual(await Promise.all(pending), Array(8).fill({ count: 50000 }));
  assert.deepEqual(
    await dashboardSnapshot(db, 'today', () => assert.fail('cache miss')),
    { count: 50000 },
  );
  await sleep(1010);
  assert.equal(await dashboardSnapshot(db, 'today', async () => ++calls), 2);
  assert.equal(await dashboardSnapshot(db, 'tomorrow', async () => ++calls), 3);
  assert.equal(await dashboardSnapshot({}, 'tomorrow', async () => ++calls), 4);
  await assert.rejects(
    dashboardSnapshot(db, 'bad', async () => {
      throw Error('sqlite busy');
    }),
    /sqlite busy/,
  );
  assert.equal(await dashboardSnapshot(db, 'bad', async () => ++calls), 5);
});
