const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  DuplicateIdempotencyKeyError,
  DuplicateRunAttemptError,
  DuplicateRunEventError,
  RunEventPayloadTooLargeError,
} = require('../../back/runtime/domain/repositoryErrors');
const {
  MAX_CANCELLATION_RECOVERY_PAGE_SIZE,
  MAX_RUN_EVENT_PAGE_SIZE,
  MAX_RUN_EVENT_PAYLOAD_BYTES,
} = require('../../back/runtime/ports/runRepository');

const legacyRepositoryContract = Object.freeze({
  DuplicateIdempotencyKeyError,
  DuplicateRunAttemptError,
  DuplicateRunEventError,
  RunEventPayloadTooLargeError,
  MAX_CANCELLATION_RECOVERY_PAGE_SIZE,
  MAX_RUN_EVENT_PAGE_SIZE,
  MAX_RUN_EVENT_PAYLOAD_BYTES,
});

function registerRunRepositoryContract({
  name,
  createRepository,
  defaultExecutionOwner = 'legacy',
  contract = legacyRepositoryContract,
}) {
  const {
    DuplicateIdempotencyKeyError,
    DuplicateRunAttemptError,
    DuplicateRunEventError,
    RunEventPayloadTooLargeError,
    MAX_CANCELLATION_RECOVERY_PAGE_SIZE,
    MAX_RUN_EVENT_PAGE_SIZE,
    MAX_RUN_EVENT_PAYLOAD_BYTES,
  } = contract;
  let idSequence = 100;

  function nextId() {
    idSequence += 1;
    return `019f70b0-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
  }

  function createRun(overrides = {}) {
    return {
      id: nextId(),
      projectId: 'default',
      taskId: 'legacy-cron:1',
      taskRevision: 'revision-1',
      taskName: 'test cron',
      legacyCronId: 1,
      triggerType: 'manual',
      executionOrigin: 'manual',
      executionOwner: defaultExecutionOwner,
      triggeredBy: 'user:1',
      status: 'created',
      version: 0,
      eventSequence: 0,
      priority: 0,
      createdAtMs: 1_750_000_000_000,
      ...overrides,
    };
  }

  function createAttempt(runId, overrides = {}) {
    return {
      id: nextId(),
      runId,
      attempt: 1,
      status: 'claimed',
      executorType: 'legacy_local',
      callbackSequence: 0,
      createdAtMs: 1_750_000_000_001,
      ...overrides,
    };
  }

  function createEvent(runId, overrides = {}) {
    return {
      id: nextId(),
      runId,
      sequence: 1,
      type: 'run.created',
      dedupeKey: 'run.created',
      actorType: 'compatibility',
      payload: { source: 'repository-contract-test' },
      createdAtMs: 1_750_000_000_002,
      ...overrides,
    };
  }

  function createRetryPolicy(runId, overrides = {}) {
    return {
      runId,
      maxAttempts: 3,
      retryOnLost: true,
      safety: 'idempotent',
      backoffBaseMs: 1_000,
      backoffMaxMs: 30_000,
      version: 0,
      createdAtMs: 1_750_000_000_002,
      updatedAtMs: 1_750_000_000_002,
      ...overrides,
    };
  }

  async function setup(t) {
    const harness = await createRepository();
    if (harness.close) {
      t.after(() => harness.close());
    }
    return harness.repository;
  }

  test(`${name}: persists a Run aggregate atomically and returns plain records`, async (t) => {
    const repository = await setup(t);
    const run = createRun({ idempotencyKey: 'manual-request-1' });
    const attempt = createAttempt(run.id, {
      deadlineAtMs: 1_750_000_030_000,
    });
    const event = createEvent(run.id, { attemptId: attempt.id });

    await repository.transaction(async (transaction) => {
      await transaction.insertRun(run);
      await transaction.insertAttempt(attempt);
      await transaction.appendEvent(event);

      assert.deepEqual(await transaction.findRunById(run.id), run);
      assert.deepEqual(await transaction.findAttemptById(attempt.id), attempt);
    });

    assert.deepEqual(await repository.findRunById(run.id), run);
    assert.deepEqual(await repository.findAttemptById(attempt.id), attempt);
    assert.deepEqual(await repository.listEvents(run.id), [event]);
  });

  test(`${name}: rolls back every aggregate write when a transaction fails`, async (t) => {
    const repository = await setup(t);
    const run = createRun();
    const attempt = createAttempt(run.id);

    await assert.rejects(
      repository.transaction(async (transaction) => {
        await transaction.insertRun(run);
        await transaction.insertAttempt(attempt);
        throw new Error('force rollback');
      }),
      /force rollback/,
    );

    assert.equal(await repository.findRunById(run.id), null);
    assert.equal(await repository.findAttemptById(attempt.id), null);
  });

  test(`${name}: enforces Run and Attempt compare-and-set predicates`, async (t) => {
    const repository = await setup(t);
    const run = createRun();
    const attempt = createAttempt(run.id);
    await repository.transaction(async (transaction) => {
      await transaction.insertRun(run);
      await transaction.insertAttempt(attempt);
    });

    const updatedRun = {
      ...run,
      status: 'queued',
      version: 1,
      queuedAtMs: 1_750_000_000_003,
    };
    const updatedAttempt = {
      ...attempt,
      status: 'starting',
      callbackSequence: 1,
      startedAtMs: 1_750_000_000_004,
    };
    await repository.transaction(async (transaction) => {
      assert.equal(await transaction.compareAndSetRun(updatedRun, 0), true);
      assert.equal(await transaction.compareAndSetRun(updatedRun, 0), false);
      assert.equal(
        await transaction.compareAndSetAttempt(updatedAttempt, {
          status: 'claimed',
          callbackSequence: 0,
        }),
        true,
      );
      assert.equal(
        await transaction.compareAndSetAttempt(updatedAttempt, {
          status: 'claimed',
          callbackSequence: 0,
        }),
        false,
      );
    });

    assert.deepEqual(await repository.findRunById(run.id), updatedRun);
    assert.deepEqual(
      await repository.findAttemptById(attempt.id),
      updatedAttempt,
    );
  });

  test(`${name}: maps stable uniqueness violations to domain errors`, async (t) => {
    const repository = await setup(t);
    const run = createRun({ idempotencyKey: 'manual-request-2' });
    const attempt = createAttempt(run.id);
    const event = createEvent(run.id);

    await repository.transaction(async (transaction) => {
      await transaction.insertRun(run);
      await transaction.insertAttempt(attempt);
      await transaction.appendEvent(event);
    });

    await assert.rejects(
      repository.transaction((transaction) =>
        transaction.insertRun(
          createRun({ idempotencyKey: 'manual-request-2' }),
        ),
      ),
      DuplicateIdempotencyKeyError,
    );
    await assert.rejects(
      repository.transaction((transaction) =>
        transaction.insertAttempt(
          createAttempt(run.id, { attempt: attempt.attempt }),
        ),
      ),
      DuplicateRunAttemptError,
    );
    await assert.rejects(
      repository.transaction((transaction) =>
        transaction.appendEvent(
          createEvent(run.id, {
            sequence: 2,
            dedupeKey: event.dedupeKey,
          }),
        ),
      ),
      DuplicateRunEventError,
    );
  });

  test(`${name}: persists and compare-and-sets the admitted retry policy`, async (t) => {
    const repository = await setup(t);
    const run = createRun();
    const policy = createRetryPolicy(run.id);
    await repository.transaction(async (transaction) => {
      await transaction.insertRun(run);
      await transaction.insertRetryPolicy(policy);
      assert.deepEqual(
        await transaction.findRetryPolicyByRunId(run.id),
        policy,
      );
    });

    const updated = {
      ...policy,
      nextAttemptAtMs: 1_750_000_010_000,
      version: 1,
      updatedAtMs: 1_750_000_000_003,
    };
    await repository.transaction(async (transaction) => {
      assert.equal(
        await transaction.compareAndSetRetryPolicy(updated, 0),
        true,
      );
      assert.equal(
        await transaction.compareAndSetRetryPolicy(updated, 0),
        false,
      );
    });
    assert.deepEqual(await repository.findRetryPolicyByRunId(run.id), updated);

    await assert.rejects(
      repository.transaction((transaction) =>
        transaction.compareAndSetRetryPolicy(
          { ...updated, version: 3, updatedAtMs: 1_750_000_000_004 },
          1,
        ),
      ),
      (error) => error.code === 'RUN_REPOSITORY_CONSTRAINT',
    );
  });

  test(`${name}: bounds event pages and rejects oversized payloads`, async (t) => {
    const repository = await setup(t);
    const run = createRun();

    await repository.transaction(async (transaction) => {
      await transaction.insertRun(run);
      await transaction.appendEvent(createEvent(run.id));
      await transaction.appendEvent(
        createEvent(run.id, {
          sequence: 2,
          dedupeKey: 'run.queued',
          type: 'run.queued',
        }),
      );
      await transaction.appendEvent(
        createEvent(run.id, {
          sequence: 3,
          dedupeKey: 'attempt.claimed',
          type: 'attempt.claimed',
        }),
      );
    });

    const page = await repository.listEvents(run.id, {
      afterSequence: 1,
      limit: 2,
    });
    assert.deepEqual(
      page.map((event) => event.sequence),
      [2, 3],
    );
    await assert.rejects(
      repository.listEvents(run.id, { limit: MAX_RUN_EVENT_PAGE_SIZE + 1 }),
      RangeError,
    );

    const oversized = createEvent(run.id, {
      sequence: 4,
      dedupeKey: 'oversized',
      payload: { value: 'x'.repeat(MAX_RUN_EVENT_PAYLOAD_BYTES) },
    });
    await assert.rejects(
      repository.transaction((transaction) =>
        transaction.appendEvent(oversized),
      ),
      RunEventPayloadTooLargeError,
    );
    assert.deepEqual(
      (await repository.listEvents(run.id)).map((event) => event.sequence),
      [1, 2, 3],
    );
  });

  test(`${name}: returns bounded cancellation requests in recovery order`, async (t) => {
    const repository = await setup(t);
    const earlier = createRun({
      status: 'running',
      cancelRequestedAtMs: 1_750_000_000_010,
      cancelReason: 'user',
    });
    const later = createRun({
      status: 'dispatching',
      cancelRequestedAtMs: 1_750_000_000_020,
      cancelReason: 'shutdown',
    });
    const terminal = createRun({
      status: 'cancelled',
      cancelRequestedAtMs: 1_750_000_000_005,
      cancelReason: 'policy',
      finishedAtMs: 1_750_000_000_006,
    });
    const untouched = createRun({ status: 'running' });
    await repository.transaction(async (transaction) => {
      for (const run of [later, terminal, untouched, earlier]) {
        await transaction.insertRun(run);
      }
    });

    assert.deepEqual(
      (await repository.listCancellationRequested()).map((run) => run.id),
      [earlier.id, later.id],
    );
    assert.deepEqual(
      (
        await repository.listCancellationRequested({
          beforeMs: 1_750_000_000_015,
          limit: 1,
        })
      ).map((run) => run.id),
      [earlier.id],
    );
    await assert.rejects(
      repository.listCancellationRequested({ beforeMs: -1 }),
      RangeError,
    );
    await assert.rejects(
      repository.listCancellationRequested({
        limit: MAX_CANCELLATION_RECOVERY_PAGE_SIZE + 1,
      }),
      RangeError,
    );
  });
}

module.exports = { registerRunRepositoryContract };
