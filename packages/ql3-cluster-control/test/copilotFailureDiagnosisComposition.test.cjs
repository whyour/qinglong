const assert = require('node:assert/strict');
const { chmod, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const {
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CONFIG_SCHEMA,
  ClusterCopilotFailureDiagnosisCompositionError,
  canonicalClusterCopilotFailureDiagnosisConfig,
  loadClusterCopilotFailureDiagnosisConfig,
  normalizeClusterCopilotFailureDiagnosisConfig,
} = require('@qinglong/cluster-control/copilot-production');

function config(overrides = {}) {
  return {
    schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CONFIG_SCHEMA,
    provider: 'provider-primary',
    model: 'model-diagnosis',
    modelBoundary: 'external',
    responseLanguage: 'zh-CN',
    maxOutputTokens: 512,
    executionTimeoutMs: 60_000,
    egressPolicy: {
      schema: 'qinglong/copilot-model-egress-policy@v1',
      revision: 'cluster-copilot-v1',
      potentiallySensitiveDataBoundaries: ['external'],
      maxInputBytes: 64 * 1024,
      maxOutputTokens: 1024,
    },
    ...overrides,
  };
}

test('normalizes one bounded deployment-owned Copilot model intent', () => {
  const normalized = normalizeClusterCopilotFailureDiagnosisConfig(config());
  assert.equal(normalized.provider, 'provider-primary');
  assert.equal(normalized.executionTimeoutMs, 60_000);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.egressPolicy), true);
  assert.throws(
    () => normalizeClusterCopilotFailureDiagnosisConfig(config({ extra: true })),
    ClusterCopilotFailureDiagnosisCompositionError,
  );
  assert.throws(
    () => normalizeClusterCopilotFailureDiagnosisConfig(config({
      modelBoundary: 'on_device',
    })),
    /egress model boundaries/,
  );
  assert.throws(
    () => normalizeClusterCopilotFailureDiagnosisConfig(config({
      executionTimeoutMs: 300_001,
    })),
    /execution timeout/,
  );
});

test('loads only canonical read-only projected Copilot configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ql3-copilot-config-test-'));
  const file = join(root, 'config.json');
  const canonical = canonicalClusterCopilotFailureDiagnosisConfig(config());
  try {
    await writeFile(file, canonical, { mode: 0o440 });
    await chmod(file, 0o440);
    assert.deepEqual(
      await loadClusterCopilotFailureDiagnosisConfig(file),
      normalizeClusterCopilotFailureDiagnosisConfig(config()),
    );

    await chmod(file, 0o640);
    await writeFile(file, Buffer.from(`${JSON.stringify(config(), null, 2)}\n`), {
      mode: 0o440,
    });
    await chmod(file, 0o440);
    await assert.rejects(
      loadClusterCopilotFailureDiagnosisConfig(file),
      /not canonical/,
    );

    await chmod(file, 0o640);
    await writeFile(file, canonical, { mode: 0o640 });
    await chmod(file, 0o640);
    await assert.rejects(
      loadClusterCopilotFailureDiagnosisConfig(file),
      ClusterCopilotFailureDiagnosisCompositionError,
    );
  } finally {
    canonical.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});
