const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const dayjs = require('dayjs');
const load = require('../helpers/load-security-module.cjs');

test('subscription becomes idle and closes its log even when completion logging fails', async () => {
  const updates = [];
  let closed = 0;
  let notified = 0;
  const Subscription = load(path.resolve('back/services/subscription.ts'), {
    '../config': {},
    '../data/subscription': {
      SubscriptionModel: { update: async (values) => updates.push(values) },
      SubscriptionStatus: { idle: 1 },
    },
    '../data/cron': {},
    '../config/util': { handleLogPath: async () => '/tmp/unused-log' },
    '../config/const': { LOG_END_SYMBOL: 'end' },
    '../config/subscription': {},
    '../shared/i18n': { t: (s) => s, tf: (s) => s },
    '../shared/pLimit': {},
    '../shared/logReader': {},
    '../shared/logStreamManager': {
      logStreamManager: {
        write: async () => {
          throw new Error('ENOSPC');
        },
        closeStream: async () => {
          closed++;
          throw new Error('ENOSPC');
        },
      },
    },
    './schedule': {},
    './sock': {},
    './sshKey': {},
    './cron': {},
  }).default;
  const service = new Subscription(
    {},
    {},
    { sendMessage: () => notified++ },
    {},
    {},
  );
  service.getDb = async () => ({ id: 1, log_path: 'log' });
  const callbacks = service.taskCallbacks({ id: 1 });
  await assert.rejects(callbacks.onEnd(undefined, dayjs(), 1), /ENOSPC/);
  assert.equal(closed, 1);
  assert.equal(updates.at(-1).status, 1);
  assert.equal(notified, 1);
});
