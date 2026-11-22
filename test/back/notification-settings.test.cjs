const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../helpers/load-security-module.cjs');

test('notification settings keep missing-row errors, empty defaults and fresh reads', async () => {
  let row;
  const { readNotificationMode } = load('back/data/notificationSettings.ts', {
    './system': {
      AuthDataType: { notification: 'notification' },
      SystemModel: {
        findOne: async (query) => {
          assert.deepEqual(query, { where: { type: 'notification' } });
          return row;
        },
      },
    },
  });
  await assert.rejects(readNotificationMode(), {
    message: '{"type":"notification"} not found',
  });
  let info = null;
  row = {
    get(options) {
      assert.deepEqual(options, { plain: true });
      return { info };
    },
  };
  assert.deepEqual(await readNotificationMode(), {});
  info = { type: 'wpush', wpushApiKey: 'saved-key' };
  assert.deepEqual(await readNotificationMode(), info);
  info = { type: 'email' };
  assert.deepEqual(await readNotificationMode(), info);
});
