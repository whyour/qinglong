const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { withUpgradeLock, waitForHealth } = require('../../shell/upgrade.cjs');

async function temporary(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-upgrade-guards-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  return tmp;
}

for (const legacy of [true, false])
  test(
    `concurrent reclamation of a ${
      legacy ? 'legacy lock' : 'unique owner lock'
    } cannot remove a new owner`,
    { timeout: 5000 },
    async (t) => {
      const tmp = await temporary(t);
      const lock = path.join(tmp, 'upgrade.lock');
      const owner = legacy ? 'pid' : `owner-99999999-${randomUUID()}`;
      await fs.mkdir(lock);
      await fs.writeFile(path.join(lock, owner), legacy ? '99999999' : '');
      const original = {
        readFile: fs.readFile,
        readdir: fs.readdir,
        rm: fs.rm,
        unlink: fs.unlink,
      };
      let readCount = 0,
        removeCount = 0,
        active = 0,
        maximum = 0;
      let readyReaders, firstEntered, release;
      const readers = new Promise((resolve) => {
        readyReaders = resolve;
      });
      const entered = new Promise((resolve) => {
        firstEntered = resolve;
      });
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const synchronize = async () => {
        if (++readCount === 2) readyReaders();
        await readers;
      };
      t.mock.method(fs, 'readFile', async (...args) => {
        const value = await original.readFile(...args);
        if (legacy && args[0] === path.join(lock, owner) && readCount < 2)
          await synchronize();
        return value;
      });
      t.mock.method(fs, 'readdir', async (...args) => {
        const value = await original.readdir(...args);
        if (!legacy && args[0] === lock && readCount < 2) await synchronize();
        return value;
      });
      t.mock.method(fs, 'rm', async (...args) => {
        if (args[0] === lock && ++removeCount === 2) await entered;
        return original.rm(...args);
      });
      t.mock.method(fs, 'unlink', async (...args) => {
        if (args[0] === path.join(lock, owner) && ++removeCount === 2)
          await entered;
        return original.unlink(...args);
      });
      const operation = async () => {
        maximum = Math.max(maximum, ++active);
        firstEntered();
        if (active === 1) await held;
        active--;
      };
      const attempts = [
        withUpgradeLock(tmp, operation),
        withUpgradeLock(tmp, operation),
      ].map((attempt) =>
        attempt.then(
          () => ({ ok: true }),
          (error) => ({ error }),
        ),
      );
      try {
        await entered;
        const contender = await Promise.race(attempts);
        assert.match(contender.error?.message || '', /Another upgrade/);
        assert.equal(maximum, 1);
        assert.equal((await original.readdir(lock)).length, 1);
      } finally {
        release();
        await Promise.all(attempts);
      }
      assert.deepEqual(await original.readdir(tmp), []);
    },
  );

test('an empty abandoned lock is acquired atomically and a failed operation releases its owner', async (t) => {
  const tmp = await temporary(t);
  await fs.mkdir(path.join(tmp, 'upgrade.lock'));
  await assert.rejects(
    withUpgradeLock(tmp, async () => {
      await assert.rejects(
        withUpgradeLock(tmp, async () => assert.fail('concurrent operation')),
        /Another upgrade/,
      );
      throw new Error('operation failed');
    }),
    /operation failed/,
  );
  await withUpgradeLock(tmp, async () => {});
  assert.deepEqual(await fs.readdir(tmp), []);
});

test('release never deletes another owner after the original lock was replaced', async (t) => {
  const tmp = await temporary(t);
  const lock = path.join(tmp, 'upgrade.lock');
  const replacement = `owner-${process.pid}-${randomUUID()}`;
  await withUpgradeLock(tmp, async () => {
    await fs.rm(lock, { recursive: true });
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, replacement), '');
  });
  assert.deepEqual(await fs.readdir(lock), [replacement]);
});

test(
  'a lock left by a killed process can be reclaimed by a new process',
  { timeout: 5000 },
  async (t) => {
    const tmp = await temporary(t);
    const worker = path.join(tmp, 'worker.cjs');
    await fs.writeFile(
      worker,
      `
const { withUpgradeLock } = require(${JSON.stringify(
        path.resolve('shell/upgrade.cjs'),
      )});
withUpgradeLock(process.argv[2], async () => {
  process.stdout.write('owned\\n');
  await new Promise(() => setInterval(() => {}, 1000));
}).catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
`,
    );
    const child = spawn(process.execPath, [worker, tmp], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      child.once('exit', () =>
        reject(new Error('worker exited before acquiring its lock')),
      );
    });
    child.kill('SIGKILL');
    await closed;
    await withUpgradeLock(tmp, async () => {
      await assert.rejects(
        withUpgradeLock(tmp, async () => {}),
        /Another upgrade/,
      );
    });
    assert.deepEqual(await fs.readdir(tmp), ['worker.cjs']);
  },
);

async function healthServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return String(server.address().port);
}

test('health checks normalize supported URL prefixes exactly like the backend', async (t) => {
  const requests = [];
  const port = await healthServer(t, (req, res) => {
    requests.push(req.url);
    if (['/api/health', '/panel/api/health'].includes(req.url))
      res.end('{"code":200,"data":{"status":"ok"}}');
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  for (const prefix of ['', '/', 'panel', '/panel', 'panel/', '/panel/'])
    await waitForHealth({ QlPort: port, QlBaseUrl: prefix }, 100);
  assert.deepEqual(requests, [
    '/api/health',
    '/api/health',
    ...Array(4).fill('/panel/api/health'),
  ]);
});

test(
  'health timeout bounds a continuously streaming response',
  { timeout: 3000 },
  async (t) => {
    const port = await healthServer(t, (req, res) => {
      const timer = setInterval(() => res.write(' '), 10);
      res.once('close', () => clearInterval(timer));
    });
    const began = Date.now();
    await assert.rejects(waitForHealth({ QlPort: port }, 80), /health check/);
    assert.ok(
      Date.now() - began < 1000,
      'deadline must not depend on socket inactivity',
    );
  },
);

for (const streaming of [false, true])
  test(
    `cancellation interrupts ${
      streaming ? 'an active response' : 'the retry delay'
    } and releases the upgrade lock`,
    { timeout: 3000 },
    async (t) => {
      const tmp = await temporary(t);
      const controller = new AbortController();
      const reason = new Error('cancelled health check');
      const port = await healthServer(t, (req, res) => {
        if (streaming) res.write('{');
        else {
          res.statusCode = 503;
          res.end('{}');
        }
        setTimeout(() => controller.abort(reason), 30);
      });
      const began = Date.now();
      await assert.rejects(
        withUpgradeLock(tmp, () =>
          waitForHealth({ QlPort: port }, 5000, controller.signal),
        ),
        (error) => error === reason,
      );
      assert.ok(
        Date.now() - began < 400,
        'cancel must interrupt the current wait',
      );
      await withUpgradeLock(tmp, async () => {});
      assert.deepEqual(await fs.readdir(tmp), []);
    },
  );

test('unhealthy, malformed and oversized health responses fail within the deadline', async (t) => {
  for (const body of ['{}', '{', ' '.repeat(65537)]) {
    const port = await healthServer(t, (req, res) => res.end(body));
    await assert.rejects(waitForHealth({ QlPort: port }, 20), /health check/);
  }
});
