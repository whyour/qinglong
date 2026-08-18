require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createLegacyShadowPrimaryGateReceipt,
} = require('../../back/runtime/domain/legacyShadowPrimaryGate');
const {
  MANUAL_PRIMARY_CANARY_MAX_APPROVAL_MS,
  createManualPrimaryCanaryDisabledManifest,
  createManualPrimaryCanaryEnabledManifest,
  createManualPrimaryCanaryPlan,
  createManualPrimaryCanaryQualification,
  manualPrimaryCanaryFileSet,
  parseManualPrimaryCanaryPlan,
  parseManualPrimaryCanaryQualification,
} = require('../../back/runtime/domain/manualPrimaryCanaryCeremony');
const {
  parseRuntimeRolloutManifest,
} = require('../../back/runtime/domain/runtimeRolloutManifest');

const START = 1_750_400_000_000;
const END = START + 60_000;
const GENERATED = END + 6 * 60_000;
const DIGESTS = {
  plan: '1'.repeat(64),
  gate: '2'.repeat(64),
  capture: '3'.repeat(64),
  terminal: '4'.repeat(64),
  resource: '5'.repeat(64),
};

function captureEvidence(admitted = 8) {
  const outcomes = {
    completed: 0,
    cancelled: 0,
    abandoned: 0,
    markedLost: 0,
    repaired: 0,
    pending: 0,
    ambiguous: 0,
    skipped: 0,
    failed: 0,
  };
  return {
    schema: 'qinglong/legacy-shadow-capture-evidence@v1',
    profile: 'edge',
    startup: {
      schema: 'qinglong/legacy-shadow-startup-difference-report@v1',
      profile: 'edge',
      assessment: 'converged',
      configuredOriginCount: 1,
      coverage: { remaining: false },
      outcomes,
      byOrigin: [{ origin: 'manual', scanned: 0, ...outcomes }],
    },
    capture: {
      schema: 'qinglong/legacy-shadow-capture-report@v1',
      profile: 'edge',
      assessment: 'captured',
      epoch: '019f75d2-5555-7555-8555-555555555555',
      window: {
        basis: 'process_local_legacy_admission',
        startInclusiveMs: START,
        endExclusiveMs: END,
      },
      configuredOriginCount: 1,
      totals: {
        admitted,
        captured: admitted,
        failed: 0,
        pending: 0,
        failures: { fact: 0, observer: 0, initialization: 0, accept: 0 },
      },
      byOrigin: [
        {
          origin: 'manual',
          admitted,
          captured: admitted,
          failed: 0,
          pending: 0,
          failures: {
            fact: 0,
            observer: 0,
            initialization: 0,
            accept: 0,
          },
        },
      ],
      capturePermille: 1_000,
    },
    qualification: {
      passed: true,
      startupConverged: true,
      originCoverageExact: true,
      captureComplete: true,
    },
  };
}

function terminal() {
  return {
    schema: 'qinglong/legacy-shadow-terminal-difference-report@v1',
    profile: 'edge',
    observedAtMs: GENERATED - 1,
    window: {
      basis: 'shadow_run_created_at',
      startInclusiveMs: START,
      endExclusiveMs: END,
      minimumSettlingAgeMs: 300_000,
      closed: true,
    },
    coverage: {
      direction: 'shadow_to_legacy',
      cohort: 'legacy_owned_shadow_runs',
      legacyWithoutShadow: 'not_measured',
    },
    scanned: 8,
    remaining: false,
    evidenceComplete: true,
    assessment: 'matched',
    counts: { matched: 8 },
    byOrigin: [{ origin: 'manual', scanned: 8, matched: 8 }],
    terminalAgreementPermille: 1_000,
    fullyComparablePermille: 1_000,
  };
}

function resource() {
  return {
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
}

function plan() {
  return createManualPrimaryCanaryPlan({
    sessionId: 'edge-0001',
    profile: 'edge',
    createdAtMs: START - 1_000,
    admissionTarget: 8,
    currentRollout: { state: 'absent' },
  });
}

function gate() {
  return createLegacyShadowPrimaryGateReceipt({
    profile: 'edge',
    generatedAtMs: GENERATED,
    capture: captureEvidence(),
    terminal: terminal(),
    resource: resource(),
  });
}

function qualification() {
  return createManualPrimaryCanaryQualification({
    plan: plan(),
    planSha256: DIGESTS.plan,
    primaryGate: gate(),
    primaryGateFileSha256: DIGESTS.gate,
    sourceFileSha256: {
      capture: DIGESTS.capture,
      terminal: DIGESTS.terminal,
      resource: DIGESTS.resource,
    },
    qualifiedAtMs: GENERATED + 1,
  });
}

test('creates an exact profile-bounded canary plan with no automatic activation', () => {
  const value = plan();

  assert.deepEqual(parseManualPrimaryCanaryPlan(value), value);
  assert.deepEqual(value.files, manualPrimaryCanaryFileSet('edge-0001'));
  assert.equal(value.admissionTarget, 8);
  assert.equal(value.activation.defaultMode, 'off');
  assert.equal(value.activation.allowLegacyFallbackBeforeStart, false);
  assert.throws(
    () => createManualPrimaryCanaryPlan({ ...value, admissionTarget: 9 }),
    /admission target/,
  );
  assert.throws(
    () => parseManualPrimaryCanaryPlan({ ...value, command: 'enable' }),
    /shape/,
  );
});

test('allows a selected standalone cohort only inside the reviewed range', () => {
  const value = createManualPrimaryCanaryPlan({
    sessionId: 'standalone-0032',
    profile: 'standalone',
    createdAtMs: START,
    admissionTarget: 64,
    currentRollout: { state: 'disabled', sha256: DIGESTS.plan },
  });

  assert.equal(parseManualPrimaryCanaryPlan(value).admissionTarget, 64);
  for (const admissionTarget of [31, 129]) {
    assert.throws(
      () => createManualPrimaryCanaryPlan({ ...value, admissionTarget }),
      /admission target/,
    );
  }
});

test('binds the exact plan, source files and independently reproducible gate', () => {
  const value = qualification();

  assert.deepEqual(parseManualPrimaryCanaryQualification(value), value);
  assert.equal(value.assessment, 'eligible');
  assert.deepEqual(value.counts, {
    admitted: 8,
    captured: 8,
    terminalScanned: 8,
    terminalMatched: 8,
  });
  const wrongPlan = { ...plan(), admissionTarget: 7 };
  assert.throws(
    () =>
      createManualPrimaryCanaryQualification({
        plan: wrongPlan,
        planSha256: DIGESTS.plan,
        primaryGate: gate(),
        primaryGateFileSha256: DIGESTS.gate,
        sourceFileSha256: {
          capture: DIGESTS.capture,
          terminal: DIGESTS.terminal,
          resource: DIGESTS.resource,
        },
        qualifiedAtMs: GENERATED + 1,
      }),
    /admission target|match the plan/,
  );
});

test('creates only a short-lived manual Primary manifest after qualification', () => {
  const approvedAtMs = GENERATED + 2;
  const manifest = createManualPrimaryCanaryEnabledManifest({
    plan: plan(),
    qualification: qualification(),
    approvedBy: 'operator:local-owner',
    approvedAtMs,
    approvalMs: 60 * 60 * 1_000,
  });

  assert.equal(
    parseRuntimeRolloutManifest(manifest, approvedAtMs).policy.modeFor(
      'manual',
    ),
    'primary',
  );
  assert.equal(manifest.rollout.defaultMode, 'off');
  assert.equal(manifest.primaryGate.receiptSha256, DIGESTS.gate);
  assert.equal(manifest.rollbackPlanRef, plan().files.plan);
  assert.throws(
    () =>
      createManualPrimaryCanaryEnabledManifest({
        plan: plan(),
        qualification: qualification(),
        approvedBy: 'operator:local-owner',
        approvedAtMs,
        approvalMs: MANUAL_PRIMARY_CANARY_MAX_APPROVAL_MS + 1,
      }),
    /approval/,
  );
  assert.deepEqual(createManualPrimaryCanaryDisabledManifest('edge-0001'), {
    schemaVersion: 2,
    revision: 'manual-primary-edge-0001-rollback',
    enabled: false,
  });
});
