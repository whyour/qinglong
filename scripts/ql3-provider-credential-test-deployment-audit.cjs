#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const NAME = 'ql3-provider-credential-test-executor';
const DIGEST_PLACEHOLDER = `sha256:${'0'.repeat(64)}`;
const MATERIAL_KEY =
  '31cf30a7b013bd31aa88867b1a8c48e35e7b88b5b49fb37eedd6222354679d02';

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

function privateIpv4HostCidr(value) {
  if (typeof value !== 'string' || !value.endsWith('/32')) return false;
  const octets = value.slice(0, -3).split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function auditProviderCredentialTestDeployment(options = {}) {
  const root = path.resolve(options.root ?? path.join(__dirname, '..'));
  const readFile = options.readFile ?? fs.readFileSync;
  const findings = [];
  try {
    const operation =
      'deploy/kubernetes/ql3-cluster/operations/provider-credential-test-executor';
    const manager =
      'deploy/kubernetes/ql3-cluster/operations/provider-credential-management/base';
    const job = load(readFile, root, `${operation}/base/job.yaml`);
    const serviceAccount = load(
      readFile,
      root,
      `${operation}/base/service-account.yaml`,
    );
    const network = load(
      readFile,
      root,
      `${operation}/base/network-policy.yaml`,
    );
    const cnpgPatch = load(
      readFile,
      root,
      `${operation}/cloudnative-pg/job-patch.yaml`,
    );
    const cnpgNetwork = load(
      readFile,
      root,
      `${operation}/cloudnative-pg/network-policy-patch.yaml`,
    );
    const cnpgKustomization = load(
      readFile,
      root,
      `${operation}/cloudnative-pg/kustomization.yaml`,
    );
    const privatePatch = load(
      readFile,
      root,
      `${operation}/private-provider-egress-patch.example.yaml`,
    );
    const privateCaPatch = load(
      readFile,
      root,
      `${operation}/private-provider-ca-patch.example.yaml`,
    );
    const examples = loadDocuments(
      readFile(path.join(root, operation, 'config.example.yaml'), 'utf8'),
    );
    const managerDeployment = load(
      readFile,
      root,
      `${manager}/deployment.yaml`,
    );
    const managerNetwork = load(
      readFile,
      root,
      `${manager}/network-policy.yaml`,
    );

    const pod = job?.spec?.template?.spec;
    const container = pod?.containers?.[0];
    const environment = envMap(container);
    const volumes = volumeMap(pod);
    if (
      job?.apiVersion !== 'batch/v1' ||
      job?.kind !== 'Job' ||
      job?.metadata?.name !== NAME ||
      job?.metadata?.labels?.['qinglong.io/execution-model'] !==
        'caller-driven' ||
      job?.spec?.backoffLimit !== 0 ||
      job?.spec?.activeDeadlineSeconds !== 60 ||
      job?.spec?.ttlSecondsAfterFinished !== 300 ||
      pod?.restartPolicy !== 'Never'
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_TEST_JOB_INVALID',
          'tester must be a bounded caller-driven, non-retrying, one-shot Job',
        ),
      );
    }
    if (
      serviceAccount?.automountServiceAccountToken !== false ||
      pod?.automountServiceAccountToken !== false ||
      pod?.serviceAccountName !== NAME ||
      container?.securityContext?.readOnlyRootFilesystem !== true ||
      container?.securityContext?.allowPrivilegeEscalation !== false ||
      container?.securityContext?.capabilities?.drop?.[0] !== 'ALL' ||
      pod?.securityContext?.runAsNonRoot !== true
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_TEST_SANDBOX_INVALID',
          'tester must use a tokenless ServiceAccount and non-root read-only container',
        ),
      );
    }
    if (
      container?.command?.[1] !==
        '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/model-provider-credential/modelProviderCredentialTestExecutorCli.js' ||
      environment.get('QL3_MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTOR_ENABLED')
        ?.value !== 'true' ||
      environment.get(
        'QL3_MODEL_PROVIDER_CREDENTIAL_TEST_WRITE_TERMINATION_MESSAGE',
      )?.value !== 'true' ||
      environment.get('QL3_POSTGRES_AI_CREDENTIAL_TESTER_POOL_MAX')?.value !==
        '1' ||
      environment.get('QL3_MODEL_PROVIDER_CREDENTIAL_TEST_SECRET_ROOT')
        ?.value !== '/var/run/secrets/qinglong3/provider-credential-test' ||
      [...environment.keys()].some((name) =>
        /MANAGER|RUNTIME|ADMIN_URL|PROVIDER_TOKEN|API_KEY/.test(name),
      )
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_TEST_PROCESS_INVALID',
          'tester must select only the one-shot entrypoint, tester database role and projected Secret root',
        ),
      );
    }
    const commandSources = volumes.get('command')?.projected?.sources ?? [];
    const material = volumes.get('provider-secret')?.secret;
    if (
      commandSources.length !== 2 ||
      commandSources.some((source) => !source?.configMap) ||
      material?.secretName !== 'ql3-provider-credential-test-material' ||
      material?.defaultMode !== 288 ||
      material?.items?.length !== 1 ||
      material.items[0]?.key !== MATERIAL_KEY ||
      material.items[0]?.path !== MATERIAL_KEY ||
      volumes.get('postgres-ai-credential-tester-ca')?.secret?.secretName !==
        'ql3-cluster-provider-credential-test-database'
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_TEST_AUTHORITY_INVALID',
          'command/allowlist must be public ConfigMaps while exactly one hashed provider material file and tester CA are projected separately',
        ),
      );
    }
    const egress = network?.spec?.egress ?? [];
    if (
      network?.spec?.ingress?.length !== 0 ||
      egress.length !== 1 ||
      egress[0]?.ports?.length !== 2 ||
      egress[0].ports.some((port) => port?.port !== 53) ||
      JSON.stringify(egress).includes('ipBlock')
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_TEST_BASE_NETWORK_INVALID',
          'base tester must deny ingress and all egress except DNS',
        ),
      );
    }

    const cnpgEnvironment = new Map(
      (
        cnpgPatch?.find((entry) => entry.path?.endsWith('/env'))?.value ?? []
      ).map((entry) => [entry.name, entry]),
    );
    if (
      cnpgEnvironment.get('QL3_POSTGRES_AI_CREDENTIAL_TESTER_USER')?.valueFrom
        ?.secretKeyRef?.name !== 'ql3-postgres-ai-credential-tester-auth' ||
      cnpgEnvironment.get('QL3_POSTGRES_AI_CREDENTIAL_TESTER_PASSWORD')
        ?.valueFrom?.secretKeyRef?.name !==
        'ql3-postgres-ai-credential-tester-auth' ||
      cnpgEnvironment.get('QL3_POSTGRES_AI_CREDENTIAL_TESTER_HOST')?.value !==
        'ql3-postgres-rw.qinglong3-system.svc' ||
      cnpgNetwork?.spec?.egress?.length !== 2 ||
      cnpgNetwork.spec.egress[1]?.to?.[0]?.podSelector?.matchLabels?.[
        'cnpg.io/cluster'
      ] !== 'ql3-postgres' ||
      cnpgNetwork.spec.egress[1]?.ports?.[0]?.port !== 5432 ||
      cnpgKustomization?.images?.[0]?.digest !== DIGEST_PLACEHOLDER
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_TEST_CNPG_INVALID',
          'CloudNativePG overlay must bind only the tester role, writer endpoint and exact database Pod egress',
        ),
      );
    }
    const privateRule = privatePatch?.[0];
    const providerEgress = privateRule?.value;
    if (
      privateRule?.op !== 'add' ||
      privateRule?.path !== '/spec/egress/-' ||
      providerEgress?.to?.length !== 1 ||
      !privateIpv4HostCidr(providerEgress.to[0]?.ipBlock?.cidr) ||
      providerEgress?.ports?.length !== 1 ||
      providerEgress.ports[0]?.protocol !== 'TCP' ||
      providerEgress.ports[0]?.port !== 443
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_TEST_PRIVATE_EGRESS_INVALID',
          'provider egress example must append only one exact private /32 TCP 443 rule',
        ),
      );
    }
    const privateCaEnvironment = privateCaPatch?.find(
      (entry) => entry?.path === '/spec/template/spec/containers/0/env/-',
    )?.value;
    const privateCaMount = privateCaPatch?.find(
      (entry) =>
        entry?.path === '/spec/template/spec/containers/0/volumeMounts/-',
    )?.value;
    const privateCaVolume = privateCaPatch?.find(
      (entry) => entry?.path === '/spec/template/spec/volumes/-',
    )?.value;
    if (
      privateCaPatch?.length !== 3 ||
      privateCaPatch.some((entry) => entry?.op !== 'add') ||
      privateCaEnvironment?.name !== 'NODE_EXTRA_CA_CERTS' ||
      privateCaEnvironment?.value !==
        '/var/run/secrets/qinglong3/provider-ca/ca.crt' ||
      privateCaMount?.name !== 'provider-ca' ||
      privateCaMount?.mountPath !== '/var/run/secrets/qinglong3/provider-ca' ||
      privateCaMount?.readOnly !== true ||
      privateCaVolume?.name !== 'provider-ca' ||
      privateCaVolume?.secret?.secretName !==
        'ql3-provider-credential-test-provider-ca' ||
      privateCaVolume?.secret?.defaultMode !== 292 ||
      privateCaVolume?.secret?.items?.length !== 1 ||
      privateCaVolume.secret.items[0]?.key !== 'ca.crt' ||
      privateCaVolume.secret.items[0]?.path !== 'ca.crt' ||
      JSON.stringify(privateCaPatch).includes('privateKey')
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_TEST_PRIVATE_CA_INVALID',
          'private provider trust must project only one read-only public CA and configure the Node.js trust path',
        ),
      );
    }

    const exampleByName = new Map(
      examples.map((resource) => [resource?.metadata?.name, resource]),
    );
    const command = exampleByName.get('ql3-provider-credential-test-command');
    const allowlist = exampleByName.get(
      'ql3-provider-credential-test-allowlist',
    );
    const providerSecret = exampleByName.get(
      'ql3-provider-credential-test-material',
    );
    const allowlistText = allowlist?.data?.['allowlist.json'];
    if (
      typeof command?.data?.['command.json'] !== 'string' ||
      !command.data['command.json'].includes('"executionId"') ||
      !command.data['command.json'].includes('"testId"') ||
      typeof allowlistText !== 'string' ||
      !allowlistText.includes('"baseUrl":"https://') ||
      !allowlistText.includes('"maxCostMicrousd":0') ||
      !allowlistText.includes('"retryLimit":0') ||
      providerSecret?.stringData?.[MATERIAL_KEY] !==
        'REPLACE_WITH_PROVIDER_TOKEN' ||
      Object.keys(providerSecret?.stringData ?? {}).length !== 1
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_TEST_EXAMPLE_INVALID',
          'examples must bind exact IDs, canonical HTTPS zero-cost/zero-retry allowlist and one hashed placeholder Secret key',
        ),
      );
    }

    const managerText = JSON.stringify(managerDeployment);
    if (
      managerText.includes('ql3-provider-credential-test-material') ||
      managerText.includes('CREDENTIAL_TEST_SECRET_ROOT') ||
      managerNetwork?.spec?.egress?.length !== 1 ||
      JSON.stringify(managerNetwork?.spec?.egress).includes('ipBlock')
    ) {
      findings.push(
        finding(
          'QL3_PROVIDER_CREDENTIAL_TEST_MANAGER_ISOLATION_INVALID',
          'long-lived manager must have no provider Secret projection or provider egress',
        ),
      );
    }
  } catch (error) {
    findings.push(
      finding(
        'QL3_PROVIDER_CREDENTIAL_TEST_DEPLOYMENT_AUDIT_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    executionModel: 'caller-driven-one-shot',
    postgresAuthority: 'ql3_ai_credential_tester',
    providerEgress: 'exact-private-cidr-plus-canonical-https-allowlist',
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

if (require.main === module) {
  const report = auditProviderCredentialTestDeployment();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.compatible) process.exitCode = 1;
}

module.exports = { auditProviderCredentialTestDeployment };
