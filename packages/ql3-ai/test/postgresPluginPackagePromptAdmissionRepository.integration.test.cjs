const assert = require('node:assert/strict');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');

const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  createPluginPackagePublisherTrustSnapshot,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
  publisherProvenanceInstallRepository,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  migratePostgresModelInvocationFeature,
} = require('@qinglong/ai/model-invocation-migration');
const {
  bootstrapPostgresPluginPackagePromptApplication,
} = require('../dist/prompt/postgresPluginPackagePromptApplication.js');

const migrationConnectionString =
  process.env.QL3_TEST_POSTGRES_MIGRATION_URL ??
  process.env.QL3_TEST_POSTGRES_URL;
const runtimeConnectionString =
  process.env.QL3_TEST_POSTGRES_RUNTIME_URL ?? migrationConnectionString;
const packageExecutorConnectionString =
  process.env.QL3_TEST_POSTGRES_PACKAGE_EXECUTOR_URL ??
  migrationConnectionString;

if (!migrationConnectionString) {
  test('PostgreSQL Package Prompt integration requires QL3_TEST_POSTGRES_URL', {
    skip: true,
  });
} else {
  const clusterRequire = createRequire(
    path.resolve(__dirname, '../../ql3-cluster-postgres/package.json'),
  );
  const { Pool } = clusterRequire('pg');
  const {
    runPostgresMigrations,
  } = require('../../ql3-cluster-postgres/dist/migration/migration.js');
  const {
    PostgresPluginPackageInstallRepository,
  } = require('../../ql3-cluster-postgres/dist/plugin-package/installation/pluginPackageInstallRepository.js');
  const {
    PostgresPluginPackagePublisherProvenanceRepository,
  } = require('../../ql3-cluster-postgres/dist/plugin-package/publisher/pluginPackagePublisherProvenanceRepository.js');
  const {
    PostgresPluginPackagePublisherTrustAuthorityRepository,
  } = require('../../ql3-cluster-postgres/dist/plugin-package/publisher/pluginPackagePublisherTrustAuthorityRepository.js');
  const {
    PostgresPluginPackageMaterializedRevisionRepository,
  } = require('../../ql3-cluster-postgres/dist/plugin-package/installation/pluginPackageMaterializedRevisionRepository.js');
  const {
    PostgresPluginPackageAutomationPublicationRepository,
  } = require('../../ql3-cluster-postgres/dist/plugin-package/publication/pluginPackageAutomationPublicationRepository.js');

  function pool(connectionString, applicationName) {
    return new Pool({
      connectionString,
      ssl: false,
      max: 4,
      application_name: applicationName,
    });
  }

  test('PostgreSQL executes and replays one content-free Package Prompt', async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const credentialId = `prompt-${suffix}`;
    const fixture = pluginPackageTaskReconciliationFixture(
      `ai-prompt-${suffix}`,
      {
        profile: 'cluster-control',
        prompts: [
          {
            schema: 'qinglong/plugin-package-prompt-resource@v1',
            id: 'summary',
            name: 'Summary',
            template: 'Summarize {{subject}} for {{audience}}.',
            parameters: [
              { name: 'audience', required: false },
              { name: 'subject', required: true },
            ],
          },
        ],
      },
    );
    const publication = createInitialPluginPackageAutomationPublication(
      fixture.revision,
      fixture.registry,
      20_000,
    );
    const migrationPool = pool(
      migrationConnectionString,
      'ql3-ai-prompt-migration-test',
    );
    const executorPool = pool(
      packageExecutorConnectionString,
      'ql3-ai-prompt-package-executor-test',
    );
    const runtimePool = pool(
      runtimeConnectionString,
      'ql3-ai-prompt-runtime-test',
    );
    let application;
    try {
      await runPostgresMigrations({ pool: migrationPool });
      await migratePostgresModelInvocationFeature(migrationPool);
      const keyPair = generateKeyPairSync('ed25519');
      const trust = createPluginPackagePublisherTrustSnapshot([
        {
          publisher: 'packages.contract.qinglong.dev',
          keyId: 'contract-key-1',
          publicKeyPem: keyPair.publicKey.export({
            type: 'spki',
            format: 'pem',
          }),
          notBeforeMs: 0,
          notAfterMs: 100_000,
        },
      ]);
      await new PostgresPluginPackagePublisherTrustAuthorityRepository(
        migrationPool,
      ).observeSnapshot({
        authorityId: 'cluster',
        observedBy: `ai-prompt-${suffix}`,
        observedAtMs: 1,
        snapshot: trust,
      });
      await migrationPool.query(
        `INSERT INTO "ql3"."projects" (
           id, name, slug, status, version, created_at_ms, updated_at_ms
         ) VALUES ($1, $1, $1, 'active', 1, 1, 1)
         ON CONFLICT (id) DO NOTHING`,
        [fixture.projectId],
      );
      await migrationPool.query(
        `INSERT INTO "ql3"."identity_subjects" (
           subject_type, subject_id, status, version, created_at_ms, updated_at_ms
         ) VALUES ('user', 'user-a', 'active', 1, 1, 1)
         ON CONFLICT (subject_type, subject_id) DO UPDATE
         SET status = 'active', version = "ql3"."identity_subjects".version + 1,
             updated_at_ms = 1`,
      );
      await migrationPool.query(
        `INSERT INTO "ql3"."api_credentials" (
           credential_id, version, state, subject_type, subject_id,
           pepper_key_id, secret_digest, created_at_ms, not_before_at_ms,
           expires_at_ms
         ) VALUES ($1, 1, 'active', 'user', 'user-a', 'integration-v1',
                   $2, 1, 1, 9999999999999)`,
        [credentialId, 'a'.repeat(64)],
      );
      await migrationPool.query(
        `INSERT INTO "ql3"."project_role_bindings" (
           project_id, subject_type, subject_id, version, state, role,
           mutation_id, changed_by_type, changed_by_id, created_at_ms
         ) VALUES ($1, 'user', 'user-a', 1, 'active', 'operator',
                   $2, 'system', 'integration-test', 1)
         ON CONFLICT (project_id, subject_type, subject_id, version)
         DO NOTHING`,
        [fixture.projectId, `ai-prompt-user-${suffix}`],
      );

      await activateInstall(
        publisherProvenanceInstallRepository(
          new PostgresPluginPackageInstallRepository(executorPool),
          new PostgresPluginPackagePublisherProvenanceRepository(executorPool),
        ),
        fixture,
      );
      await new PostgresPluginPackageMaterializedRevisionRepository(
        executorPool,
        fixture.registry,
      ).publish(fixture.revision);
      await new PostgresPluginPackageAutomationPublicationRepository(
        executorPool,
      ).publish(publication);

      const privileges = await runtimePool.query(
        `SELECT
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_prompt_admissions', 'SELECT,INSERT'
           ) AS admission_write,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_prompt_admissions', 'UPDATE'
           ) AS admission_update,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_prompt_finalizations', 'SELECT,INSERT'
           ) AS finalization_write,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_prompt_finalizations', 'DELETE'
           ) AS finalization_delete,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_prompt_output_artifacts', 'SELECT,INSERT'
           ) AS output_artifact_write,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_prompt_output_artifacts', 'UPDATE,DELETE'
           ) AS output_artifact_mutation,
           has_function_privilege(
             current_user,
             'ql3_ai.plugin_package_prompt_admission_snapshot(varchar,varchar,character,varchar,varchar,integer,integer)',
             'EXECUTE'
           ) AS snapshot_execute`,
      );
      assert.deepEqual(privileges.rows[0], {
        admission_write: true,
        admission_update: false,
        finalization_write: true,
        finalization_delete: false,
        output_artifact_write: true,
        output_artifact_mutation: false,
        snapshot_execute: true,
      });

      let providerCalls = 0;
      application = await bootstrapPostgresPluginPackagePromptApplication({
        enabled: true,
        async openDatabase() {
          return { pool: runtimePool, async close() {} };
        },
        async loadProviders() {
          return {
            providers: [
              {
                type: 'openai-compatible',
                async listModels() {
                  return [{ id: 'vendor/model-a' }];
                },
                async generate() {
                  providerCalls += 1;
                  return {
                    provider: 'openai-compatible',
                    model: 'vendor/model-a',
                    text: 'one live PostgreSQL response',
                    finishReason: 'stop',
                    usage: {
                      inputTokens: 7,
                      outputTokens: 3,
                      totalTokens: 10,
                    },
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
                  revision: 'policy-1',
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
          };
        },
        async audit() {},
        promptOutputKeys: {
          async active() {
            return {
              keyId: 'cluster-prompt-output-key-1',
              key: Buffer.alloc(32, 11),
            };
          },
          async resolve(keyId) {
            return keyId === 'cluster-prompt-output-key-1'
              ? { keyId, key: Buffer.alloc(32, 11) }
              : null;
          },
        },
        promptOutputRead: {
          authorizer: {
            async authorize() {
              return { effect: 'allow' };
            },
          },
        },
        maxConcurrent: 1,
        recoveryLimit: 8,
        now: () => 31_000,
      });
      assert.equal(application.status, 'active');
      assert.equal(application.readiness.currentUser, 'ql3_runtime');
      const executor = application.promptExecutions;
      const input = {
        projectId: publication.target.projectId,
        packageName: publication.target.packageName,
        promptId: 'summary',
        requestId: `prompt-request-${suffix}`,
        traceId: `prompt-trace-${suffix}`,
        auditEventId: randomUUID(),
        principal: {
          subject: { type: 'user', id: 'user-a' },
          authenticationId: `api_credential:${credentialId}:1`,
          authenticatedAtMs: 1,
          expiresAtMs: 9999999999999,
          assurance: 'single_factor',
        },
        policyFence: { projectVersion: 1, bindingVersion: 1 },
        parameters: { subject: 'private PostgreSQL input' },
        provider: 'openai-compatible',
        model: 'vendor/model-a',
        maxOutputTokens: 512,
        temperature: 0.2,
        plannedAtMs: 30_000,
        deadlineAtMs: 90_000,
      };
      const first = await executor.execute(input);
      assert.equal(first.status, 'executed');
      assert.equal(first.result.text, 'one live PostgreSQL response');
      assert.equal(first.finalization.runStatus, 'succeeded');
      const replay = await executor.execute(input);
      assert.equal(replay.status, 'existing');
      assert.equal(replay.result, null);
      assert.deepEqual(replay.admission, first.admission);
      assert.deepEqual(replay.finalization, first.finalization);
      assert.equal(providerCalls, 1);

      const durableInput = {
        ...input,
        requestId: `prompt-request-durable-${suffix}`,
        traceId: `prompt-trace-durable-${suffix}`,
        auditEventId: randomUUID(),
        output: {
          mode: 'durable_artifact',
          retentionPolicy: {
            revision: 'cluster-output-v1',
            retentionMs: 86_400_000,
          },
        },
      };
      const durableFirst = await executor.execute(durableInput);
      assert.equal(durableFirst.status, 'executed');
      assert.equal(durableFirst.result.text, 'one live PostgreSQL response');
      assert.equal(
        durableFirst.outputArtifact.artifactId.startsWith('pao:'),
        true,
      );
      const durableReplay = await executor.execute(durableInput);
      assert.equal(durableReplay.status, 'existing');
      assert.equal(durableReplay.result, null);
      assert.deepEqual(
        durableReplay.outputArtifact,
        durableFirst.outputArtifact,
      );
      assert.equal(providerCalls, 2);
      assert.ok(application.promptExecutionOutputs);
      const recoveredOutput = await application.promptExecutionOutputs.read({
        principal: input.principal,
        projectId: durableInput.projectId,
        packageName: durableInput.packageName,
        promptId: durableInput.promptId,
        executionRequestId: durableInput.requestId,
      });
      assert.equal(recoveredOutput.status, 'available');
      assert.equal(recoveredOutput.result.text, 'one live PostgreSQL response');
      assert.deepEqual(recoveredOutput.reference, durableFirst.outputArtifact);
      assert.equal(
        (
          await application.promptExecutionOutputs.read({
            principal: input.principal,
            projectId: durableInput.projectId,
            packageName: durableInput.packageName,
            promptId: 'cross-target',
            executionRequestId: durableInput.requestId,
          })
        ).status,
        'not_found',
      );
      const outputEvidence = await runtimePool.query(
        `SELECT artifact.artifact_json::text AS "artifactJson",
                step.output_ref AS "outputRef"
           FROM "ql3_ai"."model_invocation_prompt_output_artifacts" AS artifact
           JOIN "ql3"."step_runs" AS step
             ON step.id = artifact.step_run_id
            AND step.run_id = artifact.run_id
          WHERE artifact.invocation_id = $1`,
        [durableFirst.admission.invocationId],
      );
      assert.equal(outputEvidence.rows.length, 1);
      assert.equal(
        outputEvidence.rows[0].outputRef,
        durableFirst.outputArtifact.artifactId,
      );
      assert.equal(
        outputEvidence.rows[0].artifactJson.includes(
          'one live PostgreSQL response',
        ),
        false,
      );

      const durable = await runtimePool.query(
        `SELECT admission.plan_json, admission.receipt_json,
                finalization.receipt_json, run.status, run.version,
                run.event_sequence AS "eventSequence"
         FROM "ql3_ai"."model_invocation_prompt_admissions" AS admission
         JOIN "ql3_ai"."model_invocation_prompt_finalizations"
           AS finalization USING (request_id)
         JOIN "ql3"."runs" AS run ON run.id = admission.run_id
         WHERE admission.request_id = $1`,
        [input.requestId],
      );
      assert.equal(durable.rows.length, 1);
      assert.deepEqual(
        {
          status: durable.rows[0].status,
          version: durable.rows[0].version,
          eventSequence: durable.rows[0].eventSequence,
        },
        { status: 'succeeded', version: 5, eventSequence: 5 },
      );
      const durableJson = JSON.stringify(durable.rows[0]);
      assert.equal(durableJson.includes('private PostgreSQL input'), false);
      assert.equal(durableJson.includes('one live PostgreSQL response'), false);
    } finally {
      await application?.stop();
      await Promise.all([
        runtimePool.end(),
        executorPool.end(),
        migrationPool.end(),
      ]);
    }
  });
}
