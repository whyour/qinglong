require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  WorkerExecutionOfferFileJournal,
  WorkerExecutionOfferJournalCapacityError,
  WorkerExecutionOfferJournalOwnershipError,
  WorkerExecutionOfferJournalRevisionError,
} = require('../../back/runtime/adapters/fs/workerExecutionOfferFileJournal');
const {
  assertWorkerExecutionOfferJournalRecord,
  createWorkerExecutionOfferJournalRecord,
} = require('../../back/runtime/domain/workerExecutionOffer');
const {
  createWorkerExecutionCompletionReceiptAuthentication,
} = require('../../back/runtime/domain/workerExecutionCompletionReceiptAuthentication');
const {
  createExecutionSpecDigest,
  createRunDispatchOfferId,
} = require('../../back/runtime/domain/runDispatchOffer');

const START = 1_760_300_000_000;
const SESSION = '019f7d00-0000-7000-8000-000000000001';
const COMPLETION_TOKEN =
  'journal_completion_capability_abcdefghijklmnopqrstuvwxyz01';

function offer(sequence = 1) {
  const attemptId = `attempt-${sequence}`;
  const runId = `run-${sequence}`;
  const lease = {
    attemptId,
    runId,
    status: 'leased',
    version: 0,
    leaseGeneration: 1,
    workerId: 'worker-edge',
    workerSessionId: SESSION,
    workerGeneration: 1,
    leaseToken: `lease_token_${String(sequence).padStart(
      3,
      '0',
    )}_abcdefghijklmnopqrstuvwxyz`,
    acquiredAtMs: START,
    renewedAtMs: START,
    expiresAtMs: START + 60_000,
    updatedAtMs: START,
  };
  const executionSpec = {
    runId,
    attemptId,
    projectId: 'default',
    taskId: `task-${sequence}`,
    taskRevision: 'revision-1',
    command: { kind: 'argv', file: '/bin/true', args: [] },
    environmentPolicy: 'isolated',
    terminationGraceMs: 1_000,
  };
  return {
    offerId: createRunDispatchOfferId(lease),
    executionSpecDigest: createExecutionSpecDigest(executionSpec),
    deliveryKind: 'new_claim',
    candidate: {
      runId,
      attemptId,
      projectId: 'default',
      taskId: `task-${sequence}`,
      taskRevision: 'revision-1',
      executorType: 'remote_worker',
      priority: 0,
      queuedAtMs: START,
      attemptCreatedAtMs: START,
    },
    worker: { id: 'worker-edge', sessionId: SESSION, generation: 1 },
    lease,
    executionSpec,
  };
}

async function fixture(t, maximumEntries = 4) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-offer-journal-'));
  const journal = new WorkerExecutionOfferFileJournal(root, {
    maximumEntries,
  });
  await journal.acquireOwnership();
  t.after(async () => {
    await journal.releaseOwnership();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    journal,
  };
}

test('atomically persists, replaces and reopens a private Worker offer entry', async (t) => {
  const { root, journal } = await fixture(t);
  const delivered = offer();
  const initial = createWorkerExecutionOfferJournalRecord(delivered, START);
  assert.equal(await journal.create(initial), 'created');
  assert.equal(await journal.create(initial), 'exists');

  const accepted = await journal.read(delivered.offerId);
  assert.equal(accepted.state, 'accepted');
  const starting = {
    ...accepted,
    revision: 1,
    state: 'starting_acknowledged',
    updatedAtMs: START + 1,
  };
  await journal.replace(starting, 0);
  const authentication = createWorkerExecutionCompletionReceiptAuthentication({
    token: COMPLETION_TOKEN,
    callbackSequence: 1,
  });
  const launching = {
    ...starting,
    revision: 2,
    state: 'launching',
    updatedAtMs: START + 2,
    completionReceiptCallbackSequence: authentication.callbackSequence,
    completionReceiptTokenDigest: authentication.tokenDigest,
  };
  await journal.replace(launching, 1);

  const reopened = new WorkerExecutionOfferFileJournal(root, {
    maximumEntries: 4,
  });
  await journal.releaseOwnership();
  await reopened.acquireOwnership();
  assert.deepEqual(await reopened.read(delivered.offerId), launching);
  assert.doesNotMatch(
    await fs.readFile(path.join(root, `${delivered.offerId}.json`), 'utf8'),
    new RegExp(COMPLETION_TOKEN),
  );
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(path.join(root, `${delivered.offerId}.json`))).mode & 0o777,
    0o600,
  );
  await reopened.releaseOwnership();
  await journal.acquireOwnership();
});

test('requires one explicit owner and hands the root to a later process', async (t) => {
  const { root, journal } = await fixture(t);
  const contender = new WorkerExecutionOfferFileJournal(root, {
    maximumEntries: 4,
  });
  assert.equal(await journal.acquireOwnership(), 'already_owned');
  await assert.rejects(
    contender.acquireOwnership(),
    (error) =>
      error instanceof WorkerExecutionOfferJournalOwnershipError &&
      error.reason === 'already_owned',
  );
  await assert.rejects(
    contender.list(),
    (error) =>
      error instanceof WorkerExecutionOfferJournalOwnershipError &&
      error.reason === 'not_owned',
  );
  assert.equal(await journal.releaseOwnership(), 'released');
  assert.equal(await contender.acquireOwnership(), 'acquired');
  assert.equal((await contender.list()).records.length, 0);
  assert.equal(await contender.releaseOwnership(), 'released');
  await journal.acquireOwnership();
});

test('requires complete receipt authentication only after the launch barrier', () => {
  const initial = createWorkerExecutionOfferJournalRecord(offer(), START);
  const authentication = createWorkerExecutionCompletionReceiptAuthentication({
    token: COMPLETION_TOKEN,
    callbackSequence: 1,
  });
  assert.throws(
    () =>
      assertWorkerExecutionOfferJournalRecord({
        ...initial,
        completionReceiptCallbackSequence: authentication.callbackSequence,
        completionReceiptTokenDigest: authentication.tokenDigest,
      }),
    /not allowed before launching/,
  );
  assert.throws(
    () =>
      assertWorkerExecutionOfferJournalRecord({
        ...initial,
        revision: 1,
        state: 'launching',
        updatedAtMs: START + 1,
        completionReceiptTokenDigest: authentication.tokenDigest,
      }),
    /metadata must be complete/,
  );
  assert.throws(
    () =>
      assertWorkerExecutionOfferJournalRecord({
        ...initial,
        revision: 1,
        state: 'launching',
        updatedAtMs: START + 1,
        completionReceiptCallbackSequence: 1,
        completionReceiptTokenDigest: 'A'.repeat(64),
      }),
    /TokenDigest is invalid/,
  );
});

test('fails closed immediately when the owner lease is compromised', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-offer-owner-'));
  let compromise;
  const observed = [];
  const journal = new WorkerExecutionOfferFileJournal(root, {
    lockProvider: {
      async acquire(options) {
        compromise = options.onCompromised;
        return async () => undefined;
      },
    },
    onOwnershipCompromised(error) {
      observed.push(error.message);
    },
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await journal.acquireOwnership();
  compromise(new Error('owner heartbeat lost'));
  assert.equal(journal.ownershipState(), 'compromised');
  assert.deepEqual(observed, ['owner heartbeat lost']);
  await assert.rejects(
    journal.list(),
    (error) =>
      error instanceof WorkerExecutionOfferJournalOwnershipError &&
      error.reason === 'compromised',
  );
  assert.equal(await journal.releaseOwnership(), 'compromised');
});

test('rejects stale replacement revisions and never loses the winning state', async (t) => {
  const { journal } = await fixture(t);
  const delivered = offer();
  const initial = createWorkerExecutionOfferJournalRecord(delivered, START);
  await journal.create(initial);
  const starting = {
    ...initial,
    revision: 1,
    state: 'starting_acknowledged',
    updatedAtMs: START + 1,
  };
  await journal.replace(starting, 0);
  await assert.rejects(
    journal.replace({ ...starting, revision: 1, updatedAtMs: START + 2 }, 0),
    WorkerExecutionOfferJournalRevisionError,
  );
  assert.equal(
    (await journal.read(delivered.offerId)).state,
    'starting_acknowledged',
  );
});

test('enforces entry capacity and exposes bounded stable pagination', async (t) => {
  const { journal } = await fixture(t, 2);
  const first = createWorkerExecutionOfferJournalRecord(offer(1), START);
  const second = createWorkerExecutionOfferJournalRecord(offer(2), START);
  const third = createWorkerExecutionOfferJournalRecord(offer(3), START);
  await journal.create(first);
  await journal.create(second);
  await assert.rejects(
    journal.create(third),
    WorkerExecutionOfferJournalCapacityError,
  );

  const page = await journal.list({ limit: 1 });
  assert.equal(page.records.length, 1);
  assert.equal(typeof page.nextAfterOfferId, 'string');
  const next = await journal.list({
    afterOfferId: page.nextAfterOfferId,
    limit: 1,
  });
  assert.equal(next.records.length, 1);
  assert.notEqual(next.records[0].offer.offerId, page.records[0].offer.offerId);
  assert.equal(await journal.remove(page.records[0].offer.offerId), true);
  assert.equal(await journal.create(third), 'created');
});

test('serializes concurrent capacity checks across different offers', async (t) => {
  const { journal } = await fixture(t, 1);
  const records = [
    createWorkerExecutionOfferJournalRecord(offer(11), START),
    createWorkerExecutionOfferJournalRecord(offer(12), START),
  ];
  const results = await Promise.allSettled(
    records.map((value) => journal.create(value)),
  );
  assert.equal(
    results.filter(
      (result) => result.status === 'fulfilled' && result.value === 'created',
    ).length,
    1,
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof WorkerExecutionOfferJournalCapacityError,
    ).length,
    1,
  );
  assert.equal((await journal.list()).records.length, 1);
});

test('fences revision-conditional removal behind an in-flight replacement', async (t) => {
  const { journal } = await fixture(t);
  const initial = createWorkerExecutionOfferJournalRecord(offer(13), START);
  await journal.create(initial);
  const replacement = {
    ...initial,
    revision: 1,
    state: 'starting_acknowledged',
    updatedAtMs: START + 1,
  };
  const originalWrite = journal.writeTemporary.bind(journal);
  let releaseWrite;
  let replacementReached;
  const reached = new Promise((resolve) => {
    replacementReached = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  journal.writeTemporary = async (temporary, value) => {
    if (value.revision === 1) {
      replacementReached();
      await blocked;
    }
    return originalWrite(temporary, value);
  };

  const replacing = journal.replace(replacement, 0);
  await reached;
  const removing = journal.remove(initial.offer.offerId, 0);
  releaseWrite();
  await replacing;
  await assert.rejects(removing, WorkerExecutionOfferJournalRevisionError);
  assert.equal((await journal.read(initial.offer.offerId)).revision, 1);
});

test('waits for accepted mutations before releasing root ownership', async (t) => {
  const { journal } = await fixture(t);
  const initial = createWorkerExecutionOfferJournalRecord(offer(14), START);
  await journal.create(initial);
  const replacement = {
    ...initial,
    revision: 1,
    state: 'starting_acknowledged',
    updatedAtMs: START + 1,
  };
  const originalWrite = journal.writeTemporary.bind(journal);
  let releaseWrite;
  let replacementReached;
  const reached = new Promise((resolve) => {
    replacementReached = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  journal.writeTemporary = async (temporary, value) => {
    if (value.revision === 1) {
      replacementReached();
      await blocked;
    }
    return originalWrite(temporary, value);
  };

  const replacing = journal.replace(replacement, 0);
  await reached;
  let released = false;
  const releasing = journal.releaseOwnership().then((result) => {
    released = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(released, false);
  releaseWrite();
  await replacing;
  assert.equal(await releasing, 'released');
  assert.equal(await journal.acquireOwnership(), 'acquired');
  assert.equal((await journal.read(initial.offer.offerId)).revision, 1);
});
