const assert = require('node:assert/strict');
const test = require('node:test');

const {
  pluginPackageAutomationPublicationDigest,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  preparePluginPackagePromptExecution,
} = require('../dist/prompt/pluginPackagePromptExecution.js');
const {
  createPluginPackagePromptOutputArtifact,
} = require('../dist/prompt-output/pluginPackagePromptOutputArtifact.js');
const {
  PostgresPluginPackagePromptOutputArtifactRepository,
} = require('../dist/prompt-output/storage/postgresPluginPackagePromptOutputArtifactRepository.js');

function publication() {
  const unsigned = {
    schema: 'qinglong/plugin-package-automation-publication@v1',
    target: {
      projectId: 'project-a',
      packageName: 'package-a',
      installationId: 'installation-a',
      lockDigest: '1'.repeat(64),
      generation: 1,
      generationDigest: '2'.repeat(64),
      materializedRevisionDigest: '3'.repeat(64),
    },
    state: 'active',
    version: 1,
    previousPublicationDigest: null,
    lifecycleEventDigest: null,
    definitions: {
      workflows: [],
      prompts: [
        {
          schema: 'qinglong/plugin-package-prompt-resource@v1',
          id: 'summary',
          name: 'Summary',
          template: 'Summarize {{subject}}.',
          parameters: [{ name: 'subject', required: true }],
        },
      ],
    },
    publishedAtMs: 1_000,
  };
  return {
    ...unsigned,
    publicationDigest: pluginPackageAutomationPublicationDigest(unsigned),
  };
}

function prepared(output) {
  const active = publication();
  return preparePluginPackagePromptExecution({
    publication: active,
    expectedPublicationDigest: active.publicationDigest,
    promptId: 'summary',
    requestId: 'prompt-request-a',
    traceId: 'trace-a',
    requestedBySubject: { type: 'user', id: 'user-a' },
    policyFence: { projectVersion: 1, bindingVersion: 1 },
    parameters: { subject: 'private input' },
    provider: 'openai-compatible',
    model: 'model-a',
    maxOutputTokens: 64,
    plannedAtMs: 2_000,
    deadlineAtMs: 62_000,
    ...(output === undefined ? {} : { output }),
  });
}

function row(artifact) {
  return {
    artifactId: artifact.artifactId,
    projectId: artifact.projectId,
    runId: artifact.runId,
    stepRunId: artifact.stepRunId,
    invocationId: artifact.invocationId,
    requestedByType: artifact.requestedBy.type,
    requestedById: artifact.requestedBy.id,
    provider: artifact.provider,
    model: artifact.model,
    contentDigest: artifact.contentDigest,
    outputBytes: artifact.outputBytes,
    retentionPolicyRevision: artifact.retentionPolicy.revision,
    retentionMs: String(artifact.retentionPolicy.retentionMs),
    retentionPolicyDigest: artifact.retentionPolicyDigest,
    retentionEligibleAtMs: String(artifact.retentionEligibleAtMs),
    keyId: artifact.keyId,
    algorithm: artifact.algorithm,
    plaintextBytes: artifact.plaintextBytes,
    sealedAtMs: String(artifact.sealedAtMs),
    artifactDigest: artifact.artifactDigest,
    artifactJson: artifact,
  };
}

function fakePool(plan) {
  const queries = [];
  let stored = null;
  const client = {
    async query(sql, parameters = []) {
      queries.push(sql);
      if (sql.includes('model_invocation_prompt_admissions')) {
        return { rows: [{ planJson: plan }] };
      }
      if (
        sql.startsWith('SELECT artifact_id') &&
        sql.includes('model_invocation_prompt_output_artifacts')
      ) {
        return {
          rows: stored && stored.artifactId === parameters[0] ? [stored] : [],
        };
      }
      if (
        sql.includes('INSERT INTO') &&
        sql.includes('prompt_output_artifacts')
      ) {
        const artifact = JSON.parse(parameters[20]);
        stored = row(artifact);
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    queries,
    async connect() {
      return client;
    },
    async query(sql, parameters) {
      return client.query(sql, parameters);
    },
  };
}

test('PostgreSQL Prompt output Artifact is immutable and plan-bound', async () => {
  const durable = prepared({
    mode: 'durable_artifact',
    retentionPolicy: { revision: 'cluster-v1', retentionMs: 86_400_000 },
  });
  const artifact = createPluginPackagePromptOutputArtifact(
    {
      projectId: durable.plan.target.projectId,
      runId: durable.plan.runId,
      stepRunId: durable.plan.stepRunId,
      invocationId: durable.plan.invocationId,
      requestedBy: durable.plan.requestedBySubject,
      result: {
        provider: durable.plan.provider,
        model: durable.plan.model,
        text: 'private PostgreSQL Artifact output',
        finishReason: 'stop',
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
      retentionPolicy: durable.plan.output.retentionPolicy,
      keyId: 'cluster-key-1',
      key: Buffer.alloc(32, 7),
      sealedAtMs: 3_000,
    },
    () => Buffer.alloc(12, 9),
  );
  const pool = fakePool(durable.plan);
  const repository = new PostgresPluginPackagePromptOutputArtifactRepository(
    pool,
  );

  assert.deepEqual(await repository.put(artifact), { status: 'inserted' });
  assert.deepEqual(await repository.put(artifact), { status: 'existing' });
  assert.deepEqual(await repository.find(artifact.artifactId), artifact);
  assert.equal(pool.queries.includes('BEGIN'), true);
  assert.equal(
    pool.queries.includes('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'),
    true,
  );
  assert.equal(
    pool.queries.some((sql) => /FOR (?:UPDATE|SHARE)/.test(sql)),
    false,
  );
  assert.equal(
    JSON.stringify(row(artifact)).includes(artifact.ciphertext),
    true,
  );
  assert.equal(
    JSON.stringify(row(artifact)).includes('private PostgreSQL'),
    false,
  );

  const live = prepared();
  const livePool = fakePool(live.plan);
  const liveRepository =
    new PostgresPluginPackagePromptOutputArtifactRepository(livePool);
  const liveArtifact = createPluginPackagePromptOutputArtifact(
    {
      projectId: live.plan.target.projectId,
      runId: live.plan.runId,
      stepRunId: live.plan.stepRunId,
      invocationId: live.plan.invocationId,
      requestedBy: live.plan.requestedBySubject,
      result: {
        provider: live.plan.provider,
        model: live.plan.model,
        text: 'must remain live only',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
      retentionPolicy: { revision: 'cluster-v1', retentionMs: 86_400_000 },
      keyId: 'cluster-key-1',
      key: Buffer.alloc(32, 7),
      sealedAtMs: 3_000,
    },
    () => Buffer.alloc(12, 9),
  );
  await assert.rejects(liveRepository.put(liveArtifact), {
    code: 'PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_CONFLICT',
  });
  assert.equal(
    livePool.queries.some((sql) => sql.includes('INSERT INTO')),
    false,
  );
});
