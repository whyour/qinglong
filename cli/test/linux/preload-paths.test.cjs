const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

// Separate acceptance gate until the reused language preloaders handle these
// paths. This runs the same real-language assertions as the normal preload suite.
test(
  'language preloaders preserve hooks when the installation path contains spaces',
  {
    skip: process.env.QL_PRELOAD_PATH_INTEGRATION !== '1',
    timeout: 120000,
  },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql preload paths '));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const env = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(
      process.execPath,
      [
        '--test',
        '--test-reporter=tap',
        path.resolve(__dirname, '../preload.test.cjs'),
      ],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(status, { code: 0, signal: null }, output);
    assert.match(
      output,
      /# tests 6\b/,
      'the child must actually run all five languages',
    );
  },
);
