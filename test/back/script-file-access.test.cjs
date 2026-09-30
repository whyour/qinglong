const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const load = require('../helpers/load-security-module.cjs');

test('script file operations allow token.json while protecting panel configuration', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-script-access-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of [
    'config/grpc',
    'scripts/ZaiZaiCat-Checkin',
    'scripts/token.json',
    'bak',
    'tmp',
  ])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  const config = {
    scriptPath: path.join(root, 'scripts'),
    configPath: path.join(root, 'config'),
    tmpPath: path.join(root, 'tmp'),
    bakPath: path.join(root, 'bak'),
    blackFileList: ['token.json', 'auth.json', 'grpc'],
  };
  config.writePathList = [config.configPath, config.scriptPath];
  const secret = path.join(config.configPath, 'token.json');
  fs.writeFileSync(secret, 'PANEL-SECRET');
  fs.symlinkSync(secret, path.join(config.scriptPath, 'secret-link'));
  fs.symlinkSync(
    config.configPath,
    path.join(config.scriptPath, 'config-link'),
  );
  fs.symlinkSync(secret, path.join(config.configPath, 'secret-alias'));
  const mocks = {
    '../config': config,
    '../config/const': {},
    '../config/util': {
      getFileContentByName: (p) => fs.promises.readFile(p, 'utf8'),
      fileExist: async (p) => fs.existsSync(p),
      rmPath: (p) => fs.promises.rm(p, { recursive: true }),
      readDir: async () => [],
    },
    '../shared/utils': {
      writeFileWithLock: (p, content) => fs.promises.writeFile(p, content),
    },
    '../shared/i18n': { t: (x) => x },
    './sock': {},
    './cron': {},
    './schedule': {},
    '../shared/pLimit': {},
    typedi: { Service: () => (x) => x, Inject: () => () => {} },
  };
  const Script = load(
    path.join(__dirname, '../../back/services/script.ts'),
    mocks,
  ).default;
  const service = new Script();
  mocks['../services/script'] = Script;
  mocks.typedi = { Container: { get: () => service } };
  const app = express.Router();
  load(path.join(__dirname, '../../back/api/script.ts'), mocks).default(app);
  const router = app.stack.find((layer) => layer.name === 'router').handle;
  const invoke = async (method, url, body = {}, query = {}, file) => {
    const route = router.stack.find(
      (layer) => layer.route?.path === url && layer.route.methods[method],
    ).route;
    let result;
    await route.stack.at(-1).handle(
      { body, query, file },
      {
        send: (value) => {
          result = value;
        },
        download: (p) => {
          result = { code: 200, data: fs.readFileSync(p, 'utf8') };
        },
      },
      (error) => {
        throw error;
      },
    );
    return result;
  };
  for (const directory of ['', 'ZaiZaiCat-Checkin']) {
    const filename = directory ? 'token.json' : 'auth.json';
    const body = {
      path: directory,
      filename,
      content: '{"account":"initial"}',
    };
    assert.equal((await invoke('post', '/', body)).code, 200);
    assert.deepEqual(
      await invoke('get', '/detail', {}, { path: directory, file: filename }),
      { code: 200, data: body.content },
    );
    assert.equal(
      (await invoke('put', '/', { ...body, content: '{"account":"updated"}' }))
        .code,
      200,
    );
    assert.deepEqual(await invoke('post', '/download', body), {
      code: 200,
      data: '{"account":"updated"}',
    });
    assert.equal(
      (await invoke('put', '/rename', { ...body, newFilename: 'renamed.json' }))
        .code,
      200,
    );
    assert.equal(
      (
        await invoke('put', '/rename', {
          ...body,
          filename: 'renamed.json',
          newFilename: filename,
        })
      ).code,
      200,
    );
    assert.equal((await invoke('delete', '/', body)).code, 200);
  }
  assert.equal(
    (await invoke('get', '/', {}, { path: 'token.json' })).code,
    200,
  );
  const upload = path.join(config.tmpPath, 'upload');
  fs.writeFileSync(upload, 'uploaded');
  assert.equal(
    (
      await invoke(
        'post',
        '/',
        { filename: 'token.json', path: 'ZaiZaiCat-Checkin' },
        {},
        { path: upload },
      )
    ).code,
    200,
  );
  assert.equal(
    await service.getFile('ZaiZaiCat-Checkin', 'token.json'),
    'uploaded',
  );
  for (const filename of [
    '../config/token.json',
    secret,
    'secret-link',
    'config-link/token.json',
  ]) {
    assert.equal(service.checkFilePath('', filename), '', filename);
    assert.equal(
      (await invoke('post', '/download', { filename })).code,
      403,
      filename,
    );
    assert.equal(
      (await invoke('put', '/', { filename, content: 'changed' })).code,
      403,
      filename,
    );
    if (!path.isAbsolute(filename))
      assert.equal(
        (await invoke('post', '/', { filename, content: 'changed' })).code,
        403,
        filename,
      );
  }
  for (const filename of [
    'token.json',
    'auth.json',
    'grpc/client.key',
    'secret-alias',
  ]) {
    assert.equal(
      (
        await invoke('post', '/', {
          path: config.configPath,
          filename,
          content: 'changed',
        })
      ).code,
      403,
      filename,
    );
  }
  assert.equal(fs.readFileSync(secret, 'utf8'), 'PANEL-SECRET');
  assert.equal(
    (
      await invoke('post', '/', {
        path: config.configPath,
        filename: 'normal.txt',
        content: 'normal',
      })
    ).code,
    200,
  );
});
