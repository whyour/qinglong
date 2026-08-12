const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  auditClusterDeployment,
} = require('../../scripts/ql3-cluster-deployment-audit.cjs');

const ROOT = path.resolve(__dirname, '../..');

function intercept(relativePath, transform) {
  const target = path.join(ROOT, relativePath);
  return (filePath, encoding) => {
    const value = fs.readFileSync(filePath, encoding);
    return path.resolve(filePath) === target ? transform(value) : value;
  };
}

test('accepts the exact locked non-root multi-replica cluster deployment', () => {
  const report = auditClusterDeployment({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.kubernetesReplicas, 2);
  assert.equal(report.migrationJob, 'explicit-one-shot');
  assert.equal(report.pluginPackageRecoveryJob, 'explicit-one-shot');
  assert.equal(report.imageReleasePins, 'independent-fail-closed-digests');
  assert.equal(report.clusterAi, 'optional-projected-authority');
  assert.equal(
    report.clusterAiPromptOutput,
    'optional-read-only-projected-keyring',
  );
  assert.equal(report.promptOutputKeyRotation, 'caller-driven-staged-material');
  assert.equal(report.clusterAdminImageReferences, 24);
  assert.deepEqual(report.workspacePackages, [
    '@qinglong/runtime-core',
    '@qinglong/cluster-postgres',
    '@qinglong/cluster-control',
  ]);
  assert.deepEqual(report.adminWorkspacePackages, [
    '@qinglong/runtime-core',
    '@qinglong/cluster-postgres',
    '@qinglong/cluster-admin',
  ]);
});

test('requires every Cluster Admin Kubernetes workload to override the image command', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/approval-management/base/deployment.yaml',
      (source) =>
        source.replace(
          '          command:\n            - node\n            - /opt/qinglong/node_modules/@qinglong/cluster-admin/dist/approval-management/approvalManagementCli.js\n',
          '',
        ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(report.clusterAdminImageReferences, 24);
  assert.equal(
    report.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_ADMIN_IMAGE_COMMAND_IMPLICIT',
    ),
    true,
  );
});

test('requires the bounded Cluster product facade and image entrypoint', () => {
  const missingBinary = auditClusterDeployment({
    root: ROOT,
    readFile: intercept('packages/ql3-cluster-admin/package.json', (source) => {
      const manifest = JSON.parse(source);
      delete manifest.bin['ql3-cluster-admin'];
      return JSON.stringify(manifest);
    }),
  });
  assert.equal(missingBinary.compatible, false);
  assert.equal(
    missingBinary.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_PLUGIN_RECOVERY_ENTRYPOINT_MISSING',
    ),
    true,
  );

  const legacyEntrypoint = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/containers/ql3-cluster-admin/Dockerfile',
      (source) =>
        source.replace(
          'dist/product-cli/cli.js',
          'dist/plugin-package/recovery/pluginPackageRecoveryCli.js',
        ),
    ),
  });
  assert.equal(legacyEntrypoint.compatible, false);
  assert.equal(
    legacyEntrypoint.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_ADMIN_DOCKERFILE_CONTRACT_MISSING',
    ),
    true,
  );
});

test('ships a path-only Cluster operator context example without durable authority', () => {
  const example = JSON.parse(
    fs.readFileSync(
      path.join(
        ROOT,
        'deploy/kubernetes/ql3-cluster/operator-context.example.json',
      ),
      'utf8',
    ),
  );
  assert.deepEqual(Object.keys(example).sort(), ['commands', 'schemaVersion']);
  assert.equal(example.schemaVersion, 1);
  assert.deepEqual(Object.keys(example.commands).sort(), [
    'approval',
    'automation',
    'model-credential',
    'package',
    'package-kubernetes',
    'run',
    'worker-credential',
  ]);
  for (const [name, command] of Object.entries(example.commands)) {
    assert.deepEqual(
      Object.keys(command).sort(),
      name === 'package-kubernetes'
        ? ['configFile', 'kubernetesFile']
        : ['configFile'],
    );
    for (const value of Object.values(command)) {
      assert.match(value, /^\/secure\/qinglong3\/[a-z0-9-]+\.json$/);
    }
  }
  assert.doesNotMatch(
    JSON.stringify(example),
    /assertion|commandFile|privateKey|token|password|secret/i,
  );
});

test('keeps Cluster AI optional with projected authority and an independent digest', () => {
  const defaultEnabled = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/base/deployment.yaml',
      (source) =>
        source.replace(
          'image: qinglong3-cluster-control:3.0.0-alpha.0',
          'image: qinglong3-cluster-control-ai:3.0.0-alpha.0',
        ),
    ),
  });
  assert.equal(defaultEnabled.compatible, false);
  assert.ok(
    defaultEnabled.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_AI_DEFAULT_ENABLED',
    ),
  );

  const writableProjection = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/components/cluster-ai/deployment-patch.yaml',
      (source) => source.replaceAll('defaultMode: 288', 'defaultMode: 416'),
    ),
  });
  assert.equal(writableProjection.compatible, false);
  assert.ok(
    writableProjection.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_AI_COMPONENT_AUTHORITY',
    ),
  );

  const tagBased = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/overlays/cluster-ai-example/kustomization.yaml',
      (source) =>
        source.replace(/digest: sha256:0{64}/, 'newTag: 3.0.0-alpha.0'),
    ),
  });
  assert.equal(tagBased.compatible, false);
  assert.ok(
    tagBased.findings.some(({ code }) => code === 'QL3_CLUSTER_AI_IMAGE_PIN'),
  );
});

test('keeps durable Cluster AI Prompt output opt-in and read-only', () => {
  const enabledByBaseAi = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/components/cluster-ai/deployment-patch.yaml',
      (source) =>
        source.replace(
          '            - name: QL3_CLUSTER_AI_DATABASE_MAX_CONNECTIONS\n              value: "4"',
          '            - name: QL3_CLUSTER_AI_DATABASE_MAX_CONNECTIONS\n              value: "4"\n            - name: QL3_CLUSTER_AI_PROMPT_OUTPUT_ENABLED\n              value: "true"',
        ),
    ),
  });
  assert.equal(enabledByBaseAi.compatible, false);
  assert.ok(
    enabledByBaseAi.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_AI_COMPONENT_AUTHORITY',
    ),
  );

  const writableKeyring = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/components/cluster-ai-prompt-output/deployment-patch.yaml',
      (source) => source.replace('defaultMode: 288', 'defaultMode: 416'),
    ),
  });
  assert.equal(writableKeyring.compatible, false);
  assert.ok(
    writableKeyring.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_AI_PROMPT_OUTPUT_PROJECTION',
    ),
  );

  const writableMount = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/components/cluster-ai-prompt-output/deployment-patch.yaml',
      (source) => source.replace('readOnly: true', 'readOnly: false'),
    ),
  });
  assert.equal(writableMount.compatible, false);
  assert.ok(
    writableMount.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_AI_PROMPT_OUTPUT_PROJECTION',
    ),
  );

  const widenedProjection = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/components/cluster-ai-prompt-output/deployment-patch.yaml',
      (source) =>
        source.replace(
          'items:\n              - key: keyring.json\n                path: keyring.json',
          'optional: true',
        ),
    ),
  });
  assert.equal(widenedProjection.compatible, false);
  assert.ok(
    widenedProjection.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_AI_PROMPT_OUTPUT_PROJECTION',
    ),
  );

  const incompleteOverlay = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/overlays/cluster-ai-prompt-output-example/kustomization.yaml',
      (source) => source.replace('  - ../../components/cluster-ai\n', ''),
    ),
  });
  assert.equal(incompleteOverlay.compatible, false);
  assert.ok(
    incompleteOverlay.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_AI_PROMPT_OUTPUT_OVERLAY',
    ),
  );
});

test('keeps Prompt output active-key rotation caller-driven and least privilege', () => {
  const widenedRbac = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/prompt-output-key-rotation/base/role.yaml',
      (source) =>
        source.replace('      - update', '      - update\n      - create'),
    ),
  });
  assert.equal(widenedRbac.compatible, false);
  assert.ok(
    widenedRbac.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_PROMPT_OUTPUT_KEY_ROTATION_RBAC',
    ),
  );

  const broadMaterial = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/prompt-output-key-rotation/base/job.yaml',
      (source) => source.replace('              subPath: material.bin\n', ''),
    ),
  });
  assert.equal(broadMaterial.compatible, false);
  assert.ok(
    broadMaterial.findings.some(
      ({ code }) =>
        code === 'QL3_CLUSTER_PROMPT_OUTPUT_KEY_ROTATION_FILE_BOUNDARY',
    ),
  );

  const publicEgress = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/prompt-output-key-rotation/base/network-policy.yaml',
      (source) =>
        source.replace(
          '  egress:',
          '  egress:\n    - to:\n        - ipBlock:\n            cidr: 0.0.0.0/0',
        ),
    ),
  });
  assert.equal(publicEgress.compatible, false);
  assert.ok(
    publicEgress.findings.some(
      ({ code }) =>
        code === 'QL3_CLUSTER_PROMPT_OUTPUT_KEY_ROTATION_NETWORK_POLICY',
    ),
  );
});

test('rejects mutable or overridable Cluster image bases', () => {
  const digest =
    '@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d';
  const control = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/containers/ql3-cluster-control/Dockerfile',
      (source) => source.replace(digest, ''),
    ),
  });
  assert.equal(control.compatible, false);
  assert.equal(
    control.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_DOCKERFILE_BASE_IMAGE_NOT_PINNED',
    ),
    true,
  );

  const admin = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/containers/ql3-cluster-admin/Dockerfile',
      (source) =>
        `ARG NODE_IMAGE=node:24.18.0-bookworm-slim\n${source.replaceAll(
          `node:24.18.0-bookworm-slim${digest}`,
          '${NODE_IMAGE}',
        )}`,
    ),
  });
  assert.equal(admin.compatible, false);
  assert.equal(
    admin.findings.some(
      ({ code }) =>
        code === 'QL3_CLUSTER_ADMIN_DOCKERFILE_BASE_IMAGE_NOT_PINNED',
    ),
    true,
  );
});

test('keeps authenticated Plugin Package management optional and bounded', () => {
  const report = auditClusterDeployment({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.pluginPackageManagement, 'optional-authenticated-https');
});

test('keeps authenticated Worker credential management optional and isolated', () => {
  const report = auditClusterDeployment({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(
    report.workerCredentialManagement,
    'optional-authenticated-https',
  );
});

test('keeps authenticated automation management optional and isolated', () => {
  const report = auditClusterDeployment({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.automationManagement, 'optional-authenticated-https');
});

test('keeps authenticated human Approval management optional and isolated', () => {
  const report = auditClusterDeployment({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.approvalManagement, 'optional-authenticated-https');
});

test('rejects Approval management authority or entrypoint widening', () => {
  const publicEgress = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/approval-management/base/network-policy.yaml',
      (source) => source.replace('k8s-app: kube-dns', 'k8s-app: public-proxy'),
    ),
  });
  assert.equal(publicEgress.compatible, false);
  assert.equal(
    publicEgress.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_APPROVAL_MANAGEMENT_AUTHORITY',
    ),
    true,
  );

  const missingEntrypoint = auditClusterDeployment({
    root: ROOT,
    readFile: intercept('packages/ql3-cluster-admin/package.json', (source) => {
      const manifest = JSON.parse(source);
      delete manifest.bin['ql3-approval-manage'];
      return JSON.stringify(manifest);
    }),
  });
  assert.equal(missingEntrypoint.compatible, false);
  assert.equal(
    missingEntrypoint.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_APPROVAL_MANAGEMENT_BOUNDARY',
    ),
    true,
  );
});

test('rejects automation management authority or database role widening', () => {
  const publicEgress = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/automation-management/base/network-policy.yaml',
      (source) => source.replace('k8s-app: kube-dns', 'k8s-app: public-proxy'),
    ),
  });
  assert.equal(publicEgress.compatible, false);
  assert.equal(
    publicEgress.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_AUTOMATION_MANAGEMENT_AUTHORITY',
    ),
    true,
  );

  const wrongRole = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/automation-management/cloudnative-pg/deployment-patch.yaml',
      (source) =>
        source.replaceAll(
          'ql3-postgres-automation-manager-auth',
          'ql3-postgres-admin-auth',
        ),
    ),
  });
  assert.equal(wrongRole.compatible, false);
  assert.equal(
    wrongRole.findings.some(
      ({ code }) =>
        code === 'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLOUDNATIVE_PG_AUTHORITY',
    ),
    true,
  );

  const missingEntrypoint = auditClusterDeployment({
    root: ROOT,
    readFile: intercept('packages/ql3-cluster-admin/package.json', (source) => {
      const manifest = JSON.parse(source);
      delete manifest.bin['ql3-automation-manage'];
      return JSON.stringify(manifest);
    }),
  });
  assert.equal(missingEntrypoint.compatible, false);
  assert.equal(
    missingEntrypoint.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_AUTOMATION_MANAGEMENT_BOUNDARY',
    ),
    true,
  );
});

test('keeps the automation management client caller-driven and one-shot', () => {
  const report = auditClusterDeployment({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.automationManagementClient, 'caller-driven-one-shot');
});

test('keeps the Approval management client caller-driven and one-shot', () => {
  const report = auditClusterDeployment({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.approvalManagementClient, 'caller-driven-one-shot');
});

test('rejects widened lifecycle, authority or public inputs in the Approval client', () => {
  for (const [relativePath, transform, findingCode] of [
    [
      'deploy/kubernetes/ql3-cluster/operations/approval-management-client/base/job.yaml',
      (source) => source.replace('backoffLimit: 0', 'backoffLimit: 1'),
      'QL3_CLUSTER_APPROVAL_MANAGEMENT_CLIENT_LIFECYCLE',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/approval-management-client/base/job.yaml',
      (source) =>
        source.replace(
          'approvalManagementClientCli.js',
          'approvalManagementCli.js',
        ),
      'QL3_CLUSTER_APPROVAL_MANAGEMENT_CLIENT_ENTRYPOINT',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/approval-management-client/base/job.yaml',
      (source) =>
        source.replace(
          'secretName: ql3-approval-management-assertion',
          'secretName: ql3-approval-management-tls',
        ),
      'QL3_CLUSTER_APPROVAL_MANAGEMENT_CLIENT_FILE_BOUNDARY',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/approval-management-client/base/network-policy.yaml',
      (source) => source.replace('          port: 8447', '          port: 443'),
      'QL3_CLUSTER_APPROVAL_MANAGEMENT_CLIENT_NETWORK_POLICY',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/approval-management-client/kustomization.yaml',
      (source) =>
        source.replace(/digest: sha256:0{64}/, 'newTag: 3.0.0-alpha.0'),
      'QL3_CLUSTER_APPROVAL_MANAGEMENT_CLIENT_OPT_IN',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/approval-management-client/config.example.yaml',
      (source) => source.replace('kind: Secret', 'kind: ConfigMap'),
      'QL3_CLUSTER_APPROVAL_MANAGEMENT_CLIENT_INPUT_BOUNDARY',
    ],
  ]) {
    const report = auditClusterDeployment({
      root: ROOT,
      readFile: intercept(relativePath, transform),
    });
    assert.equal(report.compatible, false);
    assert.equal(
      report.findings.some(({ code }) => code === findingCode),
      true,
    );
  }
});

test('rejects widened lifecycle, authority or public inputs in the automation client', () => {
  for (const [relativePath, transform, findingCode] of [
    [
      'deploy/kubernetes/ql3-cluster/operations/automation-management-client/base/job.yaml',
      (source) => source.replace('backoffLimit: 0', 'backoffLimit: 1'),
      'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLIENT_LIFECYCLE',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/automation-management-client/base/job.yaml',
      (source) =>
        source.replace(
          'automationManagementClientCli.js',
          'automationManagementCli.js',
        ),
      'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLIENT_ENTRYPOINT',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/automation-management-client/base/job.yaml',
      (source) =>
        source.replace(
          '        - name: request\n          secret:',
          '        - name: request\n          configMap:',
        ),
      'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLIENT_FILE_BOUNDARY',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/automation-management-client/base/network-policy.yaml',
      (source) => source.replace('          port: 8445', '          port: 443'),
      'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLIENT_NETWORK_POLICY',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/automation-management-client/kustomization.yaml',
      (source) =>
        source.replace(/digest: sha256:0{64}/, 'newTag: 3.0.0-alpha.0'),
      'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLIENT_RELEASE_DIGEST_PIN',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      (source) => `${source}  - automation-management-client/base\n`,
      'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLIENT_DEFAULT_ENABLED',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/automation-management-client/config.example.yaml',
      (source) => source.replace('kind: Secret', 'kind: ConfigMap'),
      'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLIENT_INPUT_BOUNDARY',
    ],
  ]) {
    const report = auditClusterDeployment({
      root: ROOT,
      readFile: intercept(relativePath, transform),
    });
    assert.equal(report.compatible, false);
    assert.equal(
      report.findings.some(({ code }) => code === findingCode),
      true,
    );
  }
});

test('keeps the Worker credential management client caller-driven and one-shot', () => {
  const report = auditClusterDeployment({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(
    report.workerCredentialManagementClient,
    'caller-driven-one-shot',
  );
});

test('rejects widened authority or lifecycle in the Worker management client', () => {
  for (const [relativePath, transform, findingCode] of [
    [
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-management-client/base/job.yaml',
      (source) => source.replace('backoffLimit: 0', 'backoffLimit: 1'),
      'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_LIFECYCLE',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-management-client/base/job.yaml',
      (source) =>
        source.replace(
          'workerCredentialManagementClientCli.js',
          'workerCredentialManagementCli.js',
        ),
      'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_ENTRYPOINT',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-management-client/base/job.yaml',
      (source) =>
        source.replace(
          'secretName: ql3-worker-credential-management-assertion',
          'secretName: ql3-worker-credential-management-tls',
        ),
      'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_FILE_BOUNDARY',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-management-client/base/network-policy.yaml',
      (source) =>
        source.replace(
          '  egress:\n    - to:',
          '  egress:\n    - {}\n    - to:',
        ),
      'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_NETWORK_POLICY',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-management-client/kustomization.yaml',
      (source) =>
        source.replace(/digest: sha256:0{64}/, 'newTag: 3.0.0-alpha.0'),
      'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_RELEASE_DIGEST_PIN',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      (source) => `${source}  - worker-credential-management-client/base\n`,
      'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_DEFAULT_ENABLED',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-management-client/config.example.yaml',
      (source) => source.replace('immutable: true', 'immutable: false'),
      'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_INPUT_BOUNDARY',
    ],
  ]) {
    const report = auditClusterDeployment({
      root: ROOT,
      readFile: intercept(relativePath, transform),
    });
    assert.equal(report.compatible, false);
    assert.equal(
      report.findings.some(({ code }) => code === findingCode),
      true,
    );
  }
});

test('requires the production Worker credential management client export and binary', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept('packages/ql3-cluster-admin/package.json', (source) => {
      const manifest = JSON.parse(source);
      delete manifest.bin['ql3-worker-credential-client'];
      delete manifest.exports['./worker-credential-management-client'];
      return JSON.stringify(manifest);
    }),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_PLUGIN_RECOVERY_ENTRYPOINT_MISSING',
    ),
    true,
  );
});

test('keeps Worker credential execution caller-driven and one-shot', () => {
  const report = auditClusterDeployment({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.workerCredentialExecutor, 'caller-driven-one-shot');
});

test('rejects widened issuer token, RBAC or database authority in Worker execution', () => {
  for (const [relativePath, transform, findingCode] of [
    [
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-executor/base/job.yaml',
      (source) =>
        source.replace('expirationSeconds: 600', 'expirationSeconds: 3600'),
      'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_FILE_AUTHORITY',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-executor/base/token-issuer-role-binding.yaml',
      (source) =>
        source.replace(
          'name: ql3-worker-credential-token-issuer',
          'name: ql3-worker-credential-target-admin',
        ),
      'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_ISSUER_RBAC',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-executor/base/job.yaml',
      (source) =>
        source.replace(
          'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_URL',
          'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_URL',
        ),
      'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_DATABASE_AUTHORITY',
    ],
  ]) {
    const report = auditClusterDeployment({
      root: ROOT,
      readFile: intercept(relativePath, transform),
    });
    assert.equal(report.compatible, false);
    assert.equal(
      report.findings.some(({ code }) => code === findingCode),
      true,
    );
  }
});

test('rejects recurring, default-enabled or public-egress Worker execution', () => {
  for (const [relativePath, transform, findingCode] of [
    [
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-executor/base/job.yaml',
      (source) => source.replace('kind: Job', 'kind: CronJob'),
      'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_LIFECYCLE',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      (source) => `${source}  - worker-credential-executor/base\n`,
      'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_DEFAULT_ENABLED',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-executor/base/network-policy.yaml',
      (source) =>
        source.replace(
          '  egress:\n    - to:',
          '  egress:\n    - {}\n    - to:',
        ),
      'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_NETWORK_POLICY',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-executor/cloudnative-pg/kustomization.yaml',
      (source) =>
        source.replace(/digest: sha256:0{64}/, 'newTag: 3.0.0-alpha.0'),
      'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_CLOUDNATIVE_PG_AUTHORITY',
    ],
  ]) {
    const report = auditClusterDeployment({
      root: ROOT,
      readFile: intercept(relativePath, transform),
    });
    assert.equal(report.compatible, false);
    assert.equal(
      report.findings.some(({ code }) => code === findingCode),
      true,
    );
  }
});

test('rejects executor authority or public egress in Worker management', () => {
  const databaseAuthority = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-management/base/deployment.yaml',
      (source) =>
        source.replace(
          'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_URL',
          'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_URL',
        ),
    ),
  });
  assert.equal(databaseAuthority.compatible, false);
  assert.ok(
    databaseAuthority.findings.some(
      ({ code }) =>
        code === 'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_DATABASE_AUTHORITY',
    ),
  );

  const publicEgress = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-management/base/network-policy.yaml',
      (source) =>
        source.replace(
          '  egress:\n    - to:',
          '  egress:\n    - {}\n    - to:',
        ),
    ),
  });
  assert.equal(publicEgress.compatible, false);
  assert.ok(
    publicEgress.findings.some(
      ({ code }) =>
        code === 'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_NETWORK_POLICY',
    ),
  );
});

test('rejects default or tag-based Worker management rollout', () => {
  const defaultEnabled = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      (source) => `${source}  - worker-credential-management/base\n`,
    ),
  });
  assert.equal(defaultEnabled.compatible, false);
  assert.ok(
    defaultEnabled.findings.some(
      ({ code }) =>
        code === 'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_DEFAULT_ENABLED',
    ),
  );

  const tagBased = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-management/cloudnative-pg/kustomization.yaml',
      (source) =>
        source.replace(/digest: sha256:0{64}/, 'newTag: 3.0.0-alpha.0'),
    ),
  });
  assert.equal(tagBased.compatible, false);
  assert.ok(
    tagBased.findings.some(
      ({ code }) =>
        code ===
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLOUDNATIVE_PG_AUTHORITY',
    ),
  );
});

test('requires an explicit Worker management CRL rollout evidence annotation', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-management/base/deployment.yaml',
      (source) =>
        source.replace(
          /\n\s+qinglong\.io\/worker-credential-management-client-crl-sha256: sha256:0{64}/,
          '',
        ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.ok(
    report.findings.some(
      ({ code }) =>
        code ===
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CRL_ROLLOUT_EVIDENCE',
    ),
  );
});

test('requires an explicit Worker management CA rollout evidence annotation', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/worker-credential-management/base/deployment.yaml',
      (source) =>
        source.replace(
          /\n\s+qinglong\.io\/worker-credential-management-client-ca-sha256: sha256:0{64}/,
          '',
        ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.ok(
    report.findings.some(
      ({ code }) =>
        code === 'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CA_ROLLOUT_EVIDENCE',
    ),
  );
});

test('requires the private Plugin Package management client export and binary', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept('packages/ql3-cluster-admin/package.json', (source) => {
      const manifest = JSON.parse(source);
      delete manifest.bin['ql3-plugin-package-client'];
      delete manifest.exports['./plugin-package-management-client'];
      return JSON.stringify(manifest);
    }),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_PLUGIN_RECOVERY_ENTRYPOINT_MISSING',
    ),
    true,
  );
});

test('requires the private Kubernetes management tunnel export and binary', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept('packages/ql3-cluster-admin/package.json', (source) => {
      const manifest = JSON.parse(source);
      delete manifest.bin['ql3-plugin-package-client-kubernetes'];
      delete manifest.exports['./plugin-package-management-kubernetes-client'];
      return JSON.stringify(manifest);
    }),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_PLUGIN_RECOVERY_ENTRYPOINT_MISSING',
    ),
    true,
  );
});

test('rejects public management egress or widened CloudNativePG destinations', () => {
  const publicEgress = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-management/base/network-policy.yaml',
      (source) =>
        source.replace(
          '  egress:\n    - to:',
          '  egress:\n    - {}\n    - to:',
        ),
    ),
  });
  assert.equal(publicEgress.compatible, false);
  assert.ok(
    publicEgress.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_PLUGIN_MANAGEMENT_NETWORK_POLICY',
    ),
  );

  const widenedPostgres = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-management/cloudnative-pg/network-policy-patch.yaml',
      (source) =>
        source.replace(
          '              cnpg.io/cluster: ql3-postgres',
          '              app.kubernetes.io/part-of: qinglong3',
        ),
    ),
  });
  assert.equal(widenedPostgres.compatible, false);
  assert.ok(
    widenedPostgres.findings.some(
      ({ code }) =>
        code === 'QL3_CLUSTER_PLUGIN_MANAGEMENT_CLOUDNATIVE_PG_AUTHORITY',
    ),
  );
});

test('rejects Kubernetes API or executor authority in Package management', () => {
  const kubernetesAuthority = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-management/base/deployment.yaml',
      (source) =>
        source.replace(
          'automountServiceAccountToken: false',
          'automountServiceAccountToken: true',
        ),
    ),
  });
  assert.equal(kubernetesAuthority.compatible, false);
  assert.equal(
    kubernetesAuthority.findings.some(
      (candidate) =>
        candidate.code === 'QL3_CLUSTER_PLUGIN_MANAGEMENT_LIFECYCLE',
    ),
    true,
  );

  const databaseAuthority = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-management/base/deployment.yaml',
      (source) =>
        source.replace(
          'QL3_POSTGRES_PACKAGE_MANAGER_URL',
          'QL3_POSTGRES_PACKAGE_EXECUTOR_URL',
        ),
    ),
  });
  assert.equal(databaseAuthority.compatible, false);
  assert.equal(
    databaseAuthority.findings.some(
      (candidate) =>
        candidate.code === 'QL3_CLUSTER_PLUGIN_MANAGEMENT_DATABASE_AUTHORITY',
    ),
    true,
  );
});

test('rejects default enablement or tag-based Package management rollout', () => {
  const defaultEnabled = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      (source) => `${source}  - plugin-package-management/base\n`,
    ),
  });
  assert.equal(defaultEnabled.compatible, false);
  assert.equal(
    defaultEnabled.findings.some(
      (candidate) =>
        candidate.code === 'QL3_CLUSTER_PLUGIN_MANAGEMENT_DEFAULT_ENABLED',
    ),
    true,
  );

  const tagBased = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-management/cloudnative-pg/kustomization.yaml',
      (source) =>
        source.replace(/digest: sha256:0{64}/, 'newTag: 3.0.0-alpha.0'),
    ),
  });
  assert.equal(tagBased.compatible, false);
  assert.equal(
    tagBased.findings.some(
      (candidate) =>
        candidate.code === 'QL3_CLUSTER_PLUGIN_MANAGEMENT_RELEASE_DIGEST_PIN',
    ),
    true,
  );
});

test('rejects a recovery-writable ConfigMap as the management identity root', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-management/base/deployment.yaml',
      (source) =>
        source.replace(
          '        - name: management-identity\n          secret:\n            secretName: ql3-plugin-package-management-identity',
          '        - name: management-identity\n          configMap:\n            name: ql3-plugin-package-management-identity',
        ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) =>
        candidate.code === 'QL3_CLUSTER_PLUGIN_MANAGEMENT_FILE_BINDING',
    ),
    true,
  );
});

test('rejects a single-replica cluster-control deployment', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/base/deployment.yaml',
      (source) => source.replace('replicas: 2', 'replicas: 1'),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CLUSTER_KUBERNETES_REPLICA_FLOOR',
    ),
    true,
  );
});

test('rejects image dependency widening beyond the reviewed QL3 closure', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/containers/ql3-cluster-control/package.json',
      (source) => {
        const manifest = JSON.parse(source);
        manifest.dependencies.express = '4.22.2';
        return JSON.stringify(manifest);
      },
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CLUSTER_IMAGE_DEPENDENCY_DRIFT',
    ),
    true,
  );
});

test('rejects image builder dependency widening beyond the reviewed toolchain', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/containers/ql3-cluster-control/package.json',
      (source) => {
        const manifest = JSON.parse(source);
        manifest.devDependencies.esbuild = '0.25.12';
        return JSON.stringify(manifest);
      },
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) =>
        candidate.code === 'QL3_CLUSTER_IMAGE_BUILD_DEPENDENCY_DRIFT',
    ),
    true,
  );
});

test('rejects cluster-admin image dependency widening', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/containers/ql3-cluster-admin/package.json',
      (source) => {
        const manifest = JSON.parse(source);
        manifest.dependencies.express = '4.22.2';
        return JSON.stringify(manifest);
      },
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) =>
        candidate.code === 'QL3_CLUSTER_ADMIN_IMAGE_DEPENDENCY_DRIFT',
    ),
    true,
  );
});

test('rejects inline runtime credentials and a privileged container', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/base/deployment.yaml',
      (source) =>
        source
          .replace(
            /valueFrom:\n\s+secretKeyRef:\n\s+name: ql3-cluster-control-runtime\n\s+key: postgres-runtime-url/,
            'value: postgresql://inline-secret',
          )
          .replace(
            'allowPrivilegeEscalation: false',
            'allowPrivilegeEscalation: true',
          ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CLUSTER_KUBERNETES_SECRET_BINDING',
    ),
    true,
  );
  assert.equal(
    report.findings.some(
      (candidate) =>
        candidate.code === 'QL3_CLUSTER_KUBERNETES_SECURITY_CONTEXT',
    ),
    true,
  );
});

test('rejects migration authority in the runtime secret domain', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/base/migrate-job.yaml',
      (source) =>
        source
          .replace(
            'name: ql3-cluster-migration\n                  key: postgres-migration-url',
            'name: ql3-cluster-control-runtime\n                  key: postgres-migration-url',
          )
          .replace(
            'name: QL3_POSTGRES_MIGRATION_URL',
            'name: QL3_POSTGRES_RUNTIME_URL',
          ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CLUSTER_MIGRATION_AUTHORITY',
    ),
    true,
  );
});

test('rejects PostgreSQL CA paths or Secret projections outside the reviewed domains', () => {
  const runtime = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/base/deployment.yaml',
      (source) =>
        source.replace(
          '/var/run/secrets/qinglong3/postgres-runtime/ca.crt',
          '/tmp/postgres-ca.crt',
        ),
    ),
  });
  assert.equal(runtime.compatible, false);
  assert.equal(
    runtime.findings.some(
      (candidate) =>
        candidate.code === 'QL3_CLUSTER_KUBERNETES_ENVIRONMENT_GATE',
    ),
    true,
  );

  const migration = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/base/migrate-job.yaml',
      (source) =>
        source.replace(
          'secretName: ql3-cluster-migration',
          'secretName: ql3-cluster-control-runtime',
        ),
    ),
  });
  assert.equal(migration.compatible, false);
  assert.equal(
    migration.findings.some(
      (candidate) =>
        candidate.code === 'QL3_CLUSTER_MIGRATION_POSTGRES_CA_BINDING',
    ),
    true,
  );
});

test('rejects widened Plugin Package recovery RBAC', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-recovery/base/rbac.yaml',
      (source) =>
        source
          .replace(
            'resources:\n      - configmaps',
            'resources:\n      - configmaps\n      - secrets',
          )
          .replace(
            '      - update',
            '      - update\n      - delete\n      - list\n      - watch',
          ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CLUSTER_PLUGIN_RECOVERY_RBAC',
    ),
    true,
  );
});

test('rejects a broad or shared private Registry credential projection', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-recovery/private-registry/recover-job-patch.yaml',
      (source) =>
        source
          .replace(
            'secretName: ql3-plugin-package-registry-credentials',
            'secretName: ql3-cluster-control-runtime',
          )
          .replace('defaultMode: 288', 'defaultMode: 292'),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) =>
        candidate.code ===
        'QL3_CLUSTER_PLUGIN_RECOVERY_PRIVATE_REGISTRY_BINDING',
    ),
    true,
  );
});

test('rejects runtime database authority in the Plugin Package recovery Job', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-recovery/base/recover-job.yaml',
      (source) =>
        source
          .replace(
            'name: QL3_POSTGRES_PACKAGE_EXECUTOR_URL',
            'name: QL3_POSTGRES_RUNTIME_URL',
          )
          .replace(
            'name: ql3-cluster-plugin-package-recovery\n                  key: postgres-package-executor-url',
            'name: ql3-cluster-control-runtime\n                  key: postgres-runtime-url',
          ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.code === 'QL3_CLUSTER_PLUGIN_RECOVERY_AUTHORITY',
    ),
    true,
  );
});

test('rejects tag-based production overlays for either cluster image', () => {
  for (const [relativePath, findingCode] of [
    [
      'deploy/kubernetes/ql3-cluster/overlays/cloudnative-pg/kustomization.yaml',
      'QL3_CLUSTER_CONTROL_RELEASE_DIGEST_PIN',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-recovery/cloudnative-pg/kustomization.yaml',
      'QL3_CLUSTER_ADMIN_RELEASE_DIGEST_PIN',
    ],
  ]) {
    const report = auditClusterDeployment({
      root: ROOT,
      readFile: intercept(relativePath, (source) =>
        source.replace(/digest: sha256:0{64}/, 'newTag: 3.0.0-alpha.0'),
      ),
    });
    assert.equal(report.compatible, false);
    assert.equal(
      report.findings.some((candidate) => candidate.code === findingCode),
      true,
    );
  }
});

test('keeps Prompt output key retirement caller-driven and least privilege', () => {
  const report = auditClusterDeployment({ root: ROOT });
  assert.equal(report.compatible, true, JSON.stringify(report.findings));
  assert.equal(report.promptOutputKeyRetirement, 'caller-driven-one-shot');
});

test('rejects widened Prompt output key retirement RBAC', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/prompt-output-key-retirement/base/role.yaml',
      (source) =>
        source.replace('      - update', '      - update\n      - list'),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      ({ code }) => code === 'QL3_CLUSTER_PROMPT_OUTPUT_KEY_RETIREMENT_RBAC',
    ),
    true,
  );
});

test('rejects symlinked or broad Prompt output key retirement command mounts', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/prompt-output-key-retirement/base/job.yaml',
      (source) => source.replace('              subPath: command.json\n', ''),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      ({ code }) =>
        code === 'QL3_CLUSTER_PROMPT_OUTPUT_KEY_RETIREMENT_FILE_BOUNDARY',
    ),
    true,
  );
});

test('rejects an early or long-lived Prompt output key retirement token', () => {
  const automaticToken = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/prompt-output-key-retirement/base/job.yaml',
      (source) =>
        source.replace(
          '      automountServiceAccountToken: false',
          '      automountServiceAccountToken: true',
        ),
    ),
  });
  assert.equal(automaticToken.compatible, false);
  assert.ok(
    automaticToken.findings.some(
      ({ code }) =>
        code === 'QL3_CLUSTER_PROMPT_OUTPUT_KEY_RETIREMENT_LIFECYCLE',
    ),
  );

  const longLivedToken = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/prompt-output-key-retirement/base/job.yaml',
      (source) =>
        source.replace('expirationSeconds: 600', 'expirationSeconds: 3600'),
    ),
  });
  assert.equal(longLivedToken.compatible, false);
  assert.ok(
    longLivedToken.findings.some(
      ({ code }) =>
        code === 'QL3_CLUSTER_PROMPT_OUTPUT_KEY_RETIREMENT_FILE_BOUNDARY',
    ),
  );
});

test('rejects public Prompt output key retirement egress', () => {
  const report = auditClusterDeployment({
    root: ROOT,
    readFile: intercept(
      'deploy/kubernetes/ql3-cluster/operations/prompt-output-key-retirement/base/network-policy.yaml',
      (source) =>
        source.replace(
          '  egress:\n',
          '  egress:\n    - to:\n        - ipBlock:\n            cidr: 0.0.0.0/0\n',
        ),
    ),
  });
  assert.equal(report.compatible, false);
  assert.equal(
    report.findings.some(
      ({ code }) =>
        code === 'QL3_CLUSTER_PROMPT_OUTPUT_KEY_RETIREMENT_NETWORK_POLICY',
    ),
    true,
  );
});
