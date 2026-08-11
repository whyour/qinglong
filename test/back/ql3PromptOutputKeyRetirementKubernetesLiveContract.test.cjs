const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  canaryControlJob,
  configureRetirementResources,
  denyCanaryResources,
} = require('../../scripts/ql3-prompt-output-key-retirement-kubernetes-live-contract.cjs');

const ROOT = path.resolve(__dirname, '../..');

test('patches the retirement Job with exact live images, canary and API routes', () => {
  const rendered = require('node:child_process').execFileSync(
    process.env.QL3_KUBECTL_BIN ?? 'kubectl',
    [
      'kustomize',
      path.join(
        ROOT,
        'deploy/kubernetes/ql3-cluster/operations/prompt-output-key-retirement/cloudnative-pg',
      ),
    ],
    { encoding: 'utf8' },
  );
  const resources = configureRetirementResources(rendered, {
    adminImage: 'ql3-admin:test',
    denyCanaryHost: 'ql3-retirement-deny-canary.qinglong3-system.svc',
    denyCanaryPort: 9443,
    kubernetesServiceIp: '10.43.0.1',
    kubernetesServerIp: '172.18.0.2',
  });
  const job = resources.find((resource) => resource.kind === 'Job');
  const policy = resources.find(
    (resource) => resource.kind === 'NetworkPolicy',
  );
  assert.deepEqual(
    [
      ...job.spec.template.spec.initContainers,
      ...job.spec.template.spec.containers,
    ].map((container) => container.image),
    ['ql3-admin:test', 'ql3-admin:test'],
  );
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(
    job.spec.template.spec.initContainers[0].volumeMounts,
    undefined,
  );
  assert.equal(
    job.spec.template.spec.volumes[2].projected.sources[0].serviceAccountToken
      .expirationSeconds,
    600,
  );
  assert.deepEqual(policy.spec.egress.slice(-2), [
    {
      to: [{ ipBlock: { cidr: '10.43.0.1/32' } }],
      ports: [{ protocol: 'TCP', port: 443 }],
    },
    {
      to: [{ ipBlock: { cidr: '172.18.0.2/32' } }],
      ports: [{ protocol: 'TCP', port: 6443 }],
    },
  ]);
});

test('keeps the reachable deny canary and its control probe tokenless', () => {
  const resources = denyCanaryResources('ql3-admin:test');
  const deployment = resources.find(
    (resource) => resource.kind === 'Deployment',
  );
  const service = resources.find((resource) => resource.kind === 'Service');
  const control = canaryControlJob('ql3-admin:test');
  assert.equal(
    deployment.spec.template.spec.automountServiceAccountToken,
    false,
  );
  assert.equal(service.spec.ports[0].port, 9443);
  assert.equal(control.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(
    fs
      .readFileSync(
        path.join(
          ROOT,
          'deploy/kubernetes/ql3-cluster/operations/prompt-output-key-retirement/base/service-account.yaml',
        ),
        'utf8',
      )
      .includes('automountServiceAccountToken: false'),
    true,
  );
});
