require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  RuntimeRolloutPolicy,
  shadowOnlyRollout,
} = require('../../back/runtime/domain/runtimeRollout');
const {
  MAX_RUNTIME_ROLLOUT_APPROVAL_MS,
  parseRuntimeRolloutManifest,
} = require('../../back/runtime/domain/runtimeRolloutManifest');

const NOW = 1_750_000_000_000;

function enabledManifest(overrides = {}) {
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
    ...overrides,
  };
}

test('resolves per-origin rollout ownership without mutating caller config', () => {
  const origins = { manual: 'shadow', scheduled_node: 'primary' };
  const policy = new RuntimeRolloutPolicy({
    defaultMode: 'off',
    origins,
    allowLegacyFallbackBeforeStart: true,
  });
  origins.manual = 'off';

  assert.deepEqual(policy.decide('manual'), {
    origin: 'manual',
    mode: 'shadow',
    owner: 'legacy',
  });
  assert.deepEqual(policy.decide('scheduled_node'), {
    origin: 'scheduled_node',
    mode: 'primary',
    owner: 'runtime',
  });
  assert.deepEqual(policy.decide('grpc'), {
    origin: 'grpc',
    mode: 'off',
    owner: 'legacy',
  });

  const snapshot = policy.snapshot();
  snapshot.origins.manual = 'off';
  assert.equal(policy.modeFor('manual'), 'shadow');
});

test('builds a default-off shadow-only rollout policy', () => {
  const policy = shadowOnlyRollout(['manual', 'scheduled_node']);

  assert.equal(policy.modeFor('manual'), 'shadow');
  assert.equal(policy.modeFor('scheduled_node'), 'shadow');
  assert.equal(policy.modeFor('scheduled_system'), 'off');
  assert.equal(policy.snapshot().allowLegacyFallbackBeforeStart, false);
});

test('rejects unknown modes and origins at the configuration boundary', () => {
  assert.throws(
    () =>
      new RuntimeRolloutPolicy({
        defaultMode: 'invalid',
        origins: {},
        allowLegacyFallbackBeforeStart: false,
      }),
    TypeError,
  );
  assert.throws(
    () =>
      new RuntimeRolloutPolicy({
        defaultMode: 'off',
        origins: { unknown: 'shadow' },
        allowLegacyFallbackBeforeStart: false,
      }),
    TypeError,
  );
  assert.throws(
    () =>
      new RuntimeRolloutPolicy({
        defaultMode: 'off',
        origins: { manual: 'invalid' },
        allowLegacyFallbackBeforeStart: false,
      }),
    TypeError,
  );
});

test('parses a time-bounded, manual-only rollout manifest', () => {
  const decision = parseRuntimeRolloutManifest(enabledManifest(), NOW);

  assert.equal(decision.manifest.enabled, true);
  assert.equal(decision.manifest.revision, 'manual-primary-canary-1');
  assert.equal(decision.policy.modeFor('manual'), 'primary');
  assert.equal(decision.policy.modeFor('scheduled_system'), 'off');
  assert.equal(
    decision.policy.snapshot().allowLegacyFallbackBeforeStart,
    false,
  );

  const disabled = parseRuntimeRolloutManifest(
    { schemaVersion: 1, revision: 'disabled-1', enabled: false },
    NOW,
  );
  assert.equal(disabled.policy.modeFor('manual'), 'off');
});

test('rejects broad, stale, incomplete, and extensible rollout manifests', () => {
  const cases = [
    enabledManifest({
      rollout: {
        defaultMode: 'primary',
        origins: { manual: 'primary' },
        allowLegacyFallbackBeforeStart: false,
      },
    }),
    enabledManifest({
      rollout: {
        defaultMode: 'off',
        origins: { scheduled_system: 'primary' },
        allowLegacyFallbackBeforeStart: false,
      },
    }),
    enabledManifest({
      expiresAtMs: NOW,
    }),
    enabledManifest({
      expiresAtMs: NOW - 1_000 + MAX_RUNTIME_ROLLOUT_APPROVAL_MS + 1,
    }),
    enabledManifest({
      gates: {
        durableCancellation: 'passed',
        startupReconciliation: 'passed',
        atomicLegacyProjection: 'passed',
        rollbackDrill: 'passed',
      },
    }),
    { ...enabledManifest(), futureField: true },
  ];

  for (const manifest of cases) {
    assert.throws(() => parseRuntimeRolloutManifest(manifest, NOW), TypeError);
  }
});
