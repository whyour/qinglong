const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('@qinglong/local-sqlite/plugin-package-install');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('@qinglong/local-sqlite/plugin-package-materialized-revision');
const {
  LocalSqlitePluginPackageTaskReconciliationRepository,
} = require('@qinglong/local-sqlite/plugin-package-task-reconciliation');
const {
  LocalSqlitePluginPackageAutomationPublicationRepository,
} = require('@qinglong/local-sqlite/plugin-package-automation-publication');
const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
} = require('../../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
  migrateLocalModelInvocationFeature,
} = require('@qinglong/ai/model-invocation-migration');
const {
  LocalModelInvocationFeatureActivationRepository,
  createLocalModelInvocationFeatureTransitionCommand,
} = require('@qinglong/ai/local-feature-activation');
const {
  LocalPluginPackagePromptAdmissionRepository,
} = require('../../dist/prompt/localPluginPackagePromptAdmissionRepository.js');
const {
  LocalModelInvocationRepository,
} = require('../../dist/model-invocation/localModelInvocationRepository.js');
const {
  DurableModelInvocationCoordinator,
} = require('../../dist/model-invocation/durableModelInvocationCoordinator.js');
const { BoundedModelGateway } = require('../../dist/model-gateway/gateway.js');
const {
  preparePluginPackagePromptExecution,
} = require('../../dist/prompt/pluginPackagePromptExecution.js');

const CRASH_POINTS = Object.freeze({
  admission_before_begin: Object.freeze({
    operation: 'admission',
    timing: 'beforeExec',
    sql: 'BEGIN IMMEDIATE',
    durable: false,
  }),
  admission_after_run: Object.freeze({
    operation: 'admission',
    timing: 'afterRun',
    sql: 'INSERT INTO "Runs"',
    durable: false,
  }),
  admission_after_step_mutation: Object.freeze({
    operation: 'admission',
    timing: 'afterRun',
    sql: 'INSERT INTO "StepRunMutations"',
    durable: false,
  }),
  admission_after_fact: Object.freeze({
    operation: 'admission',
    timing: 'afterRun',
    sql: 'INSERT INTO "ModelInvocationPromptAdmissions"',
    durable: false,
  }),
  admission_after_commit: Object.freeze({
    operation: 'admission',
    timing: 'afterExec',
    sql: 'COMMIT',
    durable: true,
  }),
  finalization_before_begin: Object.freeze({
    operation: 'finalization',
    timing: 'beforeExec',
    sql: 'BEGIN IMMEDIATE',
    durable: false,
  }),
  finalization_after_run: Object.freeze({
    operation: 'finalization',
    timing: 'afterRun',
    sql: 'UPDATE "Runs"',
    durable: false,
  }),
  finalization_after_event: Object.freeze({
    operation: 'finalization',
    timing: 'afterRun',
    sql: 'INSERT INTO "RunEvents"',
    durable: false,
  }),
  finalization_after_fact: Object.freeze({
    operation: 'finalization',
    timing: 'afterRun',
    sql: 'INSERT INTO "ModelInvocationPromptFinalizations"',
    durable: false,
  }),
  finalization_after_commit: Object.freeze({
    operation: 'finalization',
    timing: 'afterExec',
    sql: 'COMMIT',
    durable: true,
  }),
});

function openClient(databasePath, profile) {
  const client = new DatabaseSync(databasePath);
  client.exec('PRAGMA foreign_keys = ON');
  client.exec('PRAGMA busy_timeout = 5000');
  client.exec(
    'PRAGMA journal_mode = ' + (profile === 'edge' ? 'DELETE' : 'WAL'),
  );
  client.exec('PRAGMA synchronous = FULL');
  return client;
}

function promptResource() {
  return {
    schema: 'qinglong/plugin-package-prompt-resource@v1',
    id: 'summary',
    name: 'Summary',
    template: 'Summarize {{subject}} for {{audience}}.',
    parameters: [
      { name: 'audience', required: false },
      { name: 'subject', required: true },
    ],
  };
}

async function seedPublication(client, profile) {
  const fixture = pluginPackageTaskReconciliationFixture(
    'prompt-crash-matrix',
    {
      profile,
      tasks: [],
      prompts: [promptResource()],
    },
  );
  const publication = createInitialPluginPackageAutomationPublication(
    fixture.revision,
    fixture.registry,
    2_000,
  );
  client
    .prepare(
      'INSERT INTO "QingLong3Projects" ' +
        '(id, name, slug, status, version, created_at_ms, updated_at_ms) ' +
        "VALUES (?, ?, ?, 'active', 1, 1, 1)",
    )
    .run(fixture.projectId, fixture.projectId, fixture.projectId);
  await activateInstall(
    new LocalSqlitePluginPackageInstallRepository(client),
    fixture,
  );
  await new LocalSqlitePluginPackageMaterializedRevisionRepository(
    client,
    fixture.registry,
  ).publish(fixture.revision);
  await new LocalSqlitePluginPackageTaskReconciliationRepository(
    client,
    fixture.registry,
  ).reconcile(fixture.revision, {
    async findActiveResourceGeneration() {
      return fixture.revision.generation;
    },
  });
  await new LocalSqlitePluginPackageAutomationPublicationRepository(
    client,
  ).publish(publication);
  return publication;
}

function executionInput(publication) {
  return {
    publication,
    expectedPublicationDigest: publication.publicationDigest,
    promptId: 'summary',
    requestId: 'prompt-crash-request',
    traceId: 'prompt-crash-trace',
    requestedBySubject: { type: 'user', id: 'prompt-crash-owner' },
    policyFence: { projectVersion: 1, bindingVersion: 1 },
    parameters: { subject: 'private crash matrix input' },
    provider: 'openai-compatible',
    model: 'vendor/model-a',
    maxOutputTokens: 512,
    temperature: 0.2,
    plannedAtMs: 2_000,
    deadlineAtMs: 62_000,
  };
}

function createGateway(repository) {
  return new BoundedModelGateway({
    providers: [
      {
        type: 'openai-compatible',
        async listModels() {
          return [{ id: 'vendor/model-a' }];
        },
        async generate() {
          return {
            provider: 'openai-compatible',
            model: 'vendor/model-a',
            text: 'private crash matrix output',
            finishReason: 'stop',
            usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
          };
        },
        async *stream() {
          throw new Error('not used');
        },
      },
    ],
    policies: {
      async resolve() {
        return {
          revision: 'prompt-crash-policy-1',
          allowedProviders: ['openai-compatible'],
          allowedModels: ['vendor/model-a'],
          maxInputBytes: 4096,
          maxOutputBytes: 4096,
          maxOutputTokens: 512,
          maxTotalTokens: 1024,
          maxCostMicros: null,
          priceRevision: null,
        };
      },
    },
    pricing: {
      async resolve() {
        throw new Error('pricing must remain unreachable');
      },
    },
    audit: new DurableModelInvocationCoordinator(repository),
    maxConcurrent: 1,
    now: () => 3_000,
  });
}

async function setupScenario({ databasePath, statePath, profile, operation }) {
  await migrateLocalSqlitePath({ databasePath, profile });
  const client = openClient(databasePath, profile);
  try {
    await migrateLocalModelInvocationFeature(client);
    new LocalModelInvocationFeatureActivationRepository(client).transition(
      createLocalModelInvocationFeatureTransitionCommand({
        featureId: 'model-invocation',
        expectedGeneration: 0,
        expectedState: null,
        state: 'active',
        mutationId: 'prompt-crash-feature-activation',
        requestId: 'prompt-crash-feature-request',
        expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
        safety: {
          mode: 'fresh_database',
          backupEvidenceDigest: null,
        },
        principal: {
          subject: { type: 'user', id: 'prompt-crash-owner' },
          authenticationId: 'local_ai_feature:prompt-crash',
          authenticatedAtMs: 1,
          expiresAtMs: 301_000,
          assurance: 'local_console',
        },
      }),
    );
    const publication = await seedPublication(client, profile);
    const prepared = preparePluginPackagePromptExecution(
      executionInput(publication),
    );
    if (operation === 'finalization') {
      const admissions = new LocalPluginPackagePromptAdmissionRepository(
        client,
      );
      assert.equal((await admissions.admit(prepared.plan)).status, 'created');
      const invocations = new LocalModelInvocationRepository(client);
      const result = await createGateway(invocations).generate(
        prepared.request,
        {
          projectId: prepared.plan.target.projectId,
          runId: prepared.plan.runId,
          stepRunId: prepared.plan.stepRunId,
          traceId: prepared.plan.traceId,
          requestId: prepared.plan.invocationId,
          deadlineAtMs: prepared.plan.deadlineAtMs,
        },
      );
      assert.equal(result.text, 'private crash matrix output');
    }
    fs.writeFileSync(
      statePath,
      JSON.stringify({ profile, operation, plan: prepared.plan }),
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
        schema: 'qinglong/sqlite-plugin-package-prompt-crash-marker@v1',
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
  if (!point) throw new Error('unknown crash point ' + pointName);
  let triggered = false;
  const crash = () => {
    if (triggered) return;
    triggered = true;
    writeCrashMarker(markerPath, pointName);
    process.kill(process.pid, 'SIGKILL');
    throw new Error('SIGKILL did not terminate ' + pointName);
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
  if (!point) throw new Error('unknown crash point ' + pointName);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (state.operation !== point.operation) {
    throw new Error(
      'crash point ' + pointName + ' does not match ' + state.operation,
    );
  }
  const client = openClient(databasePath, state.profile);
  const repository = new LocalPluginPackagePromptAdmissionRepository(
    crashClient(client, pointName, markerPath),
  );
  if (point.operation === 'admission') {
    await repository.admit(state.plan);
  } else {
    await repository.finalize(state.plan.requestId);
  }
  throw new Error('crash point ' + pointName + ' was not reached');
}

function count(client, sql, value) {
  return client.prepare(sql).get(value).count;
}

function facts(client, plan) {
  const run = client
    .prepare(
      'SELECT status, version, event_sequence AS "eventSequence" ' +
        'FROM "Runs" WHERE id = ?',
    )
    .get(plan.runId);
  const step = client
    .prepare('SELECT kind, status, version FROM "StepRuns" WHERE id = ?')
    .get(plan.stepRunId);
  return {
    run: run ? { ...run } : null,
    step: step ? { ...step } : null,
    runEvents: count(
      client,
      'SELECT count(*) AS count FROM "RunEvents" WHERE run_id = ?',
      plan.runId,
    ),
    attempts: count(
      client,
      'SELECT count(*) AS count FROM "RunAttempts" WHERE run_id = ?',
      plan.runId,
    ),
    mutations: count(
      client,
      'SELECT count(*) AS count FROM "StepRunMutations" WHERE run_id = ?',
      plan.runId,
    ),
    starts: count(
      client,
      'SELECT count(*) AS count FROM "ModelInvocationStarts" ' +
        'WHERE invocation_id = ?',
      plan.invocationId,
    ),
    completions: count(
      client,
      'SELECT count(*) AS count FROM "ModelInvocationCompletions" ' +
        'WHERE invocation_id = ?',
      plan.invocationId,
    ),
    admissions: count(
      client,
      'SELECT count(*) AS count FROM "ModelInvocationPromptAdmissions" ' +
        'WHERE request_id = ?',
      plan.requestId,
    ),
    finalizations: count(
      client,
      'SELECT count(*) AS count FROM "ModelInvocationPromptFinalizations" ' +
        'WHERE request_id = ?',
      plan.requestId,
    ),
  };
}

function emptyFacts() {
  return {
    run: null,
    step: null,
    runEvents: 0,
    attempts: 0,
    mutations: 0,
    starts: 0,
    completions: 0,
    admissions: 0,
    finalizations: 0,
  };
}

function admittedFacts() {
  return {
    run: { status: 'running', version: 2, eventSequence: 2 },
    step: { kind: 'model', status: 'ready', version: 1 },
    runEvents: 2,
    attempts: 0,
    mutations: 1,
    starts: 0,
    completions: 0,
    admissions: 1,
    finalizations: 0,
  };
}

function modelCompletedFacts() {
  return {
    run: { status: 'running', version: 4, eventSequence: 4 },
    step: { kind: 'model', status: 'succeeded', version: 3 },
    runEvents: 4,
    attempts: 0,
    mutations: 3,
    starts: 1,
    completions: 1,
    admissions: 1,
    finalizations: 0,
  };
}

function finalizedFacts() {
  return {
    run: { status: 'succeeded', version: 5, eventSequence: 5 },
    step: { kind: 'model', status: 'succeeded', version: 3 },
    runEvents: 5,
    attempts: 0,
    mutations: 3,
    starts: 1,
    completions: 1,
    admissions: 1,
    finalizations: 1,
  };
}

async function verifyScenario({ databasePath, statePath, pointName }) {
  const point = CRASH_POINTS[pointName];
  if (!point) throw new Error('unknown crash point ' + pointName);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const client = openClient(databasePath, state.profile);
  const repository = new LocalPluginPackagePromptAdmissionRepository(client);
  try {
    assert.equal(
      client.prepare('PRAGMA integrity_check').get().integrity_check,
      'ok',
    );
    assert.equal(
      client.prepare('PRAGMA journal_mode').get().journal_mode,
      state.profile === 'edge' ? 'delete' : 'wal',
    );
    assert.deepEqual(client.prepare('PRAGMA foreign_key_check').all(), []);
    const before = facts(client, state.plan);
    if (point.operation === 'admission') {
      assert.deepEqual(before, point.durable ? admittedFacts() : emptyFacts());
      const replay = await repository.admit(state.plan);
      assert.equal(replay.status, point.durable ? 'existing' : 'created');
      assert.equal((await repository.admit(state.plan)).status, 'existing');
      assert.deepEqual(facts(client, state.plan), admittedFacts());
    } else {
      assert.deepEqual(
        before,
        point.durable ? finalizedFacts() : modelCompletedFacts(),
      );
      const replay = await repository.finalize(state.plan.requestId);
      assert.equal(replay.status, point.durable ? 'existing' : 'created');
      assert.equal(
        (await repository.finalize(state.plan.requestId)).status,
        'existing',
      );
      assert.deepEqual(facts(client, state.plan), finalizedFacts());
    }
    const durableBytes = fs.readFileSync(databasePath);
    assert.equal(
      durableBytes.includes(Buffer.from('private crash matrix input')),
      false,
    );
    assert.equal(
      durableBytes.includes(Buffer.from('private crash matrix output')),
      false,
    );
    return Object.freeze({
      profile: state.profile,
      operation: point.operation,
      point: pointName,
      crashBeforeCommit: !point.durable,
      durableAfterCrash: point.durable,
      exactReplay: true,
      contentFree: true,
      journalMode: client.prepare('PRAGMA journal_mode').get().journal_mode,
      integrityCheck: 'ok',
      foreignKeyCheck: 'ok',
      physicalPowerLossProven: false,
    });
  } finally {
    client.close();
  }
}

if (require.main === module) {
  const [mode, databasePath, statePath, markerPath, pointName] =
    process.argv.slice(2);
  if (mode !== 'crash') throw new Error('unknown mode ' + mode);
  runCrashScenario({
    databasePath,
    statePath,
    markerPath,
    pointName,
  }).catch((error) => {
    process.stderr.write((error.stack ?? error.message) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  CRASH_POINTS,
  setupScenario,
  verifyScenario,
};
