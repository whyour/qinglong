const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const load = require('../helpers/load-security-module.cjs');

const back = (file) => path.join(__dirname, '../../back', file);
const protocol = load(back('protos/api.ts'));
const constants = load(back('config/const.ts'), {
  './container': { maybeSudo: (x) => x },
});

test('WPUSH survives protobuf and JSON round trips without changing existing modes', () => {
  assert.equal(protocol.NotificationMode.wpush, 22);
  for (let value = 0; value <= 22; value++) {
    const name = protocol.notificationModeToJSON(value);
    assert.equal(protocol.notificationModeFromJSON(name), value);
    assert.equal(constants.NotificationModeStringMap[value], name);
  }
  const request = protocol.SystemNotifyRequest.create({
    title: 'title',
    content: 'content',
    notificationInfo: {
      type: 22,
      wpushApiKey: 'test-key',
      wpushChannel: 'feishu',
      wpushTopicCode: 'test-topic',
    },
  });
  const decoded = protocol.SystemNotifyRequest.decode(
    protocol.SystemNotifyRequest.encode(request).finish(),
  );
  assert.equal(decoded.notificationInfo.wpushApiKey, 'test-key');
  assert.equal(decoded.notificationInfo.wpushChannel, 'feishu');
  assert.equal(decoded.notificationInfo.wpushTopicCode, 'test-topic');
  assert.deepEqual(decoded, request);
  assert.deepEqual(
    protocol.SystemNotifyRequest.fromJSON(
      protocol.SystemNotifyRequest.toJSON(request),
    ),
    request,
  );
});

test('decoded SystemNotify requests reach WPUSH with explicit or saved configuration', async () => {
  const calls = [];
  const decorators = { Service: () => (x) => x, Inject: () => () => {} };
  const NotificationService = load(back('services/notify.ts'), {
    typedi: decorators,
    './user': {},
    '../config/util': {},
    '../shared/i18n': { t: (x) => x },
    '../config/http': {
      httpClient: {
        post: async (url, options) => {
          calls.push({ url, body: options.json });
          return { code: 0 };
        },
      },
    },
  }).default;
  const SystemService = load(back('services/system.ts'), {
    typedi: decorators,
    '../config': {},
    '../config/const': constants,
    '../config/util': {},
    '../data/dependence': {},
    '../data/system': {},
    '../shared/pLimit': {},
    '../schedule/client': {},
    '../shared/i18n': { t: (x) => x },
    './notify': {},
    './schedule': {},
    './sock': {},
  }).default;
  const notification = new NotificationService();
  notification.userService = {
    getNotificationMode: async () => ({
      type: 'wpush',
      wpushApiKey: 'saved-key',
    }),
  };
  const system = new SystemService();
  system.notificationService = notification;

  for (const info of [
    {
      type: 22,
      wpushApiKey: 'explicit-key',
      wpushChannel: 'feishu',
      wpushTopicCode: 'topic',
    },
    { type: 22, wpushApiKey: 'explicit-key' },
    undefined,
  ]) {
    const decoded = protocol.SystemNotifyRequest.decode(
      protocol.SystemNotifyRequest.encode(
        protocol.SystemNotifyRequest.create({
          title: 'title',
          content: 'content',
          notificationInfo: info,
        }),
      ).finish(),
    );
    assert.equal((await system.notify(decoded)).code, 200);
    assert.deepEqual(calls.at(-1), {
      url: 'https://api.wpush.cn/api/v1/send',
      body: {
        apikey: info ? 'explicit-key' : 'saved-key',
        title: 'title',
        content: 'content',
        channel: info?.wpushChannel || 'wechat',
        ...(info?.wpushTopicCode ? { topic_code: 'topic' } : {}),
      },
    });
  }
});
