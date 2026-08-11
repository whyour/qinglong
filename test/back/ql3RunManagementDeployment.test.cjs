const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '../..');

function document(relativePath) {
  return yaml.load(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

test('keeps strong Run management opt-in, private and least-resource', () => {
  const directory = 'deploy/kubernetes/ql3-cluster/operations/run-management/base';
  const deployment = document(`${directory}/deployment.yaml`);
  const service = document(`${directory}/service.yaml`);
  const policy = document(`${directory}/network-policy.yaml`);
  const kustomization = document(`${directory}/kustomization.yaml`);
  const container = deployment.spec.template.spec.containers[0];
  const environment = new Map(container.env.map((entry) => [entry.name, entry]));

  assert.equal(deployment.metadata.name, 'ql3-run-management');
  assert.equal(deployment.spec.replicas, 2);
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.deepEqual(container.command, [
    'node',
    '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/run-management/runManagementCli.js',
  ]);
  assert.equal(environment.get('QL3_RUN_MANAGEMENT_ENABLED').value, 'true');
  assert.equal(environment.get('QL3_RUN_MANAGEMENT_PORT').value, '8448');
  assert.equal(environment.get('QL3_POSTGRES_RUN_MANAGER_POOL_MAX').value, '2');
  assert.equal(container.resources.requests.memory, '96Mi');
  assert.equal(service.spec.type, 'ClusterIP');
  assert.equal(service.spec.ports[0].port, 8448);
  assert.equal(policy.spec.ingress[0].from[0].podSelector.matchLabels['qinglong.io/run-management-client'], 'true');
  assert.equal(policy.spec.egress.length, 1);
  assert.deepEqual(kustomization.resources, [
    'service-account.yaml',
    'service.yaml',
    'deployment.yaml',
    'pod-disruption-budget.yaml',
    'network-policy.yaml',
  ]);

  for (const defaultPath of [
    'deploy/kubernetes/ql3-cluster/base/kustomization.yaml',
    'deploy/kubernetes/ql3-cluster/overlays/cloudnative-pg/kustomization.yaml',
  ]) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, defaultPath), 'utf8'), /run-management/);
  }
});

test('binds the CloudNativePG overlay only to the dedicated Run manager role', () => {
  const directory = 'deploy/kubernetes/ql3-cluster/operations/run-management/cloudnative-pg';
  const patch = yaml.load(fs.readFileSync(path.join(ROOT, directory, 'deployment-patch.yaml'), 'utf8'));
  const environment = new Map(patch[0].value.map((entry) => [entry.name, entry]));
  const policy = document(`${directory}/network-policy-patch.yaml`);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'packages/ql3-cluster-admin/package.json'), 'utf8'),
  );

  assert.equal(environment.has('QL3_POSTGRES_RUN_MANAGER_URL'), false);
  assert.equal(
    environment.get('QL3_POSTGRES_RUN_MANAGER_USER').valueFrom.secretKeyRef.name,
    'ql3-postgres-run-manager-auth',
  );
  assert.equal(
    environment.get('QL3_POSTGRES_RUN_MANAGER_PASSWORD').valueFrom.secretKeyRef.name,
    'ql3-postgres-run-manager-auth',
  );
  assert.equal(environment.get('QL3_POSTGRES_RUN_MANAGER_HOST').value, 'ql3-postgres-rw.qinglong3-system.svc');
  assert.equal(policy.spec.egress.length, 2);
  assert.deepEqual(policy.spec.egress[1].to[0].podSelector.matchLabels, {
    'cnpg.io/cluster': 'ql3-postgres',
  });
  assert.equal(manifest.bin['ql3-run-manage'], 'dist/run-management/runManagementCli.js');
  assert.equal(manifest.bin['ql3-run-client'], 'dist/run-management/runManagementClientCli.js');
  assert.equal(
    manifest.exports['./run-management-process'].require,
    './dist/run-management/runManagementProcess.js',
  );
});
