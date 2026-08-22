const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AI_MIGRATION_COUNT,
  FIXTURE,
  LIMITATIONS,
  validateProviderCredentialTestKubernetesLiveReport,
} = require('../../scripts/ql3-provider-credential-test-kubernetes-live-audit.cjs');

const sha = (value) => `sha256:${value.repeat(64)}`;

function report() {
  return {
    schemaVersion: 1,
    fixture: FIXTURE,
    observedAt: '2026-08-03T12:00:00.000Z',
    platform: {
      distribution: 'k3s',
      kubernetesVersion: 'v1.34.3+k3s1',
      architecture: 'arm64',
      kubernetesImageId: sha('1'),
      adminImageId: sha('2'),
      cniName: 'flannel',
      cniDistributionBinding: 'rancher/k3s:v1.34.3-k3s1',
      controlPlaneNodes: 1,
      workerNodes: 2,
      cniReadyNodes: 3,
    },
    database: {
      operator: 'cloudnative-pg',
      operatorVersion: '1.30.0',
      postgresVersionNumber: 180004,
      postgresImageId: sha('3'),
      instances: 3,
      readyInstances: 3,
      managerRole: 'ql3_ai_credential_manager',
      testerRole: 'ql3_ai_credential_tester',
      migrationCount: 54,
      aiMigrationCount: AI_MIGRATION_COUNT,
      tlsVerified: true,
      primaryChangedDuringFailover: true,
    },
    provider: {
      protocol: 'HTTPS',
      service: 'ql3-provider-live',
      port: 8443,
      replicas: 1,
      initialPodIdentitySha256: sha('4'),
      rotatedPodIdentitySha256: sha('5'),
      caSha256: sha('6'),
      modelCount: 2,
      requestCount: 5,
      materialGenerationCount: 2,
      exactPrivateCidrPolicy: true,
    },
    executor: {
      binary: 'ql3-provider-credential-test-execute',
      callerDrivenJobs: true,
      jobsRun: 8,
      backoffLimit: 0,
      activeDeadlineSeconds: 60,
      ttlSecondsAfterFinished: 300,
      serviceAccount: 'ql3-provider-credential-test-executor',
      serviceAccountTokenMounted: false,
      rbacGranted: false,
      poolMaxConnections: 1,
      responseRedacted: true,
      outcomes: {
        baseDenied: 'unreachable',
        exactAllowed: 'reachable',
        exactReplay: 'reachable',
        postFailover: 'reachable',
        refreshedCidr: 'reachable',
        rotatedMaterial: 'reachable',
        staleCidr: 'unreachable',
        staleMaterial: 'unreachable',
      },
    },
    rotation: {
      newPodObservedNewProjection: true,
      oldMaterialRejectedAfterRotation: true,
      projectedMaterialReresolved: true,
      providerPodReplaced: true,
      staleCidrFailedClosed: true,
    },
    isolation: {
      baseProviderEgressDenied: true,
      cloudNativePgEgressAllowed: true,
      exactProviderEgressAllowed: true,
      kubernetesApiEgressDenied: true,
      managerMountedNoProviderMaterial: true,
      publicInternetEgressDenied: true,
      staleProviderCidrDenied: true,
      testerMutationRbacDenied: true,
    },
    durability: {
      planCount: 7,
      executionCount: 7,
      resultCount: 7,
      credentialUseAuditCount: 5,
      planAuditCount: 7,
      reachableCount: 4,
      unreachableCount: 3,
      providerRequestCount: 5,
      replayDuplicateCount: 0,
      survivedCloudNativePgFailover: true,
    },
    gates: {
      contentFreeEvidence: true,
      durableFactsSurvivedFailover: true,
      exactPrivateProviderEgress: true,
      leastPrivilege: true,
      passed: true,
      projectedMaterialRotation: true,
      realCniPolicy: true,
      realThreeNodeKubernetes: true,
      eightOneShotJobs: true,
      threeInstanceCloudNativePg: true,
    },
    limitations: [...LIMITATIONS],
  };
}

test('accepts the exact content-free credential test Kubernetes report', () => {
  const result = validateProviderCredentialTestKubernetesLiveReport(report());
  assert.deepEqual(result.findings, []);
  assert.equal(result.compatible, true);
});

test('rejects widened, false and sensitive reports', () => {
  const widened = report();
  widened.extra = true;
  assert.ok(
    validateProviderCredentialTestKubernetesLiveReport(widened).findings.some(
      ({ code }) =>
        code === 'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_REPORT_SHAPE',
    ),
  );

  const falseGate = report();
  falseGate.gates.passed = false;
  assert.ok(
    validateProviderCredentialTestKubernetesLiveReport(falseGate).findings.some(
      ({ code }) =>
        code === 'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_GATES',
    ),
  );

  const sensitive = report();
  sensitive.executor.token = 'provider-value';
  assert.ok(
    validateProviderCredentialTestKubernetesLiveReport(sensitive).findings.some(
      ({ code }) =>
        code === 'QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_SENSITIVE',
    ),
  );
});

test('rejects incomplete network, rotation and durability evidence', () => {
  const value = report();
  value.isolation.staleProviderCidrDenied = false;
  value.rotation.projectedMaterialReresolved = false;
  value.durability.providerRequestCount = 4;
  const codes = new Set(
    validateProviderCredentialTestKubernetesLiveReport(value).findings.map(
      ({ code }) => code,
    ),
  );
  assert.equal(
    codes.has('QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_ISOLATION'),
    true,
  );
  assert.equal(
    codes.has('QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_ROTATION'),
    true,
  );
  assert.equal(
    codes.has('QL3_PROVIDER_CREDENTIAL_TEST_KUBERNETES_LIVE_DURABILITY'),
    true,
  );
});
