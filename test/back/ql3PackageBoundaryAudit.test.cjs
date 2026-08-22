'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  auditPackageBoundaries,
} = require('../../scripts/ql3-package-boundary-audit.cjs');

const root = path.resolve(__dirname, '../..');
const fixtureInternalSourceLayout = Object.freeze({
  directSourceFileReviewThreshold: 12,
  reviewedDenseDirectories: Object.freeze([]),
});

function fixturePackage(
  fixtureRoot,
  directory,
  manifest,
  source = 'export {};\n',
  sourcePath = 'index.ts',
) {
  const packageRoot = path.join(fixtureRoot, 'packages', directory);
  const sourceFile = path.join(packageRoot, 'src', sourcePath);
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(sourceFile, source, {
    mode: 0o600,
  });
}

function fixtureLedger(fixtureRoot, value) {
  const docs = path.join(fixtureRoot, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  const ledgerPath = path.join(docs, 'ql3-package-boundaries.json');
  fs.writeFileSync(
    ledgerPath,
    `${JSON.stringify(
      {
        internalSourceLayout: fixtureInternalSourceLayout,
        ...value,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return ledgerPath;
}

test('current QL3 workspace has exactly eighteen reviewed package boundaries', () => {
  const report = auditPackageBoundaries({ root });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.schemaVersion, 6);
  assert.equal(report.workspacePackageCount, 18);
  assert.equal(report.workspacePackageHardCap, 18);
  assert.deepEqual(report.singleSourcePackages, []);
  assert.deepEqual(report.shallowSourcePackages, []);
  assert.deepEqual(
    report.denseSourceDirectories.map(
      ({ path: directory, directSourceFiles, reviewKind }) => ({
        directory,
        directSourceFiles,
        reviewKind,
      }),
    ),
    [
      {
        directory: 'packages/ql3-cluster-postgres/src/migrations',
        directSourceFiles: 65,
        reviewKind: 'ordered_ledger',
      },
      {
        directory: 'packages/ql3-local-sqlite/src/migrations',
        directSourceFiles: 101,
        reviewKind: 'ordered_ledger',
      },
    ],
  );
  assert.equal(report.packages.length, 18);
  const localAdmin = report.packages.find(
    ({ name }) => name === '@qinglong/local-admin',
  );
  assert.deepEqual(
    {
      sourceFiles: localAdmin.sourceFiles,
      rootSourceFiles: localAdmin.rootSourceFiles,
      rootSourceLines: localAdmin.rootSourceLines,
      nestedSourceFiles: localAdmin.nestedSourceFiles,
      rootSourceFileRoles: localAdmin.rootSourceFileRoles,
    },
    {
      sourceFiles: 47,
      rootSourceFiles: 1,
      rootSourceLines: 9,
      nestedSourceFiles: 46,
      rootSourceFileRoles: { 'runtime.ts': 'public_export' },
    },
  );
  const localAdminManifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'packages/ql3-local-admin/package.json'),
      'utf8',
    ),
  );
  assert.equal(
    localAdminManifest.exports['.'].require,
    './dist/legacy-adoption/localSqliteAdoption.js',
  );
  assert.equal(
    localAdminManifest.exports['./adopted-profile'].require,
    './dist/adopted-profile/localAdoptedProfile.js',
  );
  const localApi = report.packages.find(
    ({ name }) => name === '@qinglong/local-api',
  );
  assert.deepEqual(
    {
      sourceFiles: localApi.sourceFiles,
      rootSourceFiles: localApi.rootSourceFiles,
      rootSourceLines: localApi.rootSourceLines,
      nestedSourceFiles: localApi.nestedSourceFiles,
      rootSourceFileRoles: localApi.rootSourceFileRoles,
    },
    {
      sourceFiles: 17,
      rootSourceFiles: 1,
      rootSourceLines: 84,
      nestedSourceFiles: 16,
      rootSourceFileRoles: { 'cli.ts': 'binary_entry' },
    },
  );
  assert.equal(
    fs.existsSync(path.join(root, 'packages/ql3-local-admin/src/index.ts')),
    false,
  );
  assert.deepEqual(
    report.packages.find(({ name }) => name === '@qinglong/local-execution'),
    {
      path: 'packages/ql3-local-execution',
      name: '@qinglong/local-execution',
      sourceFiles: 22,
      rootSourceFiles: 0,
      rootSourceLines: 0,
      nestedSourceFiles: 22,
      rootSourceFileHardCap: 0,
      rootSourceLineHardCap: 0,
      rootSourceFileRoles: {},
      shallowSourceLayoutKind: null,
      sourceLines: report.packages.find(
        ({ name }) => name === '@qinglong/local-execution',
      ).sourceLines,
      consumers: ['@qinglong/local-application'],
    },
  );
  const localOwnerConsole = report.packages.find(
    ({ name }) => name === '@qinglong/local-owner-console',
  );
  assert.deepEqual(
    {
      sourceFiles: localOwnerConsole.sourceFiles,
      rootSourceFiles: localOwnerConsole.rootSourceFiles,
      rootSourceLines: localOwnerConsole.rootSourceLines,
      nestedSourceFiles: localOwnerConsole.nestedSourceFiles,
      rootSourceFileRoles: localOwnerConsole.rootSourceFileRoles,
    },
    {
      sourceFiles: 19,
      rootSourceFiles: 0,
      rootSourceLines: 0,
      nestedSourceFiles: 19,
      rootSourceFileRoles: {},
    },
  );
  const localOwnerConsoleManifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'packages/ql3-local-owner-console/package.json'),
      'utf8',
    ),
  );
  assert.equal(
    localOwnerConsoleManifest.exports['.'].require,
    './dist/application-runtime/localOwnerConsole.js',
  );
  assert.equal(
    fs.existsSync(
      path.join(root, 'packages/ql3-local-owner-console/src/index.ts'),
    ),
    false,
  );
  const localOwnerCli = report.packages.find(
    ({ name }) => name === '@qinglong/local-owner-cli',
  );
  assert.deepEqual(
    {
      sourceFiles: localOwnerCli.sourceFiles,
      rootSourceFiles: localOwnerCli.rootSourceFiles,
      rootSourceLines: localOwnerCli.rootSourceLines,
      nestedSourceFiles: localOwnerCli.nestedSourceFiles,
      rootSourceFileRoles: localOwnerCli.rootSourceFileRoles,
    },
    {
      sourceFiles: 165,
      rootSourceFiles: 1,
      rootSourceLines: 50,
      nestedSourceFiles: 164,
      rootSourceFileRoles: { 'cli.ts': 'binary_entry' },
    },
  );
  const localOwnerCliManifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'packages/ql3-local-owner-cli/package.json'),
      'utf8',
    ),
  );
  assert.equal(
    localOwnerCliManifest.exports['.'].require,
    './dist/application-command/localOwnerCommand.js',
  );
  assert.equal(
    fs.existsSync(path.join(root, 'packages/ql3-local-owner-cli/src/index.ts')),
    false,
  );
  const localOwnerMaintenance = report.packages.find(
    ({ name }) => name === '@qinglong/local-owner-maintenance',
  );
  assert.deepEqual(
    {
      sourceFiles: localOwnerMaintenance.sourceFiles,
      rootSourceFiles: localOwnerMaintenance.rootSourceFiles,
      rootSourceLines: localOwnerMaintenance.rootSourceLines,
      nestedSourceFiles: localOwnerMaintenance.nestedSourceFiles,
      rootSourceFileRoles: localOwnerMaintenance.rootSourceFileRoles,
    },
    {
      sourceFiles: 6,
      rootSourceFiles: 1,
      rootSourceLines: 50,
      nestedSourceFiles: 5,
      rootSourceFileRoles: { 'cli.ts': 'binary_entry' },
    },
  );
  const localOwnerMaintenanceManifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'packages/ql3-local-owner-maintenance/package.json'),
      'utf8',
    ),
  );
  assert.equal(
    localOwnerMaintenanceManifest.exports['./command'].require,
    './dist/application-command/localOwnerMaintenanceCommand.js',
  );
  assert.equal(
    fs.existsSync(
      path.join(root, 'packages/ql3-local-owner-maintenance/src/command.ts'),
    ),
    false,
  );
  assert.deepEqual(
    report.packages.find(({ name }) => name === '@qinglong/ai'),
    {
      path: 'packages/ql3-ai',
      name: '@qinglong/ai',
      sourceFiles: 194,
      rootSourceFiles: 1,
      rootSourceLines: 16,
      nestedSourceFiles: 193,
      rootSourceFileHardCap: 1,
      rootSourceLineHardCap: 16,
      rootSourceFileRoles: {
        'index.ts': 'public_export',
      },
      shallowSourceLayoutKind: null,
      sourceLines: report.packages.find(({ name }) => name === '@qinglong/ai')
        .sourceLines,
      consumers: [
        '@qinglong/cluster-admin',
        '@qinglong/cluster-control',
        '@qinglong/local-owner-cli',
      ],
    },
  );
  const runtimeCore = report.packages.find(
    ({ name }) => name === '@qinglong/runtime-core',
  );
  assert.deepEqual(
    {
      sourceFiles: runtimeCore.sourceFiles,
      rootSourceFiles: runtimeCore.rootSourceFiles,
      rootSourceLines: runtimeCore.rootSourceLines,
      nestedSourceFiles: runtimeCore.nestedSourceFiles,
      rootSourceFileRoles: runtimeCore.rootSourceFileRoles,
    },
    {
      sourceFiles: 171,
      rootSourceFiles: 1,
      rootSourceLines: 160,
      nestedSourceFiles: 170,
      rootSourceFileRoles: { 'index.ts': 'public_export' },
    },
  );
  const runtimeCoreManifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'packages/ql3-runtime-core/package.json'),
      'utf8',
    ),
  );
  assert.equal(
    runtimeCoreManifest.exports['./migration-stream'].require,
    './dist/migration/migrationStream.js',
  );
  for (const oldRootFile of [
    'migrationStream.ts',
    'pinnedSemver.ts',
    'postgresql.ts',
  ]) {
    assert.equal(
      fs.existsSync(
        path.join(root, 'packages/ql3-runtime-core/src', oldRootFile),
      ),
      false,
    );
  }
  const clusterAdmin = report.packages.find(
    ({ name }) => name === '@qinglong/cluster-admin',
  );
  assert.deepEqual(
    {
      sourceFiles: clusterAdmin.sourceFiles,
      rootSourceFiles: clusterAdmin.rootSourceFiles,
      rootSourceLines: clusterAdmin.rootSourceLines,
      nestedSourceFiles: clusterAdmin.nestedSourceFiles,
      rootSourceFileRoles: clusterAdmin.rootSourceFileRoles,
    },
    {
      sourceFiles: 129,
      rootSourceFiles: 1,
      rootSourceLines: 61,
      nestedSourceFiles: 128,
      rootSourceFileRoles: {
        'modelInvocationMigrationCli.ts': 'binary_entry',
      },
    },
  );
  const clusterAdminManifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'packages/ql3-cluster-admin/package.json'),
      'utf8',
    ),
  );
  assert.equal(
    clusterAdminManifest.exports['.'].require,
    './dist/application-runtime/clusterAdminRuntime.js',
  );
  assert.equal(
    clusterAdminManifest.exports['./administration'].require,
    './dist/security-administration/clusterAdministration.js',
  );
  assert.equal(
    fs.existsSync(path.join(root, 'packages/ql3-cluster-admin/src/index.ts')),
    false,
  );
  assert.equal(
    fs.existsSync(
      path.join(root, 'packages/ql3-cluster-admin/src/administration.ts'),
    ),
    false,
  );
  const clusterControl = report.packages.find(
    ({ name }) => name === '@qinglong/cluster-control',
  );
  assert.deepEqual(
    {
      sourceFiles: clusterControl.sourceFiles,
      rootSourceFiles: clusterControl.rootSourceFiles,
      rootSourceLines: clusterControl.rootSourceLines,
      nestedSourceFiles: clusterControl.nestedSourceFiles,
      rootSourceFileRoles: clusterControl.rootSourceFileRoles,
    },
    {
      sourceFiles: 65,
      rootSourceFiles: 2,
      rootSourceLines: 195,
      nestedSourceFiles: 63,
      rootSourceFileRoles: {
        'aiCli.ts': 'binary_entry',
        'cli.ts': 'binary_entry',
      },
    },
  );
  const clusterControlManifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'packages/ql3-cluster-control/package.json'),
      'utf8',
    ),
  );
  assert.equal(
    clusterControlManifest.exports['.'].require,
    './dist/application-runtime/clusterControlRuntime.js',
  );
  assert.equal(
    fs.existsSync(path.join(root, 'packages/ql3-cluster-control/src/index.ts')),
    false,
  );
  const clusterPostgres = report.packages.find(
    ({ name }) => name === '@qinglong/cluster-postgres',
  );
  assert.deepEqual(
    {
      sourceFiles: clusterPostgres.sourceFiles,
      rootSourceFiles: clusterPostgres.rootSourceFiles,
      rootSourceLines: clusterPostgres.rootSourceLines,
      nestedSourceFiles: clusterPostgres.nestedSourceFiles,
      rootSourceFileRoles: clusterPostgres.rootSourceFileRoles,
    },
    {
      sourceFiles: 175,
      rootSourceFiles: 1,
      rootSourceLines: 126,
      nestedSourceFiles: 174,
      rootSourceFileRoles: { 'index.ts': 'public_export' },
    },
  );
  const clusterPostgresManifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'packages/ql3-cluster-postgres/package.json'),
      'utf8',
    ),
  );
  assert.equal(
    clusterPostgresManifest.exports['./runtime'].require,
    './dist/entrypoints/runtime.js',
  );
  for (const oldRootFile of [
    'admin.ts',
    'aiCredentialManager.ts',
    'aiCredentialTester.ts',
    'aiMaintenance.ts',
    'automationManager.ts',
    'packageExecutor.ts',
    'packageManager.ts',
    'runtime.ts',
    'workerIngress.ts',
  ]) {
    assert.equal(
      fs.existsSync(
        path.join(root, 'packages/ql3-cluster-postgres/src', oldRootFile),
      ),
      false,
    );
  }
  const workerRuntime = report.packages.find(
    ({ name }) => name === '@qinglong/worker-runtime',
  );
  assert.deepEqual(
    {
      sourceFiles: workerRuntime.sourceFiles,
      rootSourceFiles: workerRuntime.rootSourceFiles,
      rootSourceLines: workerRuntime.rootSourceLines,
      nestedSourceFiles: workerRuntime.nestedSourceFiles,
      rootSourceFileRoles: workerRuntime.rootSourceFileRoles,
    },
    {
      sourceFiles: 32,
      rootSourceFiles: 1,
      rootSourceLines: 8,
      nestedSourceFiles: 31,
      rootSourceFileRoles: { 'index.ts': 'public_export' },
    },
  );
  const workerRuntimeManifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'packages/ql3-worker-runtime/package.json'),
      'utf8',
    ),
  );
  assert.equal(
    workerRuntimeManifest.exports['./production'].require,
    './dist/application-runtime/productionHeadlessApplication.js',
  );
  assert.equal(
    workerRuntimeManifest.exports['./product'].require,
    './dist/application-runtime/productionWorkerApplication.js',
  );
  assert.equal(
    fs.existsSync(
      path.join(
        root,
        'packages/ql3-worker-runtime/src/productionHeadlessApplication.ts',
      ),
    ),
    false,
  );
  const localMcpServer = report.packages.find(
    ({ name }) => name === '@qinglong/local-mcp-server',
  );
  assert.deepEqual(
    {
      sourceFiles: localMcpServer.sourceFiles,
      rootSourceFiles: localMcpServer.rootSourceFiles,
      rootSourceLines: localMcpServer.rootSourceLines,
      nestedSourceFiles: localMcpServer.nestedSourceFiles,
      rootSourceFileRoles: localMcpServer.rootSourceFileRoles,
      consumers: localMcpServer.consumers,
    },
    {
      sourceFiles: 12,
      rootSourceFiles: 1,
      rootSourceLines: 96,
      nestedSourceFiles: 11,
      rootSourceFileRoles: { 'cli.ts': 'binary_entry' },
      consumers: [],
    },
  );
  assert.equal(
    fs.existsSync(
      path.join(
        root,
        'packages/ql3-worker-runtime/src/productionWorkerApplication.ts',
      ),
    ),
    false,
  );
  const localSqlite = report.packages.find(
    ({ name }) => name === '@qinglong/local-sqlite',
  );
  assert.deepEqual(
    {
      sourceFiles: localSqlite.sourceFiles,
      rootSourceFiles: localSqlite.rootSourceFiles,
      rootSourceLines: localSqlite.rootSourceLines,
      nestedSourceFiles: localSqlite.nestedSourceFiles,
      rootSourceFileRoles: localSqlite.rootSourceFileRoles,
    },
    {
      sourceFiles: 203,
      rootSourceFiles: 1,
      rootSourceLines: 31,
      nestedSourceFiles: 202,
      rootSourceFileRoles: { 'index.ts': 'public_export' },
    },
  );
  const localSqliteManifest = JSON.parse(
    fs.readFileSync(
      path.join(root, 'packages/ql3-local-sqlite/package.json'),
      'utf8',
    ),
  );
  assert.equal(
    localSqliteManifest.exports['./runtime'].require,
    './dist/runtime/runtimeDatabase.js',
  );
  assert.equal(
    localSqliteManifest.exports['./profile'].require,
    './dist/profile/localProfile.js',
  );
  assert.equal(
    localSqliteManifest.exports['./adoption'].require,
    './dist/adoption/legacyAdoptionDatabase.js',
  );
  assert.equal(
    fs.existsSync(path.join(root, 'packages/ql3-local-sqlite/src/runtime.ts')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(root, 'packages/ql3-local-sqlite/src/adoption.ts')),
    false,
  );
});

test('rejects an undeclared workspace package and a stale boundary', (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-package-boundary-'),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fixturePackage(fixtureRoot, 'ql3-new', {
    name: '@qinglong/new',
    version: '3.0.0-alpha.0',
  });
  const ledgerPath = fixtureLedger(fixtureRoot, {
    schemaVersion: 6,
    workspacePackageHardCap: 1,
    packages: [
      {
        path: 'packages/ql3-removed',
        name: '@qinglong/removed',
        rootSourceFileHardCap: 1,
        criteria: ['deployable'],
        profiles: ['test'],
        consumers: [],
        artifacts: ['test'],
        rationale: 'This stale fixture must be rejected.',
      },
    ],
  });
  const report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.equal(report.compatible, false);
  assert.deepEqual(report.findings.map((item) => item.code).sort(), [
    'PACKAGE_BOUNDARY_STALE_PACKAGE',
    'PACKAGE_BOUNDARY_UNDECLARED_PACKAGE',
  ]);
});

test('rejects consumer drift and an unjustified two-file package', (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-package-boundary-'),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fixturePackage(
    fixtureRoot,
    'ql3-leaf',
    {
      name: '@qinglong/leaf',
      version: '3.0.0-alpha.0',
    },
    'export {};\n',
    'adapter/index.ts',
  );
  fs.writeFileSync(
    path.join(fixtureRoot, 'packages/ql3-leaf/src/adapter/codec.ts'),
    'export {};\n',
    { mode: 0o600 },
  );
  fixturePackage(fixtureRoot, 'ql3-consumer', {
    name: '@qinglong/consumer',
    version: '3.0.0-alpha.0',
    dependencies: { '@qinglong/leaf': 'workspace:*' },
    bin: { consumer: 'dist/index.js' },
  });
  const ledgerPath = fixtureLedger(fixtureRoot, {
    schemaVersion: 6,
    workspacePackageHardCap: 2,
    packages: [
      {
        path: 'packages/ql3-consumer',
        name: '@qinglong/consumer',
        rootSourceFileHardCap: 1,
        rootSourceLineHardCap: 2,
        rootSourceFileRoles: { 'index.ts': 'binary_entry' },
        shallowSourceLayout: {
          kind: 'public_entrypoints',
          rationale:
            'The only source is the reviewed fixture binary entrypoint.',
        },
        criteria: ['deployable'],
        profiles: ['test'],
        consumers: [],
        rationale: 'This fixture is an independently deployed binary.',
      },
      {
        path: 'packages/ql3-leaf',
        name: '@qinglong/leaf',
        rootSourceFileHardCap: 1,
        rootSourceLineHardCap: 0,
        rootSourceFileRoles: {},
        criteria: ['replaceable_adapter'],
        profiles: ['test'],
        consumers: [],
        adapterContract: 'This is a narrow fixture adapter contract.',
        rationale: 'This fixture deliberately lacks a thin-package reason.',
      },
    ],
  });
  const report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.equal(report.compatible, false);
  assert.deepEqual(report.findings.map((item) => item.code).sort(), [
    'PACKAGE_BOUNDARY_CONSUMER_DRIFT',
    'PACKAGE_BOUNDARY_THIN_PACKAGE_UNJUSTIFIED',
  ]);
});

test('rejects growth in a reviewed package source root', (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-package-boundary-'),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fixturePackage(fixtureRoot, 'ql3-app', {
    name: '@qinglong/app',
    version: '3.0.0-alpha.0',
    bin: { app: 'dist/index.js' },
  });
  fs.writeFileSync(
    path.join(fixtureRoot, 'packages/ql3-app/src/newImplementation.ts'),
    'export {};\n',
    { mode: 0o600 },
  );
  const ledgerPath = fixtureLedger(fixtureRoot, {
    schemaVersion: 6,
    workspacePackageHardCap: 1,
    packages: [
      {
        path: 'packages/ql3-app',
        name: '@qinglong/app',
        rootSourceFileHardCap: 1,
        rootSourceLineHardCap: 4,
        rootSourceFileRoles: { 'index.ts': 'binary_entry' },
        shallowSourceLayout: {
          kind: 'public_entrypoints',
          rationale:
            'The only reviewed root source is the fixture binary entrypoint.',
        },
        criteria: ['deployable'],
        profiles: ['test'],
        consumers: [],
        rationale: 'This fixture is an independently deployed binary.',
      },
    ],
  });
  const report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.equal(report.compatible, false);
  assert.deepEqual(report.findings, [
    {
      code: 'PACKAGE_SOURCE_ROOT_HARD_CAP_EXCEEDED',
      packagePath: 'packages/ql3-app',
      message: '2 root source files exceed cap 1',
    },
    {
      code: 'PACKAGE_SOURCE_ROOT_ROLE_DRIFT',
      packagePath: 'packages/ql3-app',
      message:
        'expected ["index.ts"], found ["index.ts","newImplementation.ts"]',
    },
  ]);
});

test('rejects implementation growth hidden behind a reviewed root entrypoint', (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-package-boundary-'),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fixturePackage(
    fixtureRoot,
    'ql3-app',
    {
      name: '@qinglong/app',
      version: '3.0.0-alpha.0',
      bin: { app: 'dist/index.js' },
    },
    'export {};\nconst hiddenImplementation = true;\n',
  );
  const ledgerPath = fixtureLedger(fixtureRoot, {
    schemaVersion: 6,
    workspacePackageHardCap: 1,
    packages: [
      {
        path: 'packages/ql3-app',
        name: '@qinglong/app',
        rootSourceFileHardCap: 1,
        rootSourceLineHardCap: 2,
        rootSourceFileRoles: { 'index.ts': 'binary_entry' },
        shallowSourceLayout: {
          kind: 'public_entrypoints',
          rationale: 'The fixture source is the reviewed binary entrypoint.',
        },
        criteria: ['deployable'],
        profiles: ['test'],
        consumers: [],
        rationale: 'This fixture is an independently deployed binary.',
      },
    ],
  });

  const report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.equal(report.compatible, false);
  assert.deepEqual(report.findings, [
    {
      code: 'PACKAGE_SOURCE_ROOT_LINE_HARD_CAP_EXCEEDED',
      packagePath: 'packages/ql3-app',
      message: '3 root source lines exceed cap 2',
    },
  ]);
});

test('rejects implementation masquerading as a public export', (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-package-boundary-'),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fixturePackage(
    fixtureRoot,
    'ql3-adapter',
    {
      name: '@qinglong/adapter',
      version: '3.0.0-alpha.0',
      main: 'dist/index.js',
    },
    'export function hiddenImplementation() { return true; }\n',
  );
  const nestedSource = path.join(
    fixtureRoot,
    'packages/ql3-adapter/src/domain/adapter.ts',
  );
  fs.mkdirSync(path.dirname(nestedSource), { recursive: true });
  fs.writeFileSync(nestedSource, 'export {};\n', { mode: 0o600 });
  const ledgerPath = fixtureLedger(fixtureRoot, {
    schemaVersion: 6,
    workspacePackageHardCap: 1,
    packages: [
      {
        path: 'packages/ql3-adapter',
        name: '@qinglong/adapter',
        rootSourceFileHardCap: 1,
        rootSourceLineHardCap: 2,
        rootSourceFileRoles: { 'index.ts': 'public_export' },
        criteria: ['authority', 'replaceable_adapter'],
        profiles: ['test'],
        consumers: [],
        authorities: ['fixture public export review'],
        adapterContract: 'This fixture has one replaceable adapter contract.',
        rationale: 'Public labels cannot hide implementation declarations.',
      },
    ],
  });

  const report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.equal(report.compatible, false);
  assert.deepEqual(report.findings, [
    {
      code: 'PACKAGE_SOURCE_ROOT_PUBLIC_EXPORT_IMPLEMENTATION',
      packagePath: 'packages/ql3-adapter',
      message: 'index.ts must contain only re-export declarations',
    },
  ]);
});

test('rejects dishonest root roles and incomplete shallow layout evidence', (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-package-boundary-'),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  for (const name of ['flat', 'lie', 'stale', 'weak']) {
    fixturePackage(fixtureRoot, `ql3-${name}`, {
      name: `@qinglong/${name}`,
      version: '3.0.0-alpha.0',
      main: 'dist/index.js',
    });
  }
  const staleNested = path.join(
    fixtureRoot,
    'packages/ql3-stale/src/domain/implementation.ts',
  );
  const lieNested = path.join(
    fixtureRoot,
    'packages/ql3-lie/src/domain/implementation.ts',
  );
  fs.mkdirSync(path.dirname(staleNested), { recursive: true });
  fs.mkdirSync(path.dirname(lieNested), { recursive: true });
  fs.writeFileSync(staleNested, 'export {};\n', { mode: 0o600 });
  fs.writeFileSync(lieNested, 'export {};\n', { mode: 0o600 });

  const publicEntry = {
    rootSourceFileHardCap: 1,
    rootSourceLineHardCap: 2,
    rootSourceFileRoles: { 'index.ts': 'public_export' },
    criteria: ['deployable'],
    profiles: ['test'],
    consumers: [],
    artifacts: ['test'],
    rationale: 'This fixture represents a reviewed public product entrypoint.',
  };
  const ledgerPath = fixtureLedger(fixtureRoot, {
    schemaVersion: 6,
    workspacePackageHardCap: 4,
    packages: [
      {
        path: 'packages/ql3-flat',
        name: '@qinglong/flat',
        ...publicEntry,
      },
      {
        path: 'packages/ql3-lie',
        name: '@qinglong/lie',
        ...publicEntry,
        rootSourceFileRoles: { 'index.ts': 'binary_entry' },
      },
      {
        path: 'packages/ql3-stale',
        name: '@qinglong/stale',
        ...publicEntry,
        shallowSourceLayout: {
          kind: 'public_entrypoints',
          rationale:
            'This exception is stale after a nested implementation appears.',
        },
      },
      {
        path: 'packages/ql3-weak',
        name: '@qinglong/weak',
        ...publicEntry,
        shallowSourceLayout: {
          kind: 'shared_protocol',
          rationale: 'This claims protocol reuse without shared-leaf evidence.',
        },
      },
    ],
  });

  const report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.equal(report.compatible, false);
  assert.deepEqual(
    report.findings.map(({ code, packagePath }) => [code, packagePath]).sort(),
    [
      ['PACKAGE_SOURCE_ROOT_ROLE_UNPROVEN', 'packages/ql3-lie'],
      ['PACKAGE_SOURCE_SHALLOW_LAYOUT_MISSING', 'packages/ql3-flat'],
      ['PACKAGE_SOURCE_SHALLOW_LAYOUT_STALE', 'packages/ql3-stale'],
      ['PACKAGE_SOURCE_SHALLOW_LAYOUT_MISSING', 'packages/ql3-weak'],
    ].sort(),
  );
});

test('requires artifact entrypoint and dependency firewall proof for shallow packages', (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-package-boundary-'),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  fixturePackage(fixtureRoot, 'ql3-profile', {
    name: '@qinglong/profile',
    version: '3.0.0-alpha.0',
    main: 'dist/index.js',
    exports: {
      '.': './dist/index.js',
      './edge': './dist/edge.js',
      './standalone': './dist/standalone.js',
    },
  });
  fs.writeFileSync(
    path.join(fixtureRoot, 'packages/ql3-profile/src/edge.ts'),
    'export {};\n',
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(fixtureRoot, 'packages/ql3-profile/src/standalone.ts'),
    'export {};\n',
    { mode: 0o600 },
  );
  fixturePackage(
    fixtureRoot,
    'ql3-application',
    {
      name: '@qinglong/application',
      version: '3.0.0-alpha.0',
      dependencies: {
        '@qinglong/profile': 'workspace:*',
        'heavy-runtime': '1.0.0',
      },
      bin: { application: 'dist/application/index.js' },
    },
    'export {};\n',
    'application/index.ts',
  );

  const profileBoundary = {
    path: 'packages/ql3-profile',
    name: '@qinglong/profile',
    rootSourceFileHardCap: 3,
    rootSourceLineHardCap: 6,
    rootSourceFileRoles: {
      'edge.ts': 'public_export',
      'index.ts': 'public_export',
      'standalone.ts': 'public_export',
    },
    shallowSourceLayout: {
      kind: 'public_entrypoints',
      rationale: 'Three public fixture entrypoints represent two artifacts.',
    },
    criteria: ['deployable'],
    profiles: ['edge', 'standalone'],
    consumers: ['@qinglong/application'],
    artifacts: ['edge', 'standalone'],
    rationale:
      'The fixture profile is intentionally artifact-only and shallow.',
  };
  const applicationBoundary = {
    path: 'packages/ql3-application',
    name: '@qinglong/application',
    rootSourceFileHardCap: 0,
    rootSourceLineHardCap: 0,
    rootSourceFileRoles: {},
    criteria: ['deployable'],
    profiles: ['application'],
    consumers: [],
    rationale: 'The fixture application is an independently deployed binary.',
  };

  let ledgerPath = fixtureLedger(fixtureRoot, {
    schemaVersion: 6,
    workspacePackageHardCap: 2,
    packages: [applicationBoundary, profileBoundary],
  });
  let report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.equal(report.compatible, false);
  assert.deepEqual(report.findings.map(({ code }) => code).sort(), [
    'PACKAGE_SOURCE_SHALLOW_ARTIFACT_ENTRYPOINTS_UNPROVEN',
    'PACKAGE_SOURCE_SHALLOW_DEPENDENCY_FIREWALL_UNPROVEN',
  ]);

  profileBoundary.shallowSourceLayout = {
    artifactEntrypoints: {
      edge: './edge',
      standalone: './standalone',
    },
    closureDelta: {
      comparedWith: '@qinglong/application',
      excludedDependencies: ['not-in-consumer'],
    },
    kind: 'public_entrypoints',
    rationale: 'Three public fixture entrypoints represent two artifacts.',
  };
  ledgerPath = fixtureLedger(fixtureRoot, {
    schemaVersion: 6,
    workspacePackageHardCap: 2,
    packages: [applicationBoundary, profileBoundary],
  });
  report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.equal(report.compatible, false);
  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['PACKAGE_SOURCE_SHALLOW_DEPENDENCY_FIREWALL_UNPROVEN'],
  );

  profileBoundary.shallowSourceLayout.closureDelta.excludedDependencies = [
    'heavy-runtime',
  ];
  profileBoundary.shallowSourceLayout.closureDelta.comparedWith =
    '@qinglong/profile';
  ledgerPath = fixtureLedger(fixtureRoot, {
    schemaVersion: 6,
    workspacePackageHardCap: 2,
    packages: [applicationBoundary, profileBoundary],
  });
  report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.equal(report.compatible, false);
  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['PACKAGE_SOURCE_SHALLOW_DEPENDENCY_FIREWALL_UNPROVEN'],
  );

  profileBoundary.shallowSourceLayout.closureDelta.comparedWith =
    '@qinglong/application';
  profileBoundary.shallowSourceLayout.artifactEntrypoints.edge = './router';
  ledgerPath = fixtureLedger(fixtureRoot, {
    schemaVersion: 6,
    workspacePackageHardCap: 2,
    packages: [applicationBoundary, profileBoundary],
  });
  report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.equal(report.compatible, false);
  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['PACKAGE_SOURCE_SHALLOW_ARTIFACT_ENTRYPOINTS_UNPROVEN'],
  );

  profileBoundary.shallowSourceLayout.artifactEntrypoints.edge = './edge';
  ledgerPath = fixtureLedger(fixtureRoot, {
    schemaVersion: 6,
    workspacePackageHardCap: 2,
    packages: [applicationBoundary, profileBoundary],
  });
  report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));

  fs.writeFileSync(
    path.join(fixtureRoot, 'packages/ql3-profile/src/hidden.ts'),
    'export {};\n',
    { mode: 0o600 },
  );
  report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.equal(report.compatible, false);
  assert.deepEqual(report.findings.map(({ code }) => code).sort(), [
    'PACKAGE_SOURCE_ROOT_HARD_CAP_EXCEEDED',
    'PACKAGE_SOURCE_ROOT_LINE_HARD_CAP_EXCEEDED',
    'PACKAGE_SOURCE_ROOT_ROLE_DRIFT',
    'PACKAGE_SOURCE_SHALLOW_ARTIFACT_ENTRYPOINTS_UNPROVEN',
  ]);
});

test('freezes dense internal source directories until ownership is reviewed', (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-package-boundary-'),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fixturePackage(
    fixtureRoot,
    'ql3-adapter',
    {
      name: '@qinglong/adapter',
      version: '3.0.0-alpha.0',
    },
    'export const one = 1;\n',
    'domain/one.ts',
  );
  for (const name of ['two', 'three']) {
    fs.writeFileSync(
      path.join(fixtureRoot, `packages/ql3-adapter/src/domain/${name}.ts`),
      `export const ${name} = true;\n`,
      { mode: 0o600 },
    );
  }
  const boundary = {
    path: 'packages/ql3-adapter',
    name: '@qinglong/adapter',
    rootSourceFileHardCap: 0,
    rootSourceLineHardCap: 0,
    rootSourceFileRoles: {},
    criteria: ['authority', 'replaceable_adapter'],
    profiles: ['test'],
    consumers: [],
    authorities: ['fixture dense-directory review'],
    adapterContract: 'This fixture represents one replaceable adapter.',
    rationale: 'Dense package internals need explicit ownership review.',
  };
  const sourceLayout = {
    directSourceFileReviewThreshold: 3,
    reviewedDenseDirectories: [],
  };
  let ledgerPath = fixtureLedger(fixtureRoot, {
    schemaVersion: 6,
    workspacePackageHardCap: 1,
    internalSourceLayout: sourceLayout,
    packages: [boundary],
  });
  let report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['PACKAGE_SOURCE_DENSE_DIRECTORY_UNREVIEWED'],
  );

  sourceLayout.reviewedDenseDirectories = [
    {
      kind: 'ownership_review',
      maxDirectSourceFiles: 3,
      path: 'packages/ql3-adapter/src/domain',
      rationale:
        'The fixture domain is frozen until its responsibilities are split.',
    },
  ];
  ledgerPath = fixtureLedger(fixtureRoot, {
    schemaVersion: 6,
    workspacePackageHardCap: 1,
    internalSourceLayout: sourceLayout,
    packages: [boundary],
  });
  report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));

  fs.writeFileSync(
    path.join(fixtureRoot, 'packages/ql3-adapter/src/domain/four.ts'),
    'export const four = true;\n',
    { mode: 0o600 },
  );
  report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['PACKAGE_SOURCE_DENSE_DIRECTORY_HARD_CAP_EXCEEDED'],
  );

  for (const name of ['three', 'four']) {
    fs.rmSync(
      path.join(fixtureRoot, `packages/ql3-adapter/src/domain/${name}.ts`),
    );
  }
  report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['PACKAGE_SOURCE_DENSE_DIRECTORY_REVIEW_STALE'],
  );
});

test('requires an exact internal source layout policy', (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-package-boundary-'),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fixturePackage(
    fixtureRoot,
    'ql3-adapter',
    {
      name: '@qinglong/adapter',
      version: '3.0.0-alpha.0',
      bin: { adapter: 'dist/domain/index.js' },
    },
    'export {};\n',
    'domain/index.ts',
  );
  const ledgerPath = fixtureLedger(fixtureRoot, {
    schemaVersion: 6,
    workspacePackageHardCap: 1,
    internalSourceLayout: null,
    packages: [
      {
        path: 'packages/ql3-adapter',
        name: '@qinglong/adapter',
        rootSourceFileHardCap: 0,
        rootSourceLineHardCap: 0,
        rootSourceFileRoles: {},
        criteria: ['deployable'],
        profiles: ['test'],
        consumers: [],
        rationale: 'A missing internal layout policy must fail closed.',
      },
    ],
  });
  const report = auditPackageBoundaries({ root: fixtureRoot, ledgerPath });
  assert.deepEqual(
    report.findings.map(({ code }) => code),
    ['PACKAGE_SOURCE_INTERNAL_LAYOUT_POLICY_INVALID'],
  );
});
