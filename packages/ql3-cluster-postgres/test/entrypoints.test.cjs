const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('runtime export excludes executable migration DDL modules', () => {
  const packageDirectory = path.resolve(__dirname, '..');
  const script = `
    const runtime = require('@qinglong/cluster-postgres/runtime');
    const loaded = Object.keys(require.cache)
      .filter((file) => file.includes('/ql3-cluster-postgres/dist/'))
      .map((file) => file.replaceAll('\\\\', '/'));
    process.stdout.write(JSON.stringify({
      hasRepository: typeof runtime.PostgresRunRepository === 'function',
      hasSecretAuthority: typeof runtime.PostgresRemoteWorkerSecretDeliveryAuthorityRepository === 'function',
      hasReadiness: typeof runtime.assertPostgresSchemaReady === 'function',
      loaded,
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: packageDirectory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.hasRepository, true);
  assert.equal(report.hasSecretAuthority, true);
  assert.equal(report.hasReadiness, true);
  assert.equal(
    report.loaded.some(
      (file) =>
        /\/dist\/migrations\/pg-\d/.test(file) ||
        file.endsWith('/dist/migration/migrate.js') ||
        file.endsWith('/dist/migration/migration.js') ||
        file.endsWith('/dist/schema/schema.js'),
    ),
    false,
    report.loaded.join('\n'),
  );
});

test('Worker ingress export cannot acquire runtime Secret authority', () => {
  const ingress = require('@qinglong/cluster-postgres/worker-ingress');
  assert.equal(
    ingress.PostgresRemoteWorkerSecretDeliveryAuthorityRepository,
    undefined,
  );
  assert.equal(
    ingress.PostgresRemoteWorkerCompletionRepository,
    undefined,
  );
  assert.equal(
    ingress.PostgresRemoteWorkerLeaseControlRepository,
    undefined,
  );
});

test('migration export exposes the reviewed runner through a public subpath', () => {
  const migration = require('@qinglong/cluster-postgres/migration');
  assert.equal(typeof migration.runPostgresMigrations, 'function');
  assert.deepEqual(
    migration.postgresqlMainMigrationManifest.migrations,
    migration.postgresqlMainMigrationStream.migrations.map(
      ({ id, checksum }) => ({ id, checksum }),
    ),
  );
});

test('admin export exposes administration authority without migration DDL', () => {
  const packageDirectory = path.resolve(__dirname, '..');
  const script = `
    const admin = require('@qinglong/cluster-postgres/admin');
    const loaded = Object.keys(require.cache)
      .filter((file) => file.includes('/ql3-cluster-postgres/dist/'))
      .map((file) => file.replaceAll('\\\\', '/'));
    process.stdout.write(JSON.stringify({
      hasIdentityAdministration: typeof admin.PostgresIdentityAdministrationRepository === 'function',
      hasCredentialAdministration: typeof admin.PostgresApiCredentialAdministrationRepository === 'function',
      hasAuditQuery: typeof admin.PostgresSecurityAuditQueryRepository === 'function',
      hasReadiness: typeof admin.assertPostgresAdminSchemaReady === 'function',
      loaded,
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: packageDirectory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.hasIdentityAdministration, true);
  assert.equal(report.hasCredentialAdministration, true);
  assert.equal(report.hasAuditQuery, true);
  assert.equal(report.hasReadiness, true);
  assert.equal(
    report.loaded.some(
      (file) =>
        /\/dist\/migrations\/pg-\d/.test(file) ||
        file.endsWith('/dist/migration/migrate.js') ||
        file.endsWith('/dist/migration/migration.js') ||
        file.endsWith('/dist/schema/schema.js'),
    ),
    false,
    report.loaded.join('\n'),
  );
});

test('Plugin Package install authority is isolated behind its explicit subpath', () => {
  const root = require('@qinglong/cluster-postgres');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  const admin = require('@qinglong/cluster-postgres/admin');
  const ingress = require('@qinglong/cluster-postgres/worker-ingress');
  const authority = require('@qinglong/cluster-postgres/plugin-package-install');
  assert.equal(root.PostgresPluginPackageInstallRepository, undefined);
  assert.equal(runtime.PostgresPluginPackageInstallRepository, undefined);
  assert.equal(admin.PostgresPluginPackageInstallRepository, undefined);
  assert.equal(ingress.PostgresPluginPackageInstallRepository, undefined);
  assert.equal(
    typeof authority.PostgresPluginPackageInstallRepository,
    'function',
  );
});

test('Package manager exposes inventory read authority without install mutation authority', () => {
  const manager = require('@qinglong/cluster-postgres/package-manager');
  assert.equal(
    typeof manager.PostgresPluginPackageInstallInventoryReader,
    'function',
  );
  assert.equal(manager.PostgresPluginPackageInstallRepository, undefined);
  const reader = new manager.PostgresPluginPackageInstallInventoryReader({
    async query() {
      return { rows: [], rowCount: 0 };
    },
  });
  assert.deepEqual(
    Object.getOwnPropertyNames(Object.getPrototypeOf(reader)).sort(),
    ['constructor', 'findCurrent', 'listCurrentPage'],
  );
});

test('Worker credential authorities expose disjoint management and execution capabilities', () => {
  const manager = require('@qinglong/cluster-postgres/worker-credential-manager');
  const executor = require('@qinglong/cluster-postgres/worker-credential-executor');

  assert.equal(
    typeof manager.assertPostgresWorkerCredentialManagerSchemaReady,
    'function',
  );
  assert.equal(
    typeof manager.PostgresWorkerCredentialManagementPlanRepository,
    'function',
  );
  assert.equal(manager.PostgresWorkerCredentialAdministrationRepository, undefined);
  assert.equal(
    manager.PostgresRemoteWorkerSecretDeliveryAuthorityRepository,
    undefined,
  );

  assert.equal(
    typeof executor.assertPostgresWorkerCredentialExecutorSchemaReady,
    'function',
  );
  assert.equal(
    typeof executor.PostgresWorkerCredentialManagementPlanReader,
    'function',
  );
  assert.equal(
    typeof executor.PostgresWorkerCredentialAdministrationRepository,
    'function',
  );
  assert.equal(
    typeof executor.PostgresRemoteWorkerSecretDeliveryAuthorityRepository,
    'function',
  );
  assert.equal(executor.PostgresWorkerCredentialManagementPlanRepository, undefined);
});

test('Package manager inventory reader performs only bounded read queries', async () => {
  const { PostgresPluginPackageInstallInventoryReader } = require(
    '@qinglong/cluster-postgres/package-manager'
  );
  const queries = [];
  const reader = new PostgresPluginPackageInstallInventoryReader({
    async query(text, values) {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
  });

  assert.equal(await reader.findCurrent('project-reader', 'package-reader'), null);
  assert.deepEqual(
    await reader.listCurrentPage({
      projectId: 'project-reader',
      limit: 8,
      after: { packageName: 'package-before' },
    }),
    { items: [], truncated: false },
  );
  assert.equal(queries.length, 2);
  assert.match(queries[0].text, /SELECT/);
  assert.deepEqual(queries[0].values, ['project-reader', 'package-reader']);
  assert.match(queries[1].text, /ORDER BY head\.package_name/);
  assert.deepEqual(queries[1].values, [
    'project-reader',
    'package-before',
    9,
  ]);
});

test('StepRun authority is limited to runtime composition and explicit subpath', () => {
  const root = require('@qinglong/cluster-postgres');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  const admin = require('@qinglong/cluster-postgres/admin');
  const ingress = require('@qinglong/cluster-postgres/worker-ingress');
  const authority = require('@qinglong/cluster-postgres/step-run');
  assert.equal(root.PostgresStepRunRepository, undefined);
  assert.equal(
    runtime.PostgresStepRunRepository,
    authority.PostgresStepRunRepository,
  );
  assert.equal(admin.PostgresStepRunRepository, undefined);
  assert.equal(ingress.PostgresStepRunRepository, undefined);
  assert.equal(typeof authority.PostgresStepRunRepository, 'function');
});

test('Tool execution evidence authority is isolated behind its explicit subpath', () => {
  const root = require('@qinglong/cluster-postgres');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  const admin = require('@qinglong/cluster-postgres/admin');
  const ingress = require('@qinglong/cluster-postgres/worker-ingress');
  const authority = require('@qinglong/cluster-postgres/tool-execution-evidence');
  assert.equal(root.PostgresToolExecutionEvidenceRepository, undefined);
  assert.equal(runtime.PostgresToolExecutionEvidenceRepository, undefined);
  assert.equal(admin.PostgresToolExecutionEvidenceRepository, undefined);
  assert.equal(ingress.PostgresToolExecutionEvidenceRepository, undefined);
  assert.equal(
    typeof authority.PostgresToolExecutionEvidenceRepository,
    'function',
  );
});

test('Tool start barrier authority is limited to runtime composition and explicit subpath', () => {
  const root = require('@qinglong/cluster-postgres');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  const admin = require('@qinglong/cluster-postgres/admin');
  const ingress = require('@qinglong/cluster-postgres/worker-ingress');
  const authority = require('@qinglong/cluster-postgres/tool-execution-start-barrier');
  assert.equal(root.PostgresToolExecutionStartBarrierRepository, undefined);
  assert.equal(
    runtime.PostgresToolExecutionStartBarrierRepository,
    authority.PostgresToolExecutionStartBarrierRepository,
  );
  assert.equal(admin.PostgresToolExecutionStartBarrierRepository, undefined);
  assert.equal(ingress.PostgresToolExecutionStartBarrierRepository, undefined);
  assert.equal(
    typeof authority.PostgresToolExecutionStartBarrierRepository,
    'function',
  );
});

test('Tool completion authority is limited to runtime composition and explicit subpath', () => {
  const root = require('@qinglong/cluster-postgres');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  const admin = require('@qinglong/cluster-postgres/admin');
  const ingress = require('@qinglong/cluster-postgres/worker-ingress');
  const authority = require('@qinglong/cluster-postgres/tool-execution-completion');
  assert.equal(root.PostgresToolExecutionCompletionRepository, undefined);
  assert.equal(
    runtime.PostgresToolExecutionCompletionRepository,
    authority.PostgresToolExecutionCompletionRepository,
  );
  assert.equal(admin.PostgresToolExecutionCompletionRepository, undefined);
  assert.equal(ingress.PostgresToolExecutionCompletionRepository, undefined);
  assert.equal(
    typeof authority.PostgresToolExecutionCompletionRepository,
    'function',
  );
});

test('Tool failure completion authority is limited to runtime composition and explicit subpath', () => {
  const root = require('@qinglong/cluster-postgres');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  const admin = require('@qinglong/cluster-postgres/admin');
  const ingress = require('@qinglong/cluster-postgres/worker-ingress');
  const authority = require('@qinglong/cluster-postgres/tool-execution-failure-completion');
  assert.equal(
    root.PostgresToolExecutionFailureCompletionRepository,
    undefined,
  );
  assert.equal(
    runtime.PostgresToolExecutionFailureCompletionRepository,
    authority.PostgresToolExecutionFailureCompletionRepository,
  );
  assert.equal(
    admin.PostgresToolExecutionFailureCompletionRepository,
    undefined,
  );
  assert.equal(
    ingress.PostgresToolExecutionFailureCompletionRepository,
    undefined,
  );
  assert.equal(
    typeof authority.PostgresToolExecutionFailureCompletionRepository,
    'function',
  );
});

test('Tool result key catalog splits runtime read from admin mutation authority', () => {
  const root = require('@qinglong/cluster-postgres');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  const admin = require('@qinglong/cluster-postgres/admin');
  const ingress = require('@qinglong/cluster-postgres/worker-ingress');
  const authority = require('@qinglong/cluster-postgres/tool-result-key-catalog');
  assert.equal(root.PostgresToolResultKeyCatalogReader, undefined);
  assert.equal(root.PostgresToolResultKeyCatalogRepository, undefined);
  assert.equal(
    runtime.PostgresToolResultKeyCatalogReader,
    authority.PostgresToolResultKeyCatalogReader,
  );
  assert.equal(runtime.PostgresToolResultKeyCatalogRepository, undefined);
  assert.equal(
    admin.PostgresToolResultKeyCatalogRepository,
    authority.PostgresToolResultKeyCatalogRepository,
  );
  assert.equal(admin.PostgresToolResultKeyCatalogReader, undefined);
  assert.equal(ingress.PostgresToolResultKeyCatalogReader, undefined);
  assert.equal(ingress.PostgresToolResultKeyCatalogRepository, undefined);
});

test('Tool result rekey splits runtime read from admin mutation authority', () => {
  const root = require('@qinglong/cluster-postgres');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  const admin = require('@qinglong/cluster-postgres/admin');
  const ingress = require('@qinglong/cluster-postgres/worker-ingress');
  const authority = require('@qinglong/cluster-postgres/tool-result-rekey');
  assert.equal(root.PostgresToolResultRekeyReader, undefined);
  assert.equal(root.PostgresToolResultRekeyRepository, undefined);
  assert.equal(
    runtime.PostgresToolResultRekeyReader,
    authority.PostgresToolResultRekeyReader,
  );
  assert.equal(runtime.PostgresToolResultRekeyRepository, undefined);
  assert.equal(
    admin.PostgresToolResultRekeyRepository,
    authority.PostgresToolResultRekeyRepository,
  );
  assert.equal(admin.PostgresToolResultRekeyReader, undefined);
  assert.equal(ingress.PostgresToolResultRekeyReader, undefined);
  assert.equal(ingress.PostgresToolResultRekeyRepository, undefined);
});

test('Approved Action authority is isolated behind its explicit subpath', () => {
  const root = require('@qinglong/cluster-postgres');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  const admin = require('@qinglong/cluster-postgres/admin');
  const ingress = require('@qinglong/cluster-postgres/worker-ingress');
  const authority = require('@qinglong/cluster-postgres/approved-action');
  assert.equal(root.PostgresApprovalRequestRepository, undefined);
  assert.equal(runtime.PostgresApprovalRequestRepository, undefined);
  assert.equal(admin.PostgresApprovalRequestRepository, undefined);
  assert.equal(ingress.PostgresApprovalRequestRepository, undefined);
  assert.equal(typeof authority.PostgresApprovalRequestRepository, 'function');
});

test('Approved Action execution authority is isolated behind its explicit subpath', () => {
  const root = require('@qinglong/cluster-postgres');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  const admin = require('@qinglong/cluster-postgres/admin');
  const ingress = require('@qinglong/cluster-postgres/worker-ingress');
  const packageExecutor = require('@qinglong/cluster-postgres/package-executor');
  const authority = require('@qinglong/cluster-postgres/approved-action-execution');
  assert.equal(root.PostgresApprovedActionExecutionRepository, undefined);
  assert.equal(runtime.PostgresApprovedActionExecutionRepository, undefined);
  assert.equal(admin.PostgresApprovedActionExecutionRepository, undefined);
  assert.equal(ingress.PostgresApprovedActionExecutionRepository, undefined);
  assert.equal(
    packageExecutor.PostgresApprovedActionExecutionRepository,
    authority.PostgresApprovedActionExecutionRepository,
  );
  assert.equal(
    typeof authority.PostgresApprovedActionExecutionRepository,
    'function',
  );
});

test('Plugin Package proposal authority is isolated behind its explicit subpath', () => {
  const root = require('@qinglong/cluster-postgres');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  const admin = require('@qinglong/cluster-postgres/admin');
  const ingress = require('@qinglong/cluster-postgres/worker-ingress');
  const authority = require('@qinglong/cluster-postgres/plugin-package-proposal');
  assert.equal(root.PostgresPluginPackageInstallProposalRepository, undefined);
  assert.equal(
    runtime.PostgresPluginPackageInstallProposalRepository,
    undefined,
  );
  assert.equal(admin.PostgresPluginPackageInstallProposalRepository, undefined);
  assert.equal(
    ingress.PostgresPluginPackageInstallProposalRepository,
    undefined,
  );
  assert.equal(
    typeof authority.PostgresPluginPackageInstallProposalRepository,
    'function',
  );
});

test('Plugin Package lifecycle authority is limited to package executor and its explicit subpath', () => {
  const root = require('@qinglong/cluster-postgres');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  const admin = require('@qinglong/cluster-postgres/admin');
  const manager = require('@qinglong/cluster-postgres/package-manager');
  const executor = require('@qinglong/cluster-postgres/package-executor');
  const ingress = require('@qinglong/cluster-postgres/worker-ingress');
  const authority = require('@qinglong/cluster-postgres/plugin-package-lifecycle');
  assert.equal(root.PostgresPluginPackageLifecycleRepository, undefined);
  assert.equal(runtime.PostgresPluginPackageLifecycleRepository, undefined);
  assert.equal(admin.PostgresPluginPackageLifecycleRepository, undefined);
  assert.equal(manager.PostgresPluginPackageLifecycleRepository, undefined);
  assert.equal(ingress.PostgresPluginPackageLifecycleRepository, undefined);
  assert.equal(
    executor.PostgresPluginPackageLifecycleRepository,
    authority.PostgresPluginPackageLifecycleRepository,
  );
  assert.equal(
    typeof authority.PostgresPluginPackageLifecycleRepository,
    'function',
  );
});
