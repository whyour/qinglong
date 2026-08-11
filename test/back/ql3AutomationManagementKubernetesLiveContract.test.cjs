const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  assertion,
  envelope,
  keyset,
  reviewedKey,
  taskCommand,
  triggerCommand,
} = require('../../scripts/ql3-automation-management-kubernetes-live-contract.cjs');

test('automation live identity ceremony is audience, type and purpose bound', () => {
  const key = reviewedKey('automation-live-test-key');
  const document = keyset(1, [key]);
  assert.equal(document.generation, 1);
  assert.equal(document.audience, 'qinglong3-automation-management');
  assert.deepEqual(document.revokedKids, []);
  const token = assertion(key, 'unit-test');
  const [encodedHeader, encodedPayload, signature] = token.split('.');
  assert.ok(signature.length > 32);
  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url'));
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url'));
  assert.deepEqual(header, {
    alg: 'EdDSA',
    kid: 'automation-live-test-key',
    typ: 'ql3-automation-management+jwt',
  });
  assert.equal(payload.aud, 'qinglong3-automation-management');
  assert.equal(payload.ql3_purpose, 'automation-management');
  assert.equal(payload.sub, 'automation-operator');
});

test('automation live commands retain exact revision and task pinning', () => {
  const task = taskCommand('project-a', null, '001', 'v1');
  const taskEnvelope = envelope('task.publish', 'task-v1', task);
  assert.equal(taskEnvelope.operation, 'task.publish');
  assert.equal(taskEnvelope.request.command.expectedRevision, null);
  const published = {
    taskId: task.taskId,
    revision: 1,
    contentDigest: 'a'.repeat(64),
  };
  const trigger = triggerCommand('project-a', null, published, '001');
  assert.equal(trigger.taskRevision, 1);
  assert.equal(trigger.taskContentDigest, 'a'.repeat(64));
});

test('automation live runner remains opt-in, audited and observation backed', () => {
  const source = fs.readFileSync(
    path.resolve(
      __dirname,
      '../../scripts/ql3-automation-management-kubernetes-live-contract.cjs',
    ),
    'utf8',
  );
  assert.match(source, /QL3_AUTOMATION_MANAGEMENT_KUBERNETES_LIVE !== '1'/);
  assert.match(source, /reviewedOperatorManifest\(operatorManifestFile\)/);
  assert.match(source, /validateAutomationManagementKubernetesLiveReport/);
  assert.match(source, /clientTcpProbe\(/);
  assert.match(source, /podTcpProbe\(/);
  assert.match(source, /\/dev\/termination-log/);
  assert.match(source, /umask 077/);
  assert.match(source, /chmod 600 \/tmp\/client\.json/);
  assert.match(source, /QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_REQUEST_FAILED/);
  assert.match(source, /"\$attempt" -ge 60/);
  assert.doesNotMatch(source, /logs', `job\/\$\{definition\.name\}`/);
  assert.match(source, /identity ledger rollback surge failure/);
  assert.match(source, /CloudNativePG primary promotion/);
  assert.match(source, /flannel\.alpha\.coreos\.com\/backend-type/);
  assert.match(
    source,
    /finalNodes = fixture\.kubectlJson\(\['get', 'nodes'\]\)/,
  );
  assert.match(source, /new Set\(cniReadyNodes\.map/);
  assert.doesNotMatch(source, /app=flannel/);
  assert.doesNotMatch(source, /ceremony is not complete/);
});
