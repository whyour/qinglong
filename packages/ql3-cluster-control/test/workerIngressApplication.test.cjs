const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  startClusterWorkerIngressApplication,
} = require('@qinglong/cluster-control/worker-ingress');

const FIXTURES = path.join(__dirname, 'fixtures', 'mtls');
const MUTUAL_TLS = Object.freeze({
  privateKey: readFileSync(path.join(FIXTURES, 'server-key.pem')),
  certificateChain: readFileSync(path.join(FIXTURES, 'server-cert.pem')),
  clientCertificateAuthorities: Object.freeze([
    readFileSync(path.join(FIXTURES, 'ca-cert.pem')),
  ]),
});
const EVIDENCE = Object.freeze({
  contractName: 'control-core',
  contractVersion: 14,
  serverMajor: 16,
  migrationIds: Object.freeze([]),
});

test('enabled Worker ingress rejects plaintext before binding or opening storage', async () => {
  let databaseOpens = 0;
  await assert.rejects(
    startClusterWorkerIngressApplication({
      enabled: true,
      profile: 'cluster-control',
      workerCredentialPepper: 'A'.repeat(43),
      openDatabase: async () => {
        databaseOpens += 1;
        throw new Error('must not open');
      },
      create() {
        throw new Error('must not assemble');
      },
      http: { host: '127.0.0.1', port: 0 },
    }),
    /requires mutual TLS/,
  );
  assert.equal(databaseOpens, 0);
});

test('exposes explicit transport reload only for an active mTLS ingress', async (t) => {
  let databaseCloses = 0;
  const application = await startClusterWorkerIngressApplication({
    enabled: true,
    profile: 'cluster-control',
    workerCredentialPepper: 'A'.repeat(43),
    openDatabase: async () => ({
      client: {},
      async close() {
        databaseCloses += 1;
      },
    }),
    create() {
      return {
        evidence: EVIDENCE,
        pipeline: {
          async prepare() {
            return {
              handle() {
                return { statusCode: 204 };
              },
            };
          },
        },
      };
    },
    http: {
      host: '127.0.0.1',
      port: 0,
      mutualTls: MUTUAL_TLS,
    },
  });
  t.after(() => application.stop());

  assert.equal(application.status, 'active');
  assert.equal(application.reloadTransport(MUTUAL_TLS), 2);
  assert.equal(await application.stop(), 'stopped');
  assert.equal(databaseCloses, 1);
});
