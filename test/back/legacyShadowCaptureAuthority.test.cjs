require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  LegacyShadowCaptureAuthority,
  createLegacyShadowCaptureReport,
} = require('../../back/runtime/application/legacyShadowCaptureAuthority');

const EPOCH = '019f75d2-1111-7111-8111-111111111111';

function fixture() {
  let now = 1_750_200_000_000;
  const authority = new LegacyShadowCaptureAuthority({ now: () => now }, EPOCH);
  return {
    authority,
    advance(milliseconds = 1_000) {
      now += milliseconds;
    },
  };
}

test('creates a conserved origin-scoped capture window', () => {
  const value = fixture();
  const before = value.authority.snapshot(['manual']);
  for (let index = 0; index < 8; index += 1) {
    value.authority.admit('manual').captured();
  }
  value.advance();
  const after = value.authority.snapshot(['manual']);

  const report = createLegacyShadowCaptureReport(
    'edge',
    ['manual'],
    before,
    after,
  );

  assert.equal(report.assessment, 'captured');
  assert.equal(report.totals.admitted, 8);
  assert.equal(report.totals.captured, 8);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.pending, 0);
  assert.equal(report.capturePermille, 1_000);
  assert.equal(JSON.stringify(report).includes('task'), false);
});

test('separates fixed failure stages and incomplete admissions', () => {
  const value = fixture();
  const before = value.authority.snapshot(['manual', 'scheduled_node']);
  value.authority.admit('manual').failed('fact');
  value.authority.admit('manual').failed('accept');
  value.authority.admit('scheduled_node');
  value.advance();

  const report = createLegacyShadowCaptureReport(
    'standalone',
    ['manual', 'scheduled_node'],
    before,
    value.authority.snapshot(['manual', 'scheduled_node']),
  );

  assert.equal(report.assessment, 'incomplete');
  assert.deepEqual(report.totals, {
    admitted: 3,
    captured: 0,
    failed: 2,
    pending: 1,
    failures: { fact: 1, observer: 0, initialization: 0, accept: 1 },
  });
});

test('rejects cross-epoch, pending-baseline and incomplete-origin evidence', () => {
  const left = fixture();
  const right = new LegacyShadowCaptureAuthority(
    { now: () => 1_750_200_001_000 },
    '019f75d2-2222-7222-8222-222222222222',
  );
  assert.throws(
    () =>
      createLegacyShadowCaptureReport(
        'edge',
        ['manual'],
        left.authority.snapshot(['manual']),
        right.snapshot(['manual']),
      ),
    /cross process epochs/,
  );

  left.authority.admit('manual');
  const pending = left.authority.snapshot(['manual']);
  left.advance();
  assert.throws(
    () =>
      createLegacyShadowCaptureReport(
        'edge',
        ['manual'],
        pending,
        left.authority.snapshot(['manual']),
      ),
    /starts with pending/,
  );
  assert.throws(
    () =>
      createLegacyShadowCaptureReport(
        'edge',
        ['manual', 'boot'],
        left.authority.snapshot(['manual']),
        left.authority.snapshot(['manual']),
      ),
    /window must be non-empty|coverage is incomplete/,
  );
});
