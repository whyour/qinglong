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
  createLocalAiFeatureCommandRunner,
  runLocalAiFeatureCommandFile,
} = require('@qinglong/local-owner-cli/ai-feature-command');
const {
  establishAuthenticatedLocalCommand,
} = require('@qinglong/local-owner-console/authenticated-command');
const {
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console');
const {
  openLocalSqliteAuthenticatedManagementDatabase,
} = require('@qinglong/local-sqlite/authenticated-management');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');

const CREDENTIAL_ID = 'ai-feature-owner';
const PEPPER_KEY_ID = 'ai-feature-owner-v1';
const PEPPER = Buffer.alloc(32, 91).toString('base64url');
const SECRET = Buffer.alloc(32, 92).toString('base64url');
const TOKEN = formatApiCredentialToken(CREDENTIAL_ID, SECRET);

async function fixture(t) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-ai-feature-command-'),
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

  const summary = provisionLocalOwnerPepperKey({
    keyringDirectory: ownerPepperKeyringDirectory,
    pepperKeyId: PEPPER_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 91),
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
        'c'.repeat(64),
        '51000000-0000-4000-8000-000000000001',
        '51000000-0000-4000-8000-000000000002',
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
        '51000000-0000-4000-8000-000000000002',
        PEPPER_KEY_ID,
        summary.digest,
        'c'.repeat(64),
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
    database
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           "project_id", "subject_type", "subject_id", "version", "state",
           "role", "mutation_id", "changed_by_type", "changed_by_id",
           "created_at_ms"
         ) VALUES (
           'default', 'user', 'owner-user', 1, 'active', 'owner',
           'ai-feature-owner-binding', 'user', 'owner-user', ?
         )`,
      )
      .run(now - 500);
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

function inspectRequest(suffix) {
  return {
    requestId: `ai-feature-inspect-${suffix}`,
    failureAuditEventId: `52000000-0000-4000-8000-00000000000${suffix}`,
  };
}

function assertNoSensitiveMaterial(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(SECRET), false);
  assert.doesNotMatch(serialized, /authenticationId|principal|subjectId/);
}

test('runs explicit inspect, activate, replay and non-destructive deactivate', async (t) => {
  const value = await fixture(t);
  const inspectFile = commandFile(
    value,
    'ai-feature.inspect',
    inspectRequest('1'),
    '01-inspect',
  );
  const before = await runLocalAiFeatureCommandFile(inspectFile);
  assert.equal(before.schemaState, 'absent');
  assert.equal(before.activation, null);
  assert.equal(before.runtimeAction, 'none');
  assert.equal(
    before.migrationPlanDigest,
    LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
  );
  assertNoSensitiveMaterial(before);

  const activateFile = commandFile(
    value,
    'ai-feature.activate',
    {
      requestId: 'ai-feature-activate-1',
      failureAuditEventId: '52000000-0000-4000-8000-000000000002',
      mutationId: 'ai-feature-activation-1',
      expectedGeneration: 0,
      expectedState: null,
      expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
      safety: {
        mode: 'fresh_database',
        backupEvidenceDigest: null,
      },
    },
    '02-activate',
  );
  const activated = await runLocalAiFeatureCommandFile(activateFile);
  assert.equal(activated.status, 'created');
  assert.equal(activated.schemaState, 'ready');
  assert.equal(activated.runtimeAction, 'restart_required');
  assert.deepEqual(
    {
      generation: activated.activation.generation,
      state: activated.activation.state,
    },
    { generation: 1, state: 'active' },
  );
  assertNoSensitiveMaterial(activated);

  const replayed = await runLocalAiFeatureCommandFile(activateFile);
  assert.equal(replayed.status, 'existing');
  assert.deepEqual(replayed.activation, activated.activation);
  assert.equal(replayed.runtimeAction, 'restart_required');

  const child = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/ai-management/aiFeatureCli.js'),
      'run',
      '--command-file',
      inspectFile,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.equal(JSON.parse(child.stdout).activation.state, 'active');
  assert.equal(child.stdout.includes(TOKEN), false);

  const deactivateFile = commandFile(
    value,
    'ai-feature.deactivate',
    {
      requestId: 'ai-feature-deactivate-1',
      failureAuditEventId: '52000000-0000-4000-8000-000000000003',
      mutationId: 'ai-feature-deactivation-1',
      expectedGeneration: 1,
      expectedState: 'active',
      expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
      safety: {
        mode: 'preserve_existing',
        backupEvidenceDigest: null,
      },
    },
    '03-deactivate',
  );
  const deactivated = await runLocalAiFeatureCommandFile(deactivateFile);
  assert.equal(deactivated.status, 'created');
  assert.deepEqual(
    {
      generation: deactivated.activation.generation,
      state: deactivated.activation.state,
    },
    { generation: 2, state: 'inactive' },
  );
  assert.equal(deactivated.runtimeAction, 'restart_required');

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT
               (SELECT count(*) FROM "ModelInvocationFeatureTransitions") AS transitions,
               (SELECT count(*) FROM "ModelInvocationFeatureHead") AS heads,
               (SELECT count(*) FROM "ModelInvocationStarts") AS starts,
               (SELECT count(*) FROM "ModelPriceCatalogPublications") AS publications`,
          )
          .get(),
      },
      { transitions: 2, heads: 1, starts: 0, publications: 0 },
    );
  } finally {
    database.close();
  }
});

test('requires the reviewed migration digest and rejects widened command before SQLite', async (t) => {
  const value = await fixture(t);
  let opened = 0;
  const runner = createLocalAiFeatureCommandRunner({
    async openDatabase() {
      opened += 1;
      throw new Error('must not open');
    },
    authenticate: establishAuthenticatedLocalCommand,
    migrate: migrateLocalModelInvocationFeature,
    now: Date.now,
  });
  await assert.rejects(
    runner.run(
      commandFile(
        value,
        'ai-feature.inspect',
        {
          ...inspectRequest('4'),
          principal: { subject: { type: 'user', id: 'attacker' } },
        },
        'widened',
      ),
    ),
    { code: 'LOCAL_AI_FEATURE_COMMAND_CONFIGURATION_INVALID' },
  );
  assert.equal(opened, 0);

  await assert.rejects(
    runLocalAiFeatureCommandFile(
      commandFile(
        value,
        'ai-feature.activate',
        {
          requestId: 'ai-feature-plan-drift',
          failureAuditEventId: '52000000-0000-4000-8000-000000000005',
          mutationId: 'ai-feature-plan-drift',
          expectedGeneration: 0,
          expectedState: null,
          expectedMigrationDigest: 'f'.repeat(64),
          safety: {
            mode: 'fresh_database',
            backupEvidenceDigest: null,
          },
        },
        'plan-drift',
      ),
    ),
    { code: 'LOCAL_MODEL_INVOCATION_FEATURE_TRANSITION_CONFLICT' },
  );
});

test('deactivation refuses an in-flight invocation and preserves active state', async (t) => {
  const value = await fixture(t);
  await runLocalAiFeatureCommandFile(
    commandFile(
      value,
      'ai-feature.activate',
      {
        requestId: 'ai-feature-in-flight-activate',
        failureAuditEventId: '52000000-0000-4000-8000-000000000008',
        mutationId: 'ai-feature-in-flight-activate',
        expectedGeneration: 0,
        expectedState: null,
        expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
        safety: {
          mode: 'fresh_database',
          backupEvidenceDigest: null,
        },
      },
      'in-flight-activate',
    ),
  );

  const managementDatabase =
    await openLocalSqliteAuthenticatedManagementDatabase({
      databasePath: value.databasePath,
      profile: 'edge',
    });
  const database = managementDatabase.authority.client;
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    const start = {
      schema: 'qinglong/model-invocation-start@v1',
      invocationId: 'in-flight-invocation',
      projectId: 'default',
      runId: 'in-flight-run',
      stepRunId: 'in-flight-step',
      traceId: 'in-flight-trace',
      provider: 'test-provider',
      model: 'test-model',
      policyRevision: 'test-policy',
      requestDigest: `sha256:${'a'.repeat(64)}`,
      inputBytes: 1,
      maxOutputTokens: 1,
      deadlineAtMs: 2,
      admittedAtMs: 1,
      stepRunMutationId: 'in-flight-mutation',
      stepRunMutationDigest: 'b'.repeat(64),
      runEventId: 'in-flight-event',
      startDigest: 'c'.repeat(64),
    };
    database
      .prepare(
        `INSERT INTO "ModelInvocationStarts" (
           invocation_id, project_id, run_id, step_run_id, trace_id,
           provider, model, policy_revision, request_digest, input_bytes,
           max_output_tokens, deadline_at_ms, admitted_at_ms, mutation_id,
           mutation_digest, run_event_id, start_digest, record_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        start.invocationId,
        start.projectId,
        start.runId,
        start.stepRunId,
        start.traceId,
        start.provider,
        start.model,
        start.policyRevision,
        start.requestDigest,
        start.inputBytes,
        start.maxOutputTokens,
        start.deadlineAtMs,
        start.admittedAtMs,
        start.stepRunMutationId,
        start.stepRunMutationDigest,
        start.runEventId,
        start.startDigest,
        JSON.stringify(start),
      );
  } catch (error) {
    await managementDatabase.close();
    throw error;
  }

  const runner = createLocalAiFeatureCommandRunner({
    async openDatabase() {
      return managementDatabase;
    },
    authenticate: establishAuthenticatedLocalCommand,
    migrate: migrateLocalModelInvocationFeature,
    now: Date.now,
  });
  await assert.rejects(
    runner.run(
      commandFile(
        value,
        'ai-feature.deactivate',
        {
          requestId: 'ai-feature-in-flight-deactivate',
          failureAuditEventId: '52000000-0000-4000-8000-000000000009',
          mutationId: 'ai-feature-in-flight-deactivate',
          expectedGeneration: 1,
          expectedState: 'active',
          expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
          safety: {
            mode: 'preserve_existing',
            backupEvidenceDigest: null,
          },
        },
        'in-flight-deactivate',
      ),
    ),
    { code: 'LOCAL_AI_FEATURE_IN_FLIGHT_INVOCATION' },
  );

  const inspection = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...inspection
          .prepare(
            `SELECT generation, state
               FROM "ModelInvocationFeatureHead"
              WHERE feature_id = 'model-invocation'`,
          )
          .get(),
      },
      { generation: 1, state: 'active' },
    );
  } finally {
    inspection.close();
  }
});

test('resumes a pre-migrated empty schema only with backup evidence', async (t) => {
  const value = await fixture(t);
  const database = new DatabaseSync(value.databasePath);
  try {
    await migrateLocalModelInvocationFeature(database);
  } finally {
    database.close();
  }
  const result = await runLocalAiFeatureCommandFile(
    commandFile(
      value,
      'ai-feature.activate',
      {
        requestId: 'ai-feature-backup-activate',
        failureAuditEventId: '52000000-0000-4000-8000-000000000006',
        mutationId: 'ai-feature-backup-activate',
        expectedGeneration: 0,
        expectedState: null,
        expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
        safety: {
          mode: 'backup_verified',
          backupEvidenceDigest: 'd'.repeat(64),
        },
      },
      'backup-activate',
    ),
  );
  assert.equal(result.status, 'created');
  assert.equal(result.activation.state, 'active');
});

test('audits transaction-fence revocation and rolls activation back', async (t) => {
  const value = await fixture(t);
  const runner = createLocalAiFeatureCommandRunner({
    openDatabase: openLocalSqliteAuthenticatedManagementDatabase,
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
    migrate: migrateLocalModelInvocationFeature,
    now: Date.now,
  });
  await assert.rejects(
    runner.run(
      commandFile(
        value,
        'ai-feature.activate',
        {
          requestId: 'ai-feature-revocation-race',
          failureAuditEventId: '52000000-0000-4000-8000-000000000007',
          mutationId: 'ai-feature-revocation-race',
          expectedGeneration: 0,
          expectedState: null,
          expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
          safety: {
            mode: 'fresh_database',
            backupEvidenceDigest: null,
          },
        },
        'revocation-race',
      ),
    ),
    { code: 'LOCAL_SQLITE_AUTHENTICATED_MANAGEMENT_FENCE_REJECTED' },
  );

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
             FROM sqlite_schema
            WHERE type = 'table'
              AND name = 'ModelInvocationFeatureTransitions'`,
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
          .get('52000000-0000-4000-8000-000000000007'),
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
