const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  POSTGRES_CA_MAX_CERTIFICATES,
  POSTGRES_CA_MAX_FILE_BYTES,
  PostgresCertificateAuthorityFileError,
  inspectPostgresCertificateAuthorityFile,
  loadPostgresCertificateAuthorityFile,
} = require('@qinglong/cluster-postgres/runtime');

const FIXTURES = path.resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls',
);
const CA = fs.readFileSync(path.join(FIXTURES, 'ca-cert.pem'), 'utf8');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-pg-ca-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function expectCode(callback, code) {
  assert.throws(
    callback,
    (error) =>
      error instanceof PostgresCertificateAuthorityFileError &&
      error.code === code,
  );
}

test('loads a bounded CA bundle through a projected-Secret symlink', (t) => {
  const directory = temporaryDirectory(t);
  const dataDirectory = path.join(directory, '..data');
  fs.mkdirSync(dataDirectory);
  fs.writeFileSync(path.join(dataDirectory, 'ca.crt'), CA, { mode: 0o444 });
  fs.symlinkSync(path.join('..data', 'ca.crt'), path.join(directory, 'ca.crt'));

  const bundle = loadPostgresCertificateAuthorityFile(
    path.join(directory, 'ca.crt'),
  );
  assert.match(bundle, /^-----BEGIN CERTIFICATE-----/);
  assert.match(bundle, /-----END CERTIFICATE-----\n$/);

  const inspection = inspectPostgresCertificateAuthorityFile(
    path.join(directory, 'ca.crt'),
  );
  assert.equal(inspection.bundle, bundle);
  assert.equal(inspection.fingerprints256.length, 1);
  assert.match(
    inspection.fingerprints256[0],
    /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/,
  );
  assert.equal(Object.isFrozen(inspection), true);
  assert.equal(Object.isFrozen(inspection.fingerprints256), true);
});

test('rejects ambiguous paths, file types, permissions and sizes', (t) => {
  const directory = temporaryDirectory(t);
  expectCode(
    () => loadPostgresCertificateAuthorityFile('relative-ca.pem'),
    'QL3_POSTGRES_CA_INVALID_PATH',
  );
  expectCode(
    () =>
      loadPostgresCertificateAuthorityFile(path.join(directory, 'missing.pem')),
    'QL3_POSTGRES_CA_UNAVAILABLE',
  );
  expectCode(
    () => loadPostgresCertificateAuthorityFile(directory),
    'QL3_POSTGRES_CA_NOT_REGULAR',
  );

  const writable = path.join(directory, 'writable.pem');
  fs.writeFileSync(writable, CA, { mode: 0o666 });
  fs.chmodSync(writable, 0o666);
  expectCode(
    () => loadPostgresCertificateAuthorityFile(writable),
    'QL3_POSTGRES_CA_INSECURE_PERMISSIONS',
  );

  const oversized = path.join(directory, 'oversized.pem');
  fs.writeFileSync(oversized, Buffer.alloc(POSTGRES_CA_MAX_FILE_BYTES + 1), {
    mode: 0o444,
  });
  expectCode(
    () => loadPostgresCertificateAuthorityFile(oversized),
    'QL3_POSTGRES_CA_INVALID_SIZE',
  );
});

test('rejects malformed, non-CA, duplicate and oversized bundles', (t) => {
  const directory = temporaryDirectory(t);
  const malformed = path.join(directory, 'malformed.pem');
  fs.writeFileSync(malformed, `${CA}\nunreviewed`, { mode: 0o444 });
  expectCode(
    () => loadPostgresCertificateAuthorityFile(malformed),
    'QL3_POSTGRES_CA_INVALID_PEM',
  );

  const nonCa = path.join(directory, 'non-ca.pem');
  fs.copyFileSync(path.join(FIXTURES, 'server-cert.pem'), nonCa);
  fs.chmodSync(nonCa, 0o444);
  expectCode(
    () => loadPostgresCertificateAuthorityFile(nonCa),
    'QL3_POSTGRES_CA_NOT_CA',
  );

  const duplicate = path.join(directory, 'duplicate.pem');
  fs.writeFileSync(duplicate, `${CA}\n${CA}`, { mode: 0o444 });
  expectCode(
    () => loadPostgresCertificateAuthorityFile(duplicate),
    'QL3_POSTGRES_CA_DUPLICATE_CERTIFICATE',
  );

  const tooMany = path.join(directory, 'too-many.pem');
  fs.writeFileSync(
    tooMany,
    Array.from({ length: POSTGRES_CA_MAX_CERTIFICATES + 1 }, () => CA).join(
      '\n',
    ),
    { mode: 0o444 },
  );
  expectCode(
    () => loadPostgresCertificateAuthorityFile(tooMany),
    'QL3_POSTGRES_CA_TOO_MANY_CERTIFICATES',
  );
});
