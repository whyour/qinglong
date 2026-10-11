const assert = require('node:assert/strict');
const test = require('node:test');

const configPath = require.resolve('../../back/config');
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { __esModule: true, default: { logPath: '/ql/data/log' } },
  children: [],
  paths: [],
};

const { commonCronSchema } = require('../../back/validation/schedule');
const { Joi } = require('celebrate');

const schema = Joi.object(commonCronSchema);

test('cron validation accepts leading-zero schedules and legacy null labels', () => {
  const result = schema.validate({
    name: 'legacy cron',
    command: 'task legacy.js',
    schedule: '01 7 * * *',
    labels: null,
  });

  assert.equal(result.error, undefined);
});

test('cron validation identifies invalid fields', () => {
  const result = schema.validate(
    {
      name: 'invalid cron',
      command: 'task invalid.js',
      schedule: '01 7 * * *',
      allow_multiple_instances: '',
    },
    { abortEarly: false },
  );

  assert.deepEqual(
    [...new Set(result.error.details.map((detail) => detail.path.join('.')))],
    ['allow_multiple_instances'],
  );
});
