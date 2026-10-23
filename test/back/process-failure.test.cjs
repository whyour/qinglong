const assert = require('node:assert/strict');
const { test } = require('node:test');
const { processFailure } = require('../helpers/process-failure.cjs');

test('process failure diagnostics classify native crashes without credentials or raw output', () => {
  const secret = 'private-client-secret';
  const summary = processFailure({
    code: null,
    signal: 'SIGTRAP',
    killed: false,
    cmd: `node worker.cjs ${secret}`,
    message: secret,
    stdout: JSON.stringify({ token: secret }),
    stderr: `${secret}\nCheck failed: (data_) != nullptr.\ncompiler/heap-refs.h\nv8::internal::compiler::JSHeapBroker\n`,
  });
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(summary.signal, 'SIGTRAP');
  assert.equal(summary.fatal.v8Check, true);
  assert.equal(summary.fatal.heapBroker, true);
  assert.equal(summary.fatal.compiler, true);
  assert.equal(summary.fatal.outOfMemory, false);
  assert.equal(summary.fatal.threadCreation, false);
});

test('process failure diagnostics retain timeout and resource classes without arbitrary error fields', () => {
  const runtime = { versions: { node: '24.21.0' }, arch: 'x64' };
  const summary = processFailure(
    {
      code: 1,
      signal: 'SIGTERM private-token',
      killed: true,
      stderr: 'pthread_create: resource unavailable; heap out of memory',
    },
    runtime,
  );
  assert.deepEqual(summary, {
    code: 1,
    signal: null,
    killed: true,
    node: '24.21.0',
    arch: 'x64',
    fatal: {
      threadCreation: true,
      outOfMemory: true,
      v8Check: false,
      heapBroker: false,
      compiler: false,
    },
  });
  assert.equal(processFailure({ code: 'private-token' }).code, null);
  assert.equal(processFailure().signal, null);
});
