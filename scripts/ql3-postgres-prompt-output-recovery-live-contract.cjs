#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} = require('node:crypto');
const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createPostgresDatabaseOpener,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/runtime.js');
const {
  PostgresPluginPackageAutomationPublicationRepository,
  PostgresPluginPackageMaterializedRevisionRepository,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/packageExecutor.js');
const {
  runPostgresMigrations,
} = require('../packages/ql3-cluster-postgres/dist/migration/migration.js');
const {
  migratePostgresModelInvocationFeature,
} = require('../packages/ql3-ai/dist/migration/modelInvocationMigration.js');
const {
  BoundedModelGateway,
} = require('../packages/ql3-ai/dist/model-gateway/gateway.js');
const {
  DurableModelInvocationCoordinator,
} = require('../packages/ql3-ai/dist/model-invocation/durableModelInvocationCoordinator.js');
const {
  PostgresModelInvocationRepository,
} = require('../packages/ql3-ai/dist/model-invocation/postgresModelInvocationRepository.js');
const {
  PostgresPluginPackagePromptAdmissionRepository,
} = require('../packages/ql3-ai/dist/prompt/postgresPluginPackagePromptAdmissionRepository.js');
const {
  PluginPackagePromptExecutor,
} = require('../packages/ql3-ai/dist/prompt/pluginPackagePromptExecutor.js');
const {
  PluginPackagePromptOutputCompletionCoordinator,
} = require('../packages/ql3-ai/dist/prompt-output/pluginPackagePromptOutputCompletion.js');
const {
  PostgresPluginPackagePromptOutputArtifactRepository,
} = require('../packages/ql3-ai/dist/prompt-output/storage/postgresPluginPackagePromptOutputArtifactRepository.js');
const {
  PluginPackagePromptOutputKeyRotationCoordinator,
  pluginPackagePromptOutputKeyRotationMaterialProof,
} = require('../packages/ql3-ai/dist/prompt-output/key-management/pluginPackagePromptOutputKeyRotation.js');
const {
  PostgresPluginPackagePromptOutputKeyRotationRepository,
} = require('../packages/ql3-ai/dist/prompt-output/storage/postgresPluginPackagePromptOutputKeyRotationRepository.js');
const {
  createPluginPackagePromptAdmissionBundle,
  preparePluginPackagePromptExecution,
} = require('../packages/ql3-ai/dist/prompt/pluginPackagePromptExecution.js');
const {
  createPluginPackagePromptOutputExternalCustodyReceipt,
} = require('../packages/ql3-ai/dist/prompt-output/custody/pluginPackagePromptOutputExternalCustody.js');
const {
  createPluginPackagePromptOutputExternalCustodyBundle,
} = require('../packages/ql3-ai/dist/prompt-output/custody/pluginPackagePromptOutputExternalCustodyBundle.js');
const {
  createPluginPackagePromptOutputExternalRecoveryAuthorization,
} = require('../packages/ql3-ai/dist/prompt-output/custody/pluginPackagePromptOutputExternalRecoveryAuthorization.js');
const {
  createInitialPluginPackageAutomationPublication,
} = require('../packages/ql3-runtime-core/dist/plugin-package/pluginPackageAutomationPublication.js');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  disposeClusterPromptOutputExternalRecoveryInput,
  readClusterPromptOutputExternalRecoveryCommand,
  readClusterPromptOutputExternalRecoveryInput,
} = require('../packages/ql3-cluster-admin/dist/prompt-output/external-recovery/promptOutputExternalRecoveryInput.js');
const {
  runClusterPromptOutputExternalRecoveryVerifier,
} = require('../packages/ql3-cluster-admin/dist/prompt-output/external-recovery/promptOutputExternalRecoveryVerifier.js');

const IMAGE =
  'docker.io/library/postgres:18@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a';
const DATABASE = 'qinglong';
const PLAINTEXT = 'private PostgreSQL backup recovery output';
const REQUIRED_DATABASE_ROLES = Object.freeze([
  'ql3_migration',
  'ql3_runtime',
  'ql3_admin',
  'ql3_worker_ingress',
  'ql3_package_manager',
  'ql3_package_executor',
  'ql3_worker_credential_manager',
  'ql3_worker_credential_executor',
  'ql3_automation_manager',
  'ql3_approval_manager',
  'ql3_ai_maintenance',
  'ql3_ai_credential_manager',
  'ql3_ai_credential_tester',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function docker(args, options = {}) {
  const binary = options.binary === true;
  const result = spawnSync('docker', args, {
    input: options.input,
    encoding: binary ? null : 'utf8',
    timeout: options.timeoutMs ?? 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : result.stderr ?? '';
    const detail = stderr.trim().slice(-2_048);
    throw new Error(
      `Docker command failed: ${args[0] ?? 'unknown'}${
        detail ? `: ${detail}` : ''
      }`,
    );
  }
  return {
    status: result.status,
    stdout: binary
      ? Buffer.from(result.stdout ?? Buffer.alloc(0))
      : (result.stdout ?? '').trim(),
  };
}

function privateFile(directory, name, value, mode = 0o400) {
  const file = path.join(directory, name);
  writeFileSync(file, value, { flag: 'wx', mode });
  chmodSync(file, mode);
  return file;
}

function startPostgres(container, password) {
  const id = docker([
    'run',
    '--detach',
    '--name',
    container,
    '--publish',
    '127.0.0.1::5432',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,mode=1777',
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    '--env',
    `POSTGRES_DB=${DATABASE}`,
    '--volume',
    '/var/lib/postgresql',
    IMAGE,
  ]).stdout;
  assert.match(id, /^[a-f0-9]{64}$/);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const ready = docker(
      [
        'exec',
        container,
        'psql',
        '--username',
        'postgres',
        '--dbname',
        DATABASE,
        '--tuples-only',
        '--no-align',
        '--command',
        'SELECT 1',
      ],
      { allowFailure: true },
    );
    if (ready.status === 0 && ready.stdout === '1') {
      const mapping = docker(['port', container, '5432/tcp']).stdout;
      const match = mapping.match(/^127\.0\.0\.1:(\d+)$/);
      if (!match) throw new Error('PostgreSQL port is not loopback-only');
      return Object.freeze({ id, port: Number(match[1]) });
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error('PostgreSQL did not become ready');
}

function databaseOpener(password, port, applicationName) {
  return createPostgresDatabaseOpener({
    role: 'migration',
    connection: {
      connectionString:
        `postgresql://postgres:${encodeURIComponent(password)}` +
        `@127.0.0.1:${port}/${DATABASE}`,
      tls: { mode: 'disable' },
    },
    pool: {
      applicationName,
      maxConnections: 4,
      connectionTimeoutMs: 2_000,
    },
    onPoolError() {},
  });
}

function psql(container, sql) {
  return docker(
    [
      'exec',
      '--interactive',
      container,
      'psql',
      '--username',
      'postgres',
      '--dbname',
      DATABASE,
      '--set',
      'ON_ERROR_STOP=1',
      '--no-psqlrc',
      '--quiet',
    ],
    { input: sql },
  ).stdout;
}

function bootstrapDatabaseRoles(container, roles = REQUIRED_DATABASE_ROLES) {
  for (const role of roles) assert.match(role, /^ql3_[a-z0-9_]+$/);
  psql(
    container,
    roles
      .map(
        (role) =>
          `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB ` +
          'NOCREATEROLE NOREPLICATION NOBYPASSRLS;',
      )
      .join('\n'),
  );
}

async function seedCanonicalPromptAdmission(pool, bundle) {
  const client = await pool.connect();
  const run = bundle.run;
  const step = bundle.stepMutation.stepRun;
  const event = bundle.admissionEvent;
  const stepEvent = bundle.stepMutation.event;
  const plan = bundle.plan;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO "ql3"."runs" (
         id, project_id, task_id, task_revision, task_name,
         task_snapshot_ref, trigger_type, execution_origin, execution_owner,
         triggered_by, request_id, status, version, event_sequence, priority,
         idempotency_key, created_at_ms, started_at_ms
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18
       )`,
      [
        run.id,
        run.projectId,
        run.taskId,
        run.taskRevision,
        run.taskName,
        run.taskSnapshotRef,
        run.triggerType,
        run.executionOrigin,
        run.executionOwner,
        run.triggeredBy,
        run.requestId,
        run.status,
        run.version,
        run.eventSequence,
        run.priority,
        run.idempotencyKey,
        run.createdAtMs,
        run.startedAtMs,
      ],
    );
    await client.query(
      `INSERT INTO "ql3"."run_events" (
         id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
         attempt_id, step_run_id, payload, created_at_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8::jsonb, $9)`,
      [
        event.id,
        event.runId,
        event.sequence,
        event.type,
        event.dedupeKey,
        event.actorType,
        event.actorId,
        JSON.stringify(event.payload),
        event.createdAtMs,
      ],
    );
    await client.query(
      `INSERT INTO "ql3"."step_runs" (
         id, run_id, parent_step_run_id, step_key, kind, definition_ref,
         definition_digest, required, status, version, attempt_count,
         input_ref, output_ref, approval_request_id, ready_at_ms,
         started_at_ms, finished_at_ms, result_code, error_summary,
         created_at_ms, updated_at_ms, last_mutation_id, step_run_digest,
         step_run_json
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb
       )`,
      [
        step.id,
        step.runId,
        step.parentStepRunId,
        step.stepKey,
        step.kind,
        step.definitionRef,
        step.definitionDigest,
        step.required,
        step.status,
        step.version,
        step.attemptCount,
        step.inputRef,
        step.outputRef,
        step.approvalRequestId,
        step.readyAtMs,
        step.startedAtMs,
        step.finishedAtMs,
        step.resultCode,
        step.errorSummary,
        step.createdAtMs,
        step.updatedAtMs,
        step.lastMutationId,
        step.stepRunDigest,
        JSON.stringify(step),
      ],
    );
    await client.query(
      `INSERT INTO "ql3"."run_events" (
         id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
         attempt_id, step_run_id, payload, created_at_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9::jsonb, $10)`,
      [
        stepEvent.id,
        stepEvent.runId,
        stepEvent.sequence,
        stepEvent.type,
        stepEvent.dedupeKey,
        stepEvent.actorType,
        stepEvent.actorId,
        step.id,
        JSON.stringify(stepEvent.payload),
        stepEvent.createdAtMs,
      ],
    );
    await client.query(
      `INSERT INTO "ql3"."step_run_mutations" (
         mutation_id, mutation_digest, run_id, step_run_id,
         step_run_digest, event_id, event_sequence, run_version,
         step_run_json, committed_at_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [
        bundle.stepMutation.mutationId,
        bundle.stepMutation.mutationDigest,
        bundle.stepMutation.runId,
        step.id,
        step.stepRunDigest,
        stepEvent.id,
        stepEvent.sequence,
        bundle.stepMutation.expectedRunVersion + 1,
        JSON.stringify(step),
        bundle.receipt.admittedAtMs,
      ],
    );
    await client.query(
      `INSERT INTO "ql3_ai"."model_invocation_prompt_admissions" (
         request_id, invocation_id, plan_digest, run_id, step_run_id,
         project_id, package_name, installation_id, lock_digest, generation,
         generation_digest, materialized_revision_digest, publication_digest,
         prompt_id, prompt_definition_digest, parameter_digest,
         model_request_digest, admitted_at_ms, receipt_digest, plan_json,
         receipt_json
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20::jsonb, $21::jsonb
       )`,
      [
        plan.requestId,
        plan.invocationId,
        plan.planDigest,
        plan.runId,
        plan.stepRunId,
        plan.target.projectId,
        plan.target.packageName,
        plan.target.installationId,
        plan.target.lockDigest,
        plan.target.generation,
        plan.target.generationDigest,
        plan.target.materializedRevisionDigest,
        plan.target.publicationDigest,
        plan.target.promptId,
        plan.target.promptDefinitionDigest,
        plan.parameterDigest,
        plan.modelRequestDigest,
        bundle.receipt.admittedAtMs,
        bundle.receipt.receiptDigest,
        JSON.stringify(plan),
        JSON.stringify(bundle.receipt),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function readProductionEvidence(pool, artifactId, rotationId) {
  const artifact =
    await new PostgresPluginPackagePromptOutputArtifactRepository(pool).find(
      artifactId,
    );
  const rotation =
    await new PostgresPluginPackagePromptOutputKeyRotationRepository({
      pool,
    }).find(rotationId);
  assert.ok(artifact);
  assert.ok(rotation?.completion);
  const mainHistory = await pool.query(
    `SELECT migration_id AS "migrationId", checksum
       FROM "ql3"."schema_migrations" ORDER BY migration_id`,
  );
  const aiHistory = await pool.query(
    `SELECT migration_id AS "migrationId", checksum
       FROM "ql3_ai"."ai_schema_migrations" ORDER BY migration_id`,
  );
  const counts = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM "ql3_ai"."model_invocation_prompt_admissions") AS admissions,
       (SELECT count(*)::integer FROM "ql3_ai"."model_invocation_starts") AS starts,
       (SELECT count(*)::integer FROM "ql3_ai"."model_invocation_completions") AS completions,
       (SELECT count(*)::integer FROM "ql3_ai"."model_invocation_prompt_finalizations") AS finalizations,
       (SELECT count(*)::integer FROM "ql3_ai"."model_invocation_prompt_output_artifacts") AS artifacts,
       (SELECT count(*)::integer FROM "ql3_ai"."model_invocation_prompt_output_key_rotation_completions") AS rotations,
       (SELECT count(*)::integer FROM "ql3"."plugin_package_materialized_revisions") AS "materializedRevisions",
       (SELECT count(*)::integer FROM "ql3"."plugin_package_automation_publications") AS publications`,
  );
  assert.deepEqual(counts.rows, [
    {
      admissions: 1,
      starts: 1,
      completions: 1,
      finalizations: 1,
      artifacts: 1,
      rotations: 1,
      materializedRevisions: 1,
      publications: 1,
    },
  ]);
  const completion = rotation.completion;
  return Object.freeze({
    durableKeyFact: Object.freeze({
      keyId: completion.activeKeyId,
      materialProof: completion.materialProof,
      catalogDigest: completion.catalogDigest,
    }),
    artifact,
    lineage: Object.freeze({
      mainMigrationCount: mainHistory.rows.length,
      aiMigrationCount: aiHistory.rows.length,
      migrationHistoryDigest: sha256(
        JSON.stringify({ main: mainHistory.rows, ai: aiHistory.rows }),
      ),
      counts: counts.rows[0],
    }),
  });
}

function approvalSigner(userId, authenticationId, keys, approvedAtMs) {
  return {
    userId,
    authenticationId,
    authenticatedAtMs: approvedAtMs - 1_000,
    approvedAtMs,
    publicKey: keys.publicKey,
    sign(digest) {
      return sign(null, digest, keys.privateKey);
    },
  };
}

async function main() {
  if (process.env.QL3_RUN_POSTGRES_BACKUP_RECOVERY_LIVE !== 'true') {
    throw new Error('QL3_RUN_POSTGRES_BACKUP_RECOVERY_LIVE=true is required');
  }
  docker(['version', '--format', '{{.Server.Version}}']);
  docker(['image', 'inspect', IMAGE]);

  const suffix = `${process.pid}-${randomBytes(3).toString('hex')}`;
  const sourceContainer = `ql3-pg-recovery-source-${suffix}`;
  const restoreContainer = `ql3-pg-recovery-restore-${suffix}`;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ql3-pg-recovery-'));
  chmodSync(directory, 0o700);
  const material = randomBytes(32);
  const wrappedMaterial = randomBytes(96);
  const custodyKeys = generateKeyPairSync('ed25519');
  const approverAKeys = generateKeyPairSync('ed25519');
  const approverBKeys = generateKeyPairSync('ed25519');
  let sourceStarted = false;
  let restoreStarted = false;
  let sourceDatabase = null;
  let restoreDatabase = null;
  try {
    const keyId = `postgres-recovery-key-${suffix}`;
    const rotationId = `postgres-recovery-rotation-${suffix}`;
    const materialProof = pluginPackagePromptOutputKeyRotationMaterialProof(
      keyId,
      material,
    );
    const sourceCatalogDigest = sha256(
      `ql3-postgres-recovery-source-catalog:${suffix}`,
    );
    const password = randomBytes(24).toString('base64url');
    const source = startPostgres(sourceContainer, password);
    sourceStarted = true;
    bootstrapDatabaseRoles(sourceContainer);
    sourceDatabase = await databaseOpener(
      password,
      source.port,
      'ql3-prompt-output-recovery-source',
    )();
    await runPostgresMigrations({ pool: sourceDatabase.pool });
    await migratePostgresModelInvocationFeature(sourceDatabase.pool);

    const fixture = pluginPackageTaskReconciliationFixture(
      `postgres-recovery-${suffix}`,
      {
        tasks: [],
        prompts: [
          {
            schema: 'qinglong/plugin-package-prompt-resource@v1',
            id: 'recovery',
            name: 'PostgreSQL recovery Prompt',
            template: 'Recover {{name}}',
            parameters: [{ name: 'name', required: true }],
          },
        ],
      },
    );
    const publication = createInitialPluginPackageAutomationPublication(
      fixture.revision,
      fixture.registry,
      9_000,
    );
    await sourceDatabase.pool.query(
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES ($1, $2, $3, 'active', 1, 8_000, 8_000)`,
      [
        publication.target.projectId,
        'PostgreSQL recovery fixture',
        publication.target.projectId,
      ],
    );
    const materialized =
      await new PostgresPluginPackageMaterializedRevisionRepository(
        sourceDatabase.pool,
        fixture.registry,
      ).publish(fixture.revision);
    assert.equal(materialized.status, 'created');
    const published =
      await new PostgresPluginPackageAutomationPublicationRepository(
        sourceDatabase.pool,
      ).publish(publication);
    assert.equal(published.status, 'created');
    const promptInput = {
      publication,
      expectedPublicationDigest: publication.publicationDigest,
      promptId: 'recovery',
      requestId: `postgres-recovery-request-${suffix}`,
      traceId: `postgres-recovery-trace-${suffix}`,
      requestedBySubject: { type: 'user', id: 'postgres-backup-requester' },
      policyFence: { projectVersion: 1, bindingVersion: 1 },
      parameters: { name: 'production-lineage' },
      provider: 'openai-compatible',
      model: 'postgres-backup-recovery-model',
      maxOutputTokens: 64,
      temperature: 0,
      plannedAtMs: 10_000,
      deadlineAtMs: 120_000,
      output: {
        mode: 'durable_artifact',
        retentionPolicy: {
          revision: 'postgres-backup-recovery-v1',
          retentionMs: 86_400_000,
        },
      },
    };
    const prepared = preparePluginPackagePromptExecution(promptInput);
    const admissionBundle = createPluginPackagePromptAdmissionBundle(
      prepared.plan,
    );
    await seedCanonicalPromptAdmission(sourceDatabase.pool, admissionBundle);

    let rotationClock = 11_000;
    const rotationRepository =
      new PostgresPluginPackagePromptOutputKeyRotationRepository({
        pool: sourceDatabase.pool,
        now: () => (rotationClock += 1),
      });
    const previousKeyId = `postgres-recovery-previous-${suffix}`;
    const rotationMaterial = Buffer.from(material);
    let rotation;
    try {
      rotation = await new PluginPackagePromptOutputKeyRotationCoordinator({
        repository: rotationRepository,
        materials: {
          async rotate(command) {
            assert.deepEqual(Buffer.from(command.material), material);
            return {
              generation: 2,
              previousActiveKeyId: previousKeyId,
              activeKeyId: keyId,
              catalogDigest: sourceCatalogDigest,
              materialProof,
            };
          },
        },
      }).rotate({
        request: {
          rotationId,
          requestId: `postgres-recovery-rotation-request-${suffix}`,
          mutationId: `postgres-recovery-rotation-mutation-${suffix}`,
          expectedSecretUid: `postgres-recovery-keyring-${suffix}`,
          expectedActiveKeyId: previousKeyId,
          expectedCatalogDigest: sha256(
            `ql3-postgres-recovery-previous-catalog:${suffix}`,
          ),
          newKeyId: keyId,
        },
        material: rotationMaterial,
      });
    } finally {
      rotationMaterial.fill(0);
    }
    assert.equal(rotation.status, 'completed');
    assert.equal(rotation.completion.activeKeyId, keyId);

    const modelRepository = new PostgresModelInvocationRepository(
      sourceDatabase.pool,
    );
    const modelCoordinator = new DurableModelInvocationCoordinator(
      modelRepository,
    );
    const durableOutput = new PluginPackagePromptOutputCompletionCoordinator({
      coordinator: modelCoordinator,
      keys: {
        async active() {
          return { keyId, key: Buffer.from(material) };
        },
        async resolve(candidateKeyId) {
          return candidateKeyId === keyId
            ? { keyId, key: Buffer.from(material) }
            : null;
        },
      },
      now: () => 30_000,
      nonceFactory: () => Buffer.alloc(12, 0x39),
    });
    let providerCalls = 0;
    const gateway = new BoundedModelGateway({
      providers: [
        {
          type: 'openai-compatible',
          async listModels() {
            return [{ id: 'postgres-backup-recovery-model' }];
          },
          async generate() {
            providerCalls += 1;
            return {
              provider: 'openai-compatible',
              model: 'postgres-backup-recovery-model',
              text: PLAINTEXT,
              finishReason: 'stop',
              usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
            };
          },
          async *stream() {
            throw new Error('PostgreSQL recovery evidence does not stream');
          },
        },
      ],
      policies: {
        async resolve() {
          return {
            revision: 'postgres-backup-recovery-policy-v1',
            allowedProviders: ['openai-compatible'],
            allowedModels: ['postgres-backup-recovery-model'],
            maxInputBytes: 4_096,
            maxOutputBytes: 4_096,
            maxOutputTokens: 64,
            maxTotalTokens: 128,
            maxCostMicros: null,
            priceRevision: null,
          };
        },
      },
      pricing: {
        async resolve() {
          throw new Error('PostgreSQL recovery pricing must be unreachable');
        },
      },
      audit: modelCoordinator,
      successfulCompletion: durableOutput,
      maxConcurrent: 1,
      now: () => 20_000,
    });
    const executor = new PluginPackagePromptExecutor({
      admissions: new PostgresPluginPackagePromptAdmissionRepository(
        sourceDatabase.pool,
      ),
      invocations: modelRepository,
      gateway,
      durableOutput,
    });
    const executed = await executor.execute(promptInput);
    assert.equal(executed.status, 'resumed');
    assert.equal(executed.result.text, PLAINTEXT);
    assert.equal(executed.finalization.runStatus, 'succeeded');
    assert.equal(providerCalls, 1);
    const artifact =
      await new PostgresPluginPackagePromptOutputArtifactRepository(
        sourceDatabase.pool,
      ).find(executed.outputArtifact.artifactId);
    assert.ok(artifact);

    const durableKeyFact = {
      keyId: rotation.completion.activeKeyId,
      materialProof: rotation.completion.materialProof,
      catalogDigest: rotation.completion.catalogDigest,
    };
    const sourceEvidence = await readProductionEvidence(
      sourceDatabase.pool,
      artifact.artifactId,
      rotationId,
    );
    assert.deepEqual(sourceEvidence.durableKeyFact, durableKeyFact);
    assert.deepEqual(sourceEvidence.artifact, artifact);
    const sourceRowDigest = sha256(JSON.stringify(sourceEvidence));
    const ql3Roles = (
      await sourceDatabase.pool.query(
        `SELECT rolname FROM pg_roles
          WHERE rolname LIKE 'ql3\\_%' ESCAPE '\\' ORDER BY rolname`,
      )
    ).rows.map(({ rolname }) => rolname);
    assert.ok(ql3Roles.length > 0);
    assert.equal(
      ql3Roles.every((role) => /^ql3_[a-z0-9_]+$/.test(role)),
      true,
    );

    const receipt = createPluginPackagePromptOutputExternalCustodyReceipt(
      {
        custodyId: `postgres-recovery-custody-${suffix}`,
        keyId,
        materialProof,
        sourceGeneration: rotation.completion.generation,
        sourceCatalogDigest,
        wrappingProvider: 'postgres-backup-composition-fixture',
        wrappingKeyRefDigest: sha256(
          'ql3-postgres-backup-composition-wrapping-authority',
        ),
        wrappedMaterialDigest: sha256(wrappedMaterial),
        wrappedMaterialBytes: wrappedMaterial.byteLength,
        createdAtMs: Date.now() - 60_000,
      },
      {
        publicKey: custodyKeys.publicKey,
        sign(digest) {
          return sign(null, digest, custodyKeys.privateKey);
        },
      },
    );
    const bundle = createPluginPackagePromptOutputExternalCustodyBundle(
      receipt,
      custodyKeys.publicKey,
      wrappedMaterial,
    );

    await sourceDatabase.close();
    sourceDatabase = null;

    const dump = docker(
      [
        'exec',
        sourceContainer,
        'pg_dump',
        '--username',
        'postgres',
        '--dbname',
        DATABASE,
        '--format',
        'custom',
        '--no-owner',
        '--no-acl',
      ],
      { binary: true },
    ).stdout;
    assert.ok(dump.byteLength > 1_024);
    assert.equal(dump.indexOf(Buffer.from(PLAINTEXT, 'utf8')), -1);
    assert.equal(dump.indexOf(material), -1);
    const backupFile = privateFile(directory, 'qinglong.backup', dump);
    const backupDigest = sha256(dump);

    docker(['rm', '--force', '--volumes', sourceContainer]);
    sourceStarted = false;
    assert.notEqual(
      docker(['inspect', sourceContainer], { allowFailure: true }).status,
      0,
    );

    const restore = startPostgres(restoreContainer, password);
    restoreStarted = true;
    assert.notEqual(restore.id, source.id);
    bootstrapDatabaseRoles(restoreContainer, ql3Roles);
    docker(
      [
        'exec',
        '--interactive',
        restoreContainer,
        'pg_restore',
        '--username',
        'postgres',
        '--dbname',
        DATABASE,
        '--exit-on-error',
        '--no-owner',
        '--no-acl',
      ],
      { input: readFileSync(backupFile), binary: true },
    );
    restoreDatabase = await databaseOpener(
      password,
      restore.port,
      'ql3-prompt-output-recovery-restored',
    )();
    const restoredEvidence = await readProductionEvidence(
      restoreDatabase.pool,
      artifact.artifactId,
      rotationId,
    );
    const restoredRowDigest = sha256(JSON.stringify(restoredEvidence));
    assert.equal(restoredRowDigest, sourceRowDigest);
    assert.deepEqual(restoredEvidence.durableKeyFact, durableKeyFact);
    assert.deepEqual(restoredEvidence.artifact, artifact);

    const now = Date.now();
    const authorization =
      createPluginPackagePromptOutputExternalRecoveryAuthorization(
        {
          recoveryId: `postgres-backup-recovery-${suffix}`,
          requestId: `postgres-backup-request-${suffix}`,
          custodyId: receipt.custodyId,
          custodyReceiptDigest: receipt.receiptDigest,
          keyId,
          artifactId: restoredEvidence.artifact.artifactId,
          artifactDigest: restoredEvidence.artifact.artifactDigest,
          policyDigest: sha256('ql3-postgres-backup-recovery-policy'),
          requestedBy: {
            userId: 'postgres-backup-requester',
            authenticationId: `postgres-backup-requester-auth-${suffix}`,
            authenticatedAtMs: now - 4_000,
          },
          requestedAtMs: now - 3_000,
          expiresAtMs: now + 10 * 60_000,
        },
        [
          approvalSigner(
            'postgres-backup-reviewer-a',
            `postgres-backup-reviewer-a-auth-${suffix}`,
            approverAKeys,
            now - 2_000,
          ),
          approvalSigner(
            'postgres-backup-reviewer-b',
            `postgres-backup-reviewer-b-auth-${suffix}`,
            approverBKeys,
            now - 1_000,
          ),
        ],
      );

    const bundleFile = privateFile(
      directory,
      'custody-bundle.json',
      JSON.stringify(bundle),
    );
    const recoveredMaterialFile = privateFile(
      directory,
      'recovered-material.bin',
      material,
    );
    const durableKeyFactFile = privateFile(
      directory,
      'durable-key-fact.json',
      JSON.stringify(restoredEvidence.durableKeyFact),
    );
    const artifactFile = privateFile(
      directory,
      'artifact.json',
      JSON.stringify(restoredEvidence.artifact),
    );
    const authorizationFile = privateFile(
      directory,
      'authorization.json',
      JSON.stringify(authorization),
    );
    const custodyPublicKeyFile = privateFile(
      directory,
      'custody-public.pem',
      custodyKeys.publicKey.export({ format: 'pem', type: 'spki' }),
    );
    const approverAFile = privateFile(
      directory,
      'approver-a-public.pem',
      approverAKeys.publicKey.export({ format: 'pem', type: 'spki' }),
    );
    const approverBFile = privateFile(
      directory,
      'approver-b-public.pem',
      approverBKeys.publicKey.export({ format: 'pem', type: 'spki' }),
    );
    const commandFile = privateFile(
      directory,
      'recovery-command.json',
      JSON.stringify({
        schemaVersion: 1,
        operation: 'cluster.prompt-output-key.verify-recovery',
        authorizationFile,
        custodyBundleFile: bundleFile,
        recoveredMaterialFile,
        durableKeyFactFile,
        artifactFile,
        custodyPublicKeyFile,
        approverPublicKeyFiles: [
          { userId: 'postgres-backup-reviewer-a', filePath: approverAFile },
          { userId: 'postgres-backup-reviewer-b', filePath: approverBFile },
        ],
      }),
      0o444,
    );
    const command = readClusterPromptOutputExternalRecoveryCommand(commandFile);
    const input = readClusterPromptOutputExternalRecoveryInput(command);
    let proof;
    try {
      proof = runClusterPromptOutputExternalRecoveryVerifier(
        input,
        now + 3_000,
      );
    } finally {
      disposeClusterPromptOutputExternalRecoveryInput(input);
    }
    assert.equal(
      proof.artifactDigest,
      restoredEvidence.artifact.artifactDigest,
    );

    const image = JSON.parse(docker(['image', 'inspect', IMAGE]).stdout)[0];
    const report = {
      schemaVersion: 1,
      fixture: 'qinglong/postgresql-prompt-output-backup-recovery-live@v1',
      postgres: {
        image: IMAGE,
        imageId: image.Id,
        architecture: image.Architecture,
        backupFormat: 'pg_dump-custom',
        backupDigest,
        backupBytes: statSync(backupFile).size,
        sourceContainerRemovedBeforeRestore: true,
        sourceAndRestoreContainerIdsDiffer: source.id !== restore.id,
        loopbackOnlyPublishedPorts: true,
      },
      restoredEvidence: {
        rowDigest: restoredRowDigest,
        keyId,
        materialProof,
        catalogDigest: sourceCatalogDigest,
        artifactId: restoredEvidence.artifact.artifactId,
        artifactDigest: restoredEvidence.artifact.artifactDigest,
        productionSchemaLineage: restoredEvidence.lineage,
      },
      recovery: {
        authorizationDigest: proof.authorizationDigest,
        proofDigest: proof.proofDigest,
        artifactDigest: proof.artifactDigest,
        contentDigest: restoredEvidence.artifact.contentDigest,
        outputBytes: restoredEvidence.artifact.outputBytes,
      },
      gates: {
        digestPinnedPostgresImage: true,
        databaseEndpointsAreLoopbackOnly: true,
        customFormatBackupCreated: true,
        backupContainsNoPlaintextOrRawKey: true,
        sourceContainerRemovedBeforeRestore: true,
        isolatedRestoreUsesDistinctContainerAndVolume: true,
        restoredRowDigestMatchesSource: true,
        productionMigrationHistoryRestoredExactly: true,
        productionPromptAdmissionStartCompletionAndFinalizationRestored: true,
        productionRotationAndArtifactRepositoriesReopened: true,
        exactDurableKeyFactRestored: true,
        exactEncryptedArtifactRestored: true,
        twoUserAuthorizationVerified: true,
        officialArtifactOpenVerified: true,
        reportIsContentFree: true,
        passed: true,
      },
      limitations: [
        'pg_dump custom-format recovery is logical PostgreSQL backup evidence, not CloudNativePG Barman WAL/PITR evidence',
        'the canonical Prompt admission seed bypasses the package publication snapshot check; execution, finalization, Artifact and key-rotation persistence use production repositories',
        'the disposable source and restored repository composition uses the postgres owner Pool; separate HA and readiness gates prove least-privilege role activation',
        'restore bootstraps referenced ql3_* role names and uses --no-acl, so this gate does not prove restored role attributes or grants',
        'custody wrapping and dual User identities are local composition fixtures; the separate Vault live gate proves real Transit wrap/unwrap',
      ],
    };
    const serialized = JSON.stringify(report);
    for (const forbidden of [
      PLAINTEXT,
      material.toString('base64'),
      material.toString('base64url'),
      wrappedMaterial.toString('base64url'),
      receipt.signature,
      password,
      directory,
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    material.fill(0);
    wrappedMaterial.fill(0);
    if (sourceDatabase) {
      await sourceDatabase.close().catch(() => {});
    }
    if (restoreDatabase) {
      await restoreDatabase.close().catch(() => {});
    }
    if (sourceStarted) {
      docker(['rm', '--force', '--volumes', sourceContainer], {
        allowFailure: true,
      });
    }
    if (restoreStarted) {
      docker(['rm', '--force', '--volumes', restoreContainer], {
        allowFailure: true,
      });
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `ql3 PostgreSQL prompt-output backup recovery live contract failed: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = { IMAGE };
