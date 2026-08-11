const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  LocalSqliteAdoptionError,
  inspectLegacyCrontabAdoptionDiagnostics,
  inspectLegacySqlitePath,
  issueReviewedLegacyCrontabAdoptionDecisionAuthorizationFile,
  verifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFile,
} = require('..');
const {
  LegacyCrontabDecisionIssuerKeyringFileProvider,
  provisionLegacyCrontabDecisionIssuerKeyring,
} = require('../dist/legacy-adoption/legacyCrontabDecisionIssuer');

const NOW_MS = 1_760_000_000_000;
const DECISION_ID = '019a2b3c-4d5e-7f60-8123-456789abcdef';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-issuer-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'database.sqlite');
  const source = new DatabaseSync(sourcePath);
  source.exec(`
    CREATE TABLE "Auths" (id INTEGER PRIMARY KEY, type TEXT, info TEXT);
    CREATE TABLE "Crontabs" (
      id INTEGER PRIMARY KEY,
      name TEXT,
      command TEXT NOT NULL,
      schedule TEXT
    );
    CREATE TABLE "Envs" (id INTEGER PRIMARY KEY, name TEXT, value TEXT);
    INSERT INTO "Crontabs" (id, name, command, schedule)
      VALUES (1, 'Reviewed task', 'task /scripts/reviewed.sh', '0 0 * * *');
  `);
  source.close();
  return {
    directory,
    sourcePath,
    authorizationPath: path.join(directory, 'decision.ndjson'),
    issuerKeyringPath: path.join(directory, 'decision-issuer.keyring'),
  };
}

function review(value) {
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
  });
  const page = inspectLegacyCrontabAdoptionDiagnostics({
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
    limit: 16,
  });
  assert.equal(page.diagnostics.length, 1);
  assert.equal(page.diagnostics[0].classification, 'lossless');
  return {
    plan,
    decisions: [
      {
        rowOrdinal: page.diagnostics[0].rowOrdinal,
        sourceDigest: page.diagnostics[0].sourceDigest,
        disposition: 'adopt',
        reason: 'reviewed_lossless',
      },
    ],
  };
}

function reviewer(assurance = 'local_console') {
  return Object.freeze({
    subject: Object.freeze({ type: 'user', id: 'local-owner' }),
    authenticationId: 'local-console:credential-v1',
    authenticatedAtMs: NOW_MS - 1_000,
    expiresAtMs: NOW_MS + 5 * 60 * 1_000,
    assurance,
  });
}

test('issues one bounded authorization from an authenticated capability and dedicated keyring', async (t) => {
  const value = fixture(t);
  const { plan, decisions } = review(value);
  await provisionLegacyCrontabDecisionIssuerKeyring(value.issuerKeyringPath);
  let authenticationCalls = 0;
  let confirmationCalls = 0;
  const result =
    await issueReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
      sourcePath: value.sourcePath,
      profile: 'edge',
      legacyTimezone: 'UTC',
      expectedPlanDigest: plan.planDigest,
      decisionId: DECISION_ID,
      authorizationPath: value.authorizationPath,
      issuerKeyringPath: value.issuerKeyringPath,
      decisions,
      async authenticateReviewer() {
        authenticationCalls += 1;
        return reviewer();
      },
      confirmIssuerAuthority() {
        confirmationCalls += 1;
      },
      lifetimeMs: 2 * 60 * 1_000,
      clock: () => NOW_MS,
    });

  assert.equal(authenticationCalls, 1);
  assert.equal(confirmationCalls, 4);
  assert.equal(result.receipt.reviewer.subject.id, 'local-owner');
  assert.equal(result.receipt.issuedAtMs, NOW_MS);
  assert.equal(result.receipt.expiresAtMs, NOW_MS + 2 * 60 * 1_000);
  assert.match(result.file.keyId, /^qladk-/);
  assert.equal(fs.statSync(value.authorizationPath).mode & 0o777, 0o600);

  const verified =
    await verifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
      sourcePath: value.sourcePath,
      profile: 'edge',
      legacyTimezone: 'UTC',
      expectedPlanDigest: plan.planDigest,
      expectedDecisionId: DECISION_ID,
      authorizationPath: value.authorizationPath,
      keyProvider: new LegacyCrontabDecisionIssuerKeyringFileProvider(
        value.issuerKeyringPath,
      ),
      observedAtMs: NOW_MS + 1_000,
    });
  assert.equal(verified.file.fileDigest, result.file.fileDigest);
});

test('rejects a self-reported weak reviewer before reading any issuer key', async (t) => {
  const value = fixture(t);
  const { plan, decisions } = review(value);
  await assert.rejects(
    issueReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
      sourcePath: value.sourcePath,
      profile: 'edge',
      legacyTimezone: 'UTC',
      expectedPlanDigest: plan.planDigest,
      decisionId: DECISION_ID,
      authorizationPath: value.authorizationPath,
      issuerKeyringPath: value.issuerKeyringPath,
      decisions,
      authenticateReviewer: () => reviewer('single_factor'),
      confirmIssuerAuthority() {},
      clock: () => NOW_MS,
    }),
    LocalSqliteAdoptionError,
  );
  assert.equal(fs.existsSync(value.authorizationPath), false);
});

test('rechecks issuer authority immediately before no-replace publication', async (t) => {
  const value = fixture(t);
  const { plan, decisions } = review(value);
  await provisionLegacyCrontabDecisionIssuerKeyring(value.issuerKeyringPath);
  let confirmationCalls = 0;
  await assert.rejects(
    issueReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
      sourcePath: value.sourcePath,
      profile: 'edge',
      legacyTimezone: 'UTC',
      expectedPlanDigest: plan.planDigest,
      decisionId: DECISION_ID,
      authorizationPath: value.authorizationPath,
      issuerKeyringPath: value.issuerKeyringPath,
      decisions,
      authenticateReviewer: () => reviewer(),
      confirmIssuerAuthority() {
        confirmationCalls += 1;
        if (confirmationCalls === 4) throw new Error('authority drift');
      },
      clock: () => NOW_MS,
    }),
    LocalSqliteAdoptionError,
  );
  assert.equal(confirmationCalls, 4);
  assert.equal(fs.existsSync(value.authorizationPath), false);
  assert.deepEqual(
    fs.readdirSync(value.directory).filter((entry) => entry.includes('.tmp')),
    [],
  );
});
