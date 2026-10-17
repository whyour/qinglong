const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createCronJob } = require('../../back/shared/cronScheduler');
const { isValidCronSchedule } = require('../../back/shared/cronSchedule');
const native = require('node-cron');
const fixture = require('../fixtures/cron-calendar-boundaries.json');

// Each deployment gets a fresh timezone formatter cache in node-cron.
const timezone = process.env.QL_CRON_BOUNDARY_TEST_TZ;
if (!timezone) {
  for (const tz of ['UTC', 'Asia/Shanghai']) {
    test(`cron calendar boundary regressions in ${tz}`, () => {
      const env = { ...process.env, TZ: tz, QL_CRON_BOUNDARY_TEST_TZ: tz };
      // A nested --test runner otherwise exits successfully without running tests.
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(
        process.execPath,
        ['-r', 'ts-node/register/transpile-only', '--test', __filename],
        {
          env,
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /calendar boundary:/);
    });
  }
} else {
  for (const { schedule, currentDate, next } of fixture.cases) {
    test(`calendar boundary: ${schedule} from ${currentDate}`, async (t) => {
      t.mock.timers.enable({
        apis: ['Date', 'setTimeout', 'setInterval'],
        now: new Date(currentDate),
      });
      const before = native.getTasks().size;
      const actual = [];
      const job = createCronJob(
        schedule,
        (date) => actual.push(date.toISOString()),
        { name: 'calendar-boundary', logger: { warn() {}, error() {} } },
      );
      t.after(() => job.cancel());

      for (const [index, expected] of next[timezone].entries()) {
        t.mock.timers.tick(new Date(expected).getTime() - Date.now() - 1);
        await new Promise(setImmediate);
        assert.deepEqual(actual, next[timezone].slice(0, index));
        t.mock.timers.tick(1);
        await new Promise(setImmediate);
        assert.deepEqual(actual, next[timezone].slice(0, index + 1));
      }
      job.cancel();
      assert.equal(native.getTasks().size, before);
    });
  }

  test('unreachable dates and unsupported L spellings remain invalid', () => {
    for (const schedule of [
      '0 0 31 2,4 *',
      '0 0 31 2,4 0-7',
      '0 0 1L 2,4 MON',
      '0 0 * * 05L',
    ]) {
      assert.equal(isValidCronSchedule(schedule), false, schedule);
    }
  });
}
