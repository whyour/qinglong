const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');

async function waitFor(read, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read().catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Timed out waiting for command evidence');
}

for (const crash of [false, true]) {
  test(`manual compound command keeps complete, nonduplicated logs (worker crash=${crash})`, { timeout: 20000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-log-survival-'));
    const gate = path.join(root, 'continue');
    const script = path.join(root, 'command.sh');
    await fs.writeFile(script, `#!/bin/bash\necho BEFORE\nwhile [ ! -f '${gate}' ]; do sleep 0.02; done\necho '尾行 AFTER'\necho STDERR >&2\n`);
    const command = `bash '${script}'; echo COMPOUND; exit 17`;
    const worker = fork(path.resolve('test/helpers/manual-log-worker.cjs'), [root, command], {
      execArgv: ['-r', require.resolve('ts-node/register/transpile-only')],
      env: { ...process.env, TS_NODE_PROJECT: 'back/tsconfig.json' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    let supervisor;
    const messages = [];
    worker.on('message', value => messages.push(value));
    const exited = once(worker, 'exit');
    t.after(async () => {
      await fs.writeFile(gate, 'continue');
      worker.kill('SIGKILL');
      if (supervisor) { try { process.kill(supervisor, 'SIGKILL'); } catch {} }
      await fs.rm(root, { recursive: true, force: true });
    });
    const launched = await waitFor(async () => messages.find(x => x.pid), Boolean);
    supervisor = launched.pid;
    const log = path.join(root, launched.log);
    await waitFor(() => fs.readFile(log, 'utf8'), text => text?.includes('BEFORE'));
    if (crash) {
      worker.kill('SIGKILL');
      await exited;
    }
    await fs.writeFile(gate, 'continue');
    if (crash) {
      const receipt = await waitFor(() => fs.readFile(path.join(root, 'receipt.json'), 'utf8'), Boolean);
      assert.equal(JSON.parse(receipt).code, 17);
    } else {
      await exited;
      assert.equal(messages.find(x => x.result)?.result.code, 17);
    }
    assert.equal(await fs.readFile(log, 'utf8'), 'BEFORE\n尾行 AFTER\nSTDERR\nCOMPOUND\n');
  });
}
