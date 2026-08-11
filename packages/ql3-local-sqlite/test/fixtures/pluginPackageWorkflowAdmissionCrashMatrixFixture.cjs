const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { performance } = require('node:perf_hooks');

const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  createPluginPackageWorkflowExecutionPlan,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
} = require('../../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  LocalSqliteOperationAuthority,
} = require('../../dist/authority/operationAuthority');
const {
  LocalSqlitePluginPackageAutomationPublicationRepository,
} = require('../../dist/plugin-package/pluginPackageAutomationPublicationRepository');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('../../dist/plugin-package/pluginPackageInstallRepository');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('../../dist/plugin-package/pluginPackageMaterializedRevisionRepository');
const {
  LocalSqlitePluginPackageWorkflowAdmissionRepository,
} = require('../../dist/plugin-package/workflow/pluginPackageWorkflowAdmissionRepository');
const { auditLocalSqliteReadiness } = require('../../dist/readiness/readiness');
const { migrateLocalSqlitePath } = require('../../dist/migration/migration');

const CRASH_POINTS = Object.freeze({
  after_run: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "Runs"',
    durable: false,
  }),
  after_admission_event: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "RunEvents"',
    durable: false,
  }),
  after_first_step_run: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "StepRuns"',
    durable: false,
  }),
  after_first_step_mutation: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "StepRunMutations"',
    durable: false,
  }),
  after_admission: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "QingLong3PluginPackageWorkflowAdmissions"',
    durable: false,
  }),
  after_first_admission_step: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "QingLong3PluginPackageWorkflowAdmissionSteps"',
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
  const value = pluginPackageTaskReconciliationFixture(
    `workflow-admission-crash-${profile}`,
    {
      profile,
      workflows: [
        {
          schema: 'qinglong/plugin-package-workflow-resource@v1',
          id: 'daily',
          name: 'Daily workflow',
          enabled: true,
          steps: [
            { id: 'collect', task: 'alpha', needs: [] },
            { id: 'summarize', task: 'beta', needs: ['collect'] },
          ],
        },
      ],
    },
  );
  return {
    ...value,
    publication: createInitialPluginPackageAutomationPublication(
      value.revision,
      value.registry,
      2_000,
    ),
  };
}

function executionPlan(value) {
  return createPluginPackageWorkflowExecutionPlan({
    planId: `workflow-admission-crash-plan-${value.profile}`,
    runId: `wfa-crash-run-${value.profile}`,
    workflowId: 'daily',
    stepRunIds: {
      collect: `workflow-admission-crash-collect-${value.profile}`,
      summarize: `workflow-admission-crash-summary-${value.profile}`,
    },
    publication: value.publication,
    revision: value.revision,
    taskSpecSemanticRegistry: value.registry,
    plannedAtMs: 3_000,
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
    await activateInstall(
      new LocalSqlitePluginPackageInstallRepository(authority),
      value,
    );
    await new LocalSqlitePluginPackageMaterializedRevisionRepository(
      authority,
      value.registry,
    ).publish(value.revision);
    await new LocalSqlitePluginPackageAutomationPublicationRepository(
      authority,
    ).publish(value.publication);
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
        schema:
          'qinglong/sqlite-plugin-package-workflow-admission-crash-marker@v1',
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
  await new LocalSqlitePluginPackageWorkflowAdmissionRepository(
    authority,
  ).admit(executionPlan(value));
  throw new Error(`crash point ${pointName} was not reached`);
}

async function verifyScenario({ databasePath, pointName, profile }) {
  const point = CRASH_POINTS[pointName];
  const value = fixture(profile);
  const plan = executionPlan(value);
  const database = client(databasePath);
  const authority = new LocalSqliteOperationAuthority(database);
  try {
    const repository = new LocalSqlitePluginPackageWorkflowAdmissionRepository(
      authority,
    );
    const beforeRecovery = await repository.findByPlanId(plan.planId);
    if (point.durable !== (beforeRecovery !== null)) {
      throw new Error(`${profile}/${pointName} durability is inconsistent`);
    }
    const recovered = await repository.admit(plan);
    if (recovered.status !== (point.durable ? 'existing' : 'created')) {
      throw new Error(`${profile}/${pointName} replay status is inconsistent`);
    }
    const counts = database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM "Runs") AS runs,
           (SELECT COUNT(*) FROM "StepRuns") AS steps,
           (SELECT COUNT(*) FROM "RunEvents") AS events,
           (SELECT COUNT(*) FROM "StepRunMutations") AS mutations,
           (SELECT COUNT(*)
            FROM "QingLong3PluginPackageWorkflowAdmissions") AS admissions,
           (SELECT COUNT(*)
            FROM "QingLong3PluginPackageWorkflowAdmissionSteps")
              AS admissionSteps`,
      )
      .get();
    if (
      counts.runs !== 1 ||
      counts.steps !== 2 ||
      counts.events !== 3 ||
      counts.mutations !== 2 ||
      counts.admissions !== 1 ||
      counts.admissionSteps !== 2
    ) {
      throw new Error(`${profile}/${pointName} evidence is incomplete`);
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
      pointName,
      crashBeforeCommit: !point.durable,
      durableAfterCrash: point.durable,
      exactReplay:
        recovered.status === (point.durable ? 'existing' : 'created'),
      integrityCheck: Object.values(integrity)[0],
      foreignKeyCheck: foreignKey === undefined ? 'ok' : 'failed',
      journalMode: journal.journal_mode,
      synchronous: synchronous.synchronous,
    });
  } finally {
    await authority.close();
  }
}

function measuredClient(database, measurement) {
  let lockStartedAt;
  return new Proxy(database, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          const normalized = sql.trim().toUpperCase();
          const result = target.exec(sql);
          if (normalized === 'BEGIN IMMEDIATE') {
            if (lockStartedAt !== undefined) {
              throw new Error('nested Workflow admission write lock');
            }
            measurement.beginImmediateCount += 1;
            lockStartedAt = performance.now();
          } else if (normalized === 'COMMIT') {
            if (lockStartedAt === undefined) {
              throw new Error(
                'Workflow admission committed without a write lock',
              );
            }
            measurement.commitCount += 1;
            measurement.lockDurationsMs.push(performance.now() - lockStartedAt);
            lockStartedAt = undefined;
          } else if (normalized === 'ROLLBACK') {
            measurement.rollbackCount += 1;
            lockStartedAt = undefined;
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function measuredExecutionPlan(value, sequence) {
  const suffix = String(sequence).padStart(4, '0');
  return createPluginPackageWorkflowExecutionPlan({
    planId: `wfl-plan-${value.profile}-${suffix}`,
    runId: `wfl-run-${value.profile}-${suffix}`,
    workflowId: 'daily',
    stepRunIds: {
      collect: `wfl-collect-${value.profile}-${suffix}`,
      summarize: `wfl-summary-${value.profile}-${suffix}`,
    },
    publication: value.publication,
    revision: value.revision,
    taskSpecSemanticRegistry: value.registry,
    plannedAtMs: 4_000 + sequence,
  });
}

function rounded(value) {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(sortedValues, percentileValue) {
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil((percentileValue / 100) * sortedValues.length) - 1,
  );
  return sortedValues[Math.max(0, index)];
}

async function measureWorkflowAdmissionTransactions({
  databasePath,
  profile,
  samples,
}) {
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 1_000) {
    throw new RangeError('Workflow admission samples are out of range');
  }
  const value = fixture(profile);
  const database = client(databasePath);
  const measurement = {
    beginImmediateCount: 0,
    commitCount: 0,
    rollbackCount: 0,
    lockDurationsMs: [],
  };
  const authority = new LocalSqliteOperationAuthority(
    measuredClient(database, measurement),
  );
  try {
    const repository = new LocalSqlitePluginPackageWorkflowAdmissionRepository(
      authority,
    );
    for (let sequence = 1; sequence <= samples; sequence += 1) {
      const result = await repository.admit(
        measuredExecutionPlan(value, sequence),
      );
      if (result.status !== 'created') {
        throw new Error(
          `Workflow admission sample ${sequence} was not newly committed`,
        );
      }
    }
    const counts = database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM "Runs") AS runs,
           (SELECT COUNT(*) FROM "StepRuns") AS steps,
           (SELECT COUNT(*)
              FROM "QingLong3PluginPackageWorkflowAdmissions") AS admissions,
           (SELECT COUNT(*)
              FROM "QingLong3PluginPackageWorkflowAdmissionSteps")
             AS admissionSteps`,
      )
      .get();
    if (
      counts.runs !== samples ||
      counts.steps !== samples * 2 ||
      counts.admissions !== samples ||
      counts.admissionSteps !== samples * 2
    ) {
      throw new Error('Workflow admission measurement facts are incomplete');
    }
    await auditLocalSqliteReadiness(database);
    const integrity = database.prepare('PRAGMA integrity_check').get();
    const foreignKey = database
      .prepare('SELECT * FROM pragma_foreign_key_check LIMIT 1')
      .get();
    const journal = database.prepare('PRAGMA journal_mode').get();
    const synchronous = database.prepare('PRAGMA synchronous').get();
    const sorted = [...measurement.lockDurationsMs].sort(
      (left, right) => left - right,
    );
    return Object.freeze({
      profile,
      samples,
      beginImmediateCount: measurement.beginImmediateCount,
      commitCount: measurement.commitCount,
      rollbackCount: measurement.rollbackCount,
      oneWriteTransactionPerWorkflow:
        measurement.beginImmediateCount === samples &&
        measurement.commitCount === samples &&
        measurement.rollbackCount === 0,
      lockDurationMs: Object.freeze({
        p50: rounded(percentile(sorted, 50)),
        p95: rounded(percentile(sorted, 95)),
        p99: rounded(percentile(sorted, 99)),
        max: rounded(sorted.at(-1)),
      }),
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
  executionPlan,
  fixture,
  measureWorkflowAdmissionTransactions,
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
