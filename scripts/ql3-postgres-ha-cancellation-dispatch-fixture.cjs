const assert = require('node:assert/strict');

const {
  createPostgresDatabaseOpener,
  PostgresCancellationDispatchRepository,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/runtime.js');
const {
  CancellationDispatchFenceRejectedError,
  digestCancellationDispatchLeaseToken,
} = require('../packages/ql3-runtime-core/dist/run/cancellation-dispatch/cancellationDispatch.js');

const FIXTURE = Object.freeze({
  runId: 'ha-cancel-run-d363',
  attemptId: 'ha-cancel-attempt-d363',
  requestedAtMs: 1_750_000_000_100,
  retryEventId: 'ha-cancel-retry-event-d363',
  terminalEventId: 'ha-cancel-terminal-event-d363',
  settledEventId: 'ha-cancel-settled-event-d363',
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
  const { migrationPool, runtimeConnectionString } = options;
  const beforeClock = await migrationPool.query(
    `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
            AS "nowMs"`,
  );
  await migrationPool.query(
    `INSERT INTO "ql3"."runs" (
       id, project_id, task_id, task_revision, trigger_type,
       execution_origin, execution_owner, status, version, event_sequence,
       created_at_ms, started_at_ms, cancel_requested_at_ms, cancel_reason
     ) VALUES (
       $1, 'default', 'ha-cancel-task', 'v1', 'manual', 'api', 'runtime',
       'running', 2, 0, $2, $2, $3, 'user'
     )`,
    [FIXTURE.runId, FIXTURE.requestedAtMs - 100, FIXTURE.requestedAtMs],
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
    const finalLease = await first.claim({
      ...candidate,
      owner: 'ha-cancel-final',
      leaseToken: 'ha-cancel-final-token',
    });
    assert.equal(finalLease.status, 'claimed');
    assert.equal(finalLease.dispatch.dispatchCount, 3);
    const terminal = await first.recordResult({
      runId: FIXTURE.runId,
      attemptId: FIXTURE.attemptId,
      owner: 'ha-cancel-final',
      leaseToken: 'ha-cancel-final-token',
      expectedVersion: finalLease.dispatch.version,
      result: 'already_exited',
      eventId: FIXTURE.terminalEventId,
    });
    assert.equal(terminal.dispatch.status, 'dispatched');
    assert.equal(terminal.event.sequence, 2);
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
      version: 5,
      dispatchCount: 3,
      leaseTokenDigest: null,
      lastResult: 'already_exited',
      runVersion: 5,
      eventSequence: 3,
      eventCount: 3,
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
    assert.equal(dispatch?.dispatchCount, 3);
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
