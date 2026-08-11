const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  LocalSqliteAdoptionError,
  acquireLocalSqliteActivation,
  createReviewedLegacyCrontabAdoptionDecisionReceipt,
  inspectLegacyCrontabAdoptionDiagnostics,
  inspectLegacySqlitePath,
  prepareLocalSqliteActivation,
  publishReviewedLegacyCrontabAdoption,
  publishReviewedLegacyCrontabAdoptionDecisionAuthorizationFile,
  stageLocalSqliteAdoption,
  verifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFile,
  verifyReviewedLegacyCrontabAdoptionDecisionReceipt,
  verifyLocalSqliteAdoption,
} = require('..');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  visitLegacyCrontabAdoptionInspections,
} = require('../dist/legacy-adoption/legacyCrontabAdoption');

const REVIEWED_AT_MS = 1_760_000_000_000;
const REVIEWER = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'local-owner' }),
  authenticationId: 'local-console:adoption-review',
  authenticatedAtMs: REVIEWED_AT_MS - 1_000,
  expiresAtMs: REVIEWED_AT_MS + 60 * 60 * 1_000,
  assurance: 'local_console',
});
const AUTHORIZATION_KEY_ID = 'qlsk-adoption-review-test';
const AUTHORIZATION_KEY = Buffer.alloc(32, 0x5a);

function authorizationKeyProvider(key = AUTHORIZATION_KEY) {
  return Object.freeze({
    async active() {
      return {
        keyId: AUTHORIZATION_KEY_ID,
        key: Uint8Array.from(key),
      };
    },
    async resolve(keyId) {
      return keyId === AUTHORIZATION_KEY_ID
        ? {
            keyId,
            key: Uint8Array.from(key),
          }
        : null;
    },
  });
}

function decisionFor(diagnostic) {
  if (diagnostic.classification === 'lossless') {
    return {
      rowOrdinal: diagnostic.rowOrdinal,
      sourceDigest: diagnostic.sourceDigest,
      disposition: 'adopt',
      reason: 'reviewed_lossless',
    };
  }
  if (diagnostic.classification === 'requires_shell_compatibility') {
    return {
      rowOrdinal: diagnostic.rowOrdinal,
      sourceDigest: diagnostic.sourceDigest,
      disposition: 'adopt_shell_compatibility',
      reason: 'reviewed_shell_compatibility',
    };
  }
  return {
    rowOrdinal: diagnostic.rowOrdinal,
    sourceDigest: diagnostic.sourceDigest,
    disposition: 'skip',
    reason:
      diagnostic.classification === 'malformed'
        ? 'malformed_source'
        : 'unsupported_semantics',
  };
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-adoption-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'database.sqlite');
  const source = new DatabaseSync(sourcePath);
  source.exec(`
    CREATE TABLE "Auths" (id INTEGER PRIMARY KEY, type TEXT, info TEXT);
    CREATE TABLE "Crontabs" (
      id INTEGER PRIMARY KEY, command TEXT NOT NULL, schedule TEXT
    );
    CREATE TABLE "Envs" (
      id INTEGER PRIMARY KEY, name TEXT, value TEXT
    );
    CREATE TABLE "PluginOwnedState" (
      id INTEGER PRIMARY KEY, payload TEXT NOT NULL
    );
    INSERT INTO "Crontabs" (id, command, schedule)
      VALUES (1, 'echo preserved', '0 0 * * *');
    INSERT INTO "PluginOwnedState" (id, payload)
      VALUES (1, '{"preserved":true}');
  `);
  source.close();
  return {
    directory,
    sourcePath,
    targetPath: path.join(directory, 'qinglong3.sqlite'),
    recoveryPath: path.join(directory, 'database.pre-ql3.sqlite'),
    manifestPath: path.join(directory, 'qinglong3-adoption.json'),
    activationPath: path.join(directory, 'qinglong3-activation.json'),
  };
}

test('produces a stable reviewed plan without changing the legacy source', (t) => {
  const value = fixture(t);
  const before = sha256(value.sourcePath);
  const first = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
  });
  const second = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
  });

  assert.equal(first.planDigest, second.planDigest);
  assert.equal(first.schemaVersion, 2);
  assert.match(first.planDigest, /^[0-9a-f]{64}$/);
  assert.equal(first.tasks.rowCount, 1);
  assert.equal(first.tasks.classifications.requires_manual_action, 1);
  assert.equal(first.tasks.mutationReady, false);
  assert.deepEqual(first.catalog.tableNames, [
    'Auths',
    'Crontabs',
    'Envs',
    'PluginOwnedState',
  ]);
  assert.equal(sha256(value.sourcePath), before);
});

test('classifies legacy tasks with bounded secret-safe diagnostic pages', (t) => {
  const value = fixture(t);
  const source = new DatabaseSync(value.sourcePath);
  source.exec(`
    DELETE FROM "Crontabs";
    INSERT INTO "Crontabs" (id, command, schedule) VALUES
      (1, 'task /scripts/lossless.sh', '0 0 * * *'),
      (2, 'echo embedded-secret-value', '1 0 * * *'),
      (3, 'task /scripts/manual.sh', '@boot'),
      (4, '', '2 0 * * *');
  `);
  source.close();

  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
  });
  assert.deepEqual(plan.tasks.classifications, {
    lossless: 1,
    requires_shell_compatibility: 1,
    requires_manual_action: 1,
    malformed: 1,
  });
  assert.equal(plan.tasks.timezone, 'UTC');

  const first = inspectLegacyCrontabAdoptionDiagnostics({
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
    limit: 2,
  });
  assert.equal(first.reviewedPlanDigest, plan.planDigest);
  assert.equal(first.truncated, true);
  assert.deepEqual(
    first.diagnostics.map(({ rowOrdinal, classification, triggerCount }) => ({
      rowOrdinal,
      classification,
      triggerCount,
    })),
    [
      { rowOrdinal: 1, classification: 'lossless', triggerCount: 1 },
      {
        rowOrdinal: 2,
        classification: 'requires_shell_compatibility',
        triggerCount: 1,
      },
    ],
  );
  assert.equal(JSON.stringify(first).includes('embedded-secret-value'), false);
  assert.equal(JSON.stringify(first).includes('/scripts/lossless.sh'), false);

  const second = inspectLegacyCrontabAdoptionDiagnostics({
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
    afterRowOrdinal: first.next.rowOrdinal,
    limit: 2,
  });
  assert.equal(second.truncated, false);
  assert.deepEqual(
    second.diagnostics.map(({ classification, reasons }) => ({
      classification,
      reasons,
    })),
    [
      {
        classification: 'requires_manual_action',
        reasons: ['schedule_boot_unsupported'],
      },
      {
        classification: 'malformed',
        reasons: ['command_invalid'],
      },
    ],
  );
});

test('keeps canonical adoption candidates internal and gates unmapped legacy semantics', (t) => {
  const value = fixture(t);
  const source = new DatabaseSync(value.sourcePath);
  source.exec(`
    ALTER TABLE "Crontabs" ADD COLUMN "name" TEXT;
    ALTER TABLE "Crontabs" ADD COLUMN "isPinned" INTEGER;
    ALTER TABLE "Crontabs" ADD COLUMN "sub_id" INTEGER;
    DELETE FROM "Crontabs";
  `);
  const insert = source.prepare(
    'INSERT INTO "Crontabs" (id, name, command, schedule, isPinned, sub_id) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insert.run(1, 'Pinned task', 'task /scripts/pinned.sh', '0 0 * * *', 1, null);
  insert.run(2, 'Subscribed task', 'task /scripts/sub.sh', '1 0 * * *', 0, 7);
  insert.run(
    3,
    'invalid\u0001name',
    'task /scripts/invalid.sh',
    '2 0 * * *',
    0,
    null,
  );

  const inspections = [];
  const inventory = visitLegacyCrontabAdoptionInspections(
    source,
    'UTC',
    (inspection) => inspections.push(inspection),
  );
  source.close();

  assert.deepEqual(inventory.classifications, {
    lossless: 1,
    requires_shell_compatibility: 0,
    requires_manual_action: 1,
    malformed: 1,
  });
  assert.equal(inspections[0].candidate.task.name, 'Pinned task');
  assert.deepEqual(inspections[0].candidate.task.labels, {
    'qinglong.io/legacy-pinned': 'true',
  });
  assert.equal(inspections[0].candidate.triggers.length, 1);
  assert.equal(inspections[1].candidate, undefined);
  assert.deepEqual(inspections[1].diagnostic.reasons, [
    'subscription_binding_requires_mapping',
  ]);
  assert.equal(inspections[2].candidate, undefined);
  assert.deepEqual(inspections[2].diagnostic.reasons, ['legacy_field_invalid']);
  assert.equal(
    JSON.stringify(inspections[0].diagnostic).includes('pinned.sh'),
    false,
  );
  assert.equal(
    Object.hasOwn(require('..'), 'visitLegacyCrontabAdoptionInspections'),
    false,
  );
});

test('creates and verifies one complete strong-auth decision receipt', (t) => {
  const value = fixture(t);
  const source = new DatabaseSync(value.sourcePath);
  source.exec(`
    DELETE FROM "Crontabs";
    INSERT INTO "Crontabs" (id, command, schedule) VALUES
      (1, 'task /scripts/lossless.sh', '0 0 * * *'),
      (2, 'echo shell-compatibility', '1 0 * * *'),
      (3, 'task /scripts/manual.sh', '@boot'),
      (4, '', '2 0 * * *');
  `);
  source.close();
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
  });
  const diagnosticPage = inspectLegacyCrontabAdoptionDiagnostics({
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
  });
  const decisions = diagnosticPage.diagnostics.map(decisionFor);
  const receipt = createReviewedLegacyCrontabAdoptionDecisionReceipt({
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
    decisionId: '018f0f5e-7b2d-7000-8000-000000000001',
    reviewer: REVIEWER,
    issuedAtMs: REVIEWED_AT_MS,
    expiresAtMs: REVIEWED_AT_MS + 10 * 60 * 1_000,
    decisions,
  });

  assert.equal(receipt.planDigest, plan.planDigest);
  assert.equal(receipt.inventoryDigest, plan.tasks.inventoryDigest);
  assert.deepEqual(receipt.decisions.dispositions, {
    adopt: 1,
    adopt_shell_compatibility: 1,
    skip: 2,
  });
  assert.equal(receipt.decisions.rowCount, 4);
  assert.match(receipt.decisions.decisionDigest, /^[0-9a-f]{64}$/);
  assert.match(receipt.receiptDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(receipt).includes('/scripts/'), false);
  assert.deepEqual(
    verifyReviewedLegacyCrontabAdoptionDecisionReceipt({
      sourcePath: value.sourcePath,
      profile: 'edge',
      legacyTimezone: 'UTC',
      expectedPlanDigest: plan.planDigest,
      receipt: JSON.parse(JSON.stringify(receipt)),
      decisions,
      observedAtMs: REVIEWED_AT_MS + 1,
    }),
    receipt,
  );
});

test('publishes and verifies one private authenticated decision file', async (t) => {
  const value = fixture(t);
  const source = new DatabaseSync(value.sourcePath);
  source
    .prepare('UPDATE "Crontabs" SET command = ? WHERE id = 1')
    .run('task /scripts/authenticated.sh');
  source.close();
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
  });
  const decisions = page.diagnostics.map(decisionFor);
  const authorizationDirectory = path.join(value.directory, 'authorization');
  fs.mkdirSync(authorizationDirectory, { mode: 0o700 });
  const authorizationPath = path.join(
    authorizationDirectory,
    '018f0f5e-7b2d-7000-8000-000000000011.ndjson',
  );
  const options = {
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
    decisionId: '018f0f5e-7b2d-7000-8000-000000000011',
    reviewer: REVIEWER,
    issuedAtMs: REVIEWED_AT_MS,
    expiresAtMs: REVIEWED_AT_MS + 10 * 60 * 1_000,
    decisions,
    authorizationPath,
    keyProvider: authorizationKeyProvider(),
  };

  const published =
    await publishReviewedLegacyCrontabAdoptionDecisionAuthorizationFile(
      options,
    );
  assert.equal(published.file.decisionCount, 1);
  assert.equal(published.file.keyId, AUTHORIZATION_KEY_ID);
  assert.match(published.file.fileDigest, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(authorizationPath).mode & 0o777, 0o600);
  const material = fs.readFileSync(authorizationPath, 'utf8');
  assert.equal(material.includes('/scripts/'), false);
  assert.equal(material.includes('authenticated.sh'), false);

  const verified =
    await verifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
      sourcePath: value.sourcePath,
      profile: 'edge',
      legacyTimezone: 'UTC',
      expectedPlanDigest: plan.planDigest,
      expectedDecisionId: options.decisionId,
      authorizationPath,
      keyProvider: authorizationKeyProvider(),
      observedAtMs: REVIEWED_AT_MS + 1,
    });
  assert.deepEqual(verified, published);
  await assert.rejects(
    publishReviewedLegacyCrontabAdoptionDecisionAuthorizationFile(options),
    /decision authorization publication failed/,
  );
});

test('publishes one reviewed legacy task set into the target atomically', async (t) => {
  const value = fixture(t);
  const source = new DatabaseSync(value.sourcePath);
  source
    .prepare('UPDATE "Crontabs" SET command = ? WHERE id = 1')
    .run('task /scripts/published.sh');
  source.close();
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
  });
  const decisionId = '018f0f5e-7b2d-7000-8000-000000000015';
  const authorizationDirectory = path.join(
    value.directory,
    'publication-authorization',
  );
  fs.mkdirSync(authorizationDirectory, { mode: 0o700 });
  const authorizationPath = path.join(
    authorizationDirectory,
    `${decisionId}.ndjson`,
  );
  await publishReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
    decisionId,
    reviewer: REVIEWER,
    issuedAtMs: REVIEWED_AT_MS,
    expiresAtMs: REVIEWED_AT_MS + 10 * 60 * 1_000,
    decisions: page.diagnostics.map(decisionFor),
    authorizationPath,
    keyProvider: authorizationKeyProvider(),
  });
  await migrateLocalSqlitePath({
    databasePath: value.targetPath,
    profile: 'edge',
  });
  const target = new DatabaseSync(value.targetPath);
  target.exec(`
    INSERT INTO "QingLong3ProjectRoleBindings" (
      "project_id", "subject_type", "subject_id", "version", "state",
      "role", "mutation_id", "changed_by_type", "changed_by_id",
      "created_at_ms"
    ) VALUES (
      'default', 'user', 'local-owner', 1, 'active', 'owner',
      'adoption-owner-binding', 'user', 'local-owner', 1
    );
  `);
  target.close();
  const mutationId = '12345678-1234-4123-8123-123456789abd';
  let reviewerAuthorityChecks = 0;
  const publicationOptions = {
    sourcePath: value.sourcePath,
    targetPath: value.targetPath,
    authorizationPath,
    profile: 'edge',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
    expectedDecisionId: decisionId,
    projectId: 'default',
    mutationId,
    requestId: 'legacy-adoption-publication-test',
    keyProvider: authorizationKeyProvider(),
    observedAtMs: REVIEWED_AT_MS + 1,
    async confirmReviewerAuthority(reviewer) {
      await Promise.resolve();
      assert.deepEqual(reviewer, REVIEWER);
      reviewerAuthorityChecks += 1;
    },
  };
  const inserted = await publishReviewedLegacyCrontabAdoption(
    publicationOptions,
  );
  assert.equal(inserted.status, 'inserted');
  assert.equal(inserted.adoption.adoptedTaskCount, 1);
  assert.equal(inserted.adoption.adoptedTriggerCount, 1);
  assert.equal(reviewerAuthorityChecks, 2);
  assert.equal(
    (await publishReviewedLegacyCrontabAdoption(publicationOptions)).status,
    'existing',
  );
  assert.equal(reviewerAuthorityChecks, 4);

  const stored = new DatabaseSync(value.targetPath, { readOnly: true });
  assert.deepEqual(
    {
      ...stored
        .prepare(
          `SELECT task."task_id" AS taskId, revision."name" AS name,
                  revision."enabled" AS enabled
           FROM "QingLong3TaskDefinitions" AS task
           JOIN "QingLong3TaskDefinitionRevisions" AS revision
             ON revision."project_id" = task."project_id"
            AND revision."task_id" = task."task_id"
            AND revision."revision" = task."current_revision"`,
        )
        .get(),
    },
    { taskId: 'legacy-cron:1', name: 'Legacy Crontab 1', enabled: 1 },
  );
  assert.equal(
    stored
      .prepare('SELECT COUNT(*) AS count FROM "QingLong3LegacyAdoptions"')
      .get().count,
    1,
  );
  stored.close();
});

test('authenticated decision file rejects wrong keys, expiry and tampering', async (t) => {
  const value = fixture(t);
  const source = new DatabaseSync(value.sourcePath);
  source
    .prepare('UPDATE "Crontabs" SET command = ? WHERE id = 1')
    .run('task /scripts/stable-authorization.sh');
  source.close();
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'standalone',
    legacyTimezone: 'UTC',
  });
  const page = inspectLegacyCrontabAdoptionDiagnostics({
    sourcePath: value.sourcePath,
    profile: 'standalone',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
  });
  const authorizationDirectory = path.join(value.directory, 'authorization');
  fs.mkdirSync(authorizationDirectory, { mode: 0o700 });
  const authorizationPath = path.join(authorizationDirectory, 'review.ndjson');
  const decisionId = '018f0f5e-7b2d-7000-8000-000000000012';
  await publishReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
    sourcePath: value.sourcePath,
    profile: 'standalone',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
    decisionId,
    reviewer: REVIEWER,
    issuedAtMs: REVIEWED_AT_MS,
    expiresAtMs: REVIEWED_AT_MS + 10 * 60 * 1_000,
    decisions: page.diagnostics.map(decisionFor),
    authorizationPath,
    keyProvider: authorizationKeyProvider(),
  });
  const verification = {
    sourcePath: value.sourcePath,
    profile: 'standalone',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
    expectedDecisionId: decisionId,
    authorizationPath,
  };

  await assert.rejects(
    verifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
      ...verification,
      keyProvider: authorizationKeyProvider(Buffer.alloc(32, 0x6b)),
      observedAtMs: REVIEWED_AT_MS + 1,
    }),
    /decision authorization verification failed/,
  );
  await assert.rejects(
    verifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
      ...verification,
      keyProvider: authorizationKeyProvider(),
      observedAtMs: REVIEWED_AT_MS + 10 * 60 * 1_000,
    }),
    /decision authorization verification failed/,
  );

  const tampered = fs
    .readFileSync(authorizationPath, 'utf8')
    .replace('reviewed_lossless', 'operator_excluded');
  fs.writeFileSync(authorizationPath, tampered, { mode: 0o600 });
  fs.chmodSync(authorizationPath, 0o600);
  await assert.rejects(
    verifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
      ...verification,
      keyProvider: authorizationKeyProvider(),
      observedAtMs: REVIEWED_AT_MS + 1,
    }),
    /decision authorization verification failed/,
  );
});

test('authenticated decision file requires private parent and file modes', async (t) => {
  const value = fixture(t);
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
  });
  const base = {
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
    decisionId: '018f0f5e-7b2d-7000-8000-000000000013',
    reviewer: REVIEWER,
    issuedAtMs: REVIEWED_AT_MS,
    expiresAtMs: REVIEWED_AT_MS + 10 * 60 * 1_000,
    decisions: page.diagnostics.map(decisionFor),
    keyProvider: authorizationKeyProvider(),
  };
  const broadDirectory = path.join(value.directory, 'broad-authorization');
  fs.mkdirSync(broadDirectory, { mode: 0o755 });
  fs.chmodSync(broadDirectory, 0o755);
  await assert.rejects(
    publishReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
      ...base,
      authorizationPath: path.join(broadDirectory, 'review.ndjson'),
    }),
    /decision authorization publication failed/,
  );

  const privateDirectory = path.join(value.directory, 'private-authorization');
  fs.mkdirSync(privateDirectory, { mode: 0o700 });
  const authorizationPath = path.join(privateDirectory, 'review.ndjson');
  await publishReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
    ...base,
    authorizationPath,
  });
  fs.chmodSync(authorizationPath, 0o644);
  await assert.rejects(
    verifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
      sourcePath: value.sourcePath,
      profile: 'edge',
      legacyTimezone: 'UTC',
      expectedPlanDigest: plan.planDigest,
      expectedDecisionId: base.decisionId,
      authorizationPath,
      keyProvider: authorizationKeyProvider(),
      observedAtMs: REVIEWED_AT_MS + 1,
    }),
    /decision authorization verification failed/,
  );
});

test('authenticated decision file rejects same-inode semantic rewrites during verification', async (t) => {
  const value = fixture(t);
  const source = new DatabaseSync(value.sourcePath);
  source
    .prepare('UPDATE "Crontabs" SET command = ? WHERE id = 1')
    .run('task /scripts/identity-fence.sh');
  source.close();
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
  });
  const authorizationDirectory = path.join(value.directory, 'authorization');
  fs.mkdirSync(authorizationDirectory, { mode: 0o700 });
  const authorizationPath = path.join(authorizationDirectory, 'review.ndjson');
  const decisionId = '018f0f5e-7b2d-7000-8000-000000000014';
  await publishReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
    decisionId,
    reviewer: REVIEWER,
    issuedAtMs: REVIEWED_AT_MS,
    expiresAtMs: REVIEWED_AT_MS + 10 * 60 * 1_000,
    decisions: page.diagnostics.map(decisionFor),
    authorizationPath,
    keyProvider: authorizationKeyProvider(),
  });
  const mutatingProvider = authorizationKeyProvider();
  await assert.rejects(
    verifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
      sourcePath: value.sourcePath,
      profile: 'edge',
      legacyTimezone: 'UTC',
      expectedPlanDigest: plan.planDigest,
      expectedDecisionId: decisionId,
      authorizationPath,
      keyProvider: {
        active: () => mutatingProvider.active(),
        async resolve(keyId) {
          const lines = fs.readFileSync(authorizationPath, 'utf8').split('\n');
          const row = JSON.parse(lines[1]);
          row.decision = {
            sourceDigest: row.decision.sourceDigest,
            rowOrdinal: row.decision.rowOrdinal,
            disposition: row.decision.disposition,
            reason: row.decision.reason,
          };
          lines[1] = JSON.stringify(row);
          const rewritten = lines.join('\n');
          assert.equal(
            Buffer.byteLength(rewritten),
            fs.statSync(authorizationPath).size,
          );
          fs.writeFileSync(authorizationPath, rewritten, { mode: 0o600 });
          fs.utimesSync(
            authorizationPath,
            new Date(REVIEWED_AT_MS - 10_000),
            new Date(REVIEWED_AT_MS - 10_000),
          );
          return mutatingProvider.resolve(keyId);
        },
      },
      observedAtMs: REVIEWED_AT_MS + 1,
    }),
    /decision authorization verification failed/,
  );
});

test('decision receipt fails closed for incomplete, widened and weak review', (t) => {
  const value = fixture(t);
  const source = new DatabaseSync(value.sourcePath);
  source
    .prepare('UPDATE "Crontabs" SET command = ? WHERE id = 1')
    .run('task /scripts/reviewed.sh');
  source.close();
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'standalone',
    legacyTimezone: 'UTC',
  });
  const page = inspectLegacyCrontabAdoptionDiagnostics({
    sourcePath: value.sourcePath,
    profile: 'standalone',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
  });
  const decision = decisionFor(page.diagnostics[0]);
  const base = {
    sourcePath: value.sourcePath,
    profile: 'standalone',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
    decisionId: '018f0f5e-7b2d-7000-8000-000000000002',
    reviewer: REVIEWER,
    issuedAtMs: REVIEWED_AT_MS,
    expiresAtMs: REVIEWED_AT_MS + 10 * 60 * 1_000,
  };

  assert.throws(
    () =>
      createReviewedLegacyCrontabAdoptionDecisionReceipt({
        ...base,
        decisions: [],
      }),
    /decision receipt creation failed/,
  );
  assert.throws(
    () =>
      createReviewedLegacyCrontabAdoptionDecisionReceipt({
        ...base,
        decisions: [decision, decision],
      }),
    /decision receipt creation failed/,
  );
  assert.throws(
    () =>
      createReviewedLegacyCrontabAdoptionDecisionReceipt({
        ...base,
        decisions: [
          {
            ...decision,
            sourceDigest: '0'.repeat(64),
          },
        ],
      }),
    /decision receipt creation failed/,
  );
  assert.throws(
    () =>
      createReviewedLegacyCrontabAdoptionDecisionReceipt({
        ...base,
        reviewer: { ...REVIEWER, assurance: 'single_factor' },
        decisions: [decision],
      }),
    /decision receipt creation failed/,
  );
  assert.throws(
    () =>
      createReviewedLegacyCrontabAdoptionDecisionReceipt({
        ...base,
        reviewer: {
          ...REVIEWER,
          authenticatedAtMs: REVIEWED_AT_MS - 5 * 60 * 1_000 - 1,
        },
        decisions: [decision],
      }),
    /decision receipt creation failed/,
  );
  assert.throws(
    () =>
      createReviewedLegacyCrontabAdoptionDecisionReceipt({
        ...base,
        expiresAtMs: REVIEWED_AT_MS + 30 * 60 * 1_000 + 1,
        decisions: [decision],
      }),
    /decision receipt creation failed/,
  );
  assert.throws(
    () =>
      createReviewedLegacyCrontabAdoptionDecisionReceipt({
        ...base,
        decisions: [
          {
            ...decision,
            disposition: 'adopt_shell_compatibility',
            reason: 'reviewed_shell_compatibility',
          },
        ],
      }),
    /decision receipt creation failed/,
  );
});

test('decision receipt rejects tampering, expiry and source drift', (t) => {
  const value = fixture(t);
  const source = new DatabaseSync(value.sourcePath);
  source
    .prepare('UPDATE "Crontabs" SET command = ? WHERE id = 1')
    .run('task /scripts/stable.sh');
  source.close();
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
  });
  const decisions = page.diagnostics.map(decisionFor);
  const receipt = createReviewedLegacyCrontabAdoptionDecisionReceipt({
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
    decisionId: '018f0f5e-7b2d-7000-8000-000000000003',
    reviewer: REVIEWER,
    issuedAtMs: REVIEWED_AT_MS,
    expiresAtMs: REVIEWED_AT_MS + 10 * 60 * 1_000,
    decisions,
  });
  const tampered = JSON.parse(JSON.stringify(receipt));
  tampered.decisions.dispositions.skip += 1;
  assert.throws(
    () =>
      verifyReviewedLegacyCrontabAdoptionDecisionReceipt({
        sourcePath: value.sourcePath,
        profile: 'edge',
        legacyTimezone: 'UTC',
        expectedPlanDigest: plan.planDigest,
        receipt: tampered,
        decisions,
        observedAtMs: REVIEWED_AT_MS + 1,
      }),
    /decision receipt verification failed/,
  );
  assert.throws(
    () =>
      verifyReviewedLegacyCrontabAdoptionDecisionReceipt({
        sourcePath: value.sourcePath,
        profile: 'edge',
        legacyTimezone: 'UTC',
        expectedPlanDigest: plan.planDigest,
        receipt,
        decisions,
        observedAtMs: receipt.expiresAtMs,
      }),
    /decision receipt verification failed/,
  );

  const changed = new DatabaseSync(value.sourcePath);
  changed
    .prepare('UPDATE "Crontabs" SET schedule = ? WHERE id = 1')
    .run('5 0 * * *');
  changed.close();
  assert.throws(
    () =>
      verifyReviewedLegacyCrontabAdoptionDecisionReceipt({
        sourcePath: value.sourcePath,
        profile: 'edge',
        legacyTimezone: 'UTC',
        expectedPlanDigest: plan.planDigest,
        receipt,
        decisions,
        observedAtMs: REVIEWED_AT_MS + 1,
      }),
    /source no longer matches the reviewed plan/,
  );
});

test('requires an explicit timezone and canonicalizes multiple cron triggers', (t) => {
  const value = fixture(t);
  const source = new DatabaseSync(value.sourcePath);
  source.exec('ALTER TABLE "Crontabs" ADD COLUMN extra_schedules TEXT');
  source
    .prepare(
      `UPDATE "Crontabs"
       SET command = ?, extra_schedules = ?
       WHERE id = 1`,
    )
    .run(
      'task /scripts/timezone.sh',
      JSON.stringify([{ schedule: '1 0 * * *' }, { schedule: '2 0 * * *' }]),
    );
  source.close();

  const withoutTimezone = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'standalone',
  });
  const withoutPage = inspectLegacyCrontabAdoptionDiagnostics({
    sourcePath: value.sourcePath,
    profile: 'standalone',
    expectedPlanDigest: withoutTimezone.planDigest,
  });
  assert.equal(
    withoutPage.diagnostics[0].classification,
    'requires_manual_action',
  );
  assert.deepEqual(withoutPage.diagnostics[0].reasons, ['timezone_required']);
  assert.equal(withoutPage.diagnostics[0].triggerCount, 3);
  assert.equal(withoutPage.diagnostics[0].triggerSpecDigests, undefined);

  const withTimezone = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'standalone',
    legacyTimezone: 'Etc/UTC',
  });
  const withPage = inspectLegacyCrontabAdoptionDiagnostics({
    sourcePath: value.sourcePath,
    profile: 'standalone',
    legacyTimezone: 'UTC',
    expectedPlanDigest: withTimezone.planDigest,
  });
  assert.equal(withTimezone.tasks.timezone, 'UTC');
  assert.equal(withPage.diagnostics[0].classification, 'lossless');
  assert.equal(withPage.diagnostics[0].triggerCount, 3);
  assert.equal(withPage.diagnostics[0].triggerSpecDigests.length, 3);
  assert.notEqual(withoutTimezone.planDigest, withTimezone.planDigest);
});

test('binds Crontabs row content into the reviewed plan digest', async (t) => {
  const value = fixture(t);
  const reviewed = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
  });
  const source = new DatabaseSync(value.sourcePath);
  source
    .prepare('UPDATE "Crontabs" SET command = ? WHERE id = 1')
    .run('echo changed-without-schema-drift');
  source.close();
  const changed = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
  });

  assert.equal(changed.catalog.digest, reviewed.catalog.digest);
  assert.notEqual(
    changed.tasks.inventoryDigest,
    reviewed.tasks.inventoryDigest,
  );
  assert.notEqual(changed.planDigest, reviewed.planDigest);
  await assert.rejects(
    stageLocalSqliteAdoption({
      ...value,
      profile: 'edge',
      legacyTimezone: 'UTC',
      expectedPlanDigest: reviewed.planDigest,
    }),
    /source no longer matches the reviewed plan/,
  );
  assert.equal(fs.existsSync(value.targetPath), false);
  assert.equal(fs.existsSync(value.recoveryPath), false);
  assert.equal(fs.existsSync(value.manifestPath), false);
});

test('reports malformed legacy JSON and rejects unbounded diagnostic pages', (t) => {
  const value = fixture(t);
  const source = new DatabaseSync(value.sourcePath);
  source.exec('ALTER TABLE "Crontabs" ADD COLUMN extra_schedules TEXT');
  source
    .prepare('UPDATE "Crontabs" SET extra_schedules = ? WHERE id = 1')
    .run('{not-json');
  source.close();
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
  });
  assert.equal(page.diagnostics[0].classification, 'malformed');
  assert.equal(
    page.diagnostics[0].reasons.includes('extra_schedules_invalid'),
    true,
  );
  assert.throws(
    () =>
      inspectLegacyCrontabAdoptionDiagnostics({
        sourcePath: value.sourcePath,
        profile: 'edge',
        legacyTimezone: 'UTC',
        expectedPlanDigest: plan.planDigest,
        limit: 129,
      }),
    /task diagnostics failed/,
  );
});

test('runtime activation entrypoint excludes migration SQL and adoption review', () => {
  const script = `
    require(${JSON.stringify(path.resolve(__dirname, '../dist/runtime.js'))});
    const migration = Object.keys(require.cache)
      .filter((entry) => /[\\/]local-sqlite[\\/]dist[\\/](?:migration|migrations[\\/])/.test(entry));
    const classifier = Object.keys(require.cache)
      .filter((entry) => entry.endsWith('/local-admin/dist/legacy-adoption/legacyCrontabAdoption.js'));
    const decisionReceipt = Object.keys(require.cache)
      .filter((entry) => entry.endsWith('/local-admin/dist/legacy-adoption/legacyCrontabDecisionReceipt.js'));
    const decisionAuthorization = Object.keys(require.cache)
      .filter((entry) => entry.endsWith('/local-admin/dist/legacy-adoption/legacyCrontabDecisionAuthorizationFile.js'));
    process.stdout.write(JSON.stringify({ migration, classifier, decisionReceipt, decisionAuthorization }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    migration: [],
    classifier: [],
    decisionReceipt: [],
    decisionAuthorization: [],
  });
});

test('stages a restorable side-by-side database and preserves unknown data', async (t) => {
  const value = fixture(t);
  const sourceDigest = sha256(value.sourcePath);
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
  });
  const manifest = await stageLocalSqliteAdoption({
    ...value,
    profile: 'edge',
    expectedPlanDigest: plan.planDigest,
    clock: () => 1_750_000_000_000,
  });

  assert.equal(manifest.state, 'staged');
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.tasks.inventoryDigest, plan.tasks.inventoryDigest);
  assert.equal(manifest.createdAtMs, 1_750_000_000_000);
  assert.match(manifest.manifestDigest, /^[0-9a-f]{64}$/);
  assert.equal(sha256(value.sourcePath), sourceDigest);
  assert.equal(fs.statSync(value.recoveryPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(value.targetPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(value.manifestPath).mode & 0o777, 0o600);

  const recovery = new DatabaseSync(value.recoveryPath, { readOnly: true });
  assert.equal(
    recovery
      .prepare(
        `SELECT 1 FROM sqlite_schema
         WHERE type = 'table' AND name = 'QingLong3SchemaMigrations'`,
      )
      .get(),
    undefined,
  );
  recovery.close();

  const target = new DatabaseSync(value.targetPath, { readOnly: true });
  const pluginRow = target
    .prepare('SELECT id, payload FROM "PluginOwnedState"')
    .get();
  assert.equal(pluginRow.id, 1);
  assert.equal(pluginRow.payload, '{"preserved":true}');
  assert.equal(
    target.prepare('SELECT COUNT(*) AS count FROM "Runs"').get().count,
    0,
  );
  target.close();

  assert.deepEqual(await verifyLocalSqliteAdoption(value), manifest);
  await assert.rejects(
    stageLocalSqliteAdoption({
      ...value,
      profile: 'edge',
      expectedPlanDigest: plan.planDigest,
    }),
    /target already exists/,
  );
});

test('rejects a stale plan before creating any adoption output', async (t) => {
  const value = fixture(t);
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'standalone',
  });
  const source = new DatabaseSync(value.sourcePath);
  source.exec('CREATE TABLE "LateLegacyWrite" (id INTEGER PRIMARY KEY)');
  source.close();

  await assert.rejects(
    stageLocalSqliteAdoption({
      ...value,
      profile: 'standalone',
      expectedPlanDigest: plan.planDigest,
    }),
    /source no longer matches the reviewed plan/,
  );
  assert.equal(fs.existsSync(value.targetPath), false);
  assert.equal(fs.existsSync(value.recoveryPath), false);
  assert.equal(fs.existsSync(value.manifestPath), false);
});

test('rejects non-legacy, already adopted, and symlink sources', (t) => {
  const value = fixture(t);
  const incompletePath = path.join(value.directory, 'incomplete.sqlite');
  const incomplete = new DatabaseSync(incompletePath);
  incomplete.exec('CREATE TABLE "Crontabs" (id INTEGER PRIMARY KEY)');
  incomplete.close();
  assert.throws(
    () =>
      inspectLegacySqlitePath({ sourcePath: incompletePath, profile: 'edge' }),
    LocalSqliteAdoptionError,
  );

  const source = new DatabaseSync(value.sourcePath);
  source.exec('CREATE TABLE "Runs" (id TEXT PRIMARY KEY)');
  source.close();
  assert.throws(
    () =>
      inspectLegacySqlitePath({
        sourcePath: value.sourcePath,
        profile: 'edge',
      }),
    /conflicting 3.0 object Runs/,
  );

  const symlinkPath = path.join(value.directory, 'database-link.sqlite');
  fs.symlinkSync(value.sourcePath, symlinkPath);
  assert.throws(
    () => inspectLegacySqlitePath({ sourcePath: symlinkPath, profile: 'edge' }),
    /regular file/,
  );
});

test('fails verification after staged bytes or manifest fields drift', async (t) => {
  const value = fixture(t);
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
  });
  await stageLocalSqliteAdoption({
    ...value,
    profile: 'edge',
    expectedPlanDigest: plan.planDigest,
  });

  fs.appendFileSync(value.recoveryPath, Buffer.from([0]));
  await assert.rejects(
    verifyLocalSqliteAdoption(value),
    /staged database digest does not match/,
  );
});

test('rejects an extensible manifest even when its digest is recomputed', async (t) => {
  const value = fixture(t);
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
  });
  await stageLocalSqliteAdoption({
    ...value,
    profile: 'edge',
    expectedPlanDigest: plan.planDigest,
  });
  const manifest = JSON.parse(fs.readFileSync(value.manifestPath, 'utf8'));
  manifest.recovery.unreviewed = true;
  delete manifest.manifestDigest;
  manifest.manifestDigest = createHash('sha256')
    .update(JSON.stringify(manifest))
    .digest('hex');
  fs.writeFileSync(value.manifestPath, `${JSON.stringify(manifest)}\n`, {
    mode: 0o600,
  });

  await assert.rejects(
    verifyLocalSqliteAdoption(value),
    /manifest recovery evidence is invalid/,
  );
});

test('prepares activation only while the source still matches the staged snapshot', async (t) => {
  const value = fixture(t);
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
  });
  const adoption = await stageLocalSqliteAdoption({
    ...value,
    profile: 'edge',
    expectedPlanDigest: plan.planDigest,
  });
  const activation = await prepareLocalSqliteActivation({
    ...value,
    expectedManifestDigest: adoption.manifestDigest,
    clock: () => 1_760_000_000_000,
  });

  assert.equal(activation.state, 'prepared');
  assert.equal(activation.createdAtMs, 1_760_000_000_000);
  assert.equal(activation.adoptionManifestDigest, adoption.manifestDigest);
  assert.match(activation.targetPathDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    activation.targetDevice,
    fs.statSync(value.targetPath).dev.toString(),
  );
  assert.equal(
    activation.targetInode,
    fs.statSync(value.targetPath).ino.toString(),
  );
  assert.equal(fs.statSync(value.activationPath).mode & 0o777, 0o600);
  await assert.rejects(
    prepareLocalSqliteActivation({
      ...value,
      expectedManifestDigest: adoption.manifestDigest,
    }),
    /activation already exists/,
  );
});

test('rejects activation when legacy data changed after staging', async (t) => {
  const value = fixture(t);
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
  });
  const adoption = await stageLocalSqliteAdoption({
    ...value,
    profile: 'edge',
    expectedPlanDigest: plan.planDigest,
  });
  const source = new DatabaseSync(value.sourcePath);
  source
    .prepare('INSERT INTO "PluginOwnedState" (id, payload) VALUES (?, ?)')
    .run(2, '{"late":true}');
  source.close();

  await assert.rejects(
    prepareLocalSqliteActivation({
      ...value,
      expectedManifestDigest: adoption.manifestDigest,
    }),
    /legacy source content changed after staging/,
  );
  assert.equal(fs.existsSync(value.activationPath), false);
});

test('holds a legacy write fence for the complete activated lifetime', async (t) => {
  const value = fixture(t);
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'standalone',
  });
  const adoption = await stageLocalSqliteAdoption({
    ...value,
    profile: 'standalone',
    expectedPlanDigest: plan.planDigest,
  });
  const activation = await prepareLocalSqliteActivation({
    ...value,
    expectedManifestDigest: adoption.manifestDigest,
  });
  const fence = await acquireLocalSqliteActivation({
    ...value,
    expectedActivationDigest: activation.activationDigest,
    busyTimeoutMs: 100,
  });
  assert.equal(fence.state, 'fenced');

  const legacyWriter = new DatabaseSync(value.sourcePath, { timeout: 100 });
  assert.throws(
    () =>
      legacyWriter
        .prepare(
          'INSERT INTO "Crontabs" (id, command, schedule) VALUES (?, ?, ?)',
        )
        .run(2, 'echo fenced', '1 1 * * *'),
    (error) => error && error.errstr === 'database is locked',
  );
  assert.equal(await fence.release(), 'released');
  assert.equal(await fence.release(), 'released');
  legacyWriter
    .prepare('INSERT INTO "Crontabs" (id, command, schedule) VALUES (?, ?, ?)')
    .run(2, 'echo released', '1 1 * * *');
  assert.equal(
    legacyWriter.prepare('SELECT COUNT(*) AS count FROM "Crontabs"').get()
      .count,
    2,
  );
  legacyWriter.close();
});

test('reacquires an activated target after legitimate QingLong 3 writes', async (t) => {
  const value = fixture(t);
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'standalone',
  });
  const adoption = await stageLocalSqliteAdoption({
    ...value,
    profile: 'standalone',
    expectedPlanDigest: plan.planDigest,
  });
  const activation = await prepareLocalSqliteActivation({
    ...value,
    expectedManifestDigest: adoption.manifestDigest,
  });
  const firstFence = await acquireLocalSqliteActivation({
    ...value,
    expectedActivationDigest: activation.activationDigest,
  });
  await firstFence.release();

  const target = new DatabaseSync(value.targetPath);
  target
    .prepare('INSERT INTO "Crontabs" (id, command, schedule) VALUES (?, ?, ?)')
    .run(2, 'echo ql3', '2 2 * * *');
  target.close();

  await assert.rejects(
    verifyLocalSqliteAdoption(value),
    /staged database digest does not match/,
  );
  const restartedFence = await acquireLocalSqliteActivation({
    ...value,
    expectedActivationDigest: activation.activationDigest,
  });
  assert.equal(restartedFence.state, 'fenced');
  assert.equal(await restartedFence.release(), 'released');
});

test('reacquires an activated target after an additive feature migration', async (t) => {
  const value = fixture(t);
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
  });
  const adoption = await stageLocalSqliteAdoption({
    ...value,
    profile: 'edge',
    expectedPlanDigest: plan.planDigest,
  });
  const activation = await prepareLocalSqliteActivation({
    ...value,
    expectedManifestDigest: adoption.manifestDigest,
  });

  const target = new DatabaseSync(value.targetPath);
  target.exec('CREATE TABLE "QingLong3OptionalFeature" (id TEXT PRIMARY KEY)');
  target.close();

  const fence = await acquireLocalSqliteActivation({
    ...value,
    expectedActivationDigest: activation.activationDigest,
  });
  assert.equal(fence.state, 'fenced');
  assert.equal(await fence.release(), 'released');
});

test('rejects an activated target whose reviewed schema baseline regressed', async (t) => {
  const value = fixture(t);
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
  });
  const adoption = await stageLocalSqliteAdoption({
    ...value,
    profile: 'edge',
    expectedPlanDigest: plan.planDigest,
  });
  const activation = await prepareLocalSqliteActivation({
    ...value,
    expectedManifestDigest: adoption.manifestDigest,
  });

  const target = new DatabaseSync(value.targetPath);
  target.exec('DROP TABLE "PluginOwnedState"');
  target.close();

  await assert.rejects(
    acquireLocalSqliteActivation({
      ...value,
      expectedActivationDigest: activation.activationDigest,
    }),
    /target readiness evidence has drifted/,
  );
});

test('rejects a ready target file that replaced the activated inode', async (t) => {
  const value = fixture(t);
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile: 'edge',
  });
  const adoption = await stageLocalSqliteAdoption({
    ...value,
    profile: 'edge',
    expectedPlanDigest: plan.planDigest,
  });
  const activation = await prepareLocalSqliteActivation({
    ...value,
    expectedManifestDigest: adoption.manifestDigest,
  });
  const replacementPath = path.join(value.directory, 'replacement.sqlite');
  fs.copyFileSync(value.targetPath, replacementPath);
  fs.renameSync(replacementPath, value.targetPath);

  await assert.rejects(
    acquireLocalSqliteActivation({
      ...value,
      expectedActivationDigest: activation.activationDigest,
    }),
    /target database identity does not match the activation/,
  );
});
