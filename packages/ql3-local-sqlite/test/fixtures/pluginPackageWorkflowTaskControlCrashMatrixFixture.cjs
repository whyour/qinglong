const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const {
  LocalSqliteOperationAuthority,
} = require('../../dist/authority/operationAuthority');
const {
  LocalSqlitePluginPackageTaskReconciliationRepository,
} = require('../../dist/plugin-package/pluginPackageTaskReconciliationRepository');
const {
  LocalSqlitePluginPackageWorkflowAdmissionRepository,
} = require('../../dist/plugin-package/workflow/pluginPackageWorkflowAdmissionRepository');
const {
  LocalSqlitePluginPackageWorkflowTaskAttemptAdmissionRepository,
} = require('../../dist/plugin-package/workflow/pluginPackageWorkflowTaskAttemptAdmissionRepository');
const {
  LocalSqlitePluginPackageWorkflowCancellationConvergenceRepository,
} = require('../../dist/plugin-package/workflow/pluginPackageWorkflowCancellationConvergenceRepository');
const { LocalSqliteRunRepository } = require('../../dist/run/runRepository');
const {
  LocalSqliteWorkflowTaskExecutionRepository,
} = require('../../dist/plugin-package/workflow/workflowTaskExecutionRepository');
const { auditLocalSqliteReadiness } = require('../../dist/readiness/readiness');
const {
  executionPlan,
  fixture,
  setupScenario: setupWorkflowAdmissionScenario,
} = require('./pluginPackageWorkflowAdmissionCrashMatrixFixture.cjs');

const CRASH_POINTS = Object.freeze({
  after_conclusive_stop_before_begin: Object.freeze({
    timing: 'beforeExec',
    sql: 'BEGIN IMMEDIATE',
    durable: false,
  }),
  after_attempt_terminal: Object.freeze({
    timing: 'afterRun',
    sql: 'UPDATE "RunAttempts"',
    durable: false,
  }),
  after_run_cas: Object.freeze({
    timing: 'afterRun',
    sql: 'UPDATE "Runs"',
    durable: false,
  }),
  after_step_terminal: Object.freeze({
    timing: 'afterRun',
    sql: 'UPDATE "StepRuns"',
    durable: false,
  }),
  after_attempt_event: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "RunEvents"',
    durable: false,
  }),
  after_step_mutation: Object.freeze({
    timing: 'afterRun',
    sql: 'INSERT INTO "StepRunMutations"',
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

function client(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function writeCrashMarker(markerPath, pointName) {
  const descriptor = fs.openSync(markerPath, 'wx', 0o600);
  try {
    fs.writeSync(
      descriptor,
      JSON.stringify({
        schema:
          'qinglong/sqlite-plugin-package-workflow-task-control-crash-marker@v1',
        point: pointName,
        conclusiveStopObserved: true,
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

function command(run, attempt, pointName, profile) {
  const identity = createHash('sha256')
    .update(profile)
    .update('\0')
    .update(pointName)
    .digest('hex')
    .slice(0, 16);
  return {
    run,
    attempt,
    reason: 'user',
    terminalStatus: 'cancelled',
    errorCode: 'EXECUTION_CANCELLED',
    errorSummary: 'Execution was cancelled',
    finishedAtMs: Math.max(
      Date.now(),
      run.updatedAtMs ?? 0,
      attempt.startedAtMs ?? 0,
    ),
    attemptEventId: `wfc-a-${identity}`,
    stepMutationId: `wfc-s-${identity}`,
  };
}

async function setupScenario({ databasePath, profile }) {
  await setupWorkflowAdmissionScenario({ databasePath, profile });
  const value = fixture(profile);
  const plan = executionPlan(value);
  const database = client(databasePath);
  const authority = new LocalSqliteOperationAuthority(database);
  try {
    await new LocalSqlitePluginPackageTaskReconciliationRepository(
      authority,
      value.registry,
    ).reconcile(value.revision, {
      async findActiveResourceGeneration() {
        return value.revision.generation;
      },
    });
    await new LocalSqlitePluginPackageWorkflowAdmissionRepository(
      authority,
    ).admit(plan);
    const collect = plan.steps.find(({ stepKey }) => stepKey === 'collect');
    if (!collect) throw new Error('Workflow collect Step is missing');
    const admitted =
      await new LocalSqlitePluginPackageWorkflowTaskAttemptAdmissionRepository(
        authority,
      ).admit(plan.runId, collect.stepRunId);
    const runs = new LocalSqliteRunRepository(database);
    const execution = new LocalSqliteWorkflowTaskExecutionRepository(authority);
    const callbackTokenHash = 'c'.repeat(64);
    const startingAtMs = admitted.receipt.admittedAtMs + 1;
    const runningAtMs = startingAtMs + 1;
    const prepared = await execution.prepare({
      runId: plan.runId,
      attemptId: admitted.receipt.attemptId,
      stepRunId: collect.stepRunId,
      callbackTokenHash,
      deadlineAtMs: startingAtMs + 60_000,
      logArtifactId: 'local-0123456789abcdef0123456789abcd',
      atMs: startingAtMs,
      eventId: `wfc-start-${profile}`,
    });
    if (prepared.status !== 'applied') {
      throw new Error('Workflow Task did not enter starting');
    }
    const run = await runs.findRunById(plan.runId);
    const attempt = await runs.findAttemptById(admitted.receipt.attemptId);
    if (!run || !attempt) {
      throw new Error('Workflow Task starting authority is missing');
    }
    const running = await execution.recordRunning({
      run,
      attempt,
      callbackTokenHash,
      executorHandle: `qlp:v1:workflow-control-${profile}`,
      pid: 321,
      startedAtMs: runningAtMs,
      attemptEventId: `wfc-running-a-${profile}`,
      stepMutationId: `wfc-running-s-${profile}`,
    });
    if (running.status !== 'applied') {
      throw new Error('Workflow Task did not enter running');
    }
    const cancellation = database
      .prepare(
        `UPDATE "Runs"
            SET cancel_requested_at_ms = ?,
                cancel_reason = 'user'
          WHERE id = ? AND status = 'running'
            AND cancel_requested_at_ms IS NULL`,
      )
      .run(runningAtMs + 1, plan.runId);
    if (cancellation.changes !== 1) {
      throw new Error('Workflow cancellation intent was not recorded');
    }
    return Object.freeze({
      runId: plan.runId,
      attemptId: admitted.receipt.attemptId,
      stepRunId: collect.stepRunId,
    });
  } finally {
    await authority.close();
  }
}

async function runCrashScenario({
  databasePath,
  markerPath,
  pointName,
  profile,
}) {
  const database = client(databasePath);
  const runs = new LocalSqliteRunRepository(database);
  const value = fixture(profile);
  const plan = executionPlan(value);
  const run = await runs.findRunById(plan.runId);
  const attempt = await runs.findLatestAttemptByRunId(plan.runId);
  if (!run || !attempt) {
    throw new Error('Workflow Task control authority is missing');
  }
  const authority = new LocalSqliteOperationAuthority(
    crashClient(database, pointName, markerPath),
  );
  await new LocalSqliteWorkflowTaskExecutionRepository(
    authority,
  ).recordControlTerminal(command(run, attempt, pointName, profile));
  throw new Error(`crash point ${pointName} was not reached`);
}

async function verifyScenario({ databasePath, pointName, profile }) {
  const point = CRASH_POINTS[pointName];
  if (!point) throw new Error(`unknown crash point ${pointName}`);
  const database = client(databasePath);
  const authority = new LocalSqliteOperationAuthority(database);
  try {
    const value = fixture(profile);
    const plan = executionPlan(value);
    const runs = new LocalSqliteRunRepository(database);
    const execution = new LocalSqliteWorkflowTaskExecutionRepository(authority);
    let run = await runs.findRunById(plan.runId);
    let attempt = await runs.findLatestAttemptByRunId(plan.runId);
    if (!run || !attempt) {
      throw new Error('Workflow Task recovery authority is missing');
    }
    if (point.durable !== (attempt.status === 'cancelled')) {
      throw new Error(`${profile}/${pointName} durability is inconsistent`);
    }
    const recovered = await execution.recordControlTerminal(
      command(run, attempt, pointName, profile),
    );
    if (recovered !== (point.durable ? 'already_terminal' : 'terminal')) {
      throw new Error(`${profile}/${pointName} replay is inconsistent`);
    }
    const cancellation =
      new LocalSqlitePluginPackageWorkflowCancellationConvergenceRepository(
        authority,
      );
    const converged = await cancellation.convergePage({ limit: 8 });
    if (
      converged.settledRuns !== 1 ||
      converged.settledAttempts !== 0 ||
      converged.blocked !== 0
    ) {
      throw new Error(`${profile}/${pointName} parent did not converge`);
    }
    run = await runs.findRunById(plan.runId);
    attempt = await runs.findLatestAttemptByRunId(plan.runId);
    const facts = database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM "RunAttempts"
             WHERE run_id = ?) AS attempts,
           (SELECT COUNT(*) FROM "RunEvents"
             WHERE run_id = ? AND type =
               'workflow.task_attempt.cancelled') AS attemptEvents,
           (SELECT COUNT(*) FROM "RunEvents"
             WHERE run_id = ? AND type = 'step.cancelled') AS stepEvents,
           (SELECT COUNT(*) FROM "RunEvents"
             WHERE run_id = ? AND type =
               'workflow.cancelled') AS workflowEvents,
           (SELECT COUNT(*) FROM "StepRuns"
             WHERE run_id = ? AND status = 'cancelled') AS cancelledSteps`,
      )
      .get(plan.runId, plan.runId, plan.runId, plan.runId, plan.runId);
    if (
      run?.status !== 'cancelled' ||
      run.version !== run.eventSequence ||
      attempt?.status !== 'cancelled' ||
      facts.attempts !== 1 ||
      facts.attemptEvents !== 1 ||
      facts.stepEvents !== 2 ||
      facts.workflowEvents !== 1 ||
      facts.cancelledSteps !== 2
    ) {
      throw new Error(`${profile}/${pointName} terminal facts are incomplete`);
    }
    const replay = await execution.recordControlTerminal(
      command(run, attempt, pointName, profile),
    );
    if (replay !== 'already_terminal') {
      throw new Error(`${profile}/${pointName} terminal replay drifted`);
    }
    const empty = await cancellation.convergePage({ limit: 8 });
    if (
      empty.scanned !== 0 ||
      empty.settledRuns !== 0 ||
      empty.settledAttempts !== 0
    ) {
      throw new Error(`${profile}/${pointName} cancellation replay drifted`);
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
      crashAfterConclusiveStop: true,
      crashBeforeCommit: !point.durable,
      durableAfterCrash: point.durable,
      exactTerminalReplay: replay === 'already_terminal',
      parentConverged: run.status === 'cancelled',
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
