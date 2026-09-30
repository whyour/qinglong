const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const load = require('../helpers/load-security-module.cjs');

function fixture(t, customData = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-access-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, customData ? 'custom-data' : 'data');
  const config = {
    rootPath: root,
    configPath: path.join(data, 'config'),
    scriptPath: path.join(data, 'scripts'),
    logPath: path.join(data, 'log'),
    blackFileList: ['token.json', 'auth.json', 'grpc', 'env.js'],
  };
  for (const directory of [
    config.configPath,
    config.scriptPath,
    config.logPath,
  ])
    fs.mkdirSync(directory, { recursive: true });
  const secret = path.join(config.configPath, 'token.json');
  fs.writeFileSync(secret, 'PANEL-SECRET');
  for (const directory of [
    config.configPath,
    config.scriptPath,
    config.logPath,
  ])
    fs.symlinkSync(secret, path.join(directory, 'secret-link'));
  const mocks = {
    '../config': config,
    typedi: { Service: () => (x) => x, Inject: () => () => {} },
    '../config/util': {
      getFileContentByName: (p) => fs.promises.readFile(p, 'utf8'),
      rmPath: (p) => fs.promises.rm(p),
      removeAnsi: (s) => s,
    },
    '../shared/utils': {
      writeFileWithLock: (p, s) => fs.promises.writeFile(p, s),
    },
    '../shared/i18n': { t: (s) => s },
    '../config/const': {},
    '../data/runningInstance': {
      InstanceStatus: { running: 'running' },
      RunningInstanceModel: { findOne: async () => null },
    },
  };
  return { config, mocks, secret };
}

function api(name, service, mocks) {
  mocks.typedi = { Container: { get: () => service } };
  const app = express.Router();
  load(path.resolve(`back/api/${name}.ts`), mocks).default(app);
  const router = app.stack.find((layer) => layer.name === 'router').handle;
  return async (method, url, values) => {
    const handler = router.stack
      .find((layer) => layer.route?.path === url && layer.route.methods[method])
      .route.stack.at(-1).handle;
    let result;
    await handler(
      { query: values, body: values },
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
}

for (const customData of [false, true]) {
  test(`config script access scopes blacklist and uses the configured data directory (custom=${customData})`, async (t) => {
    const { config, mocks, secret } = fixture(t, customData);
    const Config = load(path.resolve('back/services/config.ts'), mocks).default;
    mocks['../services/config'] = Config;
    const invoke = api('config', new Config(), mocks);
    const legacy = path.join(config.rootPath, 'data/scripts');
    if (customData) {
      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(path.join(legacy, 'notify.py'), 'legacy');
    }
    for (const filename of [
      'token.json',
      'auth.json',
      'grpc/env.js',
      'notify.py',
    ]) {
      const file = path.join(config.scriptPath, filename);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'initial');
      const name = `data/scripts/${filename}`;
      assert.equal(
        (await invoke('get', '/detail', { path: name })).data,
        'initial',
      );
      assert.equal(
        (await invoke('post', '/save', { name, content: 'updated' })).code,
        200,
      );
      assert.equal(
        (await invoke('get', '/detail', { path: name })).data,
        'updated',
      );
      assert.equal(fs.readFileSync(file, 'utf8'), 'updated');
    }
    if (customData)
      assert.equal(
        fs.readFileSync(path.join(legacy, 'notify.py'), 'utf8'),
        'legacy',
      );
    for (const name of [
      'token.json',
      'grpc/client.key',
      'secret-link',
      'data/scripts/secret-link',
      'data/scripts/../config/token.json',
      secret,
    ]) {
      assert.equal(
        (await invoke('get', '/detail', { path: name })).code,
        403,
        name,
      );
      assert.equal(
        (await invoke('post', '/save', { name, content: 'overwrite' })).code,
        403,
        name,
      );
    }
    assert.equal(
      (await invoke('post', '/save', { name: 'normal.txt', content: 'normal' }))
        .code,
      200,
    );
    assert.equal(
      (await invoke('get', '/detail', { path: 'normal.txt' })).data,
      'normal',
    );
    assert.equal(fs.readFileSync(secret, 'utf8'), 'PANEL-SECRET');
  });
}

test('log APIs allow configuration-like names while retaining directory boundaries', async (t) => {
  const { config, mocks, secret } = fixture(t);
  const Log = load(path.resolve('back/services/log.ts'), mocks).default;
  mocks['../services/log'] = Log;
  const invoke = api('log', new Log(), mocks);
  for (const filename of ['token.json', 'grpc/run.log', 'env.js/run.log']) {
    const file = path.join(config.logPath, filename);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'log content');
    const values = {
      path: path.dirname(filename) === '.' ? '' : path.dirname(filename),
      file: path.basename(filename),
      filename: path.basename(filename),
    };
    assert.equal((await invoke('get', '/detail', values)).data, 'log content');
    assert.equal(
      (await invoke('post', '/download', values)).data,
      'log content',
    );
    assert.equal((await invoke('delete', '/', values)).code, 200);
    assert.equal(fs.existsSync(file), false);
  }
  for (const filename of ['../config/token.json', 'secret-link', secret]) {
    const values = { path: '', file: filename, filename };
    for (const [method, route] of [
      ['get', '/detail'],
      ['post', '/download'],
      ['delete', '/'],
    ])
      assert.equal((await invoke(method, route, values)).code, 403, filename);
  }
  assert.equal(fs.readFileSync(secret, 'utf8'), 'PANEL-SECRET');
});
