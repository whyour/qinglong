'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerExecutionCapacityOracle,
} = require('../dist/session/workerExecutionCapacityOracle');

function record(offerId, state) {
  return { state, offer: { offerId } };
}

function fixture(records = [], pending) {
  const journal = {
    async listOffers() {
      return { records, nextAfterOfferId: undefined };
    },
    async readPendingClaim() { return pending; },
  };
  return new WorkerExecutionCapacityOracle({
    journal,
    maxConcurrentRuns: 4,
  });
}

test('publishes zero until startup reconciliation authorizes registration', async () => {
  const oracle = fixture();
  assert.equal(oracle.mode(), 'reconciling');
  assert.equal(await oracle.availableSlots(), 0);
  oracle.prepareRegistration();
  assert.equal(await oracle.availableSlots(), 4);
  oracle.activate();
  assert.equal(await oracle.availableSlots(), 4);
});

test('subtracts durable active records and the current pull reservation', async () => {
  const oracle = fixture([
    record('offer-1', 'running_acknowledged'),
    record('offer-2', 'completion_acknowledged'),
  ], { offerId: 'offer-3' });
  oracle.prepareRegistration();
  assert.equal(await oracle.availableSlots(), 2);
});

test('does not double count a reservation already admitted to the inbox', async () => {
  const oracle = fixture([
    record('offer-1', 'accepted'),
  ], { offerId: 'offer-1' });
  oracle.prepareRegistration();
  assert.equal(await oracle.availableSlots(), 3);
});

test('fails closed on recovery and remains zero throughout drain', async () => {
  const recovery = fixture([record('offer-1', 'recovery_required')]);
  recovery.prepareRegistration();
  assert.equal(await recovery.availableSlots(), 0);
  assert.equal(recovery.mode(), 'recovery_required');

  const draining = fixture();
  draining.prepareRegistration();
  draining.activate();
  draining.beginDrain();
  assert.equal(await draining.availableSlots(), 0);
  draining.offline();
  assert.equal(await draining.availableSlots(), 0);
  draining.beginDrain();
  draining.offline();
  assert.equal(draining.mode(), 'offline');
});
