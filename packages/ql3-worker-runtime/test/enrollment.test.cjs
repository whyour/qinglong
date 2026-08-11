'use strict';

const assert = require('node:assert/strict');
const { createPublicKey } = require('node:crypto');
const test = require('node:test');

require('reflect-metadata');
const { Pkcs10CertificateRequest } = require('@peculiar/x509');
const {
  generateWorkerCertificateEnrollment,
} = require('../dist/credential/workerCertificateEnrollment');

test('generates a verifiable P-256 CSR and disposable PKCS#8 key', async () => {
  const enrollment = await generateWorkerCertificateEnrollment({
    workerId: 'worker.edge-01',
  });

  try {
    assert.equal(enrollment.algorithm, 'ECDSA_P256_SHA256');
    assert.equal(enrollment.workerId, 'worker.edge-01');
    assert.match(
      enrollment.certificateSigningRequestPem,
      /BEGIN CERTIFICATE REQUEST/,
    );
    assert.equal(enrollment.publicKeySpkiSha256.length, 64);
    assert.equal(
      createPublicKey(enrollment.privateKeyPem).asymmetricKeyType,
      'ec',
    );

    const request = new Pkcs10CertificateRequest(
      enrollment.certificateSigningRequestPem,
    );
    assert.equal(await request.verify(), true);
    assert.equal(request.subject, 'CN=worker.edge-01');
  } finally {
    enrollment.dispose();
  }

  assert.equal(
    enrollment.privateKeyPem.every((byte) => byte === 0),
    true,
  );
});

test('rejects unbounded or unsafe worker identifiers', async () => {
  await assert.rejects(
    generateWorkerCertificateEnrollment({ workerId: '../worker' }),
    /workerId is invalid/,
  );
  await assert.rejects(
    generateWorkerCertificateEnrollment({ workerId: 'x'.repeat(129) }),
    /workerId is invalid/,
  );
});
