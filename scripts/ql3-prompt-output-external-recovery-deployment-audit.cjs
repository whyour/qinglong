const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { readReleaseIdentity } = require('./lib/ql3-release-identity.cjs');

const QL3_VERSION = readReleaseIdentity(path.resolve(__dirname, '..')).version;

const OPERATION = path.join(
  'deploy',
  'kubernetes',
  'ql3-cluster',
  'operations',
  'prompt-output-external-recovery',
);
const NAME = 'ql3-prompt-output-external-recovery-verifier';
const NAMESPACE = 'qinglong3-recovery';
const WORKSPACE = '/var/run/qinglong3/prompt-output-external-recovery';

function finding(findings, code, message) {
  findings.push({ code, message });
}

function load(root, relativePath, readFile) {
  return yaml.load(readFile(path.join(root, relativePath), 'utf8'));
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    keys.length === canonical.length &&
    keys.every((key, index) => key === canonical[index])
  );
}

function canonicalJson(root, relativePath, readFile) {
  return JSON.parse(readFile(path.join(root, relativePath), 'utf8'));
}

function auditPromptOutputExternalRecoveryDeployment(options = {}) {
  const root = options.root ?? path.resolve(__dirname, '..');
  const readFile = options.readFile ?? fs.readFileSync;
  const findings = [];
  let namespace;
  let serviceAccount;
  let networkPolicy;
  let job;
  let kustomization;
  let command;
  try {
    namespace = load(
      root,
      path.join(OPERATION, 'base/namespace.yaml'),
      readFile,
    );
    serviceAccount = load(
      root,
      path.join(OPERATION, 'base/service-account.yaml'),
      readFile,
    );
    networkPolicy = load(
      root,
      path.join(OPERATION, 'base/network-policy.yaml'),
      readFile,
    );
    job = load(root, path.join(OPERATION, 'base/job.yaml'), readFile);
    kustomization = load(
      root,
      path.join(OPERATION, 'base/kustomization.yaml'),
      readFile,
    );
    command = canonicalJson(
      root,
      path.join(OPERATION, 'command.example.json'),
      readFile,
    );
  } catch {
    finding(findings, 'QL3_RECOVERY_DEPLOYMENT_PARSE', 'resources must parse');
    return { schemaVersion: 1, compatible: false, findings };
  }

  if (
    namespace?.apiVersion !== 'v1' ||
    namespace?.kind !== 'Namespace' ||
    namespace?.metadata?.name !== NAMESPACE ||
    namespace?.metadata?.labels?.['qinglong.io/security-domain'] !==
      'isolated-recovery'
  ) {
    finding(
      findings,
      'QL3_RECOVERY_NAMESPACE',
      'recovery must use its exact isolated namespace',
    );
  }

  if (
    serviceAccount?.apiVersion !== 'v1' ||
    serviceAccount?.kind !== 'ServiceAccount' ||
    serviceAccount?.metadata?.name !== NAME ||
    serviceAccount?.metadata?.namespace !== NAMESPACE ||
    serviceAccount?.automountServiceAccountToken !== false ||
    serviceAccount?.secrets !== undefined
  ) {
    finding(
      findings,
      'QL3_RECOVERY_SERVICE_ACCOUNT',
      'verifier ServiceAccount must remain tokenless',
    );
  }

  const podLabels = job?.spec?.template?.metadata?.labels;
  const pod = job?.spec?.template?.spec;
  const containers = pod?.containers;
  const container = Array.isArray(containers) ? containers[0] : undefined;
  const mounts = container?.volumeMounts;
  const volumes = pod?.volumes;
  if (
    job?.apiVersion !== 'batch/v1' ||
    job?.kind !== 'Job' ||
    job?.metadata?.name !== NAME ||
    job?.metadata?.namespace !== NAMESPACE ||
    job?.spec?.backoffLimit !== 0 ||
    job?.spec?.activeDeadlineSeconds !== 120 ||
    job?.spec?.ttlSecondsAfterFinished !== 600 ||
    podLabels?.['app.kubernetes.io/name'] !== NAME ||
    podLabels?.['qinglong.io/execution-model'] !== 'caller-driven' ||
    pod?.serviceAccountName !== NAME ||
    pod?.automountServiceAccountToken !== false ||
    pod?.enableServiceLinks !== false ||
    pod?.restartPolicy !== 'Never' ||
    pod?.initContainers !== undefined ||
    !Array.isArray(containers) ||
    containers.length !== 1 ||
    container?.name !== 'verifier' ||
    container?.image !== `qinglong3-cluster-admin:${QL3_VERSION}` ||
    JSON.stringify(container?.command) !==
      JSON.stringify([
        'node',
        '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/prompt-output/external-recovery/promptOutputExternalRecoveryCli.js',
      ]) ||
    JSON.stringify(container?.args) !==
      JSON.stringify(['run', '--command-file', `${WORKSPACE}/command.json`]) ||
    container?.env !== undefined ||
    container?.envFrom !== undefined ||
    container?.ports !== undefined ||
    container?.securityContext?.allowPrivilegeEscalation !== false ||
    container?.securityContext?.readOnlyRootFilesystem !== true ||
    JSON.stringify(container?.securityContext?.capabilities?.drop) !==
      JSON.stringify(['ALL']) ||
    !Array.isArray(mounts) ||
    mounts.length !== 1 ||
    mounts[0]?.name !== 'recovery-workspace' ||
    mounts[0]?.mountPath !== WORKSPACE ||
    mounts[0]?.readOnly !== true ||
    !Array.isArray(volumes) ||
    volumes.length !== 1 ||
    volumes[0]?.name !== 'recovery-workspace' ||
    volumes[0]?.persistentVolumeClaim?.claimName !==
      'ql3-prompt-output-external-recovery-workspace' ||
    volumes[0]?.persistentVolumeClaim?.readOnly !== true
  ) {
    finding(
      findings,
      'QL3_RECOVERY_JOB',
      'verifier Job authority or resource envelope drifted',
    );
  }

  if (
    networkPolicy?.apiVersion !== 'networking.k8s.io/v1' ||
    networkPolicy?.kind !== 'NetworkPolicy' ||
    networkPolicy?.metadata?.namespace !== NAMESPACE ||
    networkPolicy?.spec?.podSelector?.matchLabels?.[
      'app.kubernetes.io/name'
    ] !== NAME ||
    JSON.stringify(networkPolicy?.spec?.policyTypes) !==
      JSON.stringify(['Ingress', 'Egress']) ||
    !Array.isArray(networkPolicy?.spec?.ingress) ||
    networkPolicy.spec.ingress.length !== 0 ||
    !Array.isArray(networkPolicy?.spec?.egress) ||
    networkPolicy.spec.egress.length !== 0
  ) {
    finding(
      findings,
      'QL3_RECOVERY_NETWORK_POLICY',
      'verifier network must remain deny-all',
    );
  }

  if (
    kustomization?.apiVersion !== 'kustomize.config.k8s.io/v1beta1' ||
    kustomization?.kind !== 'Kustomization' ||
    JSON.stringify(kustomization?.resources) !==
      JSON.stringify([
        'namespace.yaml',
        'service-account.yaml',
        'network-policy.yaml',
        'job.yaml',
      ])
  ) {
    finding(
      findings,
      'QL3_RECOVERY_KUSTOMIZATION',
      'recovery base must contain no RBAC or credential resource',
    );
  }

  const expectedCommandKeys = [
    'approverPublicKeyFiles',
    'artifactFile',
    'authorizationFile',
    'custodyBundleFile',
    'custodyPublicKeyFile',
    'durableKeyFactFile',
    'operation',
    'recoveredMaterialFile',
    'schemaVersion',
  ];
  const fileFields = expectedCommandKeys.filter((key) => key.endsWith('File'));
  if (
    !exactKeys(command, expectedCommandKeys) ||
    command.schemaVersion !== 1 ||
    command.operation !== 'cluster.prompt-output-key.verify-recovery' ||
    fileFields.some(
      (key) =>
        typeof command[key] !== 'string' ||
        !command[key].startsWith(`${WORKSPACE}/`),
    ) ||
    !Array.isArray(command.approverPublicKeyFiles) ||
    command.approverPublicKeyFiles.length !== 2 ||
    command.approverPublicKeyFiles.some(
      (entry) =>
        !exactKeys(entry, ['filePath', 'userId']) ||
        typeof entry.userId !== 'string' ||
        typeof entry.filePath !== 'string' ||
        !entry.filePath.startsWith(`${WORKSPACE}/`),
    )
  ) {
    finding(
      findings,
      'QL3_RECOVERY_COMMAND',
      'recovery command must bind the exact read-only workspace',
    );
  }

  return {
    schemaVersion: 1,
    compatible: findings.length === 0,
    namespace: NAMESPACE,
    serviceAccount: NAME,
    network: 'deny-all',
    databaseAuthority: false,
    kubernetesApiAuthority: false,
    kmsAuthority: false,
    workspaceReadOnly: true,
    findings,
  };
}

if (require.main === module) {
  const report = auditPromptOutputExternalRecoveryDeployment();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.compatible) process.exitCode = 1;
}

module.exports = { auditPromptOutputExternalRecoveryDeployment };
