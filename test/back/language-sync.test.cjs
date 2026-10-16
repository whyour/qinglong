const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('language changes reach live HTTP/scheduler workers and replacement workers restore the saved language', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-language-cluster-'));
  const root = path.resolve(__dirname, '../..');
  try {
    const state = path.join(dir, 'language.json');
    await fs.writeFile(state, '"en"');
    const fixture = path.join(dir, 'cluster.cjs');
    await fs.writeFile(
      fixture,
      `
require(${JSON.stringify(require.resolve('ts-node/register/transpile-only'))});
const cluster = require('node:cluster');
const fs = require('node:fs/promises');
const storePath = require.resolve(${JSON.stringify(
        path.join(root, 'back/shared/store.ts'),
      )});
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { shareStore: {
  getLang: async () => JSON.parse(await fs.readFile(process.env.LANGUAGE_STATE, 'utf8')),
  setLang: (lang) => fs.writeFile(process.env.LANGUAGE_STATE, JSON.stringify(lang)),
} } };
const { initializeLanguageSync } = require(${JSON.stringify(
        path.join(root, 'back/shared/languageSync.ts'),
      )});
const { setLang, t } = require(${JSON.stringify(
        path.join(root, 'back/shared/i18n.ts'),
      )});
(async () => {
 await initializeLanguageSync();
 if (cluster.isPrimary) {
  const ready = new Map(), observed = new Set(); let phase = 'initial';
  cluster.on('message', (worker, message) => {
   if (message.kind === 'ready') {
    ready.set(worker.id, message.value);
    if (phase === 'initial' && ready.size === 2) {
     if ([...ready.values()].some(value => value !== 'Update successful')) throw Error('Initial language was not restored');
     phase = 'zh'; cluster.workers[1].send({ command: 'switch', lang: 'zh' });
    } else if (phase === 'replacement' && ready.size === 3) {
     if (message.value !== '更新成功') throw Error('Replacement lost saved language');
     phase = 'en'; observed.clear(); cluster.workers[1].send({ command: 'switch', lang: 'en' });
    }
   }
   if (message.kind === 'observed') {
    if (message.value !== (phase === 'zh' ? '更新成功' : 'Update successful')) throw Error('Worker language did not change');
    observed.add(worker.id);
    if (phase === 'zh' && observed.size === 2) { phase = 'replacement'; cluster.fork(); }
    else if (phase === 'en' && observed.size === 3) {
     console.log(JSON.stringify({ initialWorkers: 2, updatedWorkers: 3, replacementRestored: true }));
     for (const w of Object.values(cluster.workers)) w.kill();
    }
   }
  });
  cluster.fork(); cluster.fork();
 } else {
  process.on('message', async message => {
   if (message.command === 'switch') await setLang(message.lang);
   if (message.type === 'language-changed') process.send({ kind: 'observed', value: t('更新成功') });
  });
  process.send({ kind: 'ready', value: t('更新成功') });
 }
})().catch(error => { console.error(error); process.exit(1); });
`,
    );
    const result = await promisify(execFile)(process.execPath, [fixture], {
      cwd: root,
      timeout: 15000,
      env: {
        ...process.env,
        TS_NODE_PROJECT: path.join(root, 'back/tsconfig.json'),
        LANGUAGE_STATE: state,
      },
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      initialWorkers: 2,
      updatedWorkers: 3,
      replacementRestored: true,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
