'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  automationFixture,
  completionReviewFixture,
  parseArguments,
  reviewFixture,
  secretConfigFixture,
} = require('../../scripts/ql3-local-alpha-reconciliation-decision-fixture.cjs');

const DOMAINS = [
  'schema_lineage',
  'automation',
  'secret_and_config',
  'run_history',
  'plugin_package',
  'ai_and_tool',
  'identity_policy_audit',
  'unknown',
];
const PLAN_DIGEST = '1'.repeat(64);
const PREPARATION_DIGEST = '2'.repeat(64);
const AUTOMATION_PLAN_DIGEST = '3'.repeat(64);
const INVENTORY_DIGEST = '4'.repeat(64);
const REVIEW_ID = '019f8680-143d-4000-8000-000000000301';
const AUTOMATION_ID = '019f8680-143d-4000-8000-000000000461';
const DECISION_ID = '019f8680-143d-7000-8000-000000000471';
const SECRET_CONFIG_ID = '019f8680-143d-4000-8000-000000000491';
const SECRET_CONFIG_DECISION_ID = '019f8680-143d-7000-8000-0000000004a1';
const SECRET_CONFIG_PLAN_DIGEST = '6'.repeat(64);
const SECRET_CONFIG_PREPARATION_DIGEST = '7'.repeat(64);

function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-reconciliation-decisions-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'diagnostics'), { mode: 0o700 });
  let recordCount = 0;
  for (const database of ['legacy', 'target']) {
    for (const domain of DOMAINS) {
      for (const factKind of ['schema_object', 'table']) {
        const records = [];
        if (
          database === 'legacy' &&
          domain === 'automation' &&
          factKind === 'table'
        ) {
          records.push({
            schema: 'qinglong3-local-reconciliation-diagnostic-fact',
            schemaVersion: 1,
            ordinal: 1,
            database,
            domain,
            factKind,
            objectType: 'table',
            name: 'Crontabs',
            tableName: 'Crontabs',
            rowCount: '1',
            decisionRequirement: 'required',
            reason: 'reviewable_fact',
            factDigest: 'a'.repeat(64),
          });
        }
        if (
          database === 'legacy' &&
          domain === 'unknown' &&
          factKind === 'table'
        ) {
          records.push({
            schema: 'qinglong3-local-reconciliation-diagnostic-fact',
            schemaVersion: 1,
            ordinal: 1,
            database,
            domain,
            factKind,
            objectType: 'table',
            name: 'PluginOwnedState',
            tableName: 'PluginOwnedState',
            rowCount: null,
            decisionRequirement: 'blocked',
            reason: 'unknown_schema',
            factDigest: 'b'.repeat(64),
          });
        }
        if (
          database === 'legacy' &&
          domain === 'run_history' &&
          factKind === 'table'
        ) {
          records.push({
            schema: 'qinglong3-local-reconciliation-diagnostic-fact',
            schemaVersion: 1,
            ordinal: 1,
            database,
            domain,
            factKind,
            objectType: 'table',
            name: 'ExecutionHistory',
            tableName: 'ExecutionHistory',
            rowCount: '1',
            decisionRequirement: 'required',
            reason: 'historical_preservation_required',
            factDigest: 'd'.repeat(64),
          });
        }
        if (
          database === 'target' &&
          domain === 'automation' &&
          factKind === 'table'
        ) {
          records.push({
            schema: 'qinglong3-local-reconciliation-diagnostic-fact',
            schemaVersion: 1,
            ordinal: 1,
            database,
            domain,
            factKind,
            objectType: 'table',
            name: 'QingLong3TaskDefinitions',
            tableName: 'QingLong3TaskDefinitions',
            rowCount: '1',
            decisionRequirement: 'required',
            reason: 'reviewable_fact',
            factDigest: 'c'.repeat(64),
          });
        }
        recordCount += records.length;
        fs.writeFileSync(
          path.join(
            root,
            'diagnostics',
            `${database}-${domain}-${factKind}-0.json`,
          ),
          `${JSON.stringify({
            schema: 'qinglong3-local-reconciliation-diagnostic-page',
            schemaVersion: 1,
            state: 'reconciliation_review_prepared',
            reviewId: REVIEW_ID,
            planId: '019f8680-143d-4000-8000-000000000201',
            planDigest: PLAN_DIGEST,
            preparationDigest: PREPARATION_DIGEST,
            bundleDigest: 'd'.repeat(64),
            bundleFingerprintDigest: 'e'.repeat(64),
            database,
            domain,
            factKind,
            offset: 0,
            limit: 64,
            recordCount: records.length,
            complete: true,
            nextOffset: null,
            records,
            pageDigest: 'f'.repeat(64),
          })}\n`,
          { mode: 0o600 },
        );
      }
    }
  }
  fs.writeFileSync(
    path.join(root, 'summary.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      schema: 'qinglong/local-alpha-reconciliation-rehearsal-summary@v1',
      status: 'operator_decision_required',
      profile: 'edge',
      plan: {
        planId: '019f8680-143d-4000-8000-000000000201',
        planDigest: PLAN_DIGEST,
      },
      review: {
        reviewId: REVIEW_ID,
        preparationDigest: PREPARATION_DIGEST,
        diagnosticPages: 32,
        diagnosticRecords: recordCount,
      },
    })}\n`,
    { mode: 0o600 },
  );
  return { root, recordCount };
}

test('builds explicit synthetic review decisions without approving blocked facts', (t) => {
  const state = fixture(t);
  const output = path.join(
    path.dirname(state.root),
    `${path.basename(state.root)}.review.ndjson`,
  );
  t.after(() => fs.rmSync(output, { force: true }));
  const report = reviewFixture(state.root, output);
  assert.equal(report.adoptedAutomationTables, 1);
  const records = fs
    .readFileSync(output, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(
    records[0].kind,
    'qinglong3-local-reconciliation-review-decision-header',
  );
  const crontabs = records.find(
    (record) => record.factDigest === 'a'.repeat(64),
  );
  const unknown = records.find(
    (record) => record.factDigest === 'b'.repeat(64),
  );
  const target = records.find((record) => record.factDigest === 'c'.repeat(64));
  const legacyRunHistory = records.find(
    (record) => record.factDigest === 'd'.repeat(64),
  );
  assert.deepEqual(
    [crontabs.disposition, crontabs.reason],
    ['adopt_legacy', 'prefer_legacy'],
  );
  assert.deepEqual(
    [unknown.disposition, unknown.reason],
    ['manual_external', 'external_recovery_required'],
  );
  assert.deepEqual(
    [target.disposition, target.reason],
    ['retain_target', 'preserve_target'],
  );
  assert.deepEqual(
    [legacyRunHistory.disposition, legacyRunHistory.reason],
    ['manual_external', 'external_recovery_required'],
  );
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});

test('review fixture fails closed without the exact Legacy Crontabs fact', (t) => {
  const state = fixture(t);
  const pagePath = path.join(
    state.root,
    'diagnostics/legacy-automation-table-0.json',
  );
  const page = JSON.parse(fs.readFileSync(pagePath, 'utf8'));
  page.records[0].tableName = 'CronLikeState';
  fs.writeFileSync(pagePath, `${JSON.stringify(page)}\n`);
  const output = path.join(
    path.dirname(state.root),
    `${path.basename(state.root)}.invalid.ndjson`,
  );
  assert.throws(
    () => reviewFixture(state.root, output),
    /exactly one reviewable Legacy Crontabs table/,
  );
  assert.equal(fs.existsSync(output), false);
});

function completionReviewState(t) {
  const state = fixture(t);
  const unknownPath = path.join(
    state.root,
    'diagnostics/legacy-unknown-table-0.json',
  );
  const unknown = JSON.parse(fs.readFileSync(unknownPath, 'utf8'));
  unknown.records = [];
  unknown.recordCount = 0;
  fs.writeFileSync(unknownPath, `${JSON.stringify(unknown)}\n`);
  const additions = [
    ['legacy', 'secret_and_config', '6'],
    ['target', 'secret_and_config', '7'],
    ['target', 'run_history', '8'],
  ];
  for (const [database, domain, digest] of additions) {
    const pagePath = path.join(
      state.root,
      'diagnostics',
      `${database}-${domain}-table-0.json`,
    );
    const page = JSON.parse(fs.readFileSync(pagePath, 'utf8'));
    page.records = [
      {
        schema: 'qinglong3-local-reconciliation-diagnostic-fact',
        schemaVersion: 1,
        ordinal: 1,
        database,
        domain,
        factKind: 'table',
        objectType: 'table',
        name:
          domain === 'secret_and_config'
            ? database === 'legacy'
              ? 'Envs'
              : 'QingLong3Secrets'
            : 'QingLong3Runs',
        tableName:
          domain === 'secret_and_config'
            ? database === 'legacy'
              ? 'Envs'
              : 'QingLong3Secrets'
            : 'QingLong3Runs',
        rowCount: '1',
        decisionRequirement: 'required',
        reason:
          domain === 'run_history'
            ? 'historical_preservation_required'
            : 'secret_custody_required',
        factDigest: digest.repeat(64),
      },
    ];
    page.recordCount = 1;
    fs.writeFileSync(pagePath, `${JSON.stringify(page)}\n`);
  }
  const summaryPath = path.join(state.root, 'summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  summary.review.diagnosticRecords = state.recordCount - 1 + additions.length;
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary)}\n`);
  return state;
}

test('builds completion review authority for all adapted domains', (t) => {
  const state = completionReviewState(t);
  const output = path.join(
    path.dirname(state.root),
    `${path.basename(state.root)}.completion-review.ndjson`,
  );
  t.after(() => fs.rmSync(output, { force: true }));
  const report = completionReviewFixture(state.root, output);
  assert.equal(report.adoptedAutomationTables, 1);
  assert.equal(report.legacyRunHistoryFacts, 1);
  assert.equal(report.targetRunHistoryFacts, 1);
  assert.equal(report.secretConfigFacts, 2);
  const decisions = fs
    .readFileSync(output, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
    .slice(1);
  assert.ok(
    decisions.some(
      (decision) =>
        decision.database === 'legacy' &&
        decision.domain === 'run_history' &&
        decision.disposition === 'retain_both' &&
        decision.reason === 'preserve_both',
    ),
  );
  assert.ok(
    decisions
      .filter((decision) => decision.domain === 'secret_and_config')
      .every(
        (decision) =>
          decision.disposition === 'manual_external' &&
          decision.reason === 'external_recovery_required',
      ),
  );
});

test('completion review fixture refuses any blocked domain', (t) => {
  const state = fixture(t);
  const output = path.join(
    path.dirname(state.root),
    `${path.basename(state.root)}.blocked-completion.ndjson`,
  );
  assert.throws(
    () => completionReviewFixture(state.root, output),
    /refuses blocked diagnostic facts/,
  );
  assert.equal(fs.existsSync(output), false);
});

function automationState(t) {
  const state = fixture(t);
  fs.writeFileSync(
    path.join(state.root, 'summary.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      schema: 'qinglong/local-alpha-reconciliation-rehearsal-summary@v1',
      status: 'automation_decision_required',
      profile: 'edge',
      automation: {
        automationId: AUTOMATION_ID,
        automationPlanDigest: AUTOMATION_PLAN_DIGEST,
        rowCount: 1,
        eligibleCount: 1,
        conflictCount: 0,
      },
      decision: { decisionId: DECISION_ID },
    })}\n`,
  );
  const directory = path.join(state.root, 'automation', AUTOMATION_ID);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, 'receipt.json'),
    `${JSON.stringify({
      schema: 'qinglong3-local-reconciliation-automation-plan-receipt',
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      automationPlanDigest: AUTOMATION_PLAN_DIGEST,
      rowCount: 1,
      eligibleCount: 1,
      manualCount: 0,
      conflictCount: 0,
      legacyInventoryDigest: INVENTORY_DIGEST,
    })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(directory, 'plan.ndjson'),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-reconciliation-automation-plan-row',
      rowOrdinal: 1,
      sourceDigest: '5'.repeat(64),
      requirement: 'review_adopt',
      target: { state: 'absent' },
    })}\n`,
    { mode: 0o600 },
  );
  return state;
}

test('builds one reviewed-lossless Automation row decision', (t) => {
  const state = automationState(t);
  const output = path.join(
    path.dirname(state.root),
    `${path.basename(state.root)}.automation.ndjson`,
  );
  t.after(() => fs.rmSync(output, { force: true }));
  const report = automationFixture(state.root, output);
  assert.equal(report.decisionCount, 1);
  const records = fs
    .readFileSync(output, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(records[0].decisionId, DECISION_ID);
  assert.deepEqual(records[1].decision, {
    rowOrdinal: 1,
    sourceDigest: '5'.repeat(64),
    disposition: 'adopt',
    reason: 'reviewed_lossless',
  });
});

test('Automation fixture rejects a conflict before writing decisions', (t) => {
  const state = automationState(t);
  const summaryPath = path.join(state.root, 'summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  summary.automation.eligibleCount = 0;
  summary.automation.conflictCount = 1;
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary)}\n`);
  const output = path.join(
    path.dirname(state.root),
    `${path.basename(state.root)}.conflict.ndjson`,
  );
  assert.throws(
    () => automationFixture(state.root, output),
    /one conflict-free eligible Automation row/,
  );
  assert.equal(fs.existsSync(output), false);
});

function secretConfigState(t) {
  const state = fixture(t);
  fs.writeFileSync(
    path.join(state.root, 'summary.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      schema: 'qinglong/local-alpha-reconciliation-rehearsal-summary@v1',
      status: 'secret_config_decision_required',
      profile: 'edge',
      secretConfig: {
        secretConfigId: SECRET_CONFIG_ID,
        secretConfigPlanDigest: SECRET_CONFIG_PLAN_DIGEST,
        eligibleBindingCount: 1,
        eligiblePreservationCount: 1,
        targetConflictCount: 0,
        unadaptedLegacyConfigCount: 0,
      },
      secretConfigDecision: {
        decisionId: SECRET_CONFIG_DECISION_ID,
        preparationDigest: SECRET_CONFIG_PREPARATION_DIGEST,
      },
    })}\n`,
  );
  const directory = path.join(state.root, 'secret-config', SECRET_CONFIG_ID);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, 'receipt.json'),
    `${JSON.stringify({
      schema: 'qinglong3-local-reconciliation-secret-config-plan-receipt',
      schemaVersion: 1,
      state: 'reconciliation_secret_config_planned',
      secretConfigId: SECRET_CONFIG_ID,
      secretConfigPlanDigest: SECRET_CONFIG_PLAN_DIGEST,
      outcome: 'ready',
      eligibleBindingCount: 1,
      eligiblePreservationCount: 1,
      targetConflictCount: 0,
      unadaptedLegacyConfigCount: 0,
    })}\n`,
    { mode: 0o600 },
  );
  const candidates = [
    ['review_apply_binding', '9'],
    ['review_preserve_disabled', 'a'],
  ].map(([requirement, digest], index) => ({
    schemaVersion: 1,
    kind: 'qinglong3-local-reconciliation-secret-config-plan-candidate',
    candidateOrdinal: index + 1,
    candidateDigest: digest.repeat(64),
    requirement,
    target: { state: 'absent' },
  }));
  fs.writeFileSync(
    path.join(directory, 'plan.ndjson'),
    `${candidates.map((candidate) => JSON.stringify(candidate)).join('\n')}\n`,
    { mode: 0o600 },
  );
  return state;
}

test('builds reviewed Secret/Config candidate decisions', (t) => {
  const state = secretConfigState(t);
  const output = path.join(
    path.dirname(state.root),
    `${path.basename(state.root)}.secret-config.ndjson`,
  );
  t.after(() => fs.rmSync(output, { force: true }));
  const report = secretConfigFixture(state.root, output);
  assert.equal(report.decisionCount, 2);
  const records = fs
    .readFileSync(output, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(records[0].decisionId, SECRET_CONFIG_DECISION_ID);
  assert.deepEqual(
    records.slice(1).map(({ disposition, reason }) => ({
      disposition,
      reason,
    })),
    [
      {
        disposition: 'apply_active_binding',
        reason: 'reviewed_active_binding',
      },
      {
        disposition: 'preserve_disabled',
        reason: 'reviewed_disabled_preservation',
      },
    ],
  );
});

test('CLI grammar is exact', () => {
  assert.throws(
    () => parseArguments(['--mode=review', '--output=/tmp/review.ndjson']),
    /fixture arguments are invalid/,
  );
  assert.throws(
    () =>
      parseArguments([
        '--mode=completion',
        '--reconciliation-root=/tmp/root',
        '--output=/tmp/review.ndjson',
      ]),
    /fixture arguments are invalid/,
  );
});
