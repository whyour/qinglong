const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const {
  createPluginPackageQuarantineEvent,
} = require('@qinglong/runtime-core/plugin-package-quarantine');
const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
} = require('../../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  LocalSqliteOperationAuthority,
} = require('../../dist/authority/operationAuthority');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('../../dist/plugin-package/pluginPackageInstallRepository');
const {
  LocalSqlitePluginPackageAutomationPublicationRepository,
} = require('../../dist/plugin-package/pluginPackageAutomationPublicationRepository');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('../../dist/plugin-package/pluginPackageMaterializedRevisionRepository');
const {
  LocalSqlitePluginPackageQuarantineRepository,
} = require('../../dist/plugin-package/pluginPackageQuarantineRepository');
const {
  LocalSqlitePluginPackageTaskReconciliationRepository,
} = require('../../dist/plugin-package/pluginPackageTaskReconciliationRepository');
const { auditLocalSqliteReadiness } = require('../../dist/readiness/readiness');
const { migrateLocalSqlitePath } = require('../../dist/migration/migration');

const DIGEST_D = 'd'.repeat(64);
const DIGEST_E = 'e'.repeat(64);

const CRASH_POINTS = Object.freeze({
  after_automation_withdrawal: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "QingLong3PluginPackageAutomationPublications"',
    durable: false,
  }),
  after_task_disable: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "QingLong3TaskDefinitionRevisions"',
    durable: false,
  }),
  after_quarantine_event: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "QingLong3PluginPackageQuarantineEvents"',
    durable: false,
  }),
  after_withdrawal_receipt: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "QingLong3PluginPackageWithdrawalReceipts"',
    durable: false,
  }),
  before_commit: Object.freeze({
    timing: 'beforeExec',
    sql: 'COMMIT',
    durable: false,
  }),
  after_commit: Object.freeze({
    timing: 'afterExec',
    sql: 'COMMIT',
    durable: true,
  }),
});

function fixture(profile) {
  return pluginPackageTaskReconciliationFixture(`quarantine-crash-${profile}`, {
    profile,
    workflows: [
      {
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: 'daily',
        name: 'Daily workflow',
        enabled: true,
        steps: [{ id: 'run', task: 'alpha', needs: [] }],
      },
    ],
    prompts: [
      {
        schema: 'qinglong/plugin-package-prompt-resource@v1',
        id: 'operator',
        name: 'Operator prompt',
        template: 'Run {{task}}',
        parameters: [{ name: 'task', required: true }],
      },
    ],
  });
}

function event(value) {
  const record = value.install.active;
  return createPluginPackageQuarantineEvent({
    mutationId: `quarantine-crash-${value.profile}`,
    revocationReceiptDigest: DIGEST_D,
    impactDigest: DIGEST_E,
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
}

function client(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

async function setupScenario({ databasePath, profile }) {
  await migrateLocalSqlitePath({ databasePath, profile });
  const value = fixture(profile);
  const database = client(databasePath);
  database
    .prepare(
      `INSERT INTO "QingLong3Projects"
       (id, name, slug, status, version, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'active', 1, 1, 1)`,
    )
    .run(value.projectId, value.projectId, value.projectId);
  const authority = new LocalSqliteOperationAuthority(database);
  try {
    const install = new LocalSqlitePluginPackageInstallRepository(authority);
    const materialized =
      new LocalSqlitePluginPackageMaterializedRevisionRepository(
        authority,
        value.registry,
      );
    const reconciliation =
      new LocalSqlitePluginPackageTaskReconciliationRepository(
        authority,
        value.registry,
      );
    await activateInstall(install, value);
    await materialized.publish(value.revision);
    await new LocalSqlitePluginPackageAutomationPublicationRepository(
      authority,
    ).publish(
      createInitialPluginPackageAutomationPublication(
        value.revision,
        value.registry,
        value.install.active.updatedAtMs,
      ),
    );
    await reconciliation.reconcile(value.revision, {
      async findActiveResourceGeneration() {
        return value.revision.generation;
      },
    });
  } finally {
    await authority.close();
  }
}

function writeCrashMarker(markerPath, pointName) {
  const descriptor = fs.openSync(markerPath, 'wx', 0o600);
  try {
    fs.writeSync(
      descriptor,
      JSON.stringify({
        schema: 'qinglong/sqlite-plugin-package-quarantine-crash-marker@v1',
        point: pointName,
        pid: process.pid,
      }),
    );
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function crashClient(database, pointName, markerPath) {
  const point = CRASH_POINTS[pointName];
  if (!point) throw new Error(`unknown crash point ${pointName}`);
  let triggered = false;
  const crash = () => {
    if (triggered) return;
    triggered = true;
    writeCrashMarker(markerPath, pointName);
    process.kill(process.pid, 'SIGKILL');
    throw new Error(`SIGKILL did not terminate ${pointName}`);
  };
  const matches = (timing, sql) =>
    !triggered && point.timing === timing && sql.trim().includes(point.sql);
  return new Proxy(database, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          if (matches('beforeExec', sql)) crash();
          const result = target.exec(sql);
          if (matches('afterExec', sql)) crash();
          return result;
        };
      }
      if (property === 'prepare') {
        return (sql) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              const value = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget,
              );
              if (statementProperty === 'run') {
                return (...values) => {
                  const result = value.apply(statementTarget, values);
                  if (matches('afterRun', sql)) crash();
                  return result;
                };
              }
              return typeof value === 'function'
                ? value.bind(statementTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function runCrashScenario({
  databasePath,
  markerPath,
  pointName,
  profile,
}) {
  const database = client(databasePath);
  const authority = new LocalSqliteOperationAuthority(
    crashClient(database, pointName, markerPath),
  );
  const value = fixture(profile);
  await new LocalSqlitePluginPackageQuarantineRepository(authority, {
    registry: value.registry,
    activeSourceLimit: profile === 'edge' ? 4 : 16,
  }).quarantine(event(value), () => {});
  throw new Error(`crash point ${pointName} was not reached`);
}

async function verifyScenario({ databasePath, pointName, profile }) {
  const point = CRASH_POINTS[pointName];
  const value = fixture(profile);
  const quarantineEvent = event(value);
  const database = client(databasePath);
  const authority = new LocalSqliteOperationAuthority(database);
  try {
    const repository = new LocalSqlitePluginPackageQuarantineRepository(
      authority,
      {
        registry: value.registry,
        activeSourceLimit: profile === 'edge' ? 4 : 16,
      },
    );
    const beforeRecovery = await repository.findByEventDigest(
      quarantineEvent.eventDigest,
    );
    if (point.durable !== (beforeRecovery !== null)) {
      throw new Error(`${profile}/${pointName} durability is inconsistent`);
    }
    const recovered = await repository.quarantine(quarantineEvent, () => {});
    if (recovered.status !== (point.durable ? 'existing' : 'created')) {
      throw new Error(`${profile}/${pointName} replay status is inconsistent`);
    }
    const taskFacts = database
      .prepare(
        `SELECT revision.enabled, head.current_revision AS "currentRevision"
         FROM "QingLong3TaskDefinitions" AS head
         JOIN "QingLong3TaskDefinitionRevisions" AS revision
           ON revision.project_id = head.project_id
          AND revision.task_id = head.task_id
          AND revision.revision = head.current_revision
         WHERE head.project_id = ?
         ORDER BY head.task_id`,
      )
      .all(value.projectId);
    if (
      taskFacts.length !== 2 ||
      taskFacts.some((fact) => fact.enabled !== 0 || fact.currentRevision !== 2)
    ) {
      throw new Error(`${profile}/${pointName} Task withdrawal is incomplete`);
    }
    const automation = database
      .prepare(
        `SELECT publication.state,
                publication.lifecycle_event_digest AS "lifecycleEventDigest"
         FROM "QingLong3PluginPackageAutomationPublicationHeads" AS head
         JOIN "QingLong3PluginPackageAutomationPublications" AS publication
           ON publication.publication_digest = head.publication_digest
         WHERE head.project_id = ? AND head.package_name = ?`,
      )
      .get(value.projectId, value.packageName);
    if (
      automation?.state !== 'withdrawn' ||
      automation.lifecycleEventDigest !== quarantineEvent.eventDigest
    ) {
      throw new Error(
        `${profile}/${pointName} automation withdrawal is incomplete`,
      );
    }
    await auditLocalSqliteReadiness(database);
    const integrity = database.prepare('PRAGMA integrity_check').get();
    const foreignKey = database
      .prepare('SELECT * FROM pragma_foreign_key_check LIMIT 1')
      .get();
    const journal = database.prepare('PRAGMA journal_mode').get();
    return Object.freeze({
      profile,
      pointName,
      crashBeforeCommit: !point.durable,
      durableAfterCrash: point.durable,
      integrityCheck: Object.values(integrity)[0],
      foreignKeyCheck: foreignKey === undefined ? 'ok' : 'failed',
      journalMode: journal.journal_mode,
    });
  } finally {
    await authority.close();
  }
}

module.exports = {
  CRASH_POINTS,
  setupScenario,
  verifyScenario,
};

if (require.main === module) {
  const [, , action, databasePath, markerPath, pointName, profile] =
    process.argv;
  if (action !== 'crash') {
    throw new Error('fixture action must be crash');
  }
  runCrashScenario({
    databasePath,
    markerPath,
    pointName,
    profile,
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
