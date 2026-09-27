const test = require('node:test');
const assert = require('node:assert/strict');
const { createCronJob } = require('../../back/shared/cronScheduler');
const { isValidCronSchedule } = require('../../back/shared/cronSchedule');

// node-cron caches timezone formatters; model each deployment in a fresh process.
if (!process.env.QL_MACRO_TEST_TZ) {
  for (const tz of ['UTC', 'Asia/Shanghai']) {
    test(`macro execution in ${tz}`, () => {
      const result = require('node:child_process').spawnSync(process.execPath,
        ['-r', 'ts-node/register/transpile-only', '--test', __filename],
        { env: { ...process.env, TZ: tz, QL_MACRO_TEST_TZ: tz }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }
}
for (const tz of process.env.QL_MACRO_TEST_TZ ? [process.env.QL_MACRO_TEST_TZ] : []) {
  for (const [macro, start, next] of [
    ['@annually', [2026, 11, 31, 23, 59, 59], [[2027, 0, 1, 0, 0, 0], [2028, 0, 1, 0, 0, 0]]],
    ['@midnight', [2026, 8, 27, 23, 59, 59], [[2026, 8, 28, 0, 0, 0], [2026, 8, 29, 0, 0, 0]]],
    ['@minutely', [2026, 8, 27, 12, 34, 59], [[2026, 8, 27, 12, 35, 0], [2026, 8, 27, 12, 36, 0]]],
  ]) {
    test(`${macro} fires at the expected local times in ${tz}`, async (t) => {
      const previousTZ = process.env.TZ;
      process.env.TZ = tz;
      t.after(() => { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; });
      t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: new Date(...start) });
      const expected = next.map((parts) => new Date(...parts).getTime());
      const actual = [];
      assert.equal(isValidCronSchedule(` ${macro} `), true);
      const job = createCronJob(macro, (date) => actual.push(date.getTime()), {
        name: macro, logger: { warn() {}, error() {} },
      });
      t.after(() => job.cancel());
      for (const time of expected) {
        t.mock.timers.tick(time - Date.now() - 1);
        await new Promise(setImmediate);
        assert.equal(actual.includes(time), false, 'must not fire early');
        t.mock.timers.tick(1);
        await new Promise(setImmediate);
      }
      assert.deepEqual(actual, expected);
    });
  }
}

test('new aliases do not enable unknown macros or raw parser extensions', () => {
  for (const schedule of ['@annuallyx', '@midnightx', '@minutelyx', '@secondly', '@reboot', 'H * * * *', '0 /5 * * * *']) {
    assert.equal(isValidCronSchedule(schedule), false, schedule);
  }
});
