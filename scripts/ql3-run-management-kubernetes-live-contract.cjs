#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  K3sDockerLiveFixture,
  run,
  waitFor,
} = require('./lib/ql3-k3s-docker-live.cjs');
const { createMutualTlsPki } = require('./lib/ql3-live-pki.cjs');
const {
  clientTcpProbe,
  createManagementClientExecutor,
  managementHealthStatus,
  patchManagementGeneration,
  podReady,
  podTcpProbe,
  readyManagementPods,
  waitForTwoPreserved,
  waitManagementRollout,
} = require('./lib/ql3-management-kubernetes-live.cjs');
const {
  applySecret,
  currentPrimaryPod,
  imageIdDigest,
  localManifest,
  psql,
} = require('./lib/ql3-management-kubernetes-live-platform.cjs');
const {
  createManagementIdentityCeremony,
} = require('./lib/ql3-management-live-identity.cjs');
const {
  durableRunManagementFacts,
  retryCommand,
  seedRunManagement,
  stopCommand,
} = require('./lib/ql3-run-management-kubernetes-live-scenario.cjs');
const {
  imageDigest,
  imageTag,
  reviewedOperatorManifest,
} = require('./ql3-cloudnativepg-live-contract.cjs');
const {
  FIXTURE,
  LIMITATIONS,
  validateRunManagementKubernetesLiveReport,
} = require('./ql3-run-management-kubernetes-live-audit.cjs');

const ROOT = path.resolve(__dirname, '..');
const NAMESPACE = 'qinglong3-system';
const DEPLOYMENT = 'ql3-run-management';
const SERVERNAME = `${DEPLOYMENT}.${NAMESPACE}.svc`;
const POSTGRES_CLUSTER = 'ql3-postgres';
const ZERO_DIGEST = 'sha256:' + '0'.repeat(64);
const ISSUER = 'https://identity.qinglong.test/';
const AUDIENCE = 'qinglong3-run-management';
const LOCK = JSON.parse(
  fs.readFileSync(
    path.join(
      ROOT,
      'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg/operator-lock.json',
    ),
    'utf8',
  ),
);
const OPERATOR_IMAGE = LOCK.operator.image;
const POSTGRES_IMAGE = LOCK.operand.image;
const ADMIN_IMAGE_BASE = 'ql3-run-manager-live';
const CONTROL_IMAGE_BASE = 'ql3-run-migration-live';
const ROLE_NAMES = Object.freeze([
  'ql3_migration',
  'ql3_ai_maintenance',
  'ql3_ai_credential_manager',
  'ql3_ai_credential_tester',
  'ql3_runtime',
  'ql3_admin',
  'ql3_package_manager',
  'ql3_package_executor',
  'ql3_automation_manager',
  'ql3_approval_manager',
  'ql3_run_manager',
  'ql3_worker_credential_manager',
  'ql3_worker_credential_executor',
  'ql3_worker_ingress',
]);
const identity = createManagementIdentityCeremony({
  issuer: ISSUER,
  audience: AUDIENCE,
  purpose: 'run-management',
  tokenType: 'ql3-run-management+jwt',
  subject: 'run-operator',
  jtiPrefix: 'ql3-run-live',
});

function sha256(value) {
  return 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
}

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function managerOptions(fixture) {
  return {
    fixture,
    namespace: NAMESPACE,
    deployment: DEPLOYMENT,
    description: 'two Ready Run manager Pods on distinct nodes',
  };
}

function patchGeneration(fixture, generation, annotations = {}) {
  patchManagementGeneration({
    ...managerOptions(fixture),
    generation,
    annotations,
  });
}

function healthStatus(fixture, pod, route) {
  return managementHealthStatus({
    fixture,
    namespace: NAMESPACE,
    podName: pod.metadata.name,
    port: 8448,
    route,
    servername: SERVERNAME,
    caFile: '/var/run/secrets/qinglong3/run-management-tls/ca.crt',
  });
}

function privateReportPath(argv) {
  if (
    argv.length !== 1 ||
    !argv[0].startsWith('--report=') ||
    !path.isAbsolute(argv[0].slice('--report='.length))
  ) {
    throw new Error(
      'usage: ql3-run-management-kubernetes-live-contract --report=/absolute/private-report.json',
    );
  }
  const reportFile = argv[0].slice('--report='.length);
  if (fs.existsSync(reportFile)) {
    throw new Error('refusing to overwrite the Run management live report');
  }
  const parent = fs.lstatSync(path.dirname(reportFile));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error(
      'Run management live report parent must be a real directory',
    );
  }
  return reportFile;
}

async function main(argv = process.argv.slice(2)) {
  const reportFile = privateReportPath(argv);
  if (process.env.QL3_RUN_MANAGEMENT_KUBERNETES_LIVE !== '1') {
    throw new Error(
      'Refusing to mutate Docker/Kubernetes without QL3_RUN_MANAGEMENT_KUBERNETES_LIVE=1',
    );
  }
  const operatorManifestFile = process.env.QL3_CNPG_OPERATOR_MANIFEST_FILE;
  if (!operatorManifestFile) {
    throw new Error('QL3_CNPG_OPERATOR_MANIFEST_FILE is required');
  }
  const reviewedManifest = reviewedOperatorManifest(operatorManifestFile);
  const fixture = new K3sDockerLiveFixture({ prefix: 'ql3-run-live' });
  const suffix =
    process.pid.toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const adminImage = `${ADMIN_IMAGE_BASE}:${suffix}`;
  const controlImage = `${CONTROL_IMAGE_BASE}:${suffix}`;
  let adminImageBuilt = false;
  let controlImageBuilt = false;
  try {
    const nodes = await fixture.start();
    const architecture = fixture.inspectImage(fixture.k3sImage).Architecture;
    assert.ok(['amd64', 'arm64'].includes(architecture));
    for (const reviewedImage of [OPERATOR_IMAGE, POSTGRES_IMAGE]) {
      run(fixture.docker, ['pull', reviewedImage]);
      const inspected = fixture.inspectImage(reviewedImage);
      assert.ok(
        inspected.RepoDigests?.some((entry) =>
          entry.endsWith('@' + imageDigest(reviewedImage)),
        ),
      );
      const preloadTag = imageTag(reviewedImage);
      run(fixture.docker, ['tag', reviewedImage, preloadTag]);
      fixture.loadImage(preloadTag, path.basename(preloadTag) + '.tar');
    }

    const sourceRevision = run('git', ['rev-parse', 'HEAD'], {
      capture: true,
      quiet: true,
    }).stdout;
    for (const [dockerfile, image, archive] of [
      [
        'deploy/containers/ql3-cluster-admin/Dockerfile',
        adminImage,
        'run-admin.tar',
      ],
      [
        'deploy/containers/ql3-cluster-control/Dockerfile',
        controlImage,
        'run-control.tar',
      ],
    ]) {
      run(fixture.docker, [
        'build',
        '--file',
        dockerfile,
        '--tag',
        image,
        '--build-arg',
        'SOURCE_REVISION=' + sourceRevision,
        '.',
      ]);
      if (image === adminImage) adminImageBuilt = true;
      else controlImageBuilt = true;
      fixture.loadImage(image, archive);
    }
    const adminImageInfo = fixture.inspectImage(adminImage);
    const postgresImageInfo = fixture.inspectImage(POSTGRES_IMAGE);
    const k3sImageInfo = fixture.inspectImage(fixture.k3sImage);

    fixture.kubectl(['apply', '--server-side', '-f', reviewedManifest]);
    fixture.kubectl([
      '-n',
      'cnpg-system',
      'set',
      'image',
      'deployment/cnpg-controller-manager',
      'manager=' + imageTag(OPERATOR_IMAGE),
    ]);
    fixture.kubectl([
      'wait',
      '--for=condition=Established',
      'crd/clusters.postgresql.cnpg.io',
      'crd/databaseroles.postgresql.cnpg.io',
      'crd/databases.postgresql.cnpg.io',
      '--timeout=5m',
    ]);
    fixture.kubectl([
      '-n',
      'cnpg-system',
      'rollout',
      'status',
      'deployment/cnpg-controller-manager',
      '--timeout=5m',
    ]);

    fixture.kubectl([
      'apply',
      '-f',
      'deploy/kubernetes/ql3-cluster/base/namespace.yaml',
    ]);
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'apply',
      '-f',
      'deploy/kubernetes/ql3-cluster/base/service-account.yaml',
    ]);
    const passwords = Object.fromEntries(
      ROLE_NAMES.map((role) => [role, randomSecret()]),
    );
    for (const role of ROLE_NAMES) {
      applySecret(
        fixture,
        'ql3-postgres-' +
          role.replace(/^ql3_/, '').replaceAll('_', '-') +
          '-auth',
        'kubernetes.io/basic-auth',
        { username: role, password: passwords[role] },
      );
    }
    const databaseManifest = fixture
      .kubectl(
        ['kustomize', 'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg'],
        {
          capture: true,
          quiet: true,
        },
      )
      .stdout.replace(POSTGRES_IMAGE, imageTag(POSTGRES_IMAGE));
    fixture.kubectl(['apply', '-f', '-'], { input: databaseManifest + '\n' });
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'wait',
      '--for=condition=Ready',
      'cluster/' + POSTGRES_CLUSTER,
      '--timeout=20m',
    ]);
    const databasePods = (
      await waitFor('three ready CloudNativePG instances', 600_000, () => {
        const pods = fixture
          .kubectlJson([
            '-n',
            NAMESPACE,
            'get',
            'pods',
            '-l',
            'cnpg.io/cluster=' + POSTGRES_CLUSTER,
          ])
          .items.filter(podReady);
        return pods.length === 3
          ? { ready: true, value: pods }
          : { ready: false, fact: `${pods.length}/3 ready database Pods` };
      })
    ).value;

    const migrationManifest = localManifest(
      fixture.kubectl(
        [
          'kustomize',
          'deploy/kubernetes/ql3-cluster/operations/cloudnative-pg',
        ],
        { capture: true, quiet: true },
      ).stdout,
      'registry.example.com/qinglong/qinglong3-cluster-control',
      controlImage,
    );
    fixture.kubectl(['create', '-f', '-'], { input: migrationManifest + '\n' });
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'wait',
      '--for=condition=Complete',
      'job/ql3-cluster-migration',
      '--timeout=10m',
    ]);
    const migrationPrimary = currentPrimaryPod(fixture);
    const migrationState = JSON.parse(
      psql(
        fixture,
        migrationPrimary.metadata.name,
        [
          'SELECT json_build_object(',
          '  \'migrationCount\', (SELECT count(*)::integer FROM "ql3"."schema_migrations"),',
          '  \'controlCoreCapability\', (SELECT contract_version::integer FROM "ql3"."schema_capabilities" WHERE contract_name = \'control-core\'))',
        ].join('\n'),
      ),
    );
    assert.deepEqual(migrationState, {
      migrationCount: 57,
      controlCoreCapability: 56,
    });

    const values = Object.freeze({
      suffix,
      projectId: 'run-live-' + suffix,
      operatorId: 'run-operator',
      outsiderId: 'run-outsider',
      taskId: 'run-live-task-' + suffix,
      sourceRunId: crypto.randomUUID(),
      sourceAttemptId: crypto.randomUUID(),
    });
    seedRunManagement(fixture, migrationPrimary.metadata.name, values, psql);

    const pki = createMutualTlsPki({
      directory: fixture.temporary,
      servername: SERVERNAME,
      label: 'QL3 Run Management Live',
      run,
      crypto,
    });
    let pkiMaterial = pki.read();
    const oldKey = identity.reviewedKey('run-live-key-1');
    const newKey = identity.reviewedKey('run-live-key-2');
    const keysets = [
      identity.keyset(1, [oldKey]),
      identity.keyset(2, [oldKey, newKey]),
      identity.keyset(3, [oldKey, newKey], [oldKey.kid]),
    ];
    const applyIdentity = (document) =>
      applySecret(fixture, DEPLOYMENT + '-identity', 'Opaque', {
        'keyset.json': JSON.stringify(document) + '\n',
      });
    const applyTls = () =>
      applySecret(fixture, DEPLOYMENT + '-tls', 'kubernetes.io/tls', {
        'tls.crt': pkiMaterial.serverCertificate,
        'tls.key': pkiMaterial.serverKey,
        'ca.crt': pkiMaterial.ca,
        'client.crl': pkiMaterial.clientCrl,
      });
    applyIdentity(keysets[0]);
    applyTls();
    const previousBundleSha256 = pki.bundleSha256();
    let managerManifest = localManifest(
      fixture.kubectl(
        [
          'kustomize',
          'deploy/kubernetes/ql3-cluster/operations/run-management/cloudnative-pg',
        ],
        { capture: true, quiet: true },
      ).stdout,
      'registry.example.com/qinglong/qinglong3-cluster-admin',
      adminImage,
    );
    assert.equal(managerManifest.split(ZERO_DIGEST).length - 1, 2);
    managerManifest = managerManifest
      .replace(ZERO_DIGEST, sha256(pkiMaterial.ca))
      .replace(ZERO_DIGEST, sha256(pkiMaterial.clientCrl));
    fixture.kubectl(['apply', '-f', '-'], { input: managerManifest + '\n' });
    waitManagementRollout(managerOptions(fixture));
    let managerPods = await readyManagementPods(managerOptions(fixture));

    const deployment = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'deployment',
      DEPLOYMENT,
    ]);
    assert.equal(deployment.spec.replicas, 2);
    assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0);
    assert.equal(
      deployment.spec.template.spec.automountServiceAccountToken,
      false,
    );
    assert.equal(
      deployment.spec.template.spec.affinity.podAntiAffinity
        .requiredDuringSchedulingIgnoredDuringExecution.length,
      1,
    );
    assert.equal(
      fixture.kubectlJson(['-n', NAMESPACE, 'get', 'pdb', DEPLOYMENT]).spec
        .minAvailable,
      1,
    );
    for (const pod of managerPods) {
      assert.equal(pod.spec.serviceAccountName, DEPLOYMENT);
      assert.equal(pod.spec.automountServiceAccountToken, false);
    }

    const executeClient = createManagementClientExecutor({
      fixture,
      namespace: NAMESPACE,
      servername: SERVERNAME,
      port: 8448,
      managementPath: '/api/v3/runs/management',
      adminImage,
      ca: pkiMaterial.ca,
      serviceAccount: 'ql3-run-management-client',
      appName: 'ql3-run-management-client',
      component: 'run-management-client',
      networkPolicyLabel: 'qinglong.io/run-management-client',
      clientCliPath:
        '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/run-management/runManagementClientCli.js',
      retryableClientCodes: ['QL3_RUN_MANAGEMENT_CLIENT_FAILED'],
      description: 'Run management',
    });
    const retryMutationId = crypto.randomUUID();
    const retry = retryCommand(
      values.projectId,
      values.sourceRunId,
      'run-live-retry',
      retryMutationId,
      1,
    );
    const retryAccepted = await executeClient(
      {
        name: 'ql3-run-retry-accepted',
        target: managerPods[0],
        command: retry,
        bearer: identity.assertion(oldKey),
        clientCertificate: pkiMaterial.oldClientCertificate,
        clientKey: pkiMaterial.oldClientKey,
      },
      { statusCode: 200, resultField: 'retry', resultStatus: ['accepted'] },
    );
    const retriedRunId = retryAccepted.output.result.retry.runId;
    const retryReplay = await executeClient(
      {
        name: 'ql3-run-retry-replay',
        target: managerPods[1],
        command: retry,
        bearer: identity.assertion(oldKey),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 200, resultField: 'retry', resultStatus: ['existing'] },
    );
    assert.equal(retryReplay.output.result.retry.runId, retriedRunId);
    const weakRejected = await executeClient(
      {
        name: 'ql3-run-retry-weak',
        target: managerPods[0],
        command: retryCommand(
          values.projectId,
          values.sourceRunId,
          'run-live-weak',
          crypto.randomUUID(),
          2,
        ),
        bearer: identity.weakAssertion(oldKey),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 401, responseCode: 'authentication_required' },
    );
    const outsiderDenied = await executeClient(
      {
        name: 'ql3-run-retry-outsider',
        target: managerPods[1],
        command: retryCommand(
          values.projectId,
          values.sourceRunId,
          'run-live-outsider',
          crypto.randomUUID(),
          3,
        ),
        bearer: identity.assertionForSubject(oldKey, values.outsiderId),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 403, responseCode: 'forbidden' },
    );

    const generation1Uids = new Set(managerPods.map((pod) => pod.metadata.uid));
    applyIdentity(keysets[1]);
    patchGeneration(fixture, 2);
    const generation2 = await waitForTwoPreserved({
      ...managerOptions(fixture),
      excludedUids: generation1Uids,
      expectedGeneration: 2,
      description: 'zero-unavailable Run manager identity generation 2 rollout',
    });
    managerPods = generation2.pods;
    const stopMutationId = crypto.randomUUID();
    const stop = stopCommand(
      values.projectId,
      retriedRunId,
      'run-live-stop',
      stopMutationId,
      4,
    );
    const overlapOld = await executeClient(
      {
        name: 'ql3-run-stop-overlap-old',
        target: managerPods[0],
        command: stop,
        bearer: identity.assertion(oldKey),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 200, resultField: 'stop', resultStatus: ['accepted'] },
    );
    const overlapNew = await executeClient(
      {
        name: 'ql3-run-stop-overlap-new',
        target: managerPods[1],
        command: stop,
        bearer: identity.assertion(newKey),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      {
        statusCode: 200,
        resultField: 'stop',
        resultStatus: ['already_requested'],
      },
    );

    const generation2Uids = new Set(managerPods.map((pod) => pod.metadata.uid));
    applyIdentity(keysets[2]);
    patchGeneration(fixture, 3);
    const generation3 = await waitForTwoPreserved({
      ...managerOptions(fixture),
      excludedUids: generation2Uids,
      expectedGeneration: 3,
      description: 'zero-unavailable Run manager identity generation 3 rollout',
    });
    managerPods = generation3.pods;
    const rejectedOldKey = await executeClient(
      {
        name: 'ql3-run-stop-revoked-key',
        target: managerPods[0],
        command: stop,
        bearer: identity.assertion(oldKey),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 401, responseCode: 'authentication_required' },
    );
    const activeNew = await executeClient(
      {
        name: 'ql3-run-stop-active-key',
        target: managerPods[1],
        command: stop,
        bearer: identity.assertion(newKey),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      {
        statusCode: 200,
        resultField: 'stop',
        resultStatus: ['already_requested'],
      },
    );

    applyIdentity(keysets[1]);
    patchGeneration(fixture, 'rollback-2');
    const rollback = await waitFor(
      'Run identity ledger rollback surge failure',
      180_000,
      () => {
        const pods = fixture
          .kubectlJson([
            '-n',
            NAMESPACE,
            'get',
            'pods',
            '-l',
            'app.kubernetes.io/name=' + DEPLOYMENT,
          ])
          .items.filter((pod) => pod.metadata.deletionTimestamp === undefined);
        const ready = pods.filter(podReady);
        const candidate = pods.find(
          (pod) =>
            !managerPods.some(
              (current) => current.metadata.uid === pod.metadata.uid,
            ) &&
            pod.status.containerStatuses?.[0] &&
            !pod.status.containerStatuses[0].ready &&
            (pod.status.containerStatuses[0].restartCount > 0 ||
              pod.status.containerStatuses[0].state?.waiting?.reason ===
                'CrashLoopBackOff'),
        );
        return ready.length === 2 && candidate
          ? { ready: true, value: candidate }
          : {
              ready: false,
              fact: `${ready.length} ready Pods; rollback=${Boolean(
                candidate,
              )}`,
            };
      },
    );
    applyIdentity(keysets[2]);
    patchGeneration(fixture, '3-rollback-recovered');
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'delete',
      'pod',
      rollback.value.metadata.name,
      '--grace-period=0',
      '--force',
      '--wait=true',
    ]);
    waitManagementRollout(managerOptions(fixture));
    managerPods = await readyManagementPods(managerOptions(fixture));

    const previousSerialSha256 = pki.oldSerialSha256();
    pki.revokeOldClient();
    pkiMaterial = pki.read();
    const currentBundleSha256 = pki.bundleSha256();
    const preCertificateUids = new Set(
      managerPods.map((pod) => pod.metadata.uid),
    );
    applyTls();
    patchGeneration(fixture, '3-client-crl-2', {
      'qinglong.io/run-management-client-ca-sha256': sha256(pkiMaterial.ca),
      'qinglong.io/run-management-client-crl-sha256': sha256(
        pkiMaterial.clientCrl,
      ),
    });
    const certificateRollout = await waitForTwoPreserved({
      ...managerOptions(fixture),
      excludedUids: preCertificateUids,
      expectedGeneration: '3-client-crl-2',
      description: 'zero-unavailable Run manager client certificate rollout',
    });
    const certificatePodsFullyReplaced = certificateRollout.pods.every(
      (pod) => !preCertificateUids.has(pod.metadata.uid),
    );
    assert.equal(certificatePodsFullyReplaced, true);
    managerPods = certificateRollout.pods;
    const revokedCertificate = await executeClient(
      {
        name: 'ql3-run-retry-revoked-cert',
        target: managerPods[0],
        command: retry,
        bearer: identity.assertion(newKey),
        clientCertificate: pkiMaterial.oldClientCertificate,
        clientKey: pkiMaterial.oldClientKey,
      },
      { statusCode: 401, responseCode: 'client_certificate_required' },
    );
    const activeCertificate = await executeClient(
      {
        name: 'ql3-run-retry-active-cert',
        target: managerPods[1],
        command: retry,
        bearer: identity.assertion(newKey),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 200, resultField: 'retry', resultStatus: ['existing'] },
    );

    const primaryBeforeFailover = currentPrimaryPod(fixture);
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'delete',
      'pod',
      primaryBeforeFailover.metadata.name,
      '--grace-period=0',
      '--force',
      '--wait=false',
    ]);
    const promoted = await waitFor(
      'CloudNativePG primary promotion',
      600_000,
      () => {
        const status = fixture.kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'cluster',
          POSTGRES_CLUSTER,
        ]).status;
        return status.currentPrimary &&
          status.currentPrimary !== primaryBeforeFailover.metadata.name &&
          Number(status.readyInstances) >= 2
          ? { ready: true, value: status.currentPrimary }
          : {
              ready: false,
              fact: `primary=${status.currentPrimary || 'none'} ready=${
                status.readyInstances ?? 0
              }`,
            };
      },
    );
    await waitFor('CloudNativePG recovery to three instances', 900_000, () => {
      const status = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'cluster',
        POSTGRES_CLUSTER,
      ]).status;
      return Number(status.readyInstances) === 3
        ? { ready: true, value: status }
        : {
            ready: false,
            fact: `${status.readyInstances ?? 0}/3 ready database instances`,
          };
    });

    const databaseService = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'service',
      POSTGRES_CLUSTER + '-rw',
    ]);
    const databaseSelector = databaseService.spec.selector;
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'patch',
      'service',
      POSTGRES_CLUSTER + '-rw',
      '--type=merge',
      '-p',
      JSON.stringify({
        spec: { selector: { ...databaseSelector, 'ql3.invalid': 'true' } },
      }),
    ]);
    const unavailable = await Promise.all(
      managerPods.map((pod, index) =>
        executeClient(
          {
            name: 'ql3-run-database-unavailable-' + String(index + 1),
            target: pod,
            command: stop,
            bearer: identity.assertion(newKey),
            clientCertificate: pkiMaterial.newClientCertificate,
            clientKey: pkiMaterial.newClientKey,
          },
          { statusCode: 503, responseCode: 'unavailable' },
        ),
      ),
    );
    assert.deepEqual(
      unavailable.map((entry) => entry.statusCode),
      [503, 503],
    );
    await waitFor('Run manager readiness withdrawal', 60_000, () => {
      const current = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'deployment',
        DEPLOYMENT,
      ]);
      return Number(current.status.readyReplicas ?? 0) === 0
        ? { ready: true, value: current }
        : {
            ready: false,
            fact: `${current.status.readyReplicas ?? 0} ready replicas`,
          };
    });
    assert.deepEqual(
      managerPods.map((pod) => healthStatus(fixture, pod, '/readyz')),
      [503, 503],
    );
    assert.deepEqual(
      managerPods.map((pod) => healthStatus(fixture, pod, '/livez')),
      [200, 200],
    );
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'patch',
      'service',
      POSTGRES_CLUSTER + '-rw',
      '--type=json',
      '-p',
      JSON.stringify([
        { op: 'replace', path: '/spec/selector', value: databaseSelector },
      ]),
    ]);
    await waitFor('restored CloudNativePG service endpoint', 120_000, () => {
      const endpoints = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'endpoints',
        POSTGRES_CLUSTER + '-rw',
      ]);
      const count = endpoints.subsets?.flatMap(
        (subset) => subset.addresses ?? [],
      ).length;
      return count >= 1
        ? { ready: true, value: count }
        : { ready: false, fact: `${count ?? 0} service endpoints` };
    });
    assert.deepEqual(
      managerPods.map((pod) => healthStatus(fixture, pod, '/readyz')),
      [503, 503],
    );
    const staleUids = new Set(managerPods.map((pod) => pod.metadata.uid));
    patchGeneration(fixture, '3-database-recovered');
    managerPods = await readyManagementPods({
      ...managerOptions(fixture),
      excludedUids: staleUids,
      expectedGeneration: '3-database-recovered',
    });
    const recoveredRequests = await Promise.all(
      managerPods.map((pod, index) =>
        executeClient(
          {
            name: 'ql3-run-database-recovered-' + String(index + 1),
            target: pod,
            command: stop,
            bearer: identity.assertion(newKey),
            clientCertificate: pkiMaterial.newClientCertificate,
            clientKey: pkiMaterial.newClientKey,
          },
          {
            statusCode: 200,
            resultField: 'stop',
            resultStatus: ['already_requested'],
          },
        ),
      ),
    );

    const finalPrimary = currentPrimaryPod(fixture);
    const durable = durableRunManagementFacts(
      fixture,
      finalPrimary.metadata.name,
      values,
      psql,
    );
    assert.deepEqual(durable, {
      sourceRunStatus: 'failed',
      retryRunCount: 1,
      retryAttemptCount: 1,
      retryEventCount: 2,
      stoppedRunCount: 1,
      stopEventCount: 1,
      allowedAuditCount: 2,
      deniedAuditCount: 1,
      weakAuthenticationAuditCount: 0,
      duplicateMutationCount: 0,
      identityGeneration: 3,
      migrationCount: 57,
      controlCoreCapability: 56,
      postgresVersionNumber: 180004,
    });
    const roleRows = JSON.parse(
      psql(
        fixture,
        finalPrimary.metadata.name,
        `SELECT json_agg(json_build_object('name', rolname, 'login', rolcanlogin, 'superuser', rolsuper, 'createDatabase', rolcreatedb, 'createRole', rolcreaterole, 'replication', rolreplication, 'bypassRls', rolbypassrls) ORDER BY rolname) FROM pg_roles WHERE rolname IN (${ROLE_NAMES.map(
          (role) => "'" + role + "'",
        ).join(',')})`,
      ),
    );
    const rolesLeastPrivilege = roleRows.every(
      (role) =>
        role.login === true &&
        role.superuser === false &&
        role.createDatabase === false &&
        role.createRole === false &&
        role.replication === false &&
        role.bypassRls === false,
    );
    assert.equal(rolesLeastPrivilege, true);
    const canI = (verb, resource) => {
      const result = fixture.kubectl(
        [
          'auth',
          'can-i',
          verb,
          resource,
          '-n',
          NAMESPACE,
          '--as=system:serviceaccount:' + NAMESPACE + ':' + DEPLOYMENT,
        ],
        { capture: true, quiet: true, allowFailure: true },
      );
      const decision = result.stdout.trim();
      assert.ok(decision === 'yes' || decision === 'no');
      assert.equal(result.status === 0, decision === 'yes');
      return decision;
    };
    assert.equal(canI('get', 'secrets'), 'no');
    assert.equal(canI('patch', 'deployments.apps'), 'no');

    const managerServiceIp = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'service',
      DEPLOYMENT,
    ]).spec.clusterIP;
    const networkProbe = {
      fixture,
      namespace: NAMESPACE,
      adminImage,
      appName: 'ql3-run-network-probe',
      networkPolicyLabel: 'qinglong.io/run-management-client',
    };
    const labelledClientAllowed = await clientTcpProbe({
      ...networkProbe,
      name: 'ql3-run-network-labelled',
      targetHost: managerServiceIp,
      port: 8448,
      labelled: true,
      expectedConnected: true,
    });
    const unlabelledClientDenied = await clientTcpProbe({
      ...networkProbe,
      name: 'ql3-run-network-unlabelled',
      targetHost: managerServiceIp,
      port: 8448,
      labelled: false,
      expectedConnected: false,
    });
    const wrongPortDenied = await clientTcpProbe({
      ...networkProbe,
      name: 'ql3-run-network-wrong-port',
      targetHost: managerServiceIp,
      port: 8447,
      labelled: true,
      expectedConnected: false,
    });
    const kubernetesServiceIp = fixture.kubectlJson([
      'get',
      'service',
      'kubernetes',
      '-n',
      'default',
    ]).spec.clusterIP;
    const postgresServiceIp = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'service',
      POSTGRES_CLUSTER + '-rw',
    ]).spec.clusterIP;
    const podProbe = {
      fixture,
      namespace: NAMESPACE,
      podName: managerPods[0].metadata.name,
    };
    const cloudNativePgEgressAllowed =
      podTcpProbe({ ...podProbe, host: postgresServiceIp, port: 5432 })
        .status === 0;
    const kubernetesApiEgressDenied =
      podTcpProbe({ ...podProbe, host: kubernetesServiceIp, port: 443 })
        .status !== 0;
    const publicInternetEgressDenied =
      podTcpProbe({ ...podProbe, host: '1.1.1.1', port: 443 }).status !== 0;
    assert.equal(cloudNativePgEgressAllowed, true);
    assert.equal(kubernetesApiEgressDenied, true);
    assert.equal(publicInternetEgressDenied, true);

    const finalNodes = fixture.kubectlJson(['get', 'nodes']).items;
    const cniReadyNodes = finalNodes.filter(
      (node) =>
        podReady(node) &&
        Array.isArray(node.spec.podCIDRs) &&
        node.spec.podCIDRs.length === 1,
    );
    assert.equal(cniReadyNodes.length, 3);
    assert.equal(
      new Set(cniReadyNodes.map((node) => node.spec.podCIDRs[0])).size,
      3,
    );
    const serverNode = finalNodes.find(
      (node) => node.metadata.name === fixture.server,
    );
    assert.equal(
      serverNode?.metadata.annotations?.[
        'flannel.alpha.coreos.com/backend-type'
      ],
      'vxlan',
    );
    assert.equal(
      serverNode?.metadata.annotations?.[
        'flannel.alpha.coreos.com/kube-subnet-manager'
      ],
      'true',
    );
    const finalCluster = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'cluster',
      POSTGRES_CLUSTER,
    ]);
    assert.equal(Number(finalCluster.status.readyInstances), 3);

    const baselineSuccesses = [
      retryAccepted,
      retryReplay,
      overlapOld,
      overlapNew,
      activeNew,
      activeCertificate,
    ];
    const report = {
      schemaVersion: 1,
      fixture: FIXTURE,
      observedAt: new Date().toISOString(),
      platform: {
        distribution: 'k3s',
        kubernetesVersion: nodes[0].status.nodeInfo.kubeletVersion,
        architecture,
        kubernetesImageId: imageIdDigest(k3sImageInfo),
        managementImageId: imageIdDigest(adminImageInfo),
        cniName: 'flannel',
        cniDistributionBinding: fixture.k3sImage,
        controlPlaneNodes: 1,
        workerNodes: 2,
        cniReadyNodes: cniReadyNodes.length,
      },
      database: {
        operator: 'cloudnative-pg',
        operatorVersion: LOCK.operator.version,
        postgresVersionNumber: durable.postgresVersionNumber,
        postgresImageId: imageIdDigest(postgresImageInfo),
        instances: Number(finalCluster.spec.instances),
        readyInstances: Number(finalCluster.status.readyInstances),
        managerRole: 'ql3_run_manager',
        migrationCount: durable.migrationCount,
        controlCoreCapability: durable.controlCoreCapability,
        tlsVerified: true,
        primaryChangedDuringFailover:
          promoted.value !== primaryBeforeFailover.metadata.name,
      },
      deployment: {
        namespace: NAMESPACE,
        service: DEPLOYMENT,
        port: 8448,
        replicas: deployment.spec.replicas,
        readyReplicas: managerPods.length,
        podIdentitySha256: managerPods.map((pod) => sha256(pod.metadata.uid)),
        nodeIdentitySha256: managerPods.map((pod) => sha256(pod.spec.nodeName)),
        serviceAccount: DEPLOYMENT,
        automountServiceAccountToken: false,
        requiredPodAntiAffinity: true,
        podDisruptionBudgetMinAvailable: 1,
        maxUnavailable: 0,
        maxConnectionsPerPod: 2,
      },
      client: {
        binary: 'ql3-run-client',
        operations: ['run.retry', 'run.stop'],
        inputKind: 'Secret',
        inputImmutable: true,
        callerDrivenJob: true,
        backoffLimit: 0,
        serviceAccountTokenMounted: false,
        rbacGranted: false,
        transportProtocol: 'TLSv1.3',
        mutualTls: true,
        servernameVerified: true,
        exactPodRequests: baselineSuccesses.length,
        retryStatuses: [
          retryAccepted.output.result.retry.status,
          retryReplay.output.result.retry.status,
          activeCertificate.output.result.retry.status,
        ],
        stopStatuses: [
          overlapOld.output.result.stop.status,
          overlapNew.output.result.stop.status,
          activeNew.output.result.stop.status,
        ],
        responseRedacted: true,
      },
      identityRotation: {
        overlapOldAssertionAccepted: overlapOld.statusCode === 200,
        overlapNewAssertionAccepted: overlapNew.statusCode === 200,
        revokedOldAssertionRejected: rejectedOldKey.statusCode === 401,
        activeNewAssertionAccepted: activeNew.statusCode === 200,
        rollbackSurgeFailedClosed: Boolean(rollback.value),
        twoReadyReplicasPreserved:
          generation2.minimumReady >= 2 && generation3.minimumReady >= 2,
        durableGenerationReachedThree: durable.identityGeneration === 3,
      },
      certificateRotation: {
        previousSerialSha256,
        currentSerialSha256: pki.newSerialSha256(),
        previousBundleSha256,
        currentBundleSha256,
        oldClientAcceptedBefore: retryAccepted.statusCode === 200,
        replacementClientAcceptedBefore: retryReplay.statusCode === 200,
        oldClientRejectedAfter: revokedCertificate.statusCode === 401,
        replacementClientAcceptedAfter: activeCertificate.statusCode === 200,
        fullPodReplacement: certificatePodsFullyReplaced,
        allReplicasReadyThroughout: certificateRollout.minimumReady >= 2,
      },
      availability: {
        databaseFailureWithdrewReadiness: true,
        databaseFailurePreservedLiveness: true,
        stalePodsDidNotRecoverInPlace: true,
        freshPodsRecoveredAfterDatabase: managerPods.every(
          (pod) => !staleUids.has(pod.metadata.uid),
        ),
        bothReplicasServedAfterRecovery: recoveredRequests.every(
          (entry) => entry.statusCode === 200,
        ),
      },
      isolation: {
        labelledClientAllowed,
        unlabelledClientDenied,
        wrongPortDenied,
        kubernetesApiEgressDenied,
        publicInternetEgressDenied,
        cloudNativePgEgressAllowed,
        managerSecretReadDenied: canI('get', 'secrets') === 'no',
        managerMutationRbacDenied: canI('patch', 'deployments.apps') === 'no',
      },
      durability: {
        sourceRunStatus: durable.sourceRunStatus,
        retryRunCount: durable.retryRunCount,
        retryAttemptCount: durable.retryAttemptCount,
        retryEventCount: durable.retryEventCount,
        stoppedRunCount: durable.stoppedRunCount,
        stopEventCount: durable.stopEventCount,
        allowedAuditCount: durable.allowedAuditCount,
        deniedAuditCount: durable.deniedAuditCount,
        duplicateMutationCount: durable.duplicateMutationCount,
        identityGeneration: durable.identityGeneration,
        weakAuthenticationAuditCount: durable.weakAuthenticationAuditCount,
        survivedCloudNativePgFailover: true,
      },
      gates: {
        realThreeNodeKubernetes: nodes.length === 3,
        realCniPolicy:
          labelledClientAllowed &&
          unlabelledClientDenied &&
          wrongPortDenied &&
          kubernetesApiEgressDenied &&
          publicInternetEgressDenied &&
          cloudNativePgEgressAllowed,
        threeInstanceCloudNativePg: databasePods.length === 3,
        twoManagerPodsOnDistinctNodes:
          new Set(managerPods.map((pod) => pod.spec.nodeName)).size === 2,
        tls13ProductClientAcrossBothPods:
          new Set(baselineSuccesses.map((entry) => entry.targetPod)).size >= 2,
        strongUserRetryAndStop:
          weakRejected.statusCode === 401 &&
          outsiderDenied.statusCode === 403 &&
          retryAccepted.statusCode === 200 &&
          overlapOld.statusCode === 200,
        identityProjectionRotation: durable.identityGeneration === 3,
        certificateRevocationRollout: revokedCertificate.statusCode === 401,
        databaseReadinessFence: true,
        durableFactsSurvivedFailover: true,
        leastPrivilege: rolesLeastPrivilege,
        passed: true,
      },
      limitations: [...LIMITATIONS],
    };
    const audit = validateRunManagementKubernetesLiveReport(report);
    assert.deepEqual(audit.findings, []);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    process.stdout.write(
      JSON.stringify({
        schemaVersion: 1,
        fixture: FIXTURE,
        reportWritten: true,
        passed: true,
      }) + '\n',
    );
  } finally {
    await fixture.cleanup();
    if (adminImageBuilt) {
      run(fixture.docker, ['image', 'rm', '-f', adminImage], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
    if (controlImageBuilt) {
      run(fixture.docker, ['image', 'rm', '-f', controlImage], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      'QL3 Run management Kubernetes live contract failed: ' +
        (error instanceof Error
          ? error.stack || error.message
          : String(error)) +
        '\n',
    );
    process.exitCode = 1;
  });
}

module.exports = {
  identity,
  retryCommand,
  stopCommand,
};
