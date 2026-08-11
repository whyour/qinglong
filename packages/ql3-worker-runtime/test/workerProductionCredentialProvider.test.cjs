'use strict';

const assert = require('node:assert/strict');
const {
  chmod,
  mkdtemp,
  rename,
  rm,
  writeFile,
} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  generateWorkerCertificateEnrollment,
} = require('../dist/credential/workerCertificateEnrollment');
const {
  WorkerCertificateFileStore,
} = require('../dist/credential/workerCertificateStore');
const {
  WorkerProductionCredentialProvider,
} = require('../dist/credential/workerProductionCredentialProvider');
const {
  createCertificateAuthority,
} = require('./helpers/certificateAuthority.cjs');

function ql3w(credentialId, fill) {
  return `ql3w_${credentialId}_${Buffer.alloc(32, fill).toString('base64url')}`;
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

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ql3-worker-credentials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const ca = await createCertificateAuthority({ now });
  const store = new WorkerCertificateFileStore({
    rootDirectory: path.join(root, 'identity'),
  });
  const identity = await issueIdentity(ca, 'edge-1', now);
  await store.install(identity);
  identity.privateKeyPem.fill(0);
  const tokenFile = path.join(root, 'worker-token');
  await writeFile(tokenFile, `${ql3w('worker_primary', 7)}\n`, { mode: 0o600 });
  let trustLoads = 0;
  const provider = new WorkerProductionCredentialProvider({
    certificateStore: store,
    trustAnchors: {
      async load() {
        trustLoads += 1;
        return [ca.certificatePem];
      },
    },
    credentialTokenFile: tokenFile,
    expectedCredentialId: 'worker_primary',
    now: () => now,
  });
  return { root, now, ca, store, tokenFile, provider, trustLoads: () => trustLoads };
}

test('loads and disposes the current certificate and ql3w generations', async (t) => {
  const context = await fixture(t);
  const first = await context.provider.load();
  const firstCertificate = Buffer.from(first.certificateChainPem);
  assert.equal(first.authorization, `Worker ${ql3w('worker_primary', 7)}`);
  assert.equal(Buffer.isBuffer(first.privateKeyPem), true);
  first.dispose();
  assert.equal(
    first.privateKeyPem.equals(Buffer.alloc(first.privateKeyPem.length)),
    true,
  );
  assert.equal(
    first.certificateChainPem.equals(
      Buffer.alloc(first.certificateChainPem.length),
    ),
    true,
  );

  const replacement = `${context.tokenFile}.next`;
  await writeFile(replacement, `${ql3w('worker_primary', 8)}\n`, {
    mode: 0o600,
  });
  await rename(replacement, context.tokenFile);
  const secondIdentity = await issueIdentity(
    context.ca,
    'edge-1',
    context.now + 1_000,
  );
  await context.store.install(secondIdentity);
  secondIdentity.privateKeyPem.fill(0);

  const second = await context.provider.load();
  try {
    assert.equal(second.authorization, `Worker ${ql3w('worker_primary', 8)}`);
    assert.equal(
      firstCertificate.equals(second.certificateChainPem),
      false,
    );
    assert.equal(context.trustLoads(), 2);
  } finally {
    firstCertificate.fill(0);
    second.dispose();
  }
});

test('fails closed for token identity drift and broad file permissions', async (t) => {
  const context = await fixture(t);
  const drifted = new WorkerProductionCredentialProvider({
    certificateStore: context.store,
    trustAnchors: { async load() { return [context.ca.certificatePem]; } },
    credentialTokenFile: context.tokenFile,
    expectedCredentialId: 'different_credential',
    now: () => context.now,
  });
  await assert.rejects(drifted.load(), /credentials_unavailable/);

  await chmod(context.tokenFile, 0o644);
  await assert.rejects(context.provider.load(), /credentials_unavailable/);
});

test('honors pre-abort before reading trust, certificate or token authority', async () => {
  let reads = 0;
  const provider = new WorkerProductionCredentialProvider({
    certificateStore: {
      async readActive() { reads += 1; throw new Error('not reached'); },
    },
    trustAnchors: {
      async load() { reads += 1; throw new Error('not reached'); },
    },
    credentialTokenFile: '/private/ql3-worker-token',
  });
  const controller = new AbortController();
  const reason = new Error('cancelled');
  controller.abort(reason);
  await assert.rejects(provider.load(controller.signal), reason);
  assert.equal(reads, 0);
});

test('rejects unsafe token paths and credential identifiers at construction', () => {
  const base = {
    certificateStore: { async readActive() { return undefined; } },
    trustAnchors: { async load() { return []; } },
  };
  assert.throws(
    () => new WorkerProductionCredentialProvider({
      ...base,
      credentialTokenFile: 'relative-token',
    }),
    /invalid_configuration/,
  );
  assert.throws(
    () => new WorkerProductionCredentialProvider({
      ...base,
      credentialTokenFile: '/private/ql3-worker-token',
      expectedCredentialId: 'invalid id',
    }),
    /invalid_configuration/,
  );
});
