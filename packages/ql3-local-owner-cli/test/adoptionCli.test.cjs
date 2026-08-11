const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  inspectLegacyCrontabAdoptionDiagnostics,
  inspectLegacySqlitePath,
  verifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFile,
} = require('@qinglong/local-admin');
const {
  LegacyCrontabDecisionIssuerKeyringFileProvider,
  provisionLegacyCrontabDecisionIssuerKeyring,
} = require('@qinglong/local-admin/decision-issuer');
const {
  LocalOwnerPepperKeyringFileProvider,
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console/pepper-custody');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');
const {
  LegacyCrontabAdoptionCliConfigurationError,
  runLegacyCrontabAdoptionCommandFile,
} = require('../dist/lifecycle/adoption');

const DECISION_ID = '019a2b3c-4d5e-7f60-8123-456789abcdef';
const MUTATION_ID = '12345678-1234-4123-8123-123456789ace';
const CREDENTIAL_ID = 'owner-adoption';
const PEPPER_KEY_ID = 'owner-v1';
const PEPPER = Buffer.alloc(32, 83).toString('base64url');
const SECRET = Buffer.alloc(32, 84).toString('base64url');
const TOKEN = formatApiCredentialToken(CREDENTIAL_ID, SECRET);
const OTHER_CREDENTIAL_ID = 'other-adoption';
const OTHER_SECRET = Buffer.alloc(32, 85).toString('base64url');
const OTHER_TOKEN = formatApiCredentialToken(OTHER_CREDENTIAL_ID, OTHER_SECRET);

async function fixture(t) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-adoption-cli-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const commandsDirectory = path.join(deploymentRoot, 'commands');
  const authorizationDirectory = path.join(deploymentRoot, 'authorizations');
  const pepperKeyringDirectory = path.join(deploymentRoot, 'owner-keys');
  for (const directory of [
    commandsDirectory,
    authorizationDirectory,
    pepperKeyringDirectory,
  ]) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  const databasePath = path.join(deploymentRoot, 'qinglong3.sqlite');
  const sourcePath = path.join(deploymentRoot, 'legacy.sqlite');
  const reviewFilePath = path.join(deploymentRoot, 'review.ndjson');
  const credentialFilePath = path.join(deploymentRoot, 'credential.json');
  const issuerKeyringPath = path.join(
    deploymentRoot,
    'decision-issuer.keyring',
  );
  const authorizationPath = path.join(
    authorizationDirectory,
    'decision.ndjson',
  );

  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const pepperSummary = provisionLocalOwnerPepperKey({
    keyringDirectory: pepperKeyringDirectory,
    pepperKeyId: PEPPER_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 83),
  });
  const now = Date.now();
  const target = new DatabaseSync(databasePath);
  try {
    target
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
           "pepper_key_id", "material_digest", "backup_digest", "state",
           "version", "register_mutation_id", "activate_mutation_id",
           "registered_at_ms", "activated_at_ms"
         ) VALUES (?, ?, ?, 'active', 2, ?, ?, ?, ?)`,
      )
      .run(
        PEPPER_KEY_ID,
        pepperSummary.digest,
        'b'.repeat(64),
        '00000000-0000-4000-8000-000000000a01',
        '00000000-0000-4000-8000-000000000a02',
        now - 2_000,
        now - 1_500,
      );
    target
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
           "generation", "mutation_id", "expected_generation",
           "previous_pepper_key_id", "active_pepper_key_id",
           "material_digest", "backup_digest", "activated_at_ms"
         ) VALUES (1, ?, 0, NULL, ?, ?, ?, ?)`,
      )
      .run(
        '00000000-0000-4000-8000-000000000a02',
        PEPPER_KEY_ID,
        pepperSummary.digest,
        'b'.repeat(64),
        now - 1_500,
      );
    target
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
           "subject_type", "subject_id", "status", "version",
           "created_at_ms", "updated_at_ms"
         ) VALUES ('user', 'owner-user', 'active', 1, ?, ?)`,
      )
      .run(now - 1_000, now - 1_000);
    target
      .prepare(
        `INSERT INTO "QingLong3ApiCredentials" (
           "credential_id", "version", "state", "subject_type",
           "subject_id", "secret_digest", "created_at_ms",
           "not_before_at_ms", "expires_at_ms"
         ) VALUES (?, 1, 'active', 'user', 'owner-user', ?, ?, ?, ?)`,
      )
      .run(
        CREDENTIAL_ID,
        apiCredentialSecretDigest(PEPPER, CREDENTIAL_ID, SECRET),
        now - 1_000,
        now - 1_000,
        now + 10 * 60 * 1_000,
      );
    target
      .prepare(
        `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
           "credential_id", "credential_version", "pepper_key_id"
         ) VALUES (?, 1, ?)`,
      )
      .run(CREDENTIAL_ID, PEPPER_KEY_ID);
    target
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           "project_id", "subject_type", "subject_id", "version", "state",
           "role", "mutation_id", "changed_by_type", "changed_by_id",
           "created_at_ms"
         ) VALUES (
           'default', 'user', 'owner-user', 1, 'active', 'owner',
           'adoption-cli-owner-binding', 'user', 'owner-user', ?
         )`,
      )
      .run(now - 500);
  } finally {
    target.close();
  }
  fs.chmodSync(databasePath, 0o600);

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
  fs.chmodSync(sourcePath, 0o600);

  const plan = inspectLegacySqlitePath({
    sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
  });
  const page = inspectLegacyCrontabAdoptionDiagnostics({
    sourcePath,
    profile: 'edge',
    legacyTimezone: 'UTC',
    expectedPlanDigest: plan.planDigest,
    limit: 16,
  });
  const decision = {
    rowOrdinal: page.diagnostics[0].rowOrdinal,
    sourceDigest: page.diagnostics[0].sourceDigest,
    disposition: 'adopt',
    reason: 'reviewed_lossless',
  };
  const reviewRecords = [
    {
      schemaVersion: 1,
      kind: 'qinglong3-legacy-crontab-decision-review-file-header',
      decisionId: DECISION_ID,
      profile: 'edge',
      planDigest: plan.planDigest,
      inventoryDigest: plan.tasks.inventoryDigest,
    },
    {
      schemaVersion: 1,
      kind: 'qinglong3-legacy-crontab-decision-review-file-row',
      decision,
    },
  ];
  fs.writeFileSync(
    reviewFilePath,
    `${reviewRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    credentialFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-identity-credential-presentation',
      token: TOKEN,
    })}\n`,
    { mode: 0o600 },
  );
  await provisionLegacyCrontabDecisionIssuerKeyring(issuerKeyringPath);

  const options = {
    deploymentRoot,
    databasePath,
    profile: 'edge',
    ownerPepperKeyringDirectory: pepperKeyringDirectory,
    issuerKeyringPath,
    credentialFilePath,
    sourcePath,
    reviewFilePath,
    authorizationPath,
    expectedPlanDigest: plan.planDigest,
    decisionId: DECISION_ID,
    legacyTimezone: 'UTC',
    lifetimeMs: 30_000,
  };
  const commandFilePath = path.join(commandsDirectory, 'issue.json');
  fs.writeFileSync(
    commandFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'legacy-crontab.decision.issue',
      options,
    })}\n`,
    { mode: 0o600 },
  );
  return {
    ...options,
    commandFilePath,
    plan,
    pepperProvider: new LocalOwnerPepperKeyringFileProvider(
      pepperKeyringDirectory,
    ),
  };
}

function writeCommitCommand(value, name = 'commit') {
  const commandFilePath = path.join(
    path.dirname(value.commandFilePath),
    `${name}.json`,
  );
  fs.writeFileSync(
    commandFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'legacy-crontab.adoption.commit',
      options: {
        deploymentRoot: value.deploymentRoot,
        targetPath: value.databasePath,
        profile: value.profile,
        ownerPepperKeyringDirectory: value.ownerPepperKeyringDirectory,
        issuerKeyringPath: value.issuerKeyringPath,
        credentialFilePath: value.credentialFilePath,
        sourcePath: value.sourcePath,
        authorizationPath: value.authorizationPath,
        expectedPlanDigest: value.expectedPlanDigest,
        expectedDecisionId: DECISION_ID,
        projectId: 'default',
        mutationId: MUTATION_ID,
        requestId: `legacy-adoption-cli-${name}`,
        legacyTimezone: 'UTC',
      },
    })}\n`,
    { mode: 0o600 },
  );
  return commandFilePath;
}

test('issues a reviewed authorization through the ql3-adoption product binary', async (t) => {
  const value = await fixture(t);
  const child = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/lifecycle/adoptionCli.js'),
      'run',
      '--command-file',
      value.commandFilePath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.includes(TOKEN), false);
  const result = JSON.parse(child.stdout);
  assert.equal(result.operation, 'legacy-crontab.decision.issue');
  assert.equal(result.receipt.reviewerSubjectId, 'owner-user');
  assert.equal(result.authorization.decisionCount, 1);
  assert.match(result.review.fileDigest, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(value.authorizationPath).mode & 0o777, 0o600);

  const verified =
    await verifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
      sourcePath: value.sourcePath,
      profile: 'edge',
      legacyTimezone: 'UTC',
      expectedPlanDigest: value.plan.planDigest,
      expectedDecisionId: DECISION_ID,
      authorizationPath: value.authorizationPath,
      keyProvider: new LegacyCrontabDecisionIssuerKeyringFileProvider(
        value.issuerKeyringPath,
      ),
      observedAtMs: result.receipt.issuedAtMs + 1,
    });
  assert.equal(verified.file.fileDigest, result.authorization.fileDigest);
  assert.equal(verified.receipt.reviewer.assurance, 'local_console');
});

test('commits the signed adoption with the same current operator', async (t) => {
  const value = await fixture(t);
  const binaryPath = path.join(__dirname, '../dist/lifecycle/adoptionCli.js');
  const issued = spawnSync(
    process.execPath,
    [binaryPath, 'run', '--command-file', value.commandFilePath],
    { encoding: 'utf8' },
  );
  assert.equal(issued.status, 0, issued.stderr);

  const commitCommandPath = writeCommitCommand(value);
  const committed = spawnSync(
    process.execPath,
    [binaryPath, 'run', '--command-file', commitCommandPath],
    { encoding: 'utf8' },
  );
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(committed.stderr, '');
  assert.equal(committed.stdout.includes(TOKEN), false);
  const result = JSON.parse(committed.stdout);
  assert.equal(result.operation, 'legacy-crontab.adoption.commit');
  assert.equal(result.status, 'inserted');
  assert.equal(result.adoption.mutationId, MUTATION_ID);
  assert.equal(result.adoption.adoptedTaskCount, 1);
  assert.equal(result.adoption.adoptedTriggerCount, 1);

  const target = new DatabaseSync(value.databasePath, { readOnly: true });
  assert.equal(
    target
      .prepare('SELECT COUNT(*) AS count FROM "QingLong3LegacyAdoptions"')
      .get().count,
    1,
  );
  assert.equal(
    target
      .prepare('SELECT COUNT(*) AS count FROM "QingLong3TaskDefinitions"')
      .get().count,
    1,
  );
  target.close();
});

test('rejects a valid current operator who is not the signed reviewer', async (t) => {
  const value = await fixture(t);
  const binaryPath = path.join(__dirname, '../dist/lifecycle/adoptionCli.js');
  const issued = spawnSync(
    process.execPath,
    [binaryPath, 'run', '--command-file', value.commandFilePath],
    { encoding: 'utf8' },
  );
  assert.equal(issued.status, 0, issued.stderr);

  const now = Date.now();
  const target = new DatabaseSync(value.databasePath);
  target
    .prepare(
      `INSERT INTO "QingLong3IdentitySubjects" (
         "subject_type", "subject_id", "status", "version",
         "created_at_ms", "updated_at_ms"
       ) VALUES ('user', 'other-user', 'active', 1, ?, ?)`,
    )
    .run(now, now);
  target
    .prepare(
      `INSERT INTO "QingLong3ApiCredentials" (
         "credential_id", "version", "state", "subject_type",
         "subject_id", "secret_digest", "created_at_ms",
         "not_before_at_ms", "expires_at_ms"
       ) VALUES (?, 1, 'active', 'user', 'other-user', ?, ?, ?, ?)`,
    )
    .run(
      OTHER_CREDENTIAL_ID,
      apiCredentialSecretDigest(PEPPER, OTHER_CREDENTIAL_ID, OTHER_SECRET),
      now,
      now,
      now + 10 * 60 * 1_000,
    );
  target
    .prepare(
      `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
         "credential_id", "credential_version", "pepper_key_id"
       ) VALUES (?, 1, ?)`,
    )
    .run(OTHER_CREDENTIAL_ID, PEPPER_KEY_ID);
  target.close();
  fs.chmodSync(value.databasePath, 0o600);
  fs.writeFileSync(
    value.credentialFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-identity-credential-presentation',
      token: OTHER_TOKEN,
    })}\n`,
    { mode: 0o600 },
  );

  const rejected = spawnSync(
    process.execPath,
    [
      binaryPath,
      'run',
      '--command-file',
      writeCommitCommand(value, 'mismatched-reviewer'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, '');
  assert.equal(rejected.stderr.includes(OTHER_TOKEN), false);
  assert.equal(
    JSON.parse(rejected.stderr).code,
    'LEGACY_CRONTAB_ADOPTION_CLI_AUTHENTICATION_FAILED',
  );

  const stored = new DatabaseSync(value.databasePath, { readOnly: true });
  assert.equal(
    stored
      .prepare('SELECT COUNT(*) AS count FROM "QingLong3LegacyAdoptions"')
      .get().count,
    0,
  );
  stored.close();
});

test('keeps credential material outside command JSON and fails closed on widened intent', async (t) => {
  const value = await fixture(t);
  const commandText = fs.readFileSync(value.commandFilePath, 'utf8');
  assert.equal(commandText.includes(TOKEN), false);
  assert.equal(commandText.includes(SECRET), false);

  const widenedPath = path.join(
    path.dirname(value.commandFilePath),
    'widened.json',
  );
  const widened = JSON.parse(commandText);
  widened.options.token = TOKEN;
  fs.writeFileSync(widenedPath, `${JSON.stringify(widened)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    runLegacyCrontabAdoptionCommandFile(widenedPath),
    LegacyCrontabAdoptionCliConfigurationError,
  );
  assert.equal(fs.existsSync(value.authorizationPath), false);

  const help = spawnSync(
    process.execPath,
    [path.join(__dirname, '../dist/lifecycle/adoptionCli.js'), '--help'],
    { encoding: 'utf8' },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: ql3-adoption run --command-file /);
});

test('rejects an invalid credential without publishing authorization', async (t) => {
  const value = await fixture(t);
  const presentation = JSON.parse(
    fs.readFileSync(value.credentialFilePath, 'utf8'),
  );
  presentation.token = formatApiCredentialToken(
    CREDENTIAL_ID,
    Buffer.alloc(32, 90).toString('base64url'),
  );
  fs.writeFileSync(
    value.credentialFilePath,
    `${JSON.stringify(presentation)}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    runLegacyCrontabAdoptionCommandFile(value.commandFilePath),
  );
  assert.equal(fs.existsSync(value.authorizationPath), false);
});
