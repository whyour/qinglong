require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  bootstrapLegacyShadowStartupReconciliation,
} = require('../../back/runtime/adapters/legacy/bootstrapLegacyShadowStartupReconciliation');

function summary(overrides = {}) {
  return {
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
        return summary();
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
  const primaryActivation = source.indexOf(
    'await bootstrapDefaultManualPrimaryRuntime()',
  );
  const listen = source.indexOf(
    'this.httpServerService.initialize(this.app, config.port)',
  );

  assert.equal(legacyNormalization >= 0, true);
  assert.equal(legacyNormalization < shadowRecovery, true);
  assert.equal(shadowRecovery < primaryActivation, true);
  assert.equal(primaryActivation < listen, true);
});
