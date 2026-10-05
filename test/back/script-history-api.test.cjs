const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { errors } = require('celebrate');
const load = require('../helpers/load-security-module.cjs');
const { resolveFileAccess } = load(
  path.join(__dirname, '../../back/shared/fileAccess.ts'),
);

test('script routes save, list, preview and restore, with validation and conflict responses', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-history-api-'));
  const scripts = path.join(root, 'scripts');
  await fs.mkdir(scripts);
  await fs.writeFile(path.join(scripts, 'test.js'), 'before');
  const config = {
    scriptPath: scripts,
    dataPath: root,
    blackFileList: ['auth.json'],
    writePathList: [scripts],
  };
  class ScriptService {
    checkFilePath(dir, name) {
      return resolveFileAccess(scripts, [dir || '', name]);
    }
  }
  const api = load(path.join(__dirname, '../../back/api/script.ts'), {
    '../config': { default: config, __esModule: true },
    '../config/util': {
      fileExist: async (file) =>
        fs.access(file).then(
          () => true,
          () => false,
        ),
    },
    '../services/script': { default: ScriptService, __esModule: true },
    '../shared/i18n': { t: (value) => value },
    typedi: { Container: { get: () => new ScriptService() } },
  });
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  api.default(app);
  app.use(errors());
  app.use((error, _req, res, _next) =>
    res.status(500).json({ error: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, body, method = 'PUT') => {
    const res = await fetch(
      base + url,
      body && {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return { status: res.status, body: await res.json() };
  };
  assert.equal(
    (await call('/scripts', { filename: 'test.js', content: 'after' })).body
      .code,
    200,
  );
  const list = await call('/scripts/history?filename=test.js');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.versions.length, 1);
  const id = list.body.data.versions[0].id;
  const preview = await call(
    `/scripts/history/detail?filename=test.js&id=${id}`,
  );
  assert.equal(preview.body.data.version.content, 'before');
  assert.equal(preview.body.data.current, 'after');
  assert.equal(
    (await call('/scripts/history/restore', { filename: 'test.js', id }))
      .status,
    400,
  );
  assert.equal(
    (
      await call('/scripts/history/restore', {
        filename: 'test.js',
        id,
        expectedHash: '0'.repeat(64),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call('/scripts/history/restore', {
        filename: 'test.js',
        id,
        expectedHash: preview.body.data.currentHash,
      })
    ).status,
    200,
  );
  assert.equal(
    await fs.readFile(path.join(scripts, 'test.js'), 'utf8'),
    'before',
  );
  assert.equal(
    (await call('/scripts/history?filename=..%2Foutside')).status,
    403,
  );
  assert.equal((await call('/scripts/history?filename=missing')).status, 404);
  for (const content of ['debug-C', 'debug-D']) {
    const saved = await call(
      '/scripts',
      { filename: 'test.js', originFilename: 'test.js', path: '', content },
      'POST',
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.historyRecorded, true);
  }
  const debugList = await call('/scripts/history?filename=test.js');
  const newest = await call(
    `/scripts/history/detail?filename=test.js&id=${debugList.body.data.versions[0].id}`,
  );
  assert.equal(newest.body.data.version.content, 'debug-C');
  assert.equal(newest.body.data.current, 'debug-D');

  // Both editor PUT and debugger POST support the same explicit opt-out.
  for (const method of ['PUT', 'POST']) {
    await fs.writeFile(
      path.join(scripts, 'large.js'),
      'x'.repeat(1024 * 1024 + 1),
    );
    const payload = { filename: 'large.js', path: '', content: 'small' };
    const rejected = await call('/scripts', payload, method);
    assert.equal(rejected.status, 413);
    assert.equal(rejected.body.historyUnavailable, true);
    assert.equal(
      (await call('/scripts', { ...payload, skipHistory: true }, method))
        .status,
      400,
    );
    const saved = await call(
      '/scripts',
      {
        ...payload,
        skipHistory: true,
        expectedHash: rejected.body.currentHash,
      },
      method,
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.historyRecorded, false);
    assert.equal(
      await fs.readFile(path.join(scripts, 'large.js'), 'utf8'),
      'small',
    );
  }
});
