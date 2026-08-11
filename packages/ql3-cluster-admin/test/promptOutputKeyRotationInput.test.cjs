const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  readClusterPromptOutputKeyRotationCommand,
  readClusterPromptOutputKeyRotationMaterial,
} = require('../dist/prompt-output/key-management/promptOutputKeyRotationInput.js');

function command(materialFile) {
  return {
    schemaVersion: 1,
    operation: 'cluster.prompt-output-key.rotate',
    kubernetes: {
      namespace: 'qinglong',
      secretName: 'ql3-prompt-output-keyring',
      expectedSecretUid: 'uid-keyring-1',
      dataKey: 'keyring.json',
    },
    stagedMaterialFile: materialFile,
    request: {
      rotationId: 'rotation-1',
      requestId: 'request-1',
      mutationId: 'mutation-1',
      expectedActiveKeyId: 'cluster-key-current',
      expectedCatalogDigest: '1'.repeat(64),
      newKeyId: 'cluster-key-next',
    },
  };
}

test('reads one exact command and an owned 0440 staged material copy', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-key-rotate-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const materialFile = path.join(root, 'material.bin');
  fs.writeFileSync(materialFile, Buffer.alloc(32, 0x44), { mode: 0o440 });
  fs.chmodSync(materialFile, 0o440);
  const commandFile = path.join(root, 'command.json');
  fs.writeFileSync(commandFile, JSON.stringify(command(materialFile)), {
    mode: 0o444,
  });

  assert.deepEqual(
    readClusterPromptOutputKeyRotationCommand(commandFile),
    command(materialFile),
  );
  const material = readClusterPromptOutputKeyRotationMaterial(materialFile);
  assert.deepEqual(material, Buffer.alloc(32, 0x44));
  material.fill(0);
  assert.deepEqual(fs.readFileSync(materialFile), Buffer.alloc(32, 0x44));
});

test('rejects widened commands and unsafe staged material files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-key-rotate-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const materialFile = path.join(root, 'material.bin');
  fs.writeFileSync(materialFile, Buffer.alloc(32, 0x55), { mode: 0o640 });
  fs.chmodSync(materialFile, 0o640);
  assert.throws(
    () => readClusterPromptOutputKeyRotationMaterial(materialFile),
    /unavailable/,
  );

  const target = path.join(root, 'target.bin');
  fs.writeFileSync(target, Buffer.alloc(32, 0x66), { mode: 0o440 });
  const symlink = path.join(root, 'link.bin');
  fs.symlinkSync(target, symlink);
  assert.throws(() => readClusterPromptOutputKeyRotationMaterial(symlink));

  const commandFile = path.join(root, 'command.json');
  fs.writeFileSync(
    commandFile,
    JSON.stringify({ ...command(target), widened: true }),
    { mode: 0o444 },
  );
  assert.throws(
    () => readClusterPromptOutputKeyRotationCommand(commandFile),
    /shape/,
  );
});
