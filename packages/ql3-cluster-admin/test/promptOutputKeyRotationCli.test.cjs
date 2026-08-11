const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const cli = path.resolve(
  __dirname,
  '../dist/prompt-output/key-management/promptOutputKeyRotationCli.js',
);

test('Cluster Prompt output key rotation CLI is command-file-only and content-free', (t) => {
  const help = spawnSync(process.execPath, [cli, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(
    help.stdout,
    /^Usage: ql3-prompt-output-key-rotate run --command-file /,
  );
  assert.equal(help.stderr, '');

  const usage = spawnSync(process.execPath, [cli, 'run'], {
    encoding: 'utf8',
  });
  assert.equal(usage.status, 64);
  assert.equal(
    JSON.parse(usage.stderr).code,
    'QL3_PROMPT_OUTPUT_KEY_ROTATION_CLI_USAGE_INVALID',
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-key-rotate-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commandFile = path.join(root, 'command.json');
  fs.writeFileSync(
    commandFile,
    JSON.stringify({
      schemaVersion: 1,
      operation: 'cluster.prompt-output-key.rotate',
      kubernetes: {},
      stagedMaterialFile: '/private/material.bin',
      request: {},
      widened: true,
    }),
    { mode: 0o444 },
  );
  const rejected = spawnSync(
    process.execPath,
    [cli, 'run', '--command-file', commandFile],
    { encoding: 'utf8' },
  );
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, '');
  assert.equal(rejected.stderr.includes(commandFile), false);
  assert.equal(rejected.stderr.includes('/private/material.bin'), false);
  assert.equal(JSON.parse(rejected.stderr).event, 'key_rotation_failed');

  const manifest = require('../package.json');
  assert.equal(
    manifest.bin['ql3-prompt-output-key-rotate'],
    'dist/prompt-output/key-management/promptOutputKeyRotationCli.js',
  );
});
