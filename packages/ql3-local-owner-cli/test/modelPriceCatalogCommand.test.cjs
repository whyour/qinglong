const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
  migrateLocalModelInvocationFeature,
} = require('@qinglong/ai/model-invocation-migration');
const {
  LocalModelInvocationFeatureActivationRepository,
  createLocalModelInvocationFeatureTransitionCommand,
} = require('@qinglong/ai/local-feature-activation');
const {
  createLocalModelPriceCatalogCommandRunner,
  runLocalModelPriceCatalogCommandFile,
} = require('@qinglong/local-owner-cli/model-price-command');
const {
  establishAuthenticatedLocalCommand,
} = require('@qinglong/local-owner-console/authenticated-command');
const {
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  openLocalSqlitePluginPackageManagementDatabase,
} = require('@qinglong/local-sqlite/package-management');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');

const CREDENTIAL_ID = 'model-price-owner';
const PEPPER_KEY_ID = 'model-price-owner-v1';
const PEPPER = Buffer.alloc(32, 81).toString('base64url');
const SECRET = Buffer.alloc(32, 82).toString('base64url');
const TOKEN = formatApiCredentialToken(CREDENTIAL_ID, SECRET);
const PROVIDER = 'openai-compatible';
const MODEL = 'test-model';
const REVISION = '2026-07-27';

async function fixture(t, { aiReady = true, owner = true } = {}) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-model-price-command-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const commandsDirectory = path.join(deploymentRoot, 'commands');
  const ownerPepperKeyringDirectory = path.join(deploymentRoot, 'owner-keys');
  fs.mkdirSync(commandsDirectory, { mode: 0o700 });
  fs.mkdirSync(ownerPepperKeyringDirectory, { mode: 0o700 });
  const databasePath = path.join(deploymentRoot, 'qinglong3.sqlite');
  const credentialFilePath = path.join(deploymentRoot, 'credential.json');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  if (aiReady) {
    const aiDatabase = new DatabaseSync(databasePath);
    try {
      await migrateLocalModelInvocationFeature(aiDatabase);
      new LocalModelInvocationFeatureActivationRepository(
        aiDatabase,
      ).transition(
        createLocalModelInvocationFeatureTransitionCommand({
          featureId: 'model-invocation',
          expectedGeneration: 0,
          expectedState: null,
          state: 'active',
          mutationId: 'model-price-fixture-feature-activation',
          requestId: 'model-price-fixture-feature-request',
          expectedMigrationDigest:
            LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
          safety: {
            mode: 'fresh_database',
            backupEvidenceDigest: null,
          },
          principal: {
            subject: { type: 'user', id: 'owner-user' },
            authenticationId: 'local_ai_feature:fixture-proof',
            authenticatedAtMs: 1,
            expiresAtMs: 301_000,
            assurance: 'local_console',
          },
        }),
      );
    } finally {
      aiDatabase.close();
    }
  }
  const summary = provisionLocalOwnerPepperKey({
    keyringDirectory: ownerPepperKeyringDirectory,
    pepperKeyId: PEPPER_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 81),
  });
  const now = Date.now();
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
           "pepper_key_id", "material_digest", "backup_digest", "state",
           "version", "register_mutation_id", "activate_mutation_id",
           "registered_at_ms", "activated_at_ms"
         ) VALUES (?, ?, ?, 'active', 2, ?, ?, ?, ?)`,
      )
      .run(
        PEPPER_KEY_ID,
        summary.digest,
        'b'.repeat(64),
        '41000000-0000-4000-8000-000000000001',
        '41000000-0000-4000-8000-000000000002',
        now - 2_000,
        now - 1_500,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
           "generation", "mutation_id", "expected_generation",
           "previous_pepper_key_id", "active_pepper_key_id",
           "material_digest", "backup_digest", "activated_at_ms"
         ) VALUES (1, ?, 0, NULL, ?, ?, ?, ?)`,
      )
      .run(
        '41000000-0000-4000-8000-000000000002',
        PEPPER_KEY_ID,
        summary.digest,
        'b'.repeat(64),
        now - 1_500,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
           "subject_type", "subject_id", "status", "version",
           "created_at_ms", "updated_at_ms"
         ) VALUES ('user', 'owner-user', 'active', 1, ?, ?)`,
      )
      .run(now - 1_000, now - 1_000);
    database
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
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
           "credential_id", "credential_version", "pepper_key_id"
         ) VALUES (?, 1, ?)`,
      )
      .run(CREDENTIAL_ID, PEPPER_KEY_ID);
    if (owner) {
      database
        .prepare(
          `INSERT INTO "QingLong3ProjectRoleBindings" (
             "project_id", "subject_type", "subject_id", "version", "state",
             "role", "mutation_id", "changed_by_type", "changed_by_id",
             "created_at_ms"
           ) VALUES (
             'default', 'user', 'owner-user', 1, 'active', 'owner',
             'model-price-owner-binding', 'user', 'owner-user', ?
           )`,
        )
        .run(now - 500);
    }
  } finally {
    database.close();
  }
  fs.chmodSync(databasePath, 0o600);
  fs.writeFileSync(
    credentialFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-identity-credential-presentation',
      token: TOKEN,
    })}\n`,
    { mode: 0o600 },
  );
  return {
    deploymentRoot,
    commandsDirectory,
    databasePath,
    credentialFilePath,
    ownerPepperKeyringDirectory,
    options: {
      deploymentRoot,
      databasePath,
      profile: 'edge',
      ownerPepperKeyringDirectory,
      credentialFilePath,
    },
  };
}

function commandFile(value, operation, request, name, extra = {}) {
  const commandPath = path.join(value.commandsDirectory, `${name}.json`);
  fs.writeFileSync(
    commandPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation,
      options: value.options,
      request,
      ...extra,
    })}\n`,
    { mode: 0o600 },
  );
  return commandPath;
}

function baseRequest(suffix, failureAuditEventId) {
  return {
    requestId: `model-price-${suffix}`,
    failureAuditEventId,
    provider: PROVIDER,
    model: MODEL,
  };
}

function mutationRequest(suffix, failureAuditEventId) {
  return {
    ...baseRequest(suffix, failureAuditEventId),
    authorizationId: `model-price-authorization-${suffix}`,
    mutationId: `model-price-mutation-${suffix}`,
  };
}

function assertNoSensitiveMaterial(result) {
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(SECRET), false);
  assert.doesNotMatch(serialized, /authenticationId|principal|subjectId/);
}

test('runs a replay-safe private local Model Price Catalog lifecycle', async (t) => {
  const value = await fixture(t);
  const publishFile = commandFile(
    value,
    'model-price.publish',
    {
      ...mutationRequest('publish-1', '42000000-0000-4000-8000-000000000001'),
      priceRevision: REVISION,
      currency: 'USD',
      inputMicrosPerMillionTokens: 150_000,
      outputMicrosPerMillionTokens: 600_000,
    },
    '01-publish',
  );
  const published = await runLocalModelPriceCatalogCommandFile(publishFile);
  assert.equal(published.status, 'created');
  assert.equal(published.publication.priceRevision, REVISION);
  assert.equal(
    published.authorization.policyRevision,
    'local_console_platform_owner_v1',
  );
  assertNoSensitiveMaterial(published);

  const replayed = await runLocalModelPriceCatalogCommandFile(publishFile);
  assert.equal(replayed.status, 'existing');
  assert.deepEqual(replayed.publication, published.publication);
  assert.deepEqual(replayed.authorization, published.authorization);

  const activateFile = commandFile(
    value,
    'model-price.activate',
    {
      ...mutationRequest('activate-1', '42000000-0000-4000-8000-000000000002'),
      expectedGeneration: 0,
      expectedHeadDigest: null,
      priceRevision: REVISION,
    },
    '02-activate',
  );
  const activated = await runLocalModelPriceCatalogCommandFile(activateFile);
  assert.equal(activated.status, 'created');
  assert.equal(activated.head.generation, 1);
  assert.equal(activated.head.activePriceRevision, REVISION);

  const inspectFile = commandFile(
    value,
    'model-price.inspect',
    {
      ...baseRequest('inspect-1', '42000000-0000-4000-8000-000000000003'),
      priceRevision: REVISION,
    },
    '03-inspect',
  );
  const inspected = await runLocalModelPriceCatalogCommandFile(inspectFile);
  assert.equal(inspected.head.headDigest, activated.head.headDigest);
  assert.equal(
    inspected.publication.publicationDigest,
    published.publication.publicationDigest,
  );
  assertNoSensitiveMaterial(inspected);

  const child = spawnSync(
    process.execPath,
    [
      path.join(
        __dirname,
        '../dist/ai-management/modelPriceCatalogCli.js',
      ),
      'run',
      '--command-file',
      inspectFile,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.equal(JSON.parse(child.stdout).operation, 'model-price.inspect');
  assert.equal(child.stdout.includes(TOKEN), false);

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT
               (SELECT count(*) FROM "ModelPriceCatalogPublications") AS publications,
               (SELECT count(*) FROM "ModelPriceCatalogHeads") AS heads,
               (SELECT count(*) FROM "ModelPriceCatalogAuthorizations") AS authorizations`,
          )
          .get(),
      },
      { publications: 1, heads: 1, authorizations: 2 },
    );
  } finally {
    database.close();
  }
});

test('fails closed before authentication when AI schema is not activated', async (t) => {
  const value = await fixture(t, { aiReady: false });
  let authenticated = 0;
  const runner = createLocalModelPriceCatalogCommandRunner({
    openDatabase: openLocalSqlitePluginPackageManagementDatabase,
    async authenticate(...args) {
      authenticated += 1;
      return establishAuthenticatedLocalCommand(...args);
    },
    now: Date.now,
  });
  await assert.rejects(
    runner.run(
      commandFile(
        value,
        'model-price.inspect',
        {
          ...baseRequest(
            'schema-not-ready',
            '43000000-0000-4000-8000-000000000001',
          ),
          priceRevision: null,
        },
        'schema-not-ready',
      ),
    ),
    { code: 'LOCAL_MODEL_INVOCATION_FEATURE_NOT_READY' },
  );
  assert.equal(authenticated, 0);
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count FROM sqlite_schema
            WHERE type = 'table'
              AND name LIKE 'ModelPriceCatalog%'`,
        )
        .get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test('fails closed before authentication when AI feature is explicitly inactive', async (t) => {
  const value = await fixture(t);
  const database = new DatabaseSync(value.databasePath);
  try {
    new LocalModelInvocationFeatureActivationRepository(database).transition(
      createLocalModelInvocationFeatureTransitionCommand({
        featureId: 'model-invocation',
        expectedGeneration: 1,
        expectedState: 'active',
        state: 'inactive',
        mutationId: 'model-price-fixture-feature-deactivation',
        requestId: 'model-price-fixture-feature-deactivation-request',
        expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
        safety: {
          mode: 'preserve_existing',
          backupEvidenceDigest: null,
        },
        principal: {
          subject: { type: 'user', id: 'owner-user' },
          authenticationId: 'local_ai_feature:fixture-proof',
          authenticatedAtMs: 1,
          expiresAtMs: 301_000,
          assurance: 'local_console',
        },
      }),
    );
  } finally {
    database.close();
  }
  let authenticated = 0;
  const runner = createLocalModelPriceCatalogCommandRunner({
    openDatabase: openLocalSqlitePluginPackageManagementDatabase,
    async authenticate(...args) {
      authenticated += 1;
      return establishAuthenticatedLocalCommand(...args);
    },
    now: Date.now,
  });
  await assert.rejects(
    runner.run(
      commandFile(
        value,
        'model-price.inspect',
        {
          ...baseRequest(
            'feature-inactive',
            '43000000-0000-4000-8000-000000000002',
          ),
          priceRevision: null,
        },
        'feature-inactive',
      ),
    ),
    { code: 'LOCAL_MODEL_INVOCATION_FEATURE_TRANSITION_UNAVAILABLE' },
  );
  assert.equal(authenticated, 0);
});

test('rejects caller-supplied authority fields before opening SQLite', async (t) => {
  const value = await fixture(t);
  let opened = 0;
  const runner = createLocalModelPriceCatalogCommandRunner({
    async openDatabase() {
      opened += 1;
      throw new Error('must not open');
    },
    authenticate: establishAuthenticatedLocalCommand,
    now: Date.now,
  });
  const request = {
    ...baseRequest('widened', '44000000-0000-4000-8000-000000000001'),
    priceRevision: null,
    principal: { subject: { type: 'user', id: 'attacker' } },
  };
  await assert.rejects(
    runner.run(commandFile(value, 'model-price.inspect', request, 'widened')),
    { code: 'LOCAL_MODEL_PRICE_CATALOG_COMMAND_CONFIGURATION_INVALID' },
  );
  assert.equal(opened, 0);
});

test('audits invalid credentials with exact low-sensitive replay', async (t) => {
  const value = await fixture(t);
  fs.writeFileSync(
    value.credentialFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-identity-credential-presentation',
      token: formatApiCredentialToken(
        CREDENTIAL_ID,
        Buffer.alloc(32, 99).toString('base64url'),
      ),
    })}\n`,
    { mode: 0o600 },
  );
  const inspectFile = commandFile(
    value,
    'model-price.inspect',
    {
      ...baseRequest('bad-credential', '45000000-0000-4000-8000-000000000001'),
      priceRevision: null,
    },
    'bad-credential',
  );
  await assert.rejects(runLocalModelPriceCatalogCommandFile(inspectFile), {
    code: 'AUTHENTICATED_LOCAL_COMMAND_AUTHENTICATION_FAILED',
  });
  await assert.rejects(runLocalModelPriceCatalogCommandFile(inspectFile), {
    code: 'AUTHENTICATED_LOCAL_COMMAND_AUTHENTICATION_FAILED',
  });

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    const audits = database
      .prepare(
        `SELECT outcome, reasons_json AS reasons
           FROM "QingLong3SecurityAuditEvents"
          WHERE event_id = ?`,
      )
      .all('45000000-0000-4000-8000-000000000001')
      .map((row) => ({ ...row }));
    assert.deepEqual(audits, [
      {
        outcome: 'authentication_rejected',
        reasons: '["credential_rejected"]',
      },
    ]);
  } finally {
    database.close();
  }
});

test('transaction fence blocks credential revocation after precheck', async (t) => {
  const value = await fixture(t);
  const runner = createLocalModelPriceCatalogCommandRunner({
    openDatabase: openLocalSqlitePluginPackageManagementDatabase,
    async authenticate(...args) {
      const authenticated = await establishAuthenticatedLocalCommand(...args);
      let revoked = false;
      return {
        ...authenticated,
        async confirm() {
          await authenticated.confirm();
          if (!revoked) {
            revoked = true;
            const database = new DatabaseSync(value.databasePath);
            try {
              database
                .prepare(
                  `UPDATE "QingLong3ApiCredentials"
                      SET state = 'revoked'
                    WHERE credential_id = ? AND version = 1`,
                )
                .run(CREDENTIAL_ID);
            } finally {
              database.close();
            }
          }
        },
      };
    },
    now: Date.now,
  });
  await assert.rejects(
    runner.run(
      commandFile(
        value,
        'model-price.publish',
        {
          ...mutationRequest(
            'revocation-race',
            '46000000-0000-4000-8000-000000000001',
          ),
          priceRevision: REVISION,
          currency: 'USD',
          inputMicrosPerMillionTokens: 150_000,
          outputMicrosPerMillionTokens: 600_000,
        },
        'revocation-race',
      ),
    ),
    { code: 'MODEL_PRICE_CATALOG_UNAVAILABLE' },
  );

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT
               (SELECT count(*) FROM "ModelPriceCatalogPublications") AS publications,
               (SELECT count(*) FROM "ModelPriceCatalogAuthorizations") AS authorizations`,
          )
          .get(),
      },
      { publications: 0, authorizations: 0 },
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT outcome, reasons_json AS reasons
               FROM "QingLong3SecurityAuditEvents"
              WHERE event_id = ?`,
          )
          .get('46000000-0000-4000-8000-000000000001'),
      },
      {
        outcome: 'denied',
        reasons: '["credential_fence_rejected"]',
      },
    );
  } finally {
    database.close();
  }
});

test('transaction fence requires the current default Project Owner', async (t) => {
  const value = await fixture(t, { owner: false });
  await assert.rejects(
    runLocalModelPriceCatalogCommandFile(
      commandFile(
        value,
        'model-price.publish',
        {
          ...mutationRequest(
            'not-owner',
            '47000000-0000-4000-8000-000000000001',
          ),
          priceRevision: REVISION,
          currency: 'USD',
          inputMicrosPerMillionTokens: 150_000,
          outputMicrosPerMillionTokens: 600_000,
        },
        'not-owner',
      ),
    ),
    { code: 'MODEL_PRICE_CATALOG_UNAVAILABLE' },
  );
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
             FROM "ModelPriceCatalogPublications"`,
        )
        .get().count,
      0,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT outcome, reasons_json AS reasons
               FROM "QingLong3SecurityAuditEvents"
              WHERE event_id = ?`,
          )
          .get('47000000-0000-4000-8000-000000000001'),
      },
      {
        outcome: 'denied',
        reasons: '["platform_owner_required"]',
      },
    );
  } finally {
    database.close();
  }
});

test('audits an expired management principal before catalog mutation', async (t) => {
  const value = await fixture(t);
  const now = Date.now();
  const runner = createLocalModelPriceCatalogCommandRunner({
    openDatabase: openLocalSqlitePluginPackageManagementDatabase,
    async authenticate() {
      return {
        principal: {
          subject: { type: 'user', id: 'owner-user' },
          authenticationId: 'local_model_price:expired-proof',
          authenticatedAtMs: now - 10 * 60 * 1_000,
          expiresAtMs: now - 1,
          assurance: 'local_console',
        },
        databaseFence: {},
        async confirm() {},
      };
    },
    now: () => now,
  });
  await assert.rejects(
    runner.run(
      commandFile(
        value,
        'model-price.publish',
        {
          ...mutationRequest(
            'expired-principal',
            '48000000-0000-4000-8000-000000000001',
          ),
          priceRevision: REVISION,
          currency: 'USD',
          inputMicrosPerMillionTokens: 150_000,
          outputMicrosPerMillionTokens: 600_000,
        },
        'expired-principal',
      ),
    ),
    { code: 'MODEL_PRICE_CATALOG_MANAGEMENT_AUTHENTICATION_REQUIRED' },
  );
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
             FROM "ModelPriceCatalogPublications"`,
        )
        .get().count,
      0,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT outcome, reasons_json AS reasons
               FROM "QingLong3SecurityAuditEvents"
              WHERE event_id = ?`,
          )
          .get('48000000-0000-4000-8000-000000000001'),
      },
      {
        outcome: 'denied',
        reasons: '["strong_authentication_required"]',
      },
    );
  } finally {
    database.close();
  }
});
