require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Sequelize, DataTypes } = require('sequelize');
const dayjs = require('dayjs');
const express = require('express');

test('today failures includes recovered and deleted tasks, excluding previous days and successes', async (t) => {
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => db.close());
  const crons = db.define('Cron', {
    name: DataTypes.STRING,
    command: DataTypes.STRING,
  });
  const stats = db.define('Stat', {
    ref_id: DataTypes.INTEGER,
    date: DataTypes.STRING,
    fail_count: DataTypes.INTEGER,
    success_count: DataTypes.INTEGER,
  });
  const replacements = {
    '../../back/data/cron': { CrontabModel: crons },
    '../../back/data/cronStats': { CrontabStatModel: stats },
    '../../back/data/runningInstance': {},
    '../../back/shared/i18n': { tf: (format, id) => format.replace('%s', id) },
  };
  for (const [modulePath, exports] of Object.entries(replacements)) {
    const resolved = require.resolve(modulePath);
    const original = require.cache[resolved];
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports,
    };
    t.after(() => {
      if (original) require.cache[resolved] = original;
      else delete require.cache[resolved];
    });
  }
  await db.sync();
  await crons.bulkCreate([
    { id: 1, name: 'Recovered task', command: 'task recovered.js' },
    { id: 2, name: '', command: 'task unnamed.js' },
    { id: 3, name: 'Successful task', command: 'task success.js' },
  ]);
  const today = dayjs().format('YYYY-MM-DD');
  await stats.bulkCreate([
    { ref_id: 1, date: today, fail_count: 2, success_count: 1 },
    { ref_id: 2, date: today, fail_count: 1, success_count: 0 },
    { ref_id: 3, date: today, fail_count: 0, success_count: 4 },
    { ref_id: 4, date: today, fail_count: 3, success_count: 0 },
    {
      ref_id: 3,
      date: dayjs().subtract(1, 'day').format('YYYY-MM-DD'),
      fail_count: 10,
    },
  ]);
  const router = express.Router();
  require('../../back/api/dashboard').default(router);
  const dashboard = router.stack.find(
    (layer) => layer.name === 'router',
  ).handle;
  const handler = dashboard.stack.find(
    (layer) => layer.route?.path === '/failures',
  ).route.stack[0].handle;
  let response;
  await handler(
    {},
    {
      send: (value) => {
        response = value;
      },
    },
    (error) => {
      throw error;
    },
  );
  assert.deepEqual(response, {
    code: 200,
    data: [
      { id: 4, name: '任务#4', command: '', failCount: 3, deleted: true },
      {
        id: 1,
        name: 'Recovered task',
        command: 'task recovered.js',
        failCount: 2,
        deleted: false,
      },
      {
        id: 2,
        name: 'task unnamed.js',
        command: 'task unnamed.js',
        failCount: 1,
        deleted: false,
      },
    ],
  });
  await stats.destroy({ where: {} });
  await handler(
    {},
    {
      send: (value) => {
        response = value;
      },
    },
    (error) => {
      throw error;
    },
  );
  assert.deepEqual(response, { code: 200, data: [] });
  await stats.drop();
  let forwarded;
  await handler(
    {},
    { send: () => assert.fail('must forward database errors') },
    (error) => {
      forwarded = error;
    },
  );
  assert.ok(forwarded instanceof Error);
});
