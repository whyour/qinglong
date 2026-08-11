const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  InvalidPluginPackagePromptExecutionOutputReadError,
  PLUGIN_PACKAGE_PROMPT_EXECUTION_OUTPUT_READ_RESULT_SCHEMA,
  PluginPackagePromptExecutionOutputReadService,
  PluginPackagePromptExecutionOutputReadUnavailableError,
} = require('../dist/prompt-output/pluginPackagePromptExecutionOutputRead.js');
const {
  LocalPluginPackagePromptExecutionOutputReferenceRepository,
} = require('../dist/prompt-output/storage/localPluginPackagePromptExecutionOutputReferenceRepository.js');
const {
  PostgresPluginPackagePromptExecutionOutputReferenceRepository,
} = require('../dist/prompt-output/storage/postgresPluginPackagePromptExecutionOutputReferenceRepository.js');
const {
  pluginPackagePromptOutputArtifactIdentity,
} = require('../dist/prompt-output/pluginPackagePromptOutputArtifact.js');

const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'owner-1' }),
  authenticationId: 'authentication-1',
  authenticatedAtMs: 1_000,
  expiresAtMs: 10_000,
  assurance: 'multi_factor',
});
const TARGET = Object.freeze({
  projectId: 'project-1',
  packageName: 'example',
  promptId: 'summary',
  executionRequestId: 'execution-request-1',
});
const REFERENCE = Object.freeze({
  runId: '00000000-0000-4000-8000-000000000010',
  artifactId: pluginPackagePromptOutputArtifactIdentity('invocation-1'),
  artifactDigest: 'a'.repeat(64),
});
const OUTPUT_REFERENCE = Object.freeze({
  schema: 'qinglong/plugin-package-prompt-output-artifact-reference@v1',
  artifactId: REFERENCE.artifactId,
  projectId: TARGET.projectId,
  runId: REFERENCE.runId,
  stepRunId: 'step-1',
  invocationId: 'invocation-1',
  contentDigest: 'b'.repeat(64),
  outputBytes: 14,
  retentionPolicyDigest: 'c'.repeat(64),
  retentionEligibleAtMs: 20_000,
  keyId: 'key-1',
  algorithm: 'aes-256-gcm',
  artifactDigest: REFERENCE.artifactDigest,
});
const RESULT = Object.freeze({
  provider: 'provider-1',
  model: 'model-1',
  text: 'private output',
  finishReason: 'stop',
  usage: Object.freeze({ inputTokens: 2, outputTokens: 3, totalTokens: 5 }),
});

test('resolves one execution request before delegating protected output read', async () => {
  const calls = [];
  const service = new PluginPackagePromptExecutionOutputReadService({
    references: {
      async find(target) {
        calls.push({ kind: 'reference', target });
        return REFERENCE;
      },
    },
    outputs: {
      async read(command) {
        calls.push({ kind: 'output', command });
        return {
          schema: 'qinglong/plugin-package-prompt-output-read-result@v1',
          status: 'available',
          reference: OUTPUT_REFERENCE,
          result: RESULT,
        };
      },
    },
  });
  const value = await service.read({ principal: PRINCIPAL, ...TARGET });
  assert.deepEqual(value, {
    schema: PLUGIN_PACKAGE_PROMPT_EXECUTION_OUTPUT_READ_RESULT_SCHEMA,
    status: 'available',
    ...TARGET,
    reference: OUTPUT_REFERENCE,
    result: RESULT,
  });
  assert.deepEqual(calls[0], { kind: 'reference', target: TARGET });
  assert.deepEqual(calls[1], {
    kind: 'output',
    command: {
      principal: PRINCIPAL,
      projectId: TARGET.projectId,
      ...REFERENCE,
    },
  });
});

test('masks absent, live-only, tombstoned and cross-target output as not found', async () => {
  let outputReads = 0;
  const absent = new PluginPackagePromptExecutionOutputReadService({
    references: {
      async find() {
        return null;
      },
    },
    outputs: {
      async read() {
        outputReads += 1;
        throw new Error('unreachable');
      },
    },
  });
  assert.deepEqual(await absent.read({ principal: PRINCIPAL, ...TARGET }), {
    schema: PLUGIN_PACKAGE_PROMPT_EXECUTION_OUTPUT_READ_RESULT_SCHEMA,
    status: 'not_found',
    ...TARGET,
  });
  assert.equal(outputReads, 0);

  const unavailableOutput = new PluginPackagePromptExecutionOutputReadService({
    references: {
      async find() {
        return REFERENCE;
      },
    },
    outputs: {
      async read() {
        return {
          schema: 'qinglong/plugin-package-prompt-output-read-result@v1',
          status: 'not_found',
        };
      },
    },
  });
  assert.equal(
    (await unavailableOutput.read({ principal: PRINCIPAL, ...TARGET })).status,
    'not_found',
  );
  await assert.rejects(
    unavailableOutput.read({
      principal: PRINCIPAL,
      ...TARGET,
      packageName: '../invalid',
    }),
    InvalidPluginPackagePromptExecutionOutputReadError,
  );
});

test('rejects widened output envelopes before returning content', async () => {
  const widened = new PluginPackagePromptExecutionOutputReadService({
    references: {
      async find() {
        return REFERENCE;
      },
    },
    outputs: {
      async read() {
        return {
          schema: 'qinglong/plugin-package-prompt-output-read-result@v1',
          status: 'available',
          reference: OUTPUT_REFERENCE,
          result: { ...RESULT, privateTrace: 'must-not-escape' },
        };
      },
    },
  });
  await assert.rejects(
    widened.read({ principal: PRINCIPAL, ...TARGET }),
    PluginPackagePromptExecutionOutputReadUnavailableError,
  );
});

function sqliteRepository(database) {
  return new LocalPluginPackagePromptExecutionOutputReferenceRepository({
    client: database,
    async enqueue(work) {
      return work();
    },
  });
}

test('SQLite locator requires an exact terminal durable binding', async (t) => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE "ModelInvocationPromptAdmissions" (
      request_id TEXT PRIMARY KEY, invocation_id TEXT, run_id TEXT,
      step_run_id TEXT, project_id TEXT, package_name TEXT, prompt_id TEXT
    );
    CREATE TABLE "ModelInvocationPromptFinalizations" (
      request_id TEXT PRIMARY KEY, run_status TEXT
    );
    CREATE TABLE "ModelInvocationCompletions" (
      invocation_id TEXT PRIMARY KEY, outcome TEXT
    );
    CREATE TABLE "Runs" (
      id TEXT PRIMARY KEY, project_id TEXT, status TEXT
    );
    CREATE TABLE "StepRuns" (
      id TEXT, run_id TEXT, status TEXT, output_ref TEXT,
      PRIMARY KEY (run_id, id)
    );
    CREATE TABLE "ModelInvocationPromptOutputArtifacts" (
      artifact_id TEXT PRIMARY KEY, project_id TEXT, run_id TEXT,
      step_run_id TEXT, invocation_id TEXT, artifact_digest TEXT
    );
  `);
  database
    .prepare(
      `INSERT INTO "ModelInvocationPromptAdmissions" VALUES
    (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      TARGET.executionRequestId,
      'invocation-1',
      REFERENCE.runId,
      'step-1',
      TARGET.projectId,
      TARGET.packageName,
      TARGET.promptId,
    );
  database
    .prepare(`INSERT INTO "ModelInvocationPromptFinalizations" VALUES (?, ?)`)
    .run(TARGET.executionRequestId, 'succeeded');
  database
    .prepare(`INSERT INTO "ModelInvocationCompletions" VALUES (?, ?)`)
    .run('invocation-1', 'succeeded');
  database
    .prepare(`INSERT INTO "Runs" VALUES (?, ?, ?)`)
    .run(REFERENCE.runId, TARGET.projectId, 'succeeded');
  database
    .prepare(`INSERT INTO "StepRuns" VALUES (?, ?, ?, ?)`)
    .run('step-1', REFERENCE.runId, 'succeeded', REFERENCE.artifactId);
  database
    .prepare(
      `INSERT INTO "ModelInvocationPromptOutputArtifacts" VALUES
    (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      REFERENCE.artifactId,
      TARGET.projectId,
      REFERENCE.runId,
      'step-1',
      'invocation-1',
      REFERENCE.artifactDigest,
    );

  const repository = sqliteRepository(database);
  assert.deepEqual(await repository.find(TARGET), REFERENCE);
  assert.equal(
    await repository.find({ ...TARGET, promptId: 'another-prompt' }),
    null,
  );
  database.prepare(`UPDATE "StepRuns" SET output_ref = NULL`).run();
  assert.equal(await repository.find(TARGET), null);
});

test('PostgreSQL locator uses the existing request primary key and terminal joins', async () => {
  const calls = [];
  const repository =
    new PostgresPluginPackagePromptExecutionOutputReferenceRepository({
      async query(sql, parameters) {
        calls.push({ sql, parameters });
        return {
          rows: [
            {
              runId: REFERENCE.runId,
              artifactId: REFERENCE.artifactId,
              artifactDigest: REFERENCE.artifactDigest,
            },
          ],
        };
      },
    });
  assert.deepEqual(await repository.find(TARGET), REFERENCE);
  assert.deepEqual(calls[0].parameters, [
    TARGET.executionRequestId,
    TARGET.projectId,
    TARGET.packageName,
    TARGET.promptId,
  ]);
  assert.match(calls[0].sql, /admission\.request_id = \$1/);
  assert.match(calls[0].sql, /step\.output_ref = artifact\.artifact_id/);
  assert.match(calls[0].sql, /LIMIT 2/);
  assert.equal(calls[0].sql.includes('artifact_json'), false);
  assert.equal(calls[0].sql.includes('ciphertext'), false);
});
