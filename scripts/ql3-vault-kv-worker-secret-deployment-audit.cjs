#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

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

function named(values, name) {
  return (values ?? []).find((value) => value?.name === name);
}

function auditVaultKvWorkerSecretDeployment(options = {}) {
  const root = path.resolve(options.root ?? path.join(__dirname, '..'));
  const readFile = options.readFile ?? fs.readFileSync;
  const findings = [];
  try {
    const directory = 'deploy/kubernetes/ql3-cluster/vault-kv-worker-secret';
    const kustomization = load(
      readFile,
      root,
      `${directory}/kustomization.yaml`,
    );
    const patch = load(readFile, root, `${directory}/deployment-patch.yaml`);
    const credentials = loadDocuments(
      readFile(path.join(root, directory, 'credentials.example.yaml'), 'utf8'),
    );
    const readme = readFile(path.join(root, directory, 'README.md'), 'utf8');
    if (
      kustomization?.apiVersion !== 'kustomize.config.k8s.io/v1beta1' ||
      kustomization?.kind !== 'Kustomization' ||
      JSON.stringify(kustomization?.resources) !==
        JSON.stringify(['../base']) ||
      JSON.stringify(kustomization?.patches) !==
        JSON.stringify([{ path: 'deployment-patch.yaml' }])
    ) {
      findings.push(
        finding(
          'QL3_VAULT_KV_WORKER_SECRET_KUSTOMIZATION_INVALID',
          'the Vault overlay must patch only the reviewed Cluster base',
        ),
      );
    }
    const pod = patch?.spec?.template?.spec;
    const container = named(pod?.containers, 'cluster-control');
    const env = new Map(
      (container?.env ?? []).map((entry) => [entry.name, entry]),
    );
    const expectedEnvironment = new Map([
      ['QL3_WORKER_SECRET_PROVIDER', 'vault-kv-v2'],
      [
        'QL3_WORKER_SECRET_VAULT_ENDPOINT',
        'https://vault.vault.svc.cluster.local:8200',
      ],
      [
        'QL3_WORKER_SECRET_VAULT_CA_FILE',
        '/var/run/secrets/qinglong3/worker-vault-trust/ca.pem',
      ],
      [
        'QL3_WORKER_SECRET_VAULT_TOKEN_FILE',
        '/var/run/secrets/qinglong3/worker-vault-auth/token',
      ],
      ['QL3_WORKER_SECRET_VAULT_KV_MOUNT', 'worker-secrets'],
      ['QL3_WORKER_SECRET_VAULT_PATH_PREFIX', 'values/production'],
      ['QL3_WORKER_SECRET_VAULT_EXPECTED_POLICY', 'ql3-worker-secret-read'],
      ['QL3_WORKER_SECRET_VAULT_MAX_TOKEN_TTL_SECONDS', '900'],
      ['QL3_WORKER_SECRET_VAULT_REQUEST_TIMEOUT_MS', '5000'],
      ['QL3_WORKER_SECRET_VAULT_MAX_CONCURRENCY', '4'],
    ]);
    if (
      env.size !== expectedEnvironment.size + 1 ||
      env.get('QL3_WORKER_SECRET_ROOT_DIRECTORY')?.$patch !== 'delete' ||
      [...expectedEnvironment].some(
        ([name, value]) => env.get(name)?.value !== value,
      )
    ) {
      findings.push(
        finding(
          'QL3_VAULT_KV_WORKER_SECRET_ENVIRONMENT_INVALID',
          'the overlay must select exact Vault KV v2 authority and bounds while deleting the mounted-value root',
        ),
      );
    }
    const mounts = container?.volumeMounts ?? [];
    const valuesMount = named(mounts, 'worker-secret-values');
    const trustMount = named(mounts, 'worker-vault-trust');
    const authMount = named(mounts, 'worker-vault-auth');
    const volumes = pod?.volumes ?? [];
    const valuesVolume = named(volumes, 'worker-secret-values');
    const trustVolume = named(volumes, 'worker-vault-trust');
    const authVolume = named(volumes, 'worker-vault-auth');
    if (
      mounts.length !== 3 ||
      valuesMount?.$patch !== 'delete' ||
      trustMount?.mountPath !==
        '/var/run/secrets/qinglong3/worker-vault-trust' ||
      trustMount?.readOnly !== true ||
      authMount?.mountPath !== '/var/run/secrets/qinglong3/worker-vault-auth' ||
      authMount?.readOnly !== true ||
      volumes.length !== 3 ||
      valuesVolume?.$patch !== 'delete' ||
      trustVolume?.secret?.secretName !== 'ql3-cluster-worker-vault-trust' ||
      trustVolume?.secret?.defaultMode !== 0o444 ||
      JSON.stringify(trustVolume?.secret?.items) !==
        JSON.stringify([{ key: 'ca.pem', path: 'ca.pem' }]) ||
      authVolume?.secret?.secretName !== 'ql3-cluster-worker-vault-auth' ||
      authVolume?.secret?.defaultMode !== 0o440 ||
      JSON.stringify(authVolume?.secret?.items) !==
        JSON.stringify([{ key: 'token', path: 'token' }])
    ) {
      findings.push(
        finding(
          'QL3_VAULT_KV_WORKER_SECRET_PROJECTION_INVALID',
          'only read-only Vault trust and short-lived auth projections are allowed; the value projection must be deleted',
        ),
      );
    }
    if (
      credentials.length !== 2 ||
      credentials[0]?.kind !== 'Secret' ||
      credentials[0]?.metadata?.name !== 'ql3-cluster-worker-vault-trust' ||
      credentials[0]?.stringData?.['ca.pem'] !==
        'REPLACE_WITH_PRIVATE_VAULT_CA_PEM' ||
      credentials[1]?.kind !== 'Secret' ||
      credentials[1]?.metadata?.name !== 'ql3-cluster-worker-vault-auth' ||
      credentials[1]?.stringData?.token !==
        'REPLACE_WITH_SHORT_LIVED_ORPHAN_VAULT_TOKEN'
    ) {
      findings.push(
        finding(
          'QL3_VAULT_KV_WORKER_SECRET_EXAMPLE_INVALID',
          'credential examples must contain only explicit non-production placeholders',
        ),
      );
    }
    if (
      !readme.includes('auth/token/lookup-self') ||
      !readme.includes('capabilities = ["read"]') ||
      !/must not project\s+the actual Worker Secret values/.test(readme) ||
      !readme.includes('default-deny')
    ) {
      findings.push(
        finding(
          'QL3_VAULT_KV_WORKER_SECRET_OPERATIONS_INVALID',
          'operations guidance must preserve exact policy, direct custody and explicit egress boundaries',
        ),
      );
    }
  } catch (error) {
    findings.push(
      finding(
        'QL3_VAULT_KV_WORKER_SECRET_DEPLOYMENT_AUDIT_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    provider: 'vault-kv-v2',
    mountedValueProjection: false,
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

if (require.main === module) {
  const report = auditVaultKvWorkerSecretDeployment();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.compatible) process.exitCode = 1;
}

module.exports = { auditVaultKvWorkerSecretDeployment };
