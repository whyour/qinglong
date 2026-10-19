const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createContext } = require('../../dist/internal/runtime/context');
const { replaceAndReload } = require('../../dist/internal/maintenance/upgrade');
const runtime = require('../../dist/internal/maintenance/nodeRuntime.cjs');

// Change only runtime selection; execute the compiled operator, actual child
// Node and process discovery, without pretending the host CPU is ARM.
async function operatorFor(arch, armVersion, node) {
  const filename = require.resolve('../../dist/internal/maintenance/operator');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const flags = runtime.serverRuntimeArgs({
    arch,
    config: { variables: { arm_version: armVersion } },
    versions: { node },
  });
  vm.runInNewContext(
    await fs.readFile(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      process,
      setTimeout,
      clearTimeout,
      require(name) {
        return name === './nodeRuntime.cjs'
          ? { ...runtime, serverRuntimeArgs: () => [...flags] }
          : localRequire(name);
      },
    },
    { filename },
  );
  return { ...module.exports, flags };
}

for (const [arch, arm, node] of [
  ['arm', 6, '24.18.1'],
  ['arm', 6, '20.18.1'],
  ['arm', 6, '22.20.0'],
  ['arm', 7, '24.18.1'],
  ['arm64', undefined, '24.18.1'],
  ['x64', undefined, '24.18.1'],
])
  test(`CLI direct startup and stop use compatible arguments: ${arch}/${arm}/${node}`, async (t) => {
    const operator = await operatorFor(arch, arm, node);
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ql-runtime-start-')),
    );
    const context = createContext(
      { root },
      { PATH: process.platform === 'linux' ? '' : '/usr/bin:/bin', QL_LANG: 'en' },
    );
    const entry = path.join(context.paths.dir_static, 'build/app.js');
    let pid;
    t.after(async () => {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      await fs.rm(root, { recursive: true, force: true });
    });
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(
      entry,
      `require('fs').writeFileSync(${JSON.stringify(
        path.join(root, 'runtime.json'),
      )}, JSON.stringify({args:process.execArgv,pid:process.pid}));setInterval(()=>{},1000);`,
    );
    const started = await operator.startPanel(context);
    pid = started.pid;
    const report = JSON.parse(
      await fs.readFile(path.join(root, 'runtime.json')),
    );
    assert.equal(started.manager, 'node');
    assert.deepEqual(report.args, operator.flags);
    assert.equal(report.pid, pid);
    await operator.stopPanel(context);
    for (let n = 0; n < 100; n++) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') {
          pid = undefined;
          break;
        }
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      pid,
      undefined,
      'the exact backend must stop even with Node flags',
    );
  });

test(
  'ARMv6 CLI replacement stops flagged new backend before restoring old backend and data',
  {
    skip: process.platform !== 'linux',
    timeout: 20000,
  },
  async (t) => {
    const operator = await operatorFor('arm', 6, '24.18.1');
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ql-arm-rollback-')),
    );
    const context = createContext({ root }, { PATH: '', QL_LANG: 'en' });
    const entry = path.join(context.paths.dir_static, 'build/app.js');
    const incoming = path.join(root, 'incoming.js'),
      journal = path.join(root, 'journal.jsonl');
    const record = (version) =>
      `const fs=require('fs');fs.appendFileSync(${JSON.stringify(
        journal,
      )},JSON.stringify({version:${JSON.stringify(
        version,
      )},pid:process.pid,args:process.execArgv})+'\\n');setInterval(()=>{},1000);`;
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.mkdir(context.data, { recursive: true });
    await fs.writeFile(path.join(root, '.env'), 'KEEP=custom\n', {
      mode: 0o600,
    });
    await fs.writeFile(path.join(context.data, 'keep'), 'old data');
    await fs.writeFile(entry, record('old'));
    await fs.writeFile(incoming, record('new'));
    const pids = [];
    t.after(async () => {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      await fs.rm(root, { recursive: true, force: true });
    });
    pids.push((await operator.startPanel(context)).pid);
    await assert.rejects(
      replaceAndReload(context, [{ source: incoming, target: entry }], {
        stop: (ctx) => operator.stopPanel(ctx),
        start: async (ctx, recover) => {
          const result = await operator.startPanel(ctx);
          pids.push(result.pid);
          if (!recover) throw new Error('injected new-version health failure');
        },
      }),
      /injected new-version health failure/,
    );
    const launches = (await fs.readFile(journal, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(
      launches.map((x) => x.version),
      ['old', 'new', 'old'],
    );
    for (const row of launches) assert.deepEqual(row.args, operator.flags);
    for (const row of launches.slice(0, -1))
      assert.throws(() => process.kill(row.pid, 0), { code: 'ESRCH' });
    process.kill(launches.at(-1).pid, 0);
    assert.equal(
      await fs.readFile(path.join(root, '.env'), 'utf8'),
      'KEEP=custom\n',
    );
    assert.equal((await fs.stat(path.join(root, '.env'))).mode & 0o777, 0o600);
    assert.equal(
      await fs.readFile(path.join(context.data, 'keep'), 'utf8'),
      'old data',
    );
    assert.equal(await fs.readFile(entry, 'utf8'), record('old'));
    assert.ok(
      !(await fs.readdir(path.dirname(entry))).some((x) =>
        x.includes('ql-backup'),
      ),
    );
    await operator.stopPanel(context);
  },
);
