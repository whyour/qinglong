const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidCronSchedule } = require('../../back/shared/cronSchedule');
const { createCronJob } = require('../../back/shared/cronScheduler');
const legacy = require('../fixtures/legacy-cron.json');
const logger = { warn() {}, error() {} };
const flush = () => new Promise(setImmediate);

test('validation preserves legacy syntax except the explicitly added macros', () => {
  const addedMacros = new Set(['@annually', '@midnight', '@minutely']);
  assert.ok(legacy.validation.length > 250);
  for (const { schedule, accepted } of legacy.validation) {
    assert.equal(isValidCronSchedule(schedule), accepted || addedMacros.has(schedule), schedule);
  }
});

for (const sample of legacy.times) {
  test(`calendar compatibility: ${sample.schedule} from ${sample.currentDate}`, async (t) => {
    const previousTZ = process.env.TZ;
    process.env.TZ = 'UTC';
    t.after(() => { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; });
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date(sample.currentDate) });
    const actual = [];
    const job = createCronJob(sample.schedule, (date) => actual.push(date.toISOString()), { name: 'calendar', logger });
    t.after(() => job.cancel());
    for (const expected of sample.next) {
      t.mock.timers.tick(new Date(expected).getTime() - Date.now());
      await flush();
    }
    assert.deepEqual(actual, sample.next);
  });
}

test('late callbacks catch up exactly once and cancellation destroys native tasks', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date('2026-09-27T00:00:00Z') });
  const native = require('node-cron');
  const before = native.getTasks().size;
  const dates = [], warnings = [];
  const job = createCronJob('* * * * * *', (date) => dates.push(date.getTime()), {
    name: 'late', logger: { warn: (...args) => warnings.push(args), error() {} },
  });
  t.after(() => job.cancel());
  t.mock.timers.tick(8000);
  await flush();
  assert.equal(dates.length, 8);
  assert.equal(new Set(dates).size, 8);
  assert.ok(warnings.length > 0);
  job.cancel();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(dates.length, 8);
  assert.equal(native.getTasks().size, before);
});

test('callback rejection is logged and future executions continue', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date('2026-09-27T00:00:00Z') });
  const errors = [];
  let count = 0;
  const job = createCronJob('* * * * * *', async () => { count++; throw Error('callback failed'); }, {
    name: 'failure', logger: { warn() {}, error: (...args) => errors.push(args) },
  });
  t.after(() => job.cancel());
  t.mock.timers.tick(1000);
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(count, 2);
  assert.equal(errors.length, 2);
});
