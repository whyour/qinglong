const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const {
  createPostgresDatabaseOpener,
  PostgresClusterDispatchSource,
  PostgresClusterScheduleRepository,
  PostgresClusterRunCancellationConvergenceRepository,
  PostgresClusterRunCancellationRepository,
  PostgresRemoteRunActivationRepository,
  PostgresRunDispatchLeaseRepository,
  PostgresTaskExecutionRevisionSource,
  PostgresWorkerSessionRepository: RuntimePostgresWorkerSessionRepository,
} = require('@qinglong/cluster-postgres/runtime');
const {
  PostgresTaskDefinitionRepository,
  PostgresTriggerRepository,
} = require('@qinglong/cluster-postgres/admin');
const {
  assertPostgresWorkerIngressSchemaReady,
  PostgresSecurityAuditRepository,
  PostgresWorkerCredentialRepository,
  PostgresWorkerExecutionAttestationRepository,
  PostgresWorkerSessionRepository,
} = require('@qinglong/cluster-postgres/worker-ingress');
const {
  postgresqlControlSchemaContract,
  runPostgresMigrations,
} = require('@qinglong/cluster-postgres/migration');
const {
  workerCredentialSecretDigest,
} = require('@qinglong/runtime-core/worker-credential-token');
const {
  canonicalRemoteWorkerCapabilities,
} = require('@qinglong/runtime-core/remote-dispatch');
const {
  WORKER_SESSION_REGISTER_SCHEMA,
} = require('@qinglong/runtime-core/worker-session-transport');
const {
  RemoteRunActivationFenceRejectedError,
} = require('@qinglong/runtime-core/remote-activation');
const {
  ClusterRunCancellationFenceRejectedError,
} = require('@qinglong/runtime-core/cluster-run-cancellation');
const { bootstrapClusterControlRuntime } = require('@qinglong/cluster-control');
const {
  startProductionClusterControlApplication,
} = require('../dist/application-runtime/productionApplication');
const { ClusterSchedulerCoordinator } = require('../dist/scheduling/scheduler');
const {
  ClusterRemoteWorkerOfferClaimService,
} = require('../dist/remote-execution/remoteWorkerDispatcher');
const {
  ClusterRemoteRunActivationService,
} = require('../dist/remote-execution/remoteRunActivationService');
const {
  createWorkerCredentialAuthenticator,
  createWorkerIngressAdmissionPipeline,
  startClusterWorkerIngressApplication,
} = require('../dist/worker-ingress/workerIngressApplication');

const migrationConnectionString =
  process.env.QL3_TEST_POSTGRES_MIGRATION_URL ??
  process.env.QL3_TEST_POSTGRES_URL;
const runtimeConnectionString = process.env.QL3_TEST_POSTGRES_RUNTIME_URL;
const faultInjectionConnectionString =
  process.env.QL3_TEST_POSTGRES_FAULT_INJECTION_URL ??
  migrationConnectionString;
const workerIngressConnectionString =
  process.env.QL3_TEST_POSTGRES_WORKER_INGRESS_URL;
const mtlsFixtures = path.join(__dirname, 'fixtures', 'mtls');

function nextMinute(schedule, afterMs) {
  if (schedule.expression !== '* * * * *' || schedule.timezone !== 'UTC') {
    throw new Error('unsupported test schedule');
  }
  // This fixture tests replica claims, not calendar cron evaluation. A relative
  // minute keeps initialization in the future even when setup crosses :00;
  // the admission phase explicitly makes next_fire_at_ms due in PostgreSQL.
  return afterMs + 60_000;
}

test('replica fixture initializes independently of wall-clock minute boundaries', () => {
  const {
    resolveLocalScheduleDecision,
  } = require('@qinglong/runtime-core/local-scheduler');
  for (const offset of [0, 1, 999, 1_000, 59_999]) {
    const observedAtMs = 120_000 + offset;
    const candidate = {
      projectId: 'default',
      triggerId: 'trigger-multi-replica',
      triggerRevision: 1,
      triggerContentDigest: 'a'.repeat(64),
      triggerUpdatedAtMs: observedAtMs - 999,
      taskId: 'task-multi-replica',
      taskRevision: 1,
      taskContentDigest: 'b'.repeat(64),
      expression: '* * * * *',
      timezone: 'UTC',
      misfirePolicy: 'skip',
      stateVersion: 0,
      nextFireAtMs: null,
    };
    assert.equal(
      resolveLocalScheduleDecision(candidate, observedAtMs, 5_000, nextMinute)
        .disposition,
      'initialize',
      `minute offset ${offset}`,
    );
    assert.equal(
      resolveLocalScheduleDecision(
        { ...candidate, nextFireAtMs: observedAtMs },
        observedAtMs,
        5_000,
        nextMinute,
      ).disposition,
      'admit',
    );
  }
});

function workerRequest(address, requestPath, token, body) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: '127.0.0.1',
        servername: 'localhost',
        port: address.port,
        path: requestPath,
        method: 'POST',
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        ca: readFileSync(path.join(mtlsFixtures, 'ca-cert.pem')),
        key: readFileSync(path.join(mtlsFixtures, 'client-key.pem')),
        cert: readFileSync(path.join(mtlsFixtures, 'client-cert.pem')),
        headers: {
          authorization: `Worker ${token}`,
          'content-type': 'application/json',
          'content-length': String(payload.byteLength),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode,
            body: text.length === 0 ? null : JSON.parse(text),
          });
        });
      },
    );
    request.once('error', reject);
    request.end(payload);
  });
}

function probeRequest(address, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path: requestPath,
        method: 'GET',
        headers: { connection: 'close' },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      },
    );
    request.once('error', reject);
    request.end();
  });
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for integration state');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

if (!migrationConnectionString || !runtimeConnectionString) {
  test(
    'cluster-control PostgreSQL integration requires migration and runtime URLs',
    {
      skip: true,
    },
  );
} else {
  function opener(role, connectionString) {
    return createPostgresDatabaseOpener({
      role,
      connection: {
        connectionString,
        tls: { mode: 'disable' },
      },
      pool: {
        maxConnections: role === 'migration' ? 1 : 4,
        applicationName: `ql3-cluster-bootstrap-${role}`,
      },
      onPoolError(error) {
        throw error;
      },
    });
  }

  test('runtime role atomically persists a policy-fenced user cancellation', async () => {
    const openMigration = opener('migration', migrationConnectionString);
    const openRuntime = opener('runtime', runtimeConnectionString);
    const migration = await openMigration();
    const runtime = await openRuntime();
    try {
      await runPostgresMigrations({ pool: migration.pool });
      await migration.pool.query(
        'TRUNCATE TABLE "ql3"."run_events", "ql3"."run_attempts", "ql3"."runs", "ql3"."project_role_bindings", "ql3"."projects" CASCADE',
      );
      await migration.pool.query(`
        INSERT INTO "ql3"."projects" (
          id, name, slug, status, version, created_at_ms, updated_at_ms
        ) VALUES ('cancel-project', 'Cancel Project', 'cancel-project',
          'active', 2, 1, 2)
      `);
      await migration.pool.query(`
        INSERT INTO "ql3"."project_role_bindings" (
          project_id, subject_type, subject_id, version, state, role,
          mutation_id, changed_by_type, changed_by_id, created_at_ms
        ) VALUES ('cancel-project', 'user', 'cancel-user', 3, 'active',
          'operator', 'cancel-binding-3', 'user', 'owner-user', 3)
      `);
      await migration.pool.query(`
        INSERT INTO "ql3"."runs" (
          id, project_id, task_id, task_revision, trigger_type,
          execution_origin, execution_owner, status, created_at_ms,
          version, event_sequence
        ) VALUES ('cancel-run', 'cancel-project', 'task', 'v1', 'manual',
          'manual', 'runtime', 'running', 4, 1, 0)
      `);

      const repository = new PostgresClusterRunCancellationRepository(
        runtime.pool,
      );
      const command = {
        projectId: 'cancel-project',
        runId: 'cancel-run',
        mutationId: 'cancel-mutation-1',
        eventId: '018f0000-0000-7000-8000-000000000001',
        subject: { type: 'user', id: 'cancel-user' },
        policyFence: { projectVersion: 2, bindingVersion: 3 },
      };
      const accepted = await repository.requestUserCancellation(command);
      assert.equal(accepted.status, 'accepted');
      assert.equal(accepted.runVersion, 2);
      assert.equal(accepted.eventSequence, 1);
      assert.equal(accepted.cancelReason, 'user');
      assert.ok(accepted.cancelRequestedAtMs > 0);
      assert.equal(
        (await repository.requestUserCancellation(command)).status,
        'already_requested',
      );
      const events = await migration.pool.query(`
        SELECT type, actor_type AS "actorType", actor_id AS "actorId",
               payload
        FROM "ql3"."run_events" WHERE run_id = 'cancel-run'
      `);
      assert.deepEqual(events.rows, [
        {
          type: 'run.cancel_requested',
          actorType: 'user',
          actorId: 'cancel-user',
          payload: {
            reason: 'user',
            mutation_id: 'cancel-mutation-1',
            policy_fence: { project_version: 2, binding_version: 3 },
          },
        },
      ]);

      await migration.pool.query(`
        INSERT INTO "ql3"."runs" (
          id, project_id, task_id, task_revision, trigger_type,
          execution_origin, execution_owner, status, created_at_ms,
          queued_at_ms, version, event_sequence
        ) VALUES ('cancel-run-queued', 'cancel-project', 'task', 'v1', 'manual',
          'manual', 'runtime', 'queued', 6, 6, 1, 0)
      `);
      await migration.pool.query(`
        INSERT INTO "ql3"."run_attempts" (
          id, run_id, attempt, status, executor_type,
          callback_sequence, created_at_ms
        ) VALUES ('cancel-attempt-queued', 'cancel-run-queued', 1, 'claimed',
          'remote_worker', 0, 6)
      `);
      const queued = await repository.requestUserCancellation({
        ...command,
        runId: 'cancel-run-queued',
        mutationId: 'cancel-mutation-queued',
        eventId: '018f0000-0000-7000-8000-000000000002',
      });
      assert.equal(queued.status, 'accepted');
      const converged =
        await new PostgresClusterRunCancellationConvergenceRepository(
          runtime.pool,
        ).convergePage({ limit: 4 });
      assert.deepEqual(converged, {
        scanned: 1,
        settledRuns: 1,
        settledAttempts: 1,
        blocked: 0,
        hasMore: false,
      });
      const terminal = await migration.pool.query(`
        SELECT run.status AS "runStatus", run.version AS "runVersion",
               run.event_sequence AS "eventSequence",
               attempt.status AS "attemptStatus"
        FROM "ql3"."runs" AS run
        JOIN "ql3"."run_attempts" AS attempt ON attempt.run_id = run.id
        WHERE run.id = 'cancel-run-queued'
      `);
      assert.deepEqual(terminal.rows, [
        {
          runStatus: 'cancelled',
          runVersion: 4,
          eventSequence: 3,
          attemptStatus: 'cancelled',
        },
      ]);
      const terminalEvents = await migration.pool.query(`
        SELECT type, actor_type AS "actorType", actor_id AS "actorId"
        FROM "ql3"."run_events" WHERE run_id = 'cancel-run-queued'
        ORDER BY sequence
      `);
      assert.deepEqual(terminalEvents.rows, [
        {
          type: 'run.cancel_requested',
          actorType: 'user',
          actorId: 'cancel-user',
        },
        {
          type: 'attempt.cancelled',
          actorType: 'reconciler',
          actorId: 'runtime:cancellation',
        },
        {
          type: 'run.cancelled',
          actorType: 'reconciler',
          actorId: 'runtime:cancellation',
        },
      ]);

      await migration.pool.query(`
        INSERT INTO "ql3"."project_role_bindings" (
          project_id, subject_type, subject_id, version, state, role,
          mutation_id, changed_by_type, changed_by_id, created_at_ms
        ) VALUES ('cancel-project', 'user', 'cancel-user', 4, 'revoked',
          NULL, 'cancel-binding-4', 'user', 'owner-user', 5)
      `);
      await assert.rejects(
        repository.requestUserCancellation(command),
        (error) =>
          error instanceof ClusterRunCancellationFenceRejectedError &&
          error.reason === 'authorization_changed',
      );
    } finally {
      await runtime.close();
      await migration.close();
    }
  });

  test('bootstrap owns bounded recovery and atomically loses an unstarted aggregate before admission', async () => {
    const openMigration = opener('migration', migrationConnectionString);
    const openRuntime = opener('runtime', runtimeConnectionString);
    const migration = await openMigration();
    let activation;
    try {
      await runPostgresMigrations({ pool: migration.pool });
      await migration.pool.query(
        'TRUNCATE TABLE "ql3"."run_recovery_controls", "ql3"."run_events", "ql3"."run_retry_policies", "ql3"."run_attempts", "ql3"."runs" CASCADE',
      );
      await migration.pool.query(
        `INSERT INTO "ql3"."runs" (
           id, project_id, task_id, task_revision, trigger_type,
           execution_origin, execution_owner, status,
           created_at_ms, version, event_sequence
         ) VALUES (
           'run-bootstrap-recovery', 'default', 'task', 'v1', 'manual',
           'manual', 'runtime', 'dispatching', 1, 0, 0
         )`,
      );
      await migration.pool.query(
        `INSERT INTO "ql3"."run_attempts" (
           id, run_id, attempt, status, executor_type,
           lease_token, lease_expires_at_ms, callback_sequence, created_at_ms
         ) VALUES (
           'attempt-bootstrap-recovery', 'run-bootstrap-recovery', 1,
           'claimed', 'remote_worker', 'expired-lease-token', 2, 1, 2
         )`,
      );

      let applicationReconcileCalls = 0;
      activation = await bootstrapClusterControlRuntime({
        enabled: true,
        profile: 'cluster-control',
        apiCredentialPepper: 'A'.repeat(43),
        recovery: {
          ownerId: 'integration-replica',
          providers: [],
          claimLimit: 4,
          maxStartupPasses: 2,
        },
        openDatabase: openRuntime,
        create() {
          return {
            async reconcile() {
              applicationReconcileCalls += 1;
              return { safe: true, remaining: 0, failed: 0 };
            },
            async startLifecycles() {
              return true;
            },
            installAdmission() {
              return () => {};
            },
            async stop() {
              return 'stopped';
            },
          };
        },
        audit() {},
      });

      assert.equal(activation.status, 'active');
      assert.equal(applicationReconcileCalls, 1);
      assert.deepEqual(activation.recovery, {
        safe: true,
        remaining: 0,
        failed: 0,
      });

      const run = await migration.pool.query(
        `SELECT status, error_code AS "errorCode", version, event_sequence AS "eventSequence"
         FROM "ql3"."runs" WHERE id = 'run-bootstrap-recovery'`,
      );
      const attempt = await migration.pool.query(
        `SELECT status, error_code AS "errorCode", lease_token AS "leaseToken"
         FROM "ql3"."run_attempts" WHERE id = 'attempt-bootstrap-recovery'`,
      );
      const events = await migration.pool.query(
        `SELECT type FROM "ql3"."run_events"
         WHERE run_id = 'run-bootstrap-recovery' ORDER BY sequence`,
      );
      assert.deepEqual(run.rows, [
        {
          status: 'lost',
          errorCode: 'CLUSTER_RECOVERY_UNSTARTED_CLAIM_EXPIRED',
          version: 2,
          eventSequence: 2,
        },
      ]);
      assert.deepEqual(attempt.rows, [
        {
          status: 'lost',
          errorCode: 'CLUSTER_RECOVERY_UNSTARTED_CLAIM_EXPIRED',
          leaseToken: 'expired-lease-token',
        },
      ]);
      assert.deepEqual(events.rows, [
        { type: 'attempt.lost' },
        { type: 'run.lost' },
      ]);
    } finally {
      await activation?.stop();
      await migration.pool.query(
        'TRUNCATE TABLE "ql3"."run_recovery_controls", "ql3"."run_events", "ql3"."run_retry_policies", "ql3"."run_attempts", "ql3"."runs" CASCADE',
      );
      await migration.close();
    }
  });

  test('runtime role pulls one placed offer and reconstructs a lost response from its digest-only lease', async () => {
    const openMigration = opener('migration', migrationConnectionString);
    const openRuntime = opener('runtime', runtimeConnectionString);
    const migration = await openMigration();
    const runtime = await openRuntime();
    const sessionId = '018f0000-0000-7000-8000-000000000031';
    const leaseToken = 'worker_generated_lease_capability_0000000000000001';
    try {
      await runPostgresMigrations({ pool: migration.pool });
      await migration.pool.query(
        'TRUNCATE TABLE "ql3"."run_dispatch_leases", "ql3"."run_events", "ql3"."run_attempts", "ql3"."runs", "ql3"."worker_sessions", "ql3"."task_execution_revisions", "ql3"."task_definition_revisions", "ql3"."task_definitions", "ql3"."project_role_bindings", "ql3"."projects" CASCADE',
      );
      await migration.pool.query(
        `INSERT INTO "ql3"."projects" (
           id, name, slug, status, version, created_at_ms, updated_at_ms
         ) VALUES ('default', 'Default', 'default', 'active', 1, 1, 1)`,
      );
      const definition = await new PostgresTaskDefinitionRepository(
        migration.pool,
      ).appendTaskDefinitionRevision({
        projectId: 'default',
        taskId: 'task-pull-offer',
        expectedRevision: null,
        mutationId: '019f7700-0000-7000-8000-000000000031',
        name: 'Pull offer integration',
        kind: 'command',
        spec: {
          schema: 'qinglong/command@v1',
          config: {
            command: { kind: 'argv', file: '/bin/echo', args: ['placed'] },
            placement: {
              required: {
                architectures: ['arm64'],
                labels: { region: 'cn-east' },
                minMemoryBytes: 268435456,
              },
            },
          },
        },
        labels: {},
        enabled: true,
        occurredAtMs: 10,
      });
      assert.equal(definition.status, 'created');
      await migration.pool.query(
        `INSERT INTO "ql3"."runs" (
           id, project_id, task_id, task_revision, trigger_type,
           execution_origin, execution_owner, status, priority,
           created_at_ms, queued_at_ms, version, event_sequence
         ) VALUES
           (
             'run-pull-offer', 'default', 'task-pull-offer', $1, 'manual',
             'manual', 'runtime', 'queued', 5, 20, 20, 0, 0
           ),
           (
             'run-pull-start-failure', 'default', 'task-pull-offer', $1, 'manual',
             'manual', 'runtime', 'queued', 4, 21, 21, 0, 0
           )`,
        [
          `qltd:v1:${definition.definition.revision}:${definition.definition.contentDigest}`,
        ],
      );
      await migration.pool.query(
        `INSERT INTO "ql3"."run_attempts" (
           id, run_id, attempt, status, executor_type,
           callback_sequence, created_at_ms
         ) VALUES
           (
             'attempt-pull-offer', 'run-pull-offer', 1, 'claimed',
             'remote_worker', 0, 20
           ),
           (
             'attempt-pull-start-failure', 'run-pull-start-failure', 1,
             'claimed', 'remote_worker', 0, 21
           )`,
      );
      const capabilities = canonicalRemoteWorkerCapabilities({
        architecture: 'arm64',
        executors: ['remote-worker'],
        protocolVersion: '1.0.0',
        supportTier: 'tier1',
        labels: { region: 'cn-east' },
        capacity: { memoryBytes: 536870912 },
      });
      await new RuntimePostgresWorkerSessionRepository(runtime.pool).register({
        workerId: 'worker-pull-offer',
        sessionId,
        capabilitiesJson: capabilities.json,
        capabilitiesHash: capabilities.hash,
        maxConcurrentRuns: 2,
        availableSlots: 2,
        leaseDurationMs: 60_000,
      });
      const leases = new PostgresRunDispatchLeaseRepository(runtime.pool);
      const service = new ClusterRemoteWorkerOfferClaimService(
        new PostgresClusterDispatchSource(runtime.pool),
        new RuntimePostgresWorkerSessionRepository(runtime.pool),
        new PostgresTaskExecutionRevisionSource(runtime.pool),
        leases,
        { createEventId: () => '019f7700-0000-7000-8000-000000000032' },
      );
      const request = {
        workerSessionId: sessionId,
        workerGeneration: 1,
        offerId: 'offer-pull-integration',
        leaseToken,
      };
      const first = await service.claimNext(
        { workerId: 'worker-pull-offer' },
        request,
      );
      assert.equal(first.status, 'offered');
      assert.equal(first.offer.deliveryKind, 'new_claim');
      assert.equal(first.offer.placementScore, 0);
      const replay = await service.claimNext(
        { workerId: 'worker-pull-offer' },
        request,
      );
      assert.equal(replay.status, 'offered');
      assert.equal(replay.offer.deliveryKind, 'lease_recovery');
      assert.equal(replay.offer.executionDigest, first.offer.executionDigest);
      const activation = new ClusterRemoteRunActivationService(
        new PostgresRemoteRunActivationRepository(runtime.pool),
      );
      const renewed = await leases.renew({
        attemptId: first.offer.candidate.attemptId,
        workerId: 'worker-pull-offer',
        workerSessionId: sessionId,
        workerGeneration: 1,
        leaseGeneration: first.offer.lease.leaseGeneration,
        leaseToken,
        expectedVersion: first.offer.lease.version,
        leaseDurationMs: 60_000,
      });
      await assert.rejects(
        activation.acknowledgeStarting(
          { workerId: 'worker-pull-offer' },
          {
            runId: first.offer.candidate.runId,
            attemptId: first.offer.candidate.attemptId,
            workerSessionId: sessionId,
            workerGeneration: 1,
            offerId: request.offerId,
            leaseGeneration: first.offer.lease.leaseGeneration,
            leaseToken,
            expectedLeaseVersion: first.offer.lease.version,
          },
        ),
        (error) =>
          error instanceof RemoteRunActivationFenceRejectedError &&
          error.reason === 'version_mismatch',
      );
      const activationFence = {
        runId: first.offer.candidate.runId,
        attemptId: first.offer.candidate.attemptId,
        workerSessionId: sessionId,
        workerGeneration: 1,
        offerId: request.offerId,
        leaseGeneration: first.offer.lease.leaseGeneration,
        leaseToken,
        expectedLeaseVersion: renewed.version,
      };
      assert.equal(
        (
          await activation.acknowledgeStarting(
            { workerId: 'worker-pull-offer' },
            activationFence,
          )
        ).status,
        'applied',
      );
      assert.equal(
        (
          await activation.acknowledgeStarting(
            { workerId: 'worker-pull-offer' },
            activationFence,
          )
        ).status,
        'already_starting',
      );
      const runningCommand = {
        ...activationFence,
        executorHandle: 'remote:integration-handle-1',
        logArtifactId: 'log-pull-offer',
        callbackSequence: 1,
        callbackTokenDigest: 'b'.repeat(64),
      };
      assert.equal(
        (
          await activation.acknowledgeRunning(
            { workerId: 'worker-pull-offer' },
            runningCommand,
          )
        ).status,
        'applied',
      );
      assert.equal(
        (
          await activation.acknowledgeRunning(
            { workerId: 'worker-pull-offer' },
            runningCommand,
          )
        ).status,
        'already_running',
      );
      await assert.rejects(
        activation.acknowledgeRunning(
          { workerId: 'worker-pull-offer' },
          { ...runningCommand, executorHandle: 'remote:conflicting-handle' },
        ),
        (error) =>
          error instanceof RemoteRunActivationFenceRejectedError &&
          error.reason === 'replay_mismatch',
      );
      const failedLeaseToken =
        'worker_generated_lease_capability_0000000000000002';
      const failedClaim = await leases.claim({
        runId: 'run-pull-start-failure',
        attemptId: 'attempt-pull-start-failure',
        workerId: 'worker-pull-offer',
        workerSessionId: sessionId,
        workerGeneration: 1,
        leaseToken: failedLeaseToken,
        leaseDurationMs: 60_000,
        eventId: '019f7700-0000-7000-8000-000000000033',
        offerId: 'offer-pull-start-failure',
      });
      assert.equal(failedClaim.status, 'claimed');
      const failedFence = {
        runId: 'run-pull-start-failure',
        attemptId: 'attempt-pull-start-failure',
        workerSessionId: sessionId,
        workerGeneration: 1,
        offerId: 'offer-pull-start-failure',
        leaseGeneration: failedClaim.lease.leaseGeneration,
        leaseToken: failedLeaseToken,
        expectedLeaseVersion: failedClaim.lease.version,
      };
      await activation.acknowledgeStarting(
        { workerId: 'worker-pull-offer' },
        failedFence,
      );
      assert.equal(
        (
          await activation.failStart(
            { workerId: 'worker-pull-offer' },
            failedFence,
          )
        ).status,
        'applied',
      );
      assert.equal(
        (
          await activation.failStart(
            { workerId: 'worker-pull-offer' },
            failedFence,
          )
        ).status,
        'already_terminal',
      );
      await migration.pool.query(
        `INSERT INTO "ql3"."runs" (
           id, project_id, task_id, task_revision, trigger_type,
           execution_origin, execution_owner, status, priority,
           created_at_ms, queued_at_ms, version, event_sequence
         ) VALUES (
           'run-pull-start-timeout', 'default', 'task-pull-offer', $1,
           'manual', 'manual', 'runtime', 'queued', 3, 22, 22, 0, 0
         )`,
        [
          `qltd:v1:${definition.definition.revision}:${definition.definition.contentDigest}`,
        ],
      );
      await migration.pool.query(
        `INSERT INTO "ql3"."run_attempts" (
           id, run_id, attempt, status, executor_type,
           callback_sequence, created_at_ms
         ) VALUES (
           'attempt-pull-start-timeout', 'run-pull-start-timeout', 1,
           'claimed', 'remote_worker', 0, 22
         )`,
      );
      const timeoutLeaseToken =
        'worker_generated_lease_capability_0000000000000003';
      const timeoutClaim = await leases.claim({
        runId: 'run-pull-start-timeout',
        attemptId: 'attempt-pull-start-timeout',
        workerId: 'worker-pull-offer',
        workerSessionId: sessionId,
        workerGeneration: 1,
        leaseToken: timeoutLeaseToken,
        leaseDurationMs: 60_000,
        eventId: '019f7700-0000-7000-8000-000000000034',
        offerId: 'offer-pull-start-timeout',
      });
      assert.equal(timeoutClaim.status, 'claimed');
      const timeoutFence = {
        runId: 'run-pull-start-timeout',
        attemptId: 'attempt-pull-start-timeout',
        workerSessionId: sessionId,
        workerGeneration: 1,
        offerId: 'offer-pull-start-timeout',
        leaseGeneration: timeoutClaim.lease.leaseGeneration,
        leaseToken: timeoutLeaseToken,
        expectedLeaseVersion: timeoutClaim.lease.version,
      };
      await activation.acknowledgeStarting(
        { workerId: 'worker-pull-offer' },
        timeoutFence,
      );
      await migration.pool.query(
        `UPDATE "ql3"."runs"
         SET cancel_requested_at_ms = 23, cancel_reason = 'timeout'
         WHERE id = 'run-pull-start-timeout'`,
      );
      const timedOut = await activation.failStart(
        { workerId: 'worker-pull-offer' },
        timeoutFence,
      );
      assert.equal(timedOut.status, 'applied');
      assert.equal(timedOut.snapshot.runStatus, 'timed_out');
      assert.equal(timedOut.snapshot.errorCode, 'EXECUTION_TIMED_OUT');
      const facts = await migration.pool.query(
        `SELECT run.id AS "runId", run.status AS "runStatus",
                attempt.status AS "attemptStatus",
                lease.status AS "leaseStatus", lease.offer_id AS "offerId",
                lease.lease_token_digest AS "leaseTokenDigest",
                attempt.callback_sequence AS "callbackSequence",
                attempt.callback_token_hash AS "callbackTokenDigest",
                count(event.id)::integer AS "events"
         FROM "ql3"."runs" AS run
         JOIN "ql3"."run_attempts" AS attempt ON attempt.run_id = run.id
         JOIN "ql3"."run_dispatch_leases" AS lease ON lease.attempt_id = attempt.id
         LEFT JOIN "ql3"."run_events" AS event ON event.run_id = run.id
         WHERE run.id IN (
           'run-pull-offer', 'run-pull-start-failure', 'run-pull-start-timeout'
         )
         GROUP BY run.id, run.status, attempt.status, lease.status,
                  lease.offer_id, lease.lease_token_digest,
                  attempt.callback_sequence, attempt.callback_token_hash
         ORDER BY run.id`,
      );
      assert.deepEqual(facts.rows, [
        {
          runId: 'run-pull-offer',
          runStatus: 'running',
          attemptStatus: 'running',
          leaseStatus: 'leased',
          offerId: 'offer-pull-integration',
          leaseTokenDigest: require('node:crypto')
            .createHash('sha256')
            .update(leaseToken)
            .digest('hex'),
          callbackSequence: 1,
          callbackTokenDigest: 'b'.repeat(64),
          events: 4,
        },
        {
          runId: 'run-pull-start-failure',
          runStatus: 'failed',
          attemptStatus: 'failed',
          leaseStatus: 'completed',
          offerId: 'offer-pull-start-failure',
          leaseTokenDigest: require('node:crypto')
            .createHash('sha256')
            .update(failedLeaseToken)
            .digest('hex'),
          callbackSequence: 1,
          callbackTokenDigest: null,
          events: 4,
        },
        {
          runId: 'run-pull-start-timeout',
          runStatus: 'timed_out',
          attemptStatus: 'timed_out',
          leaseStatus: 'completed',
          offerId: 'offer-pull-start-timeout',
          leaseTokenDigest: require('node:crypto')
            .createHash('sha256')
            .update(timeoutLeaseToken)
            .digest('hex'),
          callbackSequence: 1,
          callbackTokenDigest: null,
          events: 4,
        },
      ]);
    } finally {
      await runtime.close();
      await migration.pool.query(
        'TRUNCATE TABLE "ql3"."run_dispatch_leases", "ql3"."run_events", "ql3"."run_attempts", "ql3"."runs", "ql3"."worker_sessions", "ql3"."task_execution_revisions", "ql3"."task_definition_revisions", "ql3"."task_definitions", "ql3"."project_role_bindings", "ql3"."projects" CASCADE',
      );
      await migration.close();
    }
  });

  test('two independent scheduler replicas admit once and take over an expired claim', async () => {
    const openMigration = opener('migration', migrationConnectionString);
    const openRuntime = opener('runtime', runtimeConnectionString);
    const migration = await openMigration();
    let runtimeA = await openRuntime();
    const runtimeB = await openRuntime();
    let idSequence = 100;
    const createId = () =>
      `019f7a00-0000-7000-8000-${String(idSequence++).padStart(12, '0')}`;
    try {
      await runPostgresMigrations({ pool: migration.pool });
      await migration.pool.query(
        'TRUNCATE TABLE "ql3"."run_events", "ql3"."run_attempts", "ql3"."runs", "ql3"."trigger_schedules", "ql3"."triggers", "ql3"."task_execution_revisions", "ql3"."task_definition_revisions", "ql3"."task_definitions" CASCADE',
      );
      const clock = await migration.pool.query(
        `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                    AS "observedAtMs"`,
      );
      const observedAtMs = Number(clock.rows[0].observedAtMs);
      await migration.pool.query(
        `INSERT INTO "ql3"."projects" (
             id, name, slug, status, version, created_at_ms, updated_at_ms
           ) VALUES ('default', 'Default', 'default', 'active', 1, $1, $1)
           ON CONFLICT (id) DO NOTHING`,
        [observedAtMs - 2_000],
      );
      const task = (
        await new PostgresTaskDefinitionRepository(
          migration.pool,
        ).appendTaskDefinitionRevision({
          projectId: 'default',
          taskId: 'task-multi-replica',
          expectedRevision: null,
          mutationId: '019f7a00-0000-7000-8000-000000000001',
          name: 'Multi-replica schedule',
          kind: 'command',
          spec: {
            schema: 'qinglong/command@v1',
            config: {
              command: {
                kind: 'argv',
                file: '/bin/echo',
                args: ['multi-replica'],
              },
            },
          },
          labels: {},
          enabled: true,
          occurredAtMs: observedAtMs - 1_000,
        })
      ).definition;
      const trigger = (
        await new PostgresTriggerRepository(
          migration.pool,
        ).appendTriggerRevision({
          projectId: 'default',
          triggerId: 'trigger-multi-replica',
          expectedRevision: null,
          mutationId: '019f7a00-0000-7000-8000-000000000002',
          taskId: task.taskId,
          taskRevision: task.revision,
          taskContentDigest: task.contentDigest,
          spec: {
            schema: 'qinglong/cron@v1',
            config: {
              expression: '* * * * *',
              timezone: 'UTC',
              misfirePolicy: 'skip',
            },
          },
          enabled: true,
          occurredAtMs: observedAtMs - 999,
        })
      ).trigger;

      const [backendA, backendB] = await Promise.all([
        runtimeA.pool.query('SELECT pg_backend_pid() AS pid'),
        runtimeB.pool.query('SELECT pg_backend_pid() AS pid'),
      ]);
      assert.notEqual(backendA.rows[0].pid, backendB.rows[0].pid);
      const storeA = new PostgresClusterScheduleRepository(runtimeA.pool);
      const storeB = new PostgresClusterScheduleRepository(runtimeB.pool);
      const schedulerA = new ClusterSchedulerCoordinator(storeA, {
        ownerId: 'cluster-control-replica-a',
        claimLeaseMs: 30_000,
        maxClaimsPerCycle: 1,
        misfireGraceMs: 5_000,
        nextOccurrence: nextMinute,
        createId,
      });
      const schedulerB = new ClusterSchedulerCoordinator(storeB, {
        ownerId: 'cluster-control-replica-b',
        claimLeaseMs: 30_000,
        maxClaimsPerCycle: 1,
        misfireGraceMs: 5_000,
        nextOccurrence: nextMinute,
        createId,
      });

      const initialized = await Promise.all([
        schedulerA.scheduleOnce(),
        schedulerB.scheduleOnce(),
      ]);
      assert.equal(
        initialized.reduce((total, summary) => total + summary.initialized, 0),
        1,
      );
      assert.equal(
        initialized.reduce((total, summary) => total + summary.claimed, 0),
        1,
      );

      const dueClock = await migration.pool.query(
        `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                    AS "observedAtMs"`,
      );
      const dueAtMs = Number(dueClock.rows[0].observedAtMs);
      await migration.pool.query(
        `UPDATE "ql3"."trigger_schedules"
              SET next_fire_at_ms = $1,
                  state_version = state_version + 1,
                  updated_at_ms = $1
            WHERE project_id = 'default' AND trigger_id = $2`,
        [dueAtMs, trigger.triggerId],
      );
      const admitted = await Promise.all([
        schedulerA.scheduleOnce(),
        schedulerB.scheduleOnce(),
      ]);
      assert.equal(
        admitted.reduce((total, summary) => total + summary.admitted, 0),
        1,
      );
      const occurrence = await migration.pool.query(
        `SELECT count(DISTINCT run.id)::integer AS runs,
                  count(event.id)::integer AS events
             FROM "ql3"."runs" AS run
             JOIN "ql3"."run_events" AS event ON event.run_id = run.id
            WHERE run.trigger_id = $1 AND run.scheduled_for_ms = $2`,
        [trigger.triggerId, dueAtMs],
      );
      assert.deepEqual(occurrence.rows, [{ runs: 1, events: 2 }]);

      const takeoverTrigger = (
        await new PostgresTriggerRepository(
          migration.pool,
        ).appendTriggerRevision({
          projectId: 'default',
          triggerId: 'trigger-replica-takeover',
          expectedRevision: null,
          mutationId: '019f7a00-0000-7000-8000-000000000003',
          taskId: task.taskId,
          taskRevision: task.revision,
          taskContentDigest: task.contentDigest,
          spec: trigger.spec,
          enabled: true,
          occurredAtMs: dueAtMs,
        })
      ).trigger;
      const abandoned = await storeA.claimNextClusterSchedule({
        ownerId: 'cluster-control-replica-a',
        claimToken: createId(),
        leaseMs: 30_000,
      });
      assert.equal(abandoned.triggerId, takeoverTrigger.triggerId);
      await runtimeA.close();
      runtimeA = undefined;
      await migration.pool.query(
        `WITH observation AS MATERIALIZED (
           SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                    AS observed_at_ms
         )
         UPDATE "ql3"."trigger_schedules"
              SET updated_at_ms = observation.observed_at_ms - 30002,
                  claim_expires_at_ms = observation.observed_at_ms - 30001
             FROM observation
            WHERE project_id = 'default' AND trigger_id = $1`,
        [takeoverTrigger.triggerId],
      );
      const takeover = await schedulerB.scheduleOnce();
      assert.equal(takeover.initialized, 1);
      const converged = await migration.pool.query(
        `SELECT claim_owner AS "claimOwner", claim_token AS "claimToken",
                  next_fire_at_ms AS "nextFireAtMs"
             FROM "ql3"."trigger_schedules"
            WHERE project_id = 'default' AND trigger_id = $1`,
        [takeoverTrigger.triggerId],
      );
      assert.equal(converged.rows[0].claimOwner, null);
      assert.equal(converged.rows[0].claimToken, null);
      assert.notEqual(converged.rows[0].nextFireAtMs, null);
    } finally {
      await runtimeA?.close();
      await runtimeB.close();
      await migration.close();
    }
  });

  test('terminating the active runtime backend withdraws admission without killing liveness', async () => {
    const openMigration = opener('migration', migrationConnectionString);
    const openFaultInjector = opener(
      'migration',
      faultInjectionConnectionString,
    );
    const migration = await openMigration();
    const faultInjector = await openFaultInjector();
    let application;
    let reactivatedApplication;
    try {
      await runPostgresMigrations({ pool: migration.pool });
      await migration.pool.query(
        'TRUNCATE TABLE "ql3"."run_recovery_controls", "ql3"."run_dispatch_leases", "ql3"."run_events", "ql3"."run_retry_policies", "ql3"."run_attempts", "ql3"."runs" CASCADE',
      );
      const productionOptions = {
        config: {
          enabled: true,
          profile: 'cluster-control',
          http: {
            host: '127.0.0.1',
            port: 0,
            drainTimeoutMs: 1_000,
          },
          database: {
            connection: {
              connectionString: runtimeConnectionString,
              tls: { mode: 'disable' },
            },
            pool: {
              maxConnections: 1,
              applicationName: 'ql3-cluster-availability-integration',
            },
          },
          security: {
            apiCredentialPepperKeyring: {
              schemaVersion: 1,
              activePepperKeyId: 'legacy-v1',
              keys: [
                {
                  pepperKeyId: 'legacy-v1',
                  pepper: 'A'.repeat(43),
                },
              ],
            },
          },
        },
        recovery: {
          ownerId: 'availability-integration-replica',
          providers: [],
        },
        audit() {},
      };
      application = await startProductionClusterControlApplication(
        productionOptions,
      );
      assert.equal(application.status, 'active');
      assert.deepEqual(await probeRequest(application.address, '/readyz'), {
        status: 200,
        body: { status: 'ready' },
      });

      const backend = await faultInjector.pool.query(
        `SELECT pid
           FROM pg_stat_activity
          WHERE application_name = 'ql3-cluster-availability-integration'
            AND usename = 'ql3_runtime'
          ORDER BY backend_start DESC
          LIMIT 1`,
      );
      assert.equal(backend.rowCount, 1);
      const terminatedBackendPid = backend.rows[0].pid;
      const terminated = await faultInjector.pool.query(
        'SELECT pg_terminate_backend($1) AS terminated',
        [terminatedBackendPid],
      );
      assert.equal(terminated.rows[0].terminated, true);

      await waitFor(() => application.availabilityStatus() === 'unavailable');
      assert.equal(application.availabilityStatus(), 'unavailable');
      assert.deepEqual(await probeRequest(application.address, '/readyz'), {
        status: 503,
        body: { status: 'not_ready' },
      });
      assert.deepEqual(await probeRequest(application.address, '/livez'), {
        status: 200,
        body: { status: 'live' },
      });

      await application.stop();
      application = undefined;
      reactivatedApplication = await startProductionClusterControlApplication(
        productionOptions,
      );
      assert.equal(reactivatedApplication.availabilityStatus(), 'ready');
      assert.deepEqual(
        await probeRequest(reactivatedApplication.address, '/readyz'),
        { status: 200, body: { status: 'ready' } },
      );
      const replacementBackend = await faultInjector.pool.query(
        `SELECT pid
           FROM pg_stat_activity
          WHERE application_name = 'ql3-cluster-availability-integration'
            AND usename = 'ql3_runtime'
          ORDER BY backend_start DESC
          LIMIT 1`,
      );
      assert.equal(replacementBackend.rowCount, 1);
      assert.notEqual(replacementBackend.rows[0].pid, terminatedBackendPid);
    } finally {
      await application?.stop();
      await reactivatedApplication?.stop();
      await faultInjector.close();
      await migration.close();
    }
  });

  test(
    'separate Worker listener authenticates and audits before registering a Session',
    {
      skip: workerIngressConnectionString
        ? false
        : 'requires QL3_TEST_POSTGRES_WORKER_INGRESS_URL',
    },
    async () => {
      const openMigration = opener('migration', migrationConnectionString);
      const openWorkerIngress = opener(
        'worker-ingress',
        workerIngressConnectionString,
      );
      const migration = await openMigration();
      const pepper = Buffer.alloc(32, 0x41).toString('base64url');
      const secret = Buffer.alloc(32, 0x42).toString('base64url');
      let application;
      try {
        await runPostgresMigrations({ pool: migration.pool });
        await migration.pool.query(
          'TRUNCATE TABLE "ql3"."worker_execution_attestations", "ql3"."worker_credential_mutations", "ql3"."worker_credentials", "ql3"."worker_sessions", "ql3"."security_audit_events" CASCADE',
        );
        await migration.pool.query(
          `INSERT INTO "ql3"."worker_credentials" (
             credential_id, version, state, worker_id, secret_digest,
             created_at_ms, not_before_at_ms, expires_at_ms
           ) VALUES (
             'worker_http', 1, 'active', 'worker-http-a', $1,
             1, 1, 9999999999999
           )`,
          [workerCredentialSecretDigest(pepper, 'worker_http', secret)],
        );
        application = await startClusterWorkerIngressApplication({
          enabled: true,
          profile: 'cluster-control',
          workerCredentialPepper: pepper,
          openDatabase: openWorkerIngress,
          async create({ database, workerCredentialPepper }) {
            const report = await assertPostgresWorkerIngressSchemaReady(
              database.pool,
            );
            const credentials = new PostgresWorkerCredentialRepository(
              database.pool,
            );
            return {
              evidence: {
                contractName: report.contractName,
                contractVersion: report.contractVersion,
                serverMajor: report.serverMajor,
                migrationIds: [...report.migrationIds],
              },
              pipeline: createWorkerIngressAdmissionPipeline({
                authenticator: createWorkerCredentialAuthenticator(
                  credentials,
                  workerCredentialPepper,
                ),
                workers: new PostgresWorkerSessionRepository(database.pool),
                attestations: new PostgresWorkerExecutionAttestationRepository(
                  database.pool,
                ),
                audit: new PostgresSecurityAuditRepository(database.pool),
              }),
            };
          },
          http: {
            host: '127.0.0.1',
            port: 0,
            drainTimeoutMs: 1_000,
            mutualTls: {
              privateKey: readFileSync(
                path.join(mtlsFixtures, 'server-key.pem'),
              ),
              certificateChain: readFileSync(
                path.join(mtlsFixtures, 'server-cert.pem'),
              ),
              clientCertificateAuthorities: [
                readFileSync(path.join(mtlsFixtures, 'ca-cert.pem')),
              ],
              certificateRevocationLists: [
                readFileSync(path.join(mtlsFixtures, 'empty-crl.pem')),
              ],
            },
          },
        });
        assert.equal(application.status, 'active');
        assert.equal(application.protocol, 'https');
        assert.equal(application.transport, 'mutual-tls');
        assert.equal(
          application.evidence.contractVersion,
          postgresqlControlSchemaContract.contractVersion,
        );
        const sessionId = '018f0000-0000-7000-8000-000000000021';
        const capabilitiesJson =
          '{"architecture":"arm64","executors":["remote-worker"],"protocolVersion":"1.0.0","supportTier":"tier1"}';
        const response = await workerRequest(
          application.address,
          `/api/v3/worker-ingress/workers/worker-http-a/sessions/${sessionId}/register`,
          `ql3w_worker_http_${secret}`,
          {
            schema: WORKER_SESSION_REGISTER_SCHEMA,
            capabilitiesJson,
            capabilitiesHash: require('node:crypto')
              .createHash('sha256')
              .update(capabilitiesJson)
              .digest('hex'),
            maxConcurrentRuns: 1,
            availableSlots: 1,
            leaseDurationMs: 60_000,
          },
        );
        assert.equal(response.status, 200);
        const body = response.body;
        assert.equal(body.workerId, 'worker-http-a');
        assert.equal(body.sessionId, sessionId);
        const facts = await migration.pool.query(
          `SELECT
             (SELECT count(*)::integer FROM "ql3"."worker_sessions"
              WHERE worker_id = 'worker-http-a') AS sessions,
             (SELECT count(*)::integer FROM "ql3"."security_audit_events"
              WHERE operation_id = 'worker.register' AND subject_type = 'worker'
                AND subject_id = 'worker-http-a' AND outcome = 'allowed') AS audits`,
        );
        assert.deepEqual(facts.rows, [{ sessions: 1, audits: 1 }]);

        const transportBase = {
          privateKey: readFileSync(path.join(mtlsFixtures, 'server-key.pem')),
          certificateChain: readFileSync(
            path.join(mtlsFixtures, 'server-cert.pem'),
          ),
          clientCertificateAuthorities: [
            readFileSync(path.join(mtlsFixtures, 'ca-cert.pem')),
          ],
        };
        assert.equal(
          application.reloadTransport({
            ...transportBase,
            certificateRevocationLists: [
              readFileSync(path.join(mtlsFixtures, 'revoked-client-crl.pem')),
            ],
          }),
          2,
        );
        await assert.rejects(
          workerRequest(
            application.address,
            `/api/v3/worker-ingress/workers/worker-http-a/sessions/${sessionId}/register`,
            `ql3w_worker_http_${secret}`,
            {
              schema: WORKER_SESSION_REGISTER_SCHEMA,
              capabilitiesJson,
              capabilitiesHash: require('node:crypto')
                .createHash('sha256')
                .update(capabilitiesJson)
                .digest('hex'),
              maxConcurrentRuns: 1,
              availableSlots: 1,
              leaseDurationMs: 60_000,
            },
          ),
        );
        const rejectedFacts = await migration.pool.query(
          `SELECT count(*)::integer AS audits
             FROM "ql3"."security_audit_events"
            WHERE operation_id = 'worker.register' AND subject_type = 'worker'
              AND subject_id = 'worker-http-a' AND outcome = 'allowed'`,
        );
        assert.deepEqual(rejectedFacts.rows, [{ audits: 1 }]);

        assert.equal(
          application.reloadTransport({
            ...transportBase,
            certificateRevocationLists: [
              readFileSync(path.join(mtlsFixtures, 'empty-crl.pem')),
            ],
          }),
          3,
        );
        const recovered = await workerRequest(
          application.address,
          `/api/v3/worker-ingress/workers/worker-http-a/sessions/${sessionId}/register`,
          `ql3w_worker_http_${secret}`,
          {
            schema: WORKER_SESSION_REGISTER_SCHEMA,
            capabilitiesJson,
            capabilitiesHash: require('node:crypto')
              .createHash('sha256')
              .update(capabilitiesJson)
              .digest('hex'),
            maxConcurrentRuns: 1,
            availableSlots: 1,
            leaseDurationMs: 60_000,
          },
        );
        assert.equal(recovered.status, 200);
        const recoveredFacts = await migration.pool.query(
          `SELECT
             (SELECT count(*)::integer FROM "ql3"."worker_sessions"
              WHERE worker_id = 'worker-http-a') AS sessions,
             (SELECT count(*)::integer FROM "ql3"."security_audit_events"
              WHERE operation_id = 'worker.register' AND subject_type = 'worker'
                AND subject_id = 'worker-http-a' AND outcome = 'allowed') AS audits`,
        );
        assert.deepEqual(recoveredFacts.rows, [{ sessions: 1, audits: 2 }]);
      } finally {
        await application?.stop();
        await migration.close();
      }
    },
  );
}
