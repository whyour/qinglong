const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  LegacyCrontabAdoptionDecisionReviewFileError,
  withPrivateLegacyCrontabAdoptionDecisionReviewFile,
} = require('../dist/legacy-adoption/legacyCrontabDecisionIssuer');

const DECISION_ID = '019a2b3c-4d5e-7f60-8123-456789abcdef';
const PLAN_DIGEST = 'a'.repeat(64);
const INVENTORY_DIGEST = 'b'.repeat(64);
const DECISION = Object.freeze({
  rowOrdinal: 1,
  sourceDigest: 'c'.repeat(64),
  disposition: 'adopt',
  reason: 'reviewed_lossless',
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-review-file-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'review.ndjson');
  const records = [
    {
      schemaVersion: 1,
      kind: 'qinglong3-legacy-crontab-decision-review-file-header',
      decisionId: DECISION_ID,
      profile: 'edge',
      planDigest: PLAN_DIGEST,
      inventoryDigest: INVENTORY_DIGEST,
    },
    {
      schemaVersion: 1,
      kind: 'qinglong3-legacy-crontab-decision-review-file-row',
      decision: DECISION,
    },
  ];
  fs.writeFileSync(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    { mode: 0o600 },
  );
  return { directory, filePath };
}

function options(filePath) {
  return {
    filePath,
    expectedDecisionId: DECISION_ID,
    expectedProfile: 'edge',
    expectedPlanDigest: PLAN_DIGEST,
    expectedInventoryDigest: INVENTORY_DIGEST,
  };
}

test('streams repeatable decisions from one authenticated private descriptor', async (t) => {
  const value = fixture(t);
  const result = await withPrivateLegacyCrontabAdoptionDecisionReviewFile(
    options(value.filePath),
    (scope) => {
      assert.equal(scope.evidence.decisionCount, 1);
      assert.match(scope.evidence.fileDigest, /^[0-9a-f]{64}$/);
      assert.deepEqual([...scope.decisions], [DECISION]);
      assert.deepEqual([...scope.decisions], [DECISION]);
      scope.confirmIdentity();
      return scope.evidence.fileDigest;
    },
  );
  assert.match(result, /^[0-9a-f]{64}$/);
});

test('fails closed on private-path violations and in-flight replacement', async (t) => {
  const value = fixture(t);
  fs.chmodSync(value.filePath, 0o640);
  await assert.rejects(
    withPrivateLegacyCrontabAdoptionDecisionReviewFile(
      options(value.filePath),
      () => undefined,
    ),
    LegacyCrontabAdoptionDecisionReviewFileError,
  );
  fs.chmodSync(value.filePath, 0o600);

  const linkPath = path.join(value.directory, 'review-link.ndjson');
  fs.symlinkSync(value.filePath, linkPath);
  await assert.rejects(
    withPrivateLegacyCrontabAdoptionDecisionReviewFile(
      options(linkPath),
      () => undefined,
    ),
    LegacyCrontabAdoptionDecisionReviewFileError,
  );

  await assert.rejects(
    withPrivateLegacyCrontabAdoptionDecisionReviewFile(
      options(value.filePath),
      () => {
        const replacement = path.join(value.directory, 'replacement.ndjson');
        fs.copyFileSync(value.filePath, replacement);
        fs.chmodSync(replacement, 0o600);
        fs.renameSync(replacement, value.filePath);
      },
    ),
    LegacyCrontabAdoptionDecisionReviewFileError,
  );
});

test('rejects widened records and mismatched review identity', async (t) => {
  const value = fixture(t);
  const widened = fs
    .readFileSync(value.filePath, 'utf8')
    .replace(
      '"reason":"reviewed_lossless"',
      '"reason":"reviewed_lossless","override":true',
    );
  fs.writeFileSync(value.filePath, widened, { mode: 0o600 });
  await assert.rejects(
    withPrivateLegacyCrontabAdoptionDecisionReviewFile(
      options(value.filePath),
      () => undefined,
    ),
    LegacyCrontabAdoptionDecisionReviewFileError,
  );

  const fresh = fixture(t);
  await assert.rejects(
    withPrivateLegacyCrontabAdoptionDecisionReviewFile(
      { ...options(fresh.filePath), expectedInventoryDigest: 'd'.repeat(64) },
      () => undefined,
    ),
    LegacyCrontabAdoptionDecisionReviewFileError,
  );
});
