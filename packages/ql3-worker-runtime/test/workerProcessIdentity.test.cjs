'use strict';

const assert = require('node:assert/strict');
const {
  chmod,
  copyFile,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  WorkerProcessIdentityError,
  createWorkerProcessCredentialProvider,
} = require('@qinglong/worker-runtime/process-identity');

const FIXTURES = path.resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls',
);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ql3-worker-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const privateKeyFile = path.join(root, 'client-key.pem');
  const certificateChainFile = path.join(root, 'client-cert.pem');
  const trustAnchorFile = path.join(root, 'ca-cert.pem');
  const credentialTokenFile = path.join(root, 'credential-token');
  await Promise.all([
    copyFile(path.join(FIXTURES, 'client-key.pem'), privateKeyFile),
    copyFile(path.join(FIXTURES, 'client-cert.pem'), certificateChainFile),
    copyFile(path.join(FIXTURES, 'ca-cert.pem'), trustAnchorFile),
    writeFile(
      credentialTokenFile,
      `ql3w_worker_primary_${Buffer.alloc(32, 7).toString('base64url')}\n`,
    ),
  ]);
  await Promise.all([
    chmod(privateKeyFile, 0o600),
    chmod(certificateChainFile, 0o444),
    chmod(trustAnchorFile, 0o444),
    chmod(credentialTokenFile, 0o600),
  ]);
  return {
    root,
    config: {
      certificateStoreRoot: path.join(root, 'store'),
      trustAnchorFile,
      credentialTokenFile,
      expectedCredentialId: 'worker_primary',
      bootstrap: {
        privateKeyFile,
        certificateChainFile,
      },
    },
  };
}

test('bootstraps one durable identity and returns disposable request credentials', async (t) => {
  const current = await fixture(t);
  const provider = await createWorkerProcessCredentialProvider(
    current.config,
  );
  const first = await provider.load();
  assert.match(first.authorization, /^Worker ql3w_worker_primary_/);
  assert.equal(Buffer.isBuffer(first.privateKeyPem), true);
  assert.equal(Buffer.isBuffer(first.certificateChainPem), true);
  assert.equal(first.trustAnchors.length, 1);
  first.dispose();

  const generations = await readdir(
    path.join(current.config.certificateStoreRoot, 'generations'),
  );
  assert.equal(generations.length, 1);
  const reloaded = await createWorkerProcessCredentialProvider(
    current.config,
  );
  const afterReload = await reloaded.load();
  afterReload.dispose();
  assert.equal(
    (
      await readdir(
        path.join(current.config.certificateStoreRoot, 'generations'),
      )
    ).length,
    1,
  );
});

test('fails closed for unsafe bootstrap material or absent active identity', async (t) => {
  const current = await fixture(t);
  await chmod(current.config.bootstrap.privateKeyFile, 0o644);
  await assert.rejects(
    createWorkerProcessCredentialProvider(current.config),
    WorkerProcessIdentityError,
  );
  await assert.rejects(
    createWorkerProcessCredentialProvider({
      certificateStoreRoot: path.join(current.root, 'empty-store'),
      trustAnchorFile: current.config.trustAnchorFile,
      credentialTokenFile: current.config.credentialTokenFile,
    }),
    WorkerProcessIdentityError,
  );
});
