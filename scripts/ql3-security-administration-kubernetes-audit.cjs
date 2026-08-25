#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const NAME = 'ql3-security-administration';
const PRIVATE_ROOT = '/var/run/qinglong3/security-administration-private';
const DELIVERY_ROOT =
  '/var/lib/qinglong3/security-administration-delivery/private';

function finding(code, detail) {
  return Object.freeze({ code, detail });
}

function parse(readFile, filePath) {
  return yaml.load(readFile(filePath, 'utf8'));
}

function named(entries, name) {
  return Array.isArray(entries)
    ? entries.find((entry) => entry?.name === name)
    : undefined;
}

function environment(container) {
  return new Map((container?.env ?? []).map((entry) => [entry.name, entry]));
}

function hasExactResources(container) {
  return (
    JSON.stringify(container?.resources) ===
    JSON.stringify({
      requests: { cpu: '25m', memory: '48Mi' },
      limits: { cpu: '250m', memory: '128Mi' },
    })
  );
}

function lockedContainer(container) {
  return (
    container?.securityContext?.allowPrivilegeEscalation === false &&
    container?.securityContext?.readOnlyRootFilesystem === true &&
    JSON.stringify(container?.securityContext?.capabilities?.drop) ===
      JSON.stringify(['ALL']) &&
    hasExactResources(container)
  );
}

function auditSecurityAdministrationKubernetes(options = {}) {
  const root = options.root ?? path.resolve(__dirname, '..');
  const readFile = options.readFile ?? fs.readFileSync;
  const operation = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/operations/security-administration',
  );
  const findings = [];
  try {
    const base = path.join(operation, 'base');
    const baseKustomization = parse(
      readFile,
      path.join(base, 'kustomization.yaml'),
    );
    const serviceAccount = parse(
      readFile,
      path.join(base, 'service-account.yaml'),
    );
    const job = parse(readFile, path.join(base, 'job.yaml'));
    const networkPolicy = parse(
      readFile,
      path.join(base, 'network-policy.yaml'),
    );
    const pod = job?.spec?.template?.spec;
    const administrator = named(pod?.containers, 'administrator');
    const stager = named(pod?.initContainers, 'stage-private-input');
    const input = named(pod?.volumes, 'projected-input');
    const privateInput = named(pod?.volumes, 'private-input');
    const postgresCa = named(pod?.volumes, 'postgres-ca');
    const adminEnv = environment(administrator);

    if (
      JSON.stringify(baseKustomization?.resources) !==
        JSON.stringify([
          'service-account.yaml',
          'job.yaml',
          'network-policy.yaml',
        ]) ||
      JSON.stringify(baseKustomization).includes('rbac.authorization.k8s.io')
    ) {
      findings.push(
        finding(
          'QL3_SECURITY_ADMIN_KUBERNETES_BASE_CLOSURE_INVALID',
          'base closure must contain exactly ServiceAccount, Job and NetworkPolicy without Kubernetes API RBAC',
        ),
      );
    }

    if (
      serviceAccount?.metadata?.name !== NAME ||
      serviceAccount?.automountServiceAccountToken !== false ||
      pod?.serviceAccountName !== NAME ||
      pod?.automountServiceAccountToken !== false ||
      pod?.enableServiceLinks !== false ||
      JSON.stringify(pod).includes('serviceAccountToken')
    ) {
      findings.push(
        finding(
          'QL3_SECURITY_ADMIN_KUBERNETES_API_AUTHORITY_INVALID',
          'the one-shot Job must have no Kubernetes API token or RBAC authority',
        ),
      );
    }

    if (
      job?.metadata?.name !== NAME ||
      job?.metadata?.labels?.['qinglong.io/execution-model'] !==
        'caller-driven' ||
      job?.spec?.backoffLimit !== 0 ||
      job?.spec?.activeDeadlineSeconds !== 300 ||
      job?.spec?.ttlSecondsAfterFinished !== 600 ||
      pod?.restartPolicy !== 'Never' ||
      pod?.securityContext?.runAsNonRoot !== true ||
      pod?.securityContext?.runAsUser !== 10001 ||
      pod?.securityContext?.runAsGroup !== 10001 ||
      pod?.securityContext?.fsGroup !== 10001 ||
      pod?.securityContext?.fsGroupChangePolicy !== 'OnRootMismatch' ||
      pod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault'
    ) {
      findings.push(
        finding(
          'QL3_SECURITY_ADMIN_KUBERNETES_JOB_BOUNDARY_INVALID',
          'Job must remain caller-driven, non-root, non-retrying and deadline/TTL bounded',
        ),
      );
    }

    const expectedStagerCommand = [
      'node',
      '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/security-administration/clusterAdministrationKubernetesInputStageCli.js',
    ];
    const expectedStagerArgs = [
      '--source=/var/run/secrets/qinglong3/security-administration-projected',
      `--target=${PRIVATE_ROOT}/input`,
    ];
    const expectedAdminCommand = [
      'node',
      '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/security-administration/clusterAdministrationCli.js',
    ];
    const expectedAdminArgs = [
      `--command=${PRIVATE_ROOT}/input/command.json`,
      `--assertion=${PRIVATE_ROOT}/input/assertion.jwt`,
      `--keyset=${PRIVATE_ROOT}/input/keyset.json`,
      `--pepper-keyring=${PRIVATE_ROOT}/input/pepper-keyring.json`,
    ];
    if (
      JSON.stringify(stager?.command) !==
        JSON.stringify(expectedStagerCommand) ||
      JSON.stringify(stager?.args) !== JSON.stringify(expectedStagerArgs) ||
      JSON.stringify(administrator?.command) !==
        JSON.stringify(expectedAdminCommand) ||
      JSON.stringify(administrator?.args) !==
        JSON.stringify(expectedAdminArgs) ||
      !lockedContainer(stager) ||
      !lockedContainer(administrator) ||
      JSON.stringify(pod).includes('/bin/sh') ||
      JSON.stringify(pod).includes('--delivery=')
    ) {
      findings.push(
        finding(
          'QL3_SECURITY_ADMIN_KUBERNETES_PROCESS_INVALID',
          'base Job must directly execute the reviewed stager and non-delivery administrator with compact resources',
        ),
      );
    }

    if (
      input?.secret?.secretName !== 'ql3-security-administration-input' ||
      input?.secret?.defaultMode !== 0o440 ||
      JSON.stringify(input?.secret?.items?.map((entry) => entry.key)) !==
        JSON.stringify([
          'command.json',
          'assertion.jwt',
          'keyset.json',
          'pepper-keyring.json',
        ]) ||
      privateInput?.emptyDir?.medium !== 'Memory' ||
      privateInput?.emptyDir?.sizeLimit !== '1Mi' ||
      postgresCa?.secret?.secretName !== 'ql3-security-administration-database'
    ) {
      findings.push(
        finding(
          'QL3_SECURITY_ADMIN_KUBERNETES_INPUT_INVALID',
          'projected immutable inputs must be copied to a 1Mi memory-backed private boundary before use',
        ),
      );
    }

    if (
      adminEnv.get('QL3_POSTGRES_ADMIN_TLS_MODE')?.value !== 'verify-full' ||
      adminEnv.get('QL3_POSTGRES_ADMIN_TLS_CA_FILE')?.value !==
        '/var/run/secrets/qinglong3/postgres-security-administration/ca.crt' ||
      adminEnv.get('QL3_POSTGRES_ADMIN_URL')?.valueFrom?.secretKeyRef?.name !==
        'ql3-security-administration-database' ||
      adminEnv.get('QL3_POSTGRES_ADMIN_TLS_SERVERNAME')?.valueFrom?.secretKeyRef
        ?.name !== 'ql3-security-administration-database'
    ) {
      findings.push(
        finding(
          'QL3_SECURITY_ADMIN_KUBERNETES_POSTGRES_INVALID',
          'generic base must use isolated Secret-backed admin credentials and verify-full TLS',
        ),
      );
    }

    if (
      networkPolicy?.spec?.ingress?.length !== 0 ||
      networkPolicy?.spec?.egress?.length !== 1 ||
      JSON.stringify(networkPolicy).includes('ipBlock')
    ) {
      findings.push(
        finding(
          'QL3_SECURITY_ADMIN_KUBERNETES_NETWORK_INVALID',
          'generic base must deny ingress and expose only DNS until a reviewed database overlay is selected',
        ),
      );
    }

    const inputExample = parse(
      readFile,
      path.join(operation, 'input-secret.example.yaml'),
    );
    const aggregate = parse(
      readFile,
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      ),
    );
    if (
      inputExample?.immutable !== true ||
      inputExample?.metadata?.name !== 'ql3-security-administration-input' ||
      JSON.stringify(Object.keys(inputExample?.stringData ?? {}).sort()) !==
        JSON.stringify(
          [
            'command.json',
            'assertion.jwt',
            'keyset.json',
            'pepper-keyring.json',
          ].sort(),
        ) ||
      JSON.stringify(aggregate).includes('security-administration')
    ) {
      findings.push(
        finding(
          'QL3_SECURITY_ADMIN_KUBERNETES_OPT_IN_INVALID',
          'input authority must be immutable and the operation must remain absent from the shared deployment aggregate',
        ),
      );
    }

    const cnpgPatch = parse(
      readFile,
      path.join(operation, 'cloudnative-pg/job-patch.yaml'),
    );
    const cnpgNetwork = parse(
      readFile,
      path.join(operation, 'cloudnative-pg/network-policy-patch.yaml'),
    );
    const cnpgEnv = new Map(
      (
        cnpgPatch?.find((entry) => entry.path.endsWith('/env'))?.value ?? []
      ).map((entry) => [entry.name, entry]),
    );
    if (
      cnpgEnv.get('QL3_POSTGRES_ADMIN_HOST')?.value !==
        'ql3-postgres-rw.qinglong3-system.svc' ||
      cnpgEnv.get('QL3_POSTGRES_ADMIN_USER')?.valueFrom?.secretKeyRef?.name !==
        'ql3-postgres-admin-auth' ||
      cnpgEnv.get('QL3_POSTGRES_ADMIN_PASSWORD')?.valueFrom?.secretKeyRef
        ?.name !== 'ql3-postgres-admin-auth' ||
      cnpgEnv.get('QL3_POSTGRES_ADMIN_TLS_MODE')?.value !== 'verify-full' ||
      cnpgNetwork?.spec?.egress?.length !== 2 ||
      !JSON.stringify(cnpgNetwork).includes('cnpg.io/cluster') ||
      !JSON.stringify(cnpgNetwork).includes('5432')
    ) {
      findings.push(
        finding(
          'QL3_SECURITY_ADMIN_KUBERNETES_CNPG_INVALID',
          'CloudNativePG overlay must bind the dedicated ql3_admin Secret, RW service, verify-full TLS and only PostgreSQL egress',
        ),
      );
    }

    const deliveryPatch = parse(
      readFile,
      path.join(operation, 'credential-delivery/component/job-patch.yaml'),
    );
    const deliveryText = JSON.stringify(deliveryPatch);
    const combined = parse(
      readFile,
      path.join(
        operation,
        'cloudnative-pg-credential-delivery/kustomization.yaml',
      ),
    );
    if (
      !deliveryText.includes(`--delivery-directory=${DELIVERY_ROOT}`) ||
      !deliveryText.includes(
        `--delivery=${DELIVERY_ROOT}/replace-with-unique-delivery.json`,
      ) ||
      !deliveryText.includes('ql3-security-administration-delivery') ||
      !deliveryText.includes('persistentVolumeClaim') ||
      JSON.stringify(combined?.components) !==
        JSON.stringify(['../credential-delivery/component'])
    ) {
      findings.push(
        finding(
          'QL3_SECURITY_ADMIN_KUBERNETES_DELIVERY_INVALID',
          'credential issue/rotate must opt into one reusable persistent no-replace delivery component',
        ),
      );
    }
  } catch (error) {
    findings.push(
      finding(
        'QL3_SECURITY_ADMIN_KUBERNETES_AUDIT_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    executionModel: 'opt-in-caller-driven-one-shot',
    residentResourceOverhead: 'zero',
    databaseConnectionsPerExecution: 1,
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

if (require.main === module) {
  const report = auditSecurityAdministrationKubernetes();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.compatible) process.exitCode = 1;
}

module.exports = { auditSecurityAdministrationKubernetes };
