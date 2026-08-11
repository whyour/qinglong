const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const {
  createApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createPluginPackageLifecycleEvent,
  pluginPackageLifecycleActionDigest,
} = require('@qinglong/runtime-core/plugin-package-lifecycle');
const {
  createProjectToolDefinitionSnapshot,
  projectToolDefinitionSnapshotContribution,
} = require('@qinglong/runtime-core/project-tool-definition-snapshot');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
} = require('../../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  LocalSqliteApprovalRequestRepository,
} = require('../../dist/approved-action/approvalRequestRepository');
const {
  LocalSqliteOperationAuthority,
} = require('../../dist/authority/operationAuthority');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('../../dist/plugin-package/pluginPackageInstallRepository');
const {
  EDGE_PLUGIN_PACKAGE_LIFECYCLE_ACTIVE_SOURCE_LIMIT,
  STANDALONE_PLUGIN_PACKAGE_LIFECYCLE_ACTIVE_SOURCE_LIMIT,
  LocalSqlitePluginPackageLifecycleRepository,
} = require('../../dist/plugin-package/pluginPackageLifecycleRepository');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('../../dist/plugin-package/pluginPackageMaterializedRevisionRepository');
const {
  LocalSqlitePluginPackageTaskReconciliationRepository,
} = require('../../dist/plugin-package/pluginPackageTaskReconciliationRepository');
const {
  LocalSqliteProjectToolDefinitionSnapshotRepository,
} = require('../../dist/tool-execution/projectToolDefinitionSnapshotRepository');
const { migrateLocalSqlitePath } = require('../../dist/migration/migration');
const { auditLocalSqliteReadiness } = require('../../dist/readiness/readiness');

const OWNER = Object.freeze({ type: 'user', id: 'owner-001' });
const SYSTEM = Object.freeze({ type: 'system', id: 'lifecycle-dispatcher' });
const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });

const CRASH_POINTS = Object.freeze({
  after_task_revision: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "QingLong3TaskDefinitionRevisions"',
    durable: false,
  }),
  after_tool_snapshot: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "QingLong3ProjectToolDefinitionSnapshots"',
    durable: false,
  }),
  after_lifecycle_event: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "QingLong3PluginPackageLifecycleEvents"',
    durable: false,
  }),
  after_lifecycle_receipt: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "QingLong3PluginPackageLifecycleReceipts"',
    durable: false,
  }),
  after_lifecycle_task: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "QingLong3PluginPackageLifecycleTasks"',
    durable: false,
  }),
  after_lifecycle_head: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "QingLong3PluginPackageLifecycleHeads"',
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
  return pluginPackageTaskReconciliationFixture(
    `lifecycle-crash-${profile}`,
    { profile },
  );
}

function client(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function activeSourceLimit(profile) {
  return profile === 'edge'
    ? EDGE_PLUGIN_PACKAGE_LIFECYCLE_ACTIVE_SOURCE_LIMIT
    : STANDALONE_PLUGIN_PACKAGE_LIFECYCLE_ACTIVE_SOURCE_LIMIT;
}

function repositories(authority, value, profile) {
  return {
    approval: new LocalSqliteApprovalRequestRepository(authority),
    install: new LocalSqlitePluginPackageInstallRepository(authority),
    lifecycle: new LocalSqlitePluginPackageLifecycleRepository(authority, {
      registry: value.registry,
      activeSourceLimit: activeSourceLimit(profile),
    }),
    materialized:
      new LocalSqlitePluginPackageMaterializedRevisionRepository(
        authority,
        value.registry,
      ),
    reconciliation:
      new LocalSqlitePluginPackageTaskReconciliationRepository(
        authority,
        value.registry,
      ),
    snapshots: new LocalSqliteProjectToolDefinitionSnapshotRepository(
      authority,
    ),
  };
}

function audit(
  eventId,
  requestId,
  operationId,
  subject,
  authenticationId,
  outcome,
  projectId,
  occurredAtMs,
) {
  return {
    eventId,
    requestId,
    operationId,
    projectId,
    subject,
    authenticationId,
    outcome,
    reasons: [outcome === 'approval_required' ? 'package_review' : 'role_grant'],
    fence: FENCE,
    occurredAtMs,
  };
}

function auditId(sequence, offset) {
  return `91000000-0000-4000-8000-${String(sequence * 10 + offset).padStart(
    12,
    '0',
  )}`;
}

function approvalSequence(action) {
  return action === 'enable' ? 2 : 1;
}

async function approveLifecycleImpact(
  approval,
  value,
  impact,
  sequence,
) {
  const requestId = `lifecycle-crash-approval-${sequence}`;
  const dispatchId = `lifecycle-crash-dispatch-${sequence}`;
  const requestedAtMs = 10_000 * sequence + 1;
  const decidedAtMs = requestedAtMs + 1;
  const consumedAtMs = requestedAtMs + 2;
  const expiresAtMs = requestedAtMs + 1_000;
  const action = {
    permission: 'package.manage',
    actionType: `plugin_package.lifecycle.${impact.action}`,
    actionRef: `lifecycle:${impact.impactDigest}`,
    actionDigest: pluginPackageLifecycleActionDigest(impact),
    previewDigest: impact.impactDigest,
  };
  await approval.create({
    request: createApprovalRequest({
      id: requestId,
      projectId: value.projectId,
      action,
      risk: 'high',
      decisionMode: 'human_confirmation',
      requestedBy: OWNER,
      requestedAtMs,
      expiresAtMs,
      requestFence: FENCE,
    }),
    audit: audit(
      auditId(sequence, 1),
      `lifecycle-crash-http-${sequence}`,
      'approval.request',
      OWNER,
      `auth-request-${sequence}`,
      'approval_required',
      value.projectId,
      requestedAtMs,
    ),
  });
  await approval.decide({
    requestId,
    expectedVersion: 1,
    decisionId: `lifecycle-crash-decision-${sequence}`,
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: OWNER,
      authenticationId: `auth-approve-${sequence}`,
      authenticatedAtMs: decidedAtMs - 1,
      expiresAtMs,
      assurance: 'local_console',
    },
    decidedAtMs,
    authorizationFence: FENCE,
    audit: audit(
      auditId(sequence, 2),
      `lifecycle-crash-http-${sequence}`,
      'approval.decide',
      OWNER,
      `auth-approve-${sequence}`,
      'allowed',
      value.projectId,
      decidedAtMs,
    ),
  });
  return approval.consume({
    requestId,
    expectedVersion: 2,
    consumptionId: `lifecycle-crash-consume-${sequence}`,
    dispatchId,
    action,
    requestedBy: OWNER,
    consumedBy: SYSTEM,
    consumedAtMs,
    authorizationFence: FENCE,
    audit: audit(
      auditId(sequence, 3),
      `lifecycle-crash-dispatch-cycle-${sequence}`,
      'approval.consume',
      SYSTEM,
      `auth-dispatch-${sequence}`,
      'allowed',
      value.projectId,
      consumedAtMs,
    ),
  });
}

function lifecycleEvent(impact, action) {
  const sequence = approvalSequence(action);
  return createPluginPackageLifecycleEvent({
    dispatchId: `lifecycle-crash-dispatch-${sequence}`,
    impact,
    requestedBy: OWNER,
    approvedBy: OWNER,
    authorizationMode: 'human_confirmation',
    occurredAtMs: 10_000 * sequence + 4,
  });
}

async function publishActivePackage(repositoriesValue, value) {
  await activateInstall(repositoriesValue.install, value);
  await repositoriesValue.materialized.publish(value.revision);
  await repositoriesValue.reconciliation.reconcile(value.revision, {
    async findActiveResourceGeneration() {
      return value.revision.generation;
    },
  });
  await repositoriesValue.snapshots.publish(
    createProjectToolDefinitionSnapshot({
      projectId: value.projectId,
      contributions: [
        projectToolDefinitionSnapshotContribution(
          value.revision,
          value.registry,
        ),
      ],
    }),
  );
}

async function setupScenario({ action, databasePath, profile }) {
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
  database
    .prepare(
      `INSERT INTO "QingLong3ProjectRoleBindings" (
         project_id, subject_type, subject_id, version, state, role,
         mutation_id, changed_by_type, changed_by_id, created_at_ms
       ) VALUES (?, 'user', ?, 1, 'active', 'owner', ?, 'user', ?, 1)`,
    )
    .run(
      value.projectId,
      OWNER.id,
      `grant-lifecycle-crash-${profile}`,
      OWNER.id,
    );
  const authority = new LocalSqliteOperationAuthority(database);
  try {
    const repository = repositories(authority, value, profile);
    await publishActivePackage(repository, value);
    if (action === 'enable') {
      const disableImpact = await repository.lifecycle.plan(
        'disable',
        value.projectId,
        value.packageName,
      );
      await approveLifecycleImpact(
        repository.approval,
        value,
        disableImpact,
        1,
      );
      await repository.lifecycle.transition(
        lifecycleEvent(disableImpact, 'disable'),
        () => {},
      );
    }
    const impact = await repository.lifecycle.plan(
      action,
      value.projectId,
      value.packageName,
    );
    await approveLifecycleImpact(
      repository.approval,
      value,
      impact,
      approvalSequence(action),
    );
    return lifecycleEvent(impact, action);
  } finally {
    await authority.close();
  }
}

function writeCrashMarker(markerPath, pointName, action) {
  const descriptor = fs.openSync(markerPath, 'wx', 0o600);
  try {
    fs.writeSync(
      descriptor,
      JSON.stringify({
        schema: 'qinglong/sqlite-plugin-package-lifecycle-crash-marker@v1',
        action,
        point: pointName,
        pid: process.pid,
      }),
    );
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function crashClient(database, pointName, markerPath, action) {
  const point = CRASH_POINTS[pointName];
  if (!point) throw new Error(`unknown crash point ${pointName}`);
  let triggered = false;
  const crash = () => {
    if (triggered) return;
    triggered = true;
    writeCrashMarker(markerPath, pointName, action);
    process.kill(process.pid, 'SIGKILL');
    throw new Error(`SIGKILL did not terminate ${action}/${pointName}`);
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
  action,
  databasePath,
  markerPath,
  pointName,
  profile,
}) {
  const value = fixture(profile);
  const planningAuthority = new LocalSqliteOperationAuthority(
    client(databasePath),
  );
  const impact = await repositories(
    planningAuthority,
    value,
    profile,
  ).lifecycle.plan(action, value.projectId, value.packageName);
  await planningAuthority.close();
  const database = client(databasePath);
  const authority = new LocalSqliteOperationAuthority(
    crashClient(database, pointName, markerPath, action),
  );
  const repository = repositories(authority, value, profile);
  await repository.lifecycle.transition(lifecycleEvent(impact, action), () => {});
  throw new Error(`crash point ${action}/${pointName} was not reached`);
}

function eventFacts(database, eventDigest) {
  return {
    events: database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3PluginPackageLifecycleEvents"
         WHERE event_digest = ?`,
      )
      .get(eventDigest).count,
    receipts: database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3PluginPackageLifecycleReceipts"
         WHERE event_digest = ?`,
      )
      .get(eventDigest).count,
    tasks: database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3PluginPackageLifecycleTasks"
         WHERE event_digest = ?`,
      )
      .get(eventDigest).count,
    heads: database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3PluginPackageLifecycleHeads"
         WHERE event_digest = ?`,
      )
      .get(eventDigest).count,
  };
}

function taskFacts(database, projectId) {
  return database
    .prepare(
      `SELECT revision.enabled,
              head.current_revision AS "currentRevision"
       FROM "QingLong3TaskDefinitions" AS head
       JOIN "QingLong3TaskDefinitionRevisions" AS revision
         ON revision.project_id = head.project_id
        AND revision.task_id = head.task_id
        AND revision.revision = head.current_revision
       WHERE head.project_id = ?
       ORDER BY head.task_id`,
    )
    .all(projectId);
}

function assertTaskState(facts, revision, enabled, label) {
  if (
    facts.length !== 2 ||
    facts.some(
      (fact) =>
        fact.enabled !== enabled || fact.currentRevision !== revision,
    )
  ) {
    throw new Error(`${label} Task state is incomplete`);
  }
}

async function verifyScenario({
  action,
  databasePath,
  event,
  pointName,
  profile,
}) {
  const point = CRASH_POINTS[pointName];
  const value = fixture(profile);
  const database = client(databasePath);
  const authority = new LocalSqliteOperationAuthority(database);
  try {
    const repository = repositories(authority, value, profile);
    const beforeRecovery = await repository.lifecycle.findByEventDigest(
      event.eventDigest,
    );
    if (point.durable !== (beforeRecovery !== null)) {
      throw new Error(
        `${profile}/${action}/${pointName} durability is inconsistent`,
      );
    }
    const beforeEventFacts = eventFacts(database, event.eventDigest);
    const expectedBeforeFacts = point.durable
      ? { events: 1, receipts: 1, tasks: 2, heads: 1 }
      : { events: 0, receipts: 0, tasks: 0, heads: 0 };
    if (JSON.stringify(beforeEventFacts) !== JSON.stringify(expectedBeforeFacts)) {
      throw new Error(
        `${profile}/${action}/${pointName} left partial lifecycle facts`,
      );
    }
    const beforeRevision = action === 'disable' ? 1 : 2;
    const beforeEnabled = action === 'disable' ? 1 : 0;
    const finalRevision = action === 'disable' ? 2 : 3;
    const finalEnabled = action === 'disable' ? 0 : 1;
    assertTaskState(
      taskFacts(database, value.projectId),
      point.durable ? finalRevision : beforeRevision,
      point.durable ? finalEnabled : beforeEnabled,
      `${profile}/${action}/${pointName} pre-recovery`,
    );
    const beforeSnapshot = await repository.snapshots.findCurrent(
      value.projectId,
    );
    const expectedBeforeSourceCount = point.durable
      ? action === 'enable'
        ? 1
        : 0
      : action === 'enable'
        ? 0
        : 1;
    if (beforeSnapshot.snapshot.sources.length !== expectedBeforeSourceCount) {
      throw new Error(
        `${profile}/${action}/${pointName} Tool snapshot is partial`,
      );
    }
    const recovered = await repository.lifecycle.transition(event, () => {});
    if (recovered.status !== (point.durable ? 'existing' : 'created')) {
      throw new Error(
        `${profile}/${action}/${pointName} replay status is inconsistent`,
      );
    }
    assertTaskState(
      taskFacts(database, value.projectId),
      finalRevision,
      finalEnabled,
      `${profile}/${action}/${pointName} recovered`,
    );
    const recoveredSnapshot = await repository.snapshots.findCurrent(
      value.projectId,
    );
    const finalSourceCount = action === 'enable' ? 1 : 0;
    if (recoveredSnapshot.snapshot.sources.length !== finalSourceCount) {
      throw new Error(
        `${profile}/${action}/${pointName} recovered Tool snapshot is invalid`,
      );
    }
    const recoveredFacts = eventFacts(database, event.eventDigest);
    if (
      JSON.stringify(recoveredFacts) !==
      JSON.stringify({ events: 1, receipts: 1, tasks: 2, heads: 1 })
    ) {
      throw new Error(
        `${profile}/${action}/${pointName} replay is not exactly once`,
      );
    }
    const head = await repository.lifecycle.findHead(
      value.projectId,
      value.packageName,
    );
    const expectedDisposition = action === 'enable' ? 'active' : 'disabled';
    if (
      !head ||
      head.disposition !== expectedDisposition ||
      head.eventDigest !== event.eventDigest
    ) {
      throw new Error(
        `${profile}/${action}/${pointName} lifecycle head is invalid`,
      );
    }
    await auditLocalSqliteReadiness(database);
    const integrity = database.prepare('PRAGMA integrity_check').get();
    const foreignKey = database
      .prepare('SELECT * FROM pragma_foreign_key_check LIMIT 1')
      .get();
    const journal = database.prepare('PRAGMA journal_mode').get();
    const synchronous = database.prepare('PRAGMA synchronous').get();
    return Object.freeze({
      profile,
      action,
      pointName,
      crashBeforeCommit: !point.durable,
      durableAfterCrash: point.durable,
      exactReplay: true,
      integrityCheck: Object.values(integrity)[0],
      foreignKeyCheck: foreignKey === undefined ? 'ok' : 'failed',
      journalMode: journal.journal_mode,
      synchronous: synchronous.synchronous,
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
  const [
    ,
    ,
    command,
    databasePath,
    markerPath,
    pointName,
    profile,
    action,
  ] = process.argv;
  if (command !== 'crash') {
    throw new Error('fixture command must be crash');
  }
  runCrashScenario({
    action,
    databasePath,
    markerPath,
    pointName,
    profile,
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
