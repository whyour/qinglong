require('reflect-metadata');
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { errors } = require('celebrate');
const { Container } = require('typedi');
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
    configPath: path.join(root, 'config'),
    dataPath: root,
    bakPath: path.join(root, 'bak'),
    blackFileList: ['auth.json'],
    writePathList: [scripts],
  };
  await fs.mkdir(config.bakPath);
  let failure = '';
  class ScriptService {
    checkFilePath(dir, name) {
      return resolveFileAccess(scripts, [dir || '', name]);
    }
  }
  const mocks = {
    '../config': { default: config, __esModule: true },
    'fs/promises': {
      ...fs,
      copyFile: async (from, to) => {
        if (failure === 'backup' && path.dirname(to) === config.bakPath)
          throw Object.assign(new Error('backup denied'), { code: 'EACCES' });
        return fs.copyFile(from, to);
      },
      writeFile: async (file, ...args) => {
        if (failure === 'history' && String(file).endsWith('.pending.tmp'))
          throw Object.assign(new Error('history full'), { code: 'ENOSPC' });
        return fs.writeFile(file, ...args);
      },
    },
    '../config/util': {
      rmPath: (file) => fs.rm(file, { force: true, recursive: true }),
      fileExist: async (file) =>
        fs.access(file).then(
          () => true,
          () => false,
        ),
    },
    '../services/script': { default: ScriptService, __esModule: true },
    '../shared/i18n': { t: (value) => value },
  };
  const cache = new Map();
  const api = load(
    path.join(__dirname, '../../back/api/script.ts'),
    mocks,
    cache,
  );
  const { default: ScriptHistoryService } = load(
    path.join(__dirname, '../../back/services/scriptHistory.ts'),
    mocks,
    cache,
  );
  Container.set(ScriptService, new ScriptService());
  t.after(() => {
    Container.remove(ScriptHistoryService);
    Container.remove(ScriptService);
  });
  assert.ok(Container.has(ScriptHistoryService));
  const historyService = Container.get(ScriptHistoryService);
  assert.strictEqual(Container.get(ScriptHistoryService), historyService);
  // An empty history read must not create storage or other persistent resources.
  assert.deepEqual((await historyService.list('', 'test.js')).versions, []);
  await assert.rejects(fs.stat(path.join(root, 'script-history')), {
    code: 'ENOENT',
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

  // develop allows script names that are protected only in the config root.
  await fs.writeFile(path.join(scripts, 'auth.json'), 'script-original');
  for (const method of ['PUT', 'POST']) {
    const saved = await call(
      '/scripts',
      { filename: 'auth.json', path: '', content: `script-${method}` },
      method,
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.historyRecorded, true);
  }
  const namedHistory = await call('/scripts/history?filename=auth.json');
  assert.equal(namedHistory.body.data.versions.length, 2);
  const namedPreview = await call(
    `/scripts/history/detail?filename=auth.json&id=${namedHistory.body.data.versions[0].id}`,
  );
  assert.equal(namedPreview.body.data.version.content, 'script-PUT');
  assert.equal(namedPreview.body.data.current, 'script-POST');
  assert.equal(
    (
      await call('/scripts/history/restore', {
        filename: 'auth.json',
        id: namedHistory.body.data.versions[0].id,
        expectedHash: namedPreview.body.data.currentHash,
      })
    ).status,
    200,
  );
  assert.equal(
    await fs.readFile(path.join(scripts, 'auth.json'), 'utf8'),
    'script-PUT',
  );

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
  for (const scenario of ['target-link', 'source-link', 'normalized-path']) {
    await t.test(
      `save-as preserves aliases of the same file: ${scenario}`,
      async () => {
        const sourceName = `${scenario}-source.js`;
        const aliasName = `${scenario}-alias.js`;
        const sourcePath = path.join(scripts, sourceName);
        await fs.writeFile(sourcePath, 'source-original');
        if (scenario !== 'normalized-path')
          await fs.symlink(sourceName, path.join(scripts, aliasName));
        const filename =
          scenario === 'target-link'
            ? aliasName
            : scenario === 'normalized-path'
            ? `./${sourceName}`
            : sourceName;
        const originFilename =
          scenario === 'source-link' ? aliasName : sourceName;
        const saved = await call(
          '/scripts',
          { filename, originFilename, path: '', content: 'source-edited' },
          'POST',
        );
        assert.equal(saved.status, 200);
        assert.equal(saved.body.code, 200);
        assert.equal(await fs.readFile(sourcePath, 'utf8'), 'source-edited');
        assert.equal(
          await fs.readFile(path.join(scripts, filename), 'utf8'),
          'source-edited',
        );
        if (scenario !== 'normalized-path') {
          assert.equal(
            await fs.readlink(path.join(scripts, aliasName)),
            sourceName,
          );
          const sourceHistory = await call(
            `/scripts/history?filename=${sourceName}`,
          );
          const aliasHistory = await call(
            `/scripts/history?filename=${aliasName}`,
          );
          assert.deepEqual(aliasHistory.body.data, sourceHistory.body.data);
        }
        const list = await call(
          `/scripts/history?filename=${encodeURIComponent(filename)}`,
        );
        assert.equal(list.body.data.versions.length, 1);
        const preview = await call(
          `/scripts/history/detail?filename=${encodeURIComponent(
            filename,
          )}&id=${list.body.data.versions[0].id}`,
        );
        assert.equal(preview.body.data.version.content, 'source-original');
        assert.equal(preview.body.data.current, 'source-edited');
      },
    );
  }
  await t.test(
    'save-as backs up the source and retains destination history before removing the source',
    async () => {
      await fs.writeFile(path.join(scripts, 'source.js'), 'source-original');
      await fs.writeFile(
        path.join(scripts, 'destination.js'),
        'destination-original',
      );
      const saved = await call(
        '/scripts',
        {
          filename: 'destination.js',
          originFilename: 'source.js',
          path: '',
          content: 'source-edited',
        },
        'POST',
      );
      assert.equal(saved.status, 200);
      await assert.rejects(fs.access(path.join(scripts, 'source.js')), {
        code: 'ENOENT',
      });
      assert.equal(
        await fs.readFile(path.join(config.bakPath, 'source.js'), 'utf8'),
        'source-original',
      );
      assert.equal(
        await fs.readFile(path.join(scripts, 'destination.js'), 'utf8'),
        'source-edited',
      );
      const list = await call('/scripts/history?filename=destination.js');
      const preview = await call(
        `/scripts/history/detail?filename=destination.js&id=${list.body.data.versions[0].id}`,
      );
      assert.equal(preview.body.data.version.content, 'destination-original');
    },
  );
  for (const step of ['backup', 'history']) {
    await t.test(
      `save-as ${step} failure preserves both original scripts`,
      async () => {
        const sourceName = `${step}-source.js`,
          destinationName = `${step}-destination.js`;
        await fs.writeFile(path.join(scripts, sourceName), 'source-original');
        await fs.writeFile(
          path.join(scripts, destinationName),
          'destination-original',
        );
        failure = step;
        try {
          const saved = await call(
            '/scripts',
            {
              filename: destinationName,
              originFilename: sourceName,
              path: '',
              content: 'source-edited',
            },
            'POST',
          );
          assert.equal(saved.status, 500);
          assert.equal(
            await fs.readFile(path.join(scripts, sourceName), 'utf8'),
            'source-original',
          );
          assert.equal(
            await fs.readFile(path.join(scripts, destinationName), 'utf8'),
            'destination-original',
          );
          assert.equal(
            (await call(`/scripts/history?filename=${destinationName}`)).body
              .data.versions.length,
            0,
          );
        } finally {
          failure = '';
        }
      },
    );
  }
});
