const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  PluginPackageAutomationPublicationConflictError,
  PluginPackageAutomationPublicationUnavailableError,
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  createPluginPackageQuarantineEvent,
} = require('@qinglong/runtime-core/plugin-package-quarantine');
const {
  pluginPackageAutomationPublicationFixture,
  registerPluginPackageAutomationPublicationRepositoryContract,
} = require('../../../test/contracts/pluginPackageAutomationPublicationRepositoryContract.cjs');
const {
  activateInstall,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  LocalSqlitePluginPackageAutomationPublicationRepository,
} = require('../dist/plugin-package/pluginPackageAutomationPublicationRepository');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('../dist/plugin-package/pluginPackageInstallRepository');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('../dist/plugin-package/pluginPackageMaterializedRevisionRepository');
const { migrateLocalSqliteDatabase } = require('../dist/migration/migration');

const digest = (value) => value.repeat(64);

function insertQuarantine(client, fixture) {
  const record = fixture.install.active;
  const event = createPluginPackageQuarantineEvent({
    mutationId: `quarantine-${fixture.namespace}`,
    revocationReceiptDigest: digest('d'),
    impactDigest: digest('e'),
    target: {
      projectId: record.projectId,
      packageName: record.packageName,
      installationId: record.installationId,
      lockDigest: record.lockDigest,
      installState: record.state,
      installVersion: record.version,
      installRecordDigest: record.recordDigest,
      activeLockDigest: record.activeLockDigest,
    },
    proposer: { type: 'user', id: 'owner-a' },
    confirmer: { type: 'user', id: 'owner-b' },
    authorizationMode: 'dual_control',
    reasonCode: 'confirmed_key_compromise',
    occurredAtMs: record.updatedAtMs + 1,
  });
  client
    .prepare(
      `INSERT INTO "QingLong3PluginPackageQuarantineEvents" (
         event_digest, mutation_id, revocation_receipt_digest, impact_digest,
         project_id, package_name, installation_id, lock_digest,
         install_state, install_version, install_record_digest,
         active_lock_digest, proposer_type, proposer_id, confirmer_type,
         confirmer_id, authorization_mode, reason_code, occurred_at_ms,
         event_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.eventDigest,
      event.mutationId,
      event.revocationReceiptDigest,
      event.impactDigest,
      event.target.projectId,
      event.target.packageName,
      event.target.installationId,
      event.target.lockDigest,
      event.target.installState,
      event.target.installVersion,
      event.target.installRecordDigest,
      event.target.activeLockDigest,
      event.proposer.type,
      event.proposer.id,
      event.confirmer.type,
      event.confirmer.id,
      event.authorizationMode,
      event.reasonCode,
      event.occurredAtMs,
      JSON.stringify(event),
    );
}

async function createRepository(_t, fixture) {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  client
    .prepare(
      `INSERT INTO "QingLong3Projects"
       (id, name, slug, status, version, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'active', 1, 1, 1)`,
    )
    .run(fixture.projectId, fixture.projectId, fixture.projectId);
  return {
    client,
    repository:
      new LocalSqlitePluginPackageAutomationPublicationRepository(client),
    materializedRepository:
      new LocalSqlitePluginPackageMaterializedRevisionRepository(
        client,
        fixture.registry,
      ),
    close: () => client.close(),
  };
}

registerPluginPackageAutomationPublicationRepositoryContract({
  name: 'SQLite Plugin Package automation publication repository',
  namespace: 'sqlite-automation-publication',
  profile: 'edge',
  createRepository,
});

test('fails closed when publication JSON is changed in place', async (t) => {
  const fixture = pluginPackageAutomationPublicationFixture(
    'sqlite-automation-corrupt',
    { profile: 'edge', name: 'daily' },
  );
  const harness = await createRepository(t, fixture);
  t.after(() => harness.close());
  await harness.materializedRepository.publish(fixture.revision);
  const publication = createInitialPluginPackageAutomationPublication(
    fixture.revision,
    fixture.registry,
    1_000,
  );
  await harness.repository.publish(publication);
  harness.client.exec('PRAGMA ignore_check_constraints = ON');
  harness.client
    .prepare(
      `UPDATE "QingLong3PluginPackageAutomationPublications"
       SET publication_json =
         json_set(publication_json, '$.definitions.workflows[0].name', 'Drift')
       WHERE publication_digest = ?`,
    )
    .run(publication.publicationDigest);
  await assert.rejects(
    harness.repository.findByDigest(publication.publicationDigest),
    PluginPackageAutomationPublicationUnavailableError,
  );
});

test('lists only materialized active generations whose automation head is stale', async (t) => {
  const fixture = pluginPackageAutomationPublicationFixture(
    'sqlite-automation-pending',
    { profile: 'edge', name: 'daily' },
  );
  const harness = await createRepository(t, fixture);
  t.after(() => harness.close());
  const installRepository =
    new LocalSqlitePluginPackageInstallRepository(harness.client);
  await activateInstall(installRepository, fixture);
  assert.deepEqual(await harness.repository.listPendingPage({ limit: 1 }), {
    candidates: [],
    truncated: false,
  });

  await harness.materializedRepository.publish(fixture.revision);
  assert.deepEqual(await harness.repository.listPendingPage({ limit: 1 }), {
    candidates: [
      {
        projectId: fixture.projectId,
        packageName: fixture.packageName,
      },
    ],
    truncated: false,
  });
  const publication = createInitialPluginPackageAutomationPublication(
    fixture.revision,
    fixture.registry,
    1_000,
  );
  await harness.repository.publish(publication);
  assert.deepEqual(await harness.repository.listPendingPage({ limit: 1 }), {
    candidates: [],
    truncated: false,
  });
});

test('admits only the exact active current automation publication', async (t) => {
  const fixture = pluginPackageAutomationPublicationFixture(
    'sqlite-automation-start-guard',
    { profile: 'edge', name: 'daily' },
  );
  const harness = await createRepository(t, fixture);
  t.after(() => harness.close());
  await activateInstall(
    new LocalSqlitePluginPackageInstallRepository(harness.client),
    fixture,
  );
  await harness.materializedRepository.publish(fixture.revision);
  const publication = createInitialPluginPackageAutomationPublication(
    fixture.revision,
    fixture.registry,
    1_000,
  );
  await harness.repository.publish(publication);

  assert.equal(
    await harness.repository.isStartAllowed(
      fixture.projectId,
      fixture.packageName,
      publication.publicationDigest,
    ),
    true,
  );
  assert.equal(
    await harness.repository.isStartAllowed(
      fixture.projectId,
      fixture.packageName,
      digest('f'),
    ),
    false,
  );
});

test('quarantine atomically removes pending work and rejects publication', async (t) => {
  const fixture = pluginPackageAutomationPublicationFixture(
    'sqlite-automation-quarantine',
    { profile: 'edge', name: 'daily' },
  );
  const harness = await createRepository(t, fixture);
  t.after(() => harness.close());
  await activateInstall(
    new LocalSqlitePluginPackageInstallRepository(harness.client),
    fixture,
  );
  await harness.materializedRepository.publish(fixture.revision);
  assert.deepEqual(await harness.repository.listPendingPage({ limit: 1 }), {
    candidates: [
      {
        projectId: fixture.projectId,
        packageName: fixture.packageName,
      },
    ],
    truncated: false,
  });

  insertQuarantine(harness.client, fixture);
  assert.deepEqual(await harness.repository.listPendingPage({ limit: 1 }), {
    candidates: [],
    truncated: false,
  });
  const publication = createInitialPluginPackageAutomationPublication(
    fixture.revision,
    fixture.registry,
    1_000,
  );
  await assert.rejects(
    harness.repository.publish(publication),
    PluginPackageAutomationPublicationConflictError,
  );
  assert.equal(
    await harness.repository.isStartAllowed(
      fixture.projectId,
      fixture.packageName,
      publication.publicationDigest,
    ),
    false,
  );
});

test('publishes storage only through the explicit subpath', () => {
  const entrypoint = require('@qinglong/local-sqlite/plugin-package-automation-publication');
  assert.equal(
    entrypoint.LocalSqlitePluginPackageAutomationPublicationRepository,
    LocalSqlitePluginPackageAutomationPublicationRepository,
  );
  assert.equal(
    require('../dist')
      .LocalSqlitePluginPackageAutomationPublicationRepository,
    undefined,
  );
});
