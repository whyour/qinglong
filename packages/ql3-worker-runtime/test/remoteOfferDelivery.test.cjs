'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, lstat, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  createClusterTaskExecutionRevision,
} = require('@qinglong/runtime-core/cluster-execution-revision');
const {
  createClusterRemoteExecutionOffer,
} = require('@qinglong/runtime-core/remote-dispatch');
const {
  createRemoteExecutionOfferPullBody,
} = require('@qinglong/runtime-core/remote-offer-delivery');
const {
  digestRunDispatchLeaseToken,
} = require('@qinglong/runtime-core');
const {
  WorkerRemoteOfferFileJournal,
  WorkerRemoteOfferPullCoordinator,
  createWorkerRemoteOfferClaimRecord,
  normalizeWorkerRemoteExecutionInboxRecord,
} = require('../dist/remote-execution/remoteOfferDeliveryEntrypoint');

const SESSION = '018f0000-0000-7000-8000-000000000001';
const SOURCE_DIGEST = 'a'.repeat(64);
const TASK_REVISION = `qltd:v1:1:${SOURCE_DIGEST}`;
const STATS = Object.freeze({
  pages: 1,
  candidates: 1,
  plansUnavailable: 0,
  placementMismatches: 0,
  claimAttempts: 1,
  claimRaces: 0,
});

const session = Object.freeze({
  workerId: 'edge-1',
  sessionId: SESSION,
  generation: 2,
});

function executionRevision() {
  return createClusterTaskExecutionRevision({
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: TASK_REVISION,
    sourceRevision: 1,
    sourceContentDigest: SOURCE_DIGEST,
    executorType: 'remote_worker',
    planSchema: 'qinglong/command-execution@v1',
    command: { kind: 'argv', file: '/bin/true', args: [] },
    environment: [],
    createdAtMs: 1,
  });
}

function offerFromRequest(request, version = 0) {
  const revision = executionRevision();
  return createClusterRemoteExecutionOffer({
    offerId: request.body.offerId,
    deliveryKind: version === 0 ? 'new_claim' : 'lease_recovery',
    executionDigest: revision.contentDigest,
    candidate: {
      runId: 'run-1',
      attemptId: 'attempt-1',
      projectId: 'project-1',
      taskId: 'task-1',
      taskRevision: TASK_REVISION,
      priority: 1,
      queuedAtMs: 10,
      attemptCreatedAtMs: 11,
      attemptNumber: 1,
      executorType: 'remote_worker',
    },
    worker: {
      workerId: session.workerId,
      sessionId: session.sessionId,
      generation: session.generation,
    },
    lease: {
      attemptId: 'attempt-1',
      runId: 'run-1',
      status: 'leased',
      version,
      leaseGeneration: 1,
      workerId: session.workerId,
      workerSessionId: session.sessionId,
      workerGeneration: session.generation,
      leaseTokenDigest: digestRunDispatchLeaseToken(request.body.leaseToken),
      acquiredAtMs: 20,
      renewedAtMs: 20 + version,
      expiresAtMs: 30_020 + version,
      updatedAtMs: 20 + version,
    },
    leaseToken: request.body.leaseToken,
    executionRevision: revision,
    placementScore: 0,
  });
}

async function journalFixture(t, maximumEntries = 64) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ql3-worker-offer-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const rootDirectory = path.join(parent, 'inbox');
  const journal = new WorkerRemoteOfferFileJournal({
    rootDirectory,
    maximumEntries,
    ownershipStaleMs: 5_000,
  });
  await journal.acquireOwnership();
  t.after(() => journal.releaseOwnership().catch(() => undefined));
  return { journal, rootDirectory };
}

test('persists the claim intent and accepted capability in private atomic files', async (t) => {
  const { journal, rootDirectory } = await journalFixture(t);
  const claim = createWorkerRemoteOfferClaimRecord({
    workerId: session.workerId,
    workerSessionId: session.sessionId,
    workerGeneration: session.generation,
    offerId: 'offer-1',
    leaseToken: 'worker_generated_lease_capability_0000000000000001',
  }, 1_000);
  await journal.createPendingClaim(claim);
  assert.equal((await journal.readPendingClaim()).offerId, 'offer-1');

  const request = {
    body: {
      offerId: claim.offerId,
      leaseToken: claim.leaseToken,
    },
  };
  const accepted = await journal.acceptOffer(offerFromRequest(request), 1_001);
  assert.equal(accepted.status, 'accepted');
  const replayed = await journal.acceptOffer(offerFromRequest(request), 1_002);
  assert.equal(replayed.status, 'replayed');
  assert.equal(replayed.record.revision, 0);
  assert.equal(
    (await lstat(path.join(rootDirectory, 'offers', 'offer-1.json'))).mode & 0o777,
    0o600,
  );
  assert.equal((await lstat(rootDirectory)).mode & 0o777, 0o700);
});

test('uses one revision-fenced inbox record through ACK and spawn barriers', async (t) => {
  const { journal } = await journalFixture(t);
  const request = {
    body: {
      offerId: 'offer-state-machine-1',
      leaseToken: 'worker_generated_lease_capability_0000000000000002',
    },
  };
  let record = (await journal.acceptOffer(offerFromRequest(request), 1_000)).record;
  assert.equal(record.state, 'accepted');

  const advance = async (patch) => {
    const next = normalizeWorkerRemoteExecutionInboxRecord({
      ...record,
      ...patch,
      revision: record.revision + 1,
      updatedAtMs: record.updatedAtMs + 1,
    });
    await journal.replaceOffer(next, record.revision);
    record = await journal.readOffer(record.offer.offerId);
  };

  await advance({ state: 'starting_acknowledged' });
  await advance({
    state: 'launching',
    executorStartedAtMs: 1_002,
    logArtifactId: 'log-artifact-1',
    completionReceiptCallbackSequence: 1,
    completionReceiptTokenDigest: 'b'.repeat(64),
  });
  await advance({
    state: 'started',
    executorHandle: 'pid:123:boot:abc',
    executorStartedAtMs: 1_002,
    logArtifactId: 'log-artifact-1',
  });
  await advance({ state: 'running_acknowledged' });

  assert.equal(record.state, 'running_acknowledged');
  assert.equal(record.revision, 4);
  assert.equal(record.offer.leaseToken, request.body.leaseToken);
  assert.equal(record.executorHandle, 'pid:123:boot:abc');
  assert.equal(record.completionReceiptTokenDigest, 'b'.repeat(64));

  const regressed = normalizeWorkerRemoteExecutionInboxRecord({
    schemaVersion: 1,
    revision: record.revision + 1,
    state: 'starting_acknowledged',
    offer: record.offer,
    acceptedAtMs: record.acceptedAtMs,
    updatedAtMs: record.updatedAtMs + 1,
  });
  await assert.rejects(
    journal.replaceOffer(regressed, record.revision),
    /invalid_transition/,
  );
  await assert.rejects(
    journal.replaceOffer({ ...record, revision: record.revision + 2 }, record.revision),
    /offer_revision_conflict/,
  );
  assert.equal((await journal.readOffer(record.offer.offerId)).revision, 4);
});

test('lists the single execution inbox authority with a stable bounded cursor', async (t) => {
  const { journal } = await journalFixture(t);
  for (const offerId of ['offer-page-a', 'offer-page-b', 'offer-page-c']) {
    await journal.acceptOffer(offerFromRequest({
      body: {
        offerId,
        leaseToken: `worker_generated_lease_capability_${offerId}`,
      },
    }), 1_000);
  }
  const first = await journal.listOffers({ limit: 2 });
  assert.deepEqual(
    first.records.map((record) => record.offer.offerId),
    ['offer-page-a', 'offer-page-b'],
  );
  assert.equal(first.nextAfterOfferId, 'offer-page-b');
  const second = await journal.listOffers({
    afterOfferId: first.nextAfterOfferId,
    limit: 2,
  });
  assert.deepEqual(
    second.records.map((record) => record.offer.offerId),
    ['offer-page-c'],
  );
  assert.equal(second.nextAfterOfferId, undefined);
  await assert.rejects(journal.listOffers({ limit: 65 }), /invalid_configuration/);
});

test('keeps one stable claim through transport loss, bounded backoff and restart', async (t) => {
  const { journal, rootDirectory } = await journalFixture(t);
  let now = 1_000;
  const firstRequests = [];
  const first = new WorkerRemoteOfferPullCoordinator({
    journal,
    currentSession: () => session,
    now: () => now,
    random: () => 0.5,
    backoffBaseMs: 1_000,
    transport: {
      async exchange(request) {
        firstRequests.push(request);
        throw new Error('response lost');
      },
    },
  });
  const unavailable = await first.pull(session);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.nextAttemptAtMs, 1_500);
  assert.equal(firstRequests.length, 1);

  now = 1_400;
  const suppressed = await first.pull(session);
  assert.equal(suppressed.status, 'backoff');
  assert.equal(firstRequests.length, 1);

  await journal.releaseOwnership();
  const resumedJournal = new WorkerRemoteOfferFileJournal({
    rootDirectory,
    ownershipStaleMs: 5_000,
  });
  await resumedJournal.acquireOwnership();
  t.after(() => resumedJournal.releaseOwnership().catch(() => undefined));
  now = 1_500;
  let resumedRequest;
  const resumed = new WorkerRemoteOfferPullCoordinator({
    journal: resumedJournal,
    currentSession: () => session,
    now: () => now,
    random: () => 0,
    transport: {
      async exchange(request) {
        resumedRequest = request;
        return JSON.stringify(createRemoteExecutionOfferPullBody({
          status: 'offered',
          offer: offerFromRequest(request),
          stats: STATS,
          truncated: false,
        }));
      },
    },
  });
  const result = await resumed.pull(session);
  assert.equal(result.status, 'accepted');
  assert.equal(resumedRequest.body.offerId, firstRequests[0].body.offerId);
  assert.equal(resumedRequest.body.leaseToken, firstRequests[0].body.leaseToken);
  assert.equal(await resumedJournal.readPendingClaim(), undefined);
  assert.equal(
    (await resumedJournal.readOffer(resumedRequest.body.offerId)).offer.leaseToken,
    resumedRequest.body.leaseToken,
  );
});

test('writes the inbox before clearing the pending claim and rejects target drift', async (t) => {
  const events = [];
  let stored;
  let pending;
  const journal = {
    async readPendingClaim() { return pending; },
    async createPendingClaim(record) { pending = record; return record; },
    async replacePendingClaim(record) { pending = record; return record; },
    async clearPendingClaim() { events.push('clear'); pending = undefined; },
    async acceptOffer(offer, acceptedAtMs) {
      events.push('accept');
      stored = { schemaVersion: 1, revision: 0, state: 'accepted', offer, acceptedAtMs, updatedAtMs: acceptedAtMs };
      return { status: 'accepted', record: stored };
    },
    async readOffer() { return stored; },
  };
  const coordinator = new WorkerRemoteOfferPullCoordinator({
    journal,
    currentSession: () => session,
    now: () => 1_000,
    transport: {
      async exchange(request) {
        return JSON.stringify(createRemoteExecutionOfferPullBody({
          status: 'offered',
          offer: offerFromRequest(request),
          stats: STATS,
          truncated: false,
        }));
      },
    },
  });
  assert.equal((await coordinator.pull(session)).status, 'accepted');
  assert.deepEqual(events, ['accept', 'clear']);
});

test('retains the old claim without accepting when the current Session changes', async () => {
  let current = session;
  let pending;
  let accepted = false;
  const journal = {
    async readPendingClaim() { return pending; },
    async createPendingClaim(record) { pending = record; return record; },
    async replacePendingClaim(record) { pending = record; return record; },
    async clearPendingClaim() { pending = undefined; },
    async acceptOffer() { accepted = true; throw new Error('must not accept'); },
    async readOffer() { return undefined; },
  };
  const coordinator = new WorkerRemoteOfferPullCoordinator({
    journal,
    currentSession: () => current,
    now: () => 1_000,
    random: () => 0,
    transport: {
      async exchange(request) {
        current = { ...session, generation: 3 };
        return JSON.stringify(createRemoteExecutionOfferPullBody({
          status: 'offered',
          offer: offerFromRequest(request),
          stats: STATS,
          truncated: false,
        }));
      },
    },
  });
  const result = await coordinator.pull(session);
  assert.equal(result.status, 'unavailable');
  assert.equal(accepted, false);
  assert.equal(pending.workerGeneration, 2);
});
