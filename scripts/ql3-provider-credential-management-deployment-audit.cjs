#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const NAME = 'ql3-provider-credential-management';
const CLIENT_NAME = `${NAME}-client`;
const DIGEST_PLACEHOLDER =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';

function finding(code, detail) {
  return Object.freeze({ code, detail });
}

function load(readFile, root, relativePath) {
  return yaml.load(readFile(path.join(root, relativePath), 'utf8'));
}

function loadDocuments(source) {
  const documents = [];
  yaml.loadAll(source, (document) => {
    if (document) documents.push(document);
  });
  return documents;
}

function envMap(container) {
  return new Map((container?.env ?? []).map((entry) => [entry.name, entry]));
}

function volumeMap(pod) {
  return new Map((pod?.volumes ?? []).map((entry) => [entry.name, entry]));
}

function exactValue(environment, name, expected, findings) {
  if (environment.get(name)?.value !== expected) {
    findings.push(
      finding(
        'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_ENV_INVALID',
        `${name} must equal ${expected}`,
      ),
    );
  }
}

function auditProviderCredentialManagementDeployment(options = {}) {
  const root = path.resolve(options.root ?? path.join(__dirname, '..'));
  const readFile = options.readFile ?? fs.readFileSync;
  const findings = [];
  try {
    const base =
      'deploy/kubernetes/ql3-cluster/operations/provider-credential-management/base';
    const cnpg =
      'deploy/kubernetes/ql3-cluster/operations/provider-credential-management/cloudnative-pg';
    const client =
      'deploy/kubernetes/ql3-cluster/operations/provider-credential-management-client';
    const deployment = load(readFile, root, `${base}/deployment.yaml`);
    const serviceAccount = load(readFile, root, `${base}/service-account.yaml`);
    const service = load(readFile, root, `${base}/service.yaml`);
    const pdb = load(readFile, root, `${base}/pod-disruption-budget.yaml`);
    const networkPolicy = load(readFile, root, `${base}/network-policy.yaml`);
    const cnpgPatch = load(readFile, root, `${cnpg}/deployment-patch.yaml`);
    const cnpgNetworkPolicy = load(
      readFile,
      root,
      `${cnpg}/network-policy-patch.yaml`,
    );
    const cnpgKustomization = load(
      readFile,
      root,
      `${cnpg}/kustomization.yaml`,
    );
    const clientJob = load(readFile, root, `${client}/base/job.yaml`);
    const clientServiceAccount = load(
      readFile,
      root,
      `${client}/base/service-account.yaml`,
    );
    const clientNetworkPolicy = load(
      readFile,
      root,
      `${client}/base/network-policy.yaml`,
    );
    const clientKustomization = load(
      readFile,
      root,
      `${client}/kustomization.yaml`,
    );
    const clientExample = readFile(
      path.join(root, client, 'config.example.yaml'),
      'utf8',
    );
    const managerExample = loadDocuments(
      readFile(
        path.join(
          root,
          'deploy/kubernetes/ql3-cluster/operations/provider-credential-management/config.example.yaml',
        ),
        'utf8',
      ),
    );
    const operations = load(
      readFile,
      root,
      'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
    );

    const pod = deployment?.spec?.template?.spec;
    const container = pod?.containers?.[0];
    const environment = envMap(container);
    const volumes = volumeMap(pod);
    if (
      deployment?.kind !== 'Deployment' ||
      deployment?.metadata?.name !== NAME ||
      deployment?.spec?.replicas !== 2 ||
      deployment?.spec?.strategy?.rollingUpdate?.maxUnavailable !== 0 ||
      !pod?.affinity?.podAntiAffinity
        ?.requiredDuringSchedulingIgnoredDuringExecution?.length ||
      pdb?.spec?.minAvailable !== 1
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_AVAILABILITY_INVALID',
          'manager requires two replicas, required anti-affinity, zero-unavailable rollout and PDB minAvailable 1',
        ),
      );
    }
    if (
      serviceAccount?.automountServiceAccountToken !== false ||
      pod?.automountServiceAccountToken !== false ||
      pod?.serviceAccountName !== NAME
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_SERVICE_ACCOUNT_INVALID',
          'manager must use a tokenless dedicated ServiceAccount',
        ),
      );
    }
    if (
      service?.spec?.type !== 'ClusterIP' ||
      service?.spec?.ports?.length !== 1 ||
      service.spec.ports[0]?.port !== 8446 ||
      service.spec.ports[0]?.protocol !== 'TCP'
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_SERVICE_INVALID',
          'manager must expose only ClusterIP TCP 8446',
        ),
      );
    }
    for (const [name, expected] of Object.entries({
      QL3_PROFILE: 'cluster-admin',
      QL3_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_ENABLED: 'true',
      QL3_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_PORT: '8446',
      QL3_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_MAX_BODY_BYTES: '32768',
      QL3_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_MAX_CONNECTIONS: '32',
      QL3_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_MAX_CONCURRENT_REQUESTS: '8',
      QL3_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_PEER_REQUEST_LIMIT: '30',
      QL3_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_GLOBAL_REQUEST_LIMIT: '120',
      QL3_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_MAX_RATE_LIMIT_PEERS: '256',
      QL3_POSTGRES_AI_CREDENTIAL_MANAGER_TLS_MODE: 'verify-full',
      QL3_POSTGRES_AI_CREDENTIAL_MANAGER_POOL_MAX: '2',
      QL3_MODEL_PROVIDER_CREDENTIAL_TEST_ALLOWLIST_FILE:
        '/var/run/qinglong3/provider-credential-test/allowlist.json',
      QL3_MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_LIFETIME_MS: '60000',
      QL3_MODEL_PROVIDER_CREDENTIAL_TEST_QUOTA_WINDOW_MS: '60000',
      QL3_MODEL_PROVIDER_CREDENTIAL_TEST_QUOTA_LIMIT: '5',
    })) {
      exactValue(environment, name, expected, findings);
    }
    if (
      container?.command?.[1] !==
        '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/model-provider-credential/modelProviderCredentialManagementCli.js' ||
      container?.securityContext?.readOnlyRootFilesystem !== true ||
      container?.securityContext?.allowPrivilegeEscalation !== false ||
      container?.securityContext?.capabilities?.drop?.[0] !== 'ALL' ||
      pod?.securityContext?.runAsNonRoot !== true
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_CONTAINER_INVALID',
          'manager command and non-root read-only security boundary must remain exact',
        ),
      );
    }
    const secretNames = [
      volumes.get('management-tls')?.secret?.secretName,
      volumes.get('management-identity')?.secret?.secretName,
      volumes.get('postgres-ai-credential-manager-ca')?.secret?.secretName,
    ];
    if (new Set(secretNames).size !== 3 || secretNames.some((name) => !name)) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_AUTHORITIES_NOT_SEPARATE',
          'TLS, OIDC keyset and PostgreSQL CA must use separate projected authorities',
        ),
      );
    }
    const allowlistVolume = volumes.get('provider-credential-test-allowlist');
    if (
      allowlistVolume?.configMap?.name !==
        'ql3-provider-credential-test-allowlist' ||
      allowlistVolume?.secret !== undefined ||
      [...volumes.keys()].some((name) =>
        /provider-(?:secret|credential-test-material)/.test(name),
      ) ||
      [...environment.keys()].some((name) =>
        /CREDENTIAL_TEST_SECRET_ROOT|PROVIDER_TOKEN|API_KEY/.test(name),
      )
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_TEST_AUTHORITY_INVALID',
          'manager must mount only the public test allowlist ConfigMap and no provider Secret material',
        ),
      );
    }
    const allowlistExample = managerExample.find(
      (resource) =>
        resource?.kind === 'ConfigMap' &&
        resource?.metadata?.name === 'ql3-provider-credential-test-allowlist',
    );
    if (
      typeof allowlistExample?.data?.['allowlist.json'] !== 'string' ||
      !allowlistExample.data['allowlist.json'].includes(
        'qinglong/model-provider-credential-test-allowlist@v1',
      ) ||
      !allowlistExample.data['allowlist.json'].includes(
        '"maxCostMicrousd":0',
      ) ||
      !allowlistExample.data['allowlist.json'].includes('"retryLimit":0')
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_ALLOWLIST_INVALID',
          'manager example must provide one content-free zero-cost zero-retry test allowlist ConfigMap',
        ),
      );
    }
    const ingress = networkPolicy?.spec?.ingress ?? [];
    if (
      ingress.length !== 1 ||
      ingress[0]?.ports?.[0]?.port !== 8446 ||
      ingress[0]?.from?.[0]?.podSelector?.matchLabels?.[
        'qinglong.io/provider-credential-management-client'
      ] !== 'true' ||
      (networkPolicy?.spec?.egress ?? []).length !== 1
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_NETWORK_INVALID',
          'base manager network closure must allow only labeled clients and DNS',
        ),
      );
    }
    if (
      (networkPolicy?.spec?.egress?.[0]?.ports ?? []).some(
        (port) => port?.port !== 53,
      ) ||
      JSON.stringify(networkPolicy?.spec?.egress).includes('ipBlock')
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_PROVIDER_EGRESS_INVALID',
          'long-lived manager base must have DNS only and no provider IP egress',
        ),
      );
    }
    const cnpgEnvironment = new Map(
      (
        cnpgPatch?.find((entry) => entry.path?.endsWith('/env'))?.value ?? []
      ).map((entry) => [entry.name, entry]),
    );
    if (
      cnpgEnvironment.get('QL3_POSTGRES_AI_CREDENTIAL_MANAGER_USER')?.valueFrom
        ?.secretKeyRef?.name !== 'ql3-postgres-ai-credential-manager-auth' ||
      cnpgEnvironment.get('QL3_POSTGRES_AI_CREDENTIAL_MANAGER_PASSWORD')
        ?.valueFrom?.secretKeyRef?.name !==
        'ql3-postgres-ai-credential-manager-auth' ||
      cnpgEnvironment.get('QL3_POSTGRES_AI_CREDENTIAL_MANAGER_HOST')?.value !==
        'ql3-postgres-rw.qinglong3-system.svc' ||
      cnpgNetworkPolicy?.spec?.egress?.[1]?.to?.[0]?.podSelector?.matchLabels?.[
        'cnpg.io/cluster'
      ] !== 'ql3-postgres' ||
      cnpgNetworkPolicy?.spec?.egress?.[1]?.ports?.[0]?.port !== 5432
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_CNPG_AUTHORITY_INVALID',
          'CloudNativePG overlay must bind the exact manager role, writer DNS and database Pod egress',
        ),
      );
    }
    if (
      cnpgKustomization?.images?.[0]?.digest !== DIGEST_PLACEHOLDER ||
      clientKustomization?.images?.[0]?.digest !== DIGEST_PLACEHOLDER
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_IMAGE_PIN_INVALID',
          'manager and client image transforms must fail closed on explicit SHA-256 digests',
        ),
      );
    }

    const clientPod = clientJob?.spec?.template?.spec;
    const clientContainer = clientPod?.containers?.[0];
    const clientVolumes = volumeMap(clientPod);
    if (
      clientJob?.kind !== 'Job' ||
      clientJob?.metadata?.labels?.['qinglong.io/execution-model'] !==
        'caller-driven' ||
      clientJob?.spec?.backoffLimit !== 0 ||
      clientJob?.spec?.activeDeadlineSeconds !== 120 ||
      clientPod?.restartPolicy !== 'Never' ||
      clientPod?.automountServiceAccountToken !== false ||
      clientServiceAccount?.automountServiceAccountToken !== false
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_CLIENT_JOB_INVALID',
          'client must remain a bounded caller-driven non-retrying tokenless Job',
        ),
      );
    }
    const clientScript = clientContainer?.args?.[0] ?? '';
    const readinessScript = clientPod?.initContainers?.[0]?.args?.[0] ?? '';
    if (
      !clientScript.includes('umask 077') ||
      !clientScript.includes('chmod 600') ||
      !clientScript.includes('modelProviderCredentialManagementClientCli.js') ||
      !readinessScript.includes("minVersion: 'TLSv1.3'") ||
      !readinessScript.includes("maxVersion: 'TLSv1.3'") ||
      !readinessScript.includes('rejectUnauthorized: true')
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_CLIENT_TLS_INVALID',
          'client must copy private inputs with mode 0600 and require verified TLS 1.3 mTLS',
        ),
      );
    }
    if (
      clientNetworkPolicy?.spec?.ingress?.length !== 0 ||
      clientNetworkPolicy?.spec?.egress?.length !== 2 ||
      clientNetworkPolicy?.spec?.egress?.[1]?.ports?.[0]?.port !== 8446 ||
      clientNetworkPolicy?.spec?.egress?.[1]?.to?.[0]?.podSelector
        ?.matchLabels?.['app.kubernetes.io/name'] !== NAME
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_CLIENT_NETWORK_INVALID',
          'client network closure must deny ingress and allow only DNS plus manager TCP 8446',
        ),
      );
    }
    if (
      clientVolumes.get('request')?.secret?.secretName !==
        'ql3-provider-credential-management-request' ||
      clientVolumes.get('assertion')?.secret?.secretName !==
        'ql3-provider-credential-management-assertion' ||
      clientVolumes.get('client-identity')?.secret?.secretName !==
        'ql3-provider-credential-management-client-identity' ||
      !clientExample.includes('immutable: true') ||
      /(?:sk-[A-Za-z0-9]|Bearer\s+[A-Za-z0-9]|api[_-]?key)/i.test(clientExample)
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_CLIENT_AUTHORITY_INVALID',
          'client request, assertion and certificate must be separate immutable examples without provider material',
        ),
      );
    }
    if (
      (operations?.resources ?? []).some((resource) =>
        String(resource).includes('provider-credential-management'),
      )
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_DEFAULT_ENABLED',
          'provider credential management must remain opt-in',
        ),
      );
    }
  } catch (error) {
    findings.push(
      finding(
        'QL3_PROVIDER_CREDENTIAL_MANAGEMENT_DEPLOYMENT_AUDIT_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    profile: 'cluster-admin',
    manager: 'optional-tls13-mtls-oidc-https',
    client: 'caller-driven-one-shot',
    postgresAuthority: 'ql3_ai_credential_manager',
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

if (require.main === module) {
  const report = auditProviderCredentialManagementDeployment();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.compatible) process.exitCode = 1;
}

module.exports = { auditProviderCredentialManagementDeployment };
