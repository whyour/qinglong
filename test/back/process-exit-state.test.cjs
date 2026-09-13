const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

// Isolate OS probes while exercising the production termination algorithm.
function terminationFixture(readStat, signalProbe = () => {}) {
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
        signals.push([pid, signal]);
        signalProbe(pid, signal);
      },
    },
    async () => [],
    { readFile: readStat },
    setTimeout,
  );
  return { killTask: exports.killTask, signals };
}

for (const state of ['Z', 'X', 'x']) {
  test(`termination accepts Linux exited state ${state} before PID reaping`, async () => {
    const { killTask, signals } = terminationFixture(
      async () => `42 (name with ) parentheses) ${state} 1 0 0`,
    );
    await killTask(42, true);
    assert.equal(
      signals.some(([, signal]) => signal === 'SIGKILL'),
      false,
    );
  });
}

test('termination keeps waiting while the process is running', async () => {
  let reads = 0;
  const { killTask } = terminationFixture(
    async () => `42 (worker) ${++reads === 1 ? 'S' : 'Z'} 1 0 0`,
  );
  await killTask(42, true);
  assert.equal(reads, 2);
});

test('a process disappearing during the procfs read is accepted', async () => {
  let probes = 0;
  const { killTask } = terminationFixture(
    async () => {
      throw Object.assign(Error('gone'), { code: 'ENOENT' });
    },
    (_pid, signal) => {
      if (signal === 0 && ++probes > 1)
        throw Object.assign(Error('gone'), { code: 'ESRCH' });
    },
  );
  await killTask(42, true);
  assert.equal(probes, 2);
});

test('permission failures are not reported as successful termination', async () => {
  const denied = Object.assign(Error('denied'), { code: 'EPERM' });
  const { killTask } = terminationFixture(
    async () => '',
    () => {
      throw denied;
    },
  );
  await assert.rejects(killTask(42, true), (error) => error === denied);
});
