const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '../..');
const BASE = path.join(
  ROOT,
  'deploy/kubernetes/ql3-cluster/operations/prompt-output-gc',
);

function document(relativePath) {
  return yaml.load(fs.readFileSync(path.join(BASE, relativePath), 'utf8'));
}

test('defines a caller-driven least-privilege Prompt output GC Job', () => {
  const job = document('base/job.yaml');
  assert.equal(job.kind, 'Job');
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.activeDeadlineSeconds, 300);
  const pod = job.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.enableServiceLinks, false);
  assert.equal(pod.restartPolicy, 'Never');
  assert.equal(pod.containers.length, 1);
  const container = pod.containers[0];
  assert.deepEqual(container.command, [
    'node',
    '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/prompt-output/retention/promptOutputGcCli.js',
  ]);
  assert.deepEqual(container.args, [
    'run',
    '--policy-file',
    '/var/run/qinglong3/prompt-output-retention/retention-policies.json',
  ]);
  assert.equal(container.resources.limits.memory, '128Mi');
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.equal(
    container.env.some(
      ({ name }) => name === 'QL3_POSTGRES_AI_MAINTENANCE_URL',
    ),
    true,
  );
  assert.equal(JSON.stringify(job).includes('ql3_runtime'), false);
  assert.equal(JSON.stringify(job).includes('ql3_admin'), false);
});

test('binds only the AI maintenance credential and CloudNativePG endpoint', () => {
  const patches = document('cloudnative-pg/job-patch.yaml');
  const env = patches.find(({ path: target }) => target.endsWith('/env')).value;
  const names = new Set(env.map(({ name }) => name));
  assert.equal(names.has('QL3_POSTGRES_AI_MAINTENANCE_USER'), true);
  assert.equal(names.has('QL3_POSTGRES_AI_MAINTENANCE_PASSWORD'), true);
  assert.equal(names.has('QL3_POSTGRES_RUNTIME_USER'), false);
  assert.equal(names.has('QL3_POSTGRES_ADMIN_USER'), false);
  assert.equal(
    JSON.stringify(env).includes('ql3-postgres-ai-maintenance-auth'),
    true,
  );
  const policy = document('cloudnative-pg/network-policy-patch.yaml');
  assert.deepEqual(policy.spec.egress[1].ports, [
    { protocol: 'TCP', port: 5432 },
  ]);
  assert.equal(policy.spec.egress.length, 2);
});

test('ships an immutable bounded digest-bound policy example outside kustomize', () => {
  const config = document('config.example.yaml');
  assert.equal(config.immutable, true);
  const catalog = JSON.parse(config.data['retention-policies.json']);
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.policies.length, 1);
  assert.match(catalog.policies[0].policyDigest, /^[0-9a-f]{64}$/);
  const kustomization = document('base/kustomization.yaml');
  assert.equal(
    kustomization.resources.includes('../config.example.yaml'),
    false,
  );
});
