'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  WorkerCertificateFileStore,
} = require('../dist/credential/workerCertificateStore');
const {
  WorkerCertificateRenewalCoordinator,
} = require('../dist/credential/workerCertificateRenewal');
const {
  createCertificateAuthority,
} = require('./helpers/certificateAuthority.cjs');

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

async function fixture(t) {
  const now = Date.now();
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ql3-worker-renewal-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return {
    now,
    ca: await createCertificateAuthority({ now }),
    store: new WorkerCertificateFileStore({
      rootDirectory: path.join(parent, 'identity'),
    }),
  };
}

function coordinator(options) {
  return new WorkerCertificateRenewalCoordinator({
    workerId: 'worker-renewal-01',
    store: options.store,
    issuer: options.issuer,
    trustAnchors: { load: async () => [options.ca.certificatePem] },
    now: () => options.now,
    random: () => 0,
    policy: {
      renewBeforeMs: HOUR_MS,
      minimumIssuedValidityMs: 2 * HOUR_MS,
      backoffBaseMs: 10_000,
      backoffMaximumMs: 60_000,
    },
  });
}

test('coalesces enrollment and leaves a fresh identity timer-free', async (t) => {
  const context = await fixture(t);
  let issueCalls = 0;
  const renewal = coordinator({
    ...context,
    issuer: {
      async issue({ certificateSigningRequestPem }) {
        issueCalls += 1;
        return {
          certificateChainPem: await context.ca.issue(
            certificateSigningRequestPem,
            { notAfterMs: context.now + 30 * DAY_MS },
          ),
        };
      },
    },
  });

  const firstRun = renewal.run();
  const coalescedRun = renewal.run();
  assert.equal(firstRun, coalescedRun);
  const result = await firstRun;

  assert.equal(result.status, 'renewed');
  assert.equal(issueCalls, 1);
  const next = await renewal.run();
  assert.equal(next.status, 'not_due');
  assert.equal(issueCalls, 1);
});

test('persists bounded backoff and suppresses repeated CA attempts', async (t) => {
  const context = await fixture(t);
  let issueCalls = 0;
  const renewal = coordinator({
    ...context,
    issuer: {
      async issue() {
        issueCalls += 1;
        throw new Error('CA unavailable');
      },
    },
  });

  const failed = await renewal.run();
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.nextAttemptAtMs, context.now + 5_000);
  assert.equal(issueCalls, 1);

  const suppressed = await renewal.run();
  assert.equal(suppressed.status, 'unavailable');
  assert.equal(suppressed.nextAttemptAtMs, context.now + 5_000);
  assert.equal(issueCalls, 1);
  assert.deepEqual(await context.store.readRenewalState(), {
    consecutiveFailures: 1,
    nextAttemptAtMs: context.now + 5_000,
    lastAttemptAtMs: context.now,
    lastSuccessAtMs: null,
  });
});

test('does not convert caller cancellation into a renewal failure', async (t) => {
  const context = await fixture(t);
  const renewal = coordinator({
    ...context,
    issuer: {
      async issue() {
        throw new Error('must not run');
      },
    },
  });
  const controller = new AbortController();
  controller.abort(new Error('shutdown'));

  await assert.rejects(renewal.run(controller.signal), /shutdown/);
  assert.deepEqual(await context.store.readRenewalState(), {
    consecutiveFailures: 0,
    nextAttemptAtMs: null,
    lastAttemptAtMs: null,
    lastSuccessAtMs: null,
  });
});
