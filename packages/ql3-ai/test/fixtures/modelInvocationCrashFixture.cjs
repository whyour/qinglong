const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const {
  createStepRunRecord,
  transitionStepRunMutation,
} = require('@qinglong/runtime-core/step-run');
const {
  createModelInvocationCompletionCommand,
  createModelInvocationMutationIdentity,
  createModelInvocationStartCommand,
} = require('../../dist/model-invocation/modelInvocation.js');
const {
  LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
  migrateLocalModelInvocationFeature,
} = require('@qinglong/ai/model-invocation-migration');
const {
  LocalModelInvocationFeatureActivationRepository,
  createLocalModelInvocationFeatureTransitionCommand,
} = require('@qinglong/ai/local-feature-activation');
const {
  LocalModelInvocationRepository,
} = require('../../dist/model-invocation/localModelInvocationRepository.js');

const NOW = 3_000_000;

const CRASH_POINTS = Object.freeze({
  start_before_begin: Object.freeze({
    operation: 'start',
    timing: 'beforeExec',
    sql: 'BEGIN IMMEDIATE',
    durable: false,
  }),
  start_after_mutation: Object.freeze({
    operation: 'start',
    timing: 'afterRun',
    sql: 'INSERT INTO "StepRunMutations"',
    durable: false,
  }),
  start_after_fact: Object.freeze({
    operation: 'start',
    timing: 'afterRun',
    sql: 'INSERT INTO "ModelInvocationStarts"',
    durable: false,
  }),
  start_after_commit: Object.freeze({
    operation: 'start',
    timing: 'afterExec',
    sql: 'COMMIT',
    durable: true,
  }),
  completion_after_mutation: Object.freeze({
    operation: 'completion',
    timing: 'afterRun',
    sql: 'INSERT INTO "StepRunMutations"',
    durable: false,
  }),
  completion_after_fact: Object.freeze({
    operation: 'completion',
    timing: 'afterRun',
    sql: 'INSERT INTO "ModelInvocationCompletions"',
    durable: false,
  }),
  completion_after_commit: Object.freeze({
    operation: 'completion',
    timing: 'afterExec',
    sql: 'COMMIT',
    durable: true,
  }),
});

function openClient(databasePath, profile) {
  const client = new DatabaseSync(databasePath);
  client.exec('PRAGMA foreign_keys = ON');
  client.exec('PRAGMA busy_timeout = 5000');
  client.exec(`PRAGMA journal_mode = ${profile === 'edge' ? 'DELETE' : 'WAL'}`);
  client.exec('PRAGMA synchronous = FULL');
  return client;
}

function createMainContract(client) {
  client.exec(`
    CREATE TABLE "QingLong3SchemaMigrations" (
      migration_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      dialect TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
    CREATE TABLE "Runs" (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      event_sequence INTEGER NOT NULL
    );
    CREATE TABLE "RunEvents" (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      attempt_id TEXT,
      step_run_id TEXT,
      payload TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      UNIQUE (run_id, sequence),
      UNIQUE (run_id, dedupe_key)
    );
    CREATE TABLE "StepRuns" (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL,
      output_ref TEXT,
      approval_request_id TEXT,
      ready_at_ms INTEGER,
      started_at_ms INTEGER,
      finished_at_ms INTEGER,
      result_code TEXT,
      error_summary TEXT,
      updated_at_ms INTEGER NOT NULL,
      last_mutation_id TEXT NOT NULL,
      step_run_digest TEXT NOT NULL,
      step_run_json TEXT NOT NULL,
      UNIQUE (run_id, id)
    );
    CREATE TABLE "StepRunMutations" (
      mutation_id TEXT PRIMARY KEY,
      mutation_digest TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_run_id TEXT NOT NULL,
      step_run_digest TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      run_version INTEGER NOT NULL,
      step_run_json TEXT NOT NULL,
      committed_at_ms INTEGER NOT NULL
    );
  `);
}

function audit(phase, overrides = {}) {
  return {
    phase,
    projectId: 'crash-project',
    runId: 'crash-run',
    stepRunId: 'crash-step',
    traceId: 'crash-trace',
    requestId: 'crash-request',
    provider: 'remote',
    model: 'crash-model',
    policyRevision: 'policy-1',
    requestDigest: `sha256:${'b'.repeat(64)}`,
    deadlineAtMs: NOW + 10_000,
    inputBytes: 128,
    maxOutputTokens: 64,
    outputBytes: 0,
    usage: null,
    errorCode: null,
    occurredAtMs: NOW,
    ...overrides,
  };
}

function startCommand(ready) {
  const identity = createModelInvocationMutationIdentity(
    'crash-request',
    'start',
  );
  return createModelInvocationStartCommand(
    audit('admitted'),
    transitionStepRunMutation(
      ready,
      {
        expectedVersion: ready.version,
        expectedDigest: ready.stepRunDigest,
        mutationId: identity.mutationId,
        to: 'running',
        atMs: NOW,
      },
      {
        expectedRunVersion: 1,
        expectedRunEventSequence: 1,
        eventId: identity.eventId,
        dedupeKey: identity.dedupeKey,
        actor: { type: 'executor', id: 'model-gateway' },
      },
    ),
  );
}

function completionCommand(start) {
  const identity = createModelInvocationMutationIdentity(
    'crash-request',
    'completion',
  );
  return createModelInvocationCompletionCommand(
    start.start,
    audit('completed', {
      occurredAtMs: NOW + 25,
      outputBytes: 12,
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    }),
    transitionStepRunMutation(
      start.stepRunMutation.stepRun,
      {
        expectedVersion: start.start.startedStepRunVersion,
        expectedDigest: start.start.startedStepRunDigest,
        mutationId: identity.mutationId,
        to: 'succeeded',
        atMs: NOW + 25,
        outputRef: 'model-invocation:crash-request',
      },
      {
        expectedRunVersion: 2,
        expectedRunEventSequence: 2,
        eventId: identity.eventId,
        dedupeKey: identity.dedupeKey,
        actor: { type: 'executor', id: 'model-gateway' },
      },
    ),
  );
}

async function setupScenario({ databasePath, statePath, profile, operation }) {
  const client = openClient(databasePath, profile);
  try {
    createMainContract(client);
    await migrateLocalModelInvocationFeature(client);
    new LocalModelInvocationFeatureActivationRepository(client).transition(
      createLocalModelInvocationFeatureTransitionCommand({
        featureId: 'model-invocation',
        expectedGeneration: 0,
        expectedState: null,
        state: 'active',
        mutationId: 'model-invocation-crash-feature-activation',
        requestId: 'model-invocation-crash-feature-request',
        expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
        safety: {
          mode: 'fresh_database',
          backupEvidenceDigest: null,
        },
        principal: {
          subject: { type: 'user', id: 'test-owner' },
          authenticationId: 'local_ai_feature:crash-proof',
          authenticatedAtMs: 1,
          expiresAtMs: 301_000,
          assurance: 'local_console',
        },
      }),
    );
    const ready = createStepRunRecord({
      id: 'crash-step',
      runId: 'crash-run',
      stepKey: 'summarize',
      kind: 'model',
      definitionRef: 'prompt:crash@1',
      definitionDigest: 'a'.repeat(64),
      required: true,
      initialStatus: 'ready',
      inputRef: 'artifact:crash-input',
      mutationId: 'create-crash-step',
      createdAtMs: NOW - 1,
    });
    client
      .prepare(
        `INSERT INTO "Runs"
         (id, project_id, status, version, event_sequence)
         VALUES ('crash-run', 'crash-project', 'running', 1, 1)`,
      )
      .run();
    client
      .prepare(
        `INSERT INTO "StepRuns" (
           id, run_id, kind, status, version, attempt_count, output_ref,
           approval_request_id, ready_at_ms, started_at_ms, finished_at_ms,
           result_code, error_summary, updated_at_ms, last_mutation_id,
           step_run_digest, step_run_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ready.id,
        ready.runId,
        ready.kind,
        ready.status,
        ready.version,
        ready.attemptCount,
        ready.outputRef,
        ready.approvalRequestId,
        ready.readyAtMs,
        ready.startedAtMs,
        ready.finishedAtMs,
        ready.resultCode,
        ready.errorSummary,
        ready.updatedAtMs,
        ready.lastMutationId,
        ready.stepRunDigest,
        JSON.stringify(ready),
      );
    const start = startCommand(ready);
    const completion = completionCommand(start);
    if (operation === 'completion') {
      assert.equal(
        (await new LocalModelInvocationRepository(client).admit(start)).status,
        'created',
      );
    }
    fs.writeFileSync(
      statePath,
      JSON.stringify({ profile, operation, start, completion }),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
  } finally {
    client.close();
  }
}

function writeCrashMarker(markerPath, pointName) {
  const file = fs.openSync(markerPath, 'wx', 0o600);
  try {
    fs.writeSync(
      file,
      JSON.stringify({
        schema: 'qinglong/sqlite-model-invocation-crash-marker@v1',
        point: pointName,
        pid: process.pid,
      }),
    );
    fs.fsyncSync(file);
  } finally {
    fs.closeSync(file);
  }
}

function crashClient(client, pointName, markerPath) {
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
  return new Proxy(client, {
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
  statePath,
  markerPath,
  pointName,
}) {
  const point = CRASH_POINTS[pointName];
  if (!point) throw new Error(`unknown crash point ${pointName}`);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (state.operation !== point.operation) {
    throw new Error(
      `crash point ${pointName} does not match ${state.operation}`,
    );
  }
  const client = openClient(databasePath, state.profile);
  const repository = new LocalModelInvocationRepository(
    crashClient(client, pointName, markerPath),
  );
  if (point.operation === 'start') {
    await repository.admit(state.start);
  } else {
    await repository.complete(state.completion);
  }
  throw new Error(`crash point ${pointName} was not reached`);
}

function facts(client) {
  return {
    ...client
      .prepare(
        `SELECT
         step.status AS "stepStatus",
         step.version AS "stepVersion",
         run.version AS "runVersion",
         run.event_sequence AS "runEventSequence",
         (SELECT count(*) FROM "RunEvents") AS "eventCount",
         (SELECT count(*) FROM "StepRunMutations") AS "mutationCount",
         (SELECT count(*) FROM "ModelInvocationStarts") AS "startCount",
         (SELECT count(*) FROM "ModelInvocationCompletions")
           AS "completionCount"
       FROM "StepRuns" AS step
       JOIN "Runs" AS run ON run.id = step.run_id
       WHERE step.id = 'crash-step' AND run.id = 'crash-run'`,
      )
      .get(),
  };
}

async function verifyScenario({ databasePath, statePath, pointName }) {
  const point = CRASH_POINTS[pointName];
  if (!point) throw new Error(`unknown crash point ${pointName}`);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const client = openClient(databasePath, state.profile);
  const repository = new LocalModelInvocationRepository(client);
  try {
    assert.equal(
      client.prepare('PRAGMA integrity_check').get().integrity_check,
      'ok',
    );
    assert.equal(
      client.prepare('PRAGMA journal_mode').get().journal_mode,
      state.profile === 'edge' ? 'delete' : 'wal',
    );
    const operation = point.operation;
    const before = facts(client);
    if (operation === 'start') {
      assert.deepEqual(
        before,
        point.durable
          ? {
              stepStatus: 'running',
              stepVersion: 2,
              runVersion: 2,
              runEventSequence: 2,
              eventCount: 1,
              mutationCount: 1,
              startCount: 1,
              completionCount: 0,
            }
          : {
              stepStatus: 'ready',
              stepVersion: 1,
              runVersion: 1,
              runEventSequence: 1,
              eventCount: 0,
              mutationCount: 0,
              startCount: 0,
              completionCount: 0,
            },
      );
      const replay = await repository.admit(state.start);
      assert.equal(replay.status, point.durable ? 'existing' : 'created');
      assert.equal((await repository.admit(state.start)).status, 'existing');
    } else {
      assert.deepEqual(
        before,
        point.durable
          ? {
              stepStatus: 'succeeded',
              stepVersion: 3,
              runVersion: 3,
              runEventSequence: 3,
              eventCount: 2,
              mutationCount: 2,
              startCount: 1,
              completionCount: 1,
            }
          : {
              stepStatus: 'running',
              stepVersion: 2,
              runVersion: 2,
              runEventSequence: 2,
              eventCount: 1,
              mutationCount: 1,
              startCount: 1,
              completionCount: 0,
            },
      );
      const replay = await repository.complete(state.completion);
      assert.equal(replay.status, point.durable ? 'existing' : 'created');
      assert.equal(
        (await repository.complete(state.completion)).status,
        'existing',
      );
    }
    const after = facts(client);
    assert.equal(
      after.stepStatus,
      operation === 'start' ? 'running' : 'succeeded',
    );
    assert.equal(after.startCount, 1);
    assert.equal(after.completionCount, operation === 'start' ? 0 : 1);
    return Object.freeze({
      profile: state.profile,
      point: pointName,
      crashBeforeCommit: !point.durable,
      durableAfterCrash: point.durable,
      journalMode: client.prepare('PRAGMA journal_mode').get().journal_mode,
      integrityCheck: 'ok',
    });
  } finally {
    client.close();
  }
}

if (require.main === module) {
  const [mode, databasePath, statePath, markerPath, pointName] =
    process.argv.slice(2);
  if (mode !== 'crash') throw new Error(`unknown mode ${mode}`);
  runCrashScenario({
    databasePath,
    statePath,
    markerPath,
    pointName,
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CRASH_POINTS,
  setupScenario,
  verifyScenario,
};
