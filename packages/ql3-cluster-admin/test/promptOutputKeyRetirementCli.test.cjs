const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const cli = path.resolve(
  __dirname,
  '../dist/prompt-output/key-management/promptOutputKeyRetirementCli.js',
);

test('Cluster Prompt output key retirement CLI exposes one command-file-only interface', (t) => {
  const help = spawnSync(process.execPath, [cli, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(
    help.stdout,
    /^Usage: ql3-prompt-output-key-retire run --command-file /,
  );
  assert.equal(help.stderr, '');

  const usage = spawnSync(process.execPath, [cli, 'run'], {
    encoding: 'utf8',
  });
  assert.equal(usage.status, 64);
  const usageFact = JSON.parse(usage.stderr);
  assert.equal(
    usageFact.code,
    'QL3_PROMPT_OUTPUT_KEY_RETIREMENT_CLI_USAGE_INVALID',
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-key-retire-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commandFile = path.join(root, 'command.json');
  fs.writeFileSync(
    commandFile,
    JSON.stringify({
      schemaVersion: 1,
      operation: 'cluster.prompt-output-key.retire',
      kubernetes: {
        namespace: 'qinglong',
        secretName: 'ql3-prompt-output-keyring',
        expectedSecretUid: 'uid-keyring-1',
        dataKey: 'keyring.json',
      },
      request: {
        keyId: 'cluster-key-old',
        retirementId: 'retirement-1',
        requestId: 'request-1',
        mutationId: 'mutation-1',
        widened: true,
      },
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
  assert.equal(rejected.stderr.includes('cluster-key-old'), false);
  const failure = JSON.parse(rejected.stderr);
  assert.equal(failure.event, 'key_retirement_failed');
  assert.equal(failure.name, 'TypeError');

  const manifest = require('../package.json');
  assert.equal(
    manifest.bin['ql3-prompt-output-key-retire'],
    'dist/prompt-output/key-management/promptOutputKeyRetirementCli.js',
  );
});
