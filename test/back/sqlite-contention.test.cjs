const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');

for (const mode of ['commit', 'rollback']) {
  test(
    `32 competing SQLite writers preserve progress, exact writes and ${mode}`,
    { timeout: 35000 },
    async (t) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'ql-sqlite-contention-'),
      );
      const child = spawn(
        process.execPath,
        [path.resolve('test/helpers/sqlite-contention-worker.cjs'), root, mode],
        {
          env: { ...process.env, UV_THREADPOOL_SIZE: '4' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      t.after(async () => {
        child.kill('SIGKILL');
        await fs.rm(root, { recursive: true, force: true });
      });
      let output = '';
      child.stdout.on('data', (data) => (output += data));
      child.stderr.on('data', (data) => (output += data));
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 30000);
      t.after(() => clearTimeout(watchdog));
      const [code, signal] = await once(child, 'close');
      assert.equal(signal, null, output);
      assert.equal(code, 0, output);
      assert.match(output, /"callbacks":32/);
    },
  );
}
