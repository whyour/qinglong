const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const load = require('../helpers/load-security-module.cjs');

test('BSD identity and parent lookups distinguish a vanished PID from ps failures', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const pid = process.pid;
  let result, field;
  const probes = load('back/shared/cronProcess.ts', {
    child_process: { spawnSync(command, args) {
      assert.equal(command, 'ps');
      assert.deepEqual(args, ['-p', String(pid), '-o', field + '=']);
      return result;
    } },
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  try {
    for (const [name, probe] of [
      ['lstart', () => probes.systemOwner(pid)],
      ['ppid', () => probes.isProcessDescendant(pid, 1)],
    ]) {
      field = name;
      result = { status: 1, stdout: '', stderr: '' };
      assert.throws(probe, { code: 'ESRCH' });
      for (result of [
        { status: 1, stdout: '', stderr: 'Permission denied' },
        { status: 0, stdout: '', stderr: '' },
        { status: null, signal: 'SIGTERM', stdout: '', stderr: '' },
        { error: Object.assign(Error('spawn ps ENOENT'), { code: 'ENOENT' }) },
      ]) {
        assert.throws(probe, error => !['ESRCH', 'ENOENT'].includes(error.code) && /ps|PID/.test(error.message));
      }
    }
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

// Exercise the production function with a deterministic process-tree race.
function fixture(descendants, probe = () => {}, birth, descendant) {
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
  new Function('exports', 'process', 'psTree', 'fs', 'setTimeout', 'systemOwner', 'isProcessDescendant', code)(
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
    setTimeout, birth, descendant,
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

test('verified stop ignores reused, vanished and reparented descendants from the tree snapshot', async () => {
  const seen = new Set();
  let rootExited = false;
  const birth = pid => {
    if (pid === 102 || (pid === 100 && rootExited)) throw Object.assign(Error('gone'), { code: 'ESRCH' });
    if (pid === 101 && seen.has(pid)) return 'replacement';
    seen.add(pid);
    return 'original-' + pid;
  };
  const f = fixture([101, 102, 103], (pid, sig) => {
    if (pid === 100 && sig === 'SIGTERM') rootExited = true;
  }, birth, pid => pid !== 103);
  await f.killTask(100, true, () => {}, async signal => signal());
  assert.deepEqual(f.signals, [[100, 'SIGTERM']]);
});

test('a root exiting immediately before TERM cannot claim a stop or signal a surviving child', async () => {
  const f = fixture([101], (pid, sig) => {
    if (pid === 100 && sig === 'SIGTERM') throw Object.assign(Error('gone'), { code: 'ESRCH' });
  }, pid => 'birth-' + pid, () => true);
  let committed = false;
  await assert.rejects(f.killTask(100, true, () => {}, async signal => {
    signal();
    committed = true;
  }), { code: 'ESRCH' });
  assert.equal(committed, false);
  assert.deepEqual(f.signals, [[100, 'SIGTERM']]);
});

test('a descendant delivery failure after root TERM preserves the claim and still signals siblings', async () => {
  const denied = Object.assign(Error('denied'), { code: 'EPERM' });
  const f = fixture([101, 102], (pid, signal) => {
    if (pid === 102 && signal === 'SIGTERM') throw denied;
  }, pid => 'birth-' + pid, () => true);
  await assert.rejects(f.killTask(100, true, () => {}, async signal => {
    const delivery = signal();
    assert.equal(delivery, denied);
    throw delivery;
  }), error => error === denied);
  assert.deepEqual(f.signals, [[100, 'SIGTERM'], [102, 'SIGTERM'], [101, 'SIGTERM']]);
});
