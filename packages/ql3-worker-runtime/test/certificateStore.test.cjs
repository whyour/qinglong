'use strict';

const assert = require('node:assert/strict');
const {
  access,
  chmod,
  lstat,
  mkdtemp,
  readdir,
  rm,
} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  generateWorkerCertificateEnrollment,
} = require('../dist/credential/workerCertificateEnrollment');
const {
  WorkerCertificateFileStore,
} = require('../dist/credential/workerCertificateStore');
const {
  createCertificateAuthority,
} = require('./helpers/certificateAuthority.cjs');

async function temporaryStore(t, retainedGenerations = 2) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ql3-worker-store-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return new WorkerCertificateFileStore({
    rootDirectory: path.join(parent, 'identity'),
    retainedGenerations,
  });
}

async function issueIdentity(ca, workerId, now) {
  const enrollment = await generateWorkerCertificateEnrollment({ workerId });
  try {
    return {
      privateKeyPem: Buffer.from(enrollment.privateKeyPem),
      certificateChainPem: await ca.issue(
        enrollment.certificateSigningRequestPem,
      ),
      trustAnchors: [ca.certificatePem],
      now,
    };
  } finally {
    enrollment.dispose();
  }
}

test('atomically installs and revalidates a private Worker identity', async (t) => {
  const now = Date.now();
  const ca = await createCertificateAuthority({ now });
  const store = await temporaryStore(t);
  const input = await issueIdentity(ca, 'worker-01', now);

  try {
    const installed = await store.install(input);
    const active = await store.readActive([ca.certificatePem], now);

    assert.equal(active.certificateSha256, installed.certificateSha256);
    assert.equal(active.publicKeySpkiSha256, installed.publicKeySpkiSha256);
    assert.equal((await lstat(active.privateKeyFile)).mode & 0o777, 0o600);
    assert.equal(
      (await lstat(path.dirname(active.privateKeyFile))).mode & 0o777,
      0o700,
    );
  } finally {
    input.privateKeyPem.fill(0);
  }
});

test('retains only the configured number of complete generations', async (t) => {
  const now = Date.now();
  const ca = await createCertificateAuthority({ now });
  const store = await temporaryStore(t, 1);
  const first = await issueIdentity(ca, 'worker-02', now);
  const second = await issueIdentity(ca, 'worker-02', now + 1_000);

  try {
    const firstInstalled = await store.install(first);
    const secondInstalled = await store.install(second);
    const generations = await readdir(
      path.join(path.dirname(secondInstalled.privateKeyFile), '..'),
    );

    assert.deepEqual(generations, [secondInstalled.generationId]);
    await assert.rejects(access(path.dirname(firstInstalled.privateKeyFile)));
  } finally {
    first.privateKeyPem.fill(0);
    second.privateKeyPem.fill(0);
  }
});

test('rejects a certificate that does not match its private key', async (t) => {
  const now = Date.now();
  const ca = await createCertificateAuthority({ now });
  const store = await temporaryStore(t);
  const left = await issueIdentity(ca, 'worker-left', now);
  const right = await issueIdentity(ca, 'worker-right', now);

  try {
    await assert.rejects(
      store.install({
        ...left,
        privateKeyPem: right.privateKeyPem,
      }),
      /install failed/,
    );
    assert.equal(await store.readActiveSummary(), undefined);
  } finally {
    left.privateKeyPem.fill(0);
    right.privateKeyPem.fill(0);
  }
});

test('rejects active identity files whose private permissions drift', async (t) => {
  const now = Date.now();
  const ca = await createCertificateAuthority({ now });
  const store = await temporaryStore(t);
  const input = await issueIdentity(ca, 'worker-permissions', now);

  try {
    const installed = await store.install(input);
    await chmod(installed.certificateChainFile, 0o644);
    await assert.rejects(
      store.readActive([ca.certificatePem], now),
      /file metadata is unsafe/,
    );
  } finally {
    input.privateKeyPem.fill(0);
  }
});
