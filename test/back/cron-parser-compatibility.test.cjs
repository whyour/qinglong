const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('node-cron');
const {
  parseCronSchedule,
  isValidCronSchedule,
  getInvalidCronSchedules,
} = require('../../back/shared/cronSchedule');
const { createCronJob } = require('../../back/shared/cronScheduler');

const logger = { warn() {}, error() {} };

// Issue #3099: cron-parser 5.4 stringifies these hours as 6/6, which
// node-cron rejects. Preserve supported fields and observe actual executions.
const cases = [
  ...[
    '0 6,12,18 * * *',
    '0 0 6,12,18 * * *',
    '0 6-18/6 * * *',
    '0 6/6 * * *',
  ].map((schedule) => ({
    schedule,
    next: [
      '2026-10-17T06:00:00.000Z',
      '2026-10-17T12:00:00.000Z',
      '2026-10-17T18:00:00.000Z',
      '2026-10-18T06:00:00.000Z',
    ],
  })),
  {
    schedule: '5,15,25 * * * *',
    next: [
      '2026-10-17T00:05:00.000Z',
      '2026-10-17T00:15:00.000Z',
      '2026-10-17T00:25:00.000Z',
      '2026-10-17T01:05:00.000Z',
    ],
  },
  {
    schedule: '5,15,25 * * * * *',
    next: [
      '2026-10-17T00:00:05.000Z',
      '2026-10-17T00:00:15.000Z',
      '2026-10-17T00:00:25.000Z',
      '2026-10-17T00:01:05.000Z',
    ],
  },
  {
    schedule: '5/20 * * * * *',
    next: [
      '2026-10-17T00:00:05.000Z',
      '2026-10-17T00:00:25.000Z',
      '2026-10-17T00:00:45.000Z',
      '2026-10-17T00:01:05.000Z',
    ],
  },
  {
    schedule: '5/20 * * * *',
    next: [
      '2026-10-17T00:05:00.000Z',
      '2026-10-17T00:25:00.000Z',
      '2026-10-17T00:45:00.000Z',
      '2026-10-17T01:05:00.000Z',
    ],
  },
  {
    schedule: '0 0 1/10,L * MON',
    next: [
      '2026-10-19T00:00:00.000Z',
      '2026-10-21T00:00:00.000Z',
      '2026-10-26T00:00:00.000Z',
      '2026-10-31T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
    ],
  },
  {
    schedule: '0 0 1 JAN/3 *',
    next: [
      '2027-01-01T00:00:00.000Z',
      '2027-04-01T00:00:00.000Z',
      '2027-07-01T00:00:00.000Z',
      '2027-10-01T00:00:00.000Z',
    ],
  },
  {
    schedule: '0 0 * * MON/2',
    next: [
      '2026-10-18T00:00:00.000Z',
      '2026-10-19T00:00:00.000Z',
      '2026-10-21T00:00:00.000Z',
      '2026-10-23T00:00:00.000Z',
      '2026-10-25T00:00:00.000Z',
    ],
  },
  {
    schedule: '0 0 * * 00#02',
    next: [
      '2026-11-08T00:00:00.000Z',
      '2026-12-13T00:00:00.000Z',
      '2027-01-10T00:00:00.000Z',
      '2027-02-14T00:00:00.000Z',
    ],
  },
  ...['*#2', '?#2'].map((weekday) => ({
    schedule: `0 0 * * ${weekday}`,
    next: [
      '2026-10-18T00:00:00.000Z',
      '2026-10-19T00:00:00.000Z',
      '2026-10-20T00:00:00.000Z',
      '2026-10-21T00:00:00.000Z',
    ],
  })),
];

test('supported fields retain their lists, ranges, names and special days', () => {
  for (const [schedule, patterns] of [
    ['0 6,12,18 * * *', ['0 0 6,12,18 * * *']],
    ['5,15,25 * * JAN-MAR MON-FRI', ['0 5,15,25 * * JAN-MAR MON-FRI']],
    ['0 0 L JAN *', ['0 0 0 L JAN *']],
    ['0 0 * JAN MON#2', ['0 0 0 * JAN MON#2']],
    ['0 0 1,15 JAN MON', ['0 0 0 1,15 JAN *', '0 0 0 * JAN MON']],
    ['0 0 ? * MON', ['0 0 0 * * MON']],
  ]) {
    assert.deepEqual(parseCronSchedule(schedule).patterns, patterns, schedule);
  }
});

for (const [schedule, patterns, maxValidations] of [
  ['0 6,12,18 * * *', ['0 0 6,12,18 * * *'], 2],
  ['0 0 1,15 JAN MON', ['0 0 0 1,15 JAN *', '0 0 0 * JAN MON'], 3],
]) {
  test(`supported expressions skip field validation: ${schedule}`, () => {
    const load = require('../helpers/load-security-module.cjs');
    const validations = [];
    const isolated = load('back/shared/cronSchedule.ts', {
      'node-cron': {
        validate(pattern) {
          validations.push(pattern);
          return validate(pattern);
        },
      },
    });

    assert.deepEqual(isolated.parseCronSchedule(schedule).patterns, patterns);
    assert.ok(validations.length <= maxValidations, validations.join('\n'));
    assert.equal(validations[0], `0 ${schedule}`);
  });
}

for (const { schedule, next } of cases) {
  test(`cron-parser normalization preserves executions: ${schedule}`, async (t) => {
    const previousTZ = process.env.TZ;
    process.env.TZ = 'UTC';
    t.after(() => {
      if (previousTZ === undefined) delete process.env.TZ;
      else process.env.TZ = previousTZ;
    });
    t.mock.timers.enable({
      apis: ['Date', 'setTimeout', 'setInterval'],
      now: new Date('2026-10-17T00:00:00Z'),
    });

    assert.equal(isValidCronSchedule(schedule), true);
    assert.ok(parseCronSchedule(schedule).patterns.every(validate));
    assert.deepEqual(
      getInvalidCronSchedules({
        schedule,
        extra_schedules: [{ schedule }],
      }),
      [],
    );

    const actual = [];
    const job = createCronJob(
      schedule,
      (date) => actual.push(date.toISOString()),
      { name: 'issue-3099', logger },
    );
    t.after(() => job.cancel());
    for (const [index, expected] of next.entries()) {
      t.mock.timers.tick(new Date(expected).getTime() - Date.now() - 1);
      await new Promise(setImmediate);
      assert.deepEqual(actual, next.slice(0, index));
      t.mock.timers.tick(1);
      await new Promise(setImmediate);
      assert.deepEqual(actual, next.slice(0, index + 1));
    }
  });
}
