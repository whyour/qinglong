const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  identity,
  retryCommand,
  stopCommand,
} = require('../../scripts/ql3-run-management-kubernetes-live-contract.cjs');
const {
  localManifest,
} = require('../../scripts/lib/ql3-management-kubernetes-live-platform.cjs');

test('Run live local manifest replaces only the exact image placeholder', () => {
  const zeroDigest = 'sha256:' + '0'.repeat(64);
  const image = 'registry.example.com/qinglong/control';
  const rendered = [
    `image: ${image}@${zeroDigest}`,
    'imagePullPolicy: IfNotPresent',
    `qinglong.io/client-ca-sha256: ${zeroDigest}`,
  ].join('\n');
  const local = localManifest(rendered, image, 'ql3-control-live:test');
  assert.match(local, /image: ql3-control-live:test/);
  assert.match(local, /imagePullPolicy: Never/);
  assert.match(local, new RegExp(`client-ca-sha256: ${zeroDigest}`));
  assert.doesNotMatch(local, new RegExp(`${image}@${zeroDigest}`));
  assert.throws(
    () => localManifest(rendered.replace('@' + zeroDigest, ''), image, 'x:y'),
    /one reviewed image placeholder/,
  );
});

test('Run management live report path is mandatory before mutation begins', () => {
  const script = path.resolve(
    __dirname,
    '../../scripts/ql3-run-management-kubernetes-live-contract.cjs',
  );
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, QL3_RUN_MANAGEMENT_KUBERNETES_LIVE: '1' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--report=\/absolute\/private-report\.json/);
  assert.doesNotMatch(result.stderr, /Docker\/Kubernetes/);
});

test('Run live identity is audience, type, purpose and assurance bound', () => {
  const key = identity.reviewedKey('run-live-test-key');
  const document = identity.keyset(1, [key]);
  assert.equal(document.audience, 'qinglong3-run-management');
  const strong = identity.assertion(key, 'strong-unit-test');
  const [header, payload, signature] = strong.split('.');
  assert.ok(signature.length > 32);
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), {
    alg: 'EdDSA',
    kid: 'run-live-test-key',
    typ: 'ql3-run-management+jwt',
  });
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.aud, 'qinglong3-run-management');
  assert.equal(claims.ql3_purpose, 'run-management');
  assert.equal(claims.sub, 'run-operator');
  assert.deepEqual(claims.amr, ['pwd', 'otp']);
  const weak = JSON.parse(
    Buffer.from(
      identity.weakAssertion(key, 'weak-unit-test').split('.')[1],
      'base64url',
    ),
  );
  assert.equal(weak.acr, 'urn:ql3:password');
  assert.deepEqual(weak.amr, ['pwd']);
});

test('Run live commands bind exact mutation, source fence and distinct audits', () => {
  const retry = retryCommand(
    'project-a',
    'source-a',
    'request-a',
    '123e4567-e89b-42d3-a456-426614174000',
    1,
  );
  assert.equal(retry.operation, 'run.retry');
  assert.equal(retry.request.body.expectedRunStatus, 'failed');
  assert.equal(retry.request.body.expectedRunVersion, 3);
  assert.notEqual(
    retry.request.auditEventId,
    retry.request.failureAuditEventId,
  );
  const stop = stopCommand(
    'project-a',
    'run-a',
    'request-b',
    '123e4567-e89b-42d3-a456-426614174001',
    2,
  );
  assert.equal(stop.operation, 'run.stop');
  assert.equal(stop.request.body.schema, 'qinglong/run-cancellation@v1');
  assert.notEqual(stop.request.auditEventId, stop.request.failureAuditEventId);
});

test('Run live runner remains opt-in, layered and observation backed', () => {
  const source = fs.readFileSync(
    path.resolve(
      __dirname,
      '../../scripts/ql3-run-management-kubernetes-live-contract.cjs',
    ),
    'utf8',
  );
  assert.match(source, /QL3_RUN_MANAGEMENT_KUBERNETES_LIVE !== '1'/);
  assert.match(source, /reviewedOperatorManifest\(operatorManifestFile\)/);
  assert.match(source, /validateRunManagementKubernetesLiveReport/);
  assert.match(source, /createManagementClientExecutor/);
  assert.match(source, /QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_REQUEST_FAILED/);
  assert.match(source, /QL3_RUN_MANAGEMENT_CLIENT_FAILED/);
  assert.match(source, /const productionRateWindowPattern =/);
  assert.match(source, /const retryAuthenticationJti =/);
  assert.match(source, /const stopAuthenticationJti =/);
  assert.match(
    source,
    /const retryBearer = identity\.assertion\(oldKey, retryAuthenticationJti\)/,
  );
  assert.equal(
    source.split('bearer: retryBearer').length - 1,
    2,
    'an exact mutation replay must retain its original authentication fence',
  );
  assert.match(source, /durableRunManagementFacts/);
  assert.match(source, /Run identity ledger rollback surge failure/);
  assert.match(source, /CloudNativePG primary promotion/);
  assert.match(source, /migrationCount: 57/);
  assert.match(source, /controlCoreCapability: 56/);
  assert.doesNotMatch(source, /kubectl.*logs/);
});
