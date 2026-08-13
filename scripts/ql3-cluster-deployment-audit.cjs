#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const yaml = require('js-yaml');

const EXPECTED_EXTERNAL_DEPENDENCIES = Object.freeze({
  '@aws-sdk/client-s3': '3.1093.0',
  croner: '7.0.8',
  'drizzle-orm': '0.45.2',
  pg: '8.22.0',
  semver: '7.7.4',
});

const EXPECTED_ADMIN_EXTERNAL_DEPENDENCIES = Object.freeze({
  '@kubernetes/client-node': '1.4.0',
  'drizzle-orm': '0.45.2',
  pg: '8.22.0',
  semver: '7.7.4',
});

const EXPECTED_BUILD_DEPENDENCIES = Object.freeze({
  '@types/node': '24.13.3',
  '@types/pg': '8.20.0',
  typescript: '5.9.3',
});

function finding(code, detail) {
  return Object.freeze({ code, detail });
}

function readJson(readFile, filePath) {
  return JSON.parse(readFile(filePath, 'utf8'));
}

function objectAt(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function documents(readFile, directory) {
  const names = [
    'namespace.yaml',
    'service-account.yaml',
    'service.yaml',
    'deployment.yaml',
    'pod-disruption-budget.yaml',
  ];
  return names.flatMap((name) => {
    const parsed = [];
    yaml.loadAll(readFile(path.join(directory, name), 'utf8'), (document) => {
      if (document) parsed.push(document);
    });
    return parsed;
  });
}

function yamlDocuments(readFile, filePath) {
  const parsed = [];
  yaml.loadAll(readFile(filePath, 'utf8'), (document) => {
    if (document) parsed.push(document);
  });
  return parsed;
}

function kubernetesYamlFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return kubernetesYamlFiles(filePath);
    return entry.isFile() && /\.ya?ml$/u.test(entry.name) ? [filePath] : [];
  });
}

function podSpecFor(document) {
  if (document?.kind === 'CronJob') {
    return document.spec?.jobTemplate?.spec?.template?.spec;
  }
  if (
    ['DaemonSet', 'Deployment', 'Job', 'StatefulSet'].includes(document?.kind)
  ) {
    return document.spec?.template?.spec;
  }
  return undefined;
}

function assertClusterAdminImageCommands(readFile, root, findings) {
  const kubernetesRoot = path.join(root, 'deploy/kubernetes/ql3-cluster');
  let references = 0;
  for (const filePath of kubernetesYamlFiles(kubernetesRoot)) {
    for (const document of yamlDocuments(readFile, filePath)) {
      const podSpec = podSpecFor(document);
      for (const section of ['initContainers', 'containers']) {
        for (const container of podSpec?.[section] ?? []) {
          if (container?.image !== 'qinglong3-cluster-admin:3.0.0-alpha.0') {
            continue;
          }
          references += 1;
          if (
            !Array.isArray(container.command) ||
            container.command.length === 0
          ) {
            findings.push(
              finding(
                'QL3_CLUSTER_ADMIN_IMAGE_COMMAND_IMPLICIT',
                `${path.relative(root, filePath)} ${document.kind}/${
                  document.metadata?.name ?? 'unnamed'
                } ${section}/${
                  container.name ?? 'unnamed'
                } must explicitly override the Cluster Admin image command`,
              ),
            );
          }
        }
      }
    }
  }
  if (references === 0) {
    findings.push(
      finding(
        'QL3_CLUSTER_ADMIN_IMAGE_REFERENCE_MISSING',
        'The Kubernetes deployment must contain reviewed Cluster Admin image references',
      ),
    );
  }
  return references;
}

function namedResource(resources, kind, name) {
  return resources.find(
    (resource) => resource?.kind === kind && resource?.metadata?.name === name,
  );
}

function environmentByName(container) {
  return new Map(
    (Array.isArray(container?.env) ? container.env : []).map((entry) => [
      entry?.name,
      entry,
    ]),
  );
}

function namedEntry(entries, name) {
  return Array.isArray(entries)
    ? entries.find((entry) => entry?.name === name)
    : undefined;
}

function assertExactExternalClosure(readFile, root, findings) {
  const packagePaths = [
    'packages/ql3-runtime-core/package.json',
    'packages/ql3-cluster-postgres/package.json',
    'packages/ql3-cluster-control/package.json',
  ];
  const expectedFromPackages = {};
  for (const relativePath of packagePaths) {
    const manifest = readJson(readFile, path.join(root, relativePath));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith('@qinglong/')) continue;
      expectedFromPackages[name] = version;
    }
  }
  if (
    JSON.stringify(
      Object.fromEntries(Object.entries(expectedFromPackages).sort()),
    ) !==
    JSON.stringify(
      Object.fromEntries(Object.entries(EXPECTED_EXTERNAL_DEPENDENCIES).sort()),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_IMAGE_EXPECTED_CLOSURE_STALE',
        'The audited external dependency closure no longer matches the three runtime packages',
      ),
    );
  }

  const imageDirectory = path.join(
    root,
    'deploy/containers/ql3-cluster-control',
  );
  const imageManifest = readJson(
    readFile,
    path.join(imageDirectory, 'package.json'),
  );
  if (
    JSON.stringify(imageManifest.dependencies ?? {}) !==
    JSON.stringify(EXPECTED_EXTERNAL_DEPENDENCIES)
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_IMAGE_DEPENDENCY_DRIFT',
        'The image dependency manifest must contain only the exact reviewed external closure',
      ),
    );
  }
  if (
    JSON.stringify(imageManifest.devDependencies ?? {}) !==
    JSON.stringify(EXPECTED_BUILD_DEPENDENCIES)
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_IMAGE_BUILD_DEPENDENCY_DRIFT',
        'The image builder manifest must contain only the exact reviewed TypeScript toolchain',
      ),
    );
  }
  const lock = readJson(
    readFile,
    path.join(imageDirectory, 'package-lock.json'),
  );
  if (
    lock.lockfileVersion !== 3 ||
    JSON.stringify(lock.packages?.['']?.dependencies ?? {}) !==
      JSON.stringify(EXPECTED_EXTERNAL_DEPENDENCIES) ||
    JSON.stringify(lock.packages?.['']?.devDependencies ?? {}) !==
      JSON.stringify(EXPECTED_BUILD_DEPENDENCIES)
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_IMAGE_LOCK_DRIFT',
        'The image lock root must exactly bind the reviewed external closure',
      ),
    );
  }

  const controlManifest = readJson(
    readFile,
    path.join(root, 'packages/ql3-cluster-control/package.json'),
  );
  if (
    controlManifest.bin?.['ql3-cluster-control'] !== 'dist/cli.js' ||
    controlManifest.bin?.['ql3-cluster-control-ai'] !== 'dist/aiCli.js' ||
    controlManifest.exports?.['./ai-production']?.require !==
      './dist/application-runtime/aiProductionApplication.js' ||
    controlManifest.exports?.['./process']?.require !==
      './dist/production-process/processApplication.js'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROCESS_ENTRYPOINT_MISSING',
        'cluster-control must publish the reviewed default and optional AI process entrypoints',
      ),
    );
  }
  const postgresManifest = readJson(
    readFile,
    path.join(root, 'packages/ql3-cluster-postgres/package.json'),
  );
  if (
    postgresManifest.bin?.['ql3-cluster-migrate'] !==
      'dist/migration/migrationCli.js' ||
    postgresManifest.exports?.['./migration-process']?.require !==
      './dist/migration/migrationProcess.js'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_MIGRATION_ENTRYPOINT_MISSING',
        'cluster-postgres must publish the reviewed migration process and binary',
      ),
    );
  }

  const adminPackagePaths = [
    'packages/ql3-runtime-core/package.json',
    'packages/ql3-cluster-postgres/package.json',
    'packages/ql3-cluster-admin/package.json',
  ];
  const expectedAdminFromPackages = {};
  for (const relativePath of adminPackagePaths) {
    const manifest = readJson(readFile, path.join(root, relativePath));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith('@qinglong/')) continue;
      expectedAdminFromPackages[name] = version;
    }
  }
  if (
    JSON.stringify(
      Object.fromEntries(Object.entries(expectedAdminFromPackages).sort()),
    ) !==
    JSON.stringify(
      Object.fromEntries(
        Object.entries(EXPECTED_ADMIN_EXTERNAL_DEPENDENCIES).sort(),
      ),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_ADMIN_IMAGE_EXPECTED_CLOSURE_STALE',
        'The audited admin dependency closure no longer matches its three workspace packages',
      ),
    );
  }
  const adminImageDirectory = path.join(
    root,
    'deploy/containers/ql3-cluster-admin',
  );
  const adminImageManifest = readJson(
    readFile,
    path.join(adminImageDirectory, 'package.json'),
  );
  if (
    JSON.stringify(adminImageManifest.dependencies ?? {}) !==
      JSON.stringify(EXPECTED_ADMIN_EXTERNAL_DEPENDENCIES) ||
    JSON.stringify(adminImageManifest.devDependencies ?? {}) !==
      JSON.stringify(EXPECTED_BUILD_DEPENDENCIES)
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_ADMIN_IMAGE_DEPENDENCY_DRIFT',
        'The admin image manifests must contain only their exact reviewed dependency closure',
      ),
    );
  }
  const adminRuntimeManifest = readJson(
    readFile,
    path.join(adminImageDirectory, 'runtime-dependencies/package.json'),
  );
  const adminBuildLock = readJson(
    readFile,
    path.join(adminImageDirectory, 'package-lock.json'),
  );
  const adminRuntimeLock = readJson(
    readFile,
    path.join(adminImageDirectory, 'runtime-dependencies/package-lock.json'),
  );
  if (
    JSON.stringify(adminRuntimeManifest.dependencies ?? {}) !==
      JSON.stringify(EXPECTED_ADMIN_EXTERNAL_DEPENDENCIES) ||
    adminBuildLock.lockfileVersion !== 3 ||
    JSON.stringify(adminBuildLock.packages?.['']?.dependencies ?? {}) !==
      JSON.stringify(EXPECTED_ADMIN_EXTERNAL_DEPENDENCIES) ||
    JSON.stringify(adminBuildLock.packages?.['']?.devDependencies ?? {}) !==
      JSON.stringify(EXPECTED_BUILD_DEPENDENCIES) ||
    adminRuntimeLock.lockfileVersion !== 3 ||
    JSON.stringify(adminRuntimeLock.packages?.['']?.dependencies ?? {}) !==
      JSON.stringify(EXPECTED_ADMIN_EXTERNAL_DEPENDENCIES) ||
    Object.keys(adminRuntimeLock.packages?.['']?.devDependencies ?? {})
      .length !== 0
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_ADMIN_IMAGE_LOCK_DRIFT',
        'The admin image build and production locks must bind the reviewed closure',
      ),
    );
  }
  const adminManifest = readJson(
    readFile,
    path.join(root, 'packages/ql3-cluster-admin/package.json'),
  );
  if (
    adminManifest.bin?.['ql3-cluster-admin'] !== 'dist/product-cli/cli.js' ||
    adminManifest.bin?.['ql3-plugin-package-recover'] !==
      'dist/plugin-package/recovery/pluginPackageRecoveryCli.js' ||
    adminManifest.bin?.['ql3-plugin-package-manage'] !==
      'dist/plugin-package/management/pluginPackageManagementCli.js' ||
    adminManifest.bin?.['ql3-plugin-package-client'] !==
      'dist/plugin-package/management/pluginPackageManagementClientCli.js' ||
    adminManifest.bin?.['ql3-plugin-package-client-kubernetes'] !==
      'dist/plugin-package/management/pluginPackageManagementKubernetesClientCli.js' ||
    adminManifest.bin?.['ql3-worker-credential-manage'] !==
      'dist/worker-credential/management-server/workerCredentialManagementCli.js' ||
    adminManifest.bin?.['ql3-worker-credential-client'] !==
      'dist/worker-credential/workerCredentialManagementClientCli.js' ||
    adminManifest.bin?.['ql3-worker-credential-execute'] !==
      'dist/worker-credential/workerCredentialExecutorCli.js' ||
    adminManifest.exports?.['./plugin-package-recovery-process']?.require !==
      './dist/plugin-package/recovery/pluginPackageRecoveryProcess.js' ||
    adminManifest.exports?.['./plugin-package-management-process']?.require !==
      './dist/plugin-package/management/pluginPackageManagementProcess.js' ||
    adminManifest.exports?.['./plugin-package-management-http']?.require !==
      './dist/management-support/pluginPackageManagementHttp.js' ||
    adminManifest.exports?.['./plugin-package-management-client']?.require !==
      './dist/management-support/pluginPackageManagementClient.js' ||
    adminManifest.exports?.['./plugin-package-management-kubernetes-client']
      ?.require !==
      './dist/plugin-package/management/pluginPackageManagementKubernetesClient.js' ||
    adminManifest.exports?.['./plugin-package-identity-keyset']?.require !==
      './dist/management-support/pluginPackageIdentityKeyset.js' ||
    adminManifest.exports?.['./plugin-package-oci-stage']?.require !==
      './dist/plugin-package/recovery/pluginPackageOciStage.js' ||
    adminManifest.exports?.['./worker-credential-management-process']
      ?.require !==
      './dist/worker-credential/management-server/workerCredentialManagementProcess.js' ||
    adminManifest.exports?.['./worker-credential-management-client']
      ?.require !==
      './dist/worker-credential/workerCredentialManagementClient.js' ||
    adminManifest.exports?.['./worker-credential-executor-process']?.require !==
      './dist/worker-credential/workerCredentialExecutorProcess.js'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_RECOVERY_ENTRYPOINT_MISSING',
        'cluster-admin must publish the reviewed product facade, Package and Worker management and executor entrypoints',
      ),
    );
  }
}

function assertDockerfile(readFile, root, findings) {
  const pinnedNodeBase =
    'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d';
  const dockerfile = readFile(
    path.join(root, 'deploy/containers/ql3-cluster-control/Dockerfile'),
    'utf8',
  );
  const required = [
    'node:24.18.0-bookworm-slim',
    'npm ci --ignore-scripts --no-audit --no-fund',
    'npm ci --omit=dev --ignore-scripts --no-audit --no-fund',
    'ql3-cluster-control/runtime-dependencies/package.json',
    'ql3-cluster-control/runtime-dependencies/package-lock.json',
    'FROM runtime-dependency-manifest AS external-dependencies',
    '/opt/qinglong/node_modules/.bin/tsc',
    '-p packages/ql3-runtime-core/tsconfig.json',
    '-p packages/ql3-cluster-postgres/tsconfig.json',
    '-p deploy/containers/ql3-cluster-control/tsconfig.default.json',
    'FROM workspace AS workspace-ai',
    'COPY packages/ql3-ai packages/ql3-ai',
    '-p packages/ql3-ai/tsconfig.json',
    '-p packages/ql3-cluster-control/tsconfig.json',
    'FROM assembled AS assembled-ai',
    '/workspace/packages/ql3-ai/dist',
    'FROM runtime-base AS runtime-ai',
    'ENTRYPOINT ["node", "/opt/qinglong/node_modules/@qinglong/cluster-control/dist/aiCli.js"]',
    'FROM runtime-base AS runtime',
    '/workspace/packages/ql3-runtime-core/dist',
    '/workspace/packages/ql3-cluster-postgres/dist',
    '/workspace/.ql3-image-build/cluster-control-default-dist',
    'USER 10001:10001',
    'ENTRYPOINT ["node", "/opt/qinglong/node_modules/@qinglong/cluster-control/dist/cli.js"]',
  ];
  for (const value of required) {
    if (!dockerfile.includes(value)) {
      findings.push(
        finding(
          'QL3_CLUSTER_DOCKERFILE_CONTRACT_MISSING',
          `Dockerfile is missing ${value}`,
        ),
      );
    }
  }
  if (
    !dockerfile
      .trimEnd()
      .endsWith(
        'ENTRYPOINT ["node", "/opt/qinglong/node_modules/@qinglong/cluster-control/dist/cli.js"]',
      )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_DEFAULT_IMAGE_TARGET_DRIFT',
        'The AI-free runtime target must remain the final/default Docker stage',
      ),
    );
  }
  const defaultTsconfig = readJson(
    readFile,
    path.join(
      root,
      'deploy/containers/ql3-cluster-control/tsconfig.default.json',
    ),
  );
  if (
    defaultTsconfig.compilerOptions?.outDir !==
      '../../../.ql3-image-build/cluster-control-default-dist' ||
    JSON.stringify(defaultTsconfig.exclude ?? []) !==
      JSON.stringify([
        '../../../packages/ql3-cluster-control/src/aiCli.ts',
        '../../../packages/ql3-cluster-control/src/application-runtime/aiProductionApplication.ts',
      ])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_DEFAULT_IMAGE_AI_SOURCE_INCLUDED',
        'The default image compiler must use a clean output directory and exclude both explicit Cluster AI entrypoints',
      ),
    );
  }
  if (dockerfile.split(`FROM ${pinnedNodeBase}`).length - 1 !== 2) {
    findings.push(
      finding(
        'QL3_CLUSTER_DOCKERFILE_BASE_IMAGE_NOT_PINNED',
        'Cluster control build and runtime stages must use the exact immutable Node base digest',
      ),
    );
  }
  for (const forbidden of [
    'ARG NODE_IMAGE',
    'FROM ${NODE_IMAGE}',
    'pnpm deploy',
    'pnpm install',
    'COPY . .',
    'ENTRYPOINT ["sh"',
    'USER root',
  ]) {
    if (dockerfile.includes(forbidden)) {
      findings.push(
        finding(
          'QL3_CLUSTER_DOCKERFILE_FORBIDDEN',
          `Dockerfile contains forbidden production pattern ${forbidden}`,
        ),
      );
    }
  }

  const adminDockerfile = readFile(
    path.join(root, 'deploy/containers/ql3-cluster-admin/Dockerfile'),
    'utf8',
  );
  const adminRequired = [
    'node:24.18.0-bookworm-slim',
    'npm ci --ignore-scripts --no-audit --no-fund',
    'npm ci --omit=dev --ignore-scripts --no-audit --no-fund',
    'ql3-cluster-admin/runtime-dependencies/package.json',
    'ql3-cluster-admin/runtime-dependencies/package-lock.json',
    '-p packages/ql3-runtime-core/tsconfig.json',
    '-p packages/ql3-cluster-postgres/tsconfig.json',
    '-p packages/ql3-cluster-admin/tsconfig.json',
    '/workspace/packages/ql3-runtime-core/dist',
    '/workspace/packages/ql3-cluster-postgres/dist',
    '/workspace/packages/ql3-cluster-admin/dist',
    'USER 10001:10001',
    'ENTRYPOINT ["node", "/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/product-cli/cli.js"]',
  ];
  for (const value of adminRequired) {
    if (!adminDockerfile.includes(value)) {
      findings.push(
        finding(
          'QL3_CLUSTER_ADMIN_DOCKERFILE_CONTRACT_MISSING',
          `Cluster admin Dockerfile is missing ${value}`,
        ),
      );
    }
  }
  if (adminDockerfile.split(`FROM ${pinnedNodeBase}`).length - 1 !== 2) {
    findings.push(
      finding(
        'QL3_CLUSTER_ADMIN_DOCKERFILE_BASE_IMAGE_NOT_PINNED',
        'Cluster admin build and runtime stages must use the exact immutable Node base digest',
      ),
    );
  }
  for (const forbidden of [
    'ARG NODE_IMAGE',
    'FROM ${NODE_IMAGE}',
    '@qinglong/cluster-control',
    '@aws-sdk/client-s3',
    'pnpm install',
    'COPY . .',
    'ENTRYPOINT ["sh"',
    'USER root',
  ]) {
    if (adminDockerfile.includes(forbidden)) {
      findings.push(
        finding(
          'QL3_CLUSTER_ADMIN_DOCKERFILE_FORBIDDEN',
          `Cluster admin Dockerfile contains forbidden production pattern ${forbidden}`,
        ),
      );
    }
  }
}

function assertKubernetes(readFile, root, findings) {
  const base = path.join(root, 'deploy/kubernetes/ql3-cluster/base');
  const resources = documents(readFile, base);
  const requiredKinds = [
    ['Namespace', 'qinglong3-system'],
    ['ServiceAccount', 'ql3-cluster-control'],
    ['Service', 'ql3-cluster-control'],
    ['Deployment', 'ql3-cluster-control'],
    ['PodDisruptionBudget', 'ql3-cluster-control'],
  ];
  for (const [kind, name] of requiredKinds) {
    if (!namedResource(resources, kind, name)) {
      findings.push(
        finding(
          'QL3_CLUSTER_KUBERNETES_RESOURCE_MISSING',
          `${kind}/${name} is required`,
        ),
      );
    }
  }
  if (resources.some((resource) => resource?.kind === 'Secret')) {
    findings.push(
      finding(
        'QL3_CLUSTER_KUBERNETES_SECRET_COMMITTED',
        'Runtime credentials must not be committed in the base',
      ),
    );
  }

  const deployment = namedResource(
    resources,
    'Deployment',
    'ql3-cluster-control',
  );
  const service = namedResource(resources, 'Service', 'ql3-cluster-control');
  const pod = objectAt(deployment, ['spec', 'template', 'spec']);
  const container = Array.isArray(pod?.containers)
    ? pod.containers.find((candidate) => candidate?.name === 'cluster-control')
    : undefined;
  const env = environmentByName(container);
  const replicaCount = objectAt(deployment, ['spec', 'replicas']);
  if (!Number.isInteger(replicaCount) || replicaCount < 2) {
    findings.push(
      finding(
        'QL3_CLUSTER_KUBERNETES_REPLICA_FLOOR',
        'cluster-control requires at least two replicas',
      ),
    );
  }
  if (
    objectAt(deployment, [
      'spec',
      'strategy',
      'rollingUpdate',
      'maxUnavailable',
    ]) !== 0
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_KUBERNETES_ROLLOUT_UNSAFE',
        'rolling updates must keep all ready replicas available',
      ),
    );
  }
  if (
    pod?.automountServiceAccountToken !== false ||
    pod?.securityContext?.runAsNonRoot !== true ||
    pod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    container?.securityContext?.allowPrivilegeEscalation !== false ||
    container?.securityContext?.readOnlyRootFilesystem !== true ||
    !container?.securityContext?.capabilities?.drop?.includes('ALL')
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_KUBERNETES_SECURITY_CONTEXT',
        'Pod and container security contexts do not match the reviewed baseline',
      ),
    );
  }
  if (
    !Array.isArray(
      objectAt(pod, [
        'affinity',
        'podAntiAffinity',
        'requiredDuringSchedulingIgnoredDuringExecution',
      ]),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_KUBERNETES_FAILURE_DOMAIN',
        'production baseline requires cross-node Pod anti-affinity',
      ),
    );
  }
  for (const [name, expected] of [
    ['QL_DEPLOYMENT_PROFILE', 'cluster-control'],
    ['QL3_CLUSTER_CONTROL_ENABLED', 'true'],
    ['QL3_POSTGRES_TLS_MODE', 'verify-full'],
    [
      'QL3_POSTGRES_TLS_CA_FILE',
      '/var/run/secrets/qinglong3/postgres-runtime/ca.crt',
    ],
    ['QL3_WORKER_INGRESS_ENABLED', 'true'],
    ['QL3_WORKER_INGRESS_HOST', '0.0.0.0'],
    ['QL3_WORKER_INGRESS_PORT', '5801'],
    ['QL3_WORKER_INGRESS_POSTGRES_TLS_MODE', 'verify-full'],
    [
      'QL3_WORKER_INGRESS_POSTGRES_TLS_CA_FILE',
      '/var/run/secrets/qinglong3/postgres-worker-ingress/ca.crt',
    ],
    [
      'QL3_WORKER_INGRESS_TLS_PRIVATE_KEY_FILE',
      '/var/run/secrets/qinglong3/worker-ingress-tls/tls.key',
    ],
    [
      'QL3_WORKER_INGRESS_TLS_CERTIFICATE_FILE',
      '/var/run/secrets/qinglong3/worker-ingress-tls/tls.crt',
    ],
    [
      'QL3_WORKER_INGRESS_TLS_CLIENT_CA_FILE',
      '/var/run/secrets/qinglong3/worker-ingress-tls/client-ca.crt',
    ],
    ['QL3_WORKER_SECRET_PROVIDER', 'mounted-files'],
    [
      'QL3_WORKER_SECRET_ROOT_DIRECTORY',
      '/var/run/secrets/qinglong3/worker-values',
    ],
  ]) {
    if (env.get(name)?.value !== expected) {
      findings.push(
        finding(
          'QL3_CLUSTER_KUBERNETES_ENVIRONMENT_GATE',
          `${name} must be fixed to ${expected}`,
        ),
      );
    }
  }
  if (
    env.get('QL3_CLUSTER_REPLICA_ID')?.valueFrom?.fieldRef?.fieldPath !==
    'metadata.name'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_KUBERNETES_REPLICA_ID',
        'lease ownership must derive from the stable Pod identity',
      ),
    );
  }
  const runtimeCaMount = namedEntry(
    container?.volumeMounts,
    'postgres-runtime-ca',
  );
  const runtimeCaVolume = namedEntry(pod?.volumes, 'postgres-runtime-ca');
  if (
    runtimeCaMount?.mountPath !==
      '/var/run/secrets/qinglong3/postgres-runtime' ||
    runtimeCaMount?.readOnly !== true ||
    runtimeCaVolume?.secret?.secretName !== 'ql3-cluster-control-runtime' ||
    runtimeCaVolume?.secret?.defaultMode !== 0o444 ||
    JSON.stringify(runtimeCaVolume?.secret?.items) !==
      JSON.stringify([{ key: 'postgres-ca.crt', path: 'ca.crt' }])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_KUBERNETES_POSTGRES_CA_BINDING',
        'runtime PostgreSQL trust must use the reviewed read-only projected CA file',
      ),
    );
  }
  for (const [name, key] of [
    ['QL3_POSTGRES_RUNTIME_URL', 'postgres-runtime-url'],
    ['QL3_POSTGRES_TLS_SERVERNAME', 'postgres-tls-servername'],
    ['QL3_API_CREDENTIAL_PEPPER', 'api-credential-pepper'],
  ]) {
    const secret = env.get(name)?.valueFrom?.secretKeyRef;
    if (secret?.name !== 'ql3-cluster-control-runtime' || secret?.key !== key) {
      findings.push(
        finding(
          'QL3_CLUSTER_KUBERNETES_SECRET_BINDING',
          `${name} must come from the reviewed runtime Secret key ${key}`,
        ),
      );
    }
  }
  for (const [name, key] of [
    ['QL3_POSTGRES_WORKER_INGRESS_URL', 'postgres-worker-ingress-url'],
    ['QL3_WORKER_INGRESS_POSTGRES_TLS_SERVERNAME', 'postgres-tls-servername'],
    ['QL3_WORKER_CREDENTIAL_PEPPER', 'worker-credential-pepper'],
    ['QL3_WORKER_ARTIFACT_S3_BUCKET', 'artifact-s3-bucket'],
    ['QL3_WORKER_ARTIFACT_S3_REGION', 'artifact-s3-region'],
  ]) {
    const secret = env.get(name)?.valueFrom?.secretKeyRef;
    if (secret?.name !== 'ql3-cluster-worker-ingress' || secret?.key !== key) {
      findings.push(
        finding(
          'QL3_CLUSTER_KUBERNETES_WORKER_SECRET_BINDING',
          `${name} must come from the reviewed Worker ingress Secret key ${key}`,
        ),
      );
    }
  }
  const workerCaMount = namedEntry(
    container?.volumeMounts,
    'postgres-worker-ingress-ca',
  );
  const workerCaVolume = namedEntry(pod?.volumes, 'postgres-worker-ingress-ca');
  const workerTlsMount = namedEntry(
    container?.volumeMounts,
    'worker-ingress-tls',
  );
  const workerTlsVolume = namedEntry(pod?.volumes, 'worker-ingress-tls');
  const workerSecretMount = namedEntry(
    container?.volumeMounts,
    'worker-secret-values',
  );
  const workerSecretVolume = namedEntry(pod?.volumes, 'worker-secret-values');
  if (
    workerCaMount?.mountPath !==
      '/var/run/secrets/qinglong3/postgres-worker-ingress' ||
    workerCaMount?.readOnly !== true ||
    workerCaVolume?.secret?.secretName !== 'ql3-cluster-worker-ingress' ||
    workerCaVolume?.secret?.defaultMode !== 0o440 ||
    JSON.stringify(workerCaVolume?.secret?.items) !==
      JSON.stringify([{ key: 'postgres-ca.crt', path: 'ca.crt' }]) ||
    workerTlsMount?.mountPath !==
      '/var/run/secrets/qinglong3/worker-ingress-tls' ||
    workerTlsMount?.readOnly !== true ||
    workerTlsVolume?.secret?.secretName !== 'ql3-cluster-worker-ingress' ||
    workerTlsVolume?.secret?.defaultMode !== 0o440 ||
    JSON.stringify(workerTlsVolume?.secret?.items) !==
      JSON.stringify([
        { key: 'tls.key', path: 'tls.key' },
        { key: 'tls.crt', path: 'tls.crt' },
        { key: 'client-ca.crt', path: 'client-ca.crt' },
      ])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_KUBERNETES_WORKER_TLS_BINDING',
        'Worker ingress must use separate read-only PostgreSQL CA and mTLS projections',
      ),
    );
  }
  if (
    workerSecretMount?.mountPath !==
      '/var/run/secrets/qinglong3/worker-values' ||
    workerSecretMount?.readOnly !== true ||
    workerSecretVolume?.secret?.secretName !== 'ql3-cluster-worker-values' ||
    workerSecretVolume?.secret?.optional !== true ||
    workerSecretVolume?.secret?.defaultMode !== 0o440 ||
    workerSecretVolume?.secret?.items !== undefined
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_KUBERNETES_WORKER_VALUE_BINDING',
        'Worker values must use the optional read-only 0440 hashed-key Secret projection',
      ),
    );
  }
  const containerWorkerPort = namedEntry(container?.ports, 'worker-mtls');
  const serviceWorkerPort = namedEntry(service?.spec?.ports, 'worker-mtls');
  if (
    containerWorkerPort?.containerPort !== 5801 ||
    containerWorkerPort?.protocol !== 'TCP' ||
    serviceWorkerPort?.port !== 5801 ||
    serviceWorkerPort?.targetPort !== 'worker-mtls' ||
    serviceWorkerPort?.protocol !== 'TCP'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_KUBERNETES_WORKER_PORT',
        'Worker ingress must expose exactly the dedicated mTLS TCP port 5801',
      ),
    );
  }
  for (const [probe, expectedPath] of [
    ['startupProbe', '/livez'],
    ['readinessProbe', '/readyz'],
    ['livenessProbe', '/livez'],
  ]) {
    if (container?.[probe]?.httpGet?.path !== expectedPath) {
      findings.push(
        finding(
          'QL3_CLUSTER_KUBERNETES_PROBE',
          `${probe} must use ${expectedPath}`,
        ),
      );
    }
  }
  if (
    container?.resources?.requests?.memory !== '128Mi' ||
    container?.resources?.limits?.memory !== '512Mi'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_KUBERNETES_RESOURCE_ENVELOPE',
        'cluster-control memory requests and limits must remain explicit',
      ),
    );
  }

  const pdb = namedResource(
    resources,
    'PodDisruptionBudget',
    'ql3-cluster-control',
  );
  if (pdb?.spec?.minAvailable !== 1) {
    findings.push(
      finding(
        'QL3_CLUSTER_KUBERNETES_PDB',
        'voluntary disruption must retain at least one control replica',
      ),
    );
  }

  const migration = yaml.load(
    readFile(
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/operations/base/migrate-job.yaml',
      ),
      'utf8',
    ),
  );
  const migrationPod = objectAt(migration, ['spec', 'template', 'spec']);
  const migrationContainer = Array.isArray(migrationPod?.containers)
    ? migrationPod.containers.find(
        (candidate) => candidate?.name === 'migration',
      )
    : undefined;
  const migrationEnv = environmentByName(migrationContainer);
  if (
    migration?.kind !== 'Job' ||
    migration?.metadata?.name !== 'ql3-cluster-migration' ||
    migration?.spec?.backoffLimit !== 0 ||
    migrationPod?.restartPolicy !== 'Never' ||
    migrationPod?.automountServiceAccountToken !== false
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_MIGRATION_JOB_LIFECYCLE',
        'migration must be an explicit one-shot non-retrying Job',
      ),
    );
  }
  if (
    JSON.stringify(migrationContainer?.command) !==
      JSON.stringify([
        'node',
        '/opt/qinglong/node_modules/@qinglong/cluster-postgres/dist/migration/migrationCli.js',
      ]) ||
    migrationEnv.get('QL3_POSTGRES_TLS_MODE')?.value !== 'verify-full' ||
    migrationEnv.get('QL3_POSTGRES_TLS_CA_FILE')?.value !==
      '/var/run/secrets/qinglong3/postgres-migration/ca.crt' ||
    migrationEnv.get('QL3_POSTGRES_MIGRATION_URL')?.valueFrom?.secretKeyRef
      ?.name !== 'ql3-cluster-migration' ||
    migrationEnv.get('QL3_POSTGRES_MIGRATION_URL')?.valueFrom?.secretKeyRef
      ?.key !== 'postgres-migration-url' ||
    migrationEnv.has('QL3_POSTGRES_RUNTIME_URL') ||
    migrationEnv.has('QL3_API_CREDENTIAL_PEPPER')
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_MIGRATION_AUTHORITY',
        'migration Job must use only its dedicated TLS-verified migration authority',
      ),
    );
  }
  const migrationCaMount = namedEntry(
    migrationContainer?.volumeMounts,
    'postgres-migration-ca',
  );
  const migrationCaVolume = namedEntry(
    migrationPod?.volumes,
    'postgres-migration-ca',
  );
  if (
    migrationCaMount?.mountPath !==
      '/var/run/secrets/qinglong3/postgres-migration' ||
    migrationCaMount?.readOnly !== true ||
    migrationCaVolume?.secret?.secretName !== 'ql3-cluster-migration' ||
    migrationCaVolume?.secret?.defaultMode !== 0o444 ||
    JSON.stringify(migrationCaVolume?.secret?.items) !==
      JSON.stringify([{ key: 'postgres-ca.crt', path: 'ca.crt' }])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_MIGRATION_POSTGRES_CA_BINDING',
        'migration PostgreSQL trust must use its dedicated read-only projected CA file',
      ),
    );
  }
  if (
    migrationPod?.securityContext?.runAsNonRoot !== true ||
    migrationPod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    migrationContainer?.securityContext?.allowPrivilegeEscalation !== false ||
    migrationContainer?.securityContext?.readOnlyRootFilesystem !== true ||
    !migrationContainer?.securityContext?.capabilities?.drop?.includes('ALL')
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_MIGRATION_SECURITY_CONTEXT',
        'migration Job security context does not match the reviewed baseline',
      ),
    );
  }

  const recoveryDirectory = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/operations/plugin-package-recovery/base',
  );
  const recoveryRbac = yamlDocuments(
    readFile,
    path.join(recoveryDirectory, 'rbac.yaml'),
  );
  const recoveryServiceAccount = namedResource(
    recoveryRbac,
    'ServiceAccount',
    'ql3-plugin-package-recovery',
  );
  const recoveryRole = namedResource(
    recoveryRbac,
    'Role',
    'ql3-plugin-package-recovery',
  );
  const recoveryRoleBinding = namedResource(
    recoveryRbac,
    'RoleBinding',
    'ql3-plugin-package-recovery',
  );
  if (
    recoveryServiceAccount?.automountServiceAccountToken !== false ||
    JSON.stringify(recoveryRole?.rules) !==
      JSON.stringify([
        {
          apiGroups: [''],
          resources: ['configmaps'],
          verbs: ['get', 'create', 'update'],
        },
      ]) ||
    recoveryRoleBinding?.roleRef?.apiGroup !== 'rbac.authorization.k8s.io' ||
    recoveryRoleBinding?.roleRef?.kind !== 'Role' ||
    recoveryRoleBinding?.roleRef?.name !== 'ql3-plugin-package-recovery' ||
    JSON.stringify(recoveryRoleBinding?.subjects) !==
      JSON.stringify([
        {
          kind: 'ServiceAccount',
          name: 'ql3-plugin-package-recovery',
          namespace: 'qinglong3-system',
        },
      ])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_RECOVERY_RBAC',
        'Plugin Package recovery must use its dedicated ConfigMap-only get/create/update authority',
      ),
    );
  }
  if (
    recoveryRbac.some(
      (resource) =>
        resource?.kind === 'ClusterRole' ||
        resource?.kind === 'ClusterRoleBinding' ||
        resource?.kind === 'Secret',
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_RECOVERY_AUTHORITY_WIDENED',
        'Plugin Package recovery may not receive cluster-wide RBAC or committed Secrets',
      ),
    );
  }

  const recoveryJob = yaml.load(
    readFile(path.join(recoveryDirectory, 'recover-job.yaml'), 'utf8'),
  );
  const recoveryPod = objectAt(recoveryJob, ['spec', 'template', 'spec']);
  const recoveryContainer = Array.isArray(recoveryPod?.containers)
    ? recoveryPod.containers.find((candidate) => candidate?.name === 'recovery')
    : undefined;
  const recoveryEnv = environmentByName(recoveryContainer);
  if (
    recoveryJob?.kind !== 'Job' ||
    recoveryJob?.metadata?.name !== 'ql3-plugin-package-recovery' ||
    recoveryJob?.spec?.backoffLimit !== 0 ||
    recoveryJob?.spec?.activeDeadlineSeconds !== 600 ||
    recoveryPod?.restartPolicy !== 'Never' ||
    recoveryPod?.serviceAccountName !== 'ql3-plugin-package-recovery' ||
    recoveryPod?.automountServiceAccountToken !== true
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_RECOVERY_JOB_LIFECYCLE',
        'Plugin Package recovery must be one bounded non-retrying Job with only its dedicated API identity',
      ),
    );
  }
  if (
    recoveryContainer?.image !== 'qinglong3-cluster-admin:3.0.0-alpha.0' ||
    JSON.stringify(recoveryContainer?.command) !==
      JSON.stringify([
        'node',
        '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/plugin-package/recovery/pluginPackageRecoveryCli.js',
      ]) ||
    recoveryEnv.get('QL3_POSTGRES_PACKAGE_EXECUTOR_URL')?.valueFrom
      ?.secretKeyRef?.name !== 'ql3-cluster-plugin-package-recovery' ||
    recoveryEnv.get('QL3_POSTGRES_PACKAGE_EXECUTOR_URL')?.valueFrom
      ?.secretKeyRef?.key !== 'postgres-package-executor-url' ||
    recoveryEnv.has('QL3_POSTGRES_ADMIN_URL') ||
    recoveryEnv.has('QL3_POSTGRES_RUNTIME_URL') ||
    recoveryEnv.has('QL3_POSTGRES_MIGRATION_URL') ||
    recoveryEnv.has('QL3_API_CREDENTIAL_PEPPER')
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_RECOVERY_AUTHORITY',
        'Plugin Package recovery must use only the Package executor database identity and its dedicated image',
      ),
    );
  }
  if (
    recoveryEnv.get('QL3_CLUSTER_IDENTITY')?.valueFrom?.configMapKeyRef
      ?.name !== 'ql3-plugin-package-recovery-config' ||
    recoveryEnv.get('QL3_CLUSTER_IDENTITY')?.valueFrom?.configMapKeyRef?.key !==
      'cluster-identity' ||
    recoveryEnv.get('QL3_PLUGIN_PACKAGE_OCI_REGISTRIES')?.valueFrom
      ?.configMapKeyRef?.name !== 'ql3-plugin-package-recovery-config' ||
    recoveryEnv.get('QL3_PLUGIN_PACKAGE_OCI_REGISTRIES')?.valueFrom
      ?.configMapKeyRef?.key !== 'oci-registries' ||
    recoveryEnv.get('QL3_KUBERNETES_NAMESPACE')?.valueFrom?.fieldRef
      ?.fieldPath !== 'metadata.namespace' ||
    recoveryEnv.get('QL3_PLUGIN_PACKAGE_PUBLISHER_TRUST_FILE')?.value !==
      '/var/run/qinglong3/plugin-package-trust/publishers.json' ||
    recoveryEnv.get('QL3_PLUGIN_PACKAGE_TRUST_AUTHORITY_ID')?.value !==
      'cluster'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_RECOVERY_SOURCE_BINDING',
        'Cluster identity, OCI allowlist, namespace and durable publisher trust authority must use reviewed explicit bindings',
      ),
    );
  }
  const recoveryTrustMount = namedEntry(
    recoveryContainer?.volumeMounts,
    'plugin-package-trust',
  );
  const recoveryTrustVolume = namedEntry(
    recoveryPod?.volumes,
    'plugin-package-trust',
  );
  const recoveryCaMount = namedEntry(
    recoveryContainer?.volumeMounts,
    'postgres-package-executor-ca',
  );
  const recoveryCaVolume = namedEntry(
    recoveryPod?.volumes,
    'postgres-package-executor-ca',
  );
  if (
    recoveryTrustMount?.mountPath !==
      '/var/run/qinglong3/plugin-package-trust' ||
    recoveryTrustMount?.readOnly !== true ||
    recoveryTrustVolume?.configMap?.name !== 'ql3-plugin-publisher-trust' ||
    recoveryTrustVolume?.configMap?.defaultMode !== 0o444 ||
    JSON.stringify(recoveryTrustVolume?.configMap?.items) !==
      JSON.stringify([{ key: 'publishers.json', path: 'publishers.json' }]) ||
    recoveryCaMount?.mountPath !==
      '/var/run/secrets/qinglong3/postgres-package-executor' ||
    recoveryCaMount?.readOnly !== true ||
    recoveryCaVolume?.secret?.secretName !==
      'ql3-cluster-plugin-package-recovery' ||
    recoveryCaVolume?.secret?.defaultMode !== 0o444 ||
    JSON.stringify(recoveryCaVolume?.secret?.items) !==
      JSON.stringify([{ key: 'postgres-ca.crt', path: 'ca.crt' }])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_RECOVERY_FILE_BINDING',
        'Publisher trust and PostgreSQL CA must use their bounded read-only projected files',
      ),
    );
  }
  const privateRegistryRoot = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/operations/plugin-package-recovery/private-registry',
  );
  const privateRegistryOverlay = yaml.load(
    readFile(path.join(privateRegistryRoot, 'kustomization.yaml'), 'utf8'),
  );
  const privateRegistryPatch = yaml.load(
    readFile(path.join(privateRegistryRoot, 'recover-job-patch.yaml'), 'utf8'),
  );
  const privateRegistryContainer =
    privateRegistryPatch?.spec?.template?.spec?.containers?.[0];
  const privateRegistryEnv = environmentByName(privateRegistryContainer);
  const privateRegistryMount = namedEntry(
    privateRegistryContainer?.volumeMounts,
    'plugin-package-registry-credentials',
  );
  const privateRegistryVolume = namedEntry(
    privateRegistryPatch?.spec?.template?.spec?.volumes,
    'plugin-package-registry-credentials',
  );
  if (
    JSON.stringify(privateRegistryOverlay?.resources) !==
      JSON.stringify(['../cloudnative-pg']) ||
    privateRegistryOverlay?.patches?.[0]?.path !== 'recover-job-patch.yaml' ||
    privateRegistryPatch?.kind !== 'Job' ||
    privateRegistryEnv.get('QL3_PLUGIN_PACKAGE_REGISTRY_CREDENTIAL_FILE')
      ?.value !==
      '/var/run/secrets/qinglong3/plugin-package-registry/credentials.json' ||
    privateRegistryMount?.mountPath !==
      '/var/run/secrets/qinglong3/plugin-package-registry' ||
    privateRegistryMount?.readOnly !== true ||
    privateRegistryVolume?.secret?.secretName !==
      'ql3-plugin-package-registry-credentials' ||
    privateRegistryVolume?.secret?.defaultMode !== 0o440 ||
    JSON.stringify(privateRegistryVolume?.secret?.items) !==
      JSON.stringify([{ key: 'credentials.json', path: 'credentials.json' }])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_RECOVERY_PRIVATE_REGISTRY_BINDING',
        'Private Registry credentials must remain one explicit 0440 Secret file bound only to the short-lived recovery Job',
      ),
    );
  }
  if (
    recoveryPod?.securityContext?.runAsNonRoot !== true ||
    recoveryPod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    recoveryContainer?.securityContext?.allowPrivilegeEscalation !== false ||
    recoveryContainer?.securityContext?.readOnlyRootFilesystem !== true ||
    !recoveryContainer?.securityContext?.capabilities?.drop?.includes('ALL') ||
    recoveryContainer?.resources?.requests?.memory !== '128Mi' ||
    recoveryContainer?.resources?.limits?.memory !== '512Mi'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_RECOVERY_SECURITY_CONTEXT',
        'Plugin Package recovery security and resource envelopes do not match the reviewed baseline',
      ),
    );
  }

  const unreleasedDigest =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  for (const [relativePath, image, repository, code] of [
    [
      'deploy/kubernetes/ql3-cluster/overlays/cloudnative-pg/kustomization.yaml',
      'qinglong3-cluster-control',
      'registry.example.com/qinglong/qinglong3-cluster-control',
      'QL3_CLUSTER_CONTROL_RELEASE_DIGEST_PIN',
    ],
    [
      'deploy/kubernetes/ql3-cluster/operations/plugin-package-recovery/cloudnative-pg/kustomization.yaml',
      'qinglong3-cluster-admin',
      'registry.example.com/qinglong/qinglong3-cluster-admin',
      'QL3_CLUSTER_ADMIN_RELEASE_DIGEST_PIN',
    ],
  ]) {
    const overlay = yaml.load(readFile(path.join(root, relativePath), 'utf8'));
    if (
      JSON.stringify(overlay?.images) !==
      JSON.stringify([
        {
          name: image,
          newName: repository,
          digest: unreleasedDigest,
        },
      ])
    ) {
      findings.push(
        finding(
          code,
          `${image} production overlay must use its independent fail-closed digest placeholder`,
        ),
      );
    }
  }
}

function assertClusterAiComponent(readFile, root, findings) {
  const componentDirectory = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/components/cluster-ai',
  );
  const component = yaml.load(
    readFile(path.join(componentDirectory, 'kustomization.yaml'), 'utf8'),
  );
  const patch = yaml.load(
    readFile(path.join(componentDirectory, 'deployment-patch.yaml'), 'utf8'),
  );
  const authority = yaml.load(
    readFile(
      path.join(componentDirectory, 'provider-authority-configmap.yaml'),
      'utf8',
    ),
  );
  const secretExample = yaml.load(
    readFile(
      path.join(componentDirectory, 'provider-secrets.example.yaml'),
      'utf8',
    ),
  );
  const overlay = yaml.load(
    readFile(
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/overlays/cluster-ai-example/kustomization.yaml',
      ),
      'utf8',
    ),
  );
  const promptOutputComponentDirectory = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/components/cluster-ai-prompt-output',
  );
  const promptOutputComponent = yaml.load(
    readFile(
      path.join(promptOutputComponentDirectory, 'kustomization.yaml'),
      'utf8',
    ),
  );
  const promptOutputPatch = yaml.load(
    readFile(
      path.join(promptOutputComponentDirectory, 'deployment-patch.yaml'),
      'utf8',
    ),
  );
  const promptOutputOverlay = yaml.load(
    readFile(
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/overlays/cluster-ai-prompt-output-example/kustomization.yaml',
      ),
      'utf8',
    ),
  );
  if (
    component?.kind !== 'Component' ||
    JSON.stringify(component?.resources) !==
      JSON.stringify(['provider-authority-configmap.yaml']) ||
    JSON.stringify(component?.patches) !==
      JSON.stringify([{ path: 'deployment-patch.yaml' }])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AI_COMPONENT_SCOPE',
        'Cluster AI must remain an explicit component containing only provider authority and one Deployment patch',
      ),
    );
  }

  const promptOutputPod = objectAt(promptOutputPatch, [
    'spec',
    'template',
    'spec',
  ]);
  const promptOutputContainer = namedEntry(
    promptOutputPod?.containers,
    'cluster-control',
  );
  const promptOutputEnv = environmentByName(promptOutputContainer);
  const promptOutputMount = namedEntry(
    promptOutputContainer?.volumeMounts,
    'cluster-ai-prompt-output-keyring',
  );
  const promptOutputVolume = namedEntry(
    promptOutputPod?.volumes,
    'cluster-ai-prompt-output-keyring',
  );
  if (
    promptOutputComponent?.kind !== 'Component' ||
    promptOutputComponent?.resources !== undefined ||
    JSON.stringify(promptOutputComponent?.patches) !==
      JSON.stringify([{ path: 'deployment-patch.yaml' }]) ||
    promptOutputPatch?.kind !== 'Deployment' ||
    promptOutputPatch?.metadata?.name !== 'ql3-cluster-control' ||
    promptOutputPod?.serviceAccountName !== undefined ||
    promptOutputPod?.automountServiceAccountToken !== undefined ||
    promptOutputPod?.containers?.length !== 1 ||
    promptOutputContainer?.image !== undefined ||
    promptOutputContainer?.env?.length !== 2 ||
    promptOutputEnv.get('QL3_CLUSTER_AI_PROMPT_OUTPUT_ENABLED')?.value !==
      'true' ||
    promptOutputEnv.get('QL3_CLUSTER_AI_PROMPT_OUTPUT_KEYRING_ROOT')?.value !==
      '/var/run/secrets/qinglong3/ai/prompt-output-keyring' ||
    promptOutputContainer?.volumeMounts?.length !== 1 ||
    promptOutputMount?.mountPath !==
      '/var/run/secrets/qinglong3/ai/prompt-output-keyring' ||
    promptOutputMount?.readOnly !== true ||
    promptOutputPod?.volumes?.length !== 1 ||
    promptOutputVolume?.secret?.secretName !== 'ql3-prompt-output-keyring' ||
    promptOutputVolume?.secret?.defaultMode !== 0o440 ||
    promptOutputVolume?.secret?.optional === true ||
    JSON.stringify(promptOutputVolume?.secret?.items) !==
      JSON.stringify([{ key: 'keyring.json', path: 'keyring.json' }])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AI_PROMPT_OUTPUT_PROJECTION',
        'Cluster AI durable Prompt output must remain an explicit, exact, required and read-only 0440 Secret projection without runtime Kubernetes API authority',
      ),
    );
  }

  const promptOutputOverlayImage = promptOutputOverlay?.images?.[0];
  if (
    JSON.stringify(promptOutputOverlay?.components) !==
      JSON.stringify([
        '../../components/cluster-ai',
        '../../components/cluster-ai-prompt-output',
      ]) ||
    promptOutputOverlayImage?.name !== 'qinglong3-cluster-control-ai' ||
    promptOutputOverlayImage?.newName !==
      'registry.example.com/qinglong/qinglong3-cluster-control-ai' ||
    !/^sha256:[0-9a-f]{64}$/.test(promptOutputOverlayImage?.digest ?? '') ||
    'newTag' in (promptOutputOverlayImage ?? {})
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AI_PROMPT_OUTPUT_OVERLAY',
        'The Prompt output overlay must compose both opt-in AI components and independently pin the Cluster AI image digest',
      ),
    );
  }

  const patchPod = objectAt(patch, ['spec', 'template', 'spec']);
  const patchContainer = namedEntry(patchPod?.containers, 'cluster-control');
  const patchEnv = environmentByName(patchContainer);
  for (const [name, expected] of [
    ['QL3_CLUSTER_AI_ENABLED', 'true'],
    [
      'QL3_CLUSTER_AI_PROVIDER_AUTHORITY_FILE',
      '/var/run/qinglong3/ai/provider-authority/authority.json',
    ],
    [
      'QL3_CLUSTER_AI_SECRET_ROOT',
      '/var/run/secrets/qinglong3/ai/provider-secrets',
    ],
    ['QL3_CLUSTER_AI_MAX_CONCURRENT', '4'],
    ['QL3_CLUSTER_AI_RECOVERY_LIMIT', '32'],
    ['QL3_CLUSTER_AI_DATABASE_MAX_CONNECTIONS', '4'],
  ]) {
    if (patchEnv.get(name)?.value !== expected) {
      findings.push(
        finding(
          'QL3_CLUSTER_AI_COMPONENT_ENVIRONMENT',
          `${name} must be fixed to the reviewed bounded value ${expected}`,
        ),
      );
    }
  }
  const authorityMount = namedEntry(
    patchContainer?.volumeMounts,
    'cluster-ai-provider-authority',
  );
  const secretMount = namedEntry(
    patchContainer?.volumeMounts,
    'cluster-ai-provider-secrets',
  );
  const authorityVolume = namedEntry(
    patchPod?.volumes,
    'cluster-ai-provider-authority',
  );
  const secretVolume = namedEntry(
    patchPod?.volumes,
    'cluster-ai-provider-secrets',
  );
  if (
    patch?.kind !== 'Deployment' ||
    patch?.metadata?.name !== 'ql3-cluster-control' ||
    patchContainer?.image !== 'qinglong3-cluster-control-ai:3.0.0-alpha.0' ||
    patchPod?.serviceAccountName !== undefined ||
    patchPod?.automountServiceAccountToken !== undefined ||
    authorityMount?.mountPath !== '/var/run/qinglong3/ai/provider-authority' ||
    authorityMount?.readOnly !== true ||
    secretMount?.mountPath !==
      '/var/run/secrets/qinglong3/ai/provider-secrets' ||
    secretMount?.readOnly !== true ||
    authorityVolume?.configMap?.name !== 'ql3-cluster-ai-provider-authority' ||
    authorityVolume?.configMap?.defaultMode !== 0o440 ||
    JSON.stringify(authorityVolume?.configMap?.items) !==
      JSON.stringify([{ key: 'authority.json', path: 'authority.json' }]) ||
    secretVolume?.secret?.secretName !== 'ql3-cluster-ai-provider-secrets' ||
    secretVolume?.secret?.defaultMode !== 0o440 ||
    secretVolume?.secret?.optional === true ||
    [...patchEnv.keys()].some((name) =>
      name.startsWith('QL3_CLUSTER_AI_PROMPT_OUTPUT_'),
    ) ||
    namedEntry(
      patchContainer?.volumeMounts,
      'cluster-ai-prompt-output-keyring',
    ) ||
    namedEntry(patchPod?.volumes, 'cluster-ai-prompt-output-keyring')
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AI_COMPONENT_AUTHORITY',
        'Cluster AI must use the explicit image and required read-only 0440 provider projections without widening ServiceAccount authority or default-enabling durable Prompt output',
      ),
    );
  }

  const authorityText = authority?.data?.['authority.json'];
  let parsedAuthority;
  try {
    parsedAuthority = JSON.parse(authorityText);
  } catch {
    parsedAuthority = undefined;
  }
  if (
    authority?.kind !== 'ConfigMap' ||
    authority?.metadata?.name !== 'ql3-cluster-ai-provider-authority' ||
    typeof authorityText !== 'string' ||
    `${JSON.stringify(parsedAuthority)}\n` !== authorityText ||
    parsedAuthority?.schema !==
      'qinglong/projected-model-gateway-authority@v1' ||
    !Array.isArray(parsedAuthority?.providers) ||
    parsedAuthority.providers.length !== 1 ||
    !Array.isArray(parsedAuthority?.projects) ||
    parsedAuthority.projects.length !== 1
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AI_PROVIDER_AUTHORITY',
        'The projected provider authority must be canonical, bounded and explicitly versioned',
      ),
    );
  }

  const canonicalSecretRef =
    'qlsecret:v1:eyJwcm9qZWN0SWQiOiJyZXBsYWNlLXByb2plY3QtaWQiLCJuYW1lIjoib3BlbmFpLWNvbXBhdGlibGUtdG9rZW4ifQ';
  const expectedSecretKey = createHash('sha256')
    .update(canonicalSecretRef, 'utf8')
    .digest('hex');
  if (
    secretExample?.kind !== 'Secret' ||
    secretExample?.metadata?.name !== 'ql3-cluster-ai-provider-secrets' ||
    JSON.stringify(secretExample?.stringData) !==
      JSON.stringify({
        [expectedSecretKey]: 'REPLACE_WITH_PROVIDER_AUTHORIZATION_VALUE',
      }) ||
    component.resources.includes('provider-secrets.example.yaml')
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AI_SECRET_EXAMPLE',
        'The example Secret must be non-deployable by default and keyed by sha256(canonical SecretRef)',
      ),
    );
  }

  const overlayImage = overlay?.images?.[0];
  if (
    JSON.stringify(overlay?.components) !==
      JSON.stringify(['../../components/cluster-ai']) ||
    overlayImage?.name !== 'qinglong3-cluster-control-ai' ||
    overlayImage?.newName !==
      'registry.example.com/qinglong/qinglong3-cluster-control-ai' ||
    !/^sha256:[0-9a-f]{64}$/.test(overlayImage?.digest ?? '') ||
    'newTag' in (overlayImage ?? {})
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AI_IMAGE_PIN',
        'The optional Cluster AI overlay must use its independently pinned image digest',
      ),
    );
  }

  const baseDeployment = yaml.load(
    readFile(
      path.join(root, 'deploy/kubernetes/ql3-cluster/base/deployment.yaml'),
      'utf8',
    ),
  );
  const basePod = objectAt(baseDeployment, ['spec', 'template', 'spec']);
  const baseContainer = namedEntry(basePod?.containers, 'cluster-control');
  const baseEnv = environmentByName(baseContainer);
  if (
    baseContainer?.image !== 'qinglong3-cluster-control:3.0.0-alpha.0' ||
    [...baseEnv.keys()].some((name) => name.startsWith('QL3_CLUSTER_AI_')) ||
    namedEntry(baseContainer?.volumeMounts, 'cluster-ai-provider-authority') ||
    namedEntry(baseContainer?.volumeMounts, 'cluster-ai-provider-secrets') ||
    namedEntry(
      baseContainer?.volumeMounts,
      'cluster-ai-prompt-output-keyring',
    ) ||
    namedEntry(basePod?.volumes, 'cluster-ai-provider-authority') ||
    namedEntry(basePod?.volumes, 'cluster-ai-provider-secrets') ||
    namedEntry(basePod?.volumes, 'cluster-ai-prompt-output-keyring')
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AI_DEFAULT_ENABLED',
        'The default Cluster deployment must remain AI-free',
      ),
    );
  }
}

function assertPluginPackageManagementDeployment(readFile, root, findings) {
  const operationRoot = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/operations/plugin-package-management',
  );
  const base = path.join(operationRoot, 'base');
  const baseKustomization = yaml.load(
    readFile(path.join(base, 'kustomization.yaml'), 'utf8'),
  );
  const expectedResources = [
    'service-account.yaml',
    'service.yaml',
    'deployment.yaml',
    'pod-disruption-budget.yaml',
    'network-policy.yaml',
  ];
  if (
    JSON.stringify(baseKustomization?.resources) !==
    JSON.stringify(expectedResources)
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_MANAGEMENT_RESOURCE_SET',
        'Plugin Package management must use only the reviewed optional namespaced resource set',
      ),
    );
  }

  const resources = expectedResources.flatMap((name) =>
    yamlDocuments(readFile, path.join(base, name)),
  );
  const name = 'ql3-plugin-package-management';
  const serviceAccount = namedResource(resources, 'ServiceAccount', name);
  const service = namedResource(resources, 'Service', name);
  const deployment = namedResource(resources, 'Deployment', name);
  const pdb = namedResource(resources, 'PodDisruptionBudget', name);
  const networkPolicy = namedResource(resources, 'NetworkPolicy', name);
  if (
    resources.some((resource) =>
      [
        'Secret',
        'ConfigMap',
        'Role',
        'RoleBinding',
        'ClusterRole',
        'ClusterRoleBinding',
      ].includes(resource?.kind),
    ) ||
    serviceAccount?.automountServiceAccountToken !== false
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_MANAGEMENT_KUBERNETES_AUTHORITY',
        'Plugin Package management may not commit credentials or receive Kubernetes API authority',
      ),
    );
  }

  const pod = objectAt(deployment, ['spec', 'template', 'spec']);
  const container = namedEntry(pod?.containers, 'management');
  const env = environmentByName(container);
  if (
    deployment?.spec?.replicas !== 2 ||
    deployment?.spec?.strategy?.rollingUpdate?.maxUnavailable !== 0 ||
    pod?.serviceAccountName !== name ||
    pod?.automountServiceAccountToken !== false ||
    !Array.isArray(
      objectAt(pod, [
        'affinity',
        'podAntiAffinity',
        'requiredDuringSchedulingIgnoredDuringExecution',
      ]),
    ) ||
    pod?.securityContext?.runAsNonRoot !== true ||
    pod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    container?.securityContext?.allowPrivilegeEscalation !== false ||
    container?.securityContext?.readOnlyRootFilesystem !== true ||
    !container?.securityContext?.capabilities?.drop?.includes('ALL')
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_MANAGEMENT_LIFECYCLE',
        'Plugin Package management must remain a hardened two-replica, zero-token Deployment',
      ),
    );
  }
  if (
    container?.image !== 'qinglong3-cluster-admin:3.0.0-alpha.0' ||
    JSON.stringify(container?.command) !==
      JSON.stringify([
        'node',
        '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/plugin-package/management/pluginPackageManagementCli.js',
      ])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_MANAGEMENT_ENTRYPOINT',
        'Plugin Package management must use the reviewed cluster-admin management binary',
      ),
    );
  }

  for (const [environmentName, expected] of [
    ['QL3_PROFILE', 'cluster-admin'],
    ['QL3_PLUGIN_PACKAGE_MANAGEMENT_ENABLED', 'true'],
    ['QL3_PLUGIN_PACKAGE_MANAGEMENT_HOST', '0.0.0.0'],
    ['QL3_PLUGIN_PACKAGE_MANAGEMENT_PORT', '8443'],
    [
      'QL3_PLUGIN_PACKAGE_MANAGEMENT_TLS_CERT_FILE',
      '/var/run/secrets/qinglong3/plugin-package-management-tls/tls.crt',
    ],
    [
      'QL3_PLUGIN_PACKAGE_MANAGEMENT_TLS_KEY_FILE',
      '/var/run/secrets/qinglong3/plugin-package-management-tls/tls.key',
    ],
    [
      'QL3_PLUGIN_PACKAGE_MANAGEMENT_IDENTITY_KEYSET_FILE',
      '/var/run/qinglong3/plugin-package-management-identity/keyset.json',
    ],
    [
      'QL3_PLUGIN_PACKAGE_PUBLISHER_TRUST_FILE',
      '/var/run/qinglong3/plugin-package-trust/publishers.json',
    ],
    [
      'QL3_PLUGIN_PACKAGE_TRUST_AUTHORITY_PROJECT_ID',
      'cluster-trust-authority',
    ],
    ['QL3_PLUGIN_PACKAGE_TRUST_AUTHORITY_ID', 'cluster'],
    ['QL3_PLUGIN_PACKAGE_TRUST_OBSERVER_ID', 'cluster-package-manager'],
    ['QL3_PLUGIN_PACKAGE_MANAGEMENT_QUOTA_WINDOW_MS', '60000'],
    ['QL3_PLUGIN_PACKAGE_MANAGEMENT_PROPOSE_QUOTA', '30'],
    ['QL3_PLUGIN_PACKAGE_MANAGEMENT_DECIDE_QUOTA', '60'],
    ['QL3_PLUGIN_PACKAGE_MANAGEMENT_INSPECT_QUOTA', '600'],
    ['QL3_PLUGIN_PACKAGE_MANAGEMENT_MAX_BODY_BYTES', '65536'],
    ['QL3_PLUGIN_PACKAGE_MANAGEMENT_MAX_CONNECTIONS', '32'],
    ['QL3_PLUGIN_PACKAGE_MANAGEMENT_MAX_CONCURRENT_REQUESTS', '16'],
    ['QL3_PLUGIN_PACKAGE_MANAGEMENT_MAX_RATE_LIMIT_PEERS', '512'],
    ['QL3_POSTGRES_PACKAGE_MANAGER_TLS_MODE', 'verify-full'],
    [
      'QL3_POSTGRES_PACKAGE_MANAGER_TLS_CA_FILE',
      '/var/run/secrets/qinglong3/postgres-package-manager/ca.crt',
    ],
    ['QL3_POSTGRES_PACKAGE_MANAGER_MAX_CONNECTIONS', '2'],
  ]) {
    if (env.get(environmentName)?.value !== expected) {
      findings.push(
        finding(
          'QL3_CLUSTER_PLUGIN_MANAGEMENT_ENVIRONMENT',
          `${environmentName} must remain fixed to the reviewed bounded value`,
        ),
      );
    }
  }
  const managerUrl = env.get('QL3_POSTGRES_PACKAGE_MANAGER_URL')?.valueFrom
    ?.secretKeyRef;
  const managerServername = env.get(
    'QL3_POSTGRES_PACKAGE_MANAGER_TLS_SERVERNAME',
  )?.valueFrom?.secretKeyRef;
  if (
    managerUrl?.name !== 'ql3-cluster-plugin-package-management-database' ||
    managerUrl?.key !== 'postgres-package-manager-url' ||
    managerServername?.name !==
      'ql3-cluster-plugin-package-management-database' ||
    managerServername?.key !== 'postgres-tls-servername' ||
    [
      'QL3_POSTGRES_PACKAGE_EXECUTOR_URL',
      'QL3_POSTGRES_ADMIN_URL',
      'QL3_POSTGRES_RUNTIME_URL',
      'QL3_POSTGRES_MIGRATION_URL',
      'QL3_API_CREDENTIAL_PEPPER',
    ].some((environmentName) => env.has(environmentName))
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_MANAGEMENT_DATABASE_AUTHORITY',
        'Plugin Package management must receive only the dedicated Package manager database identity',
      ),
    );
  }

  for (const [probe, expectedPath] of [
    ['startupProbe', '/livez'],
    ['readinessProbe', '/readyz'],
    ['livenessProbe', '/livez'],
  ]) {
    if (
      container?.[probe]?.httpGet?.path !== expectedPath ||
      container?.[probe]?.httpGet?.port !== 'https' ||
      container?.[probe]?.httpGet?.scheme !== 'HTTPS'
    ) {
      findings.push(
        finding(
          'QL3_CLUSTER_PLUGIN_MANAGEMENT_HTTPS_PROBE',
          `${probe} must use the reviewed HTTPS endpoint`,
        ),
      );
    }
  }
  if (
    service?.spec?.type !== 'ClusterIP' ||
    service?.spec?.ports?.[0]?.name !== 'https' ||
    service?.spec?.ports?.[0]?.port !== 8443 ||
    service?.spec?.ports?.[0]?.targetPort !== 'https' ||
    container?.resources?.requests?.memory !== '128Mi' ||
    container?.resources?.limits?.memory !== '512Mi' ||
    pdb?.spec?.minAvailable !== 1
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_MANAGEMENT_SERVICE_ENVELOPE',
        'Plugin Package management Service, disruption budget and memory envelope must remain bounded',
      ),
    );
  }

  const tlsMount = namedEntry(container?.volumeMounts, 'management-tls');
  const tlsVolume = namedEntry(pod?.volumes, 'management-tls');
  const identityMount = namedEntry(
    container?.volumeMounts,
    'management-identity',
  );
  const identityVolume = namedEntry(pod?.volumes, 'management-identity');
  const trustMount = namedEntry(
    container?.volumeMounts,
    'plugin-package-trust',
  );
  const trustVolume = namedEntry(pod?.volumes, 'plugin-package-trust');
  const databaseCaMount = namedEntry(
    container?.volumeMounts,
    'postgres-package-manager-ca',
  );
  const databaseCaVolume = namedEntry(
    pod?.volumes,
    'postgres-package-manager-ca',
  );
  if (
    tlsMount?.mountPath !==
      '/var/run/secrets/qinglong3/plugin-package-management-tls' ||
    tlsMount?.readOnly !== true ||
    tlsVolume?.secret?.secretName !== 'ql3-plugin-package-management-tls' ||
    tlsVolume?.secret?.defaultMode !== 0o440 ||
    JSON.stringify(tlsVolume?.secret?.items) !==
      JSON.stringify([
        { key: 'tls.crt', path: 'tls.crt' },
        { key: 'tls.key', path: 'tls.key' },
      ]) ||
    identityMount?.mountPath !==
      '/var/run/qinglong3/plugin-package-management-identity' ||
    identityMount?.readOnly !== true ||
    identityVolume?.secret?.secretName !==
      'ql3-plugin-package-management-identity' ||
    identityVolume?.secret?.defaultMode !== 0o444 ||
    JSON.stringify(identityVolume?.secret?.items) !==
      JSON.stringify([{ key: 'keyset.json', path: 'keyset.json' }]) ||
    trustMount?.mountPath !== '/var/run/qinglong3/plugin-package-trust' ||
    trustMount?.readOnly !== true ||
    trustVolume?.configMap?.name !== 'ql3-plugin-publisher-trust' ||
    trustVolume?.configMap?.defaultMode !== 0o444 ||
    JSON.stringify(trustVolume?.configMap?.items) !==
      JSON.stringify([{ key: 'publishers.json', path: 'publishers.json' }]) ||
    databaseCaMount?.mountPath !==
      '/var/run/secrets/qinglong3/postgres-package-manager' ||
    databaseCaMount?.readOnly !== true ||
    databaseCaVolume?.secret?.secretName !==
      'ql3-cluster-plugin-package-management-database' ||
    databaseCaVolume?.secret?.defaultMode !== 0o444 ||
    JSON.stringify(databaseCaVolume?.secret?.items) !==
      JSON.stringify([{ key: 'postgres-ca.crt', path: 'ca.crt' }])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_MANAGEMENT_FILE_BINDING',
        'TLS, identity keyset, publisher trust and PostgreSQL CA must use separate bounded read-only projections',
      ),
    );
  }

  const expectedDnsEgress = {
    to: [
      {
        namespaceSelector: {
          matchLabels: {
            'kubernetes.io/metadata.name': 'kube-system',
          },
        },
        podSelector: {
          matchLabels: {
            'k8s-app': 'kube-dns',
          },
        },
      },
    ],
    ports: [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ],
  };
  if (
    JSON.stringify(networkPolicy?.spec?.policyTypes) !==
      JSON.stringify(['Ingress', 'Egress']) ||
    networkPolicy?.spec?.ingress?.length !== 1 ||
    networkPolicy?.spec?.ingress?.[0]?.from?.[0]?.podSelector?.matchLabels?.[
      'qinglong.io/plugin-package-management-client'
    ] !== 'true' ||
    networkPolicy?.spec?.ingress?.[0]?.ports?.[0]?.port !== 8443 ||
    JSON.stringify(networkPolicy?.spec?.egress) !==
      JSON.stringify([expectedDnsEgress])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_MANAGEMENT_NETWORK_POLICY',
        'Plugin Package management must accept only labelled ingress and deny every egress destination except reviewed DNS',
      ),
    );
  }

  const operationsKustomization = yaml.load(
    readFile(
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      ),
      'utf8',
    ),
  );
  if (
    (operationsKustomization?.resources ?? []).some((resource) =>
      String(resource).includes('plugin-package-management'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_MANAGEMENT_DEFAULT_ENABLED',
        'Authenticated Plugin Package management must remain an explicit opt-in operation',
      ),
    );
  }

  const cloudNativeRoot = path.join(operationRoot, 'cloudnative-pg');
  const cloudNative = yaml.load(
    readFile(path.join(cloudNativeRoot, 'kustomization.yaml'), 'utf8'),
  );
  const unreleasedDigest =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  if (
    JSON.stringify(cloudNative?.resources) !== JSON.stringify(['../base']) ||
    cloudNative?.patches?.[0]?.path !== 'deployment-patch.yaml' ||
    cloudNative?.patches?.[1]?.path !== 'network-policy-patch.yaml' ||
    JSON.stringify(cloudNative?.images) !==
      JSON.stringify([
        {
          name: 'qinglong3-cluster-admin',
          newName: 'registry.example.com/qinglong/qinglong3-cluster-admin',
          digest: unreleasedDigest,
        },
      ])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_MANAGEMENT_RELEASE_DIGEST_PIN',
        'Plugin Package management must use its explicit fail-closed admin image digest',
      ),
    );
  }

  const patch = yaml.load(
    readFile(path.join(cloudNativeRoot, 'deployment-patch.yaml'), 'utf8'),
  );
  const networkPolicyPatch = yaml.load(
    readFile(path.join(cloudNativeRoot, 'network-policy-patch.yaml'), 'utf8'),
  );
  const expectedPostgresEgress = {
    to: [
      {
        podSelector: {
          matchLabels: {
            'cnpg.io/cluster': 'ql3-postgres',
          },
        },
      },
    ],
    ports: [{ protocol: 'TCP', port: 5432 }],
  };
  const environmentPatch = Array.isArray(patch)
    ? patch.find(
        (operation) =>
          operation?.op === 'replace' &&
          operation?.path === '/spec/template/spec/containers/0/env',
      )
    : undefined;
  const cloudNativeEnv = environmentByName({
    env: environmentPatch?.value,
  });
  if (
    cloudNativeEnv.has('QL3_POSTGRES_PACKAGE_MANAGER_URL') ||
    cloudNativeEnv.has('QL3_POSTGRES_PACKAGE_EXECUTOR_URL') ||
    cloudNativeEnv.has('QL3_POSTGRES_ADMIN_URL') ||
    cloudNativeEnv.has('QL3_POSTGRES_RUNTIME_URL') ||
    cloudNativeEnv.get('QL3_POSTGRES_PACKAGE_MANAGER_HOST')?.value !==
      'ql3-postgres-rw.qinglong3-system.svc' ||
    cloudNativeEnv.get('QL3_POSTGRES_PACKAGE_MANAGER_USER')?.valueFrom
      ?.secretKeyRef?.name !== 'ql3-postgres-package-manager-auth' ||
    cloudNativeEnv.get('QL3_POSTGRES_PACKAGE_MANAGER_USER')?.valueFrom
      ?.secretKeyRef?.key !== 'username' ||
    cloudNativeEnv.get('QL3_POSTGRES_PACKAGE_MANAGER_PASSWORD')?.valueFrom
      ?.secretKeyRef?.name !== 'ql3-postgres-package-manager-auth' ||
    cloudNativeEnv.get('QL3_POSTGRES_PACKAGE_MANAGER_PASSWORD')?.valueFrom
      ?.secretKeyRef?.key !== 'password' ||
    !Array.isArray(patch) ||
    !patch.some(
      (operation) =>
        operation?.op === 'replace' &&
        operation?.path === '/spec/template/spec/volumes/4/secret/secretName' &&
        operation?.value === 'ql3-postgres-ca',
    ) ||
    networkPolicyPatch?.kind !== 'NetworkPolicy' ||
    networkPolicyPatch?.metadata?.name !== name ||
    JSON.stringify(networkPolicyPatch?.spec?.egress) !==
      JSON.stringify([expectedDnsEgress, expectedPostgresEgress])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_MANAGEMENT_CLOUDNATIVE_PG_AUTHORITY',
        'CloudNativePG management must bind only the operator-managed Package manager role, CA, DNS and ql3-postgres egress',
      ),
    );
  }
}

function assertWorkerCredentialManagementDeployment(readFile, root, findings) {
  const operationRoot = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/operations/worker-credential-management',
  );
  const base = path.join(operationRoot, 'base');
  const expectedResources = [
    'service-account.yaml',
    'service.yaml',
    'deployment.yaml',
    'pod-disruption-budget.yaml',
    'network-policy.yaml',
  ];
  const kustomization = yaml.load(
    readFile(path.join(base, 'kustomization.yaml'), 'utf8'),
  );
  const resources = expectedResources.flatMap((name) =>
    yamlDocuments(readFile, path.join(base, name)),
  );
  const name = 'ql3-worker-credential-management';
  const serviceAccount = namedResource(resources, 'ServiceAccount', name);
  const service = namedResource(resources, 'Service', name);
  const deployment = namedResource(resources, 'Deployment', name);
  const pdb = namedResource(resources, 'PodDisruptionBudget', name);
  const networkPolicy = namedResource(resources, 'NetworkPolicy', name);
  const pod = objectAt(deployment, ['spec', 'template', 'spec']);
  const podAnnotations = objectAt(deployment, [
    'spec',
    'template',
    'metadata',
    'annotations',
  ]);
  const container = namedEntry(pod?.containers, 'management');
  const env = environmentByName(container);

  if (
    JSON.stringify(kustomization?.resources) !==
      JSON.stringify(expectedResources) ||
    resources.some((resource) =>
      [
        'Secret',
        'ConfigMap',
        'Role',
        'RoleBinding',
        'ClusterRole',
        'ClusterRoleBinding',
      ].includes(resource?.kind),
    ) ||
    serviceAccount?.automountServiceAccountToken !== false ||
    deployment?.spec?.replicas !== 2 ||
    deployment?.spec?.strategy?.rollingUpdate?.maxUnavailable !== 0 ||
    pod?.serviceAccountName !== name ||
    pod?.automountServiceAccountToken !== false ||
    !Array.isArray(
      objectAt(pod, [
        'affinity',
        'podAntiAffinity',
        'requiredDuringSchedulingIgnoredDuringExecution',
      ]),
    ) ||
    pod?.securityContext?.runAsNonRoot !== true ||
    pod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    container?.securityContext?.allowPrivilegeEscalation !== false ||
    container?.securityContext?.readOnlyRootFilesystem !== true ||
    !container?.securityContext?.capabilities?.drop?.includes('ALL')
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_LIFECYCLE',
        'Worker credential management must remain a hardened two-replica, zero-token Deployment',
      ),
    );
  }
  if (
    podAnnotations?.[
      'qinglong.io/worker-credential-management-client-ca-sha256'
    ] !==
    'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CA_ROLLOUT_EVIDENCE',
        'Worker credential management must retain the explicit CA bundle digest rollout annotation placeholder',
      ),
    );
  }
  if (
    podAnnotations?.[
      'qinglong.io/worker-credential-management-client-crl-sha256'
    ] !==
    'sha256:0000000000000000000000000000000000000000000000000000000000000000'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CRL_ROLLOUT_EVIDENCE',
        'Worker credential management must retain the explicit CRL bundle digest rollout annotation placeholder',
      ),
    );
  }
  if (
    container?.image !== 'qinglong3-cluster-admin:3.0.0-alpha.0' ||
    JSON.stringify(container?.command) !==
      JSON.stringify([
        'node',
        '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/worker-credential/management-server/workerCredentialManagementCli.js',
      ])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_ENTRYPOINT',
        'Worker credential management must use the reviewed manager-only binary',
      ),
    );
  }

  for (const [environmentName, expected] of [
    ['QL3_PROFILE', 'cluster-admin'],
    ['QL3_WORKER_CREDENTIAL_MANAGEMENT_ENABLED', 'true'],
    ['QL3_WORKER_CREDENTIAL_MANAGEMENT_HOST', '0.0.0.0'],
    ['QL3_WORKER_CREDENTIAL_MANAGEMENT_PORT', '8444'],
    [
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_TLS_CERT_FILE',
      '/var/run/secrets/qinglong3/worker-credential-management-tls/tls.crt',
    ],
    [
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_TLS_KEY_FILE',
      '/var/run/secrets/qinglong3/worker-credential-management-tls/tls.key',
    ],
    [
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_CA_FILE',
      '/var/run/secrets/qinglong3/worker-credential-management-tls/ca.crt',
    ],
    [
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_CRL_FILE',
      '/var/run/secrets/qinglong3/worker-credential-management-tls/client.crl',
    ],
    [
      'QL3_WORKER_CREDENTIAL_MANAGEMENT_IDENTITY_KEYSET_FILE',
      '/var/run/qinglong3/worker-credential-management-identity/keyset.json',
    ],
    ['QL3_WORKER_CREDENTIAL_MANAGEMENT_PLAN_LIFETIME_MS', '900000'],
    ['QL3_WORKER_CREDENTIAL_MANAGEMENT_APPROVAL_LIFETIME_MS', '900000'],
    ['QL3_WORKER_CREDENTIAL_MANAGEMENT_QUOTA_WINDOW_MS', '60000'],
    ['QL3_WORKER_CREDENTIAL_MANAGEMENT_PLAN_QUOTA', '30'],
    ['QL3_WORKER_CREDENTIAL_MANAGEMENT_PROPOSE_QUOTA', '30'],
    ['QL3_WORKER_CREDENTIAL_MANAGEMENT_DECIDE_QUOTA', '60'],
    ['QL3_WORKER_CREDENTIAL_MANAGEMENT_INSPECT_QUOTA', '600'],
    ['QL3_WORKER_CREDENTIAL_MANAGEMENT_MAX_BODY_BYTES', '65536'],
    ['QL3_WORKER_CREDENTIAL_MANAGEMENT_MAX_CONNECTIONS', '32'],
    ['QL3_WORKER_CREDENTIAL_MANAGEMENT_MAX_CONCURRENT_REQUESTS', '16'],
    ['QL3_WORKER_CREDENTIAL_MANAGEMENT_MAX_RATE_LIMIT_PEERS', '512'],
    ['QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_TLS_MODE', 'verify-full'],
    [
      'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_TLS_CA_FILE',
      '/var/run/secrets/qinglong3/postgres-worker-credential-manager/ca.crt',
    ],
    ['QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_MAX_CONNECTIONS', '2'],
  ]) {
    if (env.get(environmentName)?.value !== expected) {
      findings.push(
        finding(
          'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_ENVIRONMENT',
          `${environmentName} must remain fixed to the reviewed bounded value`,
        ),
      );
    }
  }
  const managerUrl = env.get('QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_URL')
    ?.valueFrom?.secretKeyRef;
  const managerServername = env.get(
    'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_TLS_SERVERNAME',
  )?.valueFrom?.secretKeyRef;
  if (
    managerUrl?.name !== 'ql3-cluster-worker-credential-management-database' ||
    managerUrl?.key !== 'postgres-worker-credential-manager-url' ||
    managerServername?.name !==
      'ql3-cluster-worker-credential-management-database' ||
    managerServername?.key !== 'postgres-tls-servername' ||
    [
      'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_URL',
      'QL3_POSTGRES_PACKAGE_MANAGER_URL',
      'QL3_POSTGRES_PACKAGE_EXECUTOR_URL',
      'QL3_POSTGRES_ADMIN_URL',
      'QL3_POSTGRES_RUNTIME_URL',
      'QL3_POSTGRES_MIGRATION_URL',
      'QL3_WORKER_CREDENTIAL_PEPPER',
    ].some((environmentName) => env.has(environmentName))
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_DATABASE_AUTHORITY',
        'Worker credential management must receive only its dedicated manager database identity',
      ),
    );
  }

  for (const [probe, expectedPath] of [
    ['startupProbe', '/livez'],
    ['readinessProbe', '/readyz'],
    ['livenessProbe', '/livez'],
  ]) {
    if (
      container?.[probe]?.httpGet?.path !== expectedPath ||
      container?.[probe]?.httpGet?.port !== 'https' ||
      container?.[probe]?.httpGet?.scheme !== 'HTTPS'
    ) {
      findings.push(
        finding(
          'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_HTTPS_PROBE',
          `${probe} must use the reviewed HTTPS endpoint`,
        ),
      );
    }
  }
  if (
    service?.spec?.type !== 'ClusterIP' ||
    service?.spec?.ports?.[0]?.port !== 8444 ||
    service?.spec?.ports?.[0]?.targetPort !== 'https' ||
    container?.resources?.requests?.memory !== '128Mi' ||
    container?.resources?.limits?.memory !== '512Mi' ||
    pdb?.spec?.minAvailable !== 1
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_SERVICE_ENVELOPE',
        'Worker credential management Service, PDB and memory envelope must remain bounded',
      ),
    );
  }

  const tlsMount = namedEntry(container?.volumeMounts, 'management-tls');
  const tlsVolume = namedEntry(pod?.volumes, 'management-tls');
  const identityMount = namedEntry(
    container?.volumeMounts,
    'management-identity',
  );
  const identityVolume = namedEntry(pod?.volumes, 'management-identity');
  const databaseCaMount = namedEntry(
    container?.volumeMounts,
    'postgres-worker-credential-manager-ca',
  );
  const databaseCaVolume = namedEntry(
    pod?.volumes,
    'postgres-worker-credential-manager-ca',
  );
  if (
    tlsMount?.readOnly !== true ||
    tlsVolume?.secret?.secretName !== 'ql3-worker-credential-management-tls' ||
    tlsVolume?.secret?.defaultMode !== 0o440 ||
    JSON.stringify(tlsVolume?.secret?.items) !==
      JSON.stringify([
        { key: 'tls.crt', path: 'tls.crt' },
        { key: 'tls.key', path: 'tls.key' },
        { key: 'ca.crt', path: 'ca.crt' },
        { key: 'client.crl', path: 'client.crl' },
      ]) ||
    identityMount?.readOnly !== true ||
    identityVolume?.secret?.secretName !==
      'ql3-worker-credential-management-identity' ||
    identityVolume?.secret?.defaultMode !== 0o444 ||
    databaseCaMount?.readOnly !== true ||
    databaseCaVolume?.secret?.secretName !==
      'ql3-cluster-worker-credential-management-database' ||
    databaseCaVolume?.secret?.defaultMode !== 0o444
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_FILE_BINDING',
        'Worker manager TLS, identity and PostgreSQL CA must use separate read-only projections',
      ),
    );
  }

  const expectedDnsEgress = {
    to: [
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
        },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      },
    ],
    ports: [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ],
  };
  if (
    JSON.stringify(networkPolicy?.spec?.policyTypes) !==
      JSON.stringify(['Ingress', 'Egress']) ||
    networkPolicy?.spec?.ingress?.length !== 1 ||
    networkPolicy?.spec?.ingress?.[0]?.from?.[0]?.podSelector?.matchLabels?.[
      'qinglong.io/worker-credential-management-client'
    ] !== 'true' ||
    networkPolicy?.spec?.ingress?.[0]?.ports?.[0]?.port !== 8444 ||
    JSON.stringify(networkPolicy?.spec?.egress) !==
      JSON.stringify([expectedDnsEgress])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_NETWORK_POLICY',
        'Worker credential management must accept only labelled ingress and DNS-only base egress',
      ),
    );
  }

  const operations = yaml.load(
    readFile(
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      ),
      'utf8',
    ),
  );
  if (
    (operations?.resources ?? []).some((resource) =>
      String(resource).includes('worker-credential-management'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_DEFAULT_ENABLED',
        'Worker credential management must remain an explicit opt-in operation',
      ),
    );
  }

  const cloudNativeRoot = path.join(operationRoot, 'cloudnative-pg');
  const cloudNative = yaml.load(
    readFile(path.join(cloudNativeRoot, 'kustomization.yaml'), 'utf8'),
  );
  const deploymentPatch = yaml.load(
    readFile(path.join(cloudNativeRoot, 'deployment-patch.yaml'), 'utf8'),
  );
  const networkPolicyPatch = yaml.load(
    readFile(path.join(cloudNativeRoot, 'network-policy-patch.yaml'), 'utf8'),
  );
  const environmentPatch = Array.isArray(deploymentPatch)
    ? deploymentPatch.find(
        (operation) =>
          operation?.op === 'replace' &&
          operation?.path === '/spec/template/spec/containers/0/env',
      )
    : undefined;
  const cloudNativeEnv = environmentByName({ env: environmentPatch?.value });
  const expectedPostgresEgress = {
    to: [
      {
        podSelector: {
          matchLabels: { 'cnpg.io/cluster': 'ql3-postgres' },
        },
      },
    ],
    ports: [{ protocol: 'TCP', port: 5432 }],
  };
  const unreleasedDigest =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  if (
    JSON.stringify(cloudNative?.resources) !== JSON.stringify(['../base']) ||
    cloudNative?.patches?.[0]?.path !== 'deployment-patch.yaml' ||
    cloudNative?.patches?.[1]?.path !== 'network-policy-patch.yaml' ||
    JSON.stringify(cloudNative?.images) !==
      JSON.stringify([
        {
          name: 'qinglong3-cluster-admin',
          newName: 'registry.example.com/qinglong/qinglong3-cluster-admin',
          digest: unreleasedDigest,
        },
      ]) ||
    cloudNativeEnv.has('QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_URL') ||
    cloudNativeEnv.has('QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_URL') ||
    cloudNativeEnv.get('QL3_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_CA_FILE')
      ?.value !==
      '/var/run/secrets/qinglong3/worker-credential-management-tls/ca.crt' ||
    cloudNativeEnv.get('QL3_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_CRL_FILE')
      ?.value !==
      '/var/run/secrets/qinglong3/worker-credential-management-tls/client.crl' ||
    cloudNativeEnv.get('QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_HOST')?.value !==
      'ql3-postgres-rw.qinglong3-system.svc' ||
    cloudNativeEnv.get('QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_USER')?.valueFrom
      ?.secretKeyRef?.name !== 'ql3-postgres-worker-credential-manager-auth' ||
    cloudNativeEnv.get('QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_PASSWORD')
      ?.valueFrom?.secretKeyRef?.name !==
      'ql3-postgres-worker-credential-manager-auth' ||
    !deploymentPatch.some(
      (operation) =>
        operation?.path === '/spec/template/spec/volumes/3/secret/secretName' &&
        operation?.value === 'ql3-postgres-ca',
    ) ||
    JSON.stringify(networkPolicyPatch?.spec?.egress) !==
      JSON.stringify([expectedDnsEgress, expectedPostgresEgress])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLOUDNATIVE_PG_AUTHORITY',
        'CloudNativePG Worker manager must bind only its operator-managed role, CA and writer endpoint',
      ),
    );
  }
}

function assertWorkerCredentialManagementClientOperation(
  readFile,
  root,
  findings,
) {
  const operationRoot = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/operations/worker-credential-management-client',
  );
  const base = path.join(operationRoot, 'base');
  const expectedResources = [
    'service-account.yaml',
    'job.yaml',
    'network-policy.yaml',
  ];
  const kustomization = yaml.load(
    readFile(path.join(base, 'kustomization.yaml'), 'utf8'),
  );
  const resources = expectedResources.flatMap((name) =>
    yamlDocuments(readFile, path.join(base, name)),
  );
  const name = 'ql3-worker-credential-management-client';
  const serviceAccount = namedResource(resources, 'ServiceAccount', name);
  const job = namedResource(resources, 'Job', name);
  const networkPolicy = namedResource(resources, 'NetworkPolicy', name);
  const pod = objectAt(job, ['spec', 'template', 'spec']);
  const init = namedEntry(pod?.initContainers, 'wait-for-manager');
  const container = namedEntry(pod?.containers, 'client');
  const hardened = (candidate) =>
    candidate?.securityContext?.allowPrivilegeEscalation === false &&
    candidate?.securityContext?.readOnlyRootFilesystem === true &&
    candidate?.securityContext?.capabilities?.drop?.length === 1 &&
    candidate.securityContext.capabilities.drop[0] === 'ALL';

  if (
    JSON.stringify(kustomization?.resources) !==
      JSON.stringify(expectedResources) ||
    resources.some((resource) =>
      [
        'CronJob',
        'Deployment',
        'DaemonSet',
        'Secret',
        'ConfigMap',
        'Role',
        'RoleBinding',
        'ClusterRole',
        'ClusterRoleBinding',
      ].includes(resource?.kind),
    ) ||
    serviceAccount?.metadata?.namespace !== 'qinglong3-system' ||
    serviceAccount?.automountServiceAccountToken !== false ||
    job?.metadata?.namespace !== 'qinglong3-system' ||
    job?.metadata?.labels?.['qinglong.io/execution-model'] !==
      'caller-driven' ||
    job?.spec?.backoffLimit !== 0 ||
    job?.spec?.activeDeadlineSeconds !== 120 ||
    job?.spec?.ttlSecondsAfterFinished !== 600 ||
    pod?.serviceAccountName !== name ||
    pod?.automountServiceAccountToken !== false ||
    pod?.enableServiceLinks !== false ||
    pod?.restartPolicy !== 'Never' ||
    pod?.securityContext?.runAsNonRoot !== true ||
    pod?.securityContext?.runAsUser !== 10001 ||
    pod?.securityContext?.runAsGroup !== 10001 ||
    pod?.securityContext?.fsGroup !== 10001 ||
    pod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    pod?.hostNetwork === true ||
    pod?.hostPID === true ||
    pod?.hostIPC === true ||
    pod?.shareProcessNamespace === true ||
    pod?.containers?.length !== 1 ||
    pod?.initContainers?.length !== 1 ||
    !hardened(init) ||
    !hardened(container) ||
    init?.resources?.requests?.memory !== '16Mi' ||
    init?.resources?.limits?.memory !== '64Mi' ||
    container?.resources?.requests?.memory !== '48Mi' ||
    container?.resources?.limits?.memory !== '128Mi'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_LIFECYCLE',
        'Worker credential management client must remain one hardened, tokenless, caller-created and non-retrying Job',
      ),
    );
  }

  const readinessScript = String(init?.args?.[0] ?? '');
  const clientScript = String(container?.args?.[0] ?? '');
  if (
    init?.image !== 'qinglong3-cluster-admin:3.0.0-alpha.0' ||
    init?.imagePullPolicy !== 'IfNotPresent' ||
    JSON.stringify(init?.command) !== JSON.stringify(['node', '-e']) ||
    !readinessScript.includes(
      "const host = 'ql3-worker-credential-management.qinglong3-system.svc';",
    ) ||
    !readinessScript.includes("path: '/readyz'") ||
    !readinessScript.includes("minVersion: 'TLSv1.3'") ||
    !readinessScript.includes("maxVersion: 'TLSv1.3'") ||
    !readinessScript.includes('rejectUnauthorized: true') ||
    !readinessScript.includes('cert,') ||
    !readinessScript.includes('key,') ||
    !readinessScript.includes('attempt <= 30') ||
    container?.image !== 'qinglong3-cluster-admin:3.0.0-alpha.0' ||
    container?.imagePullPolicy !== 'IfNotPresent' ||
    JSON.stringify(container?.command) !== JSON.stringify(['/bin/sh', '-c']) ||
    !clientScript.includes('set -eu') ||
    !clientScript.includes('umask 077') ||
    !clientScript.includes(
      'chmod 600 /tmp/client.json /tmp/command.json /tmp/assertion.jwt /tmp/ca.crt /tmp/client.crt /tmp/client.key',
    ) ||
    !clientScript.includes(
      '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/worker-credential/workerCredentialManagementClientCli.js',
    ) ||
    !clientScript.includes('--config=/tmp/client.json') ||
    !clientScript.includes('--command=/tmp/command.json') ||
    !clientScript.includes('--assertion=/tmp/assertion.jwt') ||
    Array.isArray(init?.env) ||
    Array.isArray(init?.envFrom) ||
    Array.isArray(container?.env) ||
    Array.isArray(container?.envFrom)
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_ENTRYPOINT',
        'Worker credential management client must probe readiness without replay and invoke the reviewed production client exactly once',
      ),
    );
  }

  const tmpVolume = namedEntry(pod?.volumes, 'tmp');
  const requestVolume = namedEntry(pod?.volumes, 'request');
  const assertionVolume = namedEntry(pod?.volumes, 'assertion');
  const trustVolume = namedEntry(pod?.volumes, 'trust');
  const clientIdentityVolume = namedEntry(pod?.volumes, 'client-identity');
  const tmpMount = namedEntry(container?.volumeMounts, 'tmp');
  const requestMount = namedEntry(container?.volumeMounts, 'request');
  const assertionMount = namedEntry(container?.volumeMounts, 'assertion');
  const trustMount = namedEntry(container?.volumeMounts, 'trust');
  const clientIdentityMount = namedEntry(
    container?.volumeMounts,
    'client-identity',
  );
  const initTrustMount = namedEntry(init?.volumeMounts, 'trust');
  const initClientIdentityMount = namedEntry(
    init?.volumeMounts,
    'client-identity',
  );
  if (
    pod?.volumes?.length !== 5 ||
    container?.volumeMounts?.length !== 5 ||
    init?.volumeMounts?.length !== 2 ||
    JSON.stringify(tmpVolume?.emptyDir) !==
      JSON.stringify({ medium: 'Memory', sizeLimit: '4Mi' }) ||
    tmpMount?.mountPath !== '/tmp' ||
    requestVolume?.configMap?.name !==
      'ql3-worker-credential-management-request' ||
    requestVolume?.configMap?.defaultMode !== 0o444 ||
    JSON.stringify(requestVolume?.configMap?.items) !==
      JSON.stringify([
        { key: 'client.json', path: 'client.json' },
        { key: 'command.json', path: 'command.json' },
      ]) ||
    requestMount?.mountPath !==
      '/var/run/qinglong3/worker-credential-management-request' ||
    requestMount?.readOnly !== true ||
    assertionVolume?.secret?.secretName !==
      'ql3-worker-credential-management-assertion' ||
    assertionVolume?.secret?.defaultMode !== 0o440 ||
    JSON.stringify(assertionVolume?.secret?.items) !==
      JSON.stringify([{ key: 'assertion.jwt', path: 'assertion.jwt' }]) ||
    assertionMount?.mountPath !==
      '/var/run/secrets/qinglong3/worker-credential-management-assertion' ||
    assertionMount?.readOnly !== true ||
    trustVolume?.configMap?.name !==
      'ql3-worker-credential-management-client-trust' ||
    trustVolume?.configMap?.defaultMode !== 0o444 ||
    JSON.stringify(trustVolume?.configMap?.items) !==
      JSON.stringify([{ key: 'ca.crt', path: 'ca.crt' }]) ||
    trustMount?.mountPath !==
      '/var/run/qinglong3/worker-credential-management-trust' ||
    trustMount?.readOnly !== true ||
    initTrustMount?.mountPath !==
      '/var/run/qinglong3/worker-credential-management-trust' ||
    initTrustMount?.readOnly !== true ||
    clientIdentityVolume?.secret?.secretName !==
      'ql3-worker-credential-management-client-identity' ||
    clientIdentityVolume?.secret?.defaultMode !== 0o440 ||
    JSON.stringify(clientIdentityVolume?.secret?.items) !==
      JSON.stringify([
        { key: 'tls.crt', path: 'tls.crt' },
        { key: 'tls.key', path: 'tls.key' },
      ]) ||
    clientIdentityMount?.mountPath !==
      '/var/run/secrets/qinglong3/worker-credential-management-client-identity' ||
    clientIdentityMount?.readOnly !== true ||
    initClientIdentityMount?.mountPath !==
      '/var/run/secrets/qinglong3/worker-credential-management-client-identity' ||
    initClientIdentityMount?.readOnly !== true
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_FILE_BOUNDARY',
        'Client request, assertion, reviewed CA and private scratch data must remain separate least-privilege projections',
      ),
    );
  }

  const expectedDnsEgress = {
    to: [
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
        },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      },
    ],
    ports: [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ],
  };
  const expectedManagerEgress = {
    to: [
      {
        podSelector: {
          matchLabels: {
            'app.kubernetes.io/name': 'ql3-worker-credential-management',
            'app.kubernetes.io/component': 'worker-credential-management',
          },
        },
      },
    ],
    ports: [{ protocol: 'TCP', port: 8444 }],
  };
  if (
    networkPolicy?.metadata?.namespace !== 'qinglong3-system' ||
    JSON.stringify(networkPolicy?.spec?.podSelector?.matchLabels) !==
      JSON.stringify({
        'app.kubernetes.io/name': name,
        'app.kubernetes.io/component': 'worker-credential-management-client',
      }) ||
    JSON.stringify(networkPolicy?.spec?.policyTypes) !==
      JSON.stringify(['Ingress', 'Egress']) ||
    JSON.stringify(networkPolicy?.spec?.ingress) !== JSON.stringify([]) ||
    JSON.stringify(networkPolicy?.spec?.egress) !==
      JSON.stringify([expectedDnsEgress, expectedManagerEgress])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_NETWORK_POLICY',
        'Management client must deny ingress and reach only cluster DNS plus the exact same-namespace manager Pods on TCP 8444',
      ),
    );
  }

  const release = yaml.load(
    readFile(path.join(operationRoot, 'kustomization.yaml'), 'utf8'),
  );
  const unreleasedDigest =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  if (
    JSON.stringify(release?.resources) !== JSON.stringify(['base']) ||
    JSON.stringify(release?.images) !==
      JSON.stringify([
        {
          name: 'qinglong3-cluster-admin',
          newName: 'registry.example.com/qinglong/qinglong3-cluster-admin',
          digest: unreleasedDigest,
        },
      ])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_RELEASE_DIGEST_PIN',
        'Management client rollout must remain fail-closed until its independent production image digest is supplied',
      ),
    );
  }

  const operations = yaml.load(
    readFile(
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      ),
      'utf8',
    ),
  );
  if (
    (operations?.resources ?? []).some((resource) =>
      String(resource).includes('worker-credential-management-client'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_DEFAULT_ENABLED',
        'Management client must remain an explicit per-command operation',
      ),
    );
  }

  const example = yamlDocuments(
    readFile,
    path.join(operationRoot, 'config.example.yaml'),
  );
  const requestExample = namedResource(
    example,
    'ConfigMap',
    'ql3-worker-credential-management-request',
  );
  const trustExample = namedResource(
    example,
    'ConfigMap',
    'ql3-worker-credential-management-client-trust',
  );
  const assertionExample = namedResource(
    example,
    'Secret',
    'ql3-worker-credential-management-assertion',
  );
  const clientIdentityExample = namedResource(
    example,
    'Secret',
    'ql3-worker-credential-management-client-identity',
  );
  let clientExample;
  let commandExample;
  try {
    clientExample = JSON.parse(requestExample?.data?.['client.json'] ?? '');
    commandExample = JSON.parse(requestExample?.data?.['command.json'] ?? '');
  } catch {
    clientExample = undefined;
    commandExample = undefined;
  }
  if (
    example.length !== 4 ||
    requestExample?.immutable !== true ||
    clientExample?.schemaVersion !== 1 ||
    clientExample?.endpoint !==
      'https://ql3-worker-credential-management.qinglong3-system.svc:8444/api/v3/worker-credentials/management' ||
    clientExample?.servername !==
      'ql3-worker-credential-management.qinglong3-system.svc' ||
    clientExample?.caFile !== '/tmp/ca.crt' ||
    clientExample?.clientCertificateFile !== '/tmp/client.crt' ||
    clientExample?.clientPrivateKeyFile !== '/tmp/client.key' ||
    clientExample?.requestTimeoutMs !== 15000 ||
    commandExample?.schemaVersion !== 1 ||
    commandExample?.operation !== 'worker-credential.inspect' ||
    commandExample?.request?.actionRef !== 'REPLACE_WITH_ACTION_REF' ||
    commandExample?.request?.authorityProjectId !==
      'REPLACE_WITH_AUTHORITY_PROJECT_ID' ||
    commandExample?.request?.approvalRequestId !==
      'REPLACE_WITH_APPROVAL_REQUEST_ID' ||
    commandExample?.request?.inspectionId !==
      'REPLACE_WITH_UNIQUE_INSPECTION_ID' ||
    trustExample?.immutable !== true ||
    trustExample?.data?.['ca.crt'] !==
      'REPLACE_WITH_REVIEWED_MANAGER_CA_CERTIFICATE\n' ||
    assertionExample?.immutable !== true ||
    assertionExample?.type !== 'Opaque' ||
    assertionExample?.stringData?.['assertion.jwt'] !==
      'REPLACE_WITH_SHORT_LIVED_STRONG_USER_ASSERTION' ||
    clientIdentityExample?.immutable !== true ||
    clientIdentityExample?.type !== 'kubernetes.io/tls' ||
    clientIdentityExample?.stringData?.['tls.crt'] !==
      'REPLACE_WITH_SHORT_LIVED_CLIENT_CERTIFICATE_CHAIN' ||
    clientIdentityExample?.stringData?.['tls.key'] !==
      'REPLACE_WITH_CLIENT_PRIVATE_KEY' ||
    (kustomization?.resources ?? []).some((resource) =>
      String(resource).includes('config.example'),
    ) ||
    (release?.resources ?? []).some((resource) =>
      String(resource).includes('config.example'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_INPUT_BOUNDARY',
        'Immutable per-command request, short-lived assertion, separate client identity and reviewed CA examples must stay private and excluded from Kustomize',
      ),
    );
  }
}

function assertWorkerCredentialExecutorDeployment(readFile, root, findings) {
  const operationRoot = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/operations/worker-credential-executor',
  );
  const base = path.join(operationRoot, 'base');
  const expectedResources = [
    'service-account.yaml',
    'token-issuer-role-binding.yaml',
    'job.yaml',
    'network-policy.yaml',
  ];
  const kustomization = yaml.load(
    readFile(path.join(base, 'kustomization.yaml'), 'utf8'),
  );
  const resources = expectedResources.flatMap((name) =>
    yamlDocuments(readFile, path.join(base, name)),
  );
  const name = 'ql3-worker-credential-executor';
  const serviceAccount = namedResource(resources, 'ServiceAccount', name);
  const roleBinding = namedResource(
    resources,
    'RoleBinding',
    'ql3-worker-credential-executor-token-issuer',
  );
  const job = namedResource(resources, 'Job', name);
  const networkPolicy = namedResource(resources, 'NetworkPolicy', name);
  const pod = objectAt(job, ['spec', 'template', 'spec']);
  const container = namedEntry(pod?.containers, 'executor');
  const env = environmentByName(container);

  if (
    JSON.stringify(kustomization?.resources) !==
      JSON.stringify(expectedResources) ||
    resources.some((resource) =>
      [
        'CronJob',
        'Deployment',
        'Secret',
        'ConfigMap',
        'Role',
        'ClusterRole',
        'ClusterRoleBinding',
      ].includes(resource?.kind),
    ) ||
    serviceAccount?.metadata?.namespace !== 'qinglong3-system' ||
    serviceAccount?.automountServiceAccountToken !== false ||
    job?.metadata?.labels?.['qinglong.io/execution-model'] !==
      'caller-driven' ||
    job?.spec?.backoffLimit !== 0 ||
    job?.spec?.activeDeadlineSeconds !== 600 ||
    job?.spec?.ttlSecondsAfterFinished !== 600 ||
    pod?.serviceAccountName !== name ||
    pod?.automountServiceAccountToken !== false ||
    pod?.restartPolicy !== 'Never' ||
    pod?.securityContext?.runAsNonRoot !== true ||
    pod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    container?.securityContext?.allowPrivilegeEscalation !== false ||
    container?.securityContext?.readOnlyRootFilesystem !== true ||
    !container?.securityContext?.capabilities?.drop?.includes('ALL') ||
    container?.resources?.requests?.memory !== '64Mi' ||
    container?.resources?.limits?.memory !== '256Mi'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_LIFECYCLE',
        'Worker credential execution must remain one hardened, caller-created, non-retrying Job',
      ),
    );
  }
  if (
    roleBinding?.metadata?.namespace !==
      'qinglong3-worker-credential-staging' ||
    JSON.stringify(roleBinding?.roleRef) !==
      JSON.stringify({
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: 'ql3-worker-credential-token-issuer',
      }) ||
    JSON.stringify(roleBinding?.subjects) !==
      JSON.stringify([
        {
          kind: 'ServiceAccount',
          name,
          namespace: 'qinglong3-system',
        },
      ])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_ISSUER_RBAC',
        'Executor ServiceAccount may only inherit the existing exact Worker delivery TokenRequest role',
      ),
    );
  }
  if (
    container?.image !== 'qinglong3-cluster-admin:3.0.0-alpha.0' ||
    JSON.stringify(container?.command) !==
      JSON.stringify([
        'node',
        '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/worker-credential/workerCredentialExecutorCli.js',
      ])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_ENTRYPOINT',
        'Worker credential executor must use the reviewed one-shot binary',
      ),
    );
  }

  for (const [environmentName, expected] of [
    ['QL3_PROFILE', 'cluster-admin'],
    ['QL3_WORKER_CREDENTIAL_EXECUTOR_ENABLED', 'true'],
    [
      'QL3_WORKER_CREDENTIAL_EXECUTOR_COMMAND_FILE',
      '/var/run/qinglong3/worker-credential-command/command.json',
    ],
    [
      'QL3_WORKER_CREDENTIAL_EXECUTOR_PEPPER_FILE',
      '/var/run/secrets/qinglong3/worker-credential-executor/pepper',
    ],
    [
      'QL3_WORKER_CREDENTIAL_EXECUTOR_STAGE_NAMESPACE',
      'qinglong3-worker-credential-staging',
    ],
    ['QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_DATA_KEY', 'credential-token'],
    [
      'QL3_WORKER_CREDENTIAL_EXECUTOR_DELIVERY_SERVICE_ACCOUNT',
      'ql3-worker-credential-admin',
    ],
    ['QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_TLS_MODE', 'verify-full'],
    [
      'QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_TLS_CA_FILE',
      '/var/run/secrets/qinglong3/postgres-worker-credential-executor/ca.crt',
    ],
    ['QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_MAX_CONNECTIONS', '1'],
  ]) {
    if (env.get(environmentName)?.value !== expected) {
      findings.push(
        finding(
          'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_ENVIRONMENT',
          `${environmentName} must remain fixed to the reviewed one-shot value`,
        ),
      );
    }
  }
  for (const [environmentName, key] of [
    ['QL3_WORKER_CREDENTIAL_EXECUTOR_CLUSTER_IDENTITY', 'cluster-identity'],
    ['QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_NAMESPACE', 'target-namespace'],
    ['QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_SECRET', 'target-secret'],
    ['QL3_WORKER_CREDENTIAL_EXECUTOR_TARGET_DEPLOYMENT', 'target-deployment'],
    ['QL3_WORKER_CREDENTIAL_EXECUTOR_IDENTITY_SECRET', 'identity-secret'],
  ]) {
    const reference = env.get(environmentName)?.valueFrom?.configMapKeyRef;
    if (
      reference?.name !== 'ql3-worker-credential-executor-config' ||
      reference?.key !== key
    ) {
      findings.push(
        finding(
          'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_TARGET_BINDING',
          `${environmentName} must come from the reviewed per-target ConfigMap`,
        ),
      );
    }
  }
  const executorUrl = env.get('QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_URL')
    ?.valueFrom?.secretKeyRef;
  if (
    executorUrl?.name !== 'ql3-cluster-worker-credential-executor-database' ||
    executorUrl?.key !== 'postgres-worker-credential-executor-url' ||
    [
      'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_URL',
      'QL3_POSTGRES_PACKAGE_MANAGER_URL',
      'QL3_POSTGRES_PACKAGE_EXECUTOR_URL',
      'QL3_POSTGRES_ADMIN_URL',
      'QL3_POSTGRES_RUNTIME_URL',
      'QL3_POSTGRES_MIGRATION_URL',
      'QL3_WORKER_CREDENTIAL_PEPPER',
    ].some((environmentName) => env.has(environmentName))
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_DATABASE_AUTHORITY',
        'Worker credential executor must receive only its dedicated database identity and pepper file',
      ),
    );
  }

  const tokenVolume = namedEntry(pod?.volumes, 'kube-api-access');
  const tokenMount = namedEntry(container?.volumeMounts, 'kube-api-access');
  const tokenSource = tokenVolume?.projected?.sources?.find(
    (source) => source?.serviceAccountToken,
  )?.serviceAccountToken;
  const commandVolume = namedEntry(pod?.volumes, 'command');
  const commandMount = namedEntry(container?.volumeMounts, 'command');
  const pepperVolume = namedEntry(pod?.volumes, 'pepper');
  const pepperMount = namedEntry(container?.volumeMounts, 'pepper');
  const caVolume = namedEntry(
    pod?.volumes,
    'postgres-worker-credential-executor-ca',
  );
  const caMount = namedEntry(
    container?.volumeMounts,
    'postgres-worker-credential-executor-ca',
  );
  if (
    tokenMount?.readOnly !== true ||
    tokenMount?.mountPath !== '/var/run/secrets/kubernetes.io/serviceaccount' ||
    tokenVolume?.projected?.defaultMode !== 0o440 ||
    tokenSource?.path !== 'token' ||
    tokenSource?.expirationSeconds !== 600 ||
    commandMount?.readOnly !== true ||
    commandVolume?.configMap?.name !==
      'ql3-worker-credential-execution-command' ||
    commandVolume?.configMap?.defaultMode !== 0o444 ||
    pepperMount?.readOnly !== true ||
    pepperVolume?.secret?.secretName !==
      'ql3-worker-credential-executor-pepper' ||
    pepperVolume?.secret?.defaultMode !== 0o440 ||
    caMount?.readOnly !== true ||
    caVolume?.secret?.secretName !==
      'ql3-cluster-worker-credential-executor-database' ||
    caVolume?.secret?.defaultMode !== 0o444
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_FILE_AUTHORITY',
        'Executor command, pepper, CA and 600-second issuer token must remain separate read-only projections',
      ),
    );
  }

  const expectedDnsEgress = {
    to: [
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
        },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      },
    ],
    ports: [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ],
  };
  if (
    JSON.stringify(networkPolicy?.spec?.policyTypes) !==
      JSON.stringify(['Ingress', 'Egress']) ||
    JSON.stringify(networkPolicy?.spec?.ingress) !== JSON.stringify([]) ||
    JSON.stringify(networkPolicy?.spec?.egress) !==
      JSON.stringify([expectedDnsEgress])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_NETWORK_POLICY',
        'Base executor must deny ingress and expose only DNS until exact private API and database destinations are supplied',
      ),
    );
  }

  const operations = yaml.load(
    readFile(
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      ),
      'utf8',
    ),
  );
  if (
    (operations?.resources ?? []).some((resource) =>
      String(resource).includes('worker-credential-executor'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_DEFAULT_ENABLED',
        'Worker credential execution must remain an explicit caller-created operation',
      ),
    );
  }

  const example = yamlDocuments(
    readFile,
    path.join(operationRoot, 'config.example.yaml'),
  );
  const commandExample = namedResource(
    example,
    'ConfigMap',
    'ql3-worker-credential-execution-command',
  );
  const pepperExample = namedResource(
    example,
    'Secret',
    'ql3-worker-credential-executor-pepper',
  );
  if (
    commandExample?.immutable !== true ||
    typeof commandExample?.data?.['command.json'] !== 'string' ||
    pepperExample?.stringData?.['worker-credential-pepper'] !==
      'REPLACE_WITH_DISTINCT_CANONICAL_32_BYTE_BASE64URL' ||
    (kustomization?.resources ?? []).some((resource) =>
      String(resource).includes('config.example'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_INPUT_BOUNDARY',
        'Per-dispatch immutable command and private pepper examples must stay excluded from Kustomize',
      ),
    );
  }

  const cloudNativeRoot = path.join(operationRoot, 'cloudnative-pg');
  const cloudNative = yaml.load(
    readFile(path.join(cloudNativeRoot, 'kustomization.yaml'), 'utf8'),
  );
  const jobPatch = yaml.load(
    readFile(path.join(cloudNativeRoot, 'job-patch.yaml'), 'utf8'),
  );
  const networkPatch = yaml.load(
    readFile(path.join(cloudNativeRoot, 'network-policy-patch.yaml'), 'utf8'),
  );
  const environmentPatch = Array.isArray(jobPatch)
    ? jobPatch.find(
        (operation) =>
          operation?.op === 'replace' &&
          operation?.path === '/spec/template/spec/containers/0/env',
      )
    : undefined;
  const cloudNativeEnv = environmentByName({ env: environmentPatch?.value });
  const expectedPostgresEgress = {
    to: [
      {
        podSelector: {
          matchLabels: { 'cnpg.io/cluster': 'ql3-postgres' },
        },
      },
    ],
    ports: [{ protocol: 'TCP', port: 5432 }],
  };
  const unreleasedDigest =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  if (
    JSON.stringify(cloudNative?.resources) !== JSON.stringify(['../base']) ||
    cloudNative?.patches?.[0]?.path !== 'job-patch.yaml' ||
    cloudNative?.patches?.[1]?.path !== 'network-policy-patch.yaml' ||
    JSON.stringify(cloudNative?.images) !==
      JSON.stringify([
        {
          name: 'qinglong3-cluster-admin',
          newName: 'registry.example.com/qinglong/qinglong3-cluster-admin',
          digest: unreleasedDigest,
        },
      ]) ||
    cloudNativeEnv.has('QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_URL') ||
    cloudNativeEnv.has('QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_URL') ||
    cloudNativeEnv.get('QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_HOST')
      ?.value !== 'ql3-postgres-rw.qinglong3-system.svc' ||
    cloudNativeEnv.get('QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_USER')
      ?.valueFrom?.secretKeyRef?.name !==
      'ql3-postgres-worker-credential-executor-auth' ||
    cloudNativeEnv.get('QL3_POSTGRES_WORKER_CREDENTIAL_EXECUTOR_PASSWORD')
      ?.valueFrom?.secretKeyRef?.name !==
      'ql3-postgres-worker-credential-executor-auth' ||
    !jobPatch.some(
      (operation) =>
        operation?.path === '/spec/template/spec/volumes/4/secret/secretName' &&
        operation?.value === 'ql3-postgres-ca',
    ) ||
    JSON.stringify(networkPatch?.spec?.egress) !==
      JSON.stringify([expectedDnsEgress, expectedPostgresEgress])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_WORKER_CREDENTIAL_EXECUTOR_CLOUDNATIVE_PG_AUTHORITY',
        'CloudNativePG executor must bind only its operator-managed role, CA, writer endpoint and PostgreSQL egress',
      ),
    );
  }
}

function assertPluginPackageExecutorDeployment(readFile, root, findings) {
  const operationRoot = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/operations/plugin-package-executor',
  );
  const base = path.join(operationRoot, 'base');
  const expectedResources = [
    'service-account.yaml',
    'cron-job.yaml',
    'network-policy.yaml',
  ];
  const kustomization = yaml.load(
    readFile(path.join(base, 'kustomization.yaml'), 'utf8'),
  );
  const resources = expectedResources.flatMap((name) =>
    yamlDocuments(readFile, path.join(base, name)),
  );
  const name = 'ql3-plugin-package-executor';
  const serviceAccount = namedResource(resources, 'ServiceAccount', name);
  const cronJob = namedResource(resources, 'CronJob', name);
  const networkPolicy = namedResource(resources, 'NetworkPolicy', name);
  const pod = objectAt(cronJob, [
    'spec',
    'jobTemplate',
    'spec',
    'template',
    'spec',
  ]);
  const container = namedEntry(pod?.containers, 'executor');
  const env = environmentByName(container);
  if (
    JSON.stringify(kustomization?.resources) !==
      JSON.stringify(expectedResources) ||
    serviceAccount?.automountServiceAccountToken !== false ||
    cronJob?.spec?.schedule !== '*/2 * * * *' ||
    cronJob?.spec?.concurrencyPolicy !== 'Forbid' ||
    pod?.serviceAccountName !== name ||
    pod?.automountServiceAccountToken !== false ||
    pod?.restartPolicy !== 'Never' ||
    pod?.securityContext?.runAsNonRoot !== true ||
    pod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    container?.securityContext?.allowPrivilegeEscalation !== false ||
    container?.securityContext?.readOnlyRootFilesystem !== true ||
    !container?.securityContext?.capabilities?.drop?.includes('ALL') ||
    container?.resources?.requests?.memory !== '64Mi' ||
    container?.resources?.limits?.memory !== '256Mi'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_EXECUTOR_LIFECYCLE',
        'Plugin Package executor must remain a bounded, tokenless, non-overlapping CronJob',
      ),
    );
  }
  if (
    container?.image !== 'qinglong3-cluster-admin:3.0.0-alpha.0' ||
    JSON.stringify(container?.command) !==
      JSON.stringify([
        'node',
        '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/plugin-package/executor/pluginPackageExecutorCli.js',
      ])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_EXECUTOR_ENTRYPOINT',
        'Plugin Package executor must use the reviewed cluster-admin executor binary',
      ),
    );
  }
  for (const [environmentName, expected] of [
    ['QL3_PLUGIN_PACKAGE_EXECUTOR_ENABLED', 'true'],
    ['QL3_PLUGIN_PACKAGE_EXECUTOR_APPROVAL_BATCH_SIZE', '8'],
    ['QL3_PLUGIN_PACKAGE_EXECUTOR_DISPATCH_BATCH_SIZE', '8'],
    ['QL3_PLUGIN_PACKAGE_EXECUTOR_MAX_BATCHES', '4'],
    ['QL3_PLUGIN_PACKAGE_EXECUTOR_LEASE_DURATION_MS', '600000'],
    ['QL3_PLUGIN_PACKAGE_EXECUTOR_REVOCATION_PAGE_SIZE', '16'],
    ['QL3_PLUGIN_PACKAGE_EXECUTOR_REVOCATION_MAX_PAGES', '16'],
    [
      'QL3_PLUGIN_PACKAGE_EXECUTOR_SECRET_ROOT',
      '/var/run/secrets/qinglong3/plugin-package-values',
    ],
    ['QL3_POSTGRES_TLS_MODE', 'verify-full'],
    [
      'QL3_POSTGRES_TLS_CA_FILE',
      '/var/run/secrets/qinglong3/postgres-package-executor/ca.crt',
    ],
    ['QL3_POSTGRES_MAX_CONNECTIONS', '2'],
  ]) {
    if (env.get(environmentName)?.value !== expected) {
      findings.push(
        finding(
          'QL3_CLUSTER_PLUGIN_EXECUTOR_ENVIRONMENT',
          `${environmentName} must remain fixed to the reviewed bounded value`,
        ),
      );
    }
  }
  const executorUrl = env.get('QL3_POSTGRES_PACKAGE_EXECUTOR_URL')?.valueFrom
    ?.secretKeyRef;
  if (
    executorUrl?.name !== 'ql3-cluster-plugin-package-executor' ||
    executorUrl?.key !== 'postgres-package-executor-url' ||
    [
      'QL3_POSTGRES_PACKAGE_MANAGER_URL',
      'QL3_POSTGRES_ADMIN_URL',
      'QL3_POSTGRES_RUNTIME_URL',
      'QL3_POSTGRES_MIGRATION_URL',
    ].some((environmentName) => env.has(environmentName))
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_EXECUTOR_DATABASE_AUTHORITY',
        'Plugin Package executor must receive only its dedicated database identity',
      ),
    );
  }
  const caMount = namedEntry(
    container?.volumeMounts,
    'postgres-package-executor-ca',
  );
  const caVolume = namedEntry(pod?.volumes, 'postgres-package-executor-ca');
  const secretMount = namedEntry(
    container?.volumeMounts,
    'plugin-package-values',
  );
  const secretVolume = namedEntry(pod?.volumes, 'plugin-package-values');
  if (
    caMount?.readOnly !== true ||
    caMount?.mountPath !==
      '/var/run/secrets/qinglong3/postgres-package-executor' ||
    caVolume?.secret?.secretName !== 'ql3-cluster-plugin-package-executor' ||
    caVolume?.secret?.defaultMode !== 0o444 ||
    JSON.stringify(caVolume?.secret?.items) !==
      JSON.stringify([{ key: 'postgres-ca.crt', path: 'ca.crt' }]) ||
    secretMount?.readOnly !== true ||
    secretMount?.mountPath !==
      '/var/run/secrets/qinglong3/plugin-package-values' ||
    secretVolume?.secret?.secretName !==
      'ql3-cluster-plugin-package-values' ||
    secretVolume?.secret?.optional !== true ||
    secretVolume?.secret?.defaultMode !== 0o440 ||
    JSON.stringify(networkPolicy?.spec?.policyTypes) !==
      JSON.stringify(['Ingress', 'Egress']) ||
    JSON.stringify(networkPolicy?.spec?.ingress) !== JSON.stringify([]) ||
    networkPolicy?.spec?.egress?.length !== 1
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_EXECUTOR_BOUNDARY',
        'Plugin Package executor must have private read-only CA and optional SecretRef projections, no ingress and DNS-only base egress',
      ),
    );
  }
  const operations = yaml.load(
    readFile(
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      ),
      'utf8',
    ),
  );
  if (
    (operations?.resources ?? []).some((resource) =>
      String(resource).includes('plugin-package-executor'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_EXECUTOR_DEFAULT_ENABLED',
        'Plugin Package executor must remain an explicit opt-in operation',
      ),
    );
  }
  const cloudNativeRoot = path.join(operationRoot, 'cloudnative-pg');
  const cloudNative = yaml.load(
    readFile(path.join(cloudNativeRoot, 'kustomization.yaml'), 'utf8'),
  );
  const patch = yaml.load(
    readFile(path.join(cloudNativeRoot, 'cron-job-patch.yaml'), 'utf8'),
  );
  const environmentPatch = Array.isArray(patch)
    ? patch.find(
        (operation) =>
          operation?.op === 'replace' &&
          operation?.path ===
            '/spec/jobTemplate/spec/template/spec/containers/0/env',
      )
    : undefined;
  const cloudNativeEnv = environmentByName({ env: environmentPatch?.value });
  const unreleasedDigest =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  if (
    JSON.stringify(cloudNative?.resources) !== JSON.stringify(['../base']) ||
    cloudNative?.patches?.[0]?.path !== 'cron-job-patch.yaml' ||
    cloudNative?.patches?.[1]?.path !== 'network-policy-patch.yaml' ||
    JSON.stringify(cloudNative?.images) !==
      JSON.stringify([
        {
          name: 'qinglong3-cluster-admin',
          newName: 'registry.example.com/qinglong/qinglong3-cluster-admin',
          digest: unreleasedDigest,
        },
      ]) ||
    cloudNativeEnv.has('QL3_POSTGRES_PACKAGE_EXECUTOR_URL') ||
    cloudNativeEnv.get('QL3_PLUGIN_PACKAGE_EXECUTOR_SECRET_ROOT')?.value !==
      '/var/run/secrets/qinglong3/plugin-package-values' ||
    cloudNativeEnv.get('QL3_POSTGRES_PACKAGE_EXECUTOR_HOST')?.value !==
      'ql3-postgres-rw.qinglong3-system.svc' ||
    cloudNativeEnv.get('QL3_POSTGRES_PACKAGE_EXECUTOR_USER')?.valueFrom
      ?.secretKeyRef?.name !== 'ql3-postgres-package-executor-auth' ||
    cloudNativeEnv.get('QL3_POSTGRES_PACKAGE_EXECUTOR_PASSWORD')?.valueFrom
      ?.secretKeyRef?.name !== 'ql3-postgres-package-executor-auth' ||
    !patch.some(
      (operation) =>
        operation?.path ===
          '/spec/jobTemplate/spec/template/spec/volumes/1/secret/secretName' &&
        operation?.value === 'ql3-postgres-ca',
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PLUGIN_EXECUTOR_CLOUDNATIVE_PG_AUTHORITY',
        'CloudNativePG executor must bind only the operator-managed package-executor role, CA and writer endpoint',
      ),
    );
  }
}

function assertAutomationManagementDeployment(readFile, root, findings) {
  const adminManifest = readJson(
    readFile,
    path.join(root, 'packages/ql3-cluster-admin/package.json'),
  );
  const operationRoot = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/operations/automation-management',
  );
  const base = path.join(operationRoot, 'base');
  const expectedResources = [
    'service-account.yaml',
    'service.yaml',
    'deployment.yaml',
    'pod-disruption-budget.yaml',
    'network-policy.yaml',
  ];
  const kustomization = yaml.load(
    readFile(path.join(base, 'kustomization.yaml'), 'utf8'),
  );
  const resources = expectedResources.flatMap((name) =>
    yamlDocuments(readFile, path.join(base, name)),
  );
  const name = 'ql3-automation-management';
  const serviceAccount = namedResource(resources, 'ServiceAccount', name);
  const service = namedResource(resources, 'Service', name);
  const deployment = namedResource(resources, 'Deployment', name);
  const pdb = namedResource(resources, 'PodDisruptionBudget', name);
  const networkPolicy = namedResource(resources, 'NetworkPolicy', name);
  const pod = objectAt(deployment, ['spec', 'template', 'spec']);
  const container = namedEntry(pod?.containers, 'management');
  const env = environmentByName(container);
  const tlsMount = namedEntry(container?.volumeMounts, 'management-tls');
  const identityMount = namedEntry(
    container?.volumeMounts,
    'management-identity',
  );
  const databaseCaMount = namedEntry(
    container?.volumeMounts,
    'postgres-automation-manager-ca',
  );

  if (
    JSON.stringify(kustomization?.resources) !==
      JSON.stringify(expectedResources) ||
    resources.some((resource) =>
      ['Secret', 'ConfigMap', 'Role', 'RoleBinding'].includes(resource?.kind),
    ) ||
    serviceAccount?.automountServiceAccountToken !== false ||
    deployment?.spec?.replicas !== 2 ||
    deployment?.spec?.strategy?.rollingUpdate?.maxUnavailable !== 0 ||
    pod?.serviceAccountName !== name ||
    pod?.automountServiceAccountToken !== false ||
    pod?.securityContext?.runAsNonRoot !== true ||
    pod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    container?.securityContext?.allowPrivilegeEscalation !== false ||
    container?.securityContext?.readOnlyRootFilesystem !== true ||
    !container?.securityContext?.capabilities?.drop?.includes('ALL') ||
    container?.command?.[1] !==
      '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/automation-management/automationManagementCli.js' ||
    adminManifest?.exports?.['./automation-management-process']?.require !==
      './dist/automation-management/automationManagementProcess.js' ||
    adminManifest?.bin?.['ql3-automation-manage'] !==
      'dist/automation-management/automationManagementCli.js' ||
    env.get('QL3_PROFILE')?.value !== 'cluster-admin' ||
    env.get('QL3_AUTOMATION_MANAGEMENT_ENABLED')?.value !== 'true' ||
    env.get('QL3_AUTOMATION_MANAGEMENT_PORT')?.value !== '8445' ||
    env.get('QL3_POSTGRES_AUTOMATION_MANAGER_POOL_MAX')?.value !== '2' ||
    service?.spec?.ports?.[0]?.port !== 8445 ||
    pdb?.spec?.minAvailable !== 1
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AUTOMATION_MANAGEMENT_BOUNDARY',
        'Automation management must remain a two-replica non-root cluster-admin process with bounded HTTPS and a two-connection PostgreSQL pool',
      ),
    );
  }
  if (
    tlsMount?.readOnly !== true ||
    identityMount?.readOnly !== true ||
    databaseCaMount?.readOnly !== true ||
    !env.has('QL3_AUTOMATION_MANAGEMENT_CLIENT_CA_FILE') ||
    !env.has('QL3_AUTOMATION_MANAGEMENT_CLIENT_CRL_FILE') ||
    !env.has('QL3_AUTOMATION_MANAGEMENT_IDENTITY_KEYSET_FILE') ||
    env.has('QL3_POSTGRES_AUTOMATION_MANAGER_USER') ||
    env.has('QL3_POSTGRES_AUTOMATION_MANAGER_PASSWORD') ||
    networkPolicy?.spec?.policyTypes?.join(',') !== 'Ingress,Egress' ||
    networkPolicy?.spec?.ingress?.[0]?.from?.[0]?.podSelector?.matchLabels?.[
      'qinglong.io/automation-management-client'
    ] !== 'true' ||
    networkPolicy?.spec?.egress?.length !== 1 ||
    networkPolicy?.spec?.egress?.[0]?.to?.[0]?.namespaceSelector?.matchLabels?.[
      'kubernetes.io/metadata.name'
    ] !== 'kube-system' ||
    networkPolicy?.spec?.egress?.[0]?.to?.[0]?.podSelector?.matchLabels?.[
      'k8s-app'
    ] !== 'kube-dns'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AUTOMATION_MANAGEMENT_AUTHORITY',
        'Automation management base must project mTLS, CRL, purpose-bound identity and database CA only, with no inline database credential or public egress',
      ),
    );
  }

  const operations = yaml.load(
    readFile(
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      ),
      'utf8',
    ),
  );
  if (
    (operations?.resources ?? []).some((resource) =>
      String(resource).includes('automation-management'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AUTOMATION_MANAGEMENT_DEFAULT_ENABLED',
        'Automation management must remain an explicit Cluster opt-in operation',
      ),
    );
  }

  const cloudNativeRoot = path.join(operationRoot, 'cloudnative-pg');
  const cloudNative = yaml.load(
    readFile(path.join(cloudNativeRoot, 'kustomization.yaml'), 'utf8'),
  );
  const patch = yaml.load(
    readFile(path.join(cloudNativeRoot, 'deployment-patch.yaml'), 'utf8'),
  );
  const environmentPatch = Array.isArray(patch)
    ? patch.find(
        (operation) =>
          operation?.op === 'replace' &&
          operation?.path === '/spec/template/spec/containers/0/env',
      )
    : undefined;
  const cloudNativeEnv = environmentByName({ env: environmentPatch?.value });
  const unreleasedDigest =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  if (
    JSON.stringify(cloudNative?.resources) !== JSON.stringify(['../base']) ||
    cloudNative?.patches?.[0]?.path !== 'deployment-patch.yaml' ||
    cloudNative?.patches?.[1]?.path !== 'network-policy-patch.yaml' ||
    cloudNative?.images?.[0]?.digest !== unreleasedDigest ||
    cloudNativeEnv.has('QL3_POSTGRES_AUTOMATION_MANAGER_URL') ||
    cloudNativeEnv.get('QL3_POSTGRES_AUTOMATION_MANAGER_HOST')?.value !==
      'ql3-postgres-rw.qinglong3-system.svc' ||
    cloudNativeEnv.get('QL3_POSTGRES_AUTOMATION_MANAGER_USER')?.valueFrom
      ?.secretKeyRef?.name !== 'ql3-postgres-automation-manager-auth' ||
    cloudNativeEnv.get('QL3_POSTGRES_AUTOMATION_MANAGER_PASSWORD')?.valueFrom
      ?.secretKeyRef?.name !== 'ql3-postgres-automation-manager-auth' ||
    !patch.some(
      (operation) =>
        operation?.path === '/spec/template/spec/volumes/3/secret/secretName' &&
        operation?.value === 'ql3-postgres-ca',
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLOUDNATIVE_PG_AUTHORITY',
        'CloudNativePG automation management must bind only the operator-managed automation-manager role, CA, writer endpoint and fail-closed Admin image digest',
      ),
    );
  }
}

function assertApprovalManagementDeployment(readFile, root, findings) {
  const adminManifest = readJson(
    readFile,
    path.join(root, 'packages/ql3-cluster-admin/package.json'),
  );
  const operationRoot = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/operations/approval-management',
  );
  const base = path.join(operationRoot, 'base');
  const expectedResources = [
    'service-account.yaml',
    'service.yaml',
    'deployment.yaml',
    'pod-disruption-budget.yaml',
    'network-policy.yaml',
  ];
  const kustomization = yaml.load(
    readFile(path.join(base, 'kustomization.yaml'), 'utf8'),
  );
  const resources = expectedResources.flatMap((name) =>
    yamlDocuments(readFile, path.join(base, name)),
  );
  const name = 'ql3-approval-management';
  const serviceAccount = namedResource(resources, 'ServiceAccount', name);
  const service = namedResource(resources, 'Service', name);
  const deployment = namedResource(resources, 'Deployment', name);
  const pdb = namedResource(resources, 'PodDisruptionBudget', name);
  const networkPolicy = namedResource(resources, 'NetworkPolicy', name);
  const pod = objectAt(deployment, ['spec', 'template', 'spec']);
  const container = namedEntry(pod?.containers, 'management');
  const env = environmentByName(container);
  const tlsMount = namedEntry(container?.volumeMounts, 'management-tls');
  const identityMount = namedEntry(
    container?.volumeMounts,
    'management-identity',
  );
  const databaseCaMount = namedEntry(
    container?.volumeMounts,
    'postgres-approval-manager-ca',
  );
  if (
    JSON.stringify(kustomization?.resources) !==
      JSON.stringify(expectedResources) ||
    resources.some((resource) =>
      ['Secret', 'ConfigMap', 'Role', 'RoleBinding'].includes(resource?.kind),
    ) ||
    serviceAccount?.automountServiceAccountToken !== false ||
    deployment?.spec?.replicas !== 2 ||
    deployment?.spec?.strategy?.rollingUpdate?.maxUnavailable !== 0 ||
    pod?.serviceAccountName !== name ||
    pod?.automountServiceAccountToken !== false ||
    pod?.securityContext?.runAsNonRoot !== true ||
    pod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    container?.securityContext?.allowPrivilegeEscalation !== false ||
    container?.securityContext?.readOnlyRootFilesystem !== true ||
    !container?.securityContext?.capabilities?.drop?.includes('ALL') ||
    container?.command?.[1] !==
      '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/approval-management/approvalManagementCli.js' ||
    adminManifest?.exports?.['./approval-management-process']?.require !==
      './dist/approval-management/approvalManagementProcess.js' ||
    adminManifest?.bin?.['ql3-approval-manage'] !==
      'dist/approval-management/approvalManagementCli.js' ||
    env.get('QL3_PROFILE')?.value !== 'cluster-admin' ||
    env.get('QL3_APPROVAL_MANAGEMENT_ENABLED')?.value !== 'true' ||
    env.get('QL3_APPROVAL_MANAGEMENT_PORT')?.value !== '8447' ||
    env.get('QL3_POSTGRES_APPROVAL_MANAGER_POOL_MAX')?.value !== '2' ||
    service?.spec?.ports?.[0]?.port !== 8447 ||
    pdb?.spec?.minAvailable !== 1
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_APPROVAL_MANAGEMENT_BOUNDARY',
        'Approval management must remain a two-replica non-root cluster-admin process with bounded HTTPS and a two-connection PostgreSQL pool',
      ),
    );
  }
  if (
    tlsMount?.readOnly !== true ||
    identityMount?.readOnly !== true ||
    databaseCaMount?.readOnly !== true ||
    !env.has('QL3_APPROVAL_MANAGEMENT_CLIENT_CA_FILE') ||
    !env.has('QL3_APPROVAL_MANAGEMENT_CLIENT_CRL_FILE') ||
    !env.has('QL3_APPROVAL_MANAGEMENT_IDENTITY_KEYSET_FILE') ||
    env.has('QL3_POSTGRES_APPROVAL_MANAGER_USER') ||
    env.has('QL3_POSTGRES_APPROVAL_MANAGER_PASSWORD') ||
    networkPolicy?.spec?.policyTypes?.join(',') !== 'Ingress,Egress' ||
    networkPolicy?.spec?.ingress?.[0]?.from?.[0]?.podSelector?.matchLabels?.[
      'qinglong.io/approval-management-client'
    ] !== 'true' ||
    networkPolicy?.spec?.egress?.length !== 1 ||
    networkPolicy?.spec?.egress?.[0]?.to?.[0]?.namespaceSelector?.matchLabels?.[
      'kubernetes.io/metadata.name'
    ] !== 'kube-system' ||
    networkPolicy?.spec?.egress?.[0]?.to?.[0]?.podSelector?.matchLabels?.[
      'k8s-app'
    ] !== 'kube-dns'
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_APPROVAL_MANAGEMENT_AUTHORITY',
        'Approval management base must project mTLS, CRL, purpose-bound identity and database CA only, with no inline database credential or public egress',
      ),
    );
  }
  const operations = yaml.load(
    readFile(
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      ),
      'utf8',
    ),
  );
  if (
    (operations?.resources ?? []).some((resource) =>
      String(resource).includes('approval-management'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_APPROVAL_MANAGEMENT_DEFAULT_ENABLED',
        'Approval management must remain an explicit Cluster opt-in operation',
      ),
    );
  }
  const cloudNativeRoot = path.join(operationRoot, 'cloudnative-pg');
  const cloudNative = yaml.load(
    readFile(path.join(cloudNativeRoot, 'kustomization.yaml'), 'utf8'),
  );
  const patch = yaml.load(
    readFile(path.join(cloudNativeRoot, 'deployment-patch.yaml'), 'utf8'),
  );
  const environmentPatch = Array.isArray(patch)
    ? patch.find(
        (operation) =>
          operation?.op === 'replace' &&
          operation?.path === '/spec/template/spec/containers/0/env',
      )
    : undefined;
  const cloudNativeEnv = environmentByName({ env: environmentPatch?.value });
  const unreleasedDigest =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  if (
    JSON.stringify(cloudNative?.resources) !== JSON.stringify(['../base']) ||
    cloudNative?.patches?.[0]?.path !== 'deployment-patch.yaml' ||
    cloudNative?.patches?.[1]?.path !== 'network-policy-patch.yaml' ||
    cloudNative?.images?.[0]?.digest !== unreleasedDigest ||
    cloudNativeEnv.has('QL3_POSTGRES_APPROVAL_MANAGER_URL') ||
    cloudNativeEnv.get('QL3_POSTGRES_APPROVAL_MANAGER_HOST')?.value !==
      'ql3-postgres-rw.qinglong3-system.svc' ||
    cloudNativeEnv.get('QL3_POSTGRES_APPROVAL_MANAGER_USER')?.valueFrom
      ?.secretKeyRef?.name !== 'ql3-postgres-approval-manager-auth' ||
    cloudNativeEnv.get('QL3_POSTGRES_APPROVAL_MANAGER_PASSWORD')?.valueFrom
      ?.secretKeyRef?.name !== 'ql3-postgres-approval-manager-auth' ||
    !patch.some(
      (operation) =>
        operation?.path === '/spec/template/spec/volumes/3/secret/secretName' &&
        operation?.value === 'ql3-postgres-ca',
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_APPROVAL_MANAGEMENT_CLOUDNATIVE_PG_AUTHORITY',
        'CloudNativePG Approval management must bind only the operator-managed approval-manager role, CA, writer endpoint and fail-closed Admin image digest',
      ),
    );
  }
}

function assertAutomationManagementClientOperation(readFile, root, findings) {
  const operationRoot = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/operations/automation-management-client',
  );
  const base = path.join(operationRoot, 'base');
  const expectedResources = [
    'service-account.yaml',
    'job.yaml',
    'network-policy.yaml',
  ];
  const kustomization = yaml.load(
    readFile(path.join(base, 'kustomization.yaml'), 'utf8'),
  );
  const resources = expectedResources.flatMap((name) =>
    yamlDocuments(readFile, path.join(base, name)),
  );
  const name = 'ql3-automation-management-client';
  const serviceAccount = namedResource(resources, 'ServiceAccount', name);
  const job = namedResource(resources, 'Job', name);
  const networkPolicy = namedResource(resources, 'NetworkPolicy', name);
  const pod = objectAt(job, ['spec', 'template', 'spec']);
  const init = namedEntry(pod?.initContainers, 'wait-for-manager');
  const container = namedEntry(pod?.containers, 'client');
  const hardened = (candidate) =>
    candidate?.securityContext?.allowPrivilegeEscalation === false &&
    candidate?.securityContext?.readOnlyRootFilesystem === true &&
    JSON.stringify(candidate?.securityContext?.capabilities?.drop) ===
      JSON.stringify(['ALL']);
  const manifest = readJson(
    readFile,
    path.join(root, 'packages/ql3-cluster-admin/package.json'),
  );
  if (
    JSON.stringify(kustomization?.resources) !==
      JSON.stringify(expectedResources) ||
    resources.some((resource) =>
      [
        'CronJob',
        'Deployment',
        'DaemonSet',
        'Secret',
        'ConfigMap',
        'Role',
        'RoleBinding',
        'ClusterRole',
        'ClusterRoleBinding',
      ].includes(resource?.kind),
    ) ||
    manifest?.exports?.['./automation-management-client']?.require !==
      './dist/automation-management/automationManagementClient.js' ||
    manifest?.bin?.['ql3-automation-client'] !==
      'dist/automation-management/automationManagementClientCli.js' ||
    serviceAccount?.automountServiceAccountToken !== false ||
    job?.metadata?.labels?.['qinglong.io/execution-model'] !==
      'caller-driven' ||
    job?.spec?.backoffLimit !== 0 ||
    job?.spec?.activeDeadlineSeconds !== 120 ||
    job?.spec?.ttlSecondsAfterFinished !== 600 ||
    pod?.serviceAccountName !== name ||
    pod?.automountServiceAccountToken !== false ||
    pod?.enableServiceLinks !== false ||
    pod?.restartPolicy !== 'Never' ||
    pod?.securityContext?.runAsNonRoot !== true ||
    pod?.securityContext?.runAsUser !== 10001 ||
    pod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    pod?.containers?.length !== 1 ||
    pod?.initContainers?.length !== 1 ||
    !hardened(init) ||
    !hardened(container)
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLIENT_LIFECYCLE',
        'Automation management client must remain one hardened, tokenless, caller-created and non-retrying Job using the reviewed client export',
      ),
    );
  }

  const readinessScript = String(init?.args?.[0] ?? '');
  const clientScript = String(container?.args?.[0] ?? '');
  if (
    !readinessScript.includes(
      "const host = 'ql3-automation-management.qinglong3-system.svc';",
    ) ||
    !readinessScript.includes('port: 8445') ||
    !readinessScript.includes("path: '/readyz'") ||
    !readinessScript.includes("minVersion: 'TLSv1.3'") ||
    !readinessScript.includes("maxVersion: 'TLSv1.3'") ||
    !readinessScript.includes('rejectUnauthorized: true') ||
    !readinessScript.includes('attempt <= 30') ||
    !clientScript.includes('set -eu') ||
    !clientScript.includes('umask 077') ||
    !clientScript.includes(
      '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/automation-management/automationManagementClientCli.js',
    ) ||
    !clientScript.includes('--config=/tmp/client.json') ||
    !clientScript.includes('--command=/tmp/command.json') ||
    !clientScript.includes('--assertion=/tmp/assertion.jwt') ||
    Array.isArray(init?.env) ||
    Array.isArray(init?.envFrom) ||
    Array.isArray(container?.env) ||
    Array.isArray(container?.envFrom)
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLIENT_ENTRYPOINT',
        'Automation client must perform only mTLS readiness probing and then invoke the production client exactly once',
      ),
    );
  }

  const requestVolume = namedEntry(pod?.volumes, 'request');
  const assertionVolume = namedEntry(pod?.volumes, 'assertion');
  const trustVolume = namedEntry(pod?.volumes, 'trust');
  const identityVolume = namedEntry(pod?.volumes, 'client-identity');
  if (
    pod?.volumes?.length !== 5 ||
    requestVolume?.secret?.secretName !== 'ql3-automation-management-request' ||
    requestVolume?.configMap !== undefined ||
    assertionVolume?.secret?.secretName !==
      'ql3-automation-management-assertion' ||
    trustVolume?.configMap?.name !== 'ql3-automation-management-client-trust' ||
    identityVolume?.secret?.secretName !==
      'ql3-automation-management-client-identity' ||
    pod?.volumes?.some((volume) => volume?.projected || volume?.hostPath)
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLIENT_FILE_BOUNDARY',
        'Potentially sensitive Task command, assertion and client key must remain distinct Secret projections; only the reviewed server CA may use ConfigMap',
      ),
    );
  }

  const expectedDnsEgress = {
    to: [
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
        },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      },
    ],
    ports: [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ],
  };
  const expectedManagerEgress = {
    to: [
      {
        podSelector: {
          matchLabels: {
            'app.kubernetes.io/name': 'ql3-automation-management',
            'app.kubernetes.io/component': 'automation-management',
          },
        },
      },
    ],
    ports: [{ protocol: 'TCP', port: 8445 }],
  };
  if (
    JSON.stringify(networkPolicy?.spec?.policyTypes) !==
      JSON.stringify(['Ingress', 'Egress']) ||
    JSON.stringify(networkPolicy?.spec?.ingress) !== JSON.stringify([]) ||
    JSON.stringify(networkPolicy?.spec?.egress) !==
      JSON.stringify([expectedDnsEgress, expectedManagerEgress])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLIENT_NETWORK_POLICY',
        'Automation client must deny ingress and reach only cluster DNS plus exact manager Pods on TCP 8445',
      ),
    );
  }

  const release = yaml.load(
    readFile(path.join(operationRoot, 'kustomization.yaml'), 'utf8'),
  );
  const unreleasedDigest =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  if (
    JSON.stringify(release?.resources) !== JSON.stringify(['base']) ||
    release?.images?.[0]?.name !== 'qinglong3-cluster-admin' ||
    release?.images?.[0]?.digest !== unreleasedDigest
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLIENT_RELEASE_DIGEST_PIN',
        'Automation client must fail closed until an independently verified Admin image digest is supplied',
      ),
    );
  }
  const operations = yaml.load(
    readFile(
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      ),
      'utf8',
    ),
  );
  if (
    (operations?.resources ?? []).some((resource) =>
      String(resource).includes('automation-management-client'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLIENT_DEFAULT_ENABLED',
        'Automation management client must remain an explicit per-command operation',
      ),
    );
  }

  const examples = yamlDocuments(
    readFile,
    path.join(operationRoot, 'config.example.yaml'),
  );
  const requestExample = namedResource(
    examples,
    'Secret',
    'ql3-automation-management-request',
  );
  const trustExample = namedResource(
    examples,
    'ConfigMap',
    'ql3-automation-management-client-trust',
  );
  const assertionExample = namedResource(
    examples,
    'Secret',
    'ql3-automation-management-assertion',
  );
  const identityExample = namedResource(
    examples,
    'Secret',
    'ql3-automation-management-client-identity',
  );
  let clientExample;
  let commandExample;
  try {
    clientExample = JSON.parse(
      requestExample?.stringData?.['client.json'] ?? '',
    );
    commandExample = JSON.parse(
      requestExample?.stringData?.['command.json'] ?? '',
    );
  } catch {
    clientExample = undefined;
    commandExample = undefined;
  }
  if (
    examples.length !== 4 ||
    requestExample?.immutable !== true ||
    requestExample?.type !== 'Opaque' ||
    clientExample?.endpoint !==
      'https://ql3-automation-management.qinglong3-system.svc:8445/api/v3/automations/management' ||
    clientExample?.servername !==
      'ql3-automation-management.qinglong3-system.svc' ||
    commandExample?.schemaVersion !== 1 ||
    commandExample?.operation !== 'task.publish' ||
    commandExample?.request?.requestId !== 'REPLACE_WITH_UNIQUE_REQUEST_ID' ||
    commandExample?.request?.command?.projectId !== 'REPLACE_WITH_PROJECT_ID' ||
    trustExample?.immutable !== true ||
    assertionExample?.immutable !== true ||
    identityExample?.immutable !== true
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_AUTOMATION_MANAGEMENT_CLIENT_INPUT_BOUNDARY',
        'Per-command automation inputs must remain immutable, private, purpose-specific and endpoint-pinned examples',
      ),
    );
  }
}

function assertApprovalManagementClientOperation(readFile, root, findings) {
  const operationRoot = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/operations/approval-management-client',
  );
  const base = path.join(operationRoot, 'base');
  const expectedResources = [
    'service-account.yaml',
    'job.yaml',
    'network-policy.yaml',
  ];
  const kustomization = yaml.load(
    readFile(path.join(base, 'kustomization.yaml'), 'utf8'),
  );
  const resources = expectedResources.flatMap((name) =>
    yamlDocuments(readFile, path.join(base, name)),
  );
  const name = 'ql3-approval-management-client';
  const serviceAccount = namedResource(resources, 'ServiceAccount', name);
  const job = namedResource(resources, 'Job', name);
  const networkPolicy = namedResource(resources, 'NetworkPolicy', name);
  const pod = objectAt(job, ['spec', 'template', 'spec']);
  const init = namedEntry(pod?.initContainers, 'wait-for-manager');
  const container = namedEntry(pod?.containers, 'client');
  const manifest = readJson(
    readFile,
    path.join(root, 'packages/ql3-cluster-admin/package.json'),
  );
  const hardened = (candidate) =>
    candidate?.securityContext?.allowPrivilegeEscalation === false &&
    candidate?.securityContext?.readOnlyRootFilesystem === true &&
    JSON.stringify(candidate?.securityContext?.capabilities?.drop) ===
      JSON.stringify(['ALL']);
  if (
    JSON.stringify(kustomization?.resources) !==
      JSON.stringify(expectedResources) ||
    resources.some((resource) =>
      [
        'CronJob',
        'Deployment',
        'DaemonSet',
        'Secret',
        'ConfigMap',
        'Role',
        'RoleBinding',
        'ClusterRole',
        'ClusterRoleBinding',
      ].includes(resource?.kind),
    ) ||
    manifest?.exports?.['./approval-management-client']?.require !==
      './dist/approval-management/approvalManagementClient.js' ||
    manifest?.bin?.['ql3-approval-client'] !==
      'dist/approval-management/approvalManagementClientCli.js' ||
    serviceAccount?.automountServiceAccountToken !== false ||
    job?.metadata?.labels?.['qinglong.io/execution-model'] !==
      'caller-driven' ||
    job?.spec?.backoffLimit !== 0 ||
    job?.spec?.activeDeadlineSeconds !== 120 ||
    job?.spec?.ttlSecondsAfterFinished !== 600 ||
    pod?.serviceAccountName !== name ||
    pod?.automountServiceAccountToken !== false ||
    pod?.enableServiceLinks !== false ||
    pod?.restartPolicy !== 'Never' ||
    pod?.securityContext?.runAsNonRoot !== true ||
    pod?.securityContext?.runAsUser !== 10001 ||
    pod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    pod?.containers?.length !== 1 ||
    pod?.initContainers?.length !== 1 ||
    !hardened(init) ||
    !hardened(container)
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_APPROVAL_MANAGEMENT_CLIENT_LIFECYCLE',
        'Approval management client must remain one hardened, tokenless, caller-created and non-retrying Job using the reviewed client export',
      ),
    );
  }

  const readinessScript = String(init?.args?.[0] ?? '');
  const clientScript = String(container?.args?.[0] ?? '');
  if (
    !readinessScript.includes(
      "const host = 'ql3-approval-management.qinglong3-system.svc';",
    ) ||
    !readinessScript.includes('port: 8447') ||
    !readinessScript.includes("path: '/readyz'") ||
    !readinessScript.includes("minVersion: 'TLSv1.3'") ||
    !readinessScript.includes("maxVersion: 'TLSv1.3'") ||
    !readinessScript.includes('rejectUnauthorized: true') ||
    !readinessScript.includes('attempt <= 30') ||
    !clientScript.includes('set -eu') ||
    !clientScript.includes('umask 077') ||
    !clientScript.includes(
      '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/approval-management/approvalManagementClientCli.js',
    ) ||
    !clientScript.includes('--config=/tmp/client.json') ||
    !clientScript.includes('--command=/tmp/command.json') ||
    !clientScript.includes('--assertion=/tmp/assertion.jwt') ||
    Array.isArray(init?.env) ||
    Array.isArray(init?.envFrom) ||
    Array.isArray(container?.env) ||
    Array.isArray(container?.envFrom)
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_APPROVAL_MANAGEMENT_CLIENT_ENTRYPOINT',
        'Approval client must perform only mTLS readiness probing and then invoke the production client exactly once',
      ),
    );
  }

  const requestVolume = namedEntry(pod?.volumes, 'request');
  const assertionVolume = namedEntry(pod?.volumes, 'assertion');
  const trustVolume = namedEntry(pod?.volumes, 'trust');
  const identityVolume = namedEntry(pod?.volumes, 'client-identity');
  if (
    pod?.volumes?.length !== 5 ||
    requestVolume?.secret?.secretName !== 'ql3-approval-management-request' ||
    assertionVolume?.secret?.secretName !==
      'ql3-approval-management-assertion' ||
    trustVolume?.configMap?.name !== 'ql3-approval-management-client-trust' ||
    identityVolume?.secret?.secretName !==
      'ql3-approval-management-client-identity' ||
    pod?.volumes?.some((volume) => volume?.projected || volume?.hostPath)
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_APPROVAL_MANAGEMENT_CLIENT_FILE_BOUNDARY',
        'Approval command, assertion and client key must remain distinct Secret projections; only reviewed server CA may use ConfigMap',
      ),
    );
  }

  const expectedDnsEgress = {
    to: [
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
        },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      },
    ],
    ports: [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ],
  };
  const expectedManagerEgress = {
    to: [
      {
        podSelector: {
          matchLabels: {
            'app.kubernetes.io/name': 'ql3-approval-management',
            'app.kubernetes.io/component': 'approval-management',
          },
        },
      },
    ],
    ports: [{ protocol: 'TCP', port: 8447 }],
  };
  if (
    JSON.stringify(networkPolicy?.spec?.policyTypes) !==
      JSON.stringify(['Ingress', 'Egress']) ||
    JSON.stringify(networkPolicy?.spec?.ingress) !== JSON.stringify([]) ||
    JSON.stringify(networkPolicy?.spec?.egress) !==
      JSON.stringify([expectedDnsEgress, expectedManagerEgress])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_APPROVAL_MANAGEMENT_CLIENT_NETWORK_POLICY',
        'Approval client must deny ingress and reach only cluster DNS plus exact manager Pods on TCP 8447',
      ),
    );
  }

  const release = yaml.load(
    readFile(path.join(operationRoot, 'kustomization.yaml'), 'utf8'),
  );
  const unreleasedDigest =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  const operations = yaml.load(
    readFile(
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      ),
      'utf8',
    ),
  );
  if (
    JSON.stringify(release?.resources) !== JSON.stringify(['base']) ||
    release?.images?.[0]?.name !== 'qinglong3-cluster-admin' ||
    release?.images?.[0]?.digest !== unreleasedDigest ||
    (operations?.resources ?? []).some((resource) =>
      String(resource).includes('approval-management-client'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_APPROVAL_MANAGEMENT_CLIENT_OPT_IN',
        'Approval client must remain an explicit per-command operation with a fail-closed Admin image digest',
      ),
    );
  }

  const examples = yamlDocuments(
    readFile,
    path.join(operationRoot, 'config.example.yaml'),
  );
  const requestExample = namedResource(
    examples,
    'Secret',
    'ql3-approval-management-request',
  );
  const trustExample = namedResource(
    examples,
    'ConfigMap',
    'ql3-approval-management-client-trust',
  );
  const assertionExample = namedResource(
    examples,
    'Secret',
    'ql3-approval-management-assertion',
  );
  const identityExample = namedResource(
    examples,
    'Secret',
    'ql3-approval-management-client-identity',
  );
  let clientExample;
  let commandExample;
  try {
    clientExample = JSON.parse(
      requestExample?.stringData?.['client.json'] ?? '',
    );
    commandExample = JSON.parse(
      requestExample?.stringData?.['command.json'] ?? '',
    );
  } catch {
    clientExample = undefined;
    commandExample = undefined;
  }
  if (
    examples.length !== 4 ||
    requestExample?.immutable !== true ||
    clientExample?.endpoint !==
      'https://ql3-approval-management.qinglong3-system.svc:8447/api/v3/approvals/management' ||
    clientExample?.servername !==
      'ql3-approval-management.qinglong3-system.svc' ||
    commandExample?.schemaVersion !== 1 ||
    commandExample?.operation !== 'approval.inspect' ||
    commandExample?.request?.projectId !== 'REPLACE_WITH_PROJECT_ID' ||
    trustExample?.immutable !== true ||
    assertionExample?.immutable !== true ||
    identityExample?.immutable !== true
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_APPROVAL_MANAGEMENT_CLIENT_INPUT_BOUNDARY',
        'Per-command Approval inputs must remain immutable, private, purpose-specific and endpoint-pinned examples',
      ),
    );
  }
}

function assertPromptOutputKeyRetirementOperation(readFile, root, findings) {
  const operationRoot = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/operations/prompt-output-key-retirement',
  );
  const base = path.join(operationRoot, 'base');
  const expectedResources = [
    'service-account.yaml',
    'role.yaml',
    'role-binding.yaml',
    'access-review-cluster-role.yaml',
    'access-review-cluster-role-binding.yaml',
    'job.yaml',
    'network-policy.yaml',
  ];
  const kustomization = yaml.load(
    readFile(path.join(base, 'kustomization.yaml'), 'utf8'),
  );
  const resources = expectedResources.flatMap((name) =>
    yamlDocuments(readFile, path.join(base, name)),
  );
  const name = 'ql3-prompt-output-key-retirement';
  const accessReviewName = `${name}-access-review`;
  const serviceAccount = namedResource(resources, 'ServiceAccount', name);
  const role = namedResource(resources, 'Role', name);
  const roleBinding = namedResource(resources, 'RoleBinding', name);
  const accessReviewRole = namedResource(
    resources,
    'ClusterRole',
    accessReviewName,
  );
  const accessReviewBinding = namedResource(
    resources,
    'ClusterRoleBinding',
    accessReviewName,
  );
  const job = namedResource(resources, 'Job', name);
  const networkPolicy = namedResource(resources, 'NetworkPolicy', name);
  const pod = objectAt(job, ['spec', 'template', 'spec']);
  const networkPolicyReady = namedEntry(
    pod?.initContainers,
    'network-policy-ready',
  );
  const container = namedEntry(pod?.containers, 'retirement');
  const manifest = readJson(
    readFile,
    path.join(root, 'packages/ql3-cluster-admin/package.json'),
  );

  if (
    JSON.stringify(kustomization?.resources) !==
      JSON.stringify(expectedResources) ||
    resources.length !== expectedResources.length ||
    manifest?.exports?.['./prompt-output-key-retirement-process']?.require !==
      './dist/prompt-output/key-management/promptOutputKeyRetirementProcess.js' ||
    manifest?.bin?.['ql3-prompt-output-key-retire'] !==
      'dist/prompt-output/key-management/promptOutputKeyRetirementCli.js' ||
    serviceAccount?.automountServiceAccountToken !== false ||
    job?.metadata?.labels?.['qinglong.io/execution-model'] !==
      'caller-driven' ||
    job?.spec?.backoffLimit !== 0 ||
    job?.spec?.activeDeadlineSeconds !== 300 ||
    job?.spec?.ttlSecondsAfterFinished !== 600 ||
    pod?.serviceAccountName !== name ||
    pod?.automountServiceAccountToken !== false ||
    pod?.enableServiceLinks !== false ||
    pod?.restartPolicy !== 'Never' ||
    pod?.securityContext?.runAsNonRoot !== true ||
    pod?.securityContext?.runAsUser !== 10001 ||
    pod?.securityContext?.runAsGroup !== 10001 ||
    pod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    pod?.initContainers?.length !== 1 ||
    networkPolicyReady?.image !== container?.image ||
    networkPolicyReady?.imagePullPolicy !== container?.imagePullPolicy ||
    networkPolicyReady?.terminationMessagePolicy !== 'File' ||
    networkPolicyReady?.volumeMounts !== undefined ||
    networkPolicyReady?.securityContext?.allowPrivilegeEscalation !== false ||
    networkPolicyReady?.securityContext?.readOnlyRootFilesystem !== true ||
    JSON.stringify(networkPolicyReady?.securityContext?.capabilities?.drop) !==
      JSON.stringify(['ALL']) ||
    networkPolicyReady?.resources?.requests?.cpu !== '5m' ||
    networkPolicyReady?.resources?.requests?.memory !== '16Mi' ||
    networkPolicyReady?.resources?.limits?.cpu !== '100m' ||
    networkPolicyReady?.resources?.limits?.memory !== '64Mi' ||
    JSON.stringify(networkPolicyReady?.command?.slice(0, 2)) !==
      JSON.stringify(['node', '-e']) ||
    typeof networkPolicyReady?.command?.[2] !== 'string' ||
    !networkPolicyReady.command[2].includes('KUBERNETES_SERVICE_HOST') ||
    !networkPolicyReady.command[2].includes('dns.lookup(canaryHost)') ||
    !networkPolicyReady.command[2].includes("'POLICY_READY'") ||
    JSON.stringify(networkPolicyReady?.env) !==
      JSON.stringify([
        {
          name: 'QL3_NETWORK_POLICY_DENY_CANARY_HOST',
          value: 'replace-with-reachable-deny-canary',
        },
        {
          name: 'QL3_NETWORK_POLICY_DENY_CANARY_PORT',
          value: '443',
        },
      ]) ||
    pod?.containers?.length !== 1 ||
    container?.securityContext?.allowPrivilegeEscalation !== false ||
    container?.securityContext?.readOnlyRootFilesystem !== true ||
    JSON.stringify(container?.securityContext?.capabilities?.drop) !==
      JSON.stringify(['ALL']) ||
    JSON.stringify(container?.command) !==
      JSON.stringify([
        'node',
        '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/prompt-output/key-management/promptOutputKeyRetirementCli.js',
      ]) ||
    JSON.stringify(container?.args) !==
      JSON.stringify([
        'run',
        '--command-file',
        '/var/run/qinglong3/prompt-output-key-retirement/command.json',
      ])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROMPT_OUTPUT_KEY_RETIREMENT_LIFECYCLE',
        'Prompt output key retirement must remain one hardened, caller-created, non-retrying Admin Job whose tokenless same-Pod network barrier precedes the reviewed CLI',
      ),
    );
  }

  if (
    role?.rules?.length !== 1 ||
    JSON.stringify(role.rules[0]) !==
      JSON.stringify({
        apiGroups: [''],
        resources: ['secrets'],
        resourceNames: ['ql3-prompt-output-keyring'],
        verbs: ['get', 'update'],
      }) ||
    roleBinding?.subjects?.length !== 1 ||
    roleBinding.subjects[0]?.kind !== 'ServiceAccount' ||
    roleBinding.subjects[0]?.name !== name ||
    roleBinding.subjects[0]?.namespace !== 'qinglong3-system' ||
    roleBinding?.roleRef?.kind !== 'Role' ||
    roleBinding?.roleRef?.name !== name ||
    accessReviewRole?.rules?.length !== 1 ||
    JSON.stringify(accessReviewRole.rules[0]) !==
      JSON.stringify({
        apiGroups: ['authorization.k8s.io'],
        resources: ['selfsubjectaccessreviews'],
        verbs: ['create'],
      }) ||
    accessReviewBinding?.subjects?.length !== 1 ||
    accessReviewBinding.subjects[0]?.kind !== 'ServiceAccount' ||
    accessReviewBinding.subjects[0]?.name !== name ||
    accessReviewBinding.subjects[0]?.namespace !== 'qinglong3-system' ||
    accessReviewBinding?.roleRef?.kind !== 'ClusterRole' ||
    accessReviewBinding?.roleRef?.name !== accessReviewName
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROMPT_OUTPUT_KEY_RETIREMENT_RBAC',
        'Prompt output key retirement may get/update only the exact keyring Secret and create only SelfSubjectAccessReview requests',
      ),
    );
  }

  const commandMount = namedEntry(container?.volumeMounts, 'command');
  const tokenMount = namedEntry(
    container?.volumeMounts,
    'kubernetes-api-token',
  );
  const commandVolume = namedEntry(pod?.volumes, 'command');
  const caVolume = namedEntry(pod?.volumes, 'postgres-ca');
  const tokenVolume = namedEntry(pod?.volumes, 'kubernetes-api-token');
  if (
    pod?.volumes?.length !== 3 ||
    container?.volumeMounts?.length !== 3 ||
    commandMount?.mountPath !==
      '/var/run/qinglong3/prompt-output-key-retirement/command.json' ||
    commandMount?.subPath !== 'command.json' ||
    commandMount?.readOnly !== true ||
    commandVolume?.configMap?.name !==
      'ql3-prompt-output-key-retirement-command' ||
    commandVolume?.configMap?.defaultMode !== 0o444 ||
    JSON.stringify(commandVolume?.configMap?.items) !==
      JSON.stringify([{ key: 'command.json', path: 'command.json' }]) ||
    caVolume?.secret?.secretName !== 'ql3-cluster-ai-maintenance' ||
    caVolume?.secret?.defaultMode !== 0o444 ||
    tokenMount?.mountPath !== '/var/run/secrets/kubernetes.io/serviceaccount' ||
    tokenMount?.readOnly !== true ||
    tokenVolume?.projected?.defaultMode !== 0o400 ||
    JSON.stringify(tokenVolume?.projected?.sources) !==
      JSON.stringify([
        {
          serviceAccountToken: {
            path: 'token',
            expirationSeconds: 600,
          },
        },
        {
          configMap: {
            name: 'kube-root-ca.crt',
            items: [{ key: 'ca.crt', path: 'ca.crt' }],
          },
        },
        {
          downwardAPI: {
            items: [
              {
                path: 'namespace',
                fieldRef: {
                  apiVersion: 'v1',
                  fieldPath: 'metadata.namespace',
                },
              },
            ],
          },
        },
      ]) ||
    pod?.volumes?.some(
      (volume) =>
        volume?.hostPath ||
        (volume?.projected && volume?.name !== 'kubernetes-api-token'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROMPT_OUTPUT_KEY_RETIREMENT_FILE_BOUNDARY',
        'The immutable low-sensitive command, database trust and short-lived Kubernetes token must remain distinct projections, and only the main container may mount the token',
      ),
    );
  }

  const expectedDnsEgress = {
    to: [
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
        },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      },
    ],
    ports: [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ],
  };
  if (
    JSON.stringify(networkPolicy?.spec?.policyTypes) !==
      JSON.stringify(['Ingress', 'Egress']) ||
    JSON.stringify(networkPolicy?.spec?.ingress) !== JSON.stringify([]) ||
    JSON.stringify(networkPolicy?.spec?.egress) !==
      JSON.stringify([expectedDnsEgress])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROMPT_OUTPUT_KEY_RETIREMENT_NETWORK_POLICY',
        'The base retirement operation must deny ingress and all non-DNS egress until deployment-specific exact database and API server rules are supplied',
      ),
    );
  }

  const commandExample = yaml.load(
    readFile(path.join(operationRoot, 'command.example.yaml'), 'utf8'),
  );
  let command;
  try {
    command = JSON.parse(commandExample?.data?.['command.json'] ?? '');
  } catch {
    command = undefined;
  }
  const apiPatch = yaml.load(
    readFile(
      path.join(operationRoot, 'api-server-egress-patch.example.yaml'),
      'utf8',
    ),
  );
  if (
    commandExample?.kind !== 'ConfigMap' ||
    commandExample?.metadata?.name !==
      'ql3-prompt-output-key-retirement-command' ||
    commandExample?.immutable !== true ||
    command?.schemaVersion !== 1 ||
    command?.operation !== 'cluster.prompt-output-key.retire' ||
    command?.kubernetes?.namespace !== 'qinglong3-system' ||
    command?.kubernetes?.secretName !== 'ql3-prompt-output-keyring' ||
    command?.kubernetes?.dataKey !== 'keyring.json' ||
    command?.kubernetes?.expectedSecretUid !== 'replace-with-live-secret-uid' ||
    Object.keys(command?.request ?? {})
      .sort()
      .join('\0') !==
      ['keyId', 'mutationId', 'requestId', 'retirementId'].sort().join('\0') ||
    JSON.stringify(apiPatch) !==
      JSON.stringify([
        {
          op: 'add',
          path: '/spec/egress/-',
          value: {
            to: [{ ipBlock: { cidr: '192.0.2.1/32' } }],
            ports: [{ protocol: 'TCP', port: 6443 }],
          },
        },
      ])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROMPT_OUTPUT_KEY_RETIREMENT_INPUT_BOUNDARY',
        'Retirement input must remain immutable, exact-shape, Secret-UID-fenced and paired with an explicit exact API server egress patch',
      ),
    );
  }

  const cloudNative = yaml.load(
    readFile(
      path.join(operationRoot, 'cloudnative-pg/kustomization.yaml'),
      'utf8',
    ),
  );
  const cloudNativeJobPatch = yaml.load(
    readFile(path.join(operationRoot, 'cloudnative-pg/job-patch.yaml'), 'utf8'),
  );
  const cloudNativeNetwork = yaml.load(
    readFile(
      path.join(operationRoot, 'cloudnative-pg/network-policy-patch.yaml'),
      'utf8',
    ),
  );
  const cloudNativeEnv = environmentByName({
    env: cloudNativeJobPatch?.[0]?.value,
  });
  const unreleasedDigest =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  const expectedPostgresEgress = {
    to: [
      { podSelector: { matchLabels: { 'cnpg.io/cluster': 'ql3-postgres' } } },
    ],
    ports: [{ protocol: 'TCP', port: 5432 }],
  };
  if (
    JSON.stringify(cloudNative?.resources) !== JSON.stringify(['../base']) ||
    cloudNative?.patches?.[0]?.path !== 'job-patch.yaml' ||
    cloudNative?.patches?.[1]?.path !== 'network-policy-patch.yaml' ||
    cloudNative?.images?.[0]?.name !== 'qinglong3-cluster-admin' ||
    cloudNative?.images?.[0]?.digest !== unreleasedDigest ||
    cloudNativeEnv.has('QL3_POSTGRES_AI_MAINTENANCE_URL') ||
    cloudNativeEnv.get('QL3_POSTGRES_AI_MAINTENANCE_HOST')?.value !==
      'ql3-postgres-rw.qinglong3-system.svc' ||
    cloudNativeEnv.get('QL3_POSTGRES_AI_MAINTENANCE_USER')?.valueFrom
      ?.secretKeyRef?.name !== 'ql3-postgres-ai-maintenance-auth' ||
    cloudNativeEnv.get('QL3_POSTGRES_AI_MAINTENANCE_PASSWORD')?.valueFrom
      ?.secretKeyRef?.name !== 'ql3-postgres-ai-maintenance-auth' ||
    cloudNativeJobPatch?.[1]?.value !== 'ql3-postgres-ca' ||
    cloudNativeJobPatch?.[2]?.value !== 'ca.crt' ||
    JSON.stringify(cloudNativeNetwork?.spec?.egress) !==
      JSON.stringify([expectedDnsEgress, expectedPostgresEgress])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROMPT_OUTPUT_KEY_RETIREMENT_CLOUDNATIVE_PG_AUTHORITY',
        'CloudNativePG retirement must bind only the ai-maintenance role, writer endpoint, CA, exact database Pods and a fail-closed Admin image digest',
      ),
    );
  }

  const operations = yaml.load(
    readFile(
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      ),
      'utf8',
    ),
  );
  if (
    (operations?.resources ?? []).some((resource) =>
      String(resource).includes('prompt-output-key-retirement'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROMPT_OUTPUT_KEY_RETIREMENT_DEFAULT_ENABLED',
        'Prompt output key retirement must remain an explicit per-command operation',
      ),
    );
  }
}

function assertPromptOutputKeyRotationOperation(readFile, root, findings) {
  const operationRoot = path.join(
    root,
    'deploy/kubernetes/ql3-cluster/operations/prompt-output-key-rotation',
  );
  const base = path.join(operationRoot, 'base');
  const expectedResources = [
    'service-account.yaml',
    'role.yaml',
    'role-binding.yaml',
    'access-review-cluster-role.yaml',
    'access-review-cluster-role-binding.yaml',
    'job.yaml',
    'network-policy.yaml',
  ];
  const kustomization = yaml.load(
    readFile(path.join(base, 'kustomization.yaml'), 'utf8'),
  );
  const resources = expectedResources.flatMap((name) =>
    yamlDocuments(readFile, path.join(base, name)),
  );
  const name = 'ql3-prompt-output-key-rotation';
  const accessReviewName = `${name}-access-review`;
  const serviceAccount = namedResource(resources, 'ServiceAccount', name);
  const role = namedResource(resources, 'Role', name);
  const roleBinding = namedResource(resources, 'RoleBinding', name);
  const accessReviewRole = namedResource(
    resources,
    'ClusterRole',
    accessReviewName,
  );
  const accessReviewBinding = namedResource(
    resources,
    'ClusterRoleBinding',
    accessReviewName,
  );
  const job = namedResource(resources, 'Job', name);
  const networkPolicy = namedResource(resources, 'NetworkPolicy', name);
  const pod = objectAt(job, ['spec', 'template', 'spec']);
  const barrier = namedEntry(pod?.initContainers, 'network-policy-ready');
  const container = namedEntry(pod?.containers, 'rotation');
  const environment = environmentByName(container);
  const manifest = readJson(
    readFile,
    path.join(root, 'packages/ql3-cluster-admin/package.json'),
  );
  if (
    JSON.stringify(kustomization?.resources) !==
      JSON.stringify(expectedResources) ||
    resources.length !== expectedResources.length ||
    manifest?.bin?.['ql3-prompt-output-key-rotate'] !==
      'dist/prompt-output/key-management/promptOutputKeyRotationCli.js' ||
    serviceAccount?.automountServiceAccountToken !== false ||
    job?.metadata?.labels?.['qinglong.io/execution-model'] !==
      'caller-driven' ||
    job?.spec?.backoffLimit !== 0 ||
    job?.spec?.activeDeadlineSeconds !== 180 ||
    job?.spec?.ttlSecondsAfterFinished !== 600 ||
    pod?.serviceAccountName !== name ||
    pod?.automountServiceAccountToken !== false ||
    pod?.enableServiceLinks !== false ||
    pod?.restartPolicy !== 'Never' ||
    pod?.securityContext?.runAsNonRoot !== true ||
    pod?.securityContext?.runAsUser !== 10001 ||
    pod?.securityContext?.runAsGroup !== 10001 ||
    pod?.securityContext?.fsGroup !== 10001 ||
    pod?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    pod?.initContainers?.length !== 1 ||
    barrier?.image !== container?.image ||
    barrier?.imagePullPolicy !== container?.imagePullPolicy ||
    barrier?.terminationMessagePolicy !== 'File' ||
    barrier?.volumeMounts !== undefined ||
    barrier?.securityContext?.allowPrivilegeEscalation !== false ||
    barrier?.securityContext?.readOnlyRootFilesystem !== true ||
    JSON.stringify(barrier?.securityContext?.capabilities?.drop) !==
      JSON.stringify(['ALL']) ||
    JSON.stringify(barrier?.command?.slice(0, 2)) !==
      JSON.stringify(['node', '-e']) ||
    typeof barrier?.command?.[2] !== 'string' ||
    !barrier.command[2].includes('KUBERNETES_SERVICE_HOST') ||
    !barrier.command[2].includes('dns.lookup(canaryHost)') ||
    !barrier.command[2].includes("'POLICY_READY'") ||
    barrier?.resources?.limits?.memory !== '64Mi' ||
    barrier?.resources?.limits?.cpu !== '100m' ||
    pod?.containers?.length !== 1 ||
    container?.securityContext?.allowPrivilegeEscalation !== false ||
    container?.securityContext?.readOnlyRootFilesystem !== true ||
    JSON.stringify(container?.securityContext?.capabilities?.drop) !==
      JSON.stringify(['ALL']) ||
    container?.resources?.limits?.memory !== '128Mi' ||
    container?.resources?.limits?.cpu !== '250m' ||
    JSON.stringify(container?.command) !==
      JSON.stringify([
        'node',
        '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/prompt-output/key-management/promptOutputKeyRotationCli.js',
      ]) ||
    JSON.stringify(container?.args) !==
      JSON.stringify([
        'run',
        '--command-file',
        '/var/run/qinglong3/prompt-output-key-rotation/command.json',
      ]) ||
    environment.get('QL3_POSTGRES_TLS_MODE')?.value !== 'verify-full' ||
    environment.get('QL3_POSTGRES_TLS_CA_FILE')?.value !==
      '/var/run/secrets/qinglong3/postgres-ai-maintenance/ca.crt' ||
    environment.get('QL3_POSTGRES_AI_MAINTENANCE_URL')?.valueFrom?.secretKeyRef
      ?.name !== 'ql3-cluster-ai-maintenance' ||
    environment.get('QL3_POSTGRES_AI_MAINTENANCE_URL')?.valueFrom?.secretKeyRef
      ?.key !== 'postgres-ai-maintenance-url' ||
    environment.get('QL3_POSTGRES_TLS_SERVERNAME')?.valueFrom?.secretKeyRef
      ?.name !== 'ql3-cluster-ai-maintenance' ||
    environment.get('QL3_POSTGRES_TLS_SERVERNAME')?.valueFrom?.secretKeyRef
      ?.key !== 'postgres-tls-servername' ||
    [
      'QL3_POSTGRES_RUNTIME_URL',
      'QL3_POSTGRES_ADMIN_URL',
      'QL3_POSTGRES_PACKAGE_MANAGER_URL',
      'QL3_POSTGRES_PACKAGE_EXECUTOR_URL',
      'QL3_POSTGRES_AI_CREDENTIAL_MANAGER_URL',
      'QL3_POSTGRES_AI_CREDENTIAL_TESTER_URL',
    ].some((name) => environment.has(name))
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROMPT_OUTPUT_KEY_ROTATION_LIFECYCLE',
        'Prompt output key rotation must remain one hardened, caller-created, non-retrying Admin Job whose tokenless same-Pod network barrier precedes the command-file-only CLI',
      ),
    );
  }

  if (
    role?.rules?.length !== 1 ||
    JSON.stringify(role.rules[0]) !==
      JSON.stringify({
        apiGroups: [''],
        resources: ['secrets'],
        resourceNames: ['ql3-prompt-output-keyring'],
        verbs: ['get', 'update'],
      }) ||
    roleBinding?.subjects?.length !== 1 ||
    roleBinding.subjects[0]?.kind !== 'ServiceAccount' ||
    roleBinding.subjects[0]?.name !== name ||
    roleBinding.subjects[0]?.namespace !== 'qinglong3-system' ||
    roleBinding?.roleRef?.kind !== 'Role' ||
    roleBinding?.roleRef?.name !== name ||
    accessReviewRole?.rules?.length !== 1 ||
    JSON.stringify(accessReviewRole.rules[0]) !==
      JSON.stringify({
        apiGroups: ['authorization.k8s.io'],
        resources: ['selfsubjectaccessreviews'],
        verbs: ['create'],
      }) ||
    accessReviewBinding?.subjects?.length !== 1 ||
    accessReviewBinding.subjects[0]?.name !== name ||
    accessReviewBinding.subjects[0]?.namespace !== 'qinglong3-system' ||
    accessReviewBinding?.roleRef?.kind !== 'ClusterRole' ||
    accessReviewBinding?.roleRef?.name !== accessReviewName
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROMPT_OUTPUT_KEY_ROTATION_RBAC',
        'Rotation may get/update only the exact target keyring Secret and create only SelfSubjectAccessReview requests; staged material must never be API-readable by the Job',
      ),
    );
  }

  const commandMount = namedEntry(container?.volumeMounts, 'command');
  const materialMount = namedEntry(container?.volumeMounts, 'staged-material');
  const caMount = namedEntry(container?.volumeMounts, 'postgres-ca');
  const tokenMount = namedEntry(
    container?.volumeMounts,
    'kubernetes-api-token',
  );
  const commandVolume = namedEntry(pod?.volumes, 'command');
  const materialVolume = namedEntry(pod?.volumes, 'staged-material');
  const caVolume = namedEntry(pod?.volumes, 'postgres-ca');
  const tokenVolume = namedEntry(pod?.volumes, 'kubernetes-api-token');
  if (
    pod?.volumes?.length !== 4 ||
    container?.volumeMounts?.length !== 4 ||
    commandMount?.mountPath !==
      '/var/run/qinglong3/prompt-output-key-rotation/command.json' ||
    commandMount?.subPath !== 'command.json' ||
    commandMount?.readOnly !== true ||
    commandVolume?.configMap?.name !==
      'ql3-prompt-output-key-rotation-command' ||
    commandVolume?.configMap?.defaultMode !== 0o444 ||
    JSON.stringify(commandVolume?.configMap?.items) !==
      JSON.stringify([{ key: 'command.json', path: 'command.json' }]) ||
    materialMount?.mountPath !==
      '/var/run/secrets/qinglong3/prompt-output-key-rotation/material.bin' ||
    materialMount?.subPath !== 'material.bin' ||
    materialMount?.readOnly !== true ||
    materialVolume?.secret?.secretName !==
      'ql3-prompt-output-key-rotation-material' ||
    materialVolume?.secret?.defaultMode !== 0o440 ||
    materialVolume?.secret?.optional === true ||
    JSON.stringify(materialVolume?.secret?.items) !==
      JSON.stringify([{ key: 'material.bin', path: 'material.bin' }]) ||
    caMount?.mountPath !==
      '/var/run/secrets/qinglong3/postgres-ai-maintenance' ||
    caMount?.readOnly !== true ||
    caVolume?.secret?.secretName !== 'ql3-cluster-ai-maintenance' ||
    caVolume?.secret?.defaultMode !== 0o444 ||
    JSON.stringify(caVolume?.secret?.items) !==
      JSON.stringify([{ key: 'postgres-ca.crt', path: 'ca.crt' }]) ||
    tokenMount?.mountPath !== '/var/run/secrets/kubernetes.io/serviceaccount' ||
    tokenMount?.readOnly !== true ||
    tokenVolume?.projected?.defaultMode !== 0o400 ||
    JSON.stringify(tokenVolume?.projected?.sources) !==
      JSON.stringify([
        {
          serviceAccountToken: {
            path: 'token',
            expirationSeconds: 600,
          },
        },
        {
          configMap: {
            name: 'kube-root-ca.crt',
            items: [{ key: 'ca.crt', path: 'ca.crt' }],
          },
        },
        {
          downwardAPI: {
            items: [
              {
                path: 'namespace',
                fieldRef: {
                  apiVersion: 'v1',
                  fieldPath: 'metadata.namespace',
                },
              },
            ],
          },
        },
      ]) ||
    pod?.volumes?.some(
      (volume) =>
        volume?.hostPath ||
        (volume?.projected && volume?.name !== 'kubernetes-api-token'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROMPT_OUTPUT_KEY_ROTATION_FILE_BOUNDARY',
        'The low-sensitive command, exact 32-byte staged material, PostgreSQL trust and short-lived Kubernetes token must remain separate read-only projections mounted only by the main container',
      ),
    );
  }

  const expectedDnsEgress = {
    to: [
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
        },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      },
    ],
    ports: [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ],
  };
  if (
    JSON.stringify(networkPolicy?.spec?.policyTypes) !==
      JSON.stringify(['Ingress', 'Egress']) ||
    JSON.stringify(networkPolicy?.spec?.ingress) !== JSON.stringify([]) ||
    JSON.stringify(networkPolicy?.spec?.egress) !==
      JSON.stringify([expectedDnsEgress])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROMPT_OUTPUT_KEY_ROTATION_NETWORK_POLICY',
        'The base rotation operation must deny ingress and all non-DNS egress until a deployment-specific exact API server route is supplied',
      ),
    );
  }

  const commandExample = yaml.load(
    readFile(path.join(operationRoot, 'command.example.yaml'), 'utf8'),
  );
  let command;
  try {
    command = JSON.parse(commandExample?.data?.['command.json'] ?? '');
  } catch {
    command = undefined;
  }
  const apiPatch = yaml.load(
    readFile(
      path.join(operationRoot, 'api-server-egress-patch.example.yaml'),
      'utf8',
    ),
  );
  if (
    commandExample?.kind !== 'ConfigMap' ||
    commandExample?.metadata?.name !==
      'ql3-prompt-output-key-rotation-command' ||
    commandExample?.immutable !== true ||
    command?.schemaVersion !== 1 ||
    command?.operation !== 'cluster.prompt-output-key.rotate' ||
    command?.kubernetes?.namespace !== 'qinglong3-system' ||
    command?.kubernetes?.secretName !== 'ql3-prompt-output-keyring' ||
    command?.kubernetes?.dataKey !== 'keyring.json' ||
    command?.stagedMaterialFile !==
      '/var/run/secrets/qinglong3/prompt-output-key-rotation/material.bin' ||
    Object.keys(command?.request ?? {})
      .sort()
      .join('\0') !==
      [
        'expectedActiveKeyId',
        'expectedCatalogDigest',
        'mutationId',
        'newKeyId',
        'requestId',
        'rotationId',
      ]
        .sort()
        .join('\0') ||
    JSON.stringify(apiPatch) !==
      JSON.stringify([
        {
          op: 'add',
          path: '/spec/egress/-',
          value: {
            to: [{ ipBlock: { cidr: '192.0.2.1/32' } }],
            ports: [{ protocol: 'TCP', port: 6443 }],
          },
        },
      ])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROMPT_OUTPUT_KEY_ROTATION_INPUT_BOUNDARY',
        'Rotation input must remain immutable, exact-shape, UID/catalog-fenced, fixed to the staged material mount and paired with an exact API server egress patch',
      ),
    );
  }

  const cloudNative = yaml.load(
    readFile(
      path.join(operationRoot, 'cloudnative-pg/kustomization.yaml'),
      'utf8',
    ),
  );
  const cloudNativeJobPatch = yaml.load(
    readFile(path.join(operationRoot, 'cloudnative-pg/job-patch.yaml'), 'utf8'),
  );
  const cloudNativeNetwork = yaml.load(
    readFile(
      path.join(operationRoot, 'cloudnative-pg/network-policy-patch.yaml'),
      'utf8',
    ),
  );
  const cloudNativeEnvironment = environmentByName({
    env: cloudNativeJobPatch?.[0]?.value,
  });
  const expectedPostgresEgress = {
    to: [
      { podSelector: { matchLabels: { 'cnpg.io/cluster': 'ql3-postgres' } } },
    ],
    ports: [{ protocol: 'TCP', port: 5432 }],
  };
  if (
    JSON.stringify(cloudNative?.resources) !== JSON.stringify(['../base']) ||
    cloudNative?.patches?.[0]?.path !== 'job-patch.yaml' ||
    cloudNative?.patches?.[1]?.path !== 'network-policy-patch.yaml' ||
    cloudNative?.images?.[0]?.name !== 'qinglong3-cluster-admin' ||
    cloudNative?.images?.[0]?.digest !==
      'sha256:0000000000000000000000000000000000000000000000000000000000000000' ||
    cloudNativeEnvironment.has('QL3_POSTGRES_AI_MAINTENANCE_URL') ||
    cloudNativeEnvironment.get('QL3_POSTGRES_AI_MAINTENANCE_HOST')?.value !==
      'ql3-postgres-rw.qinglong3-system.svc' ||
    cloudNativeEnvironment.get('QL3_POSTGRES_AI_MAINTENANCE_USER')?.valueFrom
      ?.secretKeyRef?.name !== 'ql3-postgres-ai-maintenance-auth' ||
    cloudNativeEnvironment.get('QL3_POSTGRES_AI_MAINTENANCE_PASSWORD')
      ?.valueFrom?.secretKeyRef?.name !== 'ql3-postgres-ai-maintenance-auth' ||
    cloudNativeJobPatch?.[1]?.value !== 'ql3-postgres-ca' ||
    cloudNativeJobPatch?.[2]?.value !== 'ca.crt' ||
    JSON.stringify(cloudNativeNetwork?.spec?.egress) !==
      JSON.stringify([expectedDnsEgress, expectedPostgresEgress])
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROMPT_OUTPUT_KEY_ROTATION_CLOUDNATIVE_PG_AUTHORITY',
        'CloudNativePG rotation must bind only the ai-maintenance role, writer endpoint, CA, exact database Pods and a fail-closed Admin image digest',
      ),
    );
  }

  const operations = yaml.load(
    readFile(
      path.join(
        root,
        'deploy/kubernetes/ql3-cluster/operations/kustomization.yaml',
      ),
      'utf8',
    ),
  );
  if (
    (operations?.resources ?? []).some((resource) =>
      String(resource).includes('prompt-output-key-rotation'),
    )
  ) {
    findings.push(
      finding(
        'QL3_CLUSTER_PROMPT_OUTPUT_KEY_ROTATION_DEFAULT_ENABLED',
        'Prompt output key rotation must remain an explicit per-command operation',
      ),
    );
  }
}

function auditClusterDeployment(options = {}) {
  const root = path.resolve(options.root ?? path.join(__dirname, '..'));
  const readFile = options.readFile ?? fs.readFileSync;
  const findings = [];
  let clusterAdminImageReferences = 0;
  try {
    assertExactExternalClosure(readFile, root, findings);
    assertDockerfile(readFile, root, findings);
    assertKubernetes(readFile, root, findings);
    clusterAdminImageReferences = assertClusterAdminImageCommands(
      readFile,
      root,
      findings,
    );
    assertClusterAiComponent(readFile, root, findings);
    assertPluginPackageManagementDeployment(readFile, root, findings);
    assertWorkerCredentialManagementDeployment(readFile, root, findings);
    assertWorkerCredentialManagementClientOperation(readFile, root, findings);
    assertWorkerCredentialExecutorDeployment(readFile, root, findings);
    assertPluginPackageExecutorDeployment(readFile, root, findings);
    assertAutomationManagementDeployment(readFile, root, findings);
    assertApprovalManagementDeployment(readFile, root, findings);
    assertAutomationManagementClientOperation(readFile, root, findings);
    assertApprovalManagementClientOperation(readFile, root, findings);
    assertPromptOutputKeyRetirementOperation(readFile, root, findings);
    assertPromptOutputKeyRotationOperation(readFile, root, findings);
  } catch (error) {
    findings.push(
      finding(
        'QL3_CLUSTER_DEPLOYMENT_AUDIT_UNAVAILABLE',
        error instanceof Error ? error.message : 'unknown audit failure',
      ),
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    profile: 'cluster-control',
    workspacePackages: Object.freeze([
      '@qinglong/runtime-core',
      '@qinglong/cluster-postgres',
      '@qinglong/cluster-control',
    ]),
    externalDependencies: EXPECTED_EXTERNAL_DEPENDENCIES,
    adminWorkspacePackages: Object.freeze([
      '@qinglong/runtime-core',
      '@qinglong/cluster-postgres',
      '@qinglong/cluster-admin',
    ]),
    adminExternalDependencies: EXPECTED_ADMIN_EXTERNAL_DEPENDENCIES,
    buildDependencies: EXPECTED_BUILD_DEPENDENCIES,
    kubernetesReplicas: 2,
    migrationJob: 'explicit-one-shot',
    pluginPackageRecoveryJob: 'explicit-one-shot',
    pluginPackageManagement: 'optional-authenticated-https',
    workerCredentialManagement: 'optional-authenticated-https',
    workerCredentialManagementClient: 'caller-driven-one-shot',
    workerCredentialExecutor: 'caller-driven-one-shot',
    pluginPackageExecutor: 'optional-bounded-cron',
    automationManagement: 'optional-authenticated-https',
    automationManagementClient: 'caller-driven-one-shot',
    approvalManagement: 'optional-authenticated-https',
    approvalManagementClient: 'caller-driven-one-shot',
    promptOutputKeyRetirement: 'caller-driven-one-shot',
    promptOutputKeyRotation: 'caller-driven-staged-material',
    clusterAi: 'optional-projected-authority',
    clusterAiPromptOutput: 'optional-read-only-projected-keyring',
    imageReleasePins: 'independent-fail-closed-digests',
    clusterAdminImageReferences,
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

if (require.main === module) {
  const report = auditClusterDeployment();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.compatible) process.exitCode = 1;
}

module.exports = {
  EXPECTED_ADMIN_EXTERNAL_DEPENDENCIES,
  EXPECTED_BUILD_DEPENDENCIES,
  EXPECTED_EXTERNAL_DEPENDENCIES,
  auditClusterDeployment,
};
