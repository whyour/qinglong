require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  bootstrapLegacyShadowStartupReconciliation,
  createLegacyShadowStartupDifferenceReport,
} = require('../../back/runtime/adapters/legacy/bootstrapLegacyShadowStartupReconciliation');

const OUTCOMES = [
  'completed',
  'cancelled',
  'abandoned',
  'markedLost',
  'repaired',
  'pending',
  'ambiguous',
  'skipped',
  'failed',
];

function originSummary(origin, overrides = {}) {
  return {
    origin,
    scanned: 0,
    completed: 0,
    cancelled: 0,
    abandoned: 0,
    markedLost: 0,
    repaired: 0,
    pending: 0,
    ambiguous: 0,
    skipped: 0,
    failed: 0,
    ...overrides,
  };
}

function summary(overrides = {}, origins = ['manual']) {
  const value = {
    pages: 1,
    scanned: 0,
    completed: 0,
    cancelled: 0,
    abandoned: 0,
    markedLost: 0,
    repaired: 0,
    pending: 0,
    ambiguous: 0,
    skipped: 0,
    failed: 0,
    stopReason: 'complete',
    remaining: false,
    ...overrides,
  };
  value.byOrigin ??= origins.map((origin) => originSummary(origin));
  return value;
}

test('disabled bootstrap remains fully lazy', async () => {
  const calls = [];
  const result = await bootstrapLegacyShadowStartupReconciliation({
    origins: [],
    profile: 'edge',
    async execute() {
      calls.push('execute');
      throw new Error('must remain lazy');
    },
    audit(record) {
      calls.push(record.state);
    },
  });

  assert.deepEqual(result, { state: 'disabled' });
  assert.deepEqual(calls, ['disabled']);
});

test('cluster profiles reject local Shadow recovery without loading storage', async () => {
  for (const profile of ['cluster-control', 'worker']) {
    const result = await bootstrapLegacyShadowStartupReconciliation({
      origins: ['manual'],
      profile,
      async execute() {
        throw new Error('cluster profile must not load local storage');
      },
      audit() {},
    });
    assert.deepEqual(result, { state: 'profile_rejected', profile });
  }
});

test('applies distinct one-shot edge and standalone budgets', async () => {
  const requests = [];
  for (const profile of ['edge', 'standalone']) {
    const result = await bootstrapLegacyShadowStartupReconciliation({
      origins: ['manual', 'scheduled_system'],
      profile,
      async execute(request) {
        requests.push(request);
        return summary({}, request.origins);
      },
      audit() {},
    });
    assert.equal(result.state, 'reconciled');
  }

  assert.deepEqual(
    requests.map(({ profile, pageSize, maxPages }) => ({
      profile,
      pageSize,
      maxPages,
    })),
    [
      { profile: 'edge', pageSize: 8, maxPages: 1 },
      { profile: 'standalone', pageSize: 32, maxPages: 4 },
    ],
  );
});

test('emits one versioned origin-bounded difference report and metric batch', async () => {
  const batches = [];
  const result = await bootstrapLegacyShadowStartupReconciliation({
    origins: ['manual', 'scheduled_system'],
    profile: 'standalone',
    async execute(request) {
      return summary(
        {
          scanned: 4,
          completed: 1,
          markedLost: 1,
          repaired: 1,
          pending: 1,
          byOrigin: [
            originSummary('manual', {
              scanned: 3,
              completed: 1,
              markedLost: 1,
              repaired: 1,
            }),
            originSummary('scheduled_system', {
              scanned: 1,
              pending: 1,
            }),
          ],
        },
        request.origins,
      );
    },
    audit() {},
    collect(batch) {
      batches.push(batch);
    },
  });

  assert.equal(result.state, 'incomplete');
  assert.equal(
    result.report.schema,
    'qinglong/legacy-shadow-startup-difference-report@v1',
  );
  assert.equal(result.report.assessment, 'waiting_external_callback');
  assert.equal(result.report.budget.maxCandidates, 128);
  assert.deepEqual(
    result.report.byOrigin.map(({ origin, scanned }) => ({ origin, scanned })),
    [
      { origin: 'manual', scanned: 3 },
      { origin: 'scheduled_system', scanned: 1 },
    ],
  );
  assert.equal(batches.length, 1);
  assert.equal(
    batches[0].schema,
    'qinglong/legacy-shadow-startup-metric-batch@v1',
  );
  assert.equal(batches[0].dimensions.assessment, 'waiting_external_callback');
  assert.equal(batches[0].values.scanned, 4);
  assert.equal(batches[0].values.pending, 1);
  assert.deepEqual(
    Object.keys(result.report.outcomes).sort(),
    [...OUTCOMES].sort(),
  );
});

test('turns inconsistent report input into a fail-open low-sensitivity audit', async () => {
  let collected = false;
  const result = await bootstrapLegacyShadowStartupReconciliation({
    origins: ['manual'],
    profile: 'edge',
    async execute() {
      return summary({ scanned: 1 });
    },
    audit() {},
    collect() {
      collected = true;
    },
  });

  assert.deepEqual(result, { state: 'failed', errorType: 'RangeError' });
  assert.equal(collected, false);
});

test('rejects non-Profile budgets and cursors outside page-limit reports', () => {
  assert.throws(
    () =>
      createLegacyShadowStartupDifferenceReport(
        {
          origins: ['manual'],
          profile: 'edge',
          pageSize: 32,
          maxPages: 1,
        },
        summary(),
      ),
    RangeError,
  );
  assert.throws(
    () =>
      createLegacyShadowStartupDifferenceReport(
        { origins: ['manual'], profile: 'edge', pageSize: 8, maxPages: 1 },
        summary({
          nextCursor: { createdAtMs: 10, runId: 'must-not-escape' },
        }),
      ),
    RangeError,
  );
});

test('classifies ambiguous, skipped, or failed comparisons as attention required', async () => {
  const result = await bootstrapLegacyShadowStartupReconciliation({
    origins: ['manual'],
    profile: 'edge',
    async execute(request) {
      return summary(
        {
          scanned: 1,
          ambiguous: 1,
          byOrigin: [originSummary('manual', { scanned: 1, ambiguous: 1 })],
        },
        request.origins,
      );
    },
    audit() {},
  });

  assert.equal(result.state, 'incomplete');
  assert.equal(result.report.assessment, 'attention_required');
  assert.equal(result.metrics.dimensions.assessment, 'attention_required');
});

test('keeps startup fail-open when metric collection fails', async () => {
  const result = await bootstrapLegacyShadowStartupReconciliation({
    origins: ['manual'],
    profile: 'edge',
    async execute(request) {
      return summary({}, request.origins);
    },
    audit() {},
    collect() {
      throw new Error('collector transport secret');
    },
  });

  assert.equal(result.state, 'reconciled');
  assert.equal(
    JSON.stringify(result).includes('collector transport secret'),
    false,
  );
});

test('fails open with a low-sensitivity error type', async () => {
  const result = await bootstrapLegacyShadowStartupReconciliation({
    origins: ['manual'],
    profile: 'edge',
    async execute() {
      throw new RangeError('secret command must not be reported');
    },
    audit() {},
  });

  assert.deepEqual(result, { state: 'failed', errorType: 'RangeError' });
  assert.equal(JSON.stringify(result).includes('secret command'), false);
});

test('redacts the resume cursor Run identity from startup audit output', async () => {
  const records = [];
  const result = await bootstrapLegacyShadowStartupReconciliation({
    origins: ['manual'],
    profile: 'edge',
    async execute() {
      return summary({
        stopReason: 'page_limit',
        remaining: true,
        nextCursor: { createdAtMs: 10, runId: 'run-secret-identity' },
      });
    },
    audit(record) {
      records.push(JSON.stringify(record));
    },
  });

  assert.equal(result.state, 'incomplete');
  assert.equal(result.summary.resumeAvailable, true);
  assert.equal('nextCursor' in result.summary, false);
  assert.equal(result.report.assessment, 'incomplete');
  assert.equal(result.metrics.values.resumeAvailable, 1);
  assert.equal('nextCursor' in result.report.coverage, false);
  assert.equal(records.join('').includes('run-secret-identity'), false);
});

test('HTTP startup orders Shadow recovery after Legacy normalization and before Primary/listen', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../back/app.ts'),
    'utf8',
  );
  const legacyNormalization = source.indexOf(
    'await appLoader.default({ app: this.app })',
  );
  const shadowRecovery = source.indexOf(
    'await bootstrapLegacyShadowStartupReconciliation()',
  );
  const captureEvidence = source.indexOf(
    'await bootstrapLegacyShadowCaptureEvidence({',
  );
  const primaryActivation = source.indexOf(
    'await bootstrapDefaultManualPrimaryRuntime()',
  );
  const listen = source.indexOf(
    'this.httpServerService.initialize(this.app, config.port)',
  );

  assert.equal(legacyNormalization >= 0, true);
  assert.equal(legacyNormalization < shadowRecovery, true);
  assert.equal(shadowRecovery < captureEvidence, true);
  assert.equal(captureEvidence < primaryActivation, true);
  assert.equal(primaryActivation < listen, true);
});
