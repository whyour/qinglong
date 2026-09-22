const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

// Exercise the production function with a deterministic process-tree race.
function fixture(descendants, probe = () => {}) {
  const source = fs.readFileSync('back/config/util.ts', 'utf8');
  const start = source.indexOf('export async function killTask(');
  const end = source.indexOf('export async function getPid(', start);
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const signals = [];
  const exports = {};
  new Function('exports', 'process', 'psTree', 'fs', 'setTimeout', code)(
    exports,
    {
      platform: 'linux',
      kill: (pid, signal) => {
        const normalized = { 15: 'SIGTERM', 2: 'SIGINT' }[signal] || signal;
        signals.push([pid, normalized]);
        probe(pid, normalized);
      },
    },
    async () => [...descendants],
    {},
    setTimeout,
  );
  return { killTask: exports.killTask, signals };
}

test('an exited descendant does not prevent stopping its siblings and parent', async () => {
  const { killTask, signals } = fixture([101, 102], (pid) => {
    if (pid === 102) throw Object.assign(Error('gone'), { code: 'ESRCH' });
  });
  await killTask(100);
  assert.deepEqual(signals, [
    [102, 'SIGTERM'],
    [101, 'SIGTERM'],
    [100, 'SIGTERM'],
  ]);
});

test('an already exited leaf can be stopped repeatedly', async () => {
  const { killTask } = fixture([], () => {
    throw Object.assign(Error('gone'), { code: 'ESRCH' });
  });
  await killTask(100);
  await killTask(100);
});

for (const descendants of [[], [101]]) {
  test(`signal permission failure is surfaced with ${descendants.length} descendants`, async () => {
    const denied = Object.assign(Error('denied'), { code: 'EPERM' });
    const { killTask } = fixture(descendants, () => {
      throw denied;
    });
    await assert.rejects(killTask(100), (error) => error === denied);
  });
}

test('a leaf retains SIGINT and a process tree retains child-first SIGTERM', async () => {
  const leaf = fixture([]);
  await leaf.killTask(100);
  assert.deepEqual(leaf.signals, [[100, 'SIGINT']]);
  const tree = fixture([101, 102]);
  await tree.killTask(100);
  assert.deepEqual(tree.signals, [
    [102, 'SIGTERM'],
    [101, 'SIGTERM'],
    [100, 'SIGTERM'],
  ]);
});
