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
