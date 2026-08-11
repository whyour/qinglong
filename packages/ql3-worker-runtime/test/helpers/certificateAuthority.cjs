'use strict';

require('reflect-metadata');

const { randomBytes, webcrypto } = require('node:crypto');
const {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  Pkcs10CertificateRequest,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
} = require('@peculiar/x509');

const algorithm = Object.freeze({
  name: 'ECDSA',
  namedCurve: 'P-256',
  hash: 'SHA-256',
});

async function createCertificateAuthority(options = {}) {
  const now = options.now ?? Date.now();
  const keys = await webcrypto.subtle.generateKey(algorithm, true, [
    'sign',
    'verify',
  ]);
  const name = 'CN=QingLong Worker Test CA';
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: randomBytes(16).toString('hex'),
      name,
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + 365 * 24 * 60 * 60_000),
      signingAlgorithm: algorithm,
      keys,
      extensions: [
        new BasicConstraintsExtension(true, 1, true),
        new KeyUsagesExtension(
          KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign,
          true,
        ),
        await SubjectKeyIdentifierExtension.create(
          keys.publicKey,
          false,
          webcrypto,
        ),
      ],
    },
    webcrypto,
  );

  return Object.freeze({
    certificatePem: certificate.toString('pem'),
    async issue(certificateSigningRequestPem, issueOptions = {}) {
      const request = new Pkcs10CertificateRequest(
        certificateSigningRequestPem,
      );
      if (!(await request.verify(webcrypto))) {
        throw new Error('test CSR signature is invalid');
      }
      const notBeforeMs = issueOptions.notBeforeMs ?? now - 60_000;
      const notAfterMs = issueOptions.notAfterMs ?? now + 30 * 24 * 60 * 60_000;
      const extensions = [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        await SubjectKeyIdentifierExtension.create(
          request.publicKey,
          false,
          webcrypto,
        ),
      ];
      if (issueOptions.clientAuth !== false) {
        extensions.splice(
          1,
          0,
          new ExtendedKeyUsageExtension([ExtendedKeyUsage.clientAuth], true),
        );
      }
      const leaf = await X509CertificateGenerator.create(
        {
          serialNumber: randomBytes(16).toString('hex'),
          subject: request.subject,
          issuer: name,
          notBefore: new Date(notBeforeMs),
          notAfter: new Date(notAfterMs),
          signingAlgorithm: algorithm,
          publicKey: request.publicKey,
          signingKey: keys.privateKey,
          extensions,
        },
        webcrypto,
      );
      return leaf.toString('pem');
    },
  });
}

module.exports = { createCertificateAuthority };
