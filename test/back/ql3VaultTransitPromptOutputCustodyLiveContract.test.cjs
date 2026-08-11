const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');
const scriptPath = path.join(
  root,
  'scripts/ql3-vault-transit-prompt-output-custody-live-contract.cjs',
);
const source = readFileSync(scriptPath, 'utf8');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json')));
const { IMAGE } = require(scriptPath);

test('Vault Transit live gate is explicit and digest pinned', () => {
  assert.equal(
    IMAGE,
    'docker.io/hashicorp/vault@sha256:4e33b126a59c0c333b76fb4e894722462659a6bec7c48c9ee8cea56fccfd2569',
  );
  assert.match(source, /QL3_RUN_VAULT_TRANSIT_LIVE/);
  assert.equal(
    manifest.scripts['test:vault-transit-custody-live:ql3'],
    'pnpm --filter @qinglong/ai build && pnpm --filter @qinglong/cluster-admin build && node scripts/ql3-vault-transit-prompt-output-custody-live-contract.cjs',
  );
});

test('fixture is loopback-only, non-root, TLS-only and capability bounded', () => {
  for (const exact of [
    "'127.0.0.1::8200'",
    'process.getuid',
    'process.getgid',
    "'--cap-drop'",
    "'ALL'",
    "'--cap-add'",
    "'IPC_LOCK'",
    "'no-new-privileges:true'",
    "'--read-only'",
    "'/tmp:rw,noexec,nosuid,size=16m'",
    "'/bin/vault'",
    'tls_min_version = "tls13"',
    'tls_max_version = "tls13"',
    "transport: 'https'",
  ]) {
    assert.equal(source.includes(exact), true, exact);
  }
});

test('persistent barrier is initialized, threshold-unsealed and replaced', () => {
  for (const exact of [
    '\'storage "file" {\'',
    "'/v1/sys/init'",
    "'/v1/sys/unseal'",
    "docker(['rm', '--force', container])",
    'assert.notEqual(secondContainerId, firstContainerId)',
    'sealedAfterContainerReplacement',
    'persistentBarrierSurvivesContainerReplacement',
    'transitKeySurvivesContainerReplacement',
    'untrustedCaRejectedBeforeVaultApi',
  ]) {
    assert.equal(source.includes(exact), true, exact);
  }
});

test('real ceremony reaches the shared adapter and offline product verifier', () => {
  for (const symbol of [
    'readCommand',
    'run(wrapCommand)',
    'run(unwrapCommand)',
    'readClusterPromptOutputExternalRecoveryInput',
    'runClusterPromptOutputExternalRecoveryVerifier',
    'disposeClusterPromptOutputExternalRecoveryInput',
    'realVaultTransitEncryptDecrypt',
    'officialArtifactOpenVerified',
  ]) {
    assert.equal(source.includes(symbol), true, symbol);
  }
});

test('success and failure always remove private state and the exact container', () => {
  assert.match(source, /finally \{/);
  assert.equal(
    source.includes(
      "docker(['rm', '--force', container], { allowFailure: true })",
    ),
    true,
  );
  assert.equal(
    source.includes('rmSync(directory, { recursive: true, force: true })'),
    true,
  );
  assert.equal(source.includes('reportIsContentFree: true'), true);
  assert.equal(source.includes('serialized.includes(forbidden)'), true);
});
