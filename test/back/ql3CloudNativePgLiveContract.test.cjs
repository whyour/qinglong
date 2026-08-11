const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  imageDigest,
  imageTag,
  localApplicationManifest,
  manifestSha256,
  reviewedOperatorManifest,
  verifyImageIds,
} = require('../../scripts/ql3-cloudnativepg-live-contract.cjs');

const INDEX = `sha256:${'a'.repeat(64)}`;
const PLATFORM = `sha256:${'b'.repeat(64)}`;

function pods(...imageIds) {
  return imageIds.map((imageID) => ({
    status: { containerStatuses: [{ imageID }] },
  }));
}

test('extracts only one exact digest-pinned image reference', () => {
  assert.equal(
    imageDigest(`registry.example/operand:18.4@${INDEX}`),
    INDEX,
  );
  assert.throws(() => imageDigest('registry.example/operand:18.4'));
  assert.throws(() => imageDigest(`registry.example/operand@${INDEX}:tag`));
});

test('derives a normal tagged preload reference from a reviewed image', () => {
  assert.equal(
    imageTag(`registry.example:5000/operand:18.4@${INDEX}`),
    'registry.example:5000/operand:18.4',
  );
  assert.throws(() => imageTag(`registry.example/operand@${INDEX}`));
  assert.throws(() => imageTag('registry.example/operand:18.4'));
});

test('replaces exactly one fail-closed application image only in live rendering', () => {
  const placeholder = `registry.example.com/qinglong/qinglong3-cluster-control@sha256:${'0'.repeat(64)}`;
  const rendered = `kind: Deployment\nspec:\n  image: ${placeholder}\n`;
  assert.equal(
    localApplicationManifest(rendered),
    'kind: Deployment\nspec:\n  image: registry.example.com/qinglong/qinglong3-cluster-control:3.0.0-alpha.0\n',
  );
  assert.throws(() => localApplicationManifest('kind: Deployment\n'));
  assert.throws(() =>
    localApplicationManifest(`${rendered}---\n${rendered}`),
  );
});

test('accepts uniform runtime reporting of the reviewed index or platform digest', () => {
  assert.deepEqual(
    verifyImageIds(
      pods(`registry.example/operand@${INDEX}`),
      [INDEX, PLATFORM],
      'operand',
    ),
    [`registry.example/operand@${INDEX}`],
  );
  assert.deepEqual(
    verifyImageIds(
      pods(`registry.example/operand@${PLATFORM}`),
      [INDEX, PLATFORM],
      'operand',
    ),
    [`registry.example/operand@${PLATFORM}`],
  );
});

test('rejects tags, unknown digests, missing status and widened reviewed sets', () => {
  for (const invoke of [
    () => verifyImageIds(pods('registry.example/operand:18.4'), [INDEX], 'operand'),
    () =>
      verifyImageIds(
        pods(`registry.example/operand@sha256:${'c'.repeat(64)}`),
        [INDEX, PLATFORM],
        'operand',
      ),
    () => verifyImageIds([{ status: {} }], [INDEX], 'operand'),
    () => verifyImageIds(pods(`registry.example/operand@${INDEX}`), ['*'], 'operand'),
  ]) {
    assert.throws(invoke);
  }
});

test('creates the namespaced control identity before the migration Job', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/ql3-cloudnativepg-live-contract.cjs'),
    'utf8',
  );
  const namespace = source.indexOf(
    "'deploy/kubernetes/ql3-cluster/base/namespace.yaml'",
  );
  const serviceAccount = source.indexOf(
    "'deploy/kubernetes/ql3-cluster/base/service-account.yaml'",
  );
  const migration = source.indexOf(
    "'deploy/kubernetes/ql3-cluster/operations/cloudnative-pg'",
  );
  assert.ok(namespace >= 0);
  assert.ok(serviceAccount > namespace);
  assert.ok(migration > serviceAccount);
  assert.match(
    source.slice(namespace, serviceAccount),
    /kubectl\(\[/,
  );
  assert.match(
    source.slice(namespace, migration),
    /'-n',\s*NAMESPACE,\s*'apply',\s*'-f',\s*'deploy\/kubernetes\/ql3-cluster\/base\/service-account\.yaml'/,
  );
});

test('provisions the fail-closed worker ingress identity and derives all role evidence from one set', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/ql3-cloudnativepg-live-contract.cjs'),
    'utf8',
  );
  assert.match(source, /const roleList = ROLE_NAMES\.map/);
  assert.match(source, /WHERE rolname IN \(\$\{roleList\}\)/);
  assert.match(source, /assert\.deepEqual\(schema, \['53', '52'\]\)/);
  assert.match(source, /migrationCount: 54/);
  assert.match(source, /contractVersion: 53/);
  assert.match(source, /createWorkerIngressTls\(tempDirectory\)/);
  for (const key of [
    'worker-credential-pepper',
    'artifact-s3-bucket',
    'artifact-s3-region',
    'artifact-s3-encryption',
    'tls.key',
    'tls.crt',
    'client-ca.crt',
  ]) {
    assert.ok(source.includes(`'${key}'`));
  }
  assert.match(source, /basicConstraints=critical,CA:TRUE/);
  assert.match(source, /extendedKeyUsage=serverAuth/);
  assert.match(source, /subjectAltName=DNS:ql3-cluster-control/);
});

test('preloads both lock-owned images before applying the operator manifest', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/ql3-cloudnativepg-live-contract.cjs'),
    'utf8',
  );
  const preload = source.indexOf(
    'for (const reviewedImage of [OPERATOR_IMAGE, POSTGRES_IMAGE])',
  );
  const manifest = source.indexOf(
    "'download official CloudNativePG 1.30.0 release manifest'",
  );
  assert.ok(preload >= 0);
  assert.ok(manifest > preload);
  const contract = source.slice(preload, manifest);
  assert.match(contract, /docker\(\['pull', reviewedImage\]\)/);
  assert.match(contract, /imageDigest\(reviewedImage\)/);
  assert.match(
    contract,
    /const preloadTag = imageTag\(reviewedImage\)/,
  );
  assert.match(
    contract,
    /docker\(\['tag', reviewedImage, preloadTag\]\)/,
  );
  assert.match(
    contract,
    /kind\(\['load', 'docker-image', preloadTag, '--name', clusterName\]\)/,
  );
  assert.doesNotMatch(
    contract,
    /kind\(\['load', 'docker-image', reviewedImage/,
  );
});

test('rejects a canonical but checksum-unreviewed operator manifest', () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-cnpg-manifest-test-')),
  );
  const candidate = path.join(directory, 'operator.yaml');
  try {
    fs.writeFileSync(candidate, 'x'.repeat(2048), { mode: 0o600 });
    assert.match(manifestSha256(candidate), /^sha256:[a-f0-9]{64}$/);
    assert.throws(
      () => reviewedOperatorManifest(candidate),
      /reviewed lock digest/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bounds remote manifest retries and removes disposable temporary state', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/ql3-cloudnativepg-live-contract.cjs'),
    'utf8',
  );
  assert.match(source, /'--http1\.1'/);
  assert.match(source, /'--retry-max-time',\s*'300'/);
  assert.match(source, /reviewedOperatorManifest\(downloadedOperatorManifest\)/);
  assert.match(
    source,
    /fs\.rmSync\(tempDirectory, \{ recursive: true, force: true \}\)/,
  );
});
