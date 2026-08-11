#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');

function json(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function document(relativePath) {
  return yaml.load(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

const buildManifest = json('deploy/containers/ql3-worker/package.json');
const runtimeManifest = json(
  'deploy/containers/ql3-worker/runtime-dependencies/package.json',
);
const buildLock = json('deploy/containers/ql3-worker/package-lock.json');
const runtimeLock = json(
  'deploy/containers/ql3-worker/runtime-dependencies/package-lock.json',
);
const workerManifest = json('packages/ql3-worker-runtime/package.json');
const runtimeCoreManifest = json('packages/ql3-runtime-core/package.json');
const localProcessManifest = json('packages/ql3-local-process/package.json');

const expectedRuntimeRoots = Object.freeze({
  ...Object.fromEntries(
    Object.entries(workerManifest.dependencies).filter(
      ([name]) => !name.startsWith('@qinglong/'),
    ),
  ),
  ...Object.fromEntries(
    Object.entries(runtimeCoreManifest.dependencies ?? {}).filter(
      ([name]) => !name.startsWith('@qinglong/'),
    ),
  ),
  ...Object.fromEntries(
    Object.entries(localProcessManifest.dependencies ?? {}).filter(
      ([name]) => !name.startsWith('@qinglong/'),
    ),
  ),
});
assert.deepEqual(runtimeManifest.dependencies, expectedRuntimeRoots);
assert.deepEqual(buildManifest.dependencies, expectedRuntimeRoots);
assert.deepEqual(runtimeLock.packages[''].dependencies, expectedRuntimeRoots);
assert.deepEqual(buildLock.packages[''].dependencies, expectedRuntimeRoots);
assert.deepEqual(
  buildLock.packages[''].devDependencies,
  buildManifest.devDependencies,
);
assert.equal(Object.keys(runtimeLock.packages).length, 25);
assert.equal(
  Object.values(runtimeLock.packages).some((entry) => entry.dev === true),
  false,
);
assert.equal(Object.keys(buildLock.packages).length, 30);
for (const [installPath, entry] of Object.entries(runtimeLock.packages)) {
  if (installPath === '') continue;
  assert.match(installPath, /^node_modules\//);
  assert.match(entry.version, /^\d+\.\d+\.\d+/);
  assert.match(entry.integrity, /^sha512-/);
  assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
  assert.doesNotMatch(
    installPath,
    /(?:^|\/)(?:pg|sqlite3|express|react|@qinglong)(?:\/|$)/,
  );
}

const dockerfile = fs.readFileSync(
  path.join(root, 'deploy/containers/ql3-worker/Dockerfile'),
  'utf8',
);
for (const required of [
  'node:24.18.0-bookworm-slim@sha256:',
  'npm ci --omit=dev --ignore-scripts',
  'packages/ql3-runtime-core',
  'packages/ql3-local-process',
  'packages/ql3-worker-runtime',
  'packages/ql3-local-process/assets',
  'chmod 0555',
  'USER 65532:65532',
  'process/workerProcessCli.js',
]) {
  assert.match(dockerfile, new RegExp(required.replaceAll('/', '\\/')));
}
assert.doesNotMatch(
  dockerfile,
  /packages\/ql3-(?:cluster|local-application|local-sqlite|ai)/,
);

const deployment = document(
  'deploy/kubernetes/ql3-worker/base/deployment.yaml',
);
assert.equal(deployment.kind, 'Deployment');
assert.equal(deployment.spec.replicas, 1);
assert.equal(deployment.spec.strategy.type, 'Recreate');
assert.equal(
  deployment.spec.template.metadata.annotations[
    'qinglong.io/worker-identity-generation'
  ],
  'replace-in-private-overlay',
);
const pod = deployment.spec.template.spec;
assert.equal(pod.automountServiceAccountToken, false);
assert.equal(pod.terminationGracePeriodSeconds, 360);
assert.equal(pod.securityContext.runAsNonRoot, true);
assert.equal(pod.securityContext.runAsUser, 65532);
assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
assert.equal(pod.initContainers.length, 1);
assert.equal(pod.containers.length, 1);
const init = pod.initContainers[0];
const worker = pod.containers[0];
for (const container of [init, worker]) {
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
}
const initScript = init.args.join('\n');
for (const proof of [
  'umask 077',
  'chmod 0700',
  'cp /projected/tls.key',
  'cp /projected/credential-token',
  'cp /projected/capabilities.json',
  'chmod 0400',
]) {
  assert.match(initScript, new RegExp(proof.replaceAll('/', '\\/')));
}
const environment = Object.fromEntries(
  worker.env.map((entry) => [entry.name, entry]),
);
assert.equal(environment.QL_DEPLOYMENT_PROFILE.value, 'worker');
assert.equal(environment.QL3_WORKER_RUNTIME_ENABLED.value, 'true');
assert.equal(environment.QL3_WORKER_CAPACITY_PROFILE.value, 'edge');
for (const name of [
  'QL3_WORKER_CAPABILITIES_FILE',
  'QL3_WORKER_JOURNAL_ROOT',
  'QL3_WORKER_LOG_ROOT',
  'QL3_WORKER_RECEIPT_ROOT',
  'QL3_WORKER_CERTIFICATE_STORE_ROOT',
  'QL3_WORKER_TRUST_ANCHOR_FILE',
  'QL3_WORKER_CREDENTIAL_TOKEN_FILE',
  'QL3_WORKER_IDENTITY_BOOTSTRAP_PRIVATE_KEY_FILE',
  'QL3_WORKER_IDENTITY_BOOTSTRAP_CERTIFICATE_FILE',
]) {
  assert.equal(typeof environment[name]?.value, 'string');
}
for (const name of [
  'QL3_WORKER_CAPABILITIES_FILE',
  'QL3_WORKER_TRUST_ANCHOR_FILE',
  'QL3_WORKER_CREDENTIAL_TOKEN_FILE',
  'QL3_WORKER_IDENTITY_BOOTSTRAP_PRIVATE_KEY_FILE',
  'QL3_WORKER_IDENTITY_BOOTSTRAP_CERTIFICATE_FILE',
]) {
  assert.match(environment[name].value, /\/private\//);
}
assert.equal(worker.ports, undefined);
assert.equal(worker.readinessProbe, undefined);
assert.equal(worker.livenessProbe, undefined);
assert.equal(worker.startupProbe, undefined);
const volumes = Object.fromEntries(
  pod.volumes.map((volume) => [volume.name, volume]),
);
assert.equal(
  volumes['worker-state'].persistentVolumeClaim.claimName,
  'ql3-worker-state',
);
assert.equal(volumes['materialized-authority'].emptyDir.medium, 'Memory');
assert.equal(volumes.tmp.emptyDir.medium, 'Memory');
const projectedSecrets = volumes['projected-authority'].projected.sources
  .filter((source) => source.secret)
  .map((source) => source.secret);
assert.deepEqual(projectedSecrets, [
  {
    name: 'ql3-worker-identity',
    items: [
      { key: 'ca.crt', path: 'ca.crt' },
      { key: 'tls.key', path: 'tls.key' },
      { key: 'tls.crt', path: 'tls.crt' },
    ],
  },
  {
    name: 'ql3-worker-credential',
    items: [{ key: 'credential-token', path: 'credential-token' }],
  },
]);

const pvc = document(
  'deploy/kubernetes/ql3-worker/base/persistent-volume-claim.yaml',
);
assert.equal(pvc.kind, 'PersistentVolumeClaim');
assert.deepEqual(pvc.spec.accessModes, ['ReadWriteOnce']);
assert.equal(pvc.spec.resources.requests.storage, '2Gi');
const baseKustomization = document(
  'deploy/kubernetes/ql3-worker/base/kustomization.yaml',
);
assert.equal(baseKustomization.namespace, 'qinglong3-worker');
assert.deepEqual(baseKustomization.resources.sort(), [
  'deployment.yaml',
  'persistent-volume-claim.yaml',
]);
const credentialBootstrapKustomization = document(
  'deploy/kubernetes/ql3-worker/credential-bootstrap/kustomization.yaml',
);
assert.equal(credentialBootstrapKustomization.namespace, 'qinglong3-worker');
assert.deepEqual(credentialBootstrapKustomization.resources, [
  'credential-secret.yaml',
]);
const credentialTarget = document(
  'deploy/kubernetes/ql3-worker/credential-bootstrap/credential-secret.yaml',
);
assert.equal(credentialTarget.kind, 'Secret');
assert.equal(credentialTarget.type, 'Opaque');
assert.equal(credentialTarget.metadata.name, 'ql3-worker-credential');
assert.equal(
  credentialTarget.metadata.labels['app.kubernetes.io/managed-by'],
  'qinglong3',
);
assert.equal(
  credentialTarget.metadata.labels['qinglong.io/worker-credential-target'],
  'prepared-v3',
);
assert.deepEqual(credentialTarget.data, {});
assert.equal(credentialTarget.stringData, undefined);

const credentialAdminKustomization = document(
  'deploy/kubernetes/ql3-worker/credential-admin/kustomization.yaml',
);
assert.deepEqual(credentialAdminKustomization.resources.sort(), [
  'service-account.yaml',
  'stage-role-binding.yaml',
  'stage-role.yaml',
  'target-role-binding.yaml',
  'target-role.yaml',
  'token-issuer-role-binding.yaml',
  'token-issuer-role.yaml',
]);
const credentialAdminServiceAccount = document(
  'deploy/kubernetes/ql3-worker/credential-admin/service-account.yaml',
);
const stageRole = document(
  'deploy/kubernetes/ql3-worker/credential-admin/stage-role.yaml',
);
const stageBinding = document(
  'deploy/kubernetes/ql3-worker/credential-admin/stage-role-binding.yaml',
);
const targetRole = document(
  'deploy/kubernetes/ql3-worker/credential-admin/target-role.yaml',
);
const targetBinding = document(
  'deploy/kubernetes/ql3-worker/credential-admin/target-role-binding.yaml',
);
const tokenIssuerRole = document(
  'deploy/kubernetes/ql3-worker/credential-admin/token-issuer-role.yaml',
);
const tokenIssuerBinding = document(
  'deploy/kubernetes/ql3-worker/credential-admin/token-issuer-role-binding.yaml',
);
assert.equal(
  credentialAdminServiceAccount.metadata.namespace,
  'qinglong3-worker-credential-staging',
);
assert.equal(credentialAdminServiceAccount.automountServiceAccountToken, false);
assert.deepEqual(stageRole.rules, [{
  apiGroups: [''],
  resources: ['secrets'],
  verbs: ['get', 'list', 'create', 'delete'],
}]);
assert.equal(stageRole.metadata.namespace, 'qinglong3-worker-credential-staging');
assert.equal(stageBinding.metadata.namespace, stageRole.metadata.namespace);
assert.deepEqual(stageBinding.subjects, [{
  kind: 'ServiceAccount',
  name: 'ql3-worker-credential-admin',
  namespace: 'qinglong3-worker-credential-staging',
}]);
assert.deepEqual(targetRole.rules, [
  {
    apiGroups: [''],
    resources: ['secrets'],
    resourceNames: ['ql3-worker-credential'],
    verbs: ['get', 'update'],
  },
  {
    apiGroups: ['apps'],
    resources: ['deployments'],
    resourceNames: ['ql3-worker'],
    verbs: ['get', 'update'],
  },
]);
assert.equal(targetRole.metadata.namespace, 'qinglong3-worker');
assert.equal(targetBinding.metadata.namespace, targetRole.metadata.namespace);
assert.deepEqual(targetBinding.subjects, stageBinding.subjects);
assert.equal(targetBinding.roleRef.name, targetRole.metadata.name);
assert.equal(stageBinding.roleRef.name, stageRole.metadata.name);
assert.deepEqual(tokenIssuerRole.rules, [{
  apiGroups: [''],
  resources: ['serviceaccounts/token'],
  resourceNames: ['ql3-worker-credential-admin'],
  verbs: ['create'],
}]);
assert.equal(
  tokenIssuerRole.metadata.namespace,
  'qinglong3-worker-credential-staging',
);
assert.equal(
  tokenIssuerBinding.metadata.namespace,
  tokenIssuerRole.metadata.namespace,
);
assert.equal(tokenIssuerBinding.roleRef.name, tokenIssuerRole.metadata.name);
assert.deepEqual(tokenIssuerBinding.subjects, [{
  apiGroup: 'rbac.authorization.k8s.io',
  kind: 'Group',
  name: 'qinglong:worker-credential-operators',
}]);
assert.equal(
  document('deploy/kubernetes/ql3-worker/config.example.yaml').metadata.namespace,
  'qinglong3-worker',
);
assert.equal(
  document('deploy/kubernetes/ql3-worker/identity.example.yaml').metadata.namespace,
  'qinglong3-worker',
);
const nodePatch = document(
  'deploy/kubernetes/ql3-worker/overlays/node/deployment-patch.yaml',
);
const nodeWorker = nodePatch.spec.template.spec.containers[0];
assert.deepEqual(nodeWorker.env, [
  { name: 'QL3_WORKER_CAPACITY_PROFILE', value: 'node' },
]);
assert.equal(nodeWorker.resources.requests.memory, '256Mi');
assert.equal(nodeWorker.resources.limits.memory, '1Gi');

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      artifact: 'qinglong3-worker-deployment',
      workspacePackages: 3,
      runtimeExternalPackages: Object.keys(runtimeLock.packages).length - 1,
      buildExternalPackages: Object.keys(buildLock.packages).length - 1,
      replicasPerIdentity: deployment.spec.replicas,
      dedicatedWorkerNamespace: true,
      separateCredentialStageNamespace: true,
      preparedCredentialTarget: true,
      credentialTargetCreateOnlyBootstrap: true,
      credentialAdminAutomountServiceAccountToken: false,
      credentialAdminStageSecretVerbs: stageRole.rules[0].verbs,
      credentialAdminTargetSecretVerbs: targetRole.rules[0].verbs,
      credentialAdminTargetDeploymentVerbs: targetRole.rules[1].verbs,
      credentialTokenIssuerGroup: tokenIssuerBinding.subjects[0].name,
      credentialTokenIssuerResourceNames:
        tokenIssuerRole.rules[0].resourceNames,
      persistentRecoveryState: true,
      projectedAuthorityMaterializedPrivately: true,
      tlsAndCredentialAuthoritySeparated: true,
      identityGenerationRolloutBound: true,
      serviceAccountTokenMounted: false,
      inboundPorts: 0,
      syntheticHealthProbes: 0,
      capacityProfiles: ['edge', 'node'],
      passed: true,
    },
    null,
    2,
  )}\n`,
);
