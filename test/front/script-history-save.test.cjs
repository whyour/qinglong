const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const load = require('../helpers/load-security-module.cjs');

function fixture(send) {
  const dialogs = [],
    notices = [],
    calls = [];
  const request = {};
  for (const method of ['put', 'post'])
    request[method] = async (url, body, options) => {
      calls.push({ method, body });
      const result = await send(body);
      if (result.status) return options.onError(result);
      return result;
    };
  const { saveWithHistory } = load(
    path.resolve(__dirname, '../../src/pages/script/saveWithHistory.ts'),
    {
      '@/utils/http': { request },
      antd: {
        Modal: {
          confirm: (dialog) => {
            dialogs.push(dialog);
            return { update: (options) => Object.assign(dialog, options) };
          },
        },
        message: Object.fromEntries(
          ['error', 'warning', 'success'].map((type) => [
            type,
            (text) => notices.push({ type, text }),
          ]),
        ),
      },
      'react-intl-universal': {
        __esModule: true,
        default: { get: (key) => key },
      },
    },
  );
  return { saveWithHistory, dialogs, notices, calls };
}
const unavailable = {
  status: 413,
  data: { historyUnavailable: true, currentHash: 'a'.repeat(64) },
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('oversized editor save requires explicit confirmation and cancellation keeps the draft unsaved', async () => {
  const f = fixture(() => unavailable);
  const pending = f.saveWithHistory('put', '/api/scripts', {
    filename: 'large.js',
    content: 'small',
  });
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].content, /不会保留/);
  f.dialogs[0].onCancel();
  assert.equal(await pending, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.notices.length, 0);
});

test('debugger confirmation retries POST with the exact preview hash and displays a warning', async () => {
  const f = fixture((body) =>
    body.skipHistory
      ? { code: 200, data: { historyRecorded: false } }
      : unavailable,
  );
  const pending = f.saveWithHistory('post', '/api/scripts', {
    content: 'small',
  });
  await tick();
  await f.dialogs[0].onOk();
  assert.equal((await pending).code, 200);
  assert.equal(f.dialogs[0].cancelButtonProps.disabled, true);
  assert.equal(f.dialogs[0].keyboard, false);
  assert.equal(f.calls[1].method, 'post');
  assert.equal(f.calls[1].body.expectedHash, unavailable.data.currentHash);
  assert.equal(f.calls[1].body.skipHistory, true);
  assert.deepEqual(
    f.notices.map((v) => v.type),
    ['warning'],
  );
});

test('a stale confirmation reports the conflict without marking the editor saved', async () => {
  const f = fixture((body) =>
    body.skipHistory
      ? { status: 409, data: { message: 'changed' } }
      : unavailable,
  );
  const pending = f.saveWithHistory('put', '/api/scripts', {});
  await tick();
  await f.dialogs[0].onOk();
  assert.equal(await pending, undefined);
  assert.deepEqual(f.notices, [{ type: 'error', text: 'changed' }]);
});

test('unrelated errors never offer history bypass, and post-commit cleanup failures remain successful saves', async () => {
  const failed = fixture(() => ({
    status: 500,
    data: { message: 'storage failed' },
  }));
  assert.equal(
    await failed.saveWithHistory('put', '/api/scripts', {}),
    undefined,
  );
  assert.equal(failed.dialogs.length, 0);
  const committed = fixture(() => ({
    code: 200,
    data: { cleanupPending: true },
  }));
  assert.equal(
    (await committed.saveWithHistory('put', '/api/scripts', {})).code,
    200,
  );
  assert.equal(committed.notices[0].type, 'warning');
});
