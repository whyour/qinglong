require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const {
  manualPrimaryCanaryFileSet,
} = require('../../back/runtime/domain/manualPrimaryCanaryCeremony');
const {
  createManualPrimaryRuntimeReceipt,
  MANUAL_PRIMARY_RUNTIME_RECEIPT_FILE,
} = require('../../back/runtime/domain/manualPrimaryRuntimeReceipt');
const {
  parseArguments,
  readPrivateJson,
  run,
} = require('../../scripts/ql3-manual-primary-canary.cjs');
const {
  run: audit,
} = require('../../scripts/ql3-manual-primary-canary-audit.cjs');

const NOW = Date.now();
const START = NOW - 7 * 60_000;
const END = START + 1_000;
const QUALIFIED_AT = END + 6 * 60_000;
const SESSION = 'edge-live-0001';
const directories = [];

function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-canary-'));
  directories.push(root);
  return root;
}

function writeJson(target, value) {
  fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

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
    observedAtMs: QUALIFIED_AT - 1,
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

function resourceEvidence() {
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

function prepare(root, clock = START - 1_000) {
  return run(
    {
      mode: 'prepare',
      root,
      sessionId: SESSION,
      profile: 'edge',
      admissions: 8,
    },
    { clock: { now: () => clock } },
  );
}

function seedSources(root) {
  const files = manualPrimaryCanaryFileSet(SESSION);
  writeJson(path.join(root, files.capture), captureEvidence());
  writeJson(path.join(root, files.terminal), terminal());
  writeJson(path.join(root, files.resource), resourceEvidence());
  return files;
}

afterEach(() => {
  for (const root of directories.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepares an idempotent private plan and exposes only explicit canary environment', () => {
  const root = directory();
  const first = prepare(root);
  const second = prepare(root, START);
  const files = manualPrimaryCanaryFileSet(SESSION);

  assert.equal(first.state, 'prepared');
  assert.equal(first.automaticActivation, false);
  assert.deepEqual(first.environment, {
    QL_DEPLOYMENT_PROFILE: 'edge',
    QL3_SHADOW_ORIGINS: 'manual',
    QL3_SHADOW_CAPTURE_EVIDENCE_FILE: files.capture,
  });
  assert.equal(second.publication, 'existing');
  assert.equal(fs.statSync(path.join(root, files.plan)).mode & 0o777, 0o600);
  assert.equal(
    run({ mode: 'status', root, sessionId: SESSION }).state,
    'prepared',
  );
});

test('qualifies, explicitly approves, audits and rolls back one target session', () => {
  const root = directory();
  prepare(root);
  const files = seedSources(root);

  const qualified = run(
    { mode: 'qualify', root, sessionId: SESSION },
    { clock: { now: () => QUALIFIED_AT } },
  );
  assert.equal(qualified.state, 'qualified');
  assert.equal(qualified.automaticActivation, false);
  fs.unlinkSync(path.join(root, files.qualification));
  assert.equal(
    run(
      { mode: 'qualify', root, sessionId: SESSION },
      { clock: { now: () => QUALIFIED_AT + 10 } },
    ).state,
    'qualified',
  );
  assert.equal(
    audit({ root, sessionId: SESSION, require: 'qualified' }).compatible,
    true,
  );

  const activatedAt = Math.max(Date.now(), QUALIFIED_AT + 1);
  const approved = run(
    {
      mode: 'approve',
      root,
      sessionId: SESSION,
      approvedBy: 'operator:local-owner',
      approvalMs: 60 * 60 * 1_000,
    },
    { clock: { now: () => activatedAt } },
  );
  assert.equal(approved.state, 'activation_approved');
  const selection = readPrivateJson(
    path.join(root, files.selection),
    64 * 1024,
  ).value;
  assert.equal(selection.selectedAtMs, activatedAt);
  assert.equal(Object.hasOwn(selection, 'activatedAtMs'), false);
  fs.unlinkSync(path.join(root, files.selection));
  assert.throws(
    () =>
      run(
        {
          mode: 'approve',
          root,
          sessionId: SESSION,
          approvedBy: 'operator:different-owner',
          approvalMs: 60 * 60 * 1_000,
        },
        { clock: { now: () => activatedAt + 5 } },
      ),
    (error) => error.code === 'active_rollout_drift',
  );
  assert.equal(
    run(
      {
        mode: 'approve',
        root,
        sessionId: SESSION,
        approvedBy: 'operator:local-owner',
        approvalMs: 60 * 60 * 1_000,
      },
      { clock: { now: () => activatedAt + 10 } },
    ).state,
    'activation_approved',
  );
  assert.equal(
    audit({ root, sessionId: SESSION, require: 'selected' }).rolloutMode,
    'primary_selected',
  );
  assert.equal(
    audit({ root, sessionId: SESSION, require: 'selected' })
      .runtimeActivationObserved,
    false,
  );
  const rolloutSha256 = readPrivateJson(
    path.join(root, files.rollout),
    64 * 1024,
  ).sha256;
  writeJson(
    path.join(root, MANUAL_PRIMARY_RUNTIME_RECEIPT_FILE),
    createManualPrimaryRuntimeReceipt({
      activationId: '1'.repeat(32),
      profile: 'edge',
      revision: `manual-primary-${SESSION}`,
      rolloutSourceSha256: rolloutSha256,
      activatedAtMs: activatedAt + 1,
      process: {
        kind: 'linux-proc',
        platform: 'linux',
        pid: 999_999,
        processGroupId: 999_999,
        bootId: '11111111-2222-3333-4444-555555555555',
        startTimeTicks: '123456',
      },
    }),
  );
  const active = audit(
    { root, sessionId: SESSION, require: 'active' },
    { inspectRuntimeProcess: () => 'running' },
  );
  assert.equal(active.runtimeActivationObserved, true);
  assert.equal(active.runtimeActivationCurrent, true);
  assert.equal(active.runtimeReceiptState, 'active');
  assert.equal(
    run(
      { mode: 'status', root, sessionId: SESSION },
      { clock: { now: () => activatedAt + 1 } },
    ).state,
    'activation_approved',
  );
  assert.throws(
    () => audit({ root, sessionId: SESSION, require: 'rolled-back' }),
    /not satisfied/,
  );

  const rolledBack = run(
    {
      mode: 'rollback',
      root,
      sessionId: SESSION,
      operator: 'operator:local-owner',
      reason: 'operator_request',
    },
    { clock: { now: () => activatedAt + 2 } },
  );
  assert.equal(rolledBack.state, 'rolled_back');
  fs.unlinkSync(path.join(root, files.rollbackComplete));
  assert.equal(
    run(
      {
        mode: 'rollback',
        root,
        sessionId: SESSION,
        operator: 'operator:local-owner',
        reason: 'operator_request',
      },
      { clock: { now: () => activatedAt + 3 } },
    ).state,
    'rolled_back',
  );
  assert.equal(
    run(
      {
        mode: 'rollback',
        root,
        sessionId: SESSION,
        operator: 'operator:local-owner',
        reason: 'operator_request',
      },
      { clock: { now: () => activatedAt + 4 } },
    ).publication,
    'existing',
  );
  assert.throws(
    () =>
      audit(
        { root, sessionId: SESSION, require: 'rolled-back' },
        { inspectRuntimeProcess: () => 'running' },
      ),
    /not satisfied/,
  );
  writeJson(
    path.join(root, MANUAL_PRIMARY_RUNTIME_RECEIPT_FILE),
    createManualPrimaryRuntimeReceipt({
      activationId: '2'.repeat(32),
      profile: 'edge',
      revision: 'manual-primary-another-session',
      rolloutSourceSha256: 'b'.repeat(64),
      activatedAtMs: activatedAt + 3,
      process: {
        kind: 'linux-proc',
        platform: 'linux',
        pid: 999_998,
        processGroupId: 999_998,
        bootId: '11111111-2222-3333-4444-555555555555',
        startTimeTicks: '123457',
      },
    }),
  );
  assert.throws(
    () =>
      audit(
        { root, sessionId: SESSION, require: 'rolled-back' },
        { inspectRuntimeProcess: () => 'running' },
      ),
    /not satisfied/,
  );
  assert.equal(
    audit({ root, sessionId: SESSION, require: 'rolled-back' }).rolloutMode,
    'off',
  );
  assert.equal(
    readPrivateJson(path.join(root, files.rollout), 64 * 1024).value.enabled,
    false,
  );
  const completionPath = path.join(root, files.rollbackComplete);
  const completion = readPrivateJson(completionPath, 64 * 1024).value;
  completion.intentSha256 = '0'.repeat(64);
  writeJson(completionPath, completion);
  assert.throws(
    () => audit({ root, sessionId: SESSION, require: 'rolled-back' }),
    /receipt chain drifted/,
  );
});

test('observe and resource use fixed child commands and recover from existing evidence', () => {
  const root = directory();
  prepare(root);
  const files = manualPrimaryCanaryFileSet(SESSION);
  writeJson(path.join(root, files.capture), captureEvidence());
  const database = path.join(root, 'database.sqlite');
  fs.writeFileSync(database, 'sqlite-fixture', { mode: 0o600 });
  const calls = [];
  const spawnSync = (_node, arguments_) => {
    calls.push(arguments_);
    const value = arguments_[0].endsWith('terminal-audit.cjs')
      ? terminal()
      : resourceEvidence();
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify(value),
      stderr: '',
    };
  };
  const dependencies = {
    clock: { now: () => QUALIFIED_AT },
    spawnSync,
    workspaceRoot: path.resolve(__dirname, '../..'),
  };

  assert.equal(
    run({ mode: 'observe', root, sessionId: SESSION, database }, dependencies)
      .state,
    'terminal_observed',
  );
  assert.equal(
    run({ mode: 'resource', root, sessionId: SESSION }, dependencies).state,
    'resource_proven',
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('--origin=manual'));
  assert.ok(calls[1].includes('--require-compiled'));
  run({ mode: 'observe', root, sessionId: SESSION, database }, dependencies);
  run({ mode: 'resource', root, sessionId: SESSION }, dependencies);
  assert.equal(calls.length, 2);
});

test('fails closed on unsafe roots, incomplete cohorts and rollout drift', () => {
  const root = directory();
  const symlink = `${root}-link`;
  fs.symlinkSync(root, symlink);
  directories.push(symlink);
  assert.throws(
    () =>
      run({
        mode: 'prepare',
        root: symlink,
        sessionId: SESSION,
        profile: 'edge',
        admissions: 8,
      }),
    (error) => error.code === 'root_unsafe',
  );

  prepare(root);
  const files = seedSources(root);
  const capture = captureEvidence(7);
  writeJson(path.join(root, 'wrong-capture.json'), capture);
  fs.renameSync(
    path.join(root, 'wrong-capture.json'),
    path.join(root, files.capture),
  );
  assert.throws(
    () =>
      run(
        { mode: 'qualify', root, sessionId: SESSION },
        { clock: { now: () => QUALIFIED_AT } },
      ),
    /capture_not_ready/,
  );

  assert.throws(
    () =>
      parseArguments([
        '--mode=rollback',
        `--root=${root}`,
        `--session=${SESSION}`,
        '--operator=owner',
        '--reason=arbitrary-text',
      ]),
    /supported/,
  );
});

test('binds an existing disabled rollout and rejects a changed live baseline', () => {
  const root = directory();
  const disabled = {
    schemaVersion: 2,
    revision: 'operator-disabled-baseline',
    enabled: false,
  };
  writeJson(path.join(root, 'qinglong3-rollout.json'), disabled);
  prepare(root);
  const plan = readPrivateJson(
    path.join(root, manualPrimaryCanaryFileSet(SESSION).plan),
    64 * 1024,
  ).value;
  assert.equal(plan.currentRollout.state, 'disabled');

  writeJson(path.join(root, 'changed.json'), {
    schemaVersion: 2,
    revision: 'changed-disabled-baseline',
    enabled: false,
  });
  fs.renameSync(
    path.join(root, 'changed.json'),
    path.join(root, 'qinglong3-rollout.json'),
  );
  assert.throws(
    () => prepare(root, START),
    (error) => error.code === 'rollout_changed',
  );
});

test('reports an expired approval as runtime-off until explicit rollback', () => {
  const root = directory();
  prepare(root);
  seedSources(root);
  run(
    { mode: 'qualify', root, sessionId: SESSION },
    { clock: { now: () => QUALIFIED_AT } },
  );
  const activatedAt = Math.max(Date.now(), QUALIFIED_AT + 1);
  run(
    {
      mode: 'approve',
      root,
      sessionId: SESSION,
      approvedBy: 'operator:local-owner',
      approvalMs: 60_000,
    },
    { clock: { now: () => activatedAt } },
  );

  const report = run(
    { mode: 'status', root, sessionId: SESSION },
    { clock: { now: () => activatedAt + 60_000 } },
  );
  assert.equal(report.state, 'approval_expired');
  assert.equal(report.rolloutMode, 'off');
  assert.equal(report.approvalExpired, true);
});

test('independent audit rejects source replacement after qualification', () => {
  const root = directory();
  prepare(root);
  const files = seedSources(root);
  run(
    { mode: 'qualify', root, sessionId: SESSION },
    { clock: { now: () => QUALIFIED_AT } },
  );
  const replaced = resourceEvidence();
  replaced.unreviewed = true;
  writeJson(path.join(root, 'replacement.json'), replaced);
  fs.renameSync(
    path.join(root, 'replacement.json'),
    path.join(root, files.resource),
  );

  assert.throws(
    () => audit({ root, sessionId: SESSION, require: 'qualified' }),
    /drifted/,
  );
});

test('independent audit rejects qualification canonical digest drift', () => {
  const root = directory();
  prepare(root);
  const files = seedSources(root);
  run(
    { mode: 'qualify', root, sessionId: SESSION },
    { clock: { now: () => QUALIFIED_AT } },
  );
  const qualificationPath = path.join(root, files.qualification);
  const qualification = readPrivateJson(qualificationPath, 64 * 1024).value;
  qualification.sourceCanonicalSha256.capture = '0'.repeat(64);
  writeJson(qualificationPath, qualification);

  assert.throws(
    () => audit({ root, sessionId: SESSION, require: 'qualified' }),
    /drifted/,
  );
});
