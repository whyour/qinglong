const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const load = require('../helpers/load-security-module.cjs');

function fixture(t, api = 'script') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-draft-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of [
    'scripts',
    'config/grpc',
    'log',
    'tmp',
    'bak',
    'outside',
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const config = { blackFileList: ['auth.json', 'token.json', 'grpc'] };
  for (const [key, dir] of Object.entries({
    scriptPath: 'scripts',
    configPath: 'config',
    logPath: 'log',
    tmpPath: 'tmp',
    bakPath: 'bak',
  }))
    config[key] = path.join(root, dir);
  config.writePathList = [config.scriptPath, config.configPath];
  const stopped = [];
  const removed = [];
  const service = {
    stopScript: async (...args) => {
      stopped.push(args);
      return { code: 200 };
    },
  };
  const app = express.Router();
  load(path.resolve(`back/api/${api}.ts`), {
    '../config': config,
    '../config/const': {},
    '../services/script': {},
    '../services/config': {},
    '../shared/i18n': { t: (x) => x },
    typedi: { Container: { get: () => service } },
    '../shared/utils': {
      writeFileWithLock: (p, s) => fs.promises.writeFile(p, s),
    },
    '../config/util': {
      fileExist: async (p) => fs.existsSync(p),
      rmPath: async (p) => {
        removed.push(p);
        await fs.promises.rm(p, { recursive: true, force: true });
      },
    },
  }).default(app);
  const router = app.stack.find((x) => x.name === 'router').handle;
  const invoke = async (method, url, body) => {
    const route = router.stack.find(
      (x) => x.route?.path === url && x.route.methods[method],
    ).route;
    let result;
    await route.stack
      .at(-1)
      .handle({ body }, { send: (x) => (result = x) }, (e) => {
        throw e;
      });
    return result;
  };
  return { root, config, stopped, removed, invoke };
}

test('script creation only creates the validated destination parent', async (t) => {
  const { root, config, invoke } = fixture(t);
  const outside = path.join(root, 'outside', 'unrequested');
  const result = await invoke('post', '/', {
    path: `${config.scriptPath}/../outside/unrequested`,
    filename: '../../scripts/safe.txt',
    content: 'safe',
  });
  assert.equal(result.code, 200);
  assert.equal(
    fs.readFileSync(path.join(config.scriptPath, 'safe.txt'), 'utf8'),
    'safe',
  );
  assert.equal(fs.existsSync(outside), false);
  assert.equal(
    (
      await invoke('post', '/', {
        path: `${config.scriptPath}/../../escape`,
        filename: 'poc.txt',
        content: 'blocked',
      })
    ).code,
    403,
  );
});

test('script creation supports root and nested parents in both writable directories', async (t) => {
  const { config, invoke } = fixture(t);
  for (const root of [config.scriptPath, config.configPath]) {
    for (const filename of ['ordinary.js', 'nested/deeper/script.js']) {
      assert.equal(
        (await invoke('post', '/', {
          path: root,
          filename,
          content: 'safe',
        })).code,
        200,
      );
      assert.equal(fs.readFileSync(path.join(root, filename), 'utf8'), 'safe');
    }
  }
});

test('script parent creation rejects sibling prefixes and external symlinks', async (t) => {
  const { root, config, invoke } = fixture(t);
  const sibling = config.scriptPath + '-sibling';
  const outside = path.join(root, 'outside');
  fs.mkdirSync(sibling);
  fs.symlinkSync(outside, path.join(config.scriptPath, 'escape'));
  for (const parent of [sibling, path.join(config.scriptPath, 'escape')]) {
    assert.equal(
      (await invoke('post', '/', {
        path: parent,
        filename: 'nested/poc.js',
        content: 'blocked',
      })).code,
      403,
    );
  }
  assert.equal(fs.existsSync(path.join(sibling, 'nested')), false);
  assert.equal(fs.existsSync(path.join(outside, 'nested')), false);
});

test('stopping scripts rejects logs outside the log root before any side effect', async (t) => {
  const { root, config, stopped, invoke } = fixture(t);
  const callbacks = [];
  t.mock.method(global, 'setTimeout', (fn) => {
    callbacks.push(fn);
    return {};
  });
  fs.mkdirSync(path.join(config.configPath, 'victim.swap'));
  fs.mkdirSync(path.join(config.scriptPath, 'linked'));
  fs.symlinkSync(
    path.join(root, 'outside'),
    path.join(config.logPath, 'linked'),
  );
  for (const dir of ['../config', 'linked']) {
    assert.equal(
      (await invoke('put', '/stop', { filename: 'victim.js', path: dir })).code,
      403,
    );
  }
  assert.equal(stopped.length, 0);
  assert.equal(callbacks.length, 0);
});

test('log cleanup revalidates delayed paths and still removes ordinary debug logs', async (t) => {
  const { root, config, removed, stopped, invoke } = fixture(t);
  const callbacks = [];
  t.mock.method(global, 'setTimeout', (fn) => {
    callbacks.push(fn);
    return {};
  });
  fs.mkdirSync(path.join(config.scriptPath, 'nested'));
  fs.mkdirSync(path.join(config.logPath, 'nested'));
  fs.mkdirSync(path.join(root, 'outside', 'victim.swap'));
  fs.mkdirSync(path.join(config.logPath, 'normal.swap'));
  assert.equal(
    (await invoke('put', '/stop', { filename: 'normal.js' })).code,
    200,
  );
  assert.equal(
    (await invoke('put', '/stop', { filename: 'victim.js', path: 'nested' }))
      .code,
    200,
  );
  fs.rmdirSync(path.join(config.logPath, 'nested'));
  fs.symlinkSync(
    path.join(root, 'outside'),
    path.join(config.logPath, 'nested'),
  );
  callbacks.forEach((fn) => fn());
  assert.equal(stopped.length, 2);
  assert.deepEqual(removed, [path.join(config.logPath, 'normal.swap')]);
  assert.equal(fs.existsSync(path.join(root, 'outside', 'victim.swap')), true);
});

test('draft configuration traversal and normalized secret names cannot write files', async (t) => {
  const { config, invoke } = fixture(t, 'config');
  fs.writeFileSync(path.join(config.configPath, 'auth.json'), 'secret');
  fs.symlinkSync(
    path.join(config.configPath, 'auth.json'),
    path.join(config.configPath, 'alias'),
  );
  for (const name of [
    'auth.json',
    'sub/../auth.json',
    'sub/../token.json',
    'grpc/client.key',
    '../../shell/preload/env.sh',
    '../scripts/poc.js',
    'data/scripts/../config/auth.json',
    'alias',
  ]) {
    assert.equal(
      (await invoke('post', '/save', { name, content: 'changed' })).code,
      403,
      name,
    );
  }
  assert.equal(
    fs.readFileSync(path.join(config.configPath, 'auth.json'), 'utf8'),
    'secret',
  );
  assert.equal(
    (await invoke('post', '/save', { name: 'config.sh', content: 'normal' }))
      .code,
    200,
  );
  assert.equal(
    (
      await invoke('post', '/save', {
        name: 'data/scripts/normal.js',
        content: 'normal',
      })
    ).code,
    403,
  );
  assert.equal(fs.existsSync(path.join(config.scriptPath, 'normal.js')), false);
});
