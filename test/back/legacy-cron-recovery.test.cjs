const test = require('node:test');
const assert = require('node:assert/strict');
const { format } = require('node:util');
const load = require('../helpers/load-security-module.cjs');
const { SchedulerReadiness } = require('../../back/shared/schedulerReadiness');

const legacySchedules = [
  '* * * * *',
  '*/5  * * * *',
  '0 */10 * * * ?',
  '0 */2 * * * ?',
  '0 */5 * * * ?',
  '0 0/30 * * * ?',
  '0 0/5 * * * ?',
  '0 0 12 ? * MON',
];

test('API accepts legacy question-mark schedules but rejects malformed cron', () => {
  const { scheduleSchema } = load('back/validation/schedule.ts', {
    '../config': { logPath: '/ql/data/log' },
  });
  for (const schedule of [...legacySchedules, '@once', '@boot']) {
    assert.equal(scheduleSchema.validate(schedule).error, undefined, schedule);
  }
  for (const schedule of ['?', '0 /5 * * * ?', '0 70 * * * ?', 'not a cron']) {
    assert.ok(scheduleSchema.validate(schedule).error, schedule);
  }
});

test('legacy main and extra schedules restore real jobs and healthy readiness', async (t) => {
  const stacks = new Map();
  t.after(() => {
    for (const jobs of stacks.values()) for (const job of jobs) job.cancel();
  });
  const { addCron } = load('back/schedule/addCron.ts', {
    './data': { scheduleStacks: stacks },
    '../shared/runCron': { runCron() {} },
    '../loaders/logger': { info() {}, warn() {} },
    '../shared/i18n': { tf: format },
  });
  const crons = legacySchedules.map((schedule, index) => ({
    id: `legacy-${index}`, name: 'legacy', schedule, command: 'true',
    extra_schedules: [{ schedule: '0 0/30 * * * ?' }],
  }));
  const register = (rows) => new Promise((resolve, reject) => {
    addCron({ request: { replace: true, crons: rows } }, (error) =>
      error ? reject(error) : resolve());
  });
  const readiness = new SchedulerReadiness(async () => {}, 60000);
  t.after(() => clearTimeout(readiness.retry));
  readiness.configure(() => register(crons));
  assert.equal(await readiness.recover(), true);
  assert.equal(await readiness.check(), true);
  assert.equal(stacks.size, crons.length);
  for (const jobs of stacks.values()) {
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((job) => job.nextInvocation()));
  }
  const previousJobs = [...stacks.values()].flat();
  for (const schedule of ['?', '0 /5 * * * ?', '0 70 * * * ?']) {
    for (const invalid of [
      { ...crons[0], schedule },
      { ...crons[0], extra_schedules: [{ schedule }] },
    ]) {
      await assert.rejects(register([invalid]), (error) => error.code === 3);
      assert.deepEqual([...stacks.values()].flat(), previousJobs);
      assert.ok(previousJobs.every((job) => job.nextInvocation()));
    }
  }
});
