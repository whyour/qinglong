require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const {
  createLegacyShadowPrimaryGateReceipt,
  parseLegacyShadowPrimaryGateReceipt,
} = require('../../back/runtime/domain/legacyShadowPrimaryGate');
const {
  parseArguments,
  readEvidence,
  run,
} = require('../../scripts/ql3-legacy-shadow-primary-gate.cjs');

const START = 1_750_400_000_000;
const END = START + 60_000;
const GENERATED = END + 6 * 60_000;
const directories = [];

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

function terminal(scanned = 8) {
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
    scanned,
    remaining: false,
    evidenceComplete: true,
    assessment: 'matched',
    counts: { matched: scanned },
    byOrigin: [{ origin: 'manual', scanned, matched: scanned }],
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

function input(overrides = {}) {
  return {
    profile: 'edge',
    generatedAtMs: GENERATED,
    capture: captureEvidence(),
    terminal: terminal(),
    resource: resource(),
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('combines capture, startup, terminal and rollback evidence into eligibility', () => {
  const receipt = createLegacyShadowPrimaryGateReceipt(input());

  assert.equal(receipt.assessment, 'eligible');
  assert.deepEqual(receipt.violations, []);
  assert.deepEqual(receipt.counts, {
    admitted: 8,
    captured: 8,
    terminalScanned: 8,
    terminalMatched: 8,
  });
  assert.deepEqual(parseLegacyShadowPrimaryGateReceipt(receipt), receipt);
});

test('fails closed for an undersized cohort, terminal drift and audit-only rollback', () => {
  const capture = captureEvidence(7);
  const terminalReport = terminal(6);
  const rollback = resource();
  rollback.workload.mode = 'audit-only';
  const receipt = createLegacyShadowPrimaryGateReceipt(
    input({ capture, terminal: terminalReport, resource: rollback }),
  );

  assert.equal(receipt.assessment, 'ineligible');
  assert.deepEqual(receipt.violations, [
    'capture_sample_budget_invalid',
    'terminal_not_matched',
    'resource_not_compiled_full_rollback',
  ]);
  assert.throws(
    () =>
      parseLegacyShadowPrimaryGateReceipt({
        ...receipt,
        assessment: 'eligible',
      }),
    /invalid/,
  );
});

test('CLI reads no-follow bounded inputs and publishes a no-replace receipt', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-primary-gate-'));
  directories.push(directory);
  const paths = Object.fromEntries(
    ['capture', 'terminal', 'resource', 'output'].map((name) => [
      name,
      path.join(directory, `${name}.json`),
    ]),
  );
  fs.writeFileSync(paths.capture, `${JSON.stringify(captureEvidence())}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(paths.terminal, `${JSON.stringify(terminal())}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(paths.resource, `${JSON.stringify(resource())}\n`, {
    mode: 0o600,
  });
  const options = parseArguments([
    '--profile=edge',
    `--capture=${paths.capture}`,
    `--terminal=${paths.terminal}`,
    `--resource=${paths.resource}`,
    `--output=${paths.output}`,
    `--generated-at-ms=${GENERATED}`,
  ]);

  const receipt = run(options);
  assert.equal(receipt.assessment, 'eligible');
  assert.equal(
    parseLegacyShadowPrimaryGateReceipt(readEvidence(paths.output).value)
      .assessment,
    'eligible',
  );
  assert.equal(fs.statSync(paths.output).mode & 0o777, 0o600);
  assert.throws(() => run(options), /EEXIST/);

  const symlink = path.join(directory, 'capture-link.json');
  fs.symlinkSync(paths.capture, symlink);
  assert.throws(() => readEvidence(symlink), /ELOOP|symbolic/i);
});
