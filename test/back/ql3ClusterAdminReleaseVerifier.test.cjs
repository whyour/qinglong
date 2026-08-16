const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const verifier = path.join(
  ROOT,
  'deploy/console/ql3-cluster-copilot/verify-release.sh',
);
const image = `ghcr.io/example/qinglong3-cluster-admin@sha256:${'b'.repeat(
  64,
)}`;
const revision = 'c'.repeat(40);

function fixture(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-admin-verifier-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const capture = path.join(directory, 'calls');
  fs.mkdirSync(bin, { mode: 0o700 });
  for (const command of ['cosign', 'gh']) {
    fs.writeFileSync(
      path.join(bin, command),
      `#!/bin/sh\nprintf '${command}\\n' >> "$QL3_TEST_VERIFY_CALLS"\nprintf 'arg=%s\\n' "$@" >> "$QL3_TEST_VERIFY_CALLS"\n`,
      { mode: 0o700 },
    );
  }
  return {
    capture,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      QL3_TEST_VERIFY_CALLS: capture,
    },
  };
}

function invoke(args, env) {
  return spawnSync(verifier, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
}

test('verifies one signature and four digest-bound GitHub attestations', (t) => {
  assert.equal(fs.statSync(verifier).mode & 0o777, 0o755);
  const value = fixture(t);
  const result = invoke(
    [image, 'example/qinglong', revision, 'refs/tags/v3.0.0-alpha.1'],
    value.env,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    component: 'qinglong3-cluster-admin-release-verifier',
    signature: true,
    provenance: true,
    sbom: true,
    osVulnerabilityEvidence: true,
    releaseCandidateContract: true,
    compatible: true,
  });
  const calls = fs.readFileSync(value.capture, 'utf8');
  assert.equal((calls.match(/^cosign$/gmu) ?? []).length, 1);
  assert.equal((calls.match(/^gh$/gmu) ?? []).length, 4);
  for (const required of [
    'arg=--certificate-identity',
    'arg=https://github.com/example/qinglong/.github/workflows/ql3-image-release.yml@refs/tags/v3.0.0-alpha.1',
    'arg=--certificate-oidc-issuer',
    'arg=https://token.actions.githubusercontent.com',
    `arg=${image}`,
    `arg=oci://${image}`,
    'arg=--repo',
    'arg=example/qinglong',
    'arg=--signer-workflow',
    'arg=example/qinglong/.github/workflows/ql3-image-release.yml',
    'arg=--source-digest',
    `arg=${revision}`,
    'arg=--source-ref',
    'arg=refs/tags/v3.0.0-alpha.1',
    'arg=https://cyclonedx.org/bom',
    'arg=https://qinglong.dev/attestations/image-os-vulnerability/v1',
    'arg=https://qinglong.dev/attestations/release-candidate-contract/v1',
    'arg=--deny-self-hosted-runners',
    'arg=--bundle-from-oci',
  ]) {
    assert.match(
      calls,
      new RegExp(`^${required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'mu'),
    );
  }
});

test('rejects mutable or source-unbound inputs before invoking trust tools', (t) => {
  const value = fixture(t);
  for (const args of [
    [
      'ghcr.io/example/qinglong3-cluster-admin:latest',
      'example/qinglong',
      revision,
      'refs/tags/v3.0.0',
    ],
    [image, 'other/qinglong', revision, 'refs/tags/v3.0.0'],
    [image, 'example/qinglong', 'short', 'refs/tags/v3.0.0'],
    [image, 'example/qinglong', revision, 'refs/heads/next'],
  ]) {
    const rejected = invoke(args, value.env);
    assert.equal(rejected.status, 78);
    assert.equal(rejected.stdout, '');
    assert.deepEqual(JSON.parse(rejected.stderr), {
      schemaVersion: 1,
      component: 'qinglong3-cluster-admin-release-verifier',
      event: 'verification_failed',
    });
    assert.equal(fs.existsSync(value.capture), false);
  }
});
