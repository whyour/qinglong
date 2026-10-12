const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const load = require('../helpers/load-security-module.cjs');

function script(config = {}, response = {}, auditError = false) {
  const logs = [],
    source = fs.readFileSync('sample/notify.js', 'utf8');
  const transport = async () => ({
    statusCode: response.httpStatus || 200,
    body: { text: async () => JSON.stringify(response) },
  });
  const context = {
    module: { exports: {} },
    console: { log() {}, info() {} },
    process: {
      env: { QL_DIR: '/fixture', HITOKOTO: 'false', ...config },
      argv: ['node', '/fixture/scripts/test-job.js'],
    },
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
  };
  context.require = (name) => {
    if (name === 'undici')
      return { request: transport, ProxyAgent: class {}, FormData };
    if (name === '/fixture/shell/preload/notificationAudit.js')
      return async (x) => {
        if (auditError) throw Error('offline');
        logs.push(x);
      };
    if (name === 'nodemailer')
      return {
        createTransport: () => ({
          sendMail: async () => {
            if (response.smtpFailure) throw Error('auth rejected');
            return { messageId: 'fixture' };
          },
          close() {},
        }),
      };
    return require(name);
  };
  vm.runInNewContext(source, context, {
    filename: path.resolve('sample/notify.js'),
  });
  return { send: context.module.exports.sendNotify, logs };
}

test('JS helper logs only configured channels, success/failure and script/task provenance', async () => {
  for (const fail of [false, true]) {
    const s = script(
      {
        SMTP_EMAIL: 'sender@example.test',
        SMTP_PASSWORD: 'private-password',
        SMTP_SERVICE: 'fixture',
        ID: '17',
      },
      { smtpFailure: fail },
    );
    await s.send('标题', '正文');
    assert.equal(s.logs.length, 1);
    assert.equal(s.logs[0].success, !fail);
    assert.equal(s.logs[0].notifyType, 'smtp');
    assert.equal(s.logs[0].scriptName, 'test-job.js');
    assert.equal(s.logs[0].taskId, '17');
    assert.ok(!JSON.stringify(s.logs).includes('private-password'));
  }
  const s = script();
  await s.send('none', 'none');
  assert.equal(s.logs.length, 0);
});

test('HTTP business rejection is audited as failure and logging errors do not change sends', async () => {
  for (const [code, success] of [
    [200, true],
    [500, false],
  ]) {
    const s = script({ BARK_PUSH: 'https://fixture.invalid' }, { code });
    await s.send('title', 'body');
    assert.equal(s.logs.length, 1);
    assert.equal(s.logs[0].success, success);
  }
  const offline = script(
    {
      SMTP_EMAIL: 'sender@example.test',
      SMTP_PASSWORD: 'fixture',
      SMTP_SERVICE: 'fixture',
    },
    {},
    true,
  );
  await offline.send('still sends', 'body');
});

test('multi-channel helpers write one result per actual channel', async () => {
  const s = script(
    {
      GOTIFY_URL: 'https://fixture.invalid',
      GOTIFY_TOKEN: 'private-token',
      SMTP_EMAIL: 'sender@example.test',
      SMTP_PASSWORD: 'fixture',
      SMTP_SERVICE: 'fixture',
    },
    { id: 123 },
  );
  await s.send('title', 'body');
  assert.deepEqual(s.logs.map((x) => x.notifyType).sort(), ['gotify', 'smtp']);
  assert.ok(s.logs.every((x) => x.success));
});

test('script audit protobuf round trips without notification credentials', () => {
  const p = load('back/protos/api.ts');
  const value = p.RecordNotifyLogRequest.create({
    title: '中文',
    content: '内容',
    success: false,
    notifyType: 'smtp',
    scriptName: 'job.py',
    taskId: '12',
  });
  assert.deepEqual(
    p.RecordNotifyLogRequest.decode(
      p.RecordNotifyLogRequest.encode(value).finish(),
    ),
    value,
  );
  assert.ok(p.ApiService.recordNotifyLog);
});

test('multi-target Chronocat records one failure if any recipient fails', async () => {
  let calls = 0;
  const response = {};
  Object.defineProperty(response, 'httpStatus', {
    get: () => (++calls === 1 ? 200 : 500),
  });
  const s = script(
    {
      CHRONOCAT_URL: 'https://fixture.invalid',
      CHRONOCAT_TOKEN: 'private-token',
      CHRONOCAT_QQ: 'user_id=123&group_id=456',
    },
    response,
  );
  await s.send('title', 'body');
  assert.equal(calls, 2);
  assert.equal(s.logs.length, 1);
  assert.equal(s.logs[0].success, false);
});
