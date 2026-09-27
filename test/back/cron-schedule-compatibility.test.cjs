const test = require('node:test');
const assert = require('node:assert/strict');
const nodeSchedule = require('node-schedule');
const { isValidCronSchedule } = require('../../back/shared/cronSchedule');

test('validation agrees with the actual scheduler across legacy cron syntax', () => {
  const candidates = new Set([
    '*', '0', '?', '0 0', '0 0 *', '0 0 * *',
    '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight',
    '@hourly', '@secondly', '@minutely', '@weekdays', '@weekends', '@reboot',
    '0 0 1 1 * 2027', '0 0 0 L * *', '0 0 0 * * 5L',
    '0 0 0 * * MON#2', '0 0 12 LW * *', '0 0 12 15W * *',
    '0 0 0 ? * MON', '0 0/30 * * * ?', '0 /5 * * * *',
  ]);
  const fields = [
    ['*', '?', '/5', '*/5', '0/5', '0', '01', '1-5', '1,3', '5-1', 'H', 'H/5', 'H(0-10)', 'L'],
    ['*', '?', '/5', '*/5', '0/5', '0', '01', '1-5', '1,3', '5-1', 'H', 'H/5', 'H(0-10)', 'L'],
    ['*', '?', '/2', '*/2', '0/2', '0', '01', '1-5', '1,3', '23-2', 'H', 'L'],
    ['*', '?', '/2', '*/2', '1/2', '1', '01', '1-5', '1,3', 'L', 'L-1', 'LW', '15W', 'H'],
    ['*', '?', '/2', '*/2', '1/2', '1', '01', '1-5', '1,3', 'JAN', 'jan', 'JAN-MAR', 'DEC-FEB', 'H'],
    ['*', '?', '/2', '*/2', '0/2', '0', '7', '01', '1-5', '1,3', 'MON', 'mon', 'MON-FRI', 'FRI-MON', '5L', 'L', 'MON#2', '1#5', 'H'],
  ];
  fields.forEach((options, index) => options.forEach((field) => {
    const values = ['0', '0', '0', '*', '*', '*'];
    values[index] = field;
    candidates.add(values.join(' '));
  }));
  for (const value of [...candidates]) {
    if (value.split(' ').length === 6) {
      candidates.add(` ${value} `);
      candidates.add(value.split(' ').slice(1).join(' '));
    }
  }
  for (const value of candidates) {
    const job = nodeSchedule.scheduleJob(value, () => {});
    const accepted = Boolean(job);
    job?.cancel();
    assert.equal(isValidCronSchedule(value), accepted, value);
  }
  assert.ok(candidates.size > 250);
});
