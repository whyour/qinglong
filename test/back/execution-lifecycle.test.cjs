const assert = require('node:assert/strict');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const load = require('../helpers/load-security-module.cjs');
const { observeChildProcess } = require('../../back/shared/childProcess');
const { LogStreamManager } = require('../../back/shared/logStreamManager');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logger = { info() {}, error() {} };

test(
  'spawn failure settles without exit, and the next scheduled run can proceed',
  { timeout: 3000 },
  async () => {
    let releases = 0;
    let active = 0;
    const { runCron } = load(path.resolve('back/shared/runCron.ts'), {
      'cross-spawn': {
        spawn: () => spawn('true', { shell: '/nonexistent-ql-test-shell' }),
      },
      './pLimit': {
        runWithCronLimit: async (_cron, fn) => {
          active++;
          try {
            return await fn();
          } finally {
            active--;
          }
        },
        removeQueuedCron: () => releases++,
      },
      '../loaders/logger': logger,
      '../data/cron': {
        CrontabModel: { findOne: async () => null },
        CrontabStatus: {},
      },
      '../data/runningInstance': {
        RunningInstanceModel: {},
        InstanceStatus: {},
      },
      '../config/util': { killTask: async () => {} },
    });
    await runCron('true', { id: '1' });
    await runCron('true', { id: '2' });
    assert.equal(active, 0);
    assert.equal(releases, 2);
  },
);

test(
  'completion waits for slow log consumers and preserves the final output',
  { timeout: 5000 },
  async () => {
    const chunks = [];
    const child = spawn(process.execPath, [
      '-e',
      'process.stdout.write("尾行\\n"); process.stderr.write("错误\\n")',
    ]);
    const observed = observeChildProcess(child, {
      onStart: () => delay(25),
      onStdout: async (message) => {
        await delay(40);
        chunks.push(message);
      },
      onStderr: async (message) => {
        await delay(30);
        chunks.push(message);
      },
    });
    const result = await observed.completed;
    assert.equal(result.code, 0);
    assert.equal(result.error, undefined);
    assert.match(chunks.join(''), /尾行/);
    assert.match(chunks.join(''), /错误/);
  },
);

test('exit is not completion, and UTF-8 split across writes remains intact', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 123;
  const chunks = [];
  const observed = observeChildProcess(child, {
    onStdout: async (data) => chunks.push(data),
  });
  child.emit('spawn');
  let done = false;
  observed.completed.then(() => {
    done = true;
  });
  child.emit('exit', 0, null);
  const data = Buffer.from('末尾中文');
  child.stdout.write(data.subarray(0, 2));
  await delay(10);
  assert.equal(done, false);
  child.stdout.end(data.subarray(2));
  child.stderr.end();
  child.emit('close', 0, null);
  await observed.completed;
  assert.equal(chunks.join(''), '末尾中文');
});

test(
  'failed log sink drains large output instead of blocking the child',
  { timeout: 5000 },
  async () => {
    const child = spawn(process.execPath, [
      '-e',
      'process.stdout.write("x".repeat(2 * 1024 * 1024))',
    ]);
    const { completed } = observeChildProcess(child, {
      onStdout: async () => {
        throw new Error('ENOSPC');
      },
    });
    const result = await completed;
    assert.equal(result.code, 0);
    assert.equal(result.error.message, 'ENOSPC');
  },
);

function scheduleFixture() {
  let active = 0;
  const limit = async (_params, fn) => {
    active++;
    try {
      return await fn();
    } finally {
      active--;
    }
  };
  const Schedule = load(path.resolve('back/services/schedule.ts'), {
    '../shared/pLimit': {
      runWithScriptLimit: limit,
      runWithSystemLimit: limit,
    },
    'cross-spawn': {
      spawn: () =>
        spawn(process.execPath, [
          '-e',
          'setTimeout(() => process.stdout.write("done"), 150)',
        ]),
    },
  }).default;
  return { service: new Schedule(logger), active: () => active };
}

test(
  'PID response keeps queue capacity occupied until cleanup completes',
  { timeout: 4000 },
  async () => {
    const fixture = scheduleFixture();
    let finish;
    const finished = new Promise((resolve) => {
      finish = resolve;
    });
    const pid = await fixture.service.runTask(
      'ignored',
      {
        onEnd: async () => {
          await delay(20);
          finish();
        },
      },
      { id: 'script', runOrigin: 'script' },
      'start',
    );
    assert.ok(pid > 0);
    assert.equal(fixture.active(), 1);
    await finished;
    await delay(0);
    assert.equal(fixture.active(), 0);
  },
);

test(
  'before/error/end callback failures settle and release capacity',
  { timeout: 3000 },
  async () => {
    const fixture = scheduleFixture();
    let ended = 0;
    const result = await fixture.service.runTask(
      'ignored',
      {
        onBefore: async () => {
          throw new Error('setup failed');
        },
        onError: async () => {
          throw new Error('sink failed');
        },
        onEnd: async (child) => {
          assert.equal(child, undefined);
          ended++;
          throw new Error('cleanup failed');
        },
      },
      { id: 'system', runOrigin: 'system' },
    );
    assert.equal(result.error.message, 'setup failed');
    assert.equal(ended, 1);
    assert.equal(fixture.active(), 0);
  },
);

test(
  'concurrent writes and closes preserve all bytes, and failed files can be closed',
  { timeout: 5000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-log-lifecycle-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const manager = new LogStreamManager(dir);
    const file = path.join(dir, 'out.log');
    const lines = Array.from({ length: 500 }, (_, i) => `${i}:末尾\n`);
    const writes = lines.map((line) => manager.write(file, line));
    await Promise.all([
      ...writes,
      manager.closeStream(file),
      manager.closeStream(file),
    ]);
    assert.equal(await fs.readFile(file, 'utf8'), lines.join(''));
    assert.equal(manager.getOpenStreamCount(), 0);
    const invalid = path.join(dir, 'missing', 'out.log');
    await assert.rejects(manager.write(invalid, 'fail'), /ENOENT/);
    await assert.rejects(manager.closeStream(invalid), /ENOENT/);
    assert.equal(manager.getOpenStreamCount(), 0);
    await manager.write(file, 'reopened');
    await manager.closeAll();
    assert.match(await fs.readFile(file, 'utf8'), /reopened$/);
  },
);
