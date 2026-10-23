const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { probeNodeRuntime } = require('../../shell/node-runtime-probe.cjs');

test('the retained Node handles URL, IDNA and file paths in fresh eval and file processes', () => {
  const result = probeNodeRuntime();
  assert.equal(result.ok, true);
  assert.equal(result.processes, 4);
  assert.match(result.nodeSha256, /^[0-9a-f]{64}$/);
});

test('a native child crash fails the runtime probe instead of accepting its healthy parent', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX crash fixture');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-node-crash-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'node');
  fs.writeFileSync(executable, '#!/bin/sh\nkill -SEGV $$\n', { mode: 0o700 });
  assert.throws(
    () => probeNodeRuntime(executable),
    /Node URL runtime probe failed.*SIGSEGV/,
  );
});

test('emulated Node probes have a bounded two-minute budget and reject a timeout', (t) => {
  const childProcess = require('node:child_process');
  const modulePath = require.resolve('../../shell/node-runtime-probe.cjs');
  let directory;
  const makeDirectory = fs.mkdtempSync;
  t.mock.method(fs, 'mkdtempSync', (...args) => {
    directory = makeDirectory(...args);
    return directory;
  });
  t.mock.method(childProcess, 'spawnSync', (_program, args, options) => {
    assert.equal(options.timeout, 120000);
    assert.equal(options.env.NODE_OPTIONS, '');
    return { status: null, signal: 'SIGTERM', error: Object.assign(new Error('probe timed out'), { code: 'ETIMEDOUT' }) };
  });
  delete require.cache[modulePath];
  t.after(() => { delete require.cache[modulePath]; });
  const probe = require(modulePath).probeNodeRuntime;
  assert.throws(() => probe(), /Node URL runtime probe failed.*SIGTERM.*probe timed out/);
  assert.ok(directory);
  assert.equal(fs.existsSync(directory), false, 'Timed-out probes must remove their temporary source files');
});
