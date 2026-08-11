const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_SCHEMA,
  normalizeAuthorizedPluginPackagePromptExecutionInspection,
  normalizePluginPackagePromptExecutionInspectionResult,
} = require('../dist/prompt/pluginPackagePromptExecutionInspection.js');
const {
  LocalPluginPackagePromptExecutionInspectionRepository,
} = require('../dist/prompt/localPluginPackagePromptExecutionInspectionRepository.js');
const {
  PostgresPluginPackagePromptExecutionInspectionRepository,
} = require('../dist/prompt/postgresPluginPackagePromptExecutionInspectionRepository.js');

function authorized(eventId = '00000000-0000-4000-8000-000000000001') {
  return {
    projectId: 'project-1',
    packageName: 'example',
    promptId: 'summary',
    executionRequestId: 'execution-request-1',
    actor: { type: 'user', id: 'owner-1' },
    fence: { projectVersion: 3, bindingVersion: 7 },
    audit: {
      eventId,
      requestId: 'inspection-request-1',
      operationId: 'prompt.execution.read',
      projectId: 'project-1',
      subject: { type: 'user', id: 'owner-1' },
      authenticationId: 'api_credential:credential-1:1',
      outcome: 'allowed',
      reasons: ['project_policy_allowed'],
      fence: { projectVersion: 3, bindingVersion: 7 },
      occurredAtMs: 2_000,
    },
  };
}

function terminalResult() {
  return {
    schema: PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_SCHEMA,
    found: true,
    projectId: 'project-1',
    packageName: 'example',
    promptId: 'summary',
    executionRequestId: 'execution-request-1',
    execution: {
      invocationId: 'invocation-1',
      runId: '00000000-0000-4000-8000-000000000010',
      stepRunId: 'step-1',
      runStatus: 'succeeded',
      runVersion: 5,
      eventSequence: 5,
      stepStatus: 'succeeded',
      stepVersion: 3,
      admittedAtMs: 1_000,
      startedAtMs: 1_000,
      finishedAtMs: 1_500,
      finalizedAtMs: 1_500,
    },
  };
}

test('normalizes an exact content-free execution inspection contract', () => {
  const command = normalizeAuthorizedPluginPackagePromptExecutionInspection(
    authorized(),
  );
  const result = normalizePluginPackagePromptExecutionInspectionResult(
    terminalResult(),
  );
  assert.equal(command.executionRequestId, 'execution-request-1');
  assert.equal(result.execution.runStatus, 'succeeded');
  assert.equal(JSON.stringify(result).includes('template'), false);
  assert.throws(() =>
    normalizePluginPackagePromptExecutionInspectionResult({
      ...terminalResult(),
      execution: { ...terminalResult().execution, privateOutput: 'secret' },
    }),
  );
});

test('SQLite inspection commits authorization, exact read and audit replay atomically', async (t) => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE "QingLong3SecurityAuditEvents" (event_id TEXT PRIMARY KEY);
    CREATE TABLE "ModelInvocationPromptAdmissions" (
      request_id TEXT PRIMARY KEY, invocation_id TEXT, run_id TEXT,
      step_run_id TEXT, project_id TEXT, package_name TEXT, prompt_id TEXT,
      admitted_at_ms INTEGER
    );
    CREATE TABLE "Runs" (
      id TEXT PRIMARY KEY, project_id TEXT, status TEXT, version INTEGER,
      event_sequence INTEGER, started_at_ms INTEGER, finished_at_ms INTEGER
    );
    CREATE TABLE "StepRuns" (
      id TEXT, run_id TEXT, status TEXT, version INTEGER,
      PRIMARY KEY (run_id, id)
    );
    CREATE TABLE "ModelInvocationPromptFinalizations" (
      request_id TEXT PRIMARY KEY, finalized_at_ms INTEGER
    );
  `);
  database
    .prepare(
      `INSERT INTO "ModelInvocationPromptAdmissions" VALUES
    (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'execution-request-1',
      'invocation-1',
      '00000000-0000-4000-8000-000000000010',
      'step-1',
      'project-1',
      'example',
      'summary',
      1_000,
    );
  database
    .prepare(`INSERT INTO "Runs" VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      '00000000-0000-4000-8000-000000000010',
      'project-1',
      'succeeded',
      5,
      5,
      1_000,
      1_500,
    );
  database
    .prepare(`INSERT INTO "StepRuns" VALUES (?, ?, ?, ?)`)
    .run('step-1', '00000000-0000-4000-8000-000000000010', 'succeeded', 3);
  database
    .prepare(`INSERT INTO "ModelInvocationPromptFinalizations" VALUES (?, ?)`)
    .run('execution-request-1', 1_500);
  const replays = [];
  const repository = new LocalPluginPackagePromptExecutionInspectionRepository(
    {
      client: database,
      async enqueue(work) {
        return work();
      },
    },
    {
      confirm(inspection, replay) {
        assert.equal(database.isTransaction, true);
        replays.push(replay);
        if (!replay) {
          database
            .prepare(`INSERT INTO "QingLong3SecurityAuditEvents" VALUES (?)`)
            .run(inspection.audit.eventId);
        }
      },
    },
  );
  assert.deepEqual(
    await repository.inspectAuthorized(authorized()),
    terminalResult(),
  );
  assert.deepEqual(
    await repository.inspectAuthorized(authorized()),
    terminalResult(),
  );
  assert.deepEqual(replays, [false, true]);
});

test('PostgreSQL inspection uses one serializable authorization snapshot', async () => {
  const queries = [];
  let released = 0;
  const client = {
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (sql.includes('FROM "ql3"."api_credentials"')) {
        return {
          rows: [
            {
              version: 1,
              state: 'active',
              subjectType: 'user',
              subjectId: 'owner-1',
              notBeforeAtMs: 0,
              expiresAtMs: 10_000,
              subjectStatus: 'active',
              nowMs: 2_000,
            },
          ],
        };
      }
      if (sql.includes('FROM "ql3"."projects"')) {
        return { rows: [{ status: 'active', version: 3 }] };
      }
      if (sql.includes('FROM "ql3"."project_role_bindings"')) {
        return { rows: [{ state: 'active', version: 7 }] };
      }
      if (sql.includes('model_invocation_prompt_admissions" AS admission')) {
        return {
          rows: [
            {
              invocationId: 'invocation-1',
              runId: '00000000-0000-4000-8000-000000000010',
              stepRunId: 'step-1',
              admittedAtMs: '1000',
              runStatus: 'succeeded',
              runVersion: 5,
              eventSequence: 5,
              startedAtMs: 1000,
              finishedAtMs: 1500,
              stepStatus: 'succeeded',
              stepVersion: 3,
              finalizedAtMs: 1500,
            },
          ],
        };
      }
      return { rows: [] };
    },
    release() {
      released += 1;
    },
  };
  const repository =
    new PostgresPluginPackagePromptExecutionInspectionRepository({
      async query() {
        return { rows: [] };
      },
      async connect() {
        return client;
      },
    });
  assert.deepEqual(
    await repository.inspectAuthorized(authorized()),
    terminalResult(),
  );
  assert.equal(released, 1);
  assert.match(queries[0].sql, /BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE/);
  const target = queries.find(({ sql }) =>
    sql.includes('model_invocation_prompt_admissions" AS admission'),
  );
  assert.deepEqual(target.parameters, [
    'execution-request-1',
    'project-1',
    'example',
    'summary',
  ]);
  assert.match(target.sql, /LIMIT 2/);
  assert.equal(
    queries.some(({ sql }) => sql.includes('security_audit_events')),
    true,
  );
});
