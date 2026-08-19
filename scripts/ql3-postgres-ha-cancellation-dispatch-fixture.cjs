const assert = require('node:assert/strict');

const {
  createPostgresDatabaseOpener,
  PostgresCancellationDispatchRepository,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/runtime.js');
const {
  PostgresRunCancellationDispatchManagementRepository,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/runManager.js');
const {
  CancellationDispatchFenceRejectedError,
  digestCancellationDispatchLeaseToken,
} = require('../packages/ql3-runtime-core/dist/run/cancellation-dispatch/cancellationDispatch.js');
const {
  ClusterRemoteWorkerCancellationDispatchControl,
} = require('../packages/ql3-cluster-control/dist/remote-execution/remoteWorkerCancellationDispatchControl.js');

const FIXTURE = Object.freeze({
  projectId: 'ha-cancel-project-d365',
  actorId: 'ha-cancel-operator-d365',
  runId: 'ha-cancel-run-d363',
  attemptId: 'ha-cancel-attempt-d363',
  requestedAtMs: 1_750_000_000_100,
  retryEventId: 'ha-cancel-retry-event-d363',
  terminalEventId: 'ha-cancel-terminal-event-d363',
  settledEventId: 'ha-cancel-settled-event-d363',
  blockedEventId: 'ha-cancel-blocked-event-d365',
  blockedListAuditEventId: '019f9700-0000-4000-8000-000000000006',
  summaryAuditEventId: '019f9700-0000-4000-8000-000000000005',
  inspectAuditEventId: '019f9700-0000-4000-8000-000000000001',
  rearmAuditEventId: '019f9700-0000-4000-8000-000000000002',
  rearmMutationId: '019f9700-0000-4000-8000-000000000003',
  rearmEventId: '019f9700-0000-4000-8000-000000000004',
});

async function openRuntime(connectionString, applicationName) {
  return createPostgresDatabaseOpener({
    role: 'runtime',
    connection: { connectionString, tls: { mode: 'disable' } },
    pool: { maxConnections: 2, applicationName },
    onPoolError(error) {
      throw error;
    },
  })();
}

async function openRunManager(connectionString, applicationName) {
  return createPostgresDatabaseOpener({
    role: 'run-manager',
    connection: { connectionString, tls: { mode: 'disable' } },
    pool: { maxConnections: 1, applicationName },
    onPoolError(error) {
      throw error;
    },
  })();
}

async function cancellationDispatchFacts(pool) {
  const result = await pool.query(
    `SELECT dispatch.status, dispatch.version,
            dispatch.dispatch_count AS "dispatchCount",
            dispatch.lease_token_digest AS "leaseTokenDigest",
            dispatch.last_result AS "lastResult",
            run.version AS "runVersion",
            run.event_sequence AS "eventSequence",
            count(event.id)::integer AS "eventCount"
       FROM "ql3"."run_cancellation_dispatches" dispatch
       JOIN "ql3"."runs" run ON run.id = dispatch.run_id
       LEFT JOIN "ql3"."run_events" event ON event.run_id = run.id
      WHERE dispatch.run_id = $1
      GROUP BY dispatch.run_id, run.id`,
    [FIXTURE.runId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function persistCancellationDispatchHaFixture(options) {
  const {
    migrationPool,
    runtimeConnectionString,
    runManagerConnectionString,
  } = options;
  const beforeClock = await migrationPool.query(
    `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
            AS "nowMs"`,
  );
  const observedAtMs = Number(beforeClock.rows[0].nowMs);
  await migrationPool.query(
    `INSERT INTO "ql3"."projects" (
       id, name, slug, status, version, created_at_ms, updated_at_ms
     ) VALUES ($1, 'HA cancellation dispatch', $1, 'active', 1, $2, $2)`,
    [FIXTURE.projectId, observedAtMs],
  );
  await migrationPool.query(
    `INSERT INTO "ql3"."project_role_bindings" (
       project_id, subject_type, subject_id, version, state, role,
       mutation_id, changed_by_type, changed_by_id, created_at_ms
     ) VALUES ($1, 'user', $2, 1, 'active', 'operator',
               'ha-cancel-binding-d365', 'system', 'ha-contract', $3)`,
    [FIXTURE.projectId, FIXTURE.actorId, observedAtMs],
  );
  await migrationPool.query(
    `INSERT INTO "ql3"."runs" (
       id, project_id, task_id, task_revision, trigger_type,
       execution_origin, execution_owner, status, version, event_sequence,
       created_at_ms, started_at_ms, cancel_requested_at_ms, cancel_reason
     ) VALUES (
       $1, $2, 'ha-cancel-task', 'v1', 'manual', 'api', 'runtime',
       'running', 2, 0, $3, $3, $4, 'user'
     )`,
    [
      FIXTURE.runId,
      FIXTURE.projectId,
      FIXTURE.requestedAtMs - 100,
      FIXTURE.requestedAtMs,
    ],
  );
  await migrationPool.query(
    `INSERT INTO "ql3"."run_attempts" (
       id, run_id, attempt, status, executor_type, callback_sequence,
       created_at_ms
     ) VALUES ($1, $2, 1, 'running', 'local_process', 0, $3)`,
    [FIXTURE.attemptId, FIXTURE.runId, FIXTURE.requestedAtMs - 50],
  );

  const [firstDatabase, secondDatabase] = await Promise.all([
    openRuntime(runtimeConnectionString, 'ql3-ha-cancel-primary-a'),
    openRuntime(runtimeConnectionString, 'ql3-ha-cancel-primary-b'),
  ]);
  try {
    const first = new PostgresCancellationDispatchRepository(
      firstDatabase.pool,
    );
    const second = new PostgresCancellationDispatchRepository(
      secondDatabase.pool,
    );
    const candidate = {
      runId: FIXTURE.runId,
      attemptId: FIXTURE.attemptId,
      requestedAtMs: FIXTURE.requestedAtMs,
      leaseDurationMs: 30_000,
    };
    const claims = await Promise.all([
      first.claim({
        ...candidate,
        owner: 'ha-cancel-primary-a',
        leaseToken: 'ha-cancel-lease-a',
      }),
      second.claim({
        ...candidate,
        owner: 'ha-cancel-primary-b',
        leaseToken: 'ha-cancel-lease-b',
      }),
    ]);
    const claimed = claims.find((result) => result.status === 'claimed');
    const competing = claims.find((result) => result.status !== 'claimed');
    assert.equal(claimed?.status, 'claimed');
    assert.equal(competing?.status, 'leased');
    assert.equal(
      claimed.dispatch.createdAtMs >= Number(beforeClock.rows[0].nowMs),
      true,
    );
    const storedLease = await migrationPool.query(
      `SELECT lease_token_digest AS "leaseTokenDigest"
         FROM "ql3"."run_cancellation_dispatches" WHERE run_id = $1`,
      [FIXTURE.runId],
    );
    assert.equal(
      storedLease.rows[0].leaseTokenDigest,
      digestCancellationDispatchLeaseToken(claimed.leaseToken),
    );
    assert.notEqual(storedLease.rows[0].leaseTokenDigest, claimed.leaseToken);

    await migrationPool.query(
      `UPDATE "ql3"."run_cancellation_dispatches"
          SET lease_expires_at_ms = 0 WHERE run_id = $1`,
      [FIXTURE.runId],
    );
    const takeover = await second.claim({
      ...candidate,
      owner: 'ha-cancel-takeover',
      leaseToken: 'ha-cancel-takeover-token',
    });
    assert.equal(takeover.status, 'claimed');
    assert.equal(takeover.dispatch.version, 2);
    await assert.rejects(
      first.recordResult({
        runId: FIXTURE.runId,
        attemptId: FIXTURE.attemptId,
        owner: claimed.dispatch.leaseOwner,
        leaseToken: claimed.leaseToken,
        expectedVersion: claimed.dispatch.version,
        result: 'already_exited',
        eventId: FIXTURE.terminalEventId,
      }),
      CancellationDispatchFenceRejectedError,
    );

    const retry = await second.recordResult({
      runId: FIXTURE.runId,
      attemptId: FIXTURE.attemptId,
      owner: 'ha-cancel-takeover',
      leaseToken: 'ha-cancel-takeover-token',
      expectedVersion: takeover.dispatch.version,
      result: 'dispatch_error',
      retryDelayMs: 60_000,
      eventId: FIXTURE.retryEventId,
    });
    assert.equal(retry.dispatch.status, 'retry_wait');
    assert.equal(
      (await first.claim({
        ...candidate,
        owner: 'ha-cancel-early',
        leaseToken: 'ha-cancel-early-token',
      })).status,
      'not_due',
    );
    await migrationPool.query(
      `UPDATE "ql3"."run_cancellation_dispatches"
          SET next_attempt_at_ms = 0 WHERE run_id = $1`,
      [FIXTURE.runId],
    );
    const blockingClaim = await second.claim({
      ...candidate,
      owner: 'ha-cancel-blocker',
      leaseToken: 'ha-cancel-blocker-token',
    });
    assert.equal(blockingClaim.status, 'claimed');
    assert.equal(blockingClaim.dispatch.version, 4);
    const blocked = await second.recordResult({
      runId: FIXTURE.runId,
      attemptId: FIXTURE.attemptId,
      owner: 'ha-cancel-blocker',
      leaseToken: 'ha-cancel-blocker-token',
      expectedVersion: blockingClaim.dispatch.version,
      result: 'identity_mismatch',
      eventId: FIXTURE.blockedEventId,
    });
    assert.equal(blocked.dispatch.status, 'blocked');
    assert.equal(blocked.dispatch.version, 5);

    const runManagerDatabase = await openRunManager(
      runManagerConnectionString,
      'ql3-ha-cancel-run-manager',
    );
    try {
      const management =
        new PostgresRunCancellationDispatchManagementRepository(
          runManagerDatabase.pool,
        );
      const principal = Object.freeze({
        subject: Object.freeze({ type: 'user', id: FIXTURE.actorId }),
        authenticationId: 'oidc:ha-cancel-d365',
        authenticatedAtMs: observedAtMs - 1_000,
        expiresAtMs: observedAtMs + 5 * 60_000,
        assurance: 'multi_factor',
      });
      const authority = Object.freeze({
        projectId: FIXTURE.projectId,
        runId: FIXTURE.runId,
        requestId: 'ha-cancel-inspect-d365',
        auditEventId: FIXTURE.inspectAuditEventId,
        principal,
        policyFence: Object.freeze({ projectVersion: 1, bindingVersion: 1 }),
      });
      const blockedPage = await management.listBlocked({
        projectId: FIXTURE.projectId,
        requestId: 'ha-cancel-blocked-list-d368',
        auditEventId: FIXTURE.blockedListAuditEventId,
        principal,
        policyFence: authority.policyFence,
      });
      assert.equal(blockedPage.projectId, FIXTURE.projectId);
      assert.equal(blockedPage.snapshotAtMs, blockedPage.observedAtMs);
      assert.deepEqual(blockedPage.items, [
        {
          runId: FIXTURE.runId,
          blockedAtMs: blocked.dispatch.updatedAtMs,
        },
      ]);
      assert.equal(blockedPage.truncated, false);
      assert.equal(Object.hasOwn(blockedPage, 'nextCursor'), false);
      assert.equal(JSON.stringify(blockedPage).includes('attemptId'), false);
      assert.equal(JSON.stringify(blockedPage).includes('lastResult'), false);
      assert.equal(JSON.stringify(blockedPage).includes('leaseOwner'), false);
      assert.equal(JSON.stringify(blockedPage).includes('leaseToken'), false);
      const blockedListAudit = await migrationPool.query(
        `SELECT operation_id AS "operationId", outcome
           FROM "ql3"."security_audit_events" WHERE event_id = $1`,
        [FIXTURE.blockedListAuditEventId],
      );
      assert.deepEqual(blockedListAudit.rows, [
        {
          operationId: 'run.cancellation.blocked.list',
          outcome: 'allowed',
        },
      ]);
      await migrationPool.query('BEGIN');
      let blockedListPlan;
      try {
        await migrationPool.query('SET LOCAL enable_seqscan = off');
        blockedListPlan = await migrationPool.query(
          `EXPLAIN (FORMAT JSON, COSTS OFF)
           SELECT run_id, updated_at_ms
             FROM "ql3"."run_cancellation_dispatches"
            WHERE project_id = $1 AND status = 'blocked'
              AND updated_at_ms <= $2
            ORDER BY updated_at_ms ASC, run_id ASC
            LIMIT 17`,
          [FIXTURE.projectId, blockedPage.snapshotAtMs],
        );
      } finally {
        await migrationPool.query('ROLLBACK');
      }
      assert.match(
        JSON.stringify(blockedListPlan.rows),
        /ql3_run_cancellation_dispatch_project_blocked_idx/,
      );
      const summary = await management.summary({
        projectId: FIXTURE.projectId,
        requestId: 'ha-cancel-summary-d366',
        auditEventId: FIXTURE.summaryAuditEventId,
        principal,
        policyFence: authority.policyFence,
      });
      assert.equal(summary.assessment, 'attention_required');
      assert.equal(summary.operatorAction, 'inspect');
      assert.equal(summary.dispatches.blocked, 1);
      assert.equal(summary.blockingResults.identityMismatch, 1);
      assert.equal(summary.signals.due, 0);
      assert.equal(summary.signals.expiredLease, 0);
      assert.equal(Object.hasOwn(summary, 'runId'), false);
      assert.equal(JSON.stringify(summary).includes('attemptId'), false);
      assert.equal(JSON.stringify(summary).includes('leaseOwner'), false);
      const diagnostic = await management.inspect(authority);
      assert.equal(diagnostic.operatorAction, 'rearm');
      assert.equal(diagnostic.dispatch?.status, 'blocked');
      assert.equal(diagnostic.dispatch?.version, 5);
      assert.equal(diagnostic.dispatch?.lastResult, 'identity_mismatch');
      assert.equal(JSON.stringify(diagnostic).includes('leaseOwner'), false);
      assert.equal(JSON.stringify(diagnostic).includes('leaseToken'), false);
      const rearm = await management.rearm({
        ...authority,
        requestId: 'ha-cancel-rearm-d365',
        auditEventId: FIXTURE.rearmAuditEventId,
        mutationId: FIXTURE.rearmMutationId,
        eventId: FIXTURE.rearmEventId,
        expectedDispatchVersion: 5,
        expectedLastResult: 'identity_mismatch',
        retryDelayMs: 60_000,
      });
      assert.equal(rearm.status, 'rearmed');
      assert.equal(rearm.dispatchVersion, 6);
      assert.equal(rearm.previousResult, 'identity_mismatch');
      assert.equal(rearm.runVersion, 5);
      assert.equal(rearm.eventSequence, 3);
    } finally {
      await runManagerDatabase.close();
    }
    assert.equal(
      (await first.claim({
        ...candidate,
        owner: 'ha-cancel-rearm-early',
        leaseToken: 'ha-cancel-rearm-early-token',
      })).status,
      'not_due',
    );
    await migrationPool.query(
      `UPDATE "ql3"."run_cancellation_dispatches"
          SET next_attempt_at_ms = 0 WHERE run_id = $1`,
      [FIXTURE.runId],
    );
    const stopRequested = Object.freeze({
      status: 'stop_requested',
      projectId: FIXTURE.projectId,
      runId: FIXTURE.runId,
      attemptId: FIXTURE.attemptId,
      offerId: 'ha-cancel-offer-d364',
      leaseGeneration: 1,
      leaseVersion: 2,
      renewedAtMs: FIXTURE.requestedAtMs,
      expiresAtMs: FIXTURE.requestedAtMs + 30_000,
      stop: Object.freeze({
        reason: 'user',
        requestedAtMs: FIXTURE.requestedAtMs,
      }),
    });
    const deliveryObservations = [];
    const delivery = new ClusterRemoteWorkerCancellationDispatchControl(
      { async control() { return stopRequested; } },
      first,
      {
        ownerId: 'ha-cancel-final',
        leaseDurationMs: 30_000,
        createLeaseToken: () => 'ha-cancel-final-token',
        createEventId: () => FIXTURE.terminalEventId,
        onObservation: (observation) => deliveryObservations.push(observation),
      },
    );
    assert.equal(await delivery.control({}), stopRequested);
    assert.deepEqual(deliveryObservations, [{ status: 'dispatched' }]);
    await migrationPool.query(
      `WITH observed AS (
         SELECT floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
                  AS at_ms
       ), closed_attempt AS (
         UPDATE "ql3"."run_attempts"
            SET status = 'cancelled', finished_at_ms = observed.at_ms
           FROM observed
          WHERE id = $2 AND run_id = $1
          RETURNING id
       ), closed_run AS (
         UPDATE "ql3"."runs"
            SET status = 'cancelled', version = version + 1,
                event_sequence = event_sequence + 1,
                finished_at_ms = observed.at_ms
           FROM observed
          WHERE id = $1
            AND EXISTS (SELECT 1 FROM closed_attempt)
          RETURNING id, event_sequence, finished_at_ms
       )
       INSERT INTO "ql3"."run_events" (
         id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
         attempt_id, payload, created_at_ms
       )
       SELECT $3, id, event_sequence, 'run.cancelled',
              'ha-cancel-fixture-settled', 'system', 'ha-contract', $2,
              '{"reason":"fixture_settled"}'::jsonb, finished_at_ms
         FROM closed_run`,
      [FIXTURE.runId, FIXTURE.attemptId, FIXTURE.settledEventId],
    );
    const beforePromotion = await cancellationDispatchFacts(migrationPool);
    assert.deepEqual(beforePromotion, {
      status: 'dispatched',
      version: 8,
      dispatchCount: 4,
      leaseTokenDigest: null,
      lastResult: 'termination_requested',
      runVersion: 7,
      eventSequence: 5,
      eventCount: 5,
    });
    return {
      fixture: FIXTURE,
      beforePromotion,
      databaseTimed: true,
      crossPoolClaimExactlyOnce: true,
      rawLeaseTokenNeverStored: true,
      expiredLeaseTakenOver: true,
      staleLeaseFenced: true,
      retryDeferredUntilDue: true,
      operatorDiagnosticLowSensitive: true,
      operatorSummaryLowSensitiveAndActionable: true,
      blockedListLowSensitiveAndSnapshotBound: true,
      blockedListUsesProjectKeysetIndex: true,
      manualBlockedRearmExact: true,
      manualRearmDeferredUntilDue: true,
      productionDeliverySettledBeforeStop: true,
      replicatedBeforePromotion: false,
      survivedPromotion: false,
    };
  } finally {
    await Promise.allSettled([
      firstDatabase.close(),
      secondDatabase.close(),
    ]);
  }
}

async function verifyPromotedCancellationDispatchHaFixture(options) {
  const { promotedPool, runtimeConnectionString, evidence } = options;
  const afterPromotion = await cancellationDispatchFacts(promotedPool);
  assert.deepEqual(afterPromotion, evidence.beforePromotion);
  const runtimeDatabase = await openRuntime(
    runtimeConnectionString,
    'ql3-ha-cancel-promoted',
  );
  try {
    const dispatch = await new PostgresCancellationDispatchRepository(
      runtimeDatabase.pool,
    ).findByRunId(FIXTURE.runId);
    assert.equal(dispatch?.status, 'dispatched');
    assert.equal(dispatch?.dispatchCount, 4);
    assert.equal(dispatch?.leaseTokenDigest, undefined);
  } finally {
    await runtimeDatabase.close();
  }
  evidence.afterPromotion = afterPromotion;
  evidence.survivedPromotion = true;
  return evidence;
}

module.exports = {
  cancellationDispatchFacts,
  persistCancellationDispatchHaFixture,
  verifyPromotedCancellationDispatchHaFixture,
};
