const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  LOCAL_PLUGIN_PACKAGE_PROMPT_ADMISSION_MIGRATION_ID,
  LOCAL_PLUGIN_PACKAGE_PROMPT_FINALIZATION_MIGRATION_ID,
  LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_MIGRATION_ID,
  LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_MIGRATION_ID,
  LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_MIGRATION_ID,
  LOCAL_MODEL_INVOCATION_MIGRATION_ID,
  LOCAL_MODEL_INVOCATION_FEATURE_ACTIVATION_MIGRATION_ID,
  LOCAL_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE,
  LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
  LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
  LOCAL_MODEL_PROVIDER_CREDENTIAL_CATALOG_MIGRATION_ID,
  LOCAL_MODEL_INVOCATION_QUOTA_MIGRATION_ID,
  LOCAL_MODEL_INVOCATION_PRICING_MIGRATION_ID,
  LOCAL_MODEL_INVOCATION_USAGE_MIGRATION_ID,
  LOCAL_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID,
  LOCAL_MODEL_PRICE_CATALOG_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE,
  POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID,
  POSTGRES_MODEL_INVOCATION_SCHEMA,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_CATALOG_MIGRATION_ID,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_MIGRATION_ID,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_IDENTITY_MIGRATION_ID,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_TEST_CONNECTION_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_QUOTA_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_PRICING_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_USAGE_MIGRATION_ID,
  POSTGRES_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID,
  POSTGRES_MODEL_PRICE_CATALOG_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_ADMISSION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_FINALIZATION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_PRODUCT_AUTHORIZATION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_MIGRATION_ID,
  LocalModelInvocationFeatureNotReadyError,
  assertLocalModelInvocationFeatureReady,
  localModelInvocationMigrationDefinition,
  migrateLocalModelInvocationFeature,
  postgresModelInvocationMigrationDefinition,
} = require('@qinglong/ai/model-invocation-migration');

function createMainSqliteContract(client) {
  client.exec(`
    CREATE TABLE "QingLong3SchemaMigrations" (
      migration_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      dialect TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
    CREATE TABLE "Runs" (id TEXT PRIMARY KEY);
    CREATE TABLE "RunEvents" (id TEXT PRIMARY KEY);
    CREATE TABLE "StepRuns" (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      UNIQUE (run_id, id)
    );
    CREATE TABLE "StepRunMutations" (mutation_id TEXT PRIMARY KEY);
  `);
}

function localFeatureTables(client) {
  return client
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND
         (name LIKE 'ModelInvocation%' OR name LIKE 'ModelPriceCatalog%')
       ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
}

test('SQLite AI schema is an explicit independent feature migration', async () => {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  createMainSqliteContract(client);

  assert.deepEqual(localFeatureTables(client), []);
  await migrateLocalModelInvocationFeature(client);
  await migrateLocalModelInvocationFeature(client);
  assert.deepEqual(localFeatureTables(client), [
    'ModelInvocationCompletions',
    'ModelInvocationFeatureHead',
    'ModelInvocationFeatureTransitions',
    'ModelInvocationPriceQuotes',
    'ModelInvocationPriceSettlements',
    'ModelInvocationPromptAdmissions',
    'ModelInvocationPromptFinalizations',
    'ModelInvocationPromptOutputArtifactTombstones',
    'ModelInvocationPromptOutputArtifacts',
    'ModelInvocationPromptOutputKeyRetirementCompletions',
    'ModelInvocationPromptOutputKeyRetirementPreparations',
    'ModelInvocationProviderCredentialAudits',
    'ModelInvocationProviderCredentialBindings',
    'ModelInvocationProviderCredentialTransitions',
    'ModelInvocationQuotaReservations',
    'ModelInvocationQuotaSettlements',
    'ModelInvocationResolutions',
    'ModelInvocationStarts',
    'ModelInvocationUsageLedger',
    'ModelPriceCatalogAuthorizations',
    'ModelPriceCatalogHeads',
    'ModelPriceCatalogPublications',
  ]);
  const history = client
    .prepare(
      `SELECT migration_id, stream_id, checksum
       FROM "${LOCAL_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE}"
       ORDER BY migration_id`,
    )
    .all();
  assert.deepEqual(
    history.map(({ migration_id, stream_id }) => ({
      migration_id,
      stream_id,
    })),
    [
      {
        migration_id: LOCAL_MODEL_INVOCATION_MIGRATION_ID,
        stream_id: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      },
      {
        migration_id: LOCAL_MODEL_INVOCATION_USAGE_MIGRATION_ID,
        stream_id: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      },
      {
        migration_id: LOCAL_MODEL_INVOCATION_QUOTA_MIGRATION_ID,
        stream_id: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      },
      {
        migration_id: LOCAL_MODEL_INVOCATION_PRICING_MIGRATION_ID,
        stream_id: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      },
      {
        migration_id: LOCAL_MODEL_PRICE_CATALOG_MIGRATION_ID,
        stream_id: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      },
      {
        migration_id: LOCAL_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID,
        stream_id: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      },
      {
        migration_id: LOCAL_MODEL_INVOCATION_FEATURE_ACTIVATION_MIGRATION_ID,
        stream_id: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      },
      {
        migration_id: LOCAL_PLUGIN_PACKAGE_PROMPT_ADMISSION_MIGRATION_ID,
        stream_id: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      },
      {
        migration_id: LOCAL_PLUGIN_PACKAGE_PROMPT_FINALIZATION_MIGRATION_ID,
        stream_id: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      },
      {
        migration_id: LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_MIGRATION_ID,
        stream_id: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      },
      {
        migration_id: LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_MIGRATION_ID,
        stream_id: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      },
      {
        migration_id:
          LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_MIGRATION_ID,
        stream_id: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      },
      {
        migration_id: LOCAL_MODEL_PROVIDER_CREDENTIAL_CATALOG_MIGRATION_ID,
        stream_id: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      },
    ],
  );
  assert.equal(
    history[0].checksum,
    localModelInvocationMigrationDefinition.migrations[0].checksum,
  );
  assert.equal(
    localModelInvocationMigrationDefinition.migrations[0].checksum,
    '258e3fd9a250d53d7d0574c3c05b3f91c40c53b20a60b68a931babfc58a0451a',
  );
  assert.equal(
    history[1].checksum,
    localModelInvocationMigrationDefinition.migrations[1].checksum,
  );
  assert.equal(
    localModelInvocationMigrationDefinition.migrations[1].checksum,
    '37e5c9bbf3f459ff036a032fc564dfd8cd78325234c9d7916bfff886b1018da5',
  );
  assert.equal(
    history[2].checksum,
    localModelInvocationMigrationDefinition.migrations[2].checksum,
  );
  assert.equal(
    localModelInvocationMigrationDefinition.migrations[2].checksum,
    'fa734aac1a3f5affaf69f4fbe53a2c6ca628255ecdcde14c08b87b49d8162012',
  );
  assert.equal(
    history[3].checksum,
    localModelInvocationMigrationDefinition.migrations[3].checksum,
  );
  assert.equal(
    localModelInvocationMigrationDefinition.migrations[3].checksum,
    '572e37d2f44df43a50b51a07c1b4b0bb87fbb22e9cafbd3421ec7ab250036951',
  );
  assert.equal(
    history[4].checksum,
    localModelInvocationMigrationDefinition.migrations[4].checksum,
  );
  assert.equal(
    localModelInvocationMigrationDefinition.migrations[4].checksum,
    '20d5c288dfab65ac7ea75a96b7302f9d59cd1bfdf06af28f3868261f6e2e3013',
  );
  assert.equal(
    history[5].checksum,
    localModelInvocationMigrationDefinition.migrations[5].checksum,
  );
  assert.equal(
    localModelInvocationMigrationDefinition.migrations[5].checksum,
    '3ee48d1468569c9dc1fa9f04031a48a220161762d48eeac4cd924e2dcd7abd21',
  );
  assert.equal(
    history[6].checksum,
    localModelInvocationMigrationDefinition.migrations[6].checksum,
  );
  assert.equal(
    localModelInvocationMigrationDefinition.migrations[6].checksum,
    '2454987c61a48dc5286a883d755c709000e6fd630025373cb276723001bdcc6c',
  );
  assert.equal(
    history[7].checksum,
    localModelInvocationMigrationDefinition.migrations[7].checksum,
  );
  assert.equal(
    localModelInvocationMigrationDefinition.migrations[7].checksum,
    '7f0b675231a79a5917dab1b7088ac8c393afef448e35309ca2e3a691af45bc79',
  );
  assert.equal(
    history[8].checksum,
    localModelInvocationMigrationDefinition.migrations[8].checksum,
  );
  assert.equal(
    localModelInvocationMigrationDefinition.migrations[8].checksum,
    'bd4c6f9f72a16f7a0e8f6d7afc702c7fe1293e7fc6f60bc31f5604b30bbdd0b6',
  );
  assert.equal(
    history[9].checksum,
    localModelInvocationMigrationDefinition.migrations[9].checksum,
  );
  assert.equal(
    localModelInvocationMigrationDefinition.migrations[9].checksum,
    '79bf3edcccf273046cb8b8ab60a7a0da881efd4e641009fa3c5833013cb7a75b',
  );
  assert.equal(
    history[10].checksum,
    localModelInvocationMigrationDefinition.migrations[10].checksum,
  );
  assert.equal(
    localModelInvocationMigrationDefinition.migrations[10].checksum,
    '4283d738e3eeb99fce30d011fd7d090577aa897581ee83e691ae021eff3f369e',
  );
  assert.equal(
    history[11].checksum,
    localModelInvocationMigrationDefinition.migrations[11].checksum,
  );
  assert.equal(
    localModelInvocationMigrationDefinition.migrations[11].checksum,
    '213d255cc40c536bbdc5fa41691839e0eb8e869db5a53ed93df50295ca8d5fc5',
  );
  assert.equal(
    history[12].checksum,
    localModelInvocationMigrationDefinition.migrations[12].checksum,
  );
  assert.equal(
    localModelInvocationMigrationDefinition.migrations[12].checksum,
    'ca9bcb4370d747884a34fdeae5079fdd7ccdaadd5ba9f66dba2faab09cfa3abb',
  );
  assert.equal(
    LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
    '2720c6e45f82adbb03641d1c19e8ff7e1875a763a0b53d4910a46ca308800aa0',
  );
  assert.deepEqual(
    client
      .prepare(
        `SELECT migration_id FROM "QingLong3SchemaMigrations"
         ORDER BY migration_id`,
      )
      .all(),
    [],
  );
  assert.equal(
    client.prepare('PRAGMA integrity_check').get().integrity_check,
    'ok',
  );
  client.close();
});

test('SQLite AI feature readiness is read-only and rejects partial or drifted schema', async () => {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  createMainSqliteContract(client);

  assert.throws(
    () => assertLocalModelInvocationFeatureReady(client),
    LocalModelInvocationFeatureNotReadyError,
  );
  await migrateLocalModelInvocationFeature(client);
  assert.doesNotThrow(() => assertLocalModelInvocationFeatureReady(client));

  client
    .prepare(
      `UPDATE "${LOCAL_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE}"
          SET checksum = ?
        WHERE migration_id = ?`,
    )
    .run('f'.repeat(64), LOCAL_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID);
  assert.throws(
    () => assertLocalModelInvocationFeatureReady(client),
    LocalModelInvocationFeatureNotReadyError,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count
           FROM "${LOCAL_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE}"`,
      )
      .get().count,
    13,
  );
  client.close();
});

test('SQLite AI migration refuses to create a parallel baseline', async () => {
  const client = new DatabaseSync(':memory:');

  await assert.rejects(
    migrateLocalModelInvocationFeature(client),
    /requires the main SQLite migration stream/,
  );
  assert.deepEqual(localFeatureTables(client), []);
  client.close();
});

test('PostgreSQL AI schema is an independent reviewed feature stream', async () => {
  assert.equal(
    POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID,
    'ql3-ai-model-invocation-postgresql',
  );
  assert.equal(
    POSTGRES_MODEL_INVOCATION_MIGRATION_ID,
    'pg-9001-ai-model-invocations',
  );
  assert.equal(
    POSTGRES_MODEL_INVOCATION_USAGE_MIGRATION_ID,
    'pg-9002-ai-model-usage-ledger',
  );
  assert.equal(
    POSTGRES_MODEL_INVOCATION_QUOTA_MIGRATION_ID,
    'pg-9003-ai-model-usage-quota',
  );
  assert.equal(
    POSTGRES_MODEL_INVOCATION_PRICING_MIGRATION_ID,
    'pg-9004-ai-model-pricing-snapshots',
  );
  assert.equal(
    POSTGRES_MODEL_PRICE_CATALOG_MIGRATION_ID,
    'pg-9005-ai-model-price-catalog',
  );
  assert.equal(
    POSTGRES_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID,
    'pg-9006-ai-model-price-catalog-authorizations',
  );
  assert.equal(
    POSTGRES_PLUGIN_PACKAGE_PROMPT_ADMISSION_MIGRATION_ID,
    'pg-9007-ai-plugin-package-prompt-admissions',
  );
  assert.equal(
    POSTGRES_PLUGIN_PACKAGE_PROMPT_FINALIZATION_MIGRATION_ID,
    'pg-9008-ai-plugin-package-prompt-finalizations',
  );
  assert.equal(
    POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_MIGRATION_ID,
    'pg-9009-ai-plugin-package-prompt-output-artifacts',
  );
  assert.equal(
    POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_MIGRATION_ID,
    'pg-9010-ai-plugin-package-prompt-output-tombstones',
  );
  assert.equal(
    POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_MIGRATION_ID,
    'pg-9011-ai-plugin-package-prompt-output-key-retirements',
  );
  assert.equal(
    POSTGRES_MODEL_PROVIDER_CREDENTIAL_CATALOG_MIGRATION_ID,
    'pg-9012-ai-model-provider-credential-catalog',
  );
  assert.equal(
    POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_MIGRATION_ID,
    'pg-9013-ai-model-provider-credential-management-boundary',
  );
  assert.equal(
    POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_IDENTITY_MIGRATION_ID,
    'pg-9014-ai-model-provider-credential-management-identity-ledger',
  );
  assert.equal(
    POSTGRES_MODEL_PROVIDER_CREDENTIAL_TEST_CONNECTION_MIGRATION_ID,
    'pg-9015-ai-model-provider-credential-test-connection',
  );
  assert.equal(
    POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_MIGRATION_ID,
    'pg-9016-ai-plugin-package-prompt-output-key-rotation',
  );
  assert.equal(
    POSTGRES_PLUGIN_PACKAGE_PROMPT_PRODUCT_AUTHORIZATION_MIGRATION_ID,
    'pg-9017-ai-plugin-package-prompt-product-authorization',
  );
  assert.equal(
    POSTGRES_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE,
    'ai_schema_migrations',
  );
  assert.equal(POSTGRES_MODEL_INVOCATION_SCHEMA, 'ql3_ai');
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrationIdScheme,
    'postgres-prefixed',
  );
  assert.match(
    postgresModelInvocationMigrationDefinition.migrations[0].checksum,
    /^[0-9a-f]{64}$/,
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations[0].checksum,
    '69f72286fba2988ba372f006eb894a7f8b89f4b1acd9da68dc1cdafc3ca96ea7',
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations[1].checksum,
    '95ad6f46163b0bbc2583dddf492f91f767a00554683186f244d3f6a22a2ad00c',
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations[2].checksum,
    '13ea1a904eb799bcae1b474d76b164a70748bdcca8e1e6ded9952921a291a855',
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations[3].checksum,
    'd38b12c2640fdd9fe21dc43a4743fb3480c988fa0a87e210fd81074d87569d2f',
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations[4].checksum,
    '7db1a80fab1aa3dee3a4c4bcae5add53758418504f63f4b7d253b090506d7864',
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations[5].checksum,
    '486d46115e28e90604a47231fe95e3b1687649c063d93bf7ce267783f2a7165f',
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations[6].checksum,
    '1ed94eae2225b26e89e8c5d34e265e143e8150ff1811f5d8ae1fda52a6603db0',
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations[7].checksum,
    '8dfd02e8e4947acb03516795ae37ef7aae5ee52a25b1fe3cd1a8640782c5b235',
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations[8].checksum,
    'cb4156b109694c2b3aaf60a870179da04e10b47dbddfc92db3a7c4a58dfd1c2d',
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations[9].checksum,
    '8972237fa41c80d131c32b380f617e8c7720687980e9accfb08f8fb19b7d8b5f',
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations[10].checksum,
    '843ea53460f6580801cb12428d35c5571fd36bbee64e7801d2c3f98ea39d8392',
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations[11].checksum,
    '4c83f5dda3c922aefd77c58760881f926e63e33628120f2fe6c71a53b30a1248',
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations[12].checksum,
    'c02a4c6b2953cc331580b6287283d33739c30c2e189d011f392c13ecea497224',
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations[13].checksum,
    '02098fad764199bc5a7750483d050be5e5acdbcecd05c0975c3fe4e5be03c782',
  );
  assert.match(
    postgresModelInvocationMigrationDefinition.migrations[14].checksum,
    /^[0-9a-f]{64}$/,
  );
  assert.match(
    postgresModelInvocationMigrationDefinition.migrations[16].checksum,
    /^[0-9a-f]{64}$/,
  );
  assert.equal(
    postgresModelInvocationMigrationDefinition.migrations.length,
    17,
  );

  const retirementStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[10].up({
    async query(statement) {
      retirementStatements.push(statement);
      return { rows: [] };
    },
  });
  const retirementSql = retirementStatements.join('\n');
  assert.match(
    retirementSql,
    /CREATE TABLE "ql3_ai"\."model_invocation_prompt_output_key_retirement_preparations"/,
  );
  assert.match(
    retirementSql,
    /CREATE TABLE "ql3_ai"\."model_invocation_prompt_output_key_retirement_completions"/,
  );
  assert.match(retirementSql, /TO ql3_runtime/);
  assert.match(retirementSql, /TO ql3_ai_maintenance/);

  const credentialStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[11].up({
    async query(statement) {
      credentialStatements.push(statement);
      return { rows: [] };
    },
  });
  const credentialSql = credentialStatements.join('\n');
  assert.match(
    credentialSql,
    /CREATE TABLE "ql3_ai"\."model_provider_credential_bindings"/,
  );
  assert.match(
    credentialSql,
    /CREATE TABLE "ql3_ai"\."model_provider_credential_transitions"/,
  );
  assert.match(
    credentialSql,
    /CREATE TABLE "ql3_ai"\."model_provider_credential_audits"/,
  );
  assert.match(credentialSql, /TO ql3_runtime/);
  assert.match(credentialSql, /TO ql3_ai_maintenance/);

  const credentialManagementStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[12].up({
    async query(statement) {
      credentialManagementStatements.push(statement);
      return { rows: [] };
    },
  });
  const credentialManagementSql = credentialManagementStatements.join('\n');
  assert.match(
    credentialManagementSql,
    /GRANT CONNECT ON DATABASE %I TO ql3_ai_credential_manager/,
  );
  assert.match(
    credentialManagementSql,
    /GRANT SELECT ON TABLE[\s\S]*"ql3"\."projects"[\s\S]*"ql3"\."project_role_bindings"[\s\S]*"ql3"\."security_audit_events"[\s\S]*TO ql3_ai_credential_manager/,
  );
  assert.match(
    credentialManagementSql,
    /GRANT INSERT ON TABLE "ql3"\."security_audit_events"[\s\S]*TO ql3_ai_credential_manager/,
  );
  assert.match(
    credentialManagementSql,
    /GRANT INSERT ON TABLE[\s\S]*model_provider_credential_bindings[\s\S]*model_provider_credential_transitions[\s\S]*TO ql3_ai_credential_manager/,
  );
  assert.doesNotMatch(
    credentialManagementSql,
    /GRANT[^;]*(?:model_invocation_prompt_output|ql3_ai_maintenance)/,
  );
  assert.match(
    credentialManagementSql,
    /REVOKE ALL ON TABLE[\s\S]*model_provider_credential_bindings[\s\S]*model_provider_credential_transitions[\s\S]*model_provider_credential_audits[\s\S]*FROM ql3_ai_maintenance/,
  );

  const credentialIdentityStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[13].up({
    async query(statement) {
      credentialIdentityStatements.push(statement);
      return { rows: [] };
    },
  });
  const credentialIdentitySql = credentialIdentityStatements.join('\n');
  assert.match(
    credentialIdentitySql,
    /CREATE TABLE "ql3_ai"\."model_provider_credential_management_identity_keyset_ledger"/,
  );
  assert.match(
    credentialIdentitySql,
    /GRANT SELECT, INSERT, UPDATE[\s\S]*TO ql3_ai_credential_manager/,
  );
  assert.match(credentialIdentitySql, /FROM PUBLIC, ql3_ai_maintenance/);
  assert.doesNotMatch(credentialIdentitySql, /GRANT[^;]*DELETE/);

  const credentialTestStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[14].up({
    async query(statement) {
      credentialTestStatements.push(statement);
      return { rows: [] };
    },
  });
  const credentialTestSql = credentialTestStatements.join('\n');
  for (const table of [
    'model_provider_credential_test_plans',
    'model_provider_credential_test_quota_buckets',
    'model_provider_credential_test_executions',
    'model_provider_credential_test_results',
  ]) {
    assert.match(
      credentialTestSql,
      new RegExp(`CREATE TABLE "ql3_ai"\\."${table}"`),
    );
  }
  assert.match(
    credentialTestSql,
    /GRANT CONNECT ON DATABASE %I TO ql3_ai_credential_tester/,
  );
  assert.match(
    credentialTestSql,
    /GRANT SELECT, INSERT, UPDATE ON TABLE[\s\S]*model_provider_credential_test_quota_buckets[\s\S]*TO ql3_ai_credential_manager/,
  );
  assert.match(
    credentialTestSql,
    /GRANT INSERT ON TABLE[\s\S]*model_provider_credential_test_executions[\s\S]*model_provider_credential_test_results[\s\S]*TO ql3_ai_credential_tester/,
  );
  for (const statement of credentialTestStatements.filter((value) =>
    value.includes('TO ql3_ai_credential_tester'),
  )) {
    assert.doesNotMatch(statement, /GRANT[\s\S]*(?:UPDATE|DELETE)/);
  }

  const rotationStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[15].up({
    async query(statement) {
      rotationStatements.push(statement);
      return { rows: [] };
    },
  });
  const rotationSql = rotationStatements.join('\n');
  assert.match(
    rotationSql,
    /CREATE TABLE "ql3_ai"\."model_invocation_prompt_output_key_rotation_preparations"/,
  );
  assert.match(
    rotationSql,
    /CREATE TABLE "ql3_ai"\."model_invocation_prompt_output_key_rotation_completions"/,
  );
  assert.match(
    rotationSql,
    /UNIQUE \(expected_secret_uid, expected_catalog_digest\)/,
  );
  assert.match(rotationSql, /TO ql3_ai_maintenance/);
  assert.doesNotMatch(rotationSql, /GRANT[^;]*TO ql3_runtime/);
  assert.doesNotMatch(rotationSql, /GRANT[^;]*(?:UPDATE|DELETE)/);

  const productAuthorizationStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[16].up({
    async query(statement) {
      productAuthorizationStatements.push(statement);
      return { rows: [] };
    },
  });
  const productAuthorizationSql = productAuthorizationStatements.join('\n');
  assert.match(
    productAuthorizationSql,
    /CREATE FUNCTION[\s\S]*plugin_package_prompt_authorize_admission/,
  );
  assert.match(productAuthorizationSql, /SECURITY DEFINER/);
  assert.match(productAuthorizationSql, /TO ql3_runtime/);
  assert.doesNotMatch(productAuthorizationSql, /GRANT[^;]*TO ql3_admin/);

  const statements = [];
  await postgresModelInvocationMigrationDefinition.migrations[0].up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(sql, /CREATE TABLE "ql3_ai"\."model_invocation_starts"/);
  assert.match(sql, /CREATE TABLE "ql3_ai"\."model_invocation_completions"/);
  assert.match(sql, /CREATE TABLE "ql3_ai"\."model_invocation_resolutions"/);
  assert.match(
    sql,
    /FOREIGN KEY \(mutation_id\)[\s\S]*"ql3"\."step_run_mutations"/,
  );
  assert.match(sql, /FOREIGN KEY \(run_event_id\)[\s\S]*"ql3"\."run_events"/);
  assert.match(
    sql,
    /REVOKE ALL ON TABLE[\s\S]*model_invocation_starts[\s\S]*FROM PUBLIC/,
  );
  assert.match(
    sql,
    /GRANT SELECT, INSERT ON TABLE[\s\S]*model_invocation_resolutions[\s\S]*TO ql3_runtime/,
  );
  assert.doesNotMatch(sql, /model_invocation_(?:starts|completions)_step_uidx/);
  assert.match(sql, /model_invocation_starts_step_history_idx/);
  assert.match(sql, /model_invocation_completions_step_history_idx/);
  assert.doesNotMatch(sql, /TO ql3_admin/);
  assert.doesNotMatch(sql, /TO ql3_worker_ingress/);

  const usageStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[1].up({
    async query(statement) {
      usageStatements.push(statement);
      return { rows: [] };
    },
  });
  const usageSql = usageStatements.join('\n');
  assert.match(
    usageSql,
    /CREATE TABLE "ql3_ai"\."model_invocation_usage_ledger"/,
  );
  assert.match(
    usageSql,
    /FOREIGN KEY \(invocation_id, completion_digest\)[\s\S]*model_invocation_completions/,
  );
  assert.match(
    usageSql,
    /GRANT SELECT, INSERT ON TABLE[\s\S]*model_invocation_usage_ledger[\s\S]*TO ql3_runtime/,
  );
  assert.deepEqual(
    usageStatements.filter((statement) => statement.startsWith('GRANT ')),
    [
      `GRANT SELECT, INSERT ON TABLE
       "ql3_ai"."model_invocation_usage_ledger"
     TO ql3_runtime`,
    ],
  );
  assert.doesNotMatch(usageSql, /TO ql3_admin|TO ql3_worker_ingress/);

  const quotaStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[2].up({
    async query(statement) {
      quotaStatements.push(statement);
      return { rows: [] };
    },
  });
  const quotaSql = quotaStatements.join('\n');
  assert.match(
    quotaSql,
    /CREATE TABLE "ql3_ai"\."model_invocation_quota_reservations"/,
  );
  assert.match(
    quotaSql,
    /CREATE TABLE "ql3_ai"\."model_invocation_quota_settlements"/,
  );
  assert.match(
    quotaSql,
    /GRANT SELECT, INSERT ON TABLE[\s\S]*model_invocation_quota_reservations[\s\S]*model_invocation_quota_settlements[\s\S]*TO ql3_runtime/,
  );
  assert.deepEqual(
    quotaStatements.filter((statement) =>
      /^(?:UPDATE|DELETE)\b/.test(statement),
    ),
    [],
  );
  assert.doesNotMatch(quotaSql, /TO ql3_admin|TO ql3_worker_ingress/);

  const pricingStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[3].up({
    async query(statement) {
      pricingStatements.push(statement);
      return { rows: [] };
    },
  });
  const pricingSql = pricingStatements.join('\n');
  assert.match(
    pricingSql,
    /CREATE TABLE "ql3_ai"\."model_invocation_price_quotes"/,
  );
  assert.match(
    pricingSql,
    /CREATE TABLE "ql3_ai"\."model_invocation_price_settlements"/,
  );
  assert.match(
    pricingSql,
    /FOREIGN KEY \(invocation_id, quote_digest\)[\s\S]*model_invocation_price_quotes/,
  );
  assert.match(
    pricingSql,
    /GRANT SELECT, INSERT ON TABLE[\s\S]*model_invocation_price_quotes[\s\S]*model_invocation_price_settlements[\s\S]*TO ql3_runtime/,
  );
  assert.deepEqual(
    pricingStatements.filter((statement) =>
      /^(?:UPDATE|DELETE)\b/.test(statement),
    ),
    [],
  );
  assert.doesNotMatch(pricingSql, /TO ql3_admin|TO ql3_worker_ingress/);

  const catalogStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[4].up({
    async query(statement) {
      catalogStatements.push(statement);
      return { rows: [] };
    },
  });
  const catalogSql = catalogStatements.join('\n');
  assert.match(
    catalogSql,
    /CREATE TABLE "ql3_ai"\."model_price_catalog_publications"/,
  );
  assert.match(
    catalogSql,
    /CREATE TABLE "ql3_ai"\."model_price_catalog_heads"/,
  );
  assert.match(
    catalogSql,
    /GRANT SELECT ON TABLE[\s\S]*model_price_catalog_publications[\s\S]*model_price_catalog_heads[\s\S]*TO ql3_runtime/,
  );
  assert.match(
    catalogSql,
    /GRANT SELECT, INSERT ON TABLE[\s\S]*model_price_catalog_publications[\s\S]*model_price_catalog_heads[\s\S]*TO ql3_admin/,
  );
  assert.doesNotMatch(
    catalogSql,
    /GRANT SELECT, INSERT ON TABLE[\s\S]*TO ql3_runtime/,
  );
  assert.doesNotMatch(
    catalogSql,
    /TO ql3_package_manager|TO ql3_package_executor|TO ql3_worker_ingress/,
  );
  assert.deepEqual(
    catalogStatements.filter((statement) =>
      /^(?:UPDATE|DELETE)\b/.test(statement),
    ),
    [],
  );

  const authorizationStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[5].up({
    async query(statement) {
      authorizationStatements.push(statement);
      return { rows: [] };
    },
  });
  const authorizationSql = authorizationStatements.join('\n');
  assert.match(
    authorizationSql,
    /CREATE TABLE "ql3_ai"\."model_price_catalog_authorizations"/,
  );
  assert.match(
    authorizationSql,
    /FOREIGN KEY \(publication_digest\)[\s\S]*model_price_catalog_publications/,
  );
  assert.match(
    authorizationSql,
    /FOREIGN KEY \(head_digest\)[\s\S]*model_price_catalog_heads/,
  );
  assert.match(
    authorizationSql,
    /GRANT SELECT, INSERT ON TABLE[\s\S]*model_price_catalog_authorizations[\s\S]*TO ql3_admin/,
  );
  assert.doesNotMatch(authorizationSql, /TO ql3_runtime/);
  assert.deepEqual(
    authorizationStatements.filter((statement) =>
      /^(?:UPDATE|DELETE)\b/.test(statement),
    ),
    [],
  );

  const promptAdmissionStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[6].up({
    async query(statement) {
      promptAdmissionStatements.push(statement);
      return { rows: [] };
    },
  });
  const promptAdmissionSql = promptAdmissionStatements.join('\n');
  assert.match(
    promptAdmissionSql,
    /CREATE TABLE "ql3_ai"\."model_invocation_prompt_admissions"/,
  );
  assert.match(
    promptAdmissionSql,
    /REFERENCES "ql3"\."plugin_package_automation_publications"/,
  );
  assert.match(
    promptAdmissionSql,
    /GRANT SELECT, INSERT ON TABLE[\s\S]*model_invocation_prompt_admissions[\s\S]*TO ql3_runtime/,
  );
  assert.match(
    promptAdmissionSql,
    /CREATE FUNCTION[\s\S]*"ql3_ai"\."plugin_package_prompt_admission_snapshot"/,
  );
  assert.match(promptAdmissionSql, /plugin_package_automation_start_allowed/);
  assert.match(
    promptAdmissionSql,
    /GRANT EXECUTE ON FUNCTION[\s\S]*plugin_package_prompt_admission_snapshot[\s\S]*TO ql3_runtime/,
  );
  assert.doesNotMatch(
    promptAdmissionSql,
    /TO ql3_admin|TO ql3_package_manager|TO ql3_worker_ingress/,
  );

  const promptFinalizationStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[7].up({
    async query(statement) {
      promptFinalizationStatements.push(statement);
      return { rows: [] };
    },
  });
  const promptFinalizationSql = promptFinalizationStatements.join('\n');
  assert.match(
    promptFinalizationSql,
    /CREATE TABLE "ql3_ai"\."model_invocation_prompt_finalizations"/,
  );
  assert.match(
    promptFinalizationSql,
    /FOREIGN KEY \(event_id\)[\s\S]*REFERENCES "ql3"\."run_events"/,
  );
  assert.match(
    promptFinalizationSql,
    /GRANT SELECT, INSERT ON TABLE[\s\S]*model_invocation_prompt_finalizations[\s\S]*TO ql3_runtime/,
  );
  assert.doesNotMatch(
    `${promptAdmissionSql}\n${promptFinalizationSql}`,
    /GRANT (?:UPDATE|DELETE)|TO ql3_admin|TO ql3_worker_ingress/,
  );

  const promptOutputArtifactStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[8].up({
    async query(statement) {
      promptOutputArtifactStatements.push(statement);
      return { rows: [] };
    },
  });
  const promptOutputArtifactSql = promptOutputArtifactStatements.join('\n');
  assert.match(
    promptOutputArtifactSql,
    /CREATE TABLE "ql3_ai"\."model_invocation_prompt_output_artifacts"/,
  );
  assert.match(
    promptOutputArtifactSql,
    /FOREIGN KEY \(invocation_id\)[\s\S]*model_invocation_prompt_admissions/,
  );
  assert.match(
    promptOutputArtifactSql,
    /FOREIGN KEY \(invocation_id\)[\s\S]*model_invocation_starts/,
  );
  assert.match(
    promptOutputArtifactSql,
    /GRANT SELECT, INSERT ON TABLE[\s\S]*model_invocation_prompt_output_artifacts[\s\S]*TO ql3_runtime/,
  );
  assert.doesNotMatch(
    promptOutputArtifactSql,
    /GRANT (?:UPDATE|DELETE)|TO ql3_admin|TO ql3_package_manager|TO ql3_package_executor|TO ql3_worker_ingress/,
  );

  const promptOutputTombstoneStatements = [];
  await postgresModelInvocationMigrationDefinition.migrations[9].up({
    async query(statement) {
      promptOutputTombstoneStatements.push(statement);
      return { rows: [] };
    },
  });
  const promptOutputTombstoneSql = promptOutputTombstoneStatements.join('\n');
  assert.match(
    promptOutputTombstoneSql,
    /CREATE TABLE "ql3_ai"\."model_invocation_prompt_output_artifact_tombstones"/,
  );
  assert.match(
    promptOutputTombstoneSql,
    /GRANT CONNECT ON DATABASE %I TO ql3_ai_maintenance/,
  );
  assert.match(
    promptOutputTombstoneSql,
    /FOREIGN KEY \(invocation_id\)[\s\S]*model_invocation_prompt_admissions/,
  );
  assert.match(
    promptOutputTombstoneSql,
    /GRANT SELECT ON TABLE[\s\S]*model_invocation_prompt_output_artifact_tombstones[\s\S]*TO ql3_runtime/,
  );
  assert.match(
    promptOutputTombstoneSql,
    /GRANT SELECT, DELETE ON TABLE[\s\S]*model_invocation_prompt_output_artifacts[\s\S]*TO ql3_ai_maintenance/,
  );
  assert.match(
    promptOutputTombstoneSql,
    /GRANT SELECT, INSERT ON TABLE[\s\S]*model_invocation_prompt_output_artifact_tombstones[\s\S]*TO ql3_ai_maintenance/,
  );
  assert.doesNotMatch(
    promptOutputTombstoneSql,
    /GRANT (?:UPDATE|DELETE)[\s\S]*model_invocation_prompt_output_artifact_tombstones|TO ql3_admin|TO ql3_package_manager|TO ql3_package_executor|TO ql3_worker_ingress/,
  );
});
