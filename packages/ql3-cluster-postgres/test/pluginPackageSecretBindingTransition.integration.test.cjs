const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PluginPackageSecretBindingConflictError,
  createPluginPackageSecretBinding,
} = require('@qinglong/runtime-core/plugin-package-secret-binding');
const {
  createPluginPackageResourceGeneration,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  assertPostgresPackageExecutorSchemaReady,
  createPostgresDatabaseOpener,
  PostgresPluginPackageSecretBindingRepository,
} = require('../dist/entrypoints/packageExecutor');
const {
  runPostgresMigrations,
} = require('../dist/migration/migration');

const migrationConnectionString =
  process.env.QL3_TEST_POSTGRES_MIGRATION_URL;
const executorConnectionString =
  process.env.QL3_TEST_POSTGRES_PACKAGE_EXECUTOR_URL;

function manifest(packageName) {
  return {
    apiVersion: 'qinglong.io/v1alpha1',
    kind: 'Package',
    metadata: {
      name: packageName,
      displayName: packageName,
      version: '1.0.0',
      description: 'PostgreSQL Secret binding transition gate',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64'],
        deploymentProfiles: ['cluster-control'],
      },
      runtimes: [],
      resources: {
        memory: { recommended: '16Mi' },
        disk: { install: '4Mi', working: '8Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets: [{ name: 'TOKEN', required: true }],
        tools: [],
      },
      contents: { tasks: [], workflows: [], prompts: [], tools: [] },
    },
  };
}

function binding({
  projectId,
  packageName,
  installationId,
  lockDigest,
  generation,
  previousActiveLockDigest,
  digestSeed,
}) {
  const packageManifest = manifest(packageName);
  const resourceGeneration = createPluginPackageResourceGeneration({
    installationId,
    projectId,
    packageName,
    lockDigest,
    generation,
    previousActiveLockDigest,
    contentDigest: digestSeed.repeat(64),
    contents: packageManifest.spec.contents,
  });
  return createPluginPackageSecretBinding({
    generation: resourceGeneration,
    manifest: packageManifest,
    assignments: [
      {
        name: 'TOKEN',
        secretRef: createSecretRef({
          projectId,
          name: 'runtime-token',
          version: generation,
        }),
      },
    ],
    authority: {
      kind: 'approved-action-execution',
      evidenceDigest: digestSeed.repeat(64),
    },
    boundAtMs: 100 + generation,
  });
}

async function insertProject(pool, projectId) {
  await pool.query(
    `INSERT INTO "ql3"."projects" (
       id, name, slug, status, version, created_at_ms, updated_at_ms
     ) VALUES ($1, $1, $1, 'active', 1, 1, 1)`,
    [projectId],
  );
}

async function insertInstall(
  pool,
  {
    projectId,
    packageName,
    installationId,
    lockDigest,
    targetGeneration,
    previousActiveLockDigest,
    activeLockDigest,
    state,
    manifestDigest,
    createdAtMs,
  },
) {
  const recordDigest = lockDigest;
  const mutationDigest = lockDigest;
  const lockJson = {
    lockDigest,
    projectId,
    packageName,
    manifestDigest,
  };
  const recordJson = {
    installationId,
    projectId,
    packageName,
    lockDigest,
    state,
    version: 1,
    recordDigest,
  };
  await pool.query(
    `INSERT INTO "ql3"."plugin_package_installs" (
       installation_id, project_id, package_name, package_version,
       operation, lock_digest, target_generation,
       previous_active_lock_digest, active_lock_digest, state, version,
       last_mutation_id, last_mutation_digest, lock_json, record_json,
       record_digest, created_at_ms, updated_at_ms
     ) VALUES (
       $1, $2, $3, '1.0.0', $4, $5, $6, $7, $8, $9, 1,
       $10, $11, $12::jsonb, $13::jsonb, $14, $15, $15
     )`,
    [
      installationId,
      projectId,
      packageName,
      targetGeneration === 1 ? 'install' : 'upgrade',
      lockDigest,
      targetGeneration,
      previousActiveLockDigest,
      activeLockDigest,
      state,
      `mutation-${installationId}`,
      mutationDigest,
      JSON.stringify(lockJson),
      JSON.stringify(recordJson),
      recordDigest,
      createdAtMs,
    ],
  );
}

async function insertHead(pool, value) {
  await pool.query(
    `INSERT INTO "ql3"."plugin_package_install_heads" (
       project_id, package_name, installation_id
     ) VALUES ($1, $2, $3)`,
    [value.projectId, value.packageName, value.installationId],
  );
}

async function insertBindingDirectly(pool, value) {
  return pool.query(
    `INSERT INTO "ql3"."plugin_package_secret_bindings" (
       generation_digest, project_id, package_name, installation_id,
       lock_digest, generation, manifest_digest, authority_kind,
       evidence_digest, bound_at_ms, binding_digest, binding_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
     )`,
    [
      value.target.generationDigest,
      value.target.projectId,
      value.target.packageName,
      value.target.installationId,
      value.target.lockDigest,
      value.target.generation,
      value.target.manifestDigest,
      value.authority.kind,
      value.authority.evidenceDigest,
      value.boundAtMs,
      value.bindingDigest,
      JSON.stringify(value),
    ],
  );
}

async function open(role, connectionString) {
  return createPostgresDatabaseOpener({
    role,
    connection: {
      connectionString,
      tls: { mode: 'disable' },
    },
    pool: {
      maxConnections: 1,
      applicationName: `ql3-b2-secret-binding-${role}`,
    },
    onPoolError(error) {
      throw error;
    },
  })();
}

if (!migrationConnectionString || !executorConnectionString) {
  test('PostgreSQL Secret binding transition gate requires migration and executor URLs', {
    skip: true,
  });
} else {
  test('PostgreSQL enforces active and reviewed staged Secret binding targets', async () => {
    const migrationDatabase = await open(
      'migration',
      migrationConnectionString,
    );
    let executorDatabase;
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      executorDatabase = await open(
        'package-executor',
        executorConnectionString,
      );
      const readiness = await assertPostgresPackageExecutorSchemaReady(
        executorDatabase.pool,
      );
      assert.equal(readiness.ready, true);
      assert.equal(readiness.contractVersion, 61);

      const repository = new PostgresPluginPackageSecretBindingRepository(
        executorDatabase.pool,
      );
      const namespace = `b2-${process.pid}-${Date.now()}`;

      const activeProjectId = `${namespace}-active`;
      const activePackageName = 'active-binding';
      const activeInstallationId = `${namespace}-active-install`;
      const activeLockDigest = 'a'.repeat(64);
      const activeBinding = binding({
        projectId: activeProjectId,
        packageName: activePackageName,
        installationId: activeInstallationId,
        lockDigest: activeLockDigest,
        generation: 1,
        previousActiveLockDigest: null,
        digestSeed: 'b',
      });
      await insertProject(migrationDatabase.pool, activeProjectId);
      await insertInstall(migrationDatabase.pool, {
        projectId: activeProjectId,
        packageName: activePackageName,
        installationId: activeInstallationId,
        lockDigest: activeLockDigest,
        targetGeneration: 1,
        previousActiveLockDigest: null,
        activeLockDigest,
        state: 'active',
        manifestDigest: activeBinding.target.manifestDigest,
        createdAtMs: 1,
      });
      await insertHead(migrationDatabase.pool, {
        projectId: activeProjectId,
        packageName: activePackageName,
        installationId: activeInstallationId,
      });
      assert.equal((await repository.publish(activeBinding)).status, 'created');

      const stagedProjectId = `${namespace}-staged`;
      const stagedPackageName = 'staged-binding';
      const previousInstallationId = `${namespace}-previous-install`;
      const stagedInstallationId = `${namespace}-staged-install`;
      const previousLockDigest = 'c'.repeat(64);
      const stagedLockDigest = 'd'.repeat(64);
      const stagedBinding = binding({
        projectId: stagedProjectId,
        packageName: stagedPackageName,
        installationId: stagedInstallationId,
        lockDigest: stagedLockDigest,
        generation: 2,
        previousActiveLockDigest: previousLockDigest,
        digestSeed: 'e',
      });
      await insertProject(migrationDatabase.pool, stagedProjectId);
      await insertInstall(migrationDatabase.pool, {
        projectId: stagedProjectId,
        packageName: stagedPackageName,
        installationId: previousInstallationId,
        lockDigest: previousLockDigest,
        targetGeneration: 1,
        previousActiveLockDigest: null,
        activeLockDigest: previousLockDigest,
        state: 'active',
        manifestDigest: stagedBinding.target.manifestDigest,
        createdAtMs: 1,
      });
      await insertInstall(migrationDatabase.pool, {
        projectId: stagedProjectId,
        packageName: stagedPackageName,
        installationId: stagedInstallationId,
        lockDigest: stagedLockDigest,
        targetGeneration: 2,
        previousActiveLockDigest: previousLockDigest,
        activeLockDigest: previousLockDigest,
        state: 'staged',
        manifestDigest: stagedBinding.target.manifestDigest,
        createdAtMs: 2,
      });
      await insertHead(migrationDatabase.pool, {
        projectId: stagedProjectId,
        packageName: stagedPackageName,
        installationId: stagedInstallationId,
      });
      assert.equal((await repository.publish(stagedBinding)).status, 'created');
      assert.equal((await repository.publish(stagedBinding)).status, 'existing');

      const activatingProjectId = `${namespace}-activating`;
      const activatingPackageName = 'activating-binding';
      const activatingPreviousId = `${namespace}-activating-previous`;
      const activatingInstallationId = `${namespace}-activating-install`;
      const activatingPreviousLock = 'f'.repeat(64);
      const activatingLock = '1'.repeat(64);
      const activatingBinding = binding({
        projectId: activatingProjectId,
        packageName: activatingPackageName,
        installationId: activatingInstallationId,
        lockDigest: activatingLock,
        generation: 2,
        previousActiveLockDigest: activatingPreviousLock,
        digestSeed: '2',
      });
      await insertProject(migrationDatabase.pool, activatingProjectId);
      await insertInstall(migrationDatabase.pool, {
        projectId: activatingProjectId,
        packageName: activatingPackageName,
        installationId: activatingPreviousId,
        lockDigest: activatingPreviousLock,
        targetGeneration: 1,
        previousActiveLockDigest: null,
        activeLockDigest: activatingPreviousLock,
        state: 'active',
        manifestDigest: activatingBinding.target.manifestDigest,
        createdAtMs: 1,
      });
      await insertInstall(migrationDatabase.pool, {
        projectId: activatingProjectId,
        packageName: activatingPackageName,
        installationId: activatingInstallationId,
        lockDigest: activatingLock,
        targetGeneration: 2,
        previousActiveLockDigest: activatingPreviousLock,
        activeLockDigest: activatingPreviousLock,
        state: 'activating',
        manifestDigest: activatingBinding.target.manifestDigest,
        createdAtMs: 2,
      });
      await insertHead(migrationDatabase.pool, {
        projectId: activatingProjectId,
        packageName: activatingPackageName,
        installationId: activatingInstallationId,
      });
      await assert.rejects(
        repository.publish(activatingBinding),
        PluginPackageSecretBindingConflictError,
      );
      await assert.rejects(
        insertBindingDirectly(executorDatabase.pool, activatingBinding),
        (error) =>
          error?.code === '23514' &&
          /not current active or reviewed staged generation/.test(
            error.message,
          ),
      );

      const staleProjectId = `${namespace}-stale`;
      const stalePackageName = 'stale-binding';
      const stalePreviousId = `${namespace}-stale-previous`;
      const staleInstallationId = `${namespace}-stale-install`;
      const newerInstallationId = `${namespace}-newer-install`;
      const stalePreviousLock = '3'.repeat(64);
      const staleLock = '4'.repeat(64);
      const staleBinding = binding({
        projectId: staleProjectId,
        packageName: stalePackageName,
        installationId: staleInstallationId,
        lockDigest: staleLock,
        generation: 2,
        previousActiveLockDigest: stalePreviousLock,
        digestSeed: '5',
      });
      await insertProject(migrationDatabase.pool, staleProjectId);
      await insertInstall(migrationDatabase.pool, {
        projectId: staleProjectId,
        packageName: stalePackageName,
        installationId: stalePreviousId,
        lockDigest: stalePreviousLock,
        targetGeneration: 1,
        previousActiveLockDigest: null,
        activeLockDigest: stalePreviousLock,
        state: 'active',
        manifestDigest: staleBinding.target.manifestDigest,
        createdAtMs: 1,
      });
      await insertInstall(migrationDatabase.pool, {
        projectId: staleProjectId,
        packageName: stalePackageName,
        installationId: staleInstallationId,
        lockDigest: staleLock,
        targetGeneration: 2,
        previousActiveLockDigest: stalePreviousLock,
        activeLockDigest: stalePreviousLock,
        state: 'staged',
        manifestDigest: staleBinding.target.manifestDigest,
        createdAtMs: 2,
      });
      await insertInstall(migrationDatabase.pool, {
        projectId: staleProjectId,
        packageName: stalePackageName,
        installationId: newerInstallationId,
        lockDigest: '6'.repeat(64),
        targetGeneration: 3,
        previousActiveLockDigest: stalePreviousLock,
        activeLockDigest: stalePreviousLock,
        state: 'failed',
        manifestDigest: staleBinding.target.manifestDigest,
        createdAtMs: 3,
      });
      await insertHead(migrationDatabase.pool, {
        projectId: staleProjectId,
        packageName: stalePackageName,
        installationId: staleInstallationId,
      });
      await assert.rejects(
        repository.publish(staleBinding),
        PluginPackageSecretBindingConflictError,
      );
      await assert.rejects(
        insertBindingDirectly(executorDatabase.pool, staleBinding),
        (error) => error?.code === '23514',
      );
    } finally {
      if (executorDatabase) await executorDatabase.close();
      await migrationDatabase.close();
    }
  });
}
