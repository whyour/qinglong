#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const OPERATOR_DIRECTORY =
  'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg';
const RUNTIME_PATCH =
  'deploy/kubernetes/ql3-cluster/overlays/cloudnative-pg/postgres-runtime-patch.yaml';
const RUNTIME_KUSTOMIZATION =
  'deploy/kubernetes/ql3-cluster/overlays/cloudnative-pg/kustomization.yaml';
const MIGRATION_PATCH =
  'deploy/kubernetes/ql3-cluster/operations/cloudnative-pg/migrate-job-patch.yaml';
const MIGRATION_KUSTOMIZATION =
  'deploy/kubernetes/ql3-cluster/operations/cloudnative-pg/kustomization.yaml';
const PRIMARY_DNS = 'ql3-postgres-rw.qinglong3-system.svc';
const APPLICATION_IMAGE_NAME = 'qinglong3-cluster-control';
const APPLICATION_IMAGE_REPOSITORY =
  'registry.example.com/qinglong/qinglong3-cluster-control';
const FAIL_CLOSED_IMAGE_DIGEST = `sha256:${'0'.repeat(64)}`;
const POSTGRES_IMAGE =
  'ghcr.io/cloudnative-pg/postgresql:18.4-minimal-trixie@sha256:24d229d801663f95b584416f8ebdfad4849b1a3fa4cfcf95a7f026df7aa6e22d';
const OPERATOR_IMAGE =
  'ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0@sha256:a2701eb97cdd2a34b1fdb2cb51987f544b706e40bec72ae7146cd8580efefebb';

const EXPECTED_ROLES = Object.freeze({
  ql3_admin: Object.freeze({
    connectionLimit: 4,
    secret: 'ql3-postgres-admin-auth',
  }),
  ql3_ai_maintenance: Object.freeze({
    connectionLimit: 4,
    secret: 'ql3-postgres-ai-maintenance-auth',
  }),
  ql3_ai_credential_manager: Object.freeze({
    connectionLimit: 4,
    secret: 'ql3-postgres-ai-credential-manager-auth',
  }),
  ql3_ai_credential_tester: Object.freeze({
    connectionLimit: 2,
    secret: 'ql3-postgres-ai-credential-tester-auth',
  }),
  ql3_automation_manager: Object.freeze({
    connectionLimit: 4,
    secret: 'ql3-postgres-automation-manager-auth',
  }),
  ql3_approval_manager: Object.freeze({
    connectionLimit: 4,
    secret: 'ql3-postgres-approval-manager-auth',
  }),
  ql3_migration: Object.freeze({
    connectionLimit: 2,
    secret: 'ql3-postgres-migration-auth',
  }),
  ql3_package_executor: Object.freeze({
    connectionLimit: 4,
    secret: 'ql3-postgres-package-executor-auth',
  }),
  ql3_package_manager: Object.freeze({
    connectionLimit: 4,
    secret: 'ql3-postgres-package-manager-auth',
  }),
  ql3_runtime: Object.freeze({
    connectionLimit: 32,
    secret: 'ql3-postgres-runtime-auth',
  }),
  ql3_run_manager: Object.freeze({
    connectionLimit: 4,
    secret: 'ql3-postgres-run-manager-auth',
  }),
  ql3_worker_credential_executor: Object.freeze({
    connectionLimit: 4,
    secret: 'ql3-postgres-worker-credential-executor-auth',
  }),
  ql3_worker_credential_manager: Object.freeze({
    connectionLimit: 4,
    secret: 'ql3-postgres-worker-credential-manager-auth',
  }),
  ql3_worker_ingress: Object.freeze({
    connectionLimit: 32,
    secret: 'ql3-postgres-worker-ingress-auth',
  }),
});

function finding(code, detail) {
  return Object.freeze({ code, detail });
}

function loadDocuments(source) {
  const result = [];
  yaml.loadAll(source, (document) => {
    if (document) result.push(document);
  });
  return result;
}

function envByName(container) {
  return new Map(
    (Array.isArray(container?.env) ? container.env : []).map((entry) => [
      entry?.name,
      entry,
    ]),
  );
}

function exactSecretRef(entry, secret, key) {
  return (
    entry?.valueFrom?.secretKeyRef?.name === secret &&
    entry?.valueFrom?.secretKeyRef?.key === key
  );
}

function exactFailClosedApplicationImage(kustomization) {
  return (
    Array.isArray(kustomization?.images) &&
    kustomization.images.length === 1 &&
    kustomization.images[0]?.name === APPLICATION_IMAGE_NAME &&
    kustomization.images[0]?.newName === APPLICATION_IMAGE_REPOSITORY &&
    kustomization.images[0]?.digest === FAIL_CLOSED_IMAGE_DIGEST &&
    !Object.hasOwn(kustomization.images[0], 'newTag')
  );
}

function assertOperatorLock(readFile, root, findings) {
  const lock = JSON.parse(
    readFile(path.join(root, OPERATOR_DIRECTORY, 'operator-lock.json'), 'utf8'),
  );
  if (
    lock?.schemaVersion !== 1 ||
    lock?.operator?.name !== 'cloudnative-pg' ||
    lock?.operator?.version !== '1.30.0' ||
    lock?.operator?.image !== OPERATOR_IMAGE ||
    lock?.operator?.platforms?.['linux/amd64'] !==
      'sha256:091d306935cfdf646debfe78010d59ebfb572150eb6eb922b0203873c0c68841' ||
    lock?.operator?.platforms?.['linux/arm64'] !==
      'sha256:6c7926147fd23a053dea6605d61c013d43bfd411be3532e7500ef2d2b68bb98c'
  ) {
    findings.push(
      finding(
        'QL3_CNPG_OPERATOR_LOCK',
        'CloudNativePG 1.30.0 must remain locked to its reviewed multi-platform OCI digest',
      ),
    );
  }
  if (
    lock?.operator?.releaseManifest !==
      'https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.30.0/cnpg-1.30.0.yaml' ||
    lock?.operator?.releaseManifestSha256 !==
      'sha256:f8bede43fe4ee0d478c2355b204a36876b2ae4faac60f2a9452280b293da3b88' ||
    lock?.operator?.signatureBundle !==
      'https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.30.0/cnpg-1.30.0.sigstore.json' ||
    lock?.operand?.postgresqlVersion !== '18.4' ||
    lock?.operand?.image !== POSTGRES_IMAGE ||
    lock?.operand?.platforms?.['linux/amd64'] !==
      'sha256:67e56bcbe50a58e60509815dd89e58effc5f331ab844f66331d945cd42131e8d' ||
    lock?.operand?.platforms?.['linux/arm64'] !==
      'sha256:2adbb634a1c0af8cb036e81200aaa7c8b62517bf5e501699926b337bd9f863f1'
  ) {
    findings.push(
      finding(
        'QL3_CNPG_SUPPLY_CHAIN_LOCK',
        'operator release inputs and PostgreSQL 18.4 operand must remain digest locked',
      ),
    );
  }
}

function assertCluster(readFile, root, findings) {
  const cluster = yaml.load(
    readFile(path.join(root, OPERATOR_DIRECTORY, 'cluster.yaml'), 'utf8'),
  );
  const spec = cluster?.spec;
  const synchronous = spec?.postgresql?.synchronous;
  if (
    cluster?.apiVersion !== 'postgresql.cnpg.io/v1' ||
    cluster?.kind !== 'Cluster' ||
    cluster?.metadata?.name !== 'ql3-postgres' ||
    spec?.instances !== 3 ||
    spec?.imageName !== POSTGRES_IMAGE ||
    spec?.enableSuperuserAccess !== false
  ) {
    findings.push(
      finding(
        'QL3_CNPG_CLUSTER_BASELINE',
        'the production cluster must use three instances, disabled superuser access and the locked operand',
      ),
    );
  }
  if (
    synchronous?.method !== 'any' ||
    synchronous?.number !== 1 ||
    synchronous?.dataDurability !== 'required' ||
    synchronous?.failoverQuorum !== true ||
    spec?.postgresql?.parameters?.synchronous_commit !== 'remote_apply'
  ) {
    findings.push(
      finding(
        'QL3_CNPG_DURABILITY',
        'the HA profile must require one remote-applied synchronous replica and failover quorum',
      ),
    );
  }
  if (
    spec?.affinity?.enablePodAntiAffinity !== true ||
    spec?.affinity?.podAntiAffinityType !== 'required' ||
    spec?.affinity?.topologyKey !== 'kubernetes.io/hostname' ||
    JSON.stringify(spec?.managed?.services?.disabledDefaultServices) !==
      JSON.stringify(['r', 'ro'])
  ) {
    findings.push(
      finding(
        'QL3_CNPG_FAILURE_DOMAIN',
        'database instances must occupy distinct nodes and expose only the primary-tracking rw service',
      ),
    );
  }
  if (
    spec?.resources?.requests?.cpu !== '250m' ||
    spec?.resources?.requests?.memory !== '512Mi' ||
    spec?.resources?.limits?.cpu !== '2' ||
    spec?.resources?.limits?.memory !== '1Gi' ||
    spec?.storage?.size !== '20Gi' ||
    spec?.walStorage?.size !== '5Gi'
  ) {
    findings.push(
      finding(
        'QL3_CNPG_RESOURCE_ENVELOPE',
        'database CPU, memory, data and WAL envelopes must remain explicit',
      ),
    );
  }
}

function assertRolesAndDatabase(readFile, root, findings) {
  const roles = loadDocuments(
    readFile(
      path.join(root, OPERATOR_DIRECTORY, 'database-roles.yaml'),
      'utf8',
    ),
  );
  const seen = new Set();
  for (const role of roles) {
    const expected = EXPECTED_ROLES[role?.spec?.name];
    const spec = role?.spec;
    if (
      role?.apiVersion !== 'postgresql.cnpg.io/v1' ||
      role?.kind !== 'DatabaseRole' ||
      !expected ||
      seen.has(spec?.name) ||
      spec?.cluster?.name !== 'ql3-postgres' ||
      spec?.login !== true ||
      spec?.superuser !== false ||
      spec?.createdb !== false ||
      spec?.createrole !== false ||
      spec?.replication !== false ||
      spec?.bypassrls !== false ||
      spec?.connectionLimit !== expected?.connectionLimit ||
      spec?.databaseRoleReclaimPolicy !== 'retain' ||
      spec?.passwordSecret?.name !== expected?.secret
    ) {
      findings.push(
        finding(
          'QL3_CNPG_DATABASE_ROLE',
          'DatabaseRole resources must match the fourteen fixed least-privilege identities',
        ),
      );
      break;
    }
    seen.add(spec.name);
  }
  if (
    seen.size !== Object.keys(EXPECTED_ROLES).length ||
    Object.keys(EXPECTED_ROLES).some((name) => !seen.has(name))
  ) {
    findings.push(
      finding(
        'QL3_CNPG_DATABASE_ROLE_SET',
        'exactly the fourteen reviewed migration, runtime, AI maintenance, AI credential management/testing, admin, automation, Approval, Run, package and Worker roles are required',
      ),
    );
  }

  const database = yaml.load(
    readFile(path.join(root, OPERATOR_DIRECTORY, 'database.yaml'), 'utf8'),
  );
  if (
    database?.apiVersion !== 'postgresql.cnpg.io/v1' ||
    database?.kind !== 'Database' ||
    database?.spec?.cluster?.name !== 'ql3-postgres' ||
    database?.spec?.name !== 'qinglong' ||
    database?.spec?.owner !== 'ql3_migration'
  ) {
    findings.push(
      finding(
        'QL3_CNPG_DATABASE_OWNER',
        'the qinglong database must be owned only by the migration role',
      ),
    );
  }
}

function assertSecretBoundary(readFile, root, findings) {
  const kustomization = yaml.load(
    readFile(path.join(root, OPERATOR_DIRECTORY, 'kustomization.yaml'), 'utf8'),
  );
  const resources = kustomization?.resources;
  if (
    JSON.stringify(resources) !==
      JSON.stringify([
        'cluster.yaml',
        'database-roles.yaml',
        'database.yaml',
      ]) ||
    resources?.includes('credentials.example.yaml')
  ) {
    findings.push(
      finding(
        'QL3_CNPG_SECRET_APPLICATION_BOUNDARY',
        'credential examples must never be part of the operator kustomization',
      ),
    );
  }
  const secrets = loadDocuments(
    readFile(
      path.join(root, OPERATOR_DIRECTORY, 'credentials.example.yaml'),
      'utf8',
    ),
  );
  const expectedUsers = new Map([
    ['ql3-postgres-migration-auth', 'ql3_migration'],
    ['ql3-postgres-ai-maintenance-auth', 'ql3_ai_maintenance'],
    ['ql3-postgres-ai-credential-manager-auth', 'ql3_ai_credential_manager'],
    ['ql3-postgres-ai-credential-tester-auth', 'ql3_ai_credential_tester'],
    ['ql3-postgres-runtime-auth', 'ql3_runtime'],
    ['ql3-postgres-admin-auth', 'ql3_admin'],
    ['ql3-postgres-automation-manager-auth', 'ql3_automation_manager'],
    ['ql3-postgres-approval-manager-auth', 'ql3_approval_manager'],
    ['ql3-postgres-run-manager-auth', 'ql3_run_manager'],
    ['ql3-postgres-worker-ingress-auth', 'ql3_worker_ingress'],
    ['ql3-postgres-package-manager-auth', 'ql3_package_manager'],
    ['ql3-postgres-package-executor-auth', 'ql3_package_executor'],
    [
      'ql3-postgres-worker-credential-manager-auth',
      'ql3_worker_credential_manager',
    ],
    [
      'ql3-postgres-worker-credential-executor-auth',
      'ql3_worker_credential_executor',
    ],
  ]);
  for (const secret of secrets) {
    const name = secret?.metadata?.name;
    if (name === 'ql3-cluster-control-runtime') {
      if (
        secret?.type !== 'Opaque' ||
        secret?.stringData?.['api-credential-pepper-keyring.json'] !==
          '{"schemaVersion":1,"activePepperKeyId":"REPLACE_WITH_ACTIVE_KEY_ID","keys":[{"pepperKeyId":"REPLACE_WITH_ACTIVE_KEY_ID","pepper":"REPLACE_WITH_CANONICAL_32_BYTE_BASE64URL"}]}\n'
      ) {
        findings.push(
          finding(
            'QL3_CNPG_RUNTIME_SECRET_EXAMPLE',
            'runtime Secret example must contain only the bounded placeholder credential pepper keyring',
          ),
        );
      }
      continue;
    }
    if (name === 'ql3-cluster-worker-ingress') {
      const data = secret?.stringData;
      const keys =
        data && typeof data === 'object' ? Object.keys(data).sort() : [];
      if (
        secret?.type !== 'Opaque' ||
        JSON.stringify(keys) !==
          JSON.stringify([
            'artifact-s3-bucket',
            'artifact-s3-encryption',
            'artifact-s3-region',
            'client-ca.crt',
            'tls.crt',
            'tls.key',
            'worker-credential-pepper',
          ]) ||
        data?.['artifact-s3-encryption'] !== 's3' ||
        keys
          .filter((key) => key !== 'artifact-s3-encryption')
          .some((key) => !String(data[key]).includes('REPLACE_WITH_'))
      ) {
        findings.push(
          finding(
            'QL3_CNPG_WORKER_INGRESS_SECRET_EXAMPLE',
            'Worker ingress Secret example must contain only reviewed placeholders',
          ),
        );
      }
      continue;
    }
    if (
      secret?.type !== 'kubernetes.io/basic-auth' ||
      secret?.stringData?.username !== expectedUsers.get(name) ||
      secret?.stringData?.password !== 'REPLACE_WITH_SECRET_MANAGER_VALUE'
    ) {
      findings.push(
        finding(
          'QL3_CNPG_DATABASE_SECRET_EXAMPLE',
          'database Secret examples must contain only fixed usernames and non-secret placeholders',
        ),
      );
    }
    expectedUsers.delete(name);
  }
  if (
    expectedUsers.size !== 0 ||
    secrets.filter(
      (secret) => secret?.metadata?.name === 'ql3-cluster-control-runtime',
    ).length !== 1 ||
    secrets.filter(
      (secret) => secret?.metadata?.name === 'ql3-cluster-worker-ingress',
    ).length !== 1
  ) {
    findings.push(
      finding(
        'QL3_CNPG_SECRET_EXAMPLE_SET',
        'the example must describe all fourteen database credentials and the reviewed workload Secrets',
      ),
    );
  }
}

function assertRuntimeBinding(readFile, root, findings) {
  const patch = yaml.load(readFile(path.join(root, RUNTIME_PATCH), 'utf8'));
  const kustomization = yaml.load(
    readFile(path.join(root, RUNTIME_KUSTOMIZATION), 'utf8'),
  );
  const podSpec = patch?.spec?.template?.spec;
  const container = podSpec?.containers?.find(
    (candidate) => candidate?.name === 'cluster-control',
  );
  const env = envByName(container);
  const caVolume = podSpec?.volumes?.find(
    (candidate) => candidate?.name === 'postgres-runtime-ca',
  );
  if (
    !exactFailClosedApplicationImage(kustomization) ||
    env.get('QL3_POSTGRES_RUNTIME_URL')?.$patch !== 'delete' ||
    env.get('QL3_POSTGRES_RUNTIME_HOST')?.value !== PRIMARY_DNS ||
    env.get('QL3_POSTGRES_RUNTIME_PORT')?.value !== '5432' ||
    env.get('QL3_POSTGRES_RUNTIME_DATABASE')?.value !== 'qinglong' ||
    !exactSecretRef(
      env.get('QL3_POSTGRES_RUNTIME_USER'),
      'ql3-postgres-runtime-auth',
      'username',
    ) ||
    !exactSecretRef(
      env.get('QL3_POSTGRES_RUNTIME_PASSWORD'),
      'ql3-postgres-runtime-auth',
      'password',
    ) ||
    env.get('QL3_POSTGRES_TLS_SERVERNAME')?.value !== PRIMARY_DNS ||
    caVolume?.secret?.secretName !== 'ql3-postgres-ca' ||
    JSON.stringify(caVolume?.secret?.items) !==
      JSON.stringify([{ key: 'ca.crt', path: 'ca.crt' }])
  ) {
    findings.push(
      finding(
        'QL3_CNPG_RUNTIME_BINDING',
        'cluster-control must use discrete runtime credentials, the primary service DNS and operator CA',
      ),
    );
  }
}

function assertMigrationBinding(readFile, root, findings) {
  const operations = yaml.load(
    readFile(path.join(root, MIGRATION_PATCH), 'utf8'),
  );
  const kustomization = yaml.load(
    readFile(path.join(root, MIGRATION_KUSTOMIZATION), 'utf8'),
  );
  const envOperation = operations?.find(
    (operation) =>
      operation?.op === 'replace' &&
      operation?.path === '/spec/template/spec/containers/0/env',
  );
  const caOperation = operations?.find(
    (operation) =>
      operation?.op === 'replace' &&
      operation?.path === '/spec/template/spec/volumes/1/secret/secretName',
  );
  const caKeyOperation = operations?.find(
    (operation) =>
      operation?.op === 'replace' &&
      operation?.path === '/spec/template/spec/volumes/1/secret/items/0/key',
  );
  const env = new Map(
    (Array.isArray(envOperation?.value) ? envOperation.value : []).map(
      (entry) => [entry?.name, entry],
    ),
  );
  if (
    !exactFailClosedApplicationImage(kustomization) ||
    env.has('QL3_POSTGRES_MIGRATION_URL') ||
    env.has('QL3_POSTGRES_RUNTIME_URL') ||
    env.has('QL3_API_CREDENTIAL_PEPPER') ||
    env.has('QL3_API_CREDENTIAL_PEPPER_KEYRING_FILE') ||
    env.get('QL3_POSTGRES_MIGRATION_HOST')?.value !== PRIMARY_DNS ||
    env.get('QL3_POSTGRES_MIGRATION_PORT')?.value !== '5432' ||
    env.get('QL3_POSTGRES_MIGRATION_DATABASE')?.value !== 'qinglong' ||
    !exactSecretRef(
      env.get('QL3_POSTGRES_MIGRATION_USER'),
      'ql3-postgres-migration-auth',
      'username',
    ) ||
    !exactSecretRef(
      env.get('QL3_POSTGRES_MIGRATION_PASSWORD'),
      'ql3-postgres-migration-auth',
      'password',
    ) ||
    env.get('QL3_POSTGRES_TLS_MODE')?.value !== 'verify-full' ||
    env.get('QL3_POSTGRES_TLS_SERVERNAME')?.value !== PRIMARY_DNS ||
    caOperation?.value !== 'ql3-postgres-ca' ||
    caKeyOperation?.value !== 'ca.crt'
  ) {
    findings.push(
      finding(
        'QL3_CNPG_MIGRATION_BINDING',
        'the one-shot migration must use only discrete migration credentials and operator TLS authority',
      ),
    );
  }
}

function auditCloudNativePgDeployment(options = {}) {
  const root = path.resolve(options.root ?? path.join(__dirname, '..'));
  const readFile = options.readFile ?? fs.readFileSync;
  const findings = [];
  try {
    assertOperatorLock(readFile, root, findings);
    assertCluster(readFile, root, findings);
    assertRolesAndDatabase(readFile, root, findings);
    assertSecretBoundary(readFile, root, findings);
    assertRuntimeBinding(readFile, root, findings);
    assertMigrationBinding(readFile, root, findings);
  } catch (error) {
    findings.push(
      finding(
        'QL3_CNPG_AUDIT_UNAVAILABLE',
        error instanceof Error ? error.message : 'unknown audit failure',
      ),
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    operator: 'cloudnative-pg',
    operatorVersion: '1.30.0',
    postgresqlVersion: '18.4',
    instances: 3,
    primaryService: PRIMARY_DNS,
    roles: Object.freeze(Object.keys(EXPECTED_ROLES).sort()),
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

if (require.main === module) {
  const report = auditCloudNativePgDeployment();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.compatible) process.exitCode = 1;
}

module.exports = {
  EXPECTED_ROLES,
  OPERATOR_IMAGE,
  POSTGRES_IMAGE,
  PRIMARY_DNS,
  auditCloudNativePgDeployment,
};
