'use strict';

const assert = require('node:assert/strict');
const { createHash, X509Certificate } = require('node:crypto');
const test = require('node:test');

const {
  generateWorkerCertificateEnrollment,
} = require('../dist/credential/workerCertificateEnrollment');
const {
  validateWorkerCertificateIdentity,
} = require('../dist/credential/workerCertificateIdentity');
const {
  createCertificateAuthority,
} = require('./helpers/certificateAuthority.cjs');

const HOUR_MS = 60 * 60_000;

async function identityFixture(options = {}) {
  const now = options.now ?? Date.now();
  const ca = await createCertificateAuthority({ now });
  const enrollment = await generateWorkerCertificateEnrollment({
    workerId: 'worker-identity-01',
  });
  const certificateChainPem = await ca.issue(
    enrollment.certificateSigningRequestPem,
    options.issue,
  );
  return { now, ca, enrollment, certificateChainPem };
}

test('validates the leaf identity independently of PEM chain formatting', async () => {
  const fixture = await identityFixture();
  try {
    const summary = validateWorkerCertificateIdentity({
      privateKeyPem: fixture.enrollment.privateKeyPem,
      certificateChainPem: `${fixture.certificateChainPem}\n`,
      trustAnchors: [fixture.ca.certificatePem],
      now: fixture.now,
      minimumRemainingValidityMs: HOUR_MS,
    });
    const leaf = new X509Certificate(fixture.certificateChainPem);

    assert.equal(
      summary.certificateSha256,
      createHash('sha256').update(leaf.raw).digest('hex'),
    );
    assert.equal(
      summary.publicKeySpkiSha256,
      fixture.enrollment.publicKeySpkiSha256,
    );
  } finally {
    fixture.enrollment.dispose();
  }
});

test('fails closed for an untrusted issuer', async () => {
  const fixture = await identityFixture();
  const otherCa = await createCertificateAuthority({ now: fixture.now });
  try {
    assert.throws(
      () =>
        validateWorkerCertificateIdentity({
          privateKeyPem: fixture.enrollment.privateKeyPem,
          certificateChainPem: fixture.certificateChainPem,
          trustAnchors: [otherCa.certificatePem],
          now: fixture.now,
        }),
      (error) => error.reason === 'untrusted',
    );
  } finally {
    fixture.enrollment.dispose();
  }
});

test('rejects expired, short-lived and non-client-auth leaves', async () => {
  const now = Date.now();
  const expired = await identityFixture({
    now,
    issue: { notBeforeMs: now - 2 * HOUR_MS, notAfterMs: now - HOUR_MS },
  });
  const shortLived = await identityFixture({
    now,
    issue: { notAfterMs: now + 2 * HOUR_MS },
  });
  const wrongUsage = await identityFixture({
    now,
    issue: { clientAuth: false },
  });
  try {
    assert.throws(
      () =>
        validateWorkerCertificateIdentity({
          privateKeyPem: expired.enrollment.privateKeyPem,
          certificateChainPem: expired.certificateChainPem,
          trustAnchors: [expired.ca.certificatePem],
          now,
        }),
      (error) => error.reason === 'expired',
    );
    assert.throws(
      () =>
        validateWorkerCertificateIdentity({
          privateKeyPem: shortLived.enrollment.privateKeyPem,
          certificateChainPem: shortLived.certificateChainPem,
          trustAnchors: [shortLived.ca.certificatePem],
          now,
          minimumRemainingValidityMs: 3 * HOUR_MS,
        }),
      (error) => error.reason === 'insufficient_validity',
    );
    assert.throws(
      () =>
        validateWorkerCertificateIdentity({
          privateKeyPem: wrongUsage.enrollment.privateKeyPem,
          certificateChainPem: wrongUsage.certificateChainPem,
          trustAnchors: [wrongUsage.ca.certificatePem],
          now,
        }),
      (error) => error.reason === 'not_client_auth',
    );
  } finally {
    expired.enrollment.dispose();
    shortLived.enrollment.dispose();
    wrongUsage.enrollment.dispose();
  }
});
