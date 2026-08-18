require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const {
  loadRuntimeRolloutManifest,
} = require('../../back/runtime/adapters/fs/runtimeRolloutManifestLoader');
const {
  createLegacyShadowPrimaryGateReceipt,
} = require('../../back/runtime/domain/legacyShadowPrimaryGate');

const NOW = 1_750_000_000_000;
const directories = [];

async function fixturePath(name = 'qinglong3-rollout.json') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-rollout-'));
  directories.push(directory);
  return path.join(directory, name);
}

function gateReceipt() {
  const start = NOW - 20_000;
  const end = NOW - 10_000;
  const startup = {
    schema: 'qinglong/legacy-shadow-startup-difference-report@v1',
    profile: 'edge',
    assessment: 'converged',
    configuredOriginCount: 1,
    coverage: { remaining: false },
    byOrigin: [{ origin: 'manual' }],
  };
  const capture = {
    schema: 'qinglong/legacy-shadow-capture-evidence@v1',
    profile: 'edge',
    startup,
    capture: {
      schema: 'qinglong/legacy-shadow-capture-report@v1',
      profile: 'edge',
      assessment: 'captured',
      configuredOriginCount: 1,
      window: {
        basis: 'process_local_legacy_admission',
        startInclusiveMs: start,
        endExclusiveMs: end,
      },
      totals: { admitted: 8, captured: 8, failed: 0, pending: 0 },
      byOrigin: [{ origin: 'manual' }],
      capturePermille: 1_000,
    },
    qualification: { passed: true },
  };
  const terminal = {
    schema: 'qinglong/legacy-shadow-terminal-difference-report@v1',
    profile: 'edge',
    observedAtMs: NOW - 3_000,
    window: { startInclusiveMs: start, endExclusiveMs: end, closed: true },
    coverage: {
      direction: 'shadow_to_legacy',
      cohort: 'legacy_owned_shadow_runs',
      legacyWithoutShadow: 'not_measured',
    },
    assessment: 'matched',
    scanned: 8,
    remaining: false,
    evidenceComplete: true,
    counts: { matched: 8 },
    byOrigin: [{ origin: 'manual', scanned: 8 }],
    terminalAgreementPermille: 1_000,
    fullyComparablePermille: 1_000,
  };
  const resource = {
    schemaVersion: 1,
    fixture: 'qinglong/legacy-shadow-resource-rollback-evidence@v1',
    profile: 'edge',
    workload: { mode: 'full', runtime: 'compiled_backend' },
    rollback: {
      performed: true,
      legacyContinued: true,
      shadowWritesStopped: true,
      databaseIntegrity: 'ok',
    },
    qualification: { passed: true, violations: [] },
  };
  return createLegacyShadowPrimaryGateReceipt({
    profile: 'edge',
    generatedAtMs: NOW - 2_000,
    capture,
    terminal,
    resource,
  });
}

async function writeGateReceipt(sourcePath, value = gateReceipt()) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  await fs.writeFile(
    path.join(path.dirname(sourcePath), 'primary-gate.json'),
    bytes,
    { mode: 0o600 },
  );
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function enabledManifest(receiptSha256) {
  return {
    schemaVersion: 2,
    revision: 'manual-primary-canary-1',
    enabled: true,
    approvedBy: 'operator:admin',
    approvedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    rollbackPlanRef: 'docs/runbooks/disable-primary.md',
    primaryGate: {
      schema: 'qinglong/legacy-shadow-primary-gate-reference@v1',
      origin: 'manual',
      receiptFile: 'primary-gate.json',
      receiptSha256,
    },
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
  const receiptSha256 = await writeGateReceipt(sourcePath);
  const raw = JSON.stringify(enabledManifest(receiptSha256));
  await fs.writeFile(sourcePath, raw);

  const result = await loadRuntimeRolloutManifest(sourcePath, {
    clock: { now: () => NOW },
  });

  assert.equal(result.status, 'accepted');
  assert.equal(result.policy.modeFor('manual'), 'primary');
  assert.equal(result.audit.revision, 'manual-primary-canary-1');
  assert.equal(result.primaryGateReceipt.assessment, 'eligible');
  assert.match(result.audit.sourceSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result.audit), /operator:admin|rollback/);
});

test('rejects a missing, tampered or ineligible Primary gate receipt', async () => {
  const missingPath = await fixturePath('missing-gate-manifest.json');
  await fs.writeFile(
    missingPath,
    JSON.stringify(enabledManifest('a'.repeat(64))),
  );
  const missing = await loadRuntimeRolloutManifest(missingPath, {
    clock: { now: () => NOW },
  });
  assert.equal(missing.status, 'rejected');
  assert.equal(missing.audit.reasonCode, 'PRIMARY_GATE_READ_FAILED');

  const tamperedPath = await fixturePath('tampered-gate-manifest.json');
  const tampered = gateReceipt();
  tampered.sources.terminal.counts.matched = 7;
  const tamperedDigest = await writeGateReceipt(tamperedPath, tampered);
  await fs.writeFile(
    tamperedPath,
    JSON.stringify(enabledManifest(tamperedDigest)),
  );
  const tamperedResult = await loadRuntimeRolloutManifest(tamperedPath, {
    clock: { now: () => NOW },
  });
  assert.equal(tamperedResult.status, 'rejected');
  assert.equal(tamperedResult.audit.reasonCode, 'PRIMARY_GATE_INVALID');

  const invalidPath = await fixturePath('invalid-gate-manifest.json');
  const ineligible = {
    ...gateReceipt(),
    assessment: 'ineligible',
    violations: ['terminal_not_matched'],
  };
  const digest = await writeGateReceipt(invalidPath, ineligible);
  await fs.writeFile(invalidPath, JSON.stringify(enabledManifest(digest)));
  const invalid = await loadRuntimeRolloutManifest(invalidPath, {
    clock: { now: () => NOW },
  });
  assert.equal(invalid.status, 'rejected');
  assert.equal(invalid.audit.reasonCode, 'PRIMARY_GATE_INVALID');
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
