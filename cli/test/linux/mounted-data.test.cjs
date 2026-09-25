const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createContext } = require('../../dist/internal/runtime/context');
const { startPanel, stopPanel } = require('../../dist/internal/maintenance/operator');
const { reloadPanel } = require('../../dist/internal/maintenance/upgrade');

test(
  'data reload preserves a real mount root while replacing contents and restarting the backend',
  { timeout: 30000 },
  async (t) => {
    assert.equal(
      process.env.QL_MOUNT_TEST,
      '1',
      'Run only in the documented disposable mounted-data container',
    );
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-mounted-data-'));
    const data = '/mounted-data';
    assert.deepEqual(await fs.readdir(data), []);
    const before = await fs.stat(data);
    assert.notEqual(before.dev, (await fs.stat(root)).dev);
    const context = createContext(
      { root, 'data-dir': data },
      { PATH: '/nonexistent' },
    );
    t.after(async () => {
      await stopPanel(context);
      await fs.rm(root, { recursive: true, force: true });
    });
    await fs.writeFile(path.join(data, 'version'), 'old');
    await fs.writeFile(path.join(data, 'obsolete'), 'remove');
    await fs.mkdir(path.join(root, '.tmp/data'), { recursive: true });
    await fs.writeFile(path.join(root, '.tmp/data/version'), 'new');
    await fs.writeFile(path.join(root, '.tmp/data/.hidden'), 'included');
    await fs.mkdir(path.join(root, 'static/build'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'static/build/app.js'),
      `const fs=require('node:fs');if(fs.readFileSync(process.env.QL_DATA_DIR+'/version','utf8')==='broken')process.exit(7);const s=require('node:http').createServer((q,r)=>r.end(fs.readFileSync(process.env.QL_DATA_DIR+'/version')));s.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.env.QL_DIR+'/port',String(s.address().port)));`,
    );
    await startPanel(context);
    const response = async () => {
      const port = await fs.readFile(path.join(root, 'port'), 'utf8');
      return (
        await fetch('http://127.0.0.1:' + port, {
          signal: AbortSignal.timeout(3000),
        })
      ).text();
    };
    assert.equal(await response(), 'old');
    const result = await reloadPanel(context, 'data');
    assert.deepEqual(result.retainedBackups, []);
    assert.equal(await response(), 'new');
    assert.equal((await fs.stat(data)).ino, before.ino);
    assert.equal((await fs.stat(data)).dev, before.dev);
    await assert.rejects(fs.access(path.join(data, 'obsolete')));
    assert.equal(
      await fs.readFile(path.join(data, '.hidden'), 'utf8'),
      'included',
    );
    assert.ok(
      !(await fs.readdir(data)).some((name) => name.includes('ql-backup')),
    );
    await fs.writeFile(path.join(root, '.tmp/data/version'), 'broken');
    await fs.writeFile(path.join(root, '.tmp/data/new-only'), 'must roll back');
    await assert.rejects(reloadPanel(context, 'data'), /startup/);
    assert.equal(await response(), 'new');
    assert.equal((await fs.stat(data)).ino, before.ino);
    await assert.rejects(fs.access(path.join(data, 'new-only')));
    assert.ok(
      !(await fs.readdir(data)).some((name) => name.includes('ql-backup')),
    );
  },
);
