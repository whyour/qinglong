const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  auditPackageFiles,
  auditPackageScripts,
  auditRegisteredPackageImporters,
  auditSourceImports,
  listQingLong3PackageImporters,
} = require('../../scripts/ql3-cluster-dependency-audit.cjs');

test('ships runtime JavaScript and declarations without development maps', () => {
  for (const [packagePath, files] of [
    ['packages/ql3-runtime-core', ['dist/**/*.js', 'dist/**/*.d.ts']],
    [
      'packages/ql3-local-api',
      ['assets/console/*', 'dist/**/*.js', 'dist/**/*.d.ts'],
    ],
    [
      'packages/ql3-cluster-admin',
      ['dist/**/*.js', 'dist/**/*.d.ts', 'assets/copilot-console/*'],
    ],
    [
      'packages/ql3-local-process',
      ['dist/**/*.js', 'dist/**/*.d.ts', 'assets'],
    ],
    [
      'packages/ql3-local-sqlite',
      ['dist/**/*.js', 'dist/**/*.d.ts', 'drizzle'],
    ],
  ]) {
    const findings = [];
    auditPackageFiles(packagePath, { files }, findings);
    assert.deepEqual(findings, []);
  }
  const findings = [];
  auditPackageFiles('packages/ql3-runtime-core', { files: ['dist'] }, findings);
  assert.deepEqual(findings, [
    {
      code: 'QL3_PACKAGE_PRODUCTION_FILES_INVALID',
      packagePath: 'packages/ql3-runtime-core',
      expected: ['dist/**/*.js', 'dist/**/*.d.ts'],
      actual: ['dist'],
    },
  ]);
});

test('package build scripts compile self and delegate dev closure builds', () => {
  const valid = {
    scripts: {
      build: 'tsc -p tsconfig.json',
      check:
        'node ../../scripts/ql3-build-package-closure.cjs && tsc -p tsconfig.json --noEmit',
      test: 'node ../../scripts/ql3-build-package-closure.cjs && node --test test/*.test.cjs',
    },
  };
  const validFindings = [];
  auditPackageScripts('packages/ql3-example', valid, validFindings);
  assert.deepEqual(validFindings, []);

  const findings = [];
  auditPackageScripts(
    'packages/ql3-example',
    {
      scripts: {
        prebuild: 'pnpm --filter @qinglong/runtime-core build',
        build:
          'pnpm --filter @qinglong/runtime-core build && tsc -p tsconfig.json',
        check: 'tsc -p tsconfig.json --noEmit',
        test: 'node --test test/*.test.cjs',
      },
    },
    findings,
  );
  assert.deepEqual(
    findings.map(({ code, lifecycle }) => ({ code, lifecycle })),
    [
      { code: 'QL3_PACKAGE_BUILD_NOT_SELF_ONLY', lifecycle: undefined },
      { code: 'QL3_PACKAGE_RECURSIVE_LIFECYCLE', lifecycle: 'prebuild' },
      {
        code: 'QL3_PACKAGE_CHECK_WITHOUT_CLOSURE_BUILD',
        lifecycle: undefined,
      },
      {
        code: 'QL3_PACKAGE_TEST_WITHOUT_CLOSURE_BUILD',
        lifecycle: 'test',
      },
      {
        code: 'QL3_PACKAGE_HANDWRITTEN_RECURSIVE_BUILD',
        lifecycle: 'prebuild',
      },
      {
        code: 'QL3_PACKAGE_HANDWRITTEN_RECURSIVE_BUILD',
        lifecycle: 'build',
      },
    ],
  );
});

function fixture(t, packagePath, source, sourcePath = 'index.ts') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-dependency-audit-'));
  const sourceDirectory = path.join(root, packagePath, 'src');
  const sourceFile = path.join(sourceDirectory, sourcePath);
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, source);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('confines Secret/Config application authority to reviewed composition files', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-secret-config-application-boundary-'),
  );
  const sources = {
    'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config/application/coordinator.ts':
      [
        "import { prepare } from '@qinglong/local-admin/reconciliation-secret-and-config-application';",
        "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
        "import { keyring } from '@qinglong/local-secret';",
        "import { read } from '@qinglong/local-sqlite/authentication-read';",
        "import { backup } from '@qinglong/local-sqlite/rollout-safety';",
        "import type { Principal } from '@qinglong/runtime-core/security';",
      ].join('\n'),
    'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config/application/evidence.ts':
      "import type { Backup } from '@qinglong/local-sqlite/rollout-safety';",
    'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config/application/storage.ts':
      "import type { Material } from '@qinglong/local-admin/reconciliation-secret-and-config-application';",
    'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config/application/widened.ts':
      [
        "import { prepare } from '@qinglong/local-admin/reconciliation-secret-and-config-application';",
        "import { backup } from '@qinglong/local-sqlite/rollout-safety';",
        "import type { Principal } from '@qinglong/runtime-core/security';",
      ].join('\n'),
    'packages/ql3-local-admin/src/legacy-adoption/secret-and-config/reconciliationSecretConfigApplication.ts':
      [
        "import { apply } from '@qinglong/local-sqlite/secret-config-application';",
        "import { envelope } from '@qinglong/runtime-core/local-secret';",
        "import { policy } from '@qinglong/runtime-core/project-policy';",
        "import { principal } from '@qinglong/runtime-core/security';",
        "import { audit } from '@qinglong/runtime-core/security-audit';",
      ].join('\n'),
    'packages/ql3-local-admin/src/legacy-adoption/secret-and-config/widened.ts':
      [
        "import { apply } from '@qinglong/local-sqlite/secret-config-application';",
        "import { policy } from '@qinglong/runtime-core/project-policy';",
      ].join('\n'),
  };
  for (const [relativePath, source] of Object.entries(sources)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  auditSourceImports(root, 'packages/ql3-local-admin', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config/application/widened.ts',
        specifier:
          '@qinglong/local-admin/reconciliation-secret-and-config-application',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config/application/widened.ts',
        specifier: '@qinglong/local-sqlite/rollout-safety',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config/application/widened.ts',
        specifier: '@qinglong/runtime-core/security',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADMIN_SQLITE_ENTRYPOINT',
        file: 'packages/ql3-local-admin/src/legacy-adoption/secret-and-config/widened.ts',
        specifier: '@qinglong/local-sqlite/secret-config-application',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
        file: 'packages/ql3-local-admin/src/legacy-adoption/secret-and-config/widened.ts',
        specifier: '@qinglong/runtime-core/project-policy',
      },
    ],
  );
});

test('accepts package-local and declared forward source imports', (t) => {
  const root = fixture(
    t,
    'packages/ql3-cluster-postgres',
    [
      "import type { PostgresPool } from '@qinglong/runtime-core';",
      "import { Pool } from 'pg';",
      "export { schema } from './schema';",
    ].join('\n'),
  );
  const findings = [];
  assert.equal(
    auditSourceImports(root, 'packages/ql3-cluster-postgres', findings),
    1,
  );
  assert.deepEqual(findings, []);
});

test('confines local Run management authority to reviewed retry and stop commands', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-run-management-boundary-'),
  );
  const sourceDirectory = path.join(
    root,
    'packages/ql3-local-owner-cli/src/run-management',
  );
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDirectory, 'runRetryCommand.ts'),
    [
      "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
      "import { fence } from '@qinglong/local-sqlite/authenticated-management';",
      "import { database } from '@qinglong/local-sqlite/run-management';",
      "import { policy } from '@qinglong/runtime-core/project-policy';",
      "import { retry } from '@qinglong/runtime-core/run-manual-retry';",
      "import { audit } from '@qinglong/runtime-core/security-audit';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(sourceDirectory, 'runStopCommand.ts'),
    [
      "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
      "import { fence } from '@qinglong/local-sqlite/authenticated-management';",
      "import { database } from '@qinglong/local-sqlite/run-management';",
      "import { policy } from '@qinglong/runtime-core/project-policy';",
      "import { stop } from '@qinglong/runtime-core/run-cancellation';",
      "import { audit } from '@qinglong/runtime-core/security-audit';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(sourceDirectory, 'widenedRunCommand.ts'),
    [
      "import { database } from '@qinglong/local-sqlite/run-management';",
      "import { stop } from '@qinglong/runtime-core/run-cancellation';",
    ].join('\n'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/run-management/widenedRunCommand.ts',
        specifier: '@qinglong/local-sqlite/run-management',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/run-management/widenedRunCommand.ts',
        specifier: '@qinglong/runtime-core/run-cancellation',
      },
    ],
  );
});

test('confines local MCP to its reviewed protocol and read-authority subpaths', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-mcp-server',
    [
      "import { McpServer } from '@modelcontextprotocol/server';",
      "import { serveStdio } from '@modelcontextprotocol/server/stdio';",
      "import { read } from '@qinglong/local-command-file';",
      "import { logs } from '@qinglong/local-command-file/artifact-read';",
      "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
      "import { open } from '@qinglong/local-sqlite/mcp-read-database';",
      "import type { approvals } from '@qinglong/runtime-core/approval-discovery';",
      "import { approval } from '@qinglong/runtime-core/approved-action';",
      "import { runs } from '@qinglong/runtime-core/bounded-run-list-projection';",
      "import { run } from '@qinglong/runtime-core/run';",
      "import { compare } from '@qinglong/runtime-core/builtin-run-compare-projection';",
      "import { excerpt } from '@qinglong/runtime-core/builtin-run-log-excerpt-projection';",
      "import { outcomes } from '@qinglong/runtime-core/builtin-task-run-outcome-compare-projection';",
      "import { tool } from '@qinglong/runtime-core/builtin-run-read-projection';",
      "import { logRead } from '@qinglong/runtime-core/run-attempt-log-read';",
      "import { window } from '@qinglong/runtime-core/task-run-outcome-window';",
      "import { tasks } from '@qinglong/runtime-core/bounded-task-list-projection';",
      "import { task } from '@qinglong/runtime-core/bounded-task-read-projection';",
      "import { trigger } from '@qinglong/runtime-core/trigger';",
      "import { forbidden } from '@qinglong/local-owner-console/pepper-custody/destructive';",
      "import { widened } from '@qinglong/local-sqlite/authenticated-management';",
    ].join('\n'),
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-mcp-server', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_MCP_SERVER_AUTHORITY_IMPORT',
        specifier: '@qinglong/local-owner-console/pepper-custody/destructive',
      },
      {
        code: 'FORBIDDEN_LOCAL_MCP_SERVER_AUTHORITY_IMPORT',
        specifier: '@qinglong/local-sqlite/authenticated-management',
      },
    ],
  );
});

test('confines private local file authority to the reviewed log-read contract', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-command-file',
    [
      "import type { range } from '@qinglong/runtime-core/run-attempt-log-read';",
      "import { forbidden } from '@qinglong/runtime-core/security';",
    ].join('\n'),
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-command-file', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_FILE_AUTHORITY_IMPORT',
        specifier: '@qinglong/runtime-core/security',
      },
    ],
  );
});

test('confines Croner to deployment-owned schedule adapters', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-croner-provider-boundary-'),
  );
  const localDirectory = path.join(
    root,
    'packages/ql3-local-execution/src/scheduler',
  );
  const clusterDirectory = path.join(
    root,
    'packages/ql3-cluster-control/src/scheduling',
  );
  fs.mkdirSync(localDirectory, { recursive: true });
  fs.mkdirSync(clusterDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(localDirectory, 'croner.ts'),
    "const provider = require('croner');",
  );
  fs.writeFileSync(
    path.join(localDirectory, 'widened.ts'),
    "const forbidden = require('croner');",
  );
  fs.writeFileSync(
    path.join(clusterDirectory, 'cronerSchedule.ts'),
    "const provider = require('croner');",
  );
  fs.writeFileSync(
    path.join(clusterDirectory, 'scheduler.ts'),
    "const forbidden = require('croner');",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-execution', findings);
  auditSourceImports(root, 'packages/ql3-cluster-control', findings);
  assert.deepEqual(
    findings.map(({ code, file }) => ({ code, file })),
    [
      {
        code: 'FORBIDDEN_CRONER_PROVIDER_IMPORT',
        file: 'packages/ql3-local-execution/src/scheduler/widened.ts',
      },
      {
        code: 'FORBIDDEN_CRONER_PROVIDER_IMPORT',
        file: 'packages/ql3-cluster-control/src/scheduling/scheduler.ts',
      },
    ],
  );
});

test('confines SemVer to the runtime-core pinned provider adapter', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-semver-provider-boundary-'),
  );
  const coreDirectory = path.join(root, 'packages/ql3-runtime-core/src');
  const versioningDirectory = path.join(coreDirectory, 'versioning');
  const workerDirectory = path.join(root, 'packages/ql3-worker-runtime/src');
  fs.mkdirSync(versioningDirectory, { recursive: true });
  fs.mkdirSync(workerDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(versioningDirectory, 'pinnedSemver.ts'),
    "const provider = require('semver');",
  );
  fs.writeFileSync(
    path.join(coreDirectory, 'widened.ts'),
    "const forbidden = require('semver');",
  );
  fs.writeFileSync(
    path.join(workerDirectory, 'semver.ts'),
    "const forbidden = require('semver');",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-runtime-core', findings);
  auditSourceImports(root, 'packages/ql3-worker-runtime', findings);
  assert.deepEqual(
    findings.map(({ code, file }) => ({ code, file })),
    [
      {
        code: 'FORBIDDEN_SEMVER_PROVIDER_IMPORT',
        file: 'packages/ql3-runtime-core/src/widened.ts',
      },
      {
        code: 'FORBIDDEN_SEMVER_PROVIDER_IMPORT',
        file: 'packages/ql3-worker-runtime/src/semver.ts',
      },
    ],
  );
});

test('limits local-admin runtime-core access to exact authority subpaths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-admin-boundary-'));
  const sourceDirectory = path.join(root, 'packages/ql3-local-admin/src');
  const legacyAdoptionDirectory = path.join(sourceDirectory, 'legacy-adoption');
  const pluginPackageDirectory = path.join(sourceDirectory, 'plugin-package');
  const securityAdministrationDirectory = path.join(
    sourceDirectory,
    'security-administration',
  );
  fs.mkdirSync(legacyAdoptionDirectory, { recursive: true });
  fs.mkdirSync(pluginPackageDirectory, { recursive: true });
  fs.mkdirSync(securityAdministrationDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(legacyAdoptionDirectory, 'legacyCrontabAdoption.ts'),
    [
      "import { createBuiltInTaskSpecSemanticRegistry } from '@qinglong/runtime-core/task-spec-semantic';",
      "import type { TaskDefinitionSpec } from '@qinglong/runtime-core/task-definition';",
      "import { createBuiltInTriggerSpecSemanticRegistry } from '@qinglong/runtime-core/trigger';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(legacyAdoptionDirectory, 'legacyCrontabDecisionReceipt.ts'),
    "import { normalizeSecurityPrincipal } from '@qinglong/runtime-core/security';",
  );
  fs.writeFileSync(
    path.join(
      legacyAdoptionDirectory,
      'legacyCrontabDecisionAuthorizationFile.ts',
    ),
    "import type { LocalSecretKeyProvider } from '@qinglong/runtime-core/local-secret';",
  );
  fs.writeFileSync(
    path.join(legacyAdoptionDirectory, 'legacyCrontabDecisionIssuerKeyring.ts'),
    "import type { LocalSecretKeyProvider } from '@qinglong/runtime-core/local-secret';",
  );
  fs.writeFileSync(
    path.join(legacyAdoptionDirectory, 'legacyCrontabPublisher.ts'),
    [
      "import { openLocalSqliteAdoptionDatabase } from '@qinglong/local-sqlite/adoption';",
      "import type { LocalSecretKeyProvider } from '@qinglong/runtime-core/local-secret';",
      "import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';",
      "import type { SecurityPolicyDecision } from '@qinglong/runtime-core/security';",
      "import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pluginPackageDirectory, 'pluginPackageStaging.ts'),
    [
      "import { manifest } from '@qinglong/runtime-core/plugin-package';",
      "import { inspect } from '@qinglong/runtime-core/plugin-package-bundle';",
      "import { lock } from '@qinglong/runtime-core/plugin-package-install';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pluginPackageDirectory, 'pluginPackageRecoveryCatalog.ts'),
    [
      "import { manifest } from '@qinglong/runtime-core/plugin-package';",
      "import { inspect } from '@qinglong/runtime-core/plugin-package-bundle';",
      "import { lock } from '@qinglong/runtime-core/plugin-package-install';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pluginPackageDirectory, 'pluginPackagePublisherTrust.ts'),
    "import { trust } from '@qinglong/runtime-core/plugin-package-bundle';",
  );
  fs.writeFileSync(
    path.join(pluginPackageDirectory, 'pluginPackageActivation.ts'),
    [
      "import { publisher } from '@qinglong/runtime-core/plugin-package-activation';",
      "import { receipt } from '@qinglong/runtime-core/plugin-package-install';",
      "import type { generation } from '@qinglong/runtime-core/plugin-package-resource-generation';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pluginPackageDirectory, 'pluginPackageInstallation.ts'),
    [
      "import { manifest } from '@qinglong/runtime-core/plugin-package';",
      "import { publisher } from '@qinglong/runtime-core/plugin-package-activation';",
      "import { bundle } from '@qinglong/runtime-core/plugin-package-bundle';",
      "import { lock } from '@qinglong/runtime-core/plugin-package-install';",
      "import { coordinator } from '@qinglong/runtime-core/plugin-package-installation';",
      "import type { admission } from '@qinglong/runtime-core/plugin-package-admission';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pluginPackageDirectory, 'pluginPackageApprovedAction.ts'),
    [
      "import { dispatcher } from '@qinglong/runtime-core/approved-action-dispatcher';",
      "import { handler } from '@qinglong/runtime-core/plugin-package-approved-action';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pluginPackageDirectory, 'pluginPackageManagement.ts'),
    [
      "import type { dispatcher } from '@qinglong/runtime-core/approved-action-dispatcher';",
      "import { management } from '@qinglong/runtime-core/plugin-package-management';",
      "import { policy } from '@qinglong/runtime-core/project-policy';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(
      securityAdministrationDirectory,
      'projectPolicyAdministration.ts',
    ),
    [
      "import type { repository } from '@qinglong/runtime-core/local-project-policy-administration';",
      "import { policy } from '@qinglong/runtime-core/project-policy';",
      "import { principal } from '@qinglong/runtime-core/security';",
      "import { audit } from '@qinglong/runtime-core/security-audit';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(sourceDirectory, 'unrelatedAdmin.ts'),
    [
      "import { dispatcher } from '@qinglong/runtime-core/approved-action-dispatcher';",
      "import { handler } from '@qinglong/runtime-core/plugin-package-approved-action';",
      "import { management } from '@qinglong/runtime-core/plugin-package-management';",
      "import { policy } from '@qinglong/runtime-core/project-policy';",
      "import { inspect } from '@qinglong/runtime-core/plugin-package-bundle';",
      "import { coordinator } from '@qinglong/runtime-core/plugin-package-installation';",
      "import type { generation } from '@qinglong/runtime-core/plugin-package-resource-generation';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(sourceDirectory, 'unknownStagingAuthority.ts'),
    "import { forbidden } from '@qinglong/runtime-core/plugin-package-activation';",
  );
  fs.writeFileSync(
    path.join(sourceDirectory, 'index.ts'),
    "import { forbidden } from '@qinglong/runtime-core';",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-admin', findings);
  assert.deepEqual(findings, [
    {
      code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
      packagePath: 'packages/ql3-local-admin',
      file: 'packages/ql3-local-admin/src/index.ts',
      specifier: '@qinglong/runtime-core',
    },
    {
      code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
      packagePath: 'packages/ql3-local-admin',
      file: 'packages/ql3-local-admin/src/unknownStagingAuthority.ts',
      specifier: '@qinglong/runtime-core/plugin-package-activation',
    },
    {
      code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
      packagePath: 'packages/ql3-local-admin',
      file: 'packages/ql3-local-admin/src/unrelatedAdmin.ts',
      specifier: '@qinglong/runtime-core/approved-action-dispatcher',
    },
    {
      code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
      packagePath: 'packages/ql3-local-admin',
      file: 'packages/ql3-local-admin/src/unrelatedAdmin.ts',
      specifier: '@qinglong/runtime-core/plugin-package-approved-action',
    },
    {
      code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
      packagePath: 'packages/ql3-local-admin',
      file: 'packages/ql3-local-admin/src/unrelatedAdmin.ts',
      specifier: '@qinglong/runtime-core/plugin-package-management',
    },
    {
      code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
      packagePath: 'packages/ql3-local-admin',
      file: 'packages/ql3-local-admin/src/unrelatedAdmin.ts',
      specifier: '@qinglong/runtime-core/project-policy',
    },
    {
      code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
      packagePath: 'packages/ql3-local-admin',
      file: 'packages/ql3-local-admin/src/unrelatedAdmin.ts',
      specifier: '@qinglong/runtime-core/plugin-package-bundle',
    },
    {
      code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
      packagePath: 'packages/ql3-local-admin',
      file: 'packages/ql3-local-admin/src/unrelatedAdmin.ts',
      specifier: '@qinglong/runtime-core/plugin-package-installation',
    },
    {
      code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
      packagePath: 'packages/ql3-local-admin',
      file: 'packages/ql3-local-admin/src/unrelatedAdmin.ts',
      specifier: '@qinglong/runtime-core/plugin-package-resource-generation',
    },
  ]);
});

test('enumerates every ql3 package importer that must be reviewed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-package-list-'));
  for (const packageName of ['ql3-runtime-core', 'ql3-new-profile']) {
    fs.mkdirSync(path.join(root, 'packages', packageName), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'packages', packageName, 'package.json'),
      '{}',
    );
  }
  fs.mkdirSync(path.join(root, 'packages', 'legacy-package'), {
    recursive: true,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(listQingLong3PackageImporters(root), [
    'packages/ql3-new-profile',
    'packages/ql3-runtime-core',
  ]);
  const findings = [];
  auditRegisteredPackageImporters(root, findings);
  assert.deepEqual(findings, [
    {
      code: 'UNREVIEWED_QL3_PACKAGE_IMPORTER',
      packagePath: 'packages/ql3-new-profile',
    },
  ]);
});

test('allows only reviewed runtime PostgreSQL entrypoints in cluster-control', (t) => {
  const root = fixture(
    t,
    'packages/ql3-cluster-control',
    [
      "import { PostgresRunRepository } from '@qinglong/cluster-postgres/runtime';",
      "import { Publications } from '@qinglong/cluster-postgres/plugin-package-automation-publication';",
      "import { Revisions } from '@qinglong/cluster-postgres/plugin-package-materialized-revision';",
      "import { Workflows } from '@qinglong/cluster-postgres/plugin-package-workflow-administration';",
      "import { TaskStart } from '@qinglong/cluster-postgres/task-start';",
      "import { runPostgresMigrations } from '@qinglong/cluster-postgres/migration';",
      "import { ql3Schema } from '@qinglong/cluster-postgres';",
    ].join('\n'),
    'application-runtime/clusterControlRuntime.ts',
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-cluster-control', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_CLUSTER_CONTROL_POSTGRES_ENTRYPOINT',
        specifier: '@qinglong/cluster-postgres/migration',
      },
      {
        code: 'FORBIDDEN_CLUSTER_CONTROL_POSTGRES_ENTRYPOINT',
        specifier: '@qinglong/cluster-postgres',
      },
    ],
  );
});

test('confines Workflow PostgreSQL assembly imports to the cluster-control composition root', (t) => {
  const root = fixture(
    t,
    'packages/ql3-cluster-control',
    "export { runtime } from '@qinglong/cluster-postgres/runtime';",
  );
  const workflowRoute = path.join(
    root,
    'packages/ql3-cluster-control/src/plugin-package/workflow/pluginPackageWorkflowRoute.ts',
  );
  fs.mkdirSync(path.dirname(workflowRoute), { recursive: true });
  fs.writeFileSync(
    workflowRoute,
    "import { Workflows } from '@qinglong/cluster-postgres/plugin-package-workflow-administration';",
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-cluster-control', findings);
  assert.deepEqual(findings, [
    {
      code: 'FORBIDDEN_CLUSTER_CONTROL_POSTGRES_ENTRYPOINT',
      packagePath: 'packages/ql3-cluster-control',
      file: 'packages/ql3-cluster-control/src/plugin-package/workflow/pluginPackageWorkflowRoute.ts',
      specifier:
        '@qinglong/cluster-postgres/plugin-package-workflow-administration',
    },
  ]);
});

test('confines AI schema migration authority to the one-shot cluster-admin CLI', (t) => {
  const root = fixture(
    t,
    'packages/ql3-cluster-admin',
    [
      "import { migrate } from '@qinglong/ai/model-invocation-migration';",
      "import { process } from '@qinglong/cluster-postgres/migration-process';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/modelInvocationMigrationCli.ts',
    ),
    [
      "import { migrate } from '@qinglong/ai/model-invocation-migration';",
      "import { process } from '@qinglong/cluster-postgres/migration-process';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/modelInvocationMigrationProcess.ts',
    ),
    [
      "import { migrate } from '@qinglong/ai/model-invocation-migration';",
      "import { process } from '@qinglong/cluster-postgres/migration-process';",
    ].join('\n'),
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-cluster-admin', findings);
  assert.deepEqual(
    findings.map(({ code, file }) => ({ code, file })),
    [
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_AI_ENTRYPOINT',
        file: 'packages/ql3-cluster-admin/src/index.ts',
      },
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_POSTGRES_ENTRYPOINT',
        file: 'packages/ql3-cluster-admin/src/index.ts',
      },
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_AI_ENTRYPOINT',
        file: 'packages/ql3-cluster-admin/src/modelInvocationMigrationProcess.ts',
      },
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_POSTGRES_ENTRYPOINT',
        file: 'packages/ql3-cluster-admin/src/modelInvocationMigrationProcess.ts',
      },
    ],
  );
});

test('confines external Prompt recovery AI authority to the offline verifier', (t) => {
  const recoveryAuthorization =
    '@qinglong/ai/plugin-package-prompt-output-external-recovery-authorization';
  const root = fixture(
    t,
    'packages/ql3-cluster-admin',
    `import { widened } from '${recoveryAuthorization}';`,
  );
  fs.mkdirSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/prompt-output/external-recovery',
    ),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/prompt-output/external-recovery/promptOutputExternalRecoveryInput.ts',
    ),
    [
      "import type { Artifact } from '@qinglong/ai/plugin-package-prompt-output-artifact';",
      "import type { Custody } from '@qinglong/ai/plugin-package-prompt-output-external-custody';",
      `import type { Authorization } from '${recoveryAuthorization}';`,
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/prompt-output/external-recovery/promptOutputExternalRecoveryVerifier.ts',
    ),
    `import { verify } from '${recoveryAuthorization}';`,
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/prompt-output/external-recovery/promptOutputExternalRecoveryNetwork.ts',
    ),
    `import { widened } from '${recoveryAuthorization}';`,
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-cluster-admin', findings);
  assert.deepEqual(
    findings.map(({ code, file }) => ({ code, file })),
    [
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_AI_ENTRYPOINT',
        file: 'packages/ql3-cluster-admin/src/index.ts',
      },
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_AI_ENTRYPOINT',
        file: 'packages/ql3-cluster-admin/src/prompt-output/external-recovery/promptOutputExternalRecoveryNetwork.ts',
      },
    ],
  );
});

test('cluster admin admits proposal and execution entrypoints only in the Package dispatcher', (t) => {
  const root = fixture(
    t,
    'packages/ql3-cluster-admin',
    [
      "import { readiness } from '@qinglong/cluster-postgres/admin';",
      "import { execution } from '@qinglong/cluster-postgres/approved-action-execution';",
      "import { approval } from '@qinglong/cluster-postgres/approved-action';",
      "import { repository } from '@qinglong/cluster-postgres/plugin-package-install';",
      "import { proposal } from '@qinglong/cluster-postgres/plugin-package-proposal';",
      "import { policy } from '@qinglong/cluster-postgres/project-policy';",
      "import { migrate } from '@qinglong/cluster-postgres/migration';",
      "import { widened } from '@qinglong/cluster-postgres';",
    ].join('\n'),
  );
  fs.mkdirSync(
    path.join(root, 'packages/ql3-cluster-admin/src/plugin-package/executor'),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/plugin-package/executor/pluginPackageApprovedAction.ts',
    ),
    [
      "import { execution } from '@qinglong/cluster-postgres/approved-action-execution';",
      "import { proposal } from '@qinglong/cluster-postgres/plugin-package-proposal';",
    ].join('\n'),
  );
  fs.mkdirSync(
    path.join(root, 'packages/ql3-cluster-admin/src/plugin-package/management'),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/plugin-package/management/pluginPackageManagement.ts',
    ),
    [
      "import { approval } from '@qinglong/cluster-postgres/approved-action';",
      "import { proposal } from '@qinglong/cluster-postgres/plugin-package-proposal';",
      "import { policy } from '@qinglong/cluster-postgres/project-policy';",
    ].join('\n'),
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-cluster-admin', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_POSTGRES_ENTRYPOINT',
        specifier: '@qinglong/cluster-postgres/approved-action-execution',
      },
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_POSTGRES_ENTRYPOINT',
        specifier: '@qinglong/cluster-postgres/approved-action',
      },
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_POSTGRES_ENTRYPOINT',
        specifier: '@qinglong/cluster-postgres/plugin-package-proposal',
      },
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_POSTGRES_ENTRYPOINT',
        specifier: '@qinglong/cluster-postgres/project-policy',
      },
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_POSTGRES_ENTRYPOINT',
        specifier: '@qinglong/cluster-postgres/migration',
      },
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_POSTGRES_ENTRYPOINT',
        specifier: '@qinglong/cluster-postgres',
      },
    ],
  );
});

test('confines Worker credential PostgreSQL authorities to their exact admin owners', (t) => {
  const root = fixture(
    t,
    'packages/ql3-cluster-admin',
    [
      "import { manager } from '@qinglong/cluster-postgres/worker-credential-manager';",
      "import { executor } from '@qinglong/cluster-postgres/worker-credential-executor';",
    ].join('\n'),
  );
  fs.mkdirSync(
    path.join(root, 'packages/ql3-cluster-admin/src/worker-credential'),
    { recursive: true },
  );
  fs.mkdirSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/worker-credential/management-server',
    ),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/worker-credential/management-server/workerCredentialManagement.ts',
    ),
    "import { manager } from '@qinglong/cluster-postgres/worker-credential-manager';",
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/worker-credential/workerCredentialManagementExecutor.ts',
    ),
    "import { executor } from '@qinglong/cluster-postgres/worker-credential-executor';",
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/worker-credential/management-server/workerCredentialManagementProcess.ts',
    ),
    "import { manager } from '@qinglong/cluster-postgres/worker-credential-manager';",
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/worker-credential/workerCredentialExecutorProcess.ts',
    ),
    "import { executor } from '@qinglong/cluster-postgres/worker-credential-executor';",
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-cluster-admin', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_POSTGRES_ENTRYPOINT',
        file: 'packages/ql3-cluster-admin/src/index.ts',
        specifier: '@qinglong/cluster-postgres/worker-credential-manager',
      },
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_POSTGRES_ENTRYPOINT',
        file: 'packages/ql3-cluster-admin/src/index.ts',
        specifier: '@qinglong/cluster-postgres/worker-credential-executor',
      },
    ],
  );
});

test('confines Automation management PostgreSQL authority to its process composition root', (t) => {
  const root = fixture(
    t,
    'packages/ql3-cluster-admin',
    "import { automation } from '@qinglong/cluster-postgres/automation-manager';",
  );
  fs.mkdirSync(
    path.join(root, 'packages/ql3-cluster-admin/src/automation-management'),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/automation-management/automationManagement.ts',
    ),
    "import { automation } from '@qinglong/cluster-postgres/automation-manager';",
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-cluster-admin/src/automation-management/automationManagementProcess.ts',
    ),
    "import { automation } from '@qinglong/cluster-postgres/automation-manager';",
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-cluster-admin', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_POSTGRES_ENTRYPOINT',
        file: 'packages/ql3-cluster-admin/src/automation-management/automationManagement.ts',
        specifier: '@qinglong/cluster-postgres/automation-manager',
      },
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_POSTGRES_ENTRYPOINT',
        file: 'packages/ql3-cluster-admin/src/index.ts',
        specifier: '@qinglong/cluster-postgres/automation-manager',
      },
    ],
  );
});

test('cluster admin admits exact PostgreSQL ports only in publisher approval consumers', (t) => {
  const root = fixture(
    t,
    'packages/ql3-cluster-admin',
    "import { forbidden } from '@qinglong/cluster-postgres/package-executor';",
  );
  const publisherDirectory = path.join(
    root,
    'packages/ql3-cluster-admin/src/plugin-package/publisher',
  );
  fs.mkdirSync(publisherDirectory, { recursive: true });
  for (const name of [
    'pluginPackagePublisherRevocationApprovalConsumer.ts',
    'pluginPackagePublisherTrustTransitionApprovalConsumer.ts',
  ]) {
    fs.writeFileSync(
      path.join(publisherDirectory, name),
      [
        "import { approval } from '@qinglong/cluster-postgres/approved-action';",
        "import { proposal } from '@qinglong/cluster-postgres/package-executor';",
        "import { policy } from '@qinglong/cluster-postgres/project-policy';",
      ].join('\n'),
    );
  }
  const findings = [];
  auditSourceImports(root, 'packages/ql3-cluster-admin', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_CLUSTER_ADMIN_POSTGRES_ENTRYPOINT',
        file: 'packages/ql3-cluster-admin/src/index.ts',
        specifier: '@qinglong/cluster-postgres/package-executor',
      },
    ],
  );
});

test('rejects package escapes and driver imports into runtime-core', (t) => {
  const clusterRoot = fixture(
    t,
    'packages/ql3-cluster-control',
    "export { bootstrap } from '../../../back/runtime/bootstrap';",
  );
  const clusterFindings = [];
  auditSourceImports(
    clusterRoot,
    'packages/ql3-cluster-control',
    clusterFindings,
  );
  assert.deepEqual(clusterFindings, [
    {
      code: 'PACKAGE_SOURCE_BOUNDARY_ESCAPE',
      packagePath: 'packages/ql3-cluster-control',
      file: 'packages/ql3-cluster-control/src/index.ts',
      specifier: '../../../back/runtime/bootstrap',
    },
  ]);

  const coreRoot = fixture(
    t,
    'packages/ql3-runtime-core',
    [
      "import { Pool } from 'pg';",
      "export { schema } from 'drizzle-orm/pg-core';",
      "export { opener } from '@qinglong/cluster-postgres';",
    ].join('\n'),
  );
  const coreFindings = [];
  auditSourceImports(coreRoot, 'packages/ql3-runtime-core', coreFindings);
  assert.deepEqual(
    coreFindings.map(({ code, specifier }) => ({ code, specifier })),
    [
      { code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT', specifier: 'pg' },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        specifier: 'drizzle-orm/pg-core',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        specifier: '@qinglong/cluster-postgres',
      },
    ],
  );
});

test('keeps the cluster Package management transport free of infrastructure authority', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-cluster-package-transport-boundary-'),
  );
  const adminSourceDirectory = path.join(
    root,
    'packages/ql3-cluster-admin/src',
  );
  const controlSourceDirectory = path.join(
    root,
    'packages/ql3-cluster-control/src',
  );
  fs.mkdirSync(adminSourceDirectory, { recursive: true });
  fs.mkdirSync(controlSourceDirectory, { recursive: true });
  const managementSupportDirectory = path.join(
    adminSourceDirectory,
    'management-support',
  );
  const pluginManagementDirectory = path.join(
    adminSourceDirectory,
    'plugin-package/management',
  );
  fs.mkdirSync(managementSupportDirectory, { recursive: true });
  fs.mkdirSync(pluginManagementDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(pluginManagementDirectory, 'pluginPackageManagementTransport.ts'),
    [
      "import type { Approval } from '@qinglong/runtime-core/approved-action';",
      "import type { Input } from '@qinglong/runtime-core/plugin-package-install';",
      "import type { Service } from '@qinglong/runtime-core/plugin-package-management';",
      "import type { Proposal } from '@qinglong/runtime-core/plugin-package-proposal';",
      "import type { Principal } from '@qinglong/runtime-core/security';",
      "import { Pool } from 'pg';",
      "import { schema } from 'drizzle-orm/pg-core';",
      "import { repository } from '@qinglong/cluster-postgres/admin';",
      "import { Core } from '@qinglong/runtime-core';",
      "import { request } from 'node:https';",
      "import { KubeConfig } from '@kubernetes/client-node';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(managementSupportDirectory, 'pluginPackageIdentityAssertion.ts'),
    [
      "import { verify } from 'node:crypto';",
      "import type { Principal } from '@qinglong/runtime-core/security';",
      "import { Pool } from 'pg';",
      "import { repository } from '@qinglong/cluster-postgres/admin';",
      "import { Core } from '@qinglong/runtime-core';",
      "import { request } from 'node:https';",
      "import { KubeConfig } from '@kubernetes/client-node';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(controlSourceDirectory, 'index.ts'),
    [
      "import { transport } from '@qinglong/cluster-admin/plugin-package-management-transport';",
      "import { identity } from '@qinglong/cluster-admin/plugin-package-identity-assertion';",
    ].join('\n'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const adminFindings = [];
  auditSourceImports(root, 'packages/ql3-cluster-admin', adminFindings);
  assert.deepEqual(
    adminFindings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_CLUSTER_PACKAGE_IDENTITY_INFRA_IMPORT',
        specifier: 'pg',
      },
      {
        code: 'FORBIDDEN_CLUSTER_PACKAGE_IDENTITY_INFRA_IMPORT',
        specifier: '@qinglong/cluster-postgres/admin',
      },
      {
        code: 'FORBIDDEN_CLUSTER_PACKAGE_IDENTITY_CORE_IMPORT',
        specifier: '@qinglong/runtime-core',
      },
      {
        code: 'FORBIDDEN_CLUSTER_PACKAGE_IDENTITY_INFRA_IMPORT',
        specifier: 'node:https',
      },
      {
        code: 'FORBIDDEN_CLUSTER_PACKAGE_IDENTITY_INFRA_IMPORT',
        specifier: '@kubernetes/client-node',
      },
      {
        code: 'FORBIDDEN_CLUSTER_PACKAGE_TRANSPORT_INFRA_IMPORT',
        specifier: 'pg',
      },
      {
        code: 'FORBIDDEN_CLUSTER_PACKAGE_TRANSPORT_INFRA_IMPORT',
        specifier: 'drizzle-orm/pg-core',
      },
      {
        code: 'FORBIDDEN_CLUSTER_PACKAGE_TRANSPORT_INFRA_IMPORT',
        specifier: '@qinglong/cluster-postgres/admin',
      },
      {
        code: 'FORBIDDEN_CLUSTER_PACKAGE_TRANSPORT_CORE_IMPORT',
        specifier: '@qinglong/runtime-core',
      },
      {
        code: 'FORBIDDEN_CLUSTER_PACKAGE_TRANSPORT_INFRA_IMPORT',
        specifier: 'node:https',
      },
      {
        code: 'FORBIDDEN_CLUSTER_PACKAGE_TRANSPORT_INFRA_IMPORT',
        specifier: '@kubernetes/client-node',
      },
    ],
  );

  const controlFindings = [];
  auditSourceImports(root, 'packages/ql3-cluster-control', controlFindings);
  assert.deepEqual(controlFindings, [
    {
      code: 'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_TRANSPORT_IMPORT',
      packagePath: 'packages/ql3-cluster-control',
      file: 'packages/ql3-cluster-control/src/index.ts',
      specifier: '@qinglong/cluster-admin/plugin-package-management-transport',
    },
    {
      code: 'FORBIDDEN_CLUSTER_PACKAGE_IDENTITY_ASSERTION_IMPORT',
      packagePath: 'packages/ql3-cluster-control',
      file: 'packages/ql3-cluster-control/src/index.ts',
      specifier: '@qinglong/cluster-admin/plugin-package-identity-assertion',
    },
  ]);
});

test('separates Package manager HTTP, identity trust and executor authority', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-cluster-package-management-process-boundary-'),
  );
  const adminSourceDirectory = path.join(
    root,
    'packages/ql3-cluster-admin/src',
  );
  const controlSourceDirectory = path.join(
    root,
    'packages/ql3-cluster-control/src',
  );
  fs.mkdirSync(adminSourceDirectory, { recursive: true });
  fs.mkdirSync(controlSourceDirectory, { recursive: true });
  const managementSupportDirectory = path.join(
    adminSourceDirectory,
    'management-support',
  );
  const pluginManagementDirectory = path.join(
    adminSourceDirectory,
    'plugin-package/management',
  );
  fs.mkdirSync(managementSupportDirectory, { recursive: true });
  fs.mkdirSync(pluginManagementDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(managementSupportDirectory, 'pluginPackageIdentityKeyset.ts'),
    [
      "import { open } from 'node:fs/promises';",
      "import { request } from 'node:https';",
      "import { Pool } from 'pg';",
      "import type { Core } from '@qinglong/runtime-core/security';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pluginManagementDirectory, 'pluginPackageManagement.ts'),
    [
      "import { proposal } from '@qinglong/cluster-postgres/plugin-package-proposal';",
      "import { execution } from '@qinglong/cluster-postgres/approved-action-execution';",
      "import { installation } from '@qinglong/cluster-postgres/plugin-package-install';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(managementSupportDirectory, 'pluginPackageManagementHttp.ts'),
    [
      "import { createServer } from 'node:https';",
      "import type { Management } from '@qinglong/runtime-core/plugin-package-management';",
      "import type { Principal } from '@qinglong/runtime-core/security';",
      "import { Pool } from 'pg';",
      "import { admin } from '@qinglong/cluster-postgres/admin';",
      "import { KubeConfig } from '@kubernetes/client-node';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pluginManagementDirectory, 'pluginPackageManagementProcess.ts'),
    [
      "import { manager } from '@qinglong/cluster-postgres/package-manager';",
      "import { executor } from '@qinglong/cluster-postgres/package-executor';",
      "import { admin } from '@qinglong/cluster-postgres/admin';",
      "import { Pool } from 'pg';",
      "import { KubeConfig } from '@kubernetes/client-node';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(controlSourceDirectory, 'index.ts'),
    [
      "import { keyset } from '@qinglong/cluster-admin/plugin-package-identity-keyset';",
      "import { http } from '@qinglong/cluster-admin/plugin-package-management-http';",
      "import { process } from '@qinglong/cluster-admin/plugin-package-management-process';",
    ].join('\n'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const adminFindings = [];
  auditSourceImports(root, 'packages/ql3-cluster-admin', adminFindings);
  assert.deepEqual(
    adminFindings.map(({ code, specifier }) => `${code}|${specifier}`).sort(),
    [
      'FORBIDDEN_CLUSTER_PACKAGE_IDENTITY_KEYSET_IMPORT|@qinglong/runtime-core/security',
      'FORBIDDEN_CLUSTER_PACKAGE_IDENTITY_KEYSET_IMPORT|node:https',
      'FORBIDDEN_CLUSTER_PACKAGE_IDENTITY_KEYSET_IMPORT|pg',
      'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_HTTP_CORE_IMPORT|@qinglong/runtime-core/security',
      'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_HTTP_INFRA_IMPORT|@kubernetes/client-node',
      'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_HTTP_INFRA_IMPORT|@qinglong/cluster-postgres/admin',
      'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_HTTP_INFRA_IMPORT|pg',
      'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_PROCESS_INFRA_IMPORT|@kubernetes/client-node',
      'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_PROCESS_INFRA_IMPORT|@qinglong/cluster-postgres/admin',
      'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_PROCESS_INFRA_IMPORT|@qinglong/cluster-postgres/package-executor',
      'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_PROCESS_INFRA_IMPORT|pg',
      'FORBIDDEN_CLUSTER_PACKAGE_MANAGER_EXECUTOR_IMPORT|@qinglong/cluster-postgres/approved-action-execution',
      'FORBIDDEN_CLUSTER_PACKAGE_MANAGER_EXECUTOR_IMPORT|@qinglong/cluster-postgres/plugin-package-install',
    ].sort(),
  );

  const controlFindings = [];
  auditSourceImports(root, 'packages/ql3-cluster-control', controlFindings);
  assert.deepEqual(
    controlFindings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_PROCESS_IMPORT',
        specifier: '@qinglong/cluster-admin/plugin-package-identity-keyset',
      },
      {
        code: 'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_PROCESS_IMPORT',
        specifier: '@qinglong/cluster-admin/plugin-package-management-http',
      },
      {
        code: 'FORBIDDEN_CLUSTER_PACKAGE_MANAGEMENT_PROCESS_IMPORT',
        specifier: '@qinglong/cluster-admin/plugin-package-management-process',
      },
    ],
  );
});

test('keeps the deleted local Secret admin package as a tombstone', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-application',
    "import { administer } from '@qinglong/local-secret-admin';",
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-application', findings);
  assert.deepEqual(findings, [
    {
      code: 'DELETED_LOCAL_SECRET_ADMIN_PACKAGE_IMPORT',
      packagePath: 'packages/ql3-local-application',
      file: 'packages/ql3-local-application/src/index.ts',
      specifier: '@qinglong/local-secret-admin',
    },
  ]);
});

test('confines local Secret administration to the reviewed Owner CLI command', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-owner-cli',
    "import { administer } from '@qinglong/local-admin/secret-administration';",
  );
  const rejected = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', rejected);
  assert.deepEqual(rejected, [
    {
      code: 'FORBIDDEN_LOCAL_SECRET_ADMIN_AUTHORITY_IMPORT',
      packagePath: 'packages/ql3-local-owner-cli',
      file: 'packages/ql3-local-owner-cli/src/index.ts',
      specifier: '@qinglong/local-admin/secret-administration',
    },
  ]);

  fs.writeFileSync(
    path.join(root, 'packages/ql3-local-owner-cli/src/index.ts'),
    '',
  );
  fs.mkdirSync(
    path.join(root, 'packages/ql3-local-owner-cli/src/security-management'),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-local-owner-cli/src/security-management/secretCommand.ts',
    ),
    [
      "import { read } from '@qinglong/local-command-file';",
      "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
      "import { keys } from '@qinglong/local-secret';",
      "import { administer } from '@qinglong/local-admin/secret-administration';",
      "import { fence } from '@qinglong/local-sqlite/authenticated-management';",
      "import { database } from '@qinglong/local-sqlite/secret-administration';",
      "import { secret } from '@qinglong/runtime-core/local-secret';",
      "import { authorization } from '@qinglong/runtime-core/local-secret-administration';",
      "import { audit } from '@qinglong/runtime-core/security-audit';",
    ].join('\n'),
  );
  const accepted = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', accepted);
  assert.deepEqual(accepted, []);
});

test('confines Project policy mutation authority to the reviewed Owner CLI command', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-application',
    [
      "import { service } from '@qinglong/local-admin/project-policy-administration';",
      "import { database } from '@qinglong/local-sqlite/project-policy-administration';",
    ].join('\n'),
  );
  const rejected = [];
  auditSourceImports(root, 'packages/ql3-local-application', rejected);
  assert.deepEqual(
    rejected.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_PROJECT_POLICY_ADMINISTRATION_IMPORT',
        specifier: '@qinglong/local-admin/project-policy-administration',
      },
      {
        code: 'FORBIDDEN_LOCAL_PROJECT_POLICY_ADMINISTRATION_IMPORT',
        specifier: '@qinglong/local-sqlite/project-policy-administration',
      },
    ],
  );

  const sourceDirectory = path.join(
    root,
    'packages/ql3-local-owner-cli/src/security-management',
  );
  fs.rmSync(path.join(root, 'packages/ql3-local-application'), {
    recursive: true,
    force: true,
  });
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDirectory, 'projectPolicyCommand.ts'),
    [
      "import { service } from '@qinglong/local-admin/project-policy-administration';",
      "import { read } from '@qinglong/local-command-file';",
      "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
      "import { fence } from '@qinglong/local-sqlite/authenticated-management';",
      "import { database } from '@qinglong/local-sqlite/project-policy-administration';",
      "import { authority } from '@qinglong/runtime-core/local-project-policy-administration';",
      "import { policy } from '@qinglong/runtime-core/project-policy';",
      "import { subject } from '@qinglong/runtime-core/security';",
      "import { audit } from '@qinglong/runtime-core/security-audit';",
    ].join('\n'),
  );
  const accepted = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', accepted);
  assert.deepEqual(accepted, []);
});

test('confines TaskDefinition administration to its exact service and Owner CLI command', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-task-definition-boundary-'),
  );
  const adminDirectory = path.join(root, 'packages/ql3-local-admin/src');
  const adminAutomationDirectory = path.join(
    adminDirectory,
    'automation-administration',
  );
  const cliDirectory = path.join(root, 'packages/ql3-local-owner-cli/src');
  const automationDirectory = path.join(cliDirectory, 'automation-management');
  fs.mkdirSync(adminDirectory, { recursive: true });
  fs.mkdirSync(adminAutomationDirectory, { recursive: true });
  fs.mkdirSync(cliDirectory, { recursive: true });
  fs.mkdirSync(automationDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(adminAutomationDirectory, 'taskDefinitionAdministration.ts'),
    [
      "import { policy } from '@qinglong/runtime-core/project-policy';",
      "import { principal } from '@qinglong/runtime-core/security';",
      "import { audit } from '@qinglong/runtime-core/security-audit';",
      "import { task } from '@qinglong/runtime-core/task-definition';",
      "import { mutation } from '@qinglong/runtime-core/task-definition-administration';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(adminDirectory, 'widened.ts'),
    "import { forbidden } from '@qinglong/runtime-core/task-definition-administration';",
  );
  fs.writeFileSync(
    path.join(automationDirectory, 'taskDefinitionCommand.ts'),
    [
      "import { service } from '@qinglong/local-admin/task-definition-administration';",
      "import { read } from '@qinglong/local-command-file';",
      "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
      "import { fence } from '@qinglong/local-sqlite/authenticated-management';",
      "import { database } from '@qinglong/local-sqlite/task-definition-administration';",
      "import { audit } from '@qinglong/runtime-core/security-audit';",
      "import { task } from '@qinglong/runtime-core/task-definition';",
      "import { mutation } from '@qinglong/runtime-core/task-definition-administration';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(cliDirectory, 'widened.ts'),
    [
      "import { service } from '@qinglong/local-admin/task-definition-administration';",
      "import { mutation } from '@qinglong/runtime-core/task-definition-administration';",
    ].join('\n'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-admin', findings);
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
        file: 'packages/ql3-local-admin/src/widened.ts',
        specifier: '@qinglong/runtime-core/task-definition-administration',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/widened.ts',
        specifier: '@qinglong/local-admin/task-definition-administration',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/widened.ts',
        specifier: '@qinglong/runtime-core/task-definition-administration',
      },
    ],
  );
});

test('confines Plugin Package Workflow administration to its exact service and Owner CLI command', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-plugin-package-workflow-boundary-'),
  );
  const adminDirectory = path.join(root, 'packages/ql3-local-admin/src');
  const adminPluginPackageDirectory = path.join(
    adminDirectory,
    'plugin-package',
  );
  const cliDirectory = path.join(root, 'packages/ql3-local-owner-cli/src');
  const pluginPackageDirectory = path.join(cliDirectory, 'plugin-package');
  const pluginPackageCommandDirectory = path.join(
    pluginPackageDirectory,
    'plugin-package-workflow-command',
  );
  fs.mkdirSync(adminDirectory, { recursive: true });
  fs.mkdirSync(adminPluginPackageDirectory, { recursive: true });
  fs.mkdirSync(pluginPackageCommandDirectory, { recursive: true });
  const runtimeCoreSpecifiers = [
    'plugin-package-automation-publication',
    'plugin-package-resource-materialization',
    'plugin-package-workflow-administration',
    'plugin-package-workflow-execution-plan',
    'project-policy',
    'security',
    'security-audit',
    'task-spec-semantic',
  ];
  fs.writeFileSync(
    path.join(
      adminPluginPackageDirectory,
      'pluginPackageWorkflowAdministration.ts',
    ),
    runtimeCoreSpecifiers
      .map(
        (specifier, index) =>
          `import { accepted${index} } from '@qinglong/runtime-core/${specifier}';`,
      )
      .join('\n'),
  );
  fs.writeFileSync(
    path.join(adminDirectory, 'widened.ts'),
    "import { forbidden } from '@qinglong/runtime-core/plugin-package-workflow-administration';",
  );
  const cliAuthorities = {
    'codecAuthority.ts': ['@qinglong/local-command-file'],
    'contractAuthority.ts': [
      '@qinglong/local-admin/plugin-package-workflow-administration',
      '@qinglong/local-owner-console/authenticated-command',
      '@qinglong/local-sqlite/plugin-package-workflow-administration',
      '@qinglong/runtime-core/plugin-package-workflow-administration',
    ],
    'supportAuthority.ts': [
      '@qinglong/local-sqlite/authenticated-management',
      '@qinglong/runtime-core/plugin-package-workflow-execution-plan',
      '@qinglong/runtime-core/security-audit',
    ],
  };
  for (const [file, specifiers] of Object.entries(cliAuthorities)) {
    fs.writeFileSync(
      path.join(pluginPackageCommandDirectory, file),
      specifiers
        .map(
          (specifier, index) =>
            `import { accepted${index} } from '${specifier}';`,
        )
        .join('\n'),
    );
  }
  fs.writeFileSync(
    path.join(cliDirectory, 'widened.ts'),
    [
      "import { service } from '@qinglong/local-admin/plugin-package-workflow-administration';",
      "import { contract } from '@qinglong/runtime-core/plugin-package-workflow-administration';",
    ].join('\n'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-admin', findings);
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
        file: 'packages/ql3-local-admin/src/widened.ts',
        specifier:
          '@qinglong/runtime-core/plugin-package-workflow-administration',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/widened.ts',
        specifier:
          '@qinglong/local-admin/plugin-package-workflow-administration',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/widened.ts',
        specifier:
          '@qinglong/runtime-core/plugin-package-workflow-administration',
      },
    ],
  );
});

test('confines Trigger administration to its exact service and Owner CLI command', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-trigger-administration-boundary-'),
  );
  const adminDirectory = path.join(root, 'packages/ql3-local-admin/src');
  const adminAutomationDirectory = path.join(
    adminDirectory,
    'automation-administration',
  );
  const cliDirectory = path.join(root, 'packages/ql3-local-owner-cli/src');
  const automationDirectory = path.join(cliDirectory, 'automation-management');
  fs.mkdirSync(adminDirectory, { recursive: true });
  fs.mkdirSync(adminAutomationDirectory, { recursive: true });
  fs.mkdirSync(cliDirectory, { recursive: true });
  fs.mkdirSync(automationDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(adminAutomationDirectory, 'triggerAdministration.ts'),
    [
      "import { policy } from '@qinglong/runtime-core/project-policy';",
      "import { principal } from '@qinglong/runtime-core/security';",
      "import { audit } from '@qinglong/runtime-core/security-audit';",
      "import { trigger } from '@qinglong/runtime-core/trigger';",
      "import { mutation } from '@qinglong/runtime-core/trigger-administration';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(adminDirectory, 'widened.ts'),
    "import { forbidden } from '@qinglong/runtime-core/trigger-administration';",
  );
  fs.writeFileSync(
    path.join(automationDirectory, 'triggerCommand.ts'),
    [
      "import { service } from '@qinglong/local-admin/trigger-administration';",
      "import { read } from '@qinglong/local-command-file';",
      "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
      "import { fence } from '@qinglong/local-sqlite/authenticated-management';",
      "import { database } from '@qinglong/local-sqlite/trigger-administration';",
      "import { audit } from '@qinglong/runtime-core/security-audit';",
      "import { trigger } from '@qinglong/runtime-core/trigger';",
      "import { mutation } from '@qinglong/runtime-core/trigger-administration';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(cliDirectory, 'widened.ts'),
    [
      "import { service } from '@qinglong/local-admin/trigger-administration';",
      "import { mutation } from '@qinglong/runtime-core/trigger-administration';",
    ].join('\n'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-admin', findings);
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
        file: 'packages/ql3-local-admin/src/widened.ts',
        specifier: '@qinglong/runtime-core/trigger-administration',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/widened.ts',
        specifier: '@qinglong/local-admin/trigger-administration',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/widened.ts',
        specifier: '@qinglong/runtime-core/trigger-administration',
      },
    ],
  );
});

test('confines local model provider credential authority to its exact Owner CLI command', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-model-provider-credential-boundary-'),
  );
  const sourceDirectory = path.join(root, 'packages/ql3-local-owner-cli/src');
  const aiManagementDirectory = path.join(sourceDirectory, 'ai-management');
  fs.mkdirSync(aiManagementDirectory, { recursive: true });
  const specifiers = [
    '@qinglong/ai/local-feature-activation',
    '@qinglong/ai/local-model-provider-credential-storage',
    '@qinglong/ai/model-provider-credential-administration',
    '@qinglong/ai/model-provider-credential-catalog',
    '@qinglong/ai/provider-credential',
    '@qinglong/local-command-file',
    '@qinglong/local-owner-console/authenticated-command',
    '@qinglong/local-sqlite/authenticated-management',
    '@qinglong/local-sqlite/project-policy',
    '@qinglong/runtime-core/project-policy',
    '@qinglong/runtime-core/security',
    '@qinglong/runtime-core/security-audit',
  ];
  fs.writeFileSync(
    path.join(aiManagementDirectory, 'modelProviderCredentialCommand.ts'),
    specifiers
      .map(
        (specifier, index) =>
          `import { accepted${index} } from '${specifier}';`,
      )
      .join('\n'),
  );
  fs.writeFileSync(
    path.join(sourceDirectory, 'widened.ts'),
    [
      "import { authenticated } from '@qinglong/local-owner-console/authenticated-command';",
      "import { policy } from '@qinglong/runtime-core/project-policy';",
    ].join('\n'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/widened.ts',
        specifier: '@qinglong/local-owner-console/authenticated-command',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/widened.ts',
        specifier: '@qinglong/runtime-core/project-policy',
      },
    ],
  );
});

test('keeps pepper destruction entrypoints inside the short-lived GC authority', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-owner-console',
    [
      "import { destroyLocalOwnerPepperKey } from '@qinglong/local-owner-console/pepper-custody/destructive';",
      "import { openLocalSqlitePepperGcDatabase } from '@qinglong/local-sqlite/pepper-gc';",
    ].join('\n'),
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-console', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_OWNER_PEPPER_DESTRUCTIVE_ENTRYPOINT',
        specifier: '@qinglong/local-owner-console/pepper-custody/destructive',
      },
      {
        code: 'FORBIDDEN_LOCAL_SQLITE_PEPPER_GC_ENTRYPOINT',
        specifier: '@qinglong/local-sqlite/pepper-gc',
      },
    ],
  );
});

test('keeps the removed local Owner keyring package as a tombstone', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-owner-cli',
    "import { keyring } from '@qinglong/local-owner-keyring';",
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'DELETED_LOCAL_OWNER_KEYRING_PACKAGE_IMPORT',
        specifier: '@qinglong/local-owner-keyring',
      },
    ],
  );
});

test('keeps the deleted local identity package as a tombstone', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-application',
    "import { authenticate } from '@qinglong/local-identity';",
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-application', findings);
  assert.deepEqual(findings, [
    {
      code: 'DELETED_LOCAL_IDENTITY_PACKAGE_IMPORT',
      packagePath: 'packages/ql3-local-application',
      file: 'packages/ql3-local-application/src/index.ts',
      specifier: '@qinglong/local-identity',
    },
  ]);
});

test('confines identity authentication to reviewed owner-console consumers', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-authenticated-command-boundary-'),
  );
  const sourceDirectory = path.join(
    root,
    'packages/ql3-local-owner-console/src',
  );
  const authenticationDirectory = path.join(sourceDirectory, 'authentication');
  fs.mkdirSync(authenticationDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(authenticationDirectory, 'authenticatedCommand.ts'),
    "import { authenticate } from './identityAuthentication';",
  );
  fs.writeFileSync(
    path.join(sourceDirectory, 'index.ts'),
    "import { forbidden } from './authentication/identityAuthentication';",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-console', findings);
  assert.deepEqual(
    findings.map(({ code, file }) => ({ code, file })),
    [
      {
        code: 'FORBIDDEN_LOCAL_IDENTITY_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-console/src/index.ts',
      },
    ],
  );
});

test('confines adoption and Package command authorities to owner CLI subpaths', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-adoption-cli-boundary-'),
  );
  const sourceDirectory = path.join(root, 'packages/ql3-local-owner-cli/src');
  const lifecycleDirectory = path.join(sourceDirectory, 'lifecycle');
  const sqliteAdoptionDirectory = path.join(
    lifecycleDirectory,
    'sqlite-adoption',
  );
  const dataDirectoryAdoptionDirectory = path.join(
    lifecycleDirectory,
    'data-directory-adoption',
  );
  const pluginPackageDirectory = path.join(sourceDirectory, 'plugin-package');
  fs.mkdirSync(lifecycleDirectory, { recursive: true });
  fs.mkdirSync(sqliteAdoptionDirectory, { recursive: true });
  fs.mkdirSync(dataDirectoryAdoptionDirectory, { recursive: true });
  fs.mkdirSync(pluginPackageDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(lifecycleDirectory, 'adoption.ts'),
    [
      "import { inspectLegacySqlitePath } from '@qinglong/local-admin';",
      "import { issueReviewedLegacyCrontabAdoptionDecisionAuthorizationFile } from '@qinglong/local-admin/decision-issuer';",
      "import { establishAuthenticatedLocalCommand } from '@qinglong/local-owner-console/authenticated-command';",
      "import { openLocalSqliteBootstrapDatabase } from '@qinglong/local-sqlite/bootstrap';",
      "import { forbidden } from '@qinglong/local-admin/runtime';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(sqliteAdoptionDirectory, 'command.ts'),
    [
      "import { inspectLegacySqlitePath } from '@qinglong/local-admin';",
      "import { forbidden } from '@qinglong/local-admin/runtime';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dataDirectoryAdoptionDirectory, 'staging.ts'),
    [
      "import { activation } from '@qinglong/local-admin/runtime';",
      "import { forbidden } from '@qinglong/local-admin';",
    ].join('\n'),
  );
  const applicationCommandDirectory = path.join(
    sourceDirectory,
    'application-command',
  );
  fs.mkdirSync(applicationCommandDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(applicationCommandDirectory, 'localOwnerCommand.ts'),
    [
      "import { console } from '@qinglong/local-owner-console';",
      "import { forbidden } from '@qinglong/local-identity';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pluginPackageDirectory, 'pluginPackageCommand.ts'),
    [
      "import { management } from '@qinglong/local-admin/package-management';",
      "import { authenticated } from '@qinglong/local-owner-console/authenticated-command';",
      "import { database } from '@qinglong/local-sqlite/package-management';",
      "import type { approval } from '@qinglong/runtime-core/approved-action';",
      "import type { dispatcher } from '@qinglong/runtime-core/approved-action-dispatcher';",
      "import type { action } from '@qinglong/runtime-core/plugin-package-install';",
      "import type { proposal } from '@qinglong/runtime-core/plugin-package-proposal';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pluginPackageDirectory, 'pluginPackageCatalogCommand.ts'),
    [
      "import { catalog } from '@qinglong/local-admin/package-recovery-catalog';",
      "import { trust } from '@qinglong/local-admin/package-publisher-trust';",
      "import { authenticated } from '@qinglong/local-owner-console/authenticated-command';",
      "import { database } from '@qinglong/local-sqlite/authenticated-management';",
      "import { installs } from '@qinglong/local-sqlite/plugin-package-install';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pluginPackageDirectory, 'pluginPackagePublisherTrustCommand.ts'),
    [
      "import { trust } from '@qinglong/local-admin/package-publisher-trust';",
      "import { catalog } from '@qinglong/local-admin/package-recovery-catalog';",
      "import { authenticated } from '@qinglong/local-owner-console/authenticated-command';",
      "import { database } from '@qinglong/local-sqlite/authenticated-management';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(sourceDirectory, 'unrelated.ts'),
    [
      "import { forbidden } from '@qinglong/local-owner-console/authenticated-command';",
      "import type { approval } from '@qinglong/runtime-core/approved-action';",
    ].join('\n'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/application-command/localOwnerCommand.ts',
        specifier: '@qinglong/local-identity',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/lifecycle/adoption.ts',
        specifier: '@qinglong/local-admin/runtime',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/lifecycle/data-directory-adoption/staging.ts',
        specifier: '@qinglong/local-admin',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/lifecycle/sqlite-adoption/command.ts',
        specifier: '@qinglong/local-admin/runtime',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/unrelated.ts',
        specifier: '@qinglong/local-owner-console/authenticated-command',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/unrelated.ts',
        specifier: '@qinglong/runtime-core/approved-action',
      },
    ],
  );
});

test('confines data-directory application authority to exact reviewed owners', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-data-directory-application-boundary-'),
  );
  const ownerApplicationDirectory = path.join(
    root,
    'packages/ql3-local-owner-cli/src/lifecycle/data-directory-adoption/application',
  );
  const adminAdoptionDirectory = path.join(
    root,
    'packages/ql3-local-admin/src/data-directory-adoption',
  );
  fs.mkdirSync(ownerApplicationDirectory, { recursive: true });
  fs.mkdirSync(adminAdoptionDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(ownerApplicationDirectory, 'application.ts'),
    [
      "import { application } from '@qinglong/local-admin/data-directory-adoption';",
      "import { secrets } from '@qinglong/local-secret';",
      "import { authenticated } from '@qinglong/local-owner-console/authenticated-command';",
      "import { bootstrap } from '@qinglong/local-sqlite/bootstrap';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(ownerApplicationDirectory, 'cleanup.ts'),
    "import { cleanup } from '@qinglong/local-sqlite/data-directory-adoption';",
  );
  fs.writeFileSync(
    path.join(ownerApplicationDirectory, 'neighbor.ts'),
    [
      "import { application } from '@qinglong/local-admin/data-directory-adoption';",
      "import { secrets } from '@qinglong/local-secret';",
      "import { cleanup } from '@qinglong/local-sqlite/data-directory-adoption';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(adminAdoptionDirectory, 'dataDirectoryAdoption.ts'),
    [
      "import { database } from '@qinglong/local-sqlite/data-directory-adoption';",
      "import type { secret } from '@qinglong/runtime-core/local-secret';",
      "import { policy } from '@qinglong/runtime-core/project-policy';",
      "import type { decision } from '@qinglong/runtime-core/security';",
      "import type { audit } from '@qinglong/runtime-core/security-audit';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(adminAdoptionDirectory, 'neighbor.ts'),
    [
      "import { database } from '@qinglong/local-sqlite/data-directory-adoption';",
      "import type { secret } from '@qinglong/runtime-core/local-secret';",
    ].join('\n'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const ownerFindings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', ownerFindings);
  assert.deepEqual(
    ownerFindings.map(({ code, file, specifier }) => ({
      code,
      file,
      specifier,
    })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/lifecycle/data-directory-adoption/application/neighbor.ts',
        specifier: '@qinglong/local-admin/data-directory-adoption',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/lifecycle/data-directory-adoption/application/neighbor.ts',
        specifier: '@qinglong/local-secret',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/lifecycle/data-directory-adoption/application/neighbor.ts',
        specifier: '@qinglong/local-sqlite/data-directory-adoption',
      },
    ],
  );

  const adminFindings = [];
  auditSourceImports(root, 'packages/ql3-local-admin', adminFindings);
  assert.deepEqual(
    adminFindings.map(({ code, file, specifier }) => ({
      code,
      file,
      specifier,
    })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADMIN_SQLITE_ENTRYPOINT',
        file: 'packages/ql3-local-admin/src/data-directory-adoption/neighbor.ts',
        specifier: '@qinglong/local-sqlite/data-directory-adoption',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADMIN_RUNTIME_CORE_ENTRYPOINT',
        file: 'packages/ql3-local-admin/src/data-directory-adoption/neighbor.ts',
        specifier: '@qinglong/runtime-core/local-secret',
      },
    ],
  );
});

test('confines fresh setup authority to the reviewed owner CLI subpath', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-setup-boundary-'));
  const sourceDirectory = path.join(root, 'packages/ql3-local-owner-cli/src');
  const lifecycleDirectory = path.join(sourceDirectory, 'lifecycle');
  fs.mkdirSync(lifecycleDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(lifecycleDirectory, 'localSetup.ts'),
    [
      "import { keys } from '@qinglong/local-owner-console/pepper-custody';",
      "import { secrets } from '@qinglong/local-secret';",
      "import { bootstrap } from '@qinglong/local-sqlite/bootstrap';",
      "import { migrate } from '@qinglong/local-sqlite/migration';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(sourceDirectory, 'widenedSetup.ts'),
    [
      "import { keys } from '@qinglong/local-owner-console/pepper-custody';",
      "import { secrets } from '@qinglong/local-secret';",
      "import { migrate } from '@qinglong/local-sqlite/migration';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(lifecycleDirectory, 'localReadiness.ts'),
    "import { inspect } from '@qinglong/local-sqlite/readiness-inspection';",
  );
  fs.writeFileSync(
    path.join(sourceDirectory, 'widenedReadiness.ts'),
    "import { inspect } from '@qinglong/local-sqlite/readiness-inspection';",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({
      code,
      file,
      specifier,
    })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/widenedReadiness.ts',
        specifier: '@qinglong/local-sqlite/readiness-inspection',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/widenedSetup.ts',
        specifier: '@qinglong/local-owner-console/pepper-custody',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/widenedSetup.ts',
        specifier: '@qinglong/local-secret',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/widenedSetup.ts',
        specifier: '@qinglong/local-sqlite/migration',
      },
    ],
  );
});

test('confines reconciliation review authentication to exact read-only owners', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-reconciliation-review-boundary-'),
  );
  const reviewDirectory = path.join(
    root,
    'packages/ql3-local-owner-cli/src/deployment/reconciliation/review',
  );
  fs.mkdirSync(reviewDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(reviewDirectory, 'authorization.ts'),
    [
      "import type { Key } from '@qinglong/runtime-core/local-secret';",
      "import type { Principal } from '@qinglong/runtime-core/security';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(reviewDirectory, 'completion.ts'),
    [
      "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
      "import { database } from '@qinglong/local-sqlite/authentication-read';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(reviewDirectory, 'issuerKeyring.ts'),
    "import type { Key } from '@qinglong/runtime-core/local-secret';",
  );
  fs.writeFileSync(
    path.join(reviewDirectory, 'neighbor.ts'),
    [
      "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
      "import { database } from '@qinglong/local-sqlite/authentication-read';",
      "import type { Key } from '@qinglong/runtime-core/local-secret';",
      "import type { Principal } from '@qinglong/runtime-core/security';",
    ].join('\n'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/review/neighbor.ts',
        specifier: '@qinglong/local-owner-console/authenticated-command',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/review/neighbor.ts',
        specifier: '@qinglong/local-sqlite/authentication-read',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/review/neighbor.ts',
        specifier: '@qinglong/runtime-core/local-secret',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/review/neighbor.ts',
        specifier: '@qinglong/runtime-core/security',
      },
    ],
  );
});

test('confines reconciliation automation apply authority to exact coordinators', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-reconciliation-automation-apply-boundary-'),
  );
  const automationDirectory = path.join(
    root,
    'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/automation',
  );
  const completionDirectory = path.join(
    root,
    'packages/ql3-local-owner-cli/src/deployment/reconciliation/completion',
  );
  fs.mkdirSync(automationDirectory, { recursive: true });
  fs.mkdirSync(completionDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(automationDirectory, 'decisionCoordinator.ts'),
    [
      "import { decide } from '@qinglong/local-admin/reconciliation-automation-decision';",
      "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
      "import { database } from '@qinglong/local-sqlite/authentication-read';",
      "import type { Principal } from '@qinglong/runtime-core/security';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(automationDirectory, 'applyCoordinator.ts'),
    [
      "import { apply } from '@qinglong/local-admin/reconciliation-automation-decision';",
      "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
      "import { database } from '@qinglong/local-sqlite/authentication-read';",
      "import { backup } from '@qinglong/local-sqlite/rollout-safety';",
      "import type { Principal } from '@qinglong/runtime-core/security';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(automationDirectory, 'applyEvidence.ts'),
    "import type { Evidence } from '@qinglong/local-sqlite/rollout-safety';",
  );
  fs.writeFileSync(
    path.join(completionDirectory, 'coordinator.ts'),
    "import { inspect } from '@qinglong/local-sqlite/rollout-safety';",
  );
  fs.writeFileSync(
    path.join(completionDirectory, 'neighbor.ts'),
    "import { backup } from '@qinglong/local-sqlite/rollout-safety';",
  );
  fs.writeFileSync(
    path.join(automationDirectory, 'neighbor.ts'),
    [
      "import { apply } from '@qinglong/local-admin/reconciliation-automation-decision';",
      "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
      "import { database } from '@qinglong/local-sqlite/authentication-read';",
      "import { backup } from '@qinglong/local-sqlite/rollout-safety';",
      "import type { Principal } from '@qinglong/runtime-core/security';",
    ].join('\n'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/automation/neighbor.ts',
        specifier: '@qinglong/local-admin/reconciliation-automation-decision',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/automation/neighbor.ts',
        specifier: '@qinglong/local-owner-console/authenticated-command',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/automation/neighbor.ts',
        specifier: '@qinglong/local-sqlite/authentication-read',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/automation/neighbor.ts',
        specifier: '@qinglong/local-sqlite/rollout-safety',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/automation/neighbor.ts',
        specifier: '@qinglong/runtime-core/security',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/completion/neighbor.ts',
        specifier: '@qinglong/local-sqlite/rollout-safety',
      },
    ],
  );
});

test('confines reconciliation Secret and Config inspection to its exact row planner', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-reconciliation-secret-config-boundary-'),
  );
  const secretConfigDirectory = path.join(
    root,
    'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config',
  );
  fs.mkdirSync(secretConfigDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(secretConfigDirectory, 'rowPlan.ts'),
    "import { inspect } from '@qinglong/local-admin/reconciliation-secret-and-config-inspection';\nimport { digest } from '@qinglong/local-sqlite/adoption-provenance';",
  );
  fs.writeFileSync(
    path.join(secretConfigDirectory, 'neighbor.ts'),
    "import { inspect } from '@qinglong/local-admin/reconciliation-secret-and-config-inspection';\nimport { digest } from '@qinglong/local-sqlite/adoption-provenance';",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config/neighbor.ts',
        specifier:
          '@qinglong/local-admin/reconciliation-secret-and-config-inspection',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config/neighbor.ts',
        specifier: '@qinglong/local-sqlite/adoption-provenance',
      },
    ],
  );
});

test('confines reconciliation Secret and Config decision authority to exact owners', (t) => {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      'ql3-reconciliation-secret-config-decision-boundary-',
    ),
  );
  const secretConfigDirectory = path.join(
    root,
    'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config',
  );
  fs.mkdirSync(secretConfigDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(secretConfigDirectory, 'decisionAuthorization.ts'),
    [
      "import type { Key } from '@qinglong/runtime-core/local-secret';",
      "import type { Principal } from '@qinglong/runtime-core/security';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(secretConfigDirectory, 'decisionCoordinator.ts'),
    [
      "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
      "import { database } from '@qinglong/local-sqlite/authentication-read';",
      "import type { Principal } from '@qinglong/runtime-core/security';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(secretConfigDirectory, 'neighbor.ts'),
    [
      "import { authenticate } from '@qinglong/local-owner-console/authenticated-command';",
      "import { database } from '@qinglong/local-sqlite/authentication-read';",
      "import type { Key } from '@qinglong/runtime-core/local-secret';",
      "import type { Principal } from '@qinglong/runtime-core/security';",
    ].join('\n'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config/neighbor.ts',
        specifier: '@qinglong/local-owner-console/authenticated-command',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config/neighbor.ts',
        specifier: '@qinglong/local-sqlite/authentication-read',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config/neighbor.ts',
        specifier: '@qinglong/runtime-core/local-secret',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/reconciliation/application/secret-and-config/neighbor.ts',
        specifier: '@qinglong/runtime-core/security',
      },
    ],
  );
});

test('deleted Owner ceremony package names remain dependency tombstones', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-owner-console',
    [
      "import { createLocalOwnerBootstrapService } from '@qinglong/local-owner-ceremony/bootstrap';",
      "import { createLocalOwnerCredentialRecoveryService } from '@qinglong/local-owner-ceremony/credential-recovery';",
      "import { widened } from '@qinglong/local-owner-ceremony';",
      "import { hidden } from '@qinglong/local-owner-ceremony/internal';",
      "import { oldBootstrap } from '@qinglong/local-owner-bootstrap';",
      "import { oldRecovery } from '@qinglong/local-owner-credential-recovery';",
    ].join('\n'),
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-console', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'DEPRECATED_LOCAL_OWNER_CEREMONY_PACKAGE_IMPORT',
        specifier: '@qinglong/local-owner-ceremony/bootstrap',
      },
      {
        code: 'DEPRECATED_LOCAL_OWNER_CEREMONY_PACKAGE_IMPORT',
        specifier: '@qinglong/local-owner-ceremony/credential-recovery',
      },
      {
        code: 'DEPRECATED_LOCAL_OWNER_CEREMONY_PACKAGE_IMPORT',
        specifier: '@qinglong/local-owner-ceremony',
      },
      {
        code: 'DEPRECATED_LOCAL_OWNER_CEREMONY_PACKAGE_IMPORT',
        specifier: '@qinglong/local-owner-ceremony/internal',
      },
      {
        code: 'DEPRECATED_LOCAL_OWNER_CEREMONY_PACKAGE_IMPORT',
        specifier: '@qinglong/local-owner-bootstrap',
      },
      {
        code: 'DEPRECATED_LOCAL_OWNER_CEREMONY_PACKAGE_IMPORT',
        specifier: '@qinglong/local-owner-credential-recovery',
      },
    ],
  );
});

test('internal Owner ceremony modules cannot cross or widen identity authority', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-owner-ceremony-'));
  const packageDirectory = path.join(
    root,
    'packages/ql3-local-owner-console/src',
  );
  const sources = {
    'bootstrap/index.ts': [
      "import '../credential-recovery';",
      "import { identity } from '../authentication/identityAuthentication';",
    ].join('\n'),
    'credential-recovery/index.ts': [
      "import '../bootstrap';",
      "import { identity } from '../authentication/identityAuthentication';",
    ].join('\n'),
  };
  for (const [relativePath, source] of Object.entries(sources)) {
    const filePath = path.join(packageDirectory, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-console', findings);
  assert.deepEqual(
    findings.map(({ code, file }) => ({ code, file })),
    [
      {
        code: 'FORBIDDEN_LOCAL_OWNER_CEREMONY_CROSS_AREA_IMPORT',
        file: 'packages/ql3-local-owner-console/src/bootstrap/index.ts',
      },
      {
        code: 'FORBIDDEN_LOCAL_OWNER_CEREMONY_CROSS_AREA_IMPORT',
        file: 'packages/ql3-local-owner-console/src/credential-recovery/index.ts',
      },
      {
        code: 'FORBIDDEN_LOCAL_OWNER_CEREMONY_CROSS_AREA_IMPORT',
        file: 'packages/ql3-local-owner-console/src/credential-recovery/index.ts',
      },
      {
        code: 'FORBIDDEN_LOCAL_IDENTITY_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-console/src/credential-recovery/index.ts',
      },
    ],
  );
});

test('confines Local API identity authentication to its exact read-only adapter', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-local-api-auth-'));
  const packageDirectory = path.join(root, 'packages/ql3-local-api/src');
  const sources = {
    'authentication/credentialAuthenticator.ts':
      "import { authenticate } from '@qinglong/local-owner-console/identity-authentication';",
    'authentication/destructive.ts':
      "import { destroy } from '@qinglong/local-owner-console/pepper-custody/destructive';",
    'transport/widened.ts':
      "import { authenticate } from '@qinglong/local-owner-console/identity-authentication';",
    'trigger/triggerPutRoute.ts':
      "import { put } from '@qinglong/local-admin/trigger-administration';",
    'trigger/widened.ts':
      "import { put } from '@qinglong/local-admin/trigger-administration';",
  };
  for (const [relativePath, source] of Object.entries(sources)) {
    const filePath = path.join(packageDirectory, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-api', findings);
  assert.deepEqual(
    findings.map(({ code, file }) => ({ code, file })),
    [
      {
        code: 'FORBIDDEN_LOCAL_OWNER_PEPPER_DESTRUCTIVE_ENTRYPOINT',
        file: 'packages/ql3-local-api/src/authentication/destructive.ts',
      },
      {
        code: 'FORBIDDEN_LOCAL_IDENTITY_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-api/src/transport/widened.ts',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-api/src/trigger/widened.ts',
      },
    ],
  );
});

test('deleted Owner GC CLI name remains a dependency tombstone', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-owner-console',
    "import { run } from '@qinglong/local-owner-gc-cli';",
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-console', findings);
  assert.deepEqual(findings, [
    {
      code: 'DEPRECATED_LOCAL_OWNER_GC_CLI_PACKAGE_IMPORT',
      packagePath: 'packages/ql3-local-owner-console',
      file: 'packages/ql3-local-owner-console/src/index.ts',
      specifier: '@qinglong/local-owner-gc-cli',
    },
  ]);
});

test('allows Drizzle only in the local typed schema, never runtime code', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-sqlite',
    "import { drizzle } from 'drizzle-orm/node-sqlite';",
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-sqlite', findings);
  assert.deepEqual(findings, [
    {
      code: 'FORBIDDEN_LOCAL_SQLITE_RUNTIME_DRIZZLE_IMPORT',
      packagePath: 'packages/ql3-local-sqlite',
      file: 'packages/ql3-local-sqlite/src/index.ts',
      specifier: 'drizzle-orm/node-sqlite',
    },
  ]);
});

test('local Profile subpath can cross only into the SQLite runtime area', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-sqlite',
    [
      "import { openLocalSqliteRuntimeDatabase } from '../runtime/runtimeDatabase';",
      "import { migrateLocalSqlitePath } from '../migration/migration';",
      "import { schema } from '../storage/schema';",
    ].join('\n'),
    'profile/localProfile.ts',
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-sqlite', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_PROFILE_SQLITE_AREA_IMPORT',
        specifier: '../migration/migration',
      },
      {
        code: 'FORBIDDEN_LOCAL_PROFILE_SQLITE_AREA_IMPORT',
        specifier: '../storage/schema',
      },
    ],
  );
});

test('local administration excludes Package command authentication from its closure', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-admin',
    [
      "import { auditLocalSqlitePath } from '@qinglong/local-sqlite/runtime';",
      "import { migrateLocalSqlitePath } from '@qinglong/local-sqlite/migration';",
      "import { schema } from '@qinglong/local-sqlite';",
      "import { repository } from '@qinglong/local-sqlite/runRepository';",
      "import { approval } from '@qinglong/local-sqlite/approved-action';",
      "import { policy } from '@qinglong/local-sqlite/project-policy';",
    ].join('\n'),
  );
  fs.mkdirSync(path.join(root, 'packages/ql3-local-admin/src/plugin-package'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-local-admin/src/plugin-package/pluginPackageApprovedAction.ts',
    ),
    [
      "import { execution } from '@qinglong/local-sqlite/approved-action-execution';",
      "import { authority } from '@qinglong/local-sqlite/operation-authority';",
      "import { install } from '@qinglong/local-sqlite/plugin-package-install';",
      "import { proposal } from '@qinglong/local-sqlite/plugin-package-proposal';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-local-admin/src/plugin-package/pluginPackageManagement.ts',
    ),
    [
      "import { approval } from '@qinglong/local-sqlite/approved-action';",
      "import { authority } from '@qinglong/local-sqlite/operation-authority';",
      "import { proposal } from '@qinglong/local-sqlite/plugin-package-proposal';",
      "import { policy } from '@qinglong/local-sqlite/project-policy';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'packages/ql3-local-admin/src/pluginPackageCommand.ts'),
    [
      "import { command } from '@qinglong/local-command-file';",
      "import { authenticated } from '@qinglong/local-owner-console/authenticated-command';",
      "import { database } from '@qinglong/local-sqlite/package-management';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'packages/ql3-local-admin/src/unrelatedCommand.ts'),
    [
      "import { command } from '@qinglong/local-command-file';",
      "import { owner } from '@qinglong/local-owner-console';",
      "import { database } from '@qinglong/local-sqlite/package-management';",
    ].join('\n'),
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-admin', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADMIN_SQLITE_ENTRYPOINT',
        specifier: '@qinglong/local-sqlite',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADMIN_SQLITE_ENTRYPOINT',
        specifier: '@qinglong/local-sqlite/runRepository',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADMIN_SQLITE_ENTRYPOINT',
        specifier: '@qinglong/local-sqlite/approved-action',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADMIN_SQLITE_ENTRYPOINT',
        specifier: '@qinglong/local-sqlite/project-policy',
      },
      {
        code: 'FORBIDDEN_LOCAL_PACKAGE_COMMAND_AUTHORITY_IMPORT',
        specifier: '@qinglong/local-command-file',
      },
      {
        code: 'FORBIDDEN_LOCAL_PACKAGE_COMMAND_AUTHORITY_IMPORT',
        specifier: '@qinglong/local-owner-console/authenticated-command',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADMIN_SQLITE_ENTRYPOINT',
        specifier: '@qinglong/local-sqlite/package-management',
      },
      {
        code: 'FORBIDDEN_LOCAL_PACKAGE_COMMAND_AUTHORITY_IMPORT',
        specifier: '@qinglong/local-command-file',
      },
      {
        code: 'FORBIDDEN_LOCAL_PACKAGE_COMMAND_AUTHORITY_IMPORT',
        specifier: '@qinglong/local-owner-console',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADMIN_SQLITE_ENTRYPOINT',
        specifier: '@qinglong/local-sqlite/package-management',
      },
    ],
  );
});

test('adopted Profile subpath can cross only into reviewed administration runtime', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-admin',
    [
      "import { acquireLocalSqliteActivation } from '../runtime';",
      "import { bootstrapLocalProfileStorage } from '@qinglong/local-sqlite/profile';",
      "import { stageLocalSqliteAdoption } from '../legacy-adoption/localSqliteAdoption';",
    ].join('\n'),
    'adopted-profile/localAdoptedProfile.ts',
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-admin', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_ADOPTED_PROFILE_ADMIN_AREA_IMPORT',
        specifier: '../legacy-adoption/localSqliteAdoption',
      },
    ],
  );
});

test('deleted cutover package stays out of every runtime composition', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-admin',
    "import { activateLocalCutover } from '@qinglong/local-cutover';",
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-admin', findings);
  assert.deepEqual(findings, [
    {
      code: 'DELETED_LOCAL_CUTOVER_PACKAGE_IMPORT',
      packagePath: 'packages/ql3-local-admin',
      file: 'packages/ql3-local-admin/src/index.ts',
      specifier: '@qinglong/local-cutover',
    },
  ]);
});

test('removed local Profile packages remain dependency tombstones', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-application',
    [
      "import { bootstrap } from '@qinglong/local-profile/edge';",
      "import { bootstrapAdopted } from '@qinglong/local-adopted-profile/edge';",
    ].join('\n'),
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-application', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'DELETED_LOCAL_PROFILE_PACKAGE_IMPORT',
        specifier: '@qinglong/local-profile/edge',
      },
      {
        code: 'DELETED_LOCAL_ADOPTED_PROFILE_PACKAGE_IMPORT',
        specifier: '@qinglong/local-adopted-profile/edge',
      },
    ],
  );
});

test('local application imports only reviewed execution subpaths and process boundaries', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-application',
    [
      "import { LocalRunStartupRecoveryCoordinator } from '@qinglong/local-execution/recovery';",
      "import { LocalProcessLauncher } from '@qinglong/local-process';",
      "import { openLocalSqliteRuntimeDatabase } from '@qinglong/local-sqlite/runtime';",
      "import { activateLocalCutover } from '@qinglong/local-cutover';",
    ].join('\n'),
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-application', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        specifier: '@qinglong/local-sqlite/runtime',
      },
      {
        code: 'DELETED_LOCAL_CUTOVER_PACKAGE_IMPORT',
        specifier: '@qinglong/local-cutover',
      },
    ],
  );
});

test('local application receives only the pure data application commit codec', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-local-data-commit-codec-boundary-'),
  );
  const sourceDirectory = path.join(
    root,
    'packages/ql3-local-application/src/production-process',
  );
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDirectory, 'legacyDataApplicationCommitment.ts'),
    [
      "import { normalize } from '@qinglong/local-sqlite/data-directory-application-commit';",
      "import { mutate } from '@qinglong/local-sqlite/data-directory-adoption';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(sourceDirectory, 'neighbor.ts'),
    "import { normalize } from '@qinglong/local-sqlite/data-directory-application-commit';",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-application', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-application/src/production-process/legacyDataApplicationCommitment.ts',
        specifier: '@qinglong/local-sqlite/data-directory-adoption',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-application/src/production-process/neighbor.ts',
        specifier: '@qinglong/local-sqlite/data-directory-application-commit',
      },
    ],
  );
});

test('service-manager Owner consumers receive only the pure data commit codec', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-service-data-commit-codec-boundary-'),
  );
  const managerDirectory = path.join(
    root,
    'packages/ql3-local-owner-cli/src/deployment/service-manager',
  );
  const rollbackDirectory = path.join(managerDirectory, 'legacy-rollback');
  fs.mkdirSync(rollbackDirectory, { recursive: true });
  for (const filePath of [
    path.join(managerDirectory, 'serviceManagerIntent.ts'),
    path.join(managerDirectory, 'serviceCutoverConsumer.ts'),
    path.join(rollbackDirectory, 'preparation.ts'),
  ]) {
    fs.writeFileSync(
      filePath,
      "import { normalize } from '@qinglong/local-sqlite/data-directory-application-commit';",
    );
  }
  fs.writeFileSync(
    path.join(managerDirectory, 'neighbor.ts'),
    "import { normalize } from '@qinglong/local-sqlite/data-directory-application-commit';",
  );
  fs.appendFileSync(
    path.join(managerDirectory, 'serviceCutoverConsumer.ts'),
    "\nimport { mutate } from '@qinglong/local-sqlite/data-directory-adoption';",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/service-manager/neighbor.ts',
        specifier: '@qinglong/local-sqlite/data-directory-application-commit',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/service-manager/serviceCutoverConsumer.ts',
        specifier: '@qinglong/local-sqlite/data-directory-adoption',
      },
    ],
  );
});

test('adopted deployment material receives only the pure data commit codec', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-adopted-bundle-codec-boundary-'),
  );
  const bundleDirectory = path.join(
    root,
    'packages/ql3-local-owner-cli/src/deployment/adopted-bundle',
  );
  fs.mkdirSync(bundleDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(bundleDirectory, 'material.ts'),
    [
      "import { normalize } from '@qinglong/local-sqlite/data-directory-application-commit';",
      "import { mutate } from '@qinglong/local-sqlite/data-directory-adoption';",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(bundleDirectory, 'neighbor.ts'),
    "import { normalize } from '@qinglong/local-sqlite/data-directory-application-commit';",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-owner-cli', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/adopted-bundle/material.ts',
        specifier: '@qinglong/local-sqlite/data-directory-adoption',
      },
      {
        code: 'FORBIDDEN_LOCAL_ADOPTION_CLI_AUTHORITY_IMPORT',
        file: 'packages/ql3-local-owner-cli/src/deployment/adopted-bundle/neighbor.ts',
        specifier: '@qinglong/local-sqlite/data-directory-application-commit',
      },
    ],
  );
});

test('local AI application imports only the reviewed dynamic composition subpaths', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-local-ai-application-boundary-'),
  );
  const sourceDirectory = path.join(root, 'packages/ql3-local-application/src');
  const applicationRuntimeDirectory = path.join(
    sourceDirectory,
    'application-runtime',
  );
  fs.mkdirSync(applicationRuntimeDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(applicationRuntimeDirectory, 'aiFeatureApplication.ts'),
    [
      "import type { Capability } from '@qinglong/ai/profile';",
      "const activation = import('@qinglong/ai/local-feature-activation');",
      "const invocation = import('@qinglong/ai/local-model-invocation-storage');",
      "const promptAdmission = import('@qinglong/ai/local-plugin-package-prompt-admission-storage');",
      "const promptOutputArtifactStorage = import('@qinglong/ai/local-plugin-package-prompt-output-artifact-storage');",
      "const promptOutputArtifact = import('@qinglong/ai/plugin-package-prompt-output-artifact');",
      "const promptOutputCompletion = import('@qinglong/ai/plugin-package-prompt-output-completion');",
      "const promptOutputRead = import('@qinglong/ai/plugin-package-prompt-output-read');",
      "const promptExecutor = import('@qinglong/ai/plugin-package-prompt-executor');",
      "const pricing = import('@qinglong/ai/local-price-catalog-storage');",
      "const sqlite = import('@qinglong/local-sqlite/optional-feature-runtime');",
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(sourceDirectory, 'widened.ts'),
    [
      "const aiRoot = import('@qinglong/ai');",
      "const aiInternal = import('@qinglong/ai/internal');",
      "const sqliteRuntime = import('@qinglong/local-sqlite/runtime');",
    ].join('\n'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-application', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_APPLICATION_AI_ENTRYPOINT',
        specifier: '@qinglong/ai',
      },
      {
        code: 'FORBIDDEN_LOCAL_APPLICATION_AI_ENTRYPOINT',
        specifier: '@qinglong/ai/internal',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        specifier: '@qinglong/local-sqlite/runtime',
      },
    ],
  );
});

test('local application rejects the execution root and unknown subpaths', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-application',
    [
      "import { LocalExecutionCoordinator } from '@qinglong/local-execution/execution';",
      "import { LocalRunStartupRecoveryCoordinator } from '@qinglong/local-execution/recovery';",
      "import { LocalRunDispatcher } from '@qinglong/local-execution/dispatch';",
      "import { LocalExecutionControlLifecycle } from '@qinglong/local-execution/control';",
      "import { widened } from '@qinglong/local-execution';",
      "import { hidden } from '@qinglong/local-execution/internal';",
    ].join('\n'),
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-application', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_EXECUTION_ENTRYPOINT_IMPORT',
        specifier: '@qinglong/local-execution',
      },
      {
        code: 'FORBIDDEN_LOCAL_EXECUTION_ENTRYPOINT_IMPORT',
        specifier: '@qinglong/local-execution/internal',
      },
    ],
  );
});

test('local application Plugin Package gate uses only exact reviewed subpaths', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-application',
    [
      "import { publisher } from '@qinglong/local-admin/package-activation';",
      "import { bytes } from '@qinglong/local-admin/package-resource-materialization';",
      "import { install } from '@qinglong/runtime-core/plugin-package-install';",
      "import { stage } from '@qinglong/runtime-core/plugin-package-installation';",
      "import { recovery } from '@qinglong/runtime-core/plugin-package-recovery';",
      "import { publication } from '@qinglong/runtime-core/plugin-package-task-publication';",
      "import { snapshot } from '@qinglong/runtime-core/project-tool-definition-snapshot';",
      "import { semantics } from '@qinglong/runtime-core/task-spec-semantic';",
      "import { widenedAdmin } from '@qinglong/local-admin';",
      "import { hiddenAdmin } from '@qinglong/local-admin/runtime';",
      "import { widenedCore } from '@qinglong/runtime-core';",
      "import { hiddenCore } from '@qinglong/runtime-core/plugin-package-activation';",
      "import { misplacedCatalog } from '@qinglong/local-admin/package-installation';",
      "import { misplacedTrust } from '@qinglong/local-admin/package-publisher-trust';",
      "import { misplacedManifest } from '@qinglong/runtime-core/plugin-package';",
    ].join('\n'),
  );
  fs.mkdirSync(
    path.join(root, 'packages/ql3-local-application/src/production-process'),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(
      root,
      'packages/ql3-local-application/src/production-process/pluginPackageRecoveryCatalog.ts',
    ),
    [
      "import { stage } from '@qinglong/local-admin/package-installation';",
      "import { trust } from '@qinglong/local-admin/package-publisher-trust';",
      "import { manifest } from '@qinglong/runtime-core/plugin-package';",
      "import { bundle } from '@qinglong/runtime-core/plugin-package-bundle';",
    ].join('\n'),
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-application', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'FORBIDDEN_LOCAL_APPLICATION_ADMIN_ENTRYPOINT',
        specifier: '@qinglong/local-admin',
      },
      {
        code: 'FORBIDDEN_LOCAL_APPLICATION_ADMIN_ENTRYPOINT',
        specifier: '@qinglong/local-admin/runtime',
      },
      {
        code: 'FORBIDDEN_LOCAL_APPLICATION_RUNTIME_CORE_ENTRYPOINT',
        specifier: '@qinglong/runtime-core',
      },
      {
        code: 'FORBIDDEN_LOCAL_APPLICATION_RUNTIME_CORE_ENTRYPOINT',
        specifier: '@qinglong/runtime-core/plugin-package-activation',
      },
      {
        code: 'FORBIDDEN_LOCAL_APPLICATION_ADMIN_ENTRYPOINT',
        specifier: '@qinglong/local-admin/package-installation',
      },
      {
        code: 'FORBIDDEN_LOCAL_APPLICATION_ADMIN_ENTRYPOINT',
        specifier: '@qinglong/local-admin/package-publisher-trust',
      },
      {
        code: 'FORBIDDEN_LOCAL_APPLICATION_RUNTIME_CORE_ENTRYPOINT',
        specifier: '@qinglong/runtime-core/plugin-package',
      },
    ],
  );
});

test('local execution subpaths keep one-way internal dependencies', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-execution-boundary-'),
  );
  const packageDirectory = path.join(root, 'packages/ql3-local-execution/src');
  const sources = {
    'control/control.ts': "import '../recovery/coordinator';",
    'dispatch/dispatcher.ts': "import '../execution/coordinator';",
    'execution/coordinator.ts': "import '../dispatch/dispatcher';",
    'recovery/coordinator.ts': "import '../control/completion';",
  };
  for (const [relativePath, source] of Object.entries(sources)) {
    const filePath = path.join(packageDirectory, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-execution', findings);
  assert.deepEqual(
    findings.map(({ code, file }) => ({ code, file })),
    [
      {
        code: 'FORBIDDEN_LOCAL_EXECUTION_CROSS_AREA_IMPORT',
        file: 'packages/ql3-local-execution/src/control/control.ts',
      },
      {
        code: 'FORBIDDEN_LOCAL_EXECUTION_CROSS_AREA_IMPORT',
        file: 'packages/ql3-local-execution/src/execution/coordinator.ts',
      },
    ],
  );
});

test('local execution accepts its reviewed shared port and scheduler DAG', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-execution-reviewed-boundary-'),
  );
  const packageDirectory = path.join(root, 'packages/ql3-local-execution/src');
  const sources = {
    'execution/workflowTaskExecution.ts': 'export interface SharedPort {}',
    'control/completion.ts':
      "import type { SharedPort } from '../execution/workflowTaskExecution';",
    'execution/coordinator.ts':
      "import type { SharedPort } from './workflowTaskExecution';",
    'recovery/workflowTask.ts':
      "import type { SharedPort } from '../execution/workflowTaskExecution';",
    'scheduler/workflowCoordinator.ts': "import '../dispatch/dispatcher';",
    'dispatch/dispatcher.ts': 'export const dispatcher = true;',
  };
  for (const [relativePath, source] of Object.entries(sources)) {
    const filePath = path.join(packageDirectory, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-execution', findings);
  assert.deepEqual(findings, []);
});

test('accepts only the reviewed Package lifecycle vertical entrypoints', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-package-lifecycle-reviewed-boundary-'),
  );
  const sources = {
    'packages/ql3-local-owner-cli/src/plugin-package/pluginPackageCommand.ts': [
      "import { lifecycle } from '@qinglong/local-admin/package-lifecycle';",
      "import { installs } from '@qinglong/local-sqlite/plugin-package-install';",
      "import type { Action } from '@qinglong/runtime-core/plugin-package-lifecycle';",
    ].join('\n'),
    'packages/ql3-local-admin/src/plugin-package/pluginPackageLifecycle.ts': [
      "import { approvals } from '@qinglong/local-sqlite/approved-action';",
      "import { authority } from '@qinglong/local-sqlite/operation-authority';",
      "import { lifecycle } from '@qinglong/local-sqlite/plugin-package-lifecycle';",
      "import { policy } from '@qinglong/local-sqlite/project-policy';",
      "import type { Approval } from '@qinglong/runtime-core/approved-action';",
      "import type { Action } from '@qinglong/runtime-core/plugin-package-lifecycle';",
      "import type { ProjectPolicy } from '@qinglong/runtime-core/project-policy';",
      "import type { Principal } from '@qinglong/runtime-core/security';",
      "import type { Audit } from '@qinglong/runtime-core/security-audit';",
    ].join('\n'),
    'packages/ql3-local-application/src/application-runtime/pluginPackageStartup.ts':
      "import type { Publication } from '@qinglong/runtime-core/plugin-package-automation-publication';",
    'packages/ql3-local-application/src/application-runtime/startupErrors.ts':
      "import type { Publication } from '@qinglong/runtime-core/plugin-package-automation-publication';",
    'packages/ql3-local-application/src/application-runtime/contract.ts':
      "import type { Publication } from '@qinglong/runtime-core/plugin-package-automation-publication';",
    'packages/ql3-cluster-admin/src/plugin-package/lifecycle/pluginPackageLifecycleExecutor.ts':
      [
        "import { approval } from '@qinglong/cluster-postgres/approved-action';",
        "import { executor } from '@qinglong/cluster-postgres/package-executor';",
        "import { policy } from '@qinglong/cluster-postgres/project-policy';",
      ].join('\n'),
    'packages/ql3-cluster-admin/src/plugin-package/lifecycle/pluginPackageLifecycleManagement.ts':
      [
        "import { approval } from '@qinglong/cluster-postgres/approved-action';",
        "import { manager } from '@qinglong/cluster-postgres/package-manager';",
        "import { policy } from '@qinglong/cluster-postgres/project-policy';",
      ].join('\n'),
    'packages/ql3-cluster-admin/src/plugin-package/management/pluginPackageManagement.ts':
      "import { manager } from '@qinglong/cluster-postgres/package-manager';",
    'packages/ql3-cluster-admin/src/plugin-package/management/pluginPackageManagementTransport.ts':
      "import type { Plan } from '@qinglong/runtime-core/plugin-package-lifecycle-plan';",
  };
  for (const [relativePath, source] of Object.entries(sources)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const packagePath of [
    'packages/ql3-local-owner-cli',
    'packages/ql3-local-admin',
    'packages/ql3-local-application',
    'packages/ql3-cluster-admin',
  ]) {
    const findings = [];
    auditSourceImports(root, packagePath, findings);
    assert.deepEqual(findings, [], packagePath);
  }
});

test('local application Profile subpaths stay in exact composition owners', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-local-application-profile-boundary-'),
  );
  const sources = {
    'packages/ql3-local-application/src/application-runtime/activation.ts':
      "import type { Storage } from '@qinglong/local-sqlite/profile';",
    'packages/ql3-local-application/src/application-runtime/contract.ts':
      "import type { Storage } from '@qinglong/local-sqlite/profile';\nimport type { Adopted } from '@qinglong/local-admin/adopted-profile';",
    'packages/ql3-local-application/src/application-runtime/storageActivation.ts':
      "import { bootstrap } from '@qinglong/local-sqlite/profile';\nimport { adopted } from '@qinglong/local-admin/adopted-profile';",
    'packages/ql3-local-application/src/production-process/processApplication.ts':
      "import type { Audit } from '@qinglong/local-sqlite/profile';\nimport type { AdoptedAudit } from '@qinglong/local-admin/adopted-profile';",
  };
  for (const [relativePath, source] of Object.entries(sources)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-application', findings);
  assert.deepEqual(
    findings.map(({ code, file, specifier }) => ({ code, file, specifier })),
    [
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        file: 'packages/ql3-local-application/src/application-runtime/activation.ts',
        specifier: '@qinglong/local-sqlite/profile',
      },
    ],
  );
});

test('local process package remains SQLite, ORM and profile neutral', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-process',
    [
      "import type { LocalCompletionReceiptJournal } from '@qinglong/runtime-core/local-completion-receipt-journal';",
      "import { CompletionReceiptFileStore } from '@qinglong/local-run-recovery';",
      "import { openLocalSqliteRuntimeDatabase } from '@qinglong/local-sqlite/runtime';",
      "import { bootstrapLocalAdoptedProfileStorage } from '@qinglong/local-adopted-profile';",
    ].join('\n'),
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-process', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'DEPRECATED_LOCAL_EXECUTION_PACKAGE_IMPORT',
        specifier: '@qinglong/local-run-recovery',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        specifier: '@qinglong/local-sqlite/runtime',
      },
      {
        code: 'DELETED_LOCAL_ADOPTED_PROFILE_PACKAGE_IMPORT',
        specifier: '@qinglong/local-adopted-profile',
      },
    ],
  );
});

test('local execution package consumes only runtime-core and local-process boundaries', (t) => {
  const root = fixture(
    t,
    'packages/ql3-local-execution',
    [
      "import type { RunRepository } from '@qinglong/runtime-core/run-repository';",
      "import type { CompletionReceiptStore } from '@qinglong/local-process';",
      "import type { LocalCompletionReceiptProcessor } from '@qinglong/local-execution-control';",
      "import { openLocalSqliteRuntimeDatabase } from '@qinglong/local-sqlite/runtime';",
      "import { bootstrapLocalAdoptedProfileStorage } from '@qinglong/local-adopted-profile';",
    ].join('\n'),
  );
  const findings = [];
  auditSourceImports(root, 'packages/ql3-local-execution', findings);
  assert.deepEqual(
    findings.map(({ code, specifier }) => ({ code, specifier })),
    [
      {
        code: 'DEPRECATED_LOCAL_EXECUTION_PACKAGE_IMPORT',
        specifier: '@qinglong/local-execution-control',
      },
      {
        code: 'FORBIDDEN_PACKAGE_SOURCE_IMPORT',
        specifier: '@qinglong/local-sqlite/runtime',
      },
      {
        code: 'DELETED_LOCAL_ADOPTED_PROFILE_PACKAGE_IMPORT',
        specifier: '@qinglong/local-adopted-profile',
      },
    ],
  );
});
