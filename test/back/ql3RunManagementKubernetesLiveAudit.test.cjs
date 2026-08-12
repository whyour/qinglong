const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  FIXTURE,
  LIMITATIONS,
  validateRunManagementKubernetesLiveReport,
} = require('../../scripts/ql3-run-management-kubernetes-live-audit.cjs');

function digest(character) {
  return 'sha256:' + character.repeat(64);
}

function validReport() {
  return {
    schemaVersion: 1,
    fixture: FIXTURE,
    observedAt: '2026-08-12T12:00:00.000Z',
    platform: {
      distribution: 'k3s',
      kubernetesVersion: 'v1.34.3+k3s1',
      architecture: 'arm64',
      kubernetesImageId: digest('1'),
      managementImageId: digest('2'),
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
      postgresImageId: digest('3'),
      instances: 3,
      readyInstances: 3,
      managerRole: 'ql3_run_manager',
      migrationCount: 57,
      controlCoreCapability: 56,
      tlsVerified: true,
      primaryChangedDuringFailover: true,
    },
    deployment: {
      namespace: 'qinglong3-system',
      service: 'ql3-run-management',
      port: 8448,
      replicas: 2,
      readyReplicas: 2,
      podIdentitySha256: [digest('4'), digest('5')],
      nodeIdentitySha256: [digest('6'), digest('7')],
      serviceAccount: 'ql3-run-management',
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
      exactPodRequests: 6,
      retryStatuses: ['accepted', 'existing', 'existing'],
      stopStatuses: ['accepted', 'already_requested', 'already_requested'],
      responseRedacted: true,
    },
    identityRotation: {
      overlapOldAssertionAccepted: true,
      overlapNewAssertionAccepted: true,
      revokedOldAssertionRejected: true,
      activeNewAssertionAccepted: true,
      rollbackSurgeFailedClosed: true,
      twoReadyReplicasPreserved: true,
      durableGenerationReachedThree: true,
    },
    certificateRotation: {
      previousSerialSha256: digest('8'),
      currentSerialSha256: digest('9'),
      previousBundleSha256: digest('a'),
      currentBundleSha256: digest('b'),
      oldClientAcceptedBefore: true,
      replacementClientAcceptedBefore: true,
      oldClientRejectedAfter: true,
      replacementClientAcceptedAfter: true,
      fullPodReplacement: true,
      allReplicasReadyThroughout: true,
    },
    availability: {
      databaseFailureWithdrewReadiness: true,
      databaseFailurePreservedLiveness: true,
      stalePodsDidNotRecoverInPlace: true,
      freshPodsRecoveredAfterDatabase: true,
      bothReplicasServedAfterRecovery: true,
    },
    isolation: {
      labelledClientAllowed: true,
      unlabelledClientDenied: true,
      wrongPortDenied: true,
      kubernetesApiEgressDenied: true,
      publicInternetEgressDenied: true,
      cloudNativePgEgressAllowed: true,
      managerSecretReadDenied: true,
      managerMutationRbacDenied: true,
    },
    durability: {
      sourceRunStatus: 'failed',
      retryRunCount: 1,
      retryAttemptCount: 1,
      retryEventCount: 2,
      stoppedRunCount: 1,
      stopEventCount: 1,
      allowedAuditCount: 2,
      deniedAuditCount: 1,
      duplicateMutationCount: 0,
      identityGeneration: 3,
      weakAuthenticationAuditCount: 0,
      survivedCloudNativePgFailover: true,
    },
    gates: {
      realThreeNodeKubernetes: true,
      realCniPolicy: true,
      threeInstanceCloudNativePg: true,
      twoManagerPodsOnDistinctNodes: true,
      tls13ProductClientAcrossBothPods: true,
      strongUserRetryAndStop: true,
      identityProjectionRotation: true,
      certificateRevocationRollout: true,
      databaseReadinessFence: true,
      durableFactsSurvivedFailover: true,
      leastPrivilege: true,
      passed: true,
    },
    limitations: [...LIMITATIONS],
  };
}

function mutate(change) {
  const report = structuredClone(validReport());
  change(report);
  return validateRunManagementKubernetesLiveReport(report);
}

test('accepts the exact content-free Run management Kubernetes report', () => {
  assert.deepEqual(validateRunManagementKubernetesLiveReport(validReport()), {
    schemaVersion: 1,
    fixture: FIXTURE,
    findings: [],
    compatible: true,
  });
});

test('rejects topology, schema and deployment weakening', () => {
  for (const [code, change] of [
    [
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_PLATFORM',
      (report) => {
        report.platform.workerNodes = 1;
      },
    ],
    [
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_DATABASE',
      (report) => {
        report.database.controlCoreCapability = 55;
      },
    ],
    [
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_DEPLOYMENT',
      (report) => {
        report.deployment.nodeIdentitySha256[1] =
          report.deployment.nodeIdentitySha256[0];
      },
    ],
  ]) {
    assert.ok(mutate(change).findings.some((entry) => entry.code === code));
  }
});

test('rejects widened client, incomplete rotations and false availability', () => {
  for (const [code, change] of [
    [
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_CLIENT',
      (report) => {
        report.client.rbacGranted = true;
      },
    ],
    [
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_IDENTITY_ROTATION',
      (report) => {
        report.identityRotation.revokedOldAssertionRejected = false;
      },
    ],
    [
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_CERTIFICATE_ROTATION',
      (report) => {
        report.certificateRotation.fullPodReplacement = false;
      },
    ],
    [
      'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_AVAILABILITY',
      (report) => {
        report.availability.stalePodsDidNotRecoverInPlace = false;
      },
    ],
  ]) {
    assert.ok(mutate(change).findings.some((entry) => entry.code === code));
  }
});

test('rejects incomplete isolation, durable drift and secret-shaped content', () => {
  assert.ok(
    mutate((report) => {
      report.isolation.publicInternetEgressDenied = false;
    }).findings.some(
      (entry) => entry.code === 'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_ISOLATION',
    ),
  );
  assert.ok(
    mutate((report) => {
      report.durability.retryRunCount = 2;
    }).findings.some(
      (entry) => entry.code === 'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_DURABILITY',
    ),
  );
  assert.ok(
    mutate((report) => {
      report.client.token =
        'eyJ0123456789012345.eyJ0123456789012345.abc0123456789012345';
    }).findings.some(
      (entry) =>
        entry.code === 'QL3_RUN_MANAGEMENT_KUBERNETES_LIVE_SECRET_EXPOSURE',
    ),
  );
});

module.exports = { validReport };
