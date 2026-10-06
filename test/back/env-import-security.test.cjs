const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const load = require('../helpers/load-security-module.cjs');

test('environment import never writes upload filenames, including rejected files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-env-import-'));
  fs.writeFileSync(path.join(root, 'sendNotify.js'), 'ORIGINAL');
  const created = [];
  const Env = class {};
  const app = express();
  load(path.resolve('back/api/env.ts'), {
    '../config': { scriptPath: root },
    '../config/util': {
      safeJSONParse: (value) => {
        try {
          return JSON.parse(value);
        } catch {
          return {};
        }
      },
    },
    '../services/env': Env,
    '../shared/i18n': { t: (s) => s },
    typedi: {
      Container: {
        get: () => ({
          create: async (values) => {
            created.push(values);
            return values;
          },
        }),
      },
    },
  }).default(app);
  app.use((err, _req, res, _next) =>
    res.status(400).json({ code: 400, message: err.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.on('listening', resolve);
    server.on('error', reject);
  });
  const upload = async (content, filename = 'sendNotify.js') => {
    const form = new FormData();
    form.append('env', new Blob([content]), filename);
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/envs/upload`,
      { method: 'POST', body: form },
    );
    return response.json();
  };
  for (const payload of [
    'globalThis.injected=true;',
    'null',
    '[]',
    '[{"name":"BAD;CODE","value":"x"}]',
    '[{"name":"X","value":{}}]',
  ]) {
    assert.equal((await upload(payload)).code, 400);
    assert.equal(
      fs.readFileSync(path.join(root, 'sendNotify.js'), 'utf8'),
      'ORIGINAL',
    );
  }
  assert.equal((await upload('x'.repeat(5 * 1024 * 1024 + 1))).code, 400);
  assert.equal(created.length, 0);
  assert.equal(
    (
      await upload(
        '[{"name":"TOKEN","value":"literal ${value}","remarks":"ok"}]',
        '../sendNotify.js',
      )
    ).code,
    200,
  );
  assert.equal(created.length, 1);
  assert.equal(created[0][0].value, 'literal ${value}');
  assert.deepEqual(fs.readdirSync(root), ['sendNotify.js']);
  assert.equal(
    fs.readFileSync(path.join(root, 'sendNotify.js'), 'utf8'),
    'ORIGINAL',
  );
});
