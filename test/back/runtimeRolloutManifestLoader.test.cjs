require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const {
  loadRuntimeRolloutManifest,
} = require('../../back/runtime/adapters/fs/runtimeRolloutManifestLoader');

const NOW = 1_750_000_000_000;
const directories = [];

async function fixturePath(name = 'qinglong3-rollout.json') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-rollout-'));
  directories.push(directory);
  return path.join(directory, name);
}

function enabledManifest() {
  return {
    schemaVersion: 1,
    revision: 'manual-primary-canary-1',
    enabled: true,
    approvedBy: 'operator:admin',
    approvedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    rollbackPlanRef: 'docs/runbooks/disable-primary.md',
    rollout: {
      defaultMode: 'off',
      origins: { manual: 'primary' },
      allowLegacyFallbackBeforeStart: false,
    },
    gates: {
      durableCancellation: 'passed',
      startupReconciliation: 'passed',
      atomicLegacyProjection: 'passed',
      rollbackDrill: 'passed',
      edgeBudget: 'passed',
    },
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

test('fails closed when the rollout file is absent', async () => {
  const sourcePath = await fixturePath();
  const result = await loadRuntimeRolloutManifest(sourcePath, {
    clock: { now: () => NOW },
  });

  assert.equal(result.status, 'missing');
  assert.equal(result.policy.modeFor('manual'), 'off');
  assert.deepEqual(result.audit, {
    event: 'runtime.rollout_config_evaluated',
    evaluatedAtMs: NOW,
    sourcePath,
    status: 'missing',
    reasonCode: 'FILE_MISSING',
  });
});

test('loads an approved manifest and audits only bounded metadata', async () => {
  const sourcePath = await fixturePath();
  const raw = JSON.stringify(enabledManifest());
  await fs.writeFile(sourcePath, raw);

  const result = await loadRuntimeRolloutManifest(sourcePath, {
    clock: { now: () => NOW },
  });

  assert.equal(result.status, 'accepted');
  assert.equal(result.policy.modeFor('manual'), 'primary');
  assert.equal(result.audit.revision, 'manual-primary-canary-1');
  assert.match(result.audit.sourceSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result.audit), /operator:admin|rollback/);
});

test('rejects malformed and oversized files without exposing their contents', async () => {
  const malformedPath = await fixturePath('malformed.json');
  await fs.writeFile(malformedPath, '{"approvedBy":"secret"');
  const malformed = await loadRuntimeRolloutManifest(malformedPath, {
    clock: { now: () => NOW },
  });
  assert.equal(malformed.status, 'rejected');
  assert.equal(malformed.audit.reasonCode, 'INVALID_JSON');
  assert.equal(malformed.policy.modeFor('manual'), 'off');
  assert.doesNotMatch(JSON.stringify(malformed.audit), /secret/);

  const oversizedPath = await fixturePath('oversized.json');
  await fs.writeFile(oversizedPath, 'x'.repeat(11));
  const oversized = await loadRuntimeRolloutManifest(oversizedPath, {
    clock: { now: () => NOW },
    maxBytes: 10,
  });
  assert.equal(oversized.status, 'rejected');
  assert.equal(oversized.audit.reasonCode, 'FILE_TOO_LARGE');
  assert.equal(oversized.policy.modeFor('manual'), 'off');
});
