const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  assertion,
  assertionForSubject,
  decisionCommand,
  inspectCommand,
  keyset,
  reviewedKey,
  weakAssertion,
} = require('../../scripts/ql3-approval-management-kubernetes-live-contract.cjs');

test('approval live report path is mandatory before mutation begins', () => {
  const script = path.resolve(
    __dirname,
    '../../scripts/ql3-approval-management-kubernetes-live-contract.cjs',
  );
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, QL3_APPROVAL_MANAGEMENT_KUBERNETES_LIVE: '1' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--report=\/absolute\/private-report\.json/);
  assert.doesNotMatch(result.stderr, /Docker\/Kubernetes/);
});

test('approval live can sign a strong but unauthorized User identity', () => {
  const key = reviewedKey('approval-outsider-test-key');
  const payload = JSON.parse(
    Buffer.from(
      assertionForSubject(key, 'approval-outsider', 'unit-test').split('.')[1],
      'base64url',
    ),
  );
  assert.equal(payload.sub, 'approval-outsider');
  assert.equal(payload.acr, 'urn:ql3:mfa');
  assert.deepEqual(payload.amr, ['pwd', 'otp']);
});

test('approval live identity is audience, type, purpose and assurance bound', () => {
  const key = reviewedKey('approval-live-test-key');
  const document = keyset(1, [key]);
  assert.equal(document.generation, 1);
  assert.equal(document.audience, 'qinglong3-approval-management');
  assert.deepEqual(document.revokedKids, []);

  const strong = assertion(key, 'strong-unit-test');
  const [encodedHeader, encodedPayload, signature] = strong.split('.');
  assert.ok(signature.length > 32);
  assert.deepEqual(JSON.parse(Buffer.from(encodedHeader, 'base64url')), {
    alg: 'EdDSA',
    kid: 'approval-live-test-key',
    typ: 'ql3-approval-management+jwt',
  });
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url'));
  assert.equal(payload.aud, 'qinglong3-approval-management');
  assert.equal(payload.ql3_purpose, 'approval-management');
  assert.equal(payload.sub, 'approval-operator');
  assert.equal(payload.acr, 'urn:ql3:mfa');
  assert.deepEqual(payload.amr, ['pwd', 'otp']);

  const weakPayload = JSON.parse(
    Buffer.from(weakAssertion(key, 'weak-unit-test').split('.')[1], 'base64url'),
  );
  assert.equal(weakPayload.acr, 'urn:ql3:password');
  assert.deepEqual(weakPayload.amr, ['pwd']);
});

test('approval live commands bind exact request, action and distinct audits', () => {
  const inspect = inspectCommand(
    'project-a',
    'approval-a',
    'inspect-a',
    1,
  );
  assert.equal(inspect.operation, 'approval.inspect');
  assert.notEqual(
    inspect.request.auditEventId,
    inspect.request.failureAuditEventId,
  );

  const decide = decisionCommand(
    'project-a',
    'approval-a',
    'decide-a',
    'decision-a',
    2,
  );
  assert.equal(decide.operation, 'approval.decide');
  assert.equal(decide.request.expectedVersion, 1);
  assert.equal(decide.request.expectedAction.permission, 'run.start');
  assert.equal(decide.request.decision, 'approved');
  assert.equal(decide.request.reasonCode, 'reviewed');
});

test('approval live runner remains opt-in, audited and observation backed', () => {
  const source = fs.readFileSync(
    path.resolve(
      __dirname,
      '../../scripts/ql3-approval-management-kubernetes-live-contract.cjs',
    ),
    'utf8',
  );
  assert.match(
    source,
    /QL3_APPROVAL_MANAGEMENT_KUBERNETES_LIVE !== '1'/,
  );
  assert.match(source, /reviewedOperatorManifest\(operatorManifestFile\)/);
  assert.match(source, /validateApprovalManagementKubernetesLiveReport/);
  assert.match(source, /createManagementClientExecutor/);
  assert.match(source, /clientTcpProbe/);
  assert.match(source, /podTcpProbe/);
  assert.match(source, /weakUserRejected/);
  assert.match(source, /identity ledger rollback surge failure/);
  assert.match(source, /CloudNativePG primary promotion/);
  assert.match(source, /migrationCount: 54/);
  assert.match(source, /controlCoreCapability: 53/);
  assert.match(source, /flannel\.alpha\.coreos\.com\/backend-type/);
  assert.doesNotMatch(source, /kubectl.*logs/);
  assert.doesNotMatch(source, /ceremony is not complete/);
});
