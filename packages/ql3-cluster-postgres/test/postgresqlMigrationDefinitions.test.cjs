const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  postgresqlControlSchemaContract,
} = require('../dist/schema/schemaContract');
const {
  postgresqlMainMigrationManifest,
} = require('../dist/migration/migrationManifest');
const { postgresqlMainMigrationStream } = require('../dist/migrations');

const BANNED_CLUSTER_SCHEMA_NAMES = [
  'crontabs',
  'envs',
  'subscriptions',
  'runninginstances',
  'completionreceiptjournals',
  'localexecutioncontextrecipes',
  'localsecretenvelopes',
  'localartifactretentioncheckpoints',
  'projectownerbootstrapchallenges',
  'legacypanelidentitybindings',
];

function tableDefinitionSql(statements, tableName) {
  const qualifiedName = `"ql3"."${tableName}"`;
  return statements
    .filter(
      (statement) =>
        statement.includes(qualifiedName) &&
        (/^CREATE TABLE /.test(statement) || /^ALTER TABLE /.test(statement)),
    )
    .join('\n');
}

function migrationById(id) {
  const migration = postgresqlMainMigrationStream.migrations.find(
    (candidate) => candidate.id === id,
  );
  assert.ok(migration, `missing migration ${id}`);
  return migration;
}

test('defines the immutable PostgreSQL capability and Run core stream', async () => {
  assert.equal(postgresqlMainMigrationStream.id, 'postgresql-main');
  assert.equal(postgresqlMainMigrationStream.dialect, 'postgresql');
  assert.equal(
    postgresqlMainMigrationStream.migrationIdScheme,
    'postgres-prefixed',
  );
  assert.equal(postgresqlMainMigrationStream.checksumScheme, 'sha256');
  assert.deepEqual(
    postgresqlMainMigrationStream.migrations.map(({ id }) => id),
    [
      'pg-0001-schema-capability',
      'pg-0002-run-core',
      'pg-0003-run-retry-policy',
      'pg-0004-project-policy',
      'pg-0005-api-credential-security-audit',
      'pg-0006-identity-credential-administration',
      'pg-0007-cluster-recovery-indexes',
      'pg-0008-run-recovery-claims',
      'pg-0009-worker-session-run-lease',
      'pg-0010-worker-ingress-attestation',
      'pg-0011-api-credential-pepper-binding',
      'pg-0012-task-trigger-definitions',
      'pg-0013-task-execution-revisions',
      'pg-0014-cluster-scheduler-admission',
      'pg-0015-worker-credential-delivery-ledger',
      'pg-0016-worker-credential-stage-discard-ledger',
      'pg-0017-database-role-grants',
      'pg-0018-plugin-package-installs',
      'pg-0019-approved-actions',
      'pg-0020-plugin-package-admission-receipts',
      'pg-0021-approved-action-executions-and-package-proposals',
      'pg-0022-plugin-package-authority-split',
      'pg-0023-plugin-package-management-quota',
      'pg-0024-plugin-package-identity-keyset-ledger',
      'pg-0025-plugin-package-materialized-revisions',
      'pg-0026-plugin-package-task-reconciliations',
      'pg-0027-project-tool-definition-snapshots',
      'pg-0028-step-runs',
      'pg-0029-tool-execution-evidence',
      'pg-0030-tool-execution-start-barriers',
      'pg-0031-tool-invocation-artifacts',
      'pg-0032-tool-execution-artifact-bindings',
      'pg-0033-tool-execution-completions',
      'pg-0034-tool-execution-failure-completions',
      'pg-0035-tool-result-key-catalog',
      'pg-0036-tool-result-rekey-overlays',
      'pg-0037-plugin-package-quarantine',
      'pg-0038-plugin-package-publisher-provenance',
      'pg-0039-plugin-package-publisher-trust-authority',
      'pg-0040-plugin-package-publisher-trust-transitions',
      'pg-0041-plugin-package-lifecycle',
      'pg-0042-plugin-package-lifecycle-plans',
      'pg-0043-plugin-package-automation-publications',
      'pg-0044-plugin-package-automation-start-guard',
      'pg-0045-plugin-package-workflow-admissions',
      'pg-0046-plugin-package-workflow-task-attempt-admissions',
      'pg-0047-worker-credential-management-plans',
      'pg-0048-worker-credential-preapproved-activation',
      'pg-0049-worker-credential-execution-receipts',
      'pg-0050-worker-credential-management-boundary',
      'pg-0051-automation-management-boundary',
      'pg-0052-automation-management-identity-keyset-ledger',
      'pg-0053-plugin-package-workflow-run-list-index',
      'pg-0054-approval-management-boundary',
      'pg-0055-run-attempt-log-retention',
      'pg-0056-run-management-boundary',
      'pg-0057-run-management-stop-boundary',
      'pg-0058-plugin-package-automation-disposition-events',
      'pg-0059-plugin-package-secret-bindings',
      'pg-0060-plugin-package-secret-materialization-guard',
    ],
  );
  for (const migration of postgresqlMainMigrationStream.migrations) {
    assert.match(migration.checksum, /^[0-9a-f]{64}$/);
  }
});

test('keeps local-only and legacy tables out of the cluster baseline', async () => {
  const statements = [];
  for (const migration of postgresqlMainMigrationStream.migrations) {
    await migration.up({
      async query(statement) {
        statements.push(statement);
        return { rows: [] };
      },
    });
  }
  const canonical = statements.join('\n').toLowerCase();
  for (const table of BANNED_CLUSTER_SCHEMA_NAMES) {
    assert.equal(canonical.includes(table.toLowerCase()), false, table);
  }
  for (const table of [
    'schema_capabilities',
    'runs',
    'run_attempts',
    'step_runs',
    'step_run_mutations',
    'tool_execution_trace_anchors',
    'tool_execution_audit_receipts',
    'tool_invocation_input_artifacts',
    'tool_invocation_preview_artifacts',
    'worker_sessions',
    'run_dispatch_leases',
    'run_recovery_controls',
    'run_events',
    'run_retry_policies',
    'projects',
    'project_role_bindings',
    'identity_subjects',
    'api_credentials',
    'security_audit_events',
    'identity_subject_mutations',
    'api_credential_mutations',
    'worker_credentials',
    'worker_credential_mutations',
    'worker_credential_deliveries',
    'worker_credential_stage_discards',
    'plugin_package_installs',
    'plugin_package_install_heads',
    'plugin_package_install_mutations',
    'plugin_package_materialized_revisions',
    'plugin_package_secret_bindings',
    'plugin_package_lifecycle_events',
    'plugin_package_lifecycle_heads',
    'plugin_package_lifecycle_receipts',
    'plugin_package_lifecycle_tasks',
    'project_tool_definition_snapshots',
    'project_tool_definition_snapshot_sources',
    'approval_requests',
    'approved_action_dispatches',
    'approved_action_executions',
    'plugin_package_install_proposals',
    'plugin_package_management_quota_buckets',
    'plugin_package_admission_receipts',
    'worker_execution_attestations',
    'task_definitions',
    'task_definition_revisions',
    'triggers',
    'trigger_revisions',
    'task_execution_revisions',
    'trigger_schedules',
  ]) {
    assert.match(canonical, new RegExp(`"ql3"\\."${table}"`));
  }
  assert.match(canonical, /deferrable initially deferred/);
  assert.match(canonical, /'control-core'/);
  assert.match(canonical, /'pg-0016-worker-credential-stage-discard-ledger'/);
  assert.match(canonical, /'pg-0017-database-role-grants'/);
  assert.match(canonical, /'pg-0018-plugin-package-installs'/);
  assert.match(canonical, /'pg-0019-approved-actions'/);
  assert.match(canonical, /'pg-0020-plugin-package-admission-receipts'/);
  assert.match(
    canonical,
    /'pg-0021-approved-action-executions-and-package-proposals'/,
  );
  assert.match(canonical, /"cluster_execution_revision":1/);
  assert.match(canonical, /"cluster_scheduler_admission":1/);
  assert.match(canonical, /"worker_credential_delivery":1/);
  assert.match(canonical, /"worker_credential_stage_discard":1/);
  assert.match(canonical, /"plugin_package_install":1/);
  assert.match(canonical, /"approved_action":1/);
  assert.match(canonical, /"approved_action_execution":1/);
  assert.match(canonical, /"plugin_package_admission":1/);
  assert.match(canonical, /"plugin_package_materialized_revision":1/);
  assert.match(canonical, /"plugin_package_lifecycle":1/);
  assert.match(canonical, /"project_tool_definition_snapshot":1/);
  assert.match(canonical, /"tool_execution_evidence":1/);
  assert.match(canonical, /"tool_invocation_artifact":1/);
  assert.match(canonical, /"plugin_package_proposal":1/);
  assert.match(canonical, /alter column trigger_id type varchar\(128\)/);
});

test('keeps the reviewed SQL and readiness schema contract in lockstep', async () => {
  const statements = [];
  for (const migration of postgresqlMainMigrationStream.migrations) {
    await migration.up({
      async query(statement) {
        statements.push(statement);
        return { rows: [] };
      },
    });
  }
  const canonical = statements.join('\n');
  for (const table of postgresqlControlSchemaContract.tables) {
    if (table.name === 'schema_migrations') continue;
    const definition = tableDefinitionSql(statements, table.name);
    assert.match(definition, new RegExp(`"ql3"\\."${table.name}"`));
    for (const column of table.columns) {
      assert.match(definition, new RegExp(`\\b${column}\\b`));
    }
  }
  for (const index of postgresqlControlSchemaContract.indexes) {
    if (index.endsWith('_pkey')) continue;
    assert.match(
      canonical,
      new RegExp(
        `(?:CREATE (?:UNIQUE )?INDEX ${index}\\b|CONSTRAINT ${index}\\s+UNIQUE\\b)`,
      ),
    );
  }
  assert.doesNotMatch(canonical, /CREATE TABLE IF NOT EXISTS/);
  assert.doesNotMatch(canonical, /CREATE INDEX IF NOT EXISTS/);
});

test('freezes every published PostgreSQL migration checksum', () => {
  const expected = [
    {
      id: 'pg-0001-schema-capability',
      checksum:
        '9e3499e3bcdfe3d7b2559e64ea7bbf236a8a11ba32d6a45af131034887d5a8ab',
    },
    {
      id: 'pg-0002-run-core',
      checksum:
        '5b59a7f9323746e49c6c321e89007f553a0751f25d16ffd23c3ae37dd87f76e4',
    },
    {
      id: 'pg-0003-run-retry-policy',
      checksum:
        '621792cde917cc86809bbebff389443e790bdba60f73d04f7a1dc97a0ebf72db',
    },
    {
      id: 'pg-0004-project-policy',
      checksum:
        '715675d1725687438106c01193f9b87368705c89793d1553c7cbfa7ddefc2343',
    },
    {
      id: 'pg-0005-api-credential-security-audit',
      checksum:
        'd19134de8639df125a8ee4ae4056d6493bf9be4bb2bd28ba3ea1db2a4bf119df',
    },
    {
      id: 'pg-0006-identity-credential-administration',
      checksum:
        'fe2e87ad191a185a6187d1ef350b7fb49bc13cb56bef610669a59838103b2f87',
    },
    {
      id: 'pg-0007-cluster-recovery-indexes',
      checksum:
        'e7e20ee7789a90ddf68eacbb25a9a4e7f4101358b4fb7fd10fa1d4f256e4b5dd',
    },
    {
      id: 'pg-0008-run-recovery-claims',
      checksum:
        '1f32c1dd83107eb1881e1b0e968c59fb33e0c63bb8d526b6cde6f350c07652db',
    },
    {
      id: 'pg-0009-worker-session-run-lease',
      checksum:
        '6be7e5380ca4d71aa6fcbe9170e0c9beb67aa976800ce75167aab44c41ae335b',
    },
    {
      id: 'pg-0010-worker-ingress-attestation',
      checksum:
        'bbc1c36d3d8d3d162073988c8abcf94795fded80277a56b7ac6aa48544caf367',
    },
    {
      id: 'pg-0011-api-credential-pepper-binding',
      checksum:
        '12e76002c42f8409ca417fbb562e29d407eaa57324567d80605471eb9e0fa7a4',
    },
    {
      id: 'pg-0012-task-trigger-definitions',
      checksum:
        '963e99d1aec9de46fd8ec034480f6c78dc904e30fe85d1b3790224c66f628055',
    },
    {
      id: 'pg-0013-task-execution-revisions',
      checksum:
        'a09b34cfda9102c1c573479f61a70f39a786ccd8b45bb82b640935ede4cb6301',
    },
    {
      id: 'pg-0014-cluster-scheduler-admission',
      checksum:
        '5f58a214fb2321c2193bf1f3c4e231d9bc2116cd56fd8550bbc23c81cdbf566d',
    },
    {
      id: 'pg-0015-worker-credential-delivery-ledger',
      checksum:
        'e8bcef07055a748a4858ae502233138da4c0b4f9f2ea3d3a02bd9264da61f4a4',
    },
    {
      id: 'pg-0016-worker-credential-stage-discard-ledger',
      checksum:
        '8e749a3c16fc9c995124bb80fbe67bb4de30ad20c0a1591f283a0dbf1ce243a0',
    },
    {
      id: 'pg-0017-database-role-grants',
      checksum:
        '3bb01c0f0dcab152c01b6ba374e60f0aaae7e7464d589fc76626d5d8191fe9f0',
    },
    {
      id: 'pg-0018-plugin-package-installs',
      checksum:
        '300bd91155c6480f4397f903645022fa980d71fabe592d42584b1402328f5348',
    },
    {
      id: 'pg-0019-approved-actions',
      checksum:
        '96fd50dc1e42f7b2f54af670460d7b486f2fa7c6a234ea1debad120436fcd40c',
    },
    {
      id: 'pg-0020-plugin-package-admission-receipts',
      checksum:
        'b1ae4af68d274eb4324e5fd521f42bfb99c1a81478cc9f57c9b604cd393ea8cf',
    },
    {
      id: 'pg-0021-approved-action-executions-and-package-proposals',
      checksum:
        '6f65ca0dcb25ea56b32e82d40a5a7a6b2be6cf9ed4a48d04107ef01e44f1cd6a',
    },
    {
      id: 'pg-0022-plugin-package-authority-split',
      checksum:
        '431c7c454583629a46a45bb88107765ef600185d3606bfedabb0ca0e40138bf6',
    },
    {
      id: 'pg-0023-plugin-package-management-quota',
      checksum:
        '9e3d1bd16bcb2712885de8f0a094289a60c20dc0e4ed9d90ed5adcf1b0240380',
    },
    {
      id: 'pg-0024-plugin-package-identity-keyset-ledger',
      checksum:
        '0c764e9427632a79033ecd75a600e3788b9f7b9b39f55899d2c9d1e2d033105f',
    },
    {
      id: 'pg-0025-plugin-package-materialized-revisions',
      checksum:
        'da6413393e26f369a9f2639dbd7a0b25bbd079f5de3c61e96e74f0fb10953a54',
    },
    {
      id: 'pg-0026-plugin-package-task-reconciliations',
      checksum:
        'b46c241d958cbc34c2e6052708dbc13e040abc3db92c58b0d5915f05c322a32f',
    },
    {
      id: 'pg-0027-project-tool-definition-snapshots',
      checksum:
        '147b413aa7eee0469c23d1895f4b9136ffa90da999370c9ca9d293e94afe0960',
    },
    {
      id: 'pg-0028-step-runs',
      checksum:
        'a5fd40534f582d07ff5851aa3b856a872a3685e8c975725e8eacf0f6a44ec04a',
    },
    {
      id: 'pg-0029-tool-execution-evidence',
      checksum:
        'c61683499c5d65ad319b2ce18ec94b001131381e9d118ed56f05626f6f83d5c6',
    },
    {
      id: 'pg-0030-tool-execution-start-barriers',
      checksum:
        'dba5dd522bc9cc7d7cce1432d14262c0195637c9f407d21bb6dc93b24a5018a7',
    },
    {
      id: 'pg-0031-tool-invocation-artifacts',
      checksum:
        'b95d9953315aed36a204caa26f2aba5fe9b2893f67f036c8c118bd5551a0a641',
    },
    {
      id: 'pg-0032-tool-execution-artifact-bindings',
      checksum:
        '9dd8c3ce052124370bfef691e21cc582331ce527b0d69740549d3d440bec4946',
    },
    {
      id: 'pg-0033-tool-execution-completions',
      checksum:
        '1ada1837e4473c3e4f27437ede826832cc590aa47f8e8bfa512fa0fadd8dd291',
    },
    {
      id: 'pg-0034-tool-execution-failure-completions',
      checksum:
        '77aa1e86f748f59b84cb4546f0c376ca2bf6ee424bf1b5b3b7fe4970b8056c2f',
    },
    {
      id: 'pg-0035-tool-result-key-catalog',
      checksum:
        '64af556669d93e5cf20a29f5df3842280e56029188e1c719f30325b4b75b84ff',
    },
    {
      id: 'pg-0036-tool-result-rekey-overlays',
      checksum:
        '3d4fb20c52502b8a5609a8242adb17eb0348f7dc7fa65f793d61136d54b5c851',
    },
    {
      id: 'pg-0037-plugin-package-quarantine',
      checksum:
        'a388c7e49a9fe6e417fb343e4ce30dd1b774513c726696ac387d6a1f9884bcb2',
    },
    {
      id: 'pg-0038-plugin-package-publisher-provenance',
      checksum:
        'faa63ec953c41fa75c25c69fce017c07539080a9e8c321b107d067405db6a4ec',
    },
    {
      id: 'pg-0039-plugin-package-publisher-trust-authority',
      checksum:
        'e0ee11727cbc5342bf480e2cc3142971ff256182d56fa960fe4a35f5c3333afe',
    },
    {
      id: 'pg-0040-plugin-package-publisher-trust-transitions',
      checksum:
        'c45ab5c687b62555530035a11370e7094f7b5608505b02d3325804cc680c23fb',
    },
    {
      id: 'pg-0041-plugin-package-lifecycle',
      checksum:
        '99669c63c891124aa0741586d5e92bd40d7a3ddf322ec7da970790958f554101',
    },
    {
      id: 'pg-0042-plugin-package-lifecycle-plans',
      checksum:
        'a242067854f4ee5231c75874fa77dda364da962a2dcaf570b5015ee069818c4b',
    },
    {
      id: 'pg-0043-plugin-package-automation-publications',
      checksum:
        'f93d3a1205c12b252ae31da08b401cad570c1d7f1dea48e83901eff4afe214b9',
    },
    {
      id: 'pg-0044-plugin-package-automation-start-guard',
      checksum:
        'd4f436769e4845c220196f9a0ee4845cc9dae6b2fcd229486f42e4d87e11effd',
    },
    {
      id: 'pg-0045-plugin-package-workflow-admissions',
      checksum:
        'e31520b150eb8991004f773ccd8f4fb9ec2bb559ef0750391f28038aeae43b7e',
    },
    {
      id: 'pg-0046-plugin-package-workflow-task-attempt-admissions',
      checksum:
        '2c5316c9b4e60a1601d9ad0346f56261e6f15ee9368044e632154adb6fe45b7b',
    },
    {
      id: 'pg-0047-worker-credential-management-plans',
      checksum:
        '2004c64019beb6971d43507160a7bd488baba12eb299fde3681a731800145d6a',
    },
    {
      id: 'pg-0048-worker-credential-preapproved-activation',
      checksum:
        'cf37300e40a127b08c118c0bbb352035937af935455709fe5569d458ef91df8b',
    },
    {
      id: 'pg-0049-worker-credential-execution-receipts',
      checksum:
        'd606e51a326b50f8969942c83b3d06d3ed4aa94618fbc5b25005006016918af9',
    },
    {
      id: 'pg-0050-worker-credential-management-boundary',
      checksum:
        '9555dd93ab076bf450cfdf16e2178586a2c58738359266fa5d5345c938913555',
    },
    {
      id: 'pg-0051-automation-management-boundary',
      checksum:
        '1f5e2beff59570163cee7ba2f798a149b5108522bc9db05ecb387d99cc0f96f5',
    },
    {
      id: 'pg-0052-automation-management-identity-keyset-ledger',
      checksum:
        '8594427ad2d53caf61891d21296c140f43ca8204cf728c66784c6db48b7743cd',
    },
    {
      id: 'pg-0053-plugin-package-workflow-run-list-index',
      checksum:
        '1848d8ffcf930462a0beab1220860ac6a626228511a0f55e997077bcb6ef4b63',
    },
    {
      id: 'pg-0054-approval-management-boundary',
      checksum:
        '5e3e6b222269f095e0d7a985fdeb0ea154510e59dfe15873192af8c8d603fca3',
    },
    {
      id: 'pg-0055-run-attempt-log-retention',
      checksum:
        'c775c65ec03ae3a1606f899064d2d38fa63fd136ce52cbd1b1172c3a51e6bf30',
    },
    {
      id: 'pg-0056-run-management-boundary',
      checksum:
        '7aa2b2ade67cdfa6839d4af02209906646a68adfd6c12c4dddeb854021da72b8',
    },
    {
      id: 'pg-0057-run-management-stop-boundary',
      checksum:
        'ab2d0eee3d85a937e1e87243b1fd1e75181529122b64026303488404162e4ba7',
    },
    {
      id: 'pg-0058-plugin-package-automation-disposition-events',
      checksum:
        'd184324909f1e450f3c1b58d422796e3869a1360df60c3f2dfe4af0bacc37471',
    },
    {
      id: 'pg-0059-plugin-package-secret-bindings',
      checksum:
        '87582d256c868bd7f5af352c4b052fdab9f3714e1e7179e35d33bfa5d62957be',
    },
    {
      id: 'pg-0060-plugin-package-secret-materialization-guard',
      checksum:
        '28284ca860b39ff9de5b2aa1a2a60ef2c463fd6a72798d237040174272b64b1e',
    },
  ];
  assert.deepEqual(
    postgresqlMainMigrationStream.migrations.map(({ id, checksum }) => ({
      id,
      checksum,
    })),
    expected,
  );
  assert.deepEqual(postgresqlMainMigrationManifest, {
    id: postgresqlMainMigrationStream.id,
    dialect: postgresqlMainMigrationStream.dialect,
    migrationIdScheme: postgresqlMainMigrationStream.migrationIdScheme,
    checksumScheme: postgresqlMainMigrationStream.checksumScheme,
    migrations: expected,
  });
});

test('advances capability v15 only from the exact v14 predecessor', async () => {
  const statements = [];
  await migrationById('pg-0015-worker-credential-delivery-ledger').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const capability = statements.at(-1);
  assert.match(capability, /contract_version = 14/);
  assert.match(
    capability,
    /migration_id = 'pg-0015-worker-credential-delivery-ledger'/,
  );
  assert.match(
    capability,
    /capabilities = '\{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_session":1\}'::jsonb/,
  );
  assert.match(capability, /IF NOT FOUND THEN/);
  assert.match(capability, /RAISE EXCEPTION/);
});

test('advances capability v16 only after installing exact database role grants', async () => {
  const statements = [];
  await migrationById('pg-0017-database-role-grants').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /required QingLong database roles are missing or privileged/,
  );
  assert.match(canonical, /REVOKE CONNECT ON DATABASE %I FROM PUBLIC/);
  assert.match(canonical, /GRANT USAGE ON SCHEMA "ql3" TO ql3_runtime/);
  assert.match(
    canonical,
    /GRANT INSERT ON "ql3"\."security_audit_events" TO ql3_worker_ingress/,
  );
  assert.match(capability, /contract_version = 16/);
  assert.match(capability, /contract_version = 15/);
  assert.match(
    capability,
    /migration_id = 'pg-0016-worker-credential-stage-discard-ledger'/,
  );
  assert.match(capability, /"database_role_grants":1/);
  assert.match(capability, /IF NOT FOUND THEN/);
});

test('advances capability v17 only with isolated Plugin Package administration grants', async () => {
  const statements = [];
  await migrationById('pg-0018-plugin-package-installs').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(canonical, /CREATE TABLE "ql3"\."plugin_package_installs"/);
  assert.match(
    canonical,
    /GRANT SELECT, INSERT, UPDATE\s+ON "ql3"\."plugin_package_installs", "ql3"\."plugin_package_install_heads"\s+TO ql3_admin/,
  );
  assert.match(
    canonical,
    /CREATE FUNCTION "ql3"\."lock_active_plugin_package_project"\(varchar\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, ql3[\s\S]*FOR SHARE/,
  );
  assert.match(
    canonical,
    /REVOKE ALL\s+ON FUNCTION "ql3"\."lock_active_plugin_package_project"\(varchar\)\s+FROM PUBLIC/,
  );
  assert.match(
    canonical,
    /GRANT EXECUTE\s+ON FUNCTION "ql3"\."lock_active_plugin_package_project"\(varchar\)\s+TO ql3_admin/,
  );
  assert.doesNotMatch(
    canonical,
    /plugin_package_install(?:s|_heads|_mutations)"\s+TO ql3_runtime/,
  );
  assert.doesNotMatch(
    canonical,
    /plugin_package_install(?:s|_heads|_mutations)"\s+TO ql3_worker_ingress/,
  );
  assert.match(capability, /contract_version = 17/);
  assert.match(capability, /contract_version = 16/);
  assert.match(capability, /migration_id = 'pg-0017-database-role-grants'/);
  assert.match(capability, /"plugin_package_install":1/);
  assert.match(capability, /IF NOT FOUND THEN/);
});

test('advances capability v18 only with isolated Approved Action authority', async () => {
  const statements = [];
  await migrationById('pg-0019-approved-actions').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(canonical, /CREATE TABLE "ql3"\."approval_requests"/);
  assert.match(canonical, /CREATE TABLE "ql3"\."approved_action_dispatches"/);
  assert.match(
    canonical,
    /CREATE FUNCTION "ql3"\."lock_approval_policy_fence"\([\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, ql3[\s\S]*FOR SHARE/,
  );
  assert.match(
    canonical,
    /REVOKE ALL\s+ON FUNCTION "ql3"\."lock_approval_policy_fence"\(\s*varchar, varchar, varchar, integer, integer\s*\)\s+FROM PUBLIC/,
  );
  assert.match(
    canonical,
    /GRANT EXECUTE\s+ON FUNCTION "ql3"\."lock_approval_policy_fence"\(\s*varchar, varchar, varchar, integer, integer\s*\)\s+TO ql3_admin/,
  );
  assert.match(
    canonical,
    /GRANT SELECT, INSERT, UPDATE\s+ON "ql3"\."approval_requests"\s+TO ql3_admin/,
  );
  assert.doesNotMatch(
    canonical,
    /approved_action_dispatches?"\s+TO ql3_(?:runtime|worker_ingress)/,
  );
  assert.match(capability, /contract_version = 18/);
  assert.match(capability, /contract_version = 17/);
  assert.match(capability, /migration_id = 'pg-0018-plugin-package-installs'/);
  assert.match(capability, /"approved_action":1/);
  assert.match(capability, /IF NOT FOUND THEN/);
});

test('advances capability v19 only with atomic Package admission receipts', async () => {
  const statements = [];
  await migrationById('pg-0020-plugin-package-admission-receipts').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."plugin_package_admission_receipts"/,
  );
  assert.match(
    canonical,
    /GRANT SELECT, INSERT\s+ON "ql3"\."plugin_package_admission_receipts"\s+TO ql3_admin/,
  );
  assert.doesNotMatch(
    canonical,
    /plugin_package_admission_receipts"\s+TO ql3_(?:runtime|worker_ingress)/,
  );
  assert.match(capability, /contract_version = 19/);
  assert.match(capability, /contract_version = 18/);
  assert.match(capability, /migration_id = 'pg-0019-approved-actions'/);
  assert.match(capability, /"plugin_package_admission":1/);
  assert.match(capability, /IF NOT FOUND THEN/);
});

test('advances capability v20 only with isolated proposal and execution authority', async () => {
  const statements = [];
  await migrationById(
    'pg-0021-approved-action-executions-and-package-proposals',
  ).up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."plugin_package_install_proposals"/,
  );
  assert.match(canonical, /CREATE TABLE "ql3"\."approved_action_executions"/);
  assert.match(
    canonical,
    /GRANT SELECT, INSERT\s+ON "ql3"\."plugin_package_install_proposals"\s+TO ql3_admin/,
  );
  assert.match(
    canonical,
    /GRANT SELECT, INSERT, UPDATE\s+ON "ql3"\."approved_action_executions"\s+TO ql3_admin/,
  );
  assert.doesNotMatch(
    canonical,
    /(?:plugin_package_install_proposals|approved_action_executions)"\s+TO ql3_(?:runtime|worker_ingress)/,
  );
  assert.match(capability, /contract_version = 20/);
  assert.match(capability, /contract_version = 19/);
  assert.match(
    capability,
    /migration_id = 'pg-0020-plugin-package-admission-receipts'/,
  );
  assert.match(capability, /"approved_action_execution":1/);
  assert.match(capability, /"plugin_package_proposal":1/);
  assert.match(capability, /IF NOT FOUND THEN/);
});

test('advances capability v21 only after splitting Package manager and executor', async () => {
  const statements = [];
  await migrationById('pg-0022-plugin-package-authority-split').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(canonical, /ql3_package_manager/);
  assert.match(canonical, /ql3_package_executor/);
  assert.match(canonical, /REVOKE ALL[\s\S]+FROM ql3_admin/);
  assert.match(
    canonical,
    /plugin_package_install_proposals"[\s\S]+TO ql3_package_manager/,
  );
  assert.match(
    canonical,
    /approved_action_executions"[\s\S]+TO ql3_package_executor/,
  );
  assert.equal(
    statements.some(
      (statement) =>
        statement.startsWith('GRANT') &&
        statement.includes('approved_action_executions') &&
        statement.includes('TO ql3_package_manager'),
    ),
    false,
  );
  assert.match(capability, /contract_version = 21/);
  assert.match(capability, /contract_version = 20/);
  assert.match(capability, /"plugin_package_authority_split":1/);
});

test('advances capability v22 only with bounded durable management quota', async () => {
  const statements = [];
  await migrationById('pg-0023-plugin-package-management-quota').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."plugin_package_management_quota_buckets"/,
  );
  assert.match(canonical, /jsonb_array_length\(receipt_ids\) = consumed_count/);
  assert.match(
    canonical,
    /GRANT SELECT, INSERT, UPDATE[\s\S]+TO ql3_package_manager/,
  );
  assert.match(
    canonical,
    /FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_executor, ql3_worker_ingress/,
  );
  assert.match(capability, /contract_version = 22/);
  assert.match(capability, /contract_version = 21/);
  assert.match(capability, /"plugin_package_management_quota":1/);
  assert.match(
    capability,
    /migration_id = 'pg-0022-plugin-package-authority-split'/,
  );
});

test('advances capability v23 only with a durable identity keyset ledger', async () => {
  const statements = [];
  await migrationById('pg-0024-plugin-package-identity-keyset-ledger').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."plugin_package_identity_keyset_ledger"/,
  );
  assert.match(
    canonical,
    /jsonb_array_length\(active_key_ids\) BETWEEN 1 AND 8/i,
  );
  assert.match(
    canonical,
    /GRANT SELECT, INSERT, UPDATE[\s\S]+TO ql3_package_manager/,
  );
  assert.match(
    canonical,
    /FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_executor, ql3_worker_ingress/,
  );
  assert.match(capability, /contract_version = 23/);
  assert.match(capability, /contract_version = 22/);
  assert.match(capability, /"plugin_package_identity_keyset_ledger":1/);
  assert.match(
    capability,
    /migration_id = 'pg-0023-plugin-package-management-quota'/,
  );
});

test('advances capability v24 only with immutable semantic revisions', async () => {
  const statements = [];
  await migrationById('pg-0025-plugin-package-materialized-revisions').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."plugin_package_materialized_revisions"/,
  );
  assert.match(canonical, /GRANT SELECT, INSERT[\s\S]+TO ql3_package_executor/);
  assert.match(
    canonical,
    /FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,[\s\S]+ql3_worker_ingress/,
  );
  assert.match(capability, /contract_version = 24/);
  assert.match(capability, /contract_version = 23/);
  assert.match(capability, /"plugin_package_materialized_revision":1/);
  assert.match(
    capability,
    /migration_id = 'pg-0024-plugin-package-identity-keyset-ledger'/,
  );
});

test('advances capability v26 only with executor-owned Tool Definition snapshots', async () => {
  const statements = [];
  await migrationById('pg-0027-project-tool-definition-snapshots').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."project_tool_definition_snapshots"/,
  );
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."project_tool_definition_snapshot_sources"/,
  );
  assert.match(canonical, /GRANT SELECT, INSERT[\s\S]+TO ql3_package_executor/);
  assert.match(
    canonical,
    /FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,[\s\S]+ql3_worker_ingress/,
  );
  assert.match(capability, /contract_version = 26/);
  assert.match(capability, /contract_version = 25/);
  assert.match(capability, /"project_tool_definition_snapshot":1/);
  assert.match(
    capability,
    /migration_id = 'pg-0027-project-tool-definition-snapshots'/,
  );
});

test('advances capability v27 only with same-Run StepRun authority', async () => {
  const statements = [];
  await migrationById('pg-0028-step-runs').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(canonical, /CREATE TABLE "ql3"\."step_runs"/);
  assert.match(canonical, /CREATE TABLE "ql3"\."step_run_mutations"/);
  assert.match(canonical, /ql3_run_attempts_step_run_fk/);
  assert.match(canonical, /ql3_run_events_step_run_fk/);
  assert.match(canonical, /GRANT SELECT, INSERT, UPDATE[\s\S]+TO ql3_runtime/);
  assert.match(capability, /contract_version = 27/);
  assert.match(capability, /contract_version = 26/);
  assert.match(capability, /"step_run":1/);
  assert.match(capability, /migration_id = 'pg-0028-step-runs'/);
});

test('advances capability v28 only with durable Tool execution evidence', async () => {
  const statements = [];
  await migrationById('pg-0029-tool-execution-evidence').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(canonical, /CREATE TABLE "ql3"\."tool_execution_trace_anchors"/);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."tool_execution_audit_receipts"/,
  );
  assert.match(canonical, /REFERENCES "ql3"\."step_runs" \(run_id, id\)/);
  assert.match(
    canonical,
    /REFERENCES "ql3"\."security_audit_events" \(event_id\)/,
  );
  assert.match(canonical, /GRANT SELECT, INSERT/);
  assert.doesNotMatch(canonical, /GRANT SELECT, INSERT, UPDATE/);
  assert.match(capability, /contract_version = 28/);
  assert.match(capability, /migration_id = 'pg-0029-tool-execution-evidence'/);
  assert.match(capability, /contract_version = 27/);
  assert.match(capability, /migration_id = 'pg-0028-step-runs'/);
  assert.match(capability, /"tool_execution_evidence":1/);
  assert.match(capability, /IF NOT FOUND THEN/);
});

test('advances capability v29 only with atomic Tool start barriers', async () => {
  const statements = [];
  await migrationById('pg-0030-tool-execution-start-barriers').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."tool_execution_start_barriers"/,
  );
  assert.match(canonical, /ql3_tool_start_step_version_uidx/);
  assert.match(canonical, /REFERENCES "ql3"\."step_run_mutations"/);
  assert.match(canonical, /REFERENCES "ql3"\."tool_execution_audit_receipts"/);
  assert.match(canonical, /GRANT SELECT, INSERT/);
  assert.doesNotMatch(canonical, /GRANT SELECT, INSERT, UPDATE/);
  assert.match(capability, /contract_version = 29/);
  assert.match(
    capability,
    /migration_id = 'pg-0030-tool-execution-start-barriers'/,
  );
  assert.match(capability, /contract_version = 28/);
  assert.match(capability, /migration_id = 'pg-0029-tool-execution-evidence'/);
  assert.match(capability, /"tool_execution_start_barrier":1/);
  assert.match(capability, /IF NOT FOUND THEN/);
});

test('advances capability v30 only with immutable Tool invocation Artifacts', async () => {
  const statements = [];
  await migrationById('pg-0031-tool-invocation-artifacts').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."tool_invocation_input_artifacts"/,
  );
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."tool_invocation_preview_artifacts"/,
  );
  assert.match(canonical, /REFERENCES "ql3"\."projects" \(id\)/);
  assert.match(
    canonical,
    /REVOKE ALL[\s\S]+FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,[\s\S]+ql3_package_executor, ql3_worker_ingress/,
  );
  assert.match(canonical, /GRANT SELECT, INSERT[\s\S]+TO ql3_runtime/);
  assert.doesNotMatch(canonical, /GRANT SELECT, INSERT, UPDATE/);
  assert.match(capability, /contract_version = 30/);
  assert.match(
    capability,
    /migration_id = 'pg-0031-tool-invocation-artifacts'/,
  );
  assert.match(capability, /contract_version = 29/);
  assert.match(
    capability,
    /migration_id = 'pg-0030-tool-execution-start-barriers'/,
  );
  assert.match(capability, /"tool_invocation_artifact":1/);
  assert.match(capability, /IF NOT FOUND THEN/);
});

test('advances capability v31 only with exact Tool start Artifact bindings', async () => {
  const statements = [];
  await migrationById('pg-0032-tool-execution-artifact-bindings').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."tool_execution_start_artifact_bindings"/,
  );
  assert.match(canonical, /ql3_tool_start_input_artifact_fk/);
  assert.match(canonical, /ql3_tool_start_preview_artifact_fk/);
  assert.match(canonical, /REFERENCES "ql3"\."tool_execution_start_barriers"/);
  assert.match(canonical, /GRANT SELECT, INSERT/);
  assert.doesNotMatch(canonical, /GRANT SELECT, INSERT, UPDATE/);
  assert.match(capability, /contract_version = 31/);
  assert.match(
    capability,
    /migration_id = 'pg-0032-tool-execution-artifact-bindings'/,
  );
  assert.match(capability, /contract_version = 30/);
  assert.match(
    capability,
    /migration_id = 'pg-0031-tool-invocation-artifacts'/,
  );
  assert.match(capability, /"tool_execution_artifact_binding":1/);
  assert.match(capability, /IF NOT FOUND THEN/);
});

test('advances capability v32 only with atomic encrypted Tool completion', async () => {
  const statements = [];
  await migrationById('pg-0033-tool-execution-completions').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(canonical, /CREATE TABLE "ql3"\."tool_execution_completions"/);
  assert.match(canonical, /ql3_tool_completion_start_fk/);
  assert.match(canonical, /ql3_tool_completion_mutation_fk/);
  assert.match(canonical, /algorithm = 'aes-256-gcm'/);
  assert.match(canonical, /GRANT SELECT, INSERT/);
  assert.doesNotMatch(canonical, /GRANT SELECT, INSERT, UPDATE/);
  assert.match(capability, /contract_version = 32/);
  assert.match(
    capability,
    /migration_id = 'pg-0033-tool-execution-completions'/,
  );
  assert.match(capability, /contract_version = 31/);
  assert.match(
    capability,
    /migration_id = 'pg-0032-tool-execution-artifact-bindings'/,
  );
  assert.match(capability, /"tool_execution_completion":1/);
  assert.match(capability, /IF NOT FOUND THEN/);
});

test('advances capability v33 only with atomic fixed-fact Tool failure completion', async () => {
  const statements = [];
  await migrationById('pg-0034-tool-execution-failure-completions').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."tool_execution_failure_completions"/,
  );
  assert.match(canonical, /ql3_tool_failure_completion_start_fk/);
  assert.match(canonical, /ql3_tool_failure_completion_mutation_fk/);
  assert.match(canonical, /outcome = 'failed'/);
  assert.match(canonical, /outcome = 'timed_out'/);
  assert.match(canonical, /GRANT SELECT, INSERT/);
  assert.doesNotMatch(canonical, /GRANT SELECT, INSERT, UPDATE/);
  assert.match(capability, /contract_version = 33/);
  assert.match(
    capability,
    /migration_id = 'pg-0034-tool-execution-failure-completions'/,
  );
  assert.match(capability, /contract_version = 32/);
  assert.match(
    capability,
    /migration_id = 'pg-0033-tool-execution-completions'/,
  );
  assert.match(capability, /"tool_execution_failure_completion":1/);
  assert.match(capability, /IF NOT FOUND THEN/);
});

test('advances capability v34 only with the fenced Tool result key catalog', async () => {
  const statements = [];
  await migrationById('pg-0035-tool-result-key-catalog').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."tool_result_key_catalog_generations"/,
  );
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."tool_execution_result_key_bindings"/,
  );
  assert.match(canonical, /ql3_tool_result_key_binding_catalog_fk/);
  assert.match(canonical, /GRANT SELECT, INSERT[\s\S]*TO ql3_admin/);
  assert.match(canonical, /GRANT SELECT, INSERT[\s\S]*TO ql3_runtime/);
  assert.doesNotMatch(canonical, /GRANT SELECT, INSERT, UPDATE/);
  assert.match(capability, /contract_version = 34/);
  assert.match(capability, /migration_id = 'pg-0035-tool-result-key-catalog'/);
  assert.match(capability, /contract_version = 33/);
  assert.match(
    capability,
    /migration_id = 'pg-0034-tool-execution-failure-completions'/,
  );
  assert.match(capability, /"tool_result_key_catalog":1/);
  assert.match(capability, /IF NOT FOUND THEN/);
});

test('advances capability v35 only with durable result rekey overlays', async () => {
  const statements = [];
  await migrationById('pg-0036-tool-result-rekey-overlays').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."tool_execution_result_rekey_overlays"/,
  );
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."tool_result_key_retirement_receipts"/,
  );
  assert.match(canonical, /GRANT SELECT, INSERT, UPDATE[\s\S]*ql3_admin/);
  assert.match(
    canonical,
    /GRANT SELECT ON "ql3"\."tool_execution_completions", "ql3"\."tool_execution_result_key_bindings" TO ql3_admin/,
  );
  assert.match(capability, /contract_version = 35/);
  assert.match(
    capability,
    /migration_id = 'pg-0036-tool-result-rekey-overlays'/,
  );
  assert.match(capability, /contract_version = 34/);
  assert.match(capability, /"tool_result_rekey":1/);
});

test('advances capability v36 only with atomic Package quarantine fences', async () => {
  const statements = [];
  await migrationById('pg-0037-plugin-package-quarantine').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."plugin_package_quarantine_events"/,
  );
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."plugin_package_withdrawal_receipts"/,
  );
  assert.match(canonical, /commit_plugin_package_quarantine/);
  assert.match(canonical, /plugin_package_run_start_allowed/);
  assert.match(canonical, /plugin_package_tool_start_allowed/);
  assert.match(
    canonical,
    /GRANT EXECUTE ON FUNCTION[\s\S]*TO ql3_package_executor/,
  );
  assert.match(
    canonical,
    /plugin_package_run_start_allowed[\s\S]*TO ql3_runtime/,
  );
  assert.doesNotMatch(
    canonical,
    /GRANT SELECT ON "ql3"\."plugin_package_quarantine_events", "ql3"\."plugin_package_withdrawal_receipts", "ql3"\."plugin_package_withdrawal_tasks" TO ql3_runtime/,
  );
  assert.match(capability, /contract_version = 36/);
  assert.match(
    capability,
    /migration_id = 'pg-0037-plugin-package-quarantine'/,
  );
  assert.match(capability, /contract_version = 35/);
  assert.match(capability, /"plugin_package_quarantine":1/);
});

test('advances capability v37 only with publisher provenance and revocation fences', async () => {
  const statements = [];
  await migrationById('pg-0038-plugin-package-publisher-provenance').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."plugin_package_publisher_provenance"/,
  );
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."plugin_package_publisher_revocation_receipts"/,
  );
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."plugin_package_publisher_revocation_impacts"/,
  );
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."plugin_package_publisher_revocation_impact_items"/,
  );
  assert.match(
    canonical,
    /CREATE TRIGGER ql3_plugin_package_stage_provenance_guard/,
  );
  assert.match(canonical, /enforce_plugin_package_stage_provenance/);
  assert.match(
    canonical,
    /JOIN "ql3"\."plugin_package_publisher_revocation_receipts" AS revoked/,
  );
  assert.match(
    canonical,
    /GRANT SELECT, INSERT ON[\s\S]*TO ql3_package_executor/,
  );
  assert.match(capability, /contract_version = 37/);
  assert.match(
    capability,
    /migration_id = 'pg-0038-plugin-package-publisher-provenance'/,
  );
  assert.match(capability, /contract_version = 36/);
  assert.match(capability, /"plugin_package_publisher_provenance":1/);
});

test('advances capability v38 only with durable publisher trust authority', async () => {
  const statements = [];
  await migrationById('pg-0039-plugin-package-publisher-trust-authority').up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const canonical = statements.join('\n');
  const capability = statements.at(-1);
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."plugin_package_publisher_trust_snapshots"/,
  );
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."plugin_package_publisher_trust_heads"/,
  );
  assert.match(
    canonical,
    /CREATE TABLE "ql3"\."plugin_package_publisher_revocation_proposals"/,
  );
  assert.match(
    canonical,
    /GRANT SELECT, INSERT ON[\s\S]*TO ql3_package_manager/,
  );
  assert.match(
    canonical,
    /GRANT SELECT, UPDATE ON[\s\S]*TO ql3_package_executor/,
  );
  assert.doesNotMatch(
    canonical,
    /GRANT[\s\S]*plugin_package_publisher_trust_heads[\s\S]*TO ql3_runtime/,
  );
  assert.match(capability, /contract_version = 38/);
  assert.match(
    capability,
    /migration_id =\s*'pg-0039-plugin-package-publisher-trust-authority'/,
  );
  assert.match(capability, /contract_version = 37/);
  assert.match(capability, /"plugin_package_publisher_trust_authority":1/);
});

test('advances capability v39 only with approved publisher trust transitions', async () => {
  const migration = migrationById(
    'pg-0040-plugin-package-publisher-trust-transitions',
  );
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  for (const table of [
    'plugin_package_publisher_trust_transition_proposals',
    'plugin_package_publisher_trust_transition_receipts',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE \"ql3\"\\.\"${table}\"`));
  }
  assert.match(sql, /plugin_package\.publisher_key\.overlap_add/);
  assert.match(sql, /plugin_package\.publisher_key\.safe_retire/);
  assert.match(sql, /retirement_matching_installations = 0/);
  assert.match(
    sql,
    /REFERENCES "ql3"\."approved_action_dispatches" \(dispatch_id\)/,
  );
  assert.match(sql, /TO ql3_package_manager/);
  assert.match(sql, /TO ql3_package_executor/);
  assert.match(sql, /contract_version = 39/);
  assert.match(
    sql,
    /migration_id =\s*'pg-0040-plugin-package-publisher-trust-transitions'/,
  );
  assert.match(sql, /contract_version = 38/);
  assert.match(
    sql,
    /migration_id =\s*'pg-0039-plugin-package-publisher-trust-authority'/,
  );
});

test('advances capability v40 only with atomic Plugin Package lifecycle', async () => {
  const migration = migrationById('pg-0041-plugin-package-lifecycle');
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  for (const table of [
    'plugin_package_lifecycle_events',
    'plugin_package_lifecycle_heads',
    'plugin_package_lifecycle_receipts',
    'plugin_package_lifecycle_tasks',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE \"ql3\"\\.\"${table}\"`));
  }
  assert.match(sql, /commit_plugin_package_lifecycle/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /plugin_package_run_start_allowed/);
  assert.match(sql, /plugin_package_tool_start_allowed/);
  assert.match(sql, /plugin_package_lifecycle_blocking_runs/);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION "ql3"\."plugin_package_lifecycle_blocking_runs"\(varchar, varchar, integer\) TO ql3_package_executor/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT SELECT(?:\s*\([^)]*\))? ON "ql3"\."runs" TO ql3_package_executor/,
  );
  assert.match(sql, /GRANT EXECUTE ON FUNCTION[\s\S]*TO ql3_package_executor/);
  assert.doesNotMatch(
    sql,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*plugin_package_lifecycle_[a-z_]+"[\s\S]*TO ql3_runtime/,
  );
  assert.match(sql, /contract_version = 40/);
  assert.match(sql, /migration_id = 'pg-0041-plugin-package-lifecycle'/);
  assert.match(sql, /contract_version = 39/);
  assert.match(
    sql,
    /migration_id =\s*'pg-0040-plugin-package-publisher-trust-transitions'/,
  );
  assert.match(sql, /"plugin_package_lifecycle":1/);
});

test('advances capability v41 with durable manager-readable lifecycle plans', async () => {
  const migration = migrationById('pg-0042-plugin-package-lifecycle-plans');
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(sql, /CREATE TABLE "ql3"\."plugin_package_lifecycle_plans"/);
  assert.match(
    sql,
    /GRANT SELECT ON "ql3"\."plugin_package_lifecycle_plans" TO ql3_package_manager, ql3_package_executor/,
  );
  assert.match(
    sql,
    /GRANT INSERT ON "ql3"\."plugin_package_lifecycle_plans" TO ql3_package_executor/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT (?:INSERT|UPDATE|DELETE)[\s\S]*plugin_package_lifecycle_plans" TO ql3_package_manager/,
  );
  assert.match(sql, /contract_version = 41/);
  assert.match(sql, /migration_id = 'pg-0042-plugin-package-lifecycle-plans'/);
  assert.match(sql, /contract_version = 40/);
  assert.match(sql, /migration_id = 'pg-0041-plugin-package-lifecycle'/);
  assert.match(sql, /"plugin_package_lifecycle_plan":1/);
});

test('advances capability v42 with runtime-readable automation publications', async () => {
  const migration = migrationById(
    'pg-0043-plugin-package-automation-publications',
  );
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(
    sql,
    /CREATE TABLE "ql3"\."plugin_package_automation_publications"/,
  );
  assert.match(
    sql,
    /CREATE TABLE "ql3"\."plugin_package_automation_publication_heads"/,
  );
  assert.match(
    sql,
    /TO ql3_runtime, ql3_package_manager, ql3_package_executor/,
  );
  assert.match(
    sql,
    /GRANT INSERT[\s\S]*plugin_package_automation_publications"[\s\S]*TO ql3_package_executor/,
  );
  assert.match(
    sql,
    /GRANT INSERT, UPDATE[\s\S]*plugin_package_automation_publication_heads"[\s\S]*TO ql3_package_executor/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT (?:INSERT|UPDATE|DELETE)[\s\S]*plugin_package_automation_publication_heads"[\s\S]*TO ql3_runtime/,
  );
  assert.match(sql, /contract_version = 42/);
  assert.match(
    sql,
    /migration_id = 'pg-0043-plugin-package-automation-publications'/,
  );
  assert.match(sql, /contract_version = 41/);
  assert.match(sql, /migration_id = 'pg-0042-plugin-package-lifecycle-plans'/);
  assert.match(sql, /"plugin_package_automation_publication":1/);
});

test('advances capability v43 with a runtime-only automation start guard', async () => {
  const migration = migrationById(
    'pg-0044-plugin-package-automation-start-guard',
  );
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(
    sql,
    /CREATE FUNCTION "ql3"\."plugin_package_automation_start_allowed"/,
  );
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /FOR SHARE OF head, publication/);
  assert.match(sql, /plugin_package_quarantine_events/);
  assert.match(sql, /plugin_package_publisher_revocation_receipts/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /774635230/);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION[\s\S]*plugin_package_automation_start_allowed[\s\S]*TO ql3_runtime/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT EXECUTE ON FUNCTION[\s\S]*plugin_package_automation_start_allowed[\s\S]*TO ql3_(?:admin|package_manager|package_executor|worker_ingress)/,
  );
  assert.match(sql, /contract_version = 43/);
  assert.match(
    sql,
    /migration_id = 'pg-0044-plugin-package-automation-start-guard'/,
  );
  assert.match(sql, /contract_version = 42/);
  assert.match(
    sql,
    /migration_id = 'pg-0043-plugin-package-automation-publications'/,
  );
  assert.match(sql, /"plugin_package_automation_start_guard":1/);
});

test('advances capability v44 with atomic runtime-only Workflow admission', async () => {
  const migration = migrationById('pg-0045-plugin-package-workflow-admissions');
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(sql, /CREATE TABLE "ql3"\."plugin_package_workflow_admissions"/);
  assert.match(
    sql,
    /CREATE TABLE "ql3"\."plugin_package_workflow_admission_steps"/,
  );
  assert.match(
    sql,
    /CREATE FUNCTION "ql3"\."plugin_package_workflow_admission_snapshot"/,
  );
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /plugin_package_automation_start_allowed/);
  assert.match(sql, /FOR SHARE OF publication, revision/);
  assert.match(
    sql,
    /GRANT SELECT, INSERT[\s\S]*plugin_package_workflow_admissions[\s\S]*TO ql3_runtime/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION[\s\S]*plugin_package_workflow_admission_snapshot[\s\S]*TO ql3_runtime/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*plugin_package_workflow_admissions[\s\S]*TO ql3_(?:admin|package_manager|package_executor|worker_ingress)/,
  );
  assert.match(sql, /contract_version = 44/);
  assert.match(
    sql,
    /migration_id = 'pg-0045-plugin-package-workflow-admissions'/,
  );
  assert.match(sql, /contract_version = 43/);
  assert.match(
    sql,
    /migration_id = 'pg-0044-plugin-package-automation-start-guard'/,
  );
  assert.match(sql, /"plugin_package_workflow_admission":1/);
});

test('advances capability v45 with generation-bound Workflow Task attempts', async () => {
  const migration = migrationById(
    'pg-0046-plugin-package-workflow-task-attempt-admissions',
  );
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(
    sql,
    /CREATE TABLE "ql3"\."plugin_package_workflow_task_attempt_admissions"/,
  );
  assert.match(
    sql,
    /CREATE FUNCTION "ql3"\."plugin_package_workflow_task_attempt_snapshot"/,
  );
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(
    sql,
    /FOR KEY SHARE OF workflow, source, reconciliation, item, execution/,
  );
  assert.match(
    sql,
    /GRANT SELECT, INSERT[\s\S]*plugin_package_workflow_task_attempt_admissions[\s\S]*TO ql3_runtime/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION[\s\S]*plugin_package_workflow_task_attempt_snapshot[\s\S]*TO ql3_runtime/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*plugin_package_task_reconciliations[\s\S]*TO ql3_runtime/,
  );
  assert.match(sql, /contract_version = 45/);
  assert.match(
    sql,
    /migration_id\s*=\s*'pg-0046-plugin-package-workflow-task-attempt-admissions'/,
  );
  assert.match(sql, /contract_version = 44/);
  assert.match(
    sql,
    /migration_id\s*=\s*'pg-0045-plugin-package-workflow-admissions'/,
  );
  assert.match(sql, /"plugin_package_workflow_task_attempt_admission":1/);
});

test('advances capability v46 with split Worker credential management authorities', async () => {
  const migration = migrationById('pg-0047-worker-credential-management-plans');
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(sql, /CREATE TABLE "ql3"\."worker_credential_management_plans"/);
  assert.match(sql, /'ql3_worker_credential_manager'/);
  assert.match(sql, /'ql3_worker_credential_executor'/);
  assert.match(
    sql,
    /GRANT SELECT, INSERT ON "ql3"\."worker_credential_management_plans" TO ql3_worker_credential_manager/,
  );
  assert.match(
    sql,
    /GRANT SELECT ON "ql3"\."worker_credential_management_plans" TO ql3_worker_credential_executor/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT (?:INSERT|UPDATE|DELETE)[^\n]*worker_credential_management_plans" TO ql3_worker_credential_executor/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^\n]*worker_credentials"[^\n]*TO ql3_worker_credential_manager/,
  );
  assert.match(sql, /contract_version = 46/);
  assert.match(
    sql,
    /migration_id = 'pg-0047-worker-credential-management-plans'/,
  );
  assert.match(sql, /contract_version = 45/);
  assert.match(
    sql,
    /migration_id\s*=\s*'pg-0046-plugin-package-workflow-task-attempt-admissions'/,
  );
  assert.match(sql, /"worker_credential_management_plan":1/);
});

test('advances capability v47 without invalidating preapproved Worker credentials', async () => {
  const migration = migrationById(
    'pg-0048-worker-credential-preapproved-activation',
  );
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(sql, /DROP CONSTRAINT ql3_worker_credentials_lifetime_check/);
  assert.match(
    sql,
    /expires_at_ms > GREATEST\(created_at_ms, not_before_at_ms\)/,
  );
  assert.doesNotMatch(sql, /not_before_at_ms >= created_at_ms/);
  assert.match(sql, /contract_version = 47/);
  assert.match(
    sql,
    /migration_id = 'pg-0048-worker-credential-preapproved-activation'/,
  );
  assert.match(sql, /contract_version = 46/);
  assert.match(
    sql,
    /migration_id = 'pg-0047-worker-credential-management-plans'/,
  );
  assert.match(sql, /"worker_credential_preapproved_activation":1/);
});

test('advances capability v48 with a dedicated Worker credential execution receipt authority', async () => {
  const migration = migrationById(
    'pg-0049-worker-credential-execution-receipts',
  );
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(
    sql,
    /REVOKE ALL ON "ql3"\."approved_action_executions" FROM ql3_worker_credential_manager, ql3_worker_credential_executor/,
  );
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE ON "ql3"\."approved_action_executions" TO ql3_worker_credential_executor/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT[^\n]+approved_action_executions[^\n]+ql3_worker_credential_manager/,
  );
  assert.match(sql, /contract_version = 48/);
  assert.match(
    sql,
    /migration_id = 'pg-0049-worker-credential-execution-receipts'/,
  );
  assert.match(sql, /contract_version = 47/);
  assert.match(
    sql,
    /migration_id = 'pg-0048-worker-credential-preapproved-activation'/,
  );
  assert.match(sql, /"worker_credential_execution_receipt":1/);
});

test('advances capability v49 with durable Worker credential management boundaries', async () => {
  const migration = migrationById(
    'pg-0050-worker-credential-management-boundary',
  );
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(
    sql,
    /CREATE TABLE "ql3"\."worker_credential_management_quota_buckets"/,
  );
  assert.match(sql, /TO ql3_worker_credential_manager/);
  assert.doesNotMatch(
    sql,
    /GRANT[^\n]+worker_credential_management_quota_buckets[^\n]+ql3_worker_credential_executor/,
  );
  assert.match(sql, /'worker-credential\.plan'/);
  assert.match(sql, /'worker-credential\.inspect'/);
  assert.match(sql, /'worker-credential-management'/);
  assert.match(sql, /contract_version = 49/);
  assert.match(
    sql,
    /migration_id = 'pg-0050-worker-credential-management-boundary'/,
  );
  assert.match(sql, /contract_version = 48/);
  assert.match(
    sql,
    /migration_id = 'pg-0049-worker-credential-execution-receipts'/,
  );
});

test('advances capability v50 with isolated automation management authority', async () => {
  const migration = migrationById('pg-0051-automation-management-boundary');
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(sql, /ql3_automation_manager/);
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE ON "ql3"\."task_definitions"[^\n]+TO ql3_automation_manager/,
  );
  assert.match(
    sql,
    /REVOKE SELECT, INSERT, UPDATE ON "ql3"\."task_definitions"[^\n]+FROM ql3_admin/,
  );
  assert.doesNotMatch(sql, /GRANT[^\n]+"runs"[^\n]+ql3_automation_manager/);
  assert.match(sql, /contract_version = 50/);
  assert.match(sql, /"automation_management_boundary":1/);
  assert.match(sql, /contract_version = 49/);
  assert.match(
    sql,
    /migration_id = 'pg-0050-worker-credential-management-boundary'/,
  );
});

test('advances capability v51 with a restart-safe automation identity keyset ledger', async () => {
  const migration = migrationById(
    'pg-0052-automation-management-identity-keyset-ledger',
  );
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(
    sql,
    /authority IN \('plugin-package-management', 'worker-credential-management', 'automation-management'\)/,
  );
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE ON "ql3"\."plugin_package_identity_keyset_ledger" TO ql3_automation_manager/,
  );
  assert.match(sql, /contract_version = 51/);
  assert.match(sql, /"automation_management_identity_keyset_ledger":1/);
  assert.match(sql, /contract_version = 50/);
  assert.match(sql, /migration_id = 'pg-0051-automation-management-boundary'/);
});

test('advances capability v52 with a bounded Workflow Run history index', async () => {
  const migration = migrationById(
    'pg-0053-plugin-package-workflow-run-list-index',
  );
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(
    sql,
    /plugin_package_workflow_admissions" \(project_id, package_name, workflow_id, admitted_at_ms, run_id\)/,
  );
  assert.match(sql, /contract_version = 52/);
  assert.match(sql, /"plugin_package_workflow_run_list":1/);
  assert.match(sql, /contract_version = 51/);
  assert.match(
    sql,
    /migration_id = 'pg-0052-automation-management-identity-keyset-ledger'/,
  );
});

test('advances capability v53 with isolated human Approval management authority', async () => {
  const migration = migrationById('pg-0054-approval-management-boundary');
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(sql, /ql3_approval_manager/);
  assert.match(
    sql,
    /GRANT SELECT, UPDATE ON "ql3"\."approval_requests" TO ql3_approval_manager/,
  );
  assert.match(
    sql,
    /GRANT SELECT ON [^\n]+"tool_invocation_preview_artifacts" TO ql3_approval_manager/,
  );
  assert.match(
    sql,
    /GRANT SELECT, INSERT ON "ql3"\."security_audit_events" TO ql3_approval_manager/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT[^\n]+"tool_invocation_input_artifacts"[^\n]+ql3_approval_manager/,
  );
  assert.match(sql, /'approval-management'/);
  assert.match(sql, /contract_version = 53/);
  assert.match(sql, /"approval_management_boundary":1/);
  assert.match(sql, /contract_version = 52/);
  assert.match(
    sql,
    /migration_id = 'pg-0053-plugin-package-workflow-run-list-index'/,
  );
});

test('advances capability v54 with durable Cluster log retention authority', async () => {
  const migration = migrationById('pg-0055-run-attempt-log-retention');
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(sql, /run_attempt_log_retention_controls/);
  assert.match(sql, /run_attempt_log_artifact_tombstones/);
  assert.match(sql, /FOR UPDATE|SKIP LOCKED|claim_expires_at_ms/);
  assert.match(sql, /TO ql3_runtime/);
  assert.match(sql, /contract_version = 54/);
  assert.match(sql, /"run_attempt_log_retention":1/);
  assert.match(sql, /contract_version = 53/);
  assert.match(sql, /migration_id = 'pg-0054-approval-management-boundary'/);
});

test('advances capability v55 with isolated strong Run management authority', async () => {
  const migration = migrationById('pg-0056-run-management-boundary');
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(sql, /ql3_run_manager/);
  assert.match(sql, /lock_run_management_policy_fence/);
  assert.match(
    sql,
    /GRANT SELECT, INSERT ON "ql3"\."runs", "ql3"\."run_attempts", "ql3"\."run_events", "ql3"\."security_audit_events" TO ql3_run_manager/,
  );
  assert.doesNotMatch(sql, /GRANT UPDATE ON "ql3"\."runs"/);
  assert.match(sql, /'run-management'/);
  assert.match(sql, /contract_version = 55/);
  assert.match(sql, /"run_management_boundary":1/);
  assert.match(sql, /contract_version = 54/);
  assert.match(sql, /migration_id = 'pg-0055-run-attempt-log-retention'/);
});

test('advances capability v56 with column-scoped Run stop authority', async () => {
  const migration = migrationById('pg-0057-run-management-stop-boundary');
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(
    sql,
    /GRANT UPDATE \(cancel_requested_at_ms, cancel_reason, version, event_sequence\) ON "ql3"\."runs" TO ql3_run_manager/,
  );
  assert.doesNotMatch(sql, /GRANT UPDATE ON "ql3"\."runs" TO ql3_run_manager/);
  assert.match(sql, /contract_version = 56/);
  assert.match(sql, /"run_management_stop":1/);
  assert.match(sql, /contract_version = 55/);
  assert.match(sql, /migration_id = 'pg-0056-run-management-boundary'/);
});

test('advances capability v58 with immutable generation-bound Package Secret bindings', async () => {
  const migration = migrationById('pg-0059-plugin-package-secret-bindings');
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(sql, /CREATE TABLE "ql3"\."plugin_package_secret_bindings"/);
  assert.match(sql, /qinglong\/plugin-package-secret-binding@v1/);
  assert.match(sql, /GRANT SELECT, INSERT[^;]+TO ql3_package_executor/);
  assert.doesNotMatch(sql, /GRANT UPDATE|GRANT DELETE/);
  assert.match(sql, /contract_version = 58/);
  assert.match(sql, /"plugin_package_secret_binding":1/);
  assert.match(sql, /contract_version = 57/);
  assert.match(
    sql,
    /migration_id = 'pg-0058-plugin-package-automation-disposition-events'/,
  );
});

test('advances capability v59 with fail-closed Package Secret materialization', async () => {
  const migration = migrationById(
    'pg-0060-plugin-package-secret-materialization-guard',
  );
  const statements = [];
  await migration.up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const sql = statements.join('\n');
  assert.match(
    sql,
    /CREATE FUNCTION "ql3"\."enforce_plugin_package_secret_materialization"\(\)/,
  );
  assert.match(
    sql,
    /jsonb_typeof\([\s\S]+IS DISTINCT FROM 'array'[\s\S]+permission declarations are malformed/,
  );
  assert.match(sql, /unresolved Package Secret placeholder/);
  assert.match(sql, /Task SecretRef is outside Package binding/);
  assert.match(
    sql,
    /CREATE TRIGGER ql3_plugin_package_secret_materialization_guard BEFORE INSERT/,
  );
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION [^;]+ FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress/,
  );
  assert.match(sql, /contract_version = 59/);
  assert.match(sql, /"plugin_package_secret_materialization":1/);
  assert.match(sql, /contract_version = 58/);
  assert.match(sql, /migration_id = 'pg-0059-plugin-package-secret-bindings'/);
});
