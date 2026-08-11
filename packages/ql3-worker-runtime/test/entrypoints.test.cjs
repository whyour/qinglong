'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('main entrypoint leaves enrollment PKI out of steady-state memory', () => {
  const before = new Set(Object.keys(require.cache));
  const runtime = require('../dist');
  const loaded = Object.keys(require.cache).filter((file) => !before.has(file));

  assert.equal(typeof runtime.WorkerCertificateFileStore, 'function');
  assert.equal(typeof runtime.WorkerCertificateRenewalCoordinator, 'function');
  assert.equal(
    loaded.some(
      (file) =>
        file.includes('/@peculiar/x509/') || file.includes('/@peculiar+x509@'),
    ),
    false,
  );
  assert.equal(
    loaded.some((file) => file.includes('/ql3-runtime-core/')),
    false,
  );
});

test('offer delivery subpath avoids runtime root and cluster/database modules', () => {
  const before = new Set(Object.keys(require.cache));
  const delivery = require('../dist/remote-execution/remoteOfferDeliveryEntrypoint');
  const loaded = Object.keys(require.cache).filter((file) => !before.has(file));

  assert.equal(typeof delivery.WorkerRemoteOfferPullCoordinator, 'function');
  assert.equal(typeof delivery.WorkerRemoteOfferHttpsTransport, 'function');
  assert.equal(typeof delivery.WorkerRemoteSecretHttpsProvider, 'function');
  assert.equal(
    loaded.some((file) => /ql3-runtime-core\/dist\/index\.js$/.test(file)),
    false,
  );
  assert.equal(
    loaded.some(
      (file) =>
        file.includes('/ql3-cluster-') ||
        file.includes('/pg/') ||
        file.includes('/drizzle-orm/') ||
        file.includes('/croner/') ||
        file.includes('/semver/'),
    ),
    false,
  );
});
