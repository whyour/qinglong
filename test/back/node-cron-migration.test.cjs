const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../helpers/load-security-module.cjs');
const { createCronJob } = require('../../back/shared/cronScheduler');
const logger = { info() {}, warn() {}, error() {} };

test('native calendar skips nonexistent spring time and duplicate fall hour', async (t) => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date('2026-03-08T05:00:00Z') });
  const springRuns = [];
  const spring = createCronJob('0 30 2 * * *', (date) => springRuns.push(date.toISOString()), { name: 'spring', logger });
  t.after(() => spring.cancel());
  t.mock.timers.tick(new Date('2026-03-09T06:30:00Z') - Date.now());
  await new Promise(setImmediate);
  assert.deepEqual(springRuns, ['2026-03-09T06:30:00.000Z']);
  spring.cancel();
  t.mock.timers.setTime(new Date('2026-11-01T05:30:00Z').getTime());
  const fallRuns = [];
  const fall = createCronJob('0 30 1 * * *', (date) => fallRuns.push(date.toISOString()), { name: 'fall', logger });
  t.after(() => fall.cancel());
  t.mock.timers.tick(new Date('2026-11-02T06:30:00Z') - Date.now());
  await new Promise(setImmediate);
  assert.deepEqual(fallRuns, ['2026-11-02T06:30:00.000Z']);
});

test('construction failure cleans staged jobs and preserves the running snapshot', async () => {
  const cancelled = [];
  const stacks = new Map([['old', [{ cancel: () => cancelled.push('old') }]]]);
  let count = 0;
  const { addCron } = load('back/schedule/addCron.ts', {
    './data': { scheduleStacks: stacks },
    '../shared/cronScheduler': { createCronJob: () => {
      if (++count === 2) throw Error('construction failed');
      return { start() { throw Error('must not start'); }, cancel: () => cancelled.push('staged') };
    } },
    '../shared/runCron': {}, '../loaders/logger': logger, '../shared/i18n': { tf: require('node:util').format },
  });
  await assert.rejects(new Promise((resolve, reject) => addCron({ request: {
    replace: true, crons: [{ id: 'new', schedule: '* * * * *', extra_schedules: [{ schedule: '0 * * * *' }] }],
  } }, (error) => error ? reject(error) : resolve())), /construction failed/);
  assert.deepEqual([...stacks.keys()], ['old']);
  assert.deepEqual(cancelled, ['staged']);
});

test('invalid subscription schedules are isolated and immediate runs without a schedule survive', async () => {
  const warnings = [], runs = [];
  const Service = load('back/services/schedule.ts', {
    typedi: { Service: () => (x) => x, Inject: () => () => {} },
    '../shared/pLimit': {},
  }).default;
  const service = new Service({ ...logger, warn: (...args) => warnings.push(args) });
  service.runTask = async (...args) => { runs.push(args); };
  const item = { id: 123, name: 'subscription', command: 'true', runOrigin: 'subscription' };
  await service.createCronTask({ ...item, schedule: 'not a cron' });
  assert.equal(warnings.length, 1);
  assert.equal(service.scheduleStacks.size, 0);
  await service.createCronTask(item, {}, true);
  assert.equal(runs.length, 1);
  await service.createCronTask({ ...item, schedule: '* * * * *' });
  assert.equal(service.scheduleStacks.size, 1);
  await service.cancelCronTask(item);
  assert.equal(service.scheduleStacks.size, 0);
});
