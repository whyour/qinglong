const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  FIXTURE,
  LIMITATIONS,
  validateApprovalManagementKubernetesLiveReport,
} = require('../../scripts/ql3-approval-management-kubernetes-live-audit.cjs');

function digest(character) {
  return 'sha256:' + character.repeat(64);
}

function validReport() {
  return {
    schemaVersion: 1,
    fixture: FIXTURE,
    observedAt: '2026-08-10T12:00:00.000Z',
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
      managerRole: 'ql3_approval_manager',
      migrationCount: 54,
      controlCoreCapability: 53,
      tlsVerified: true,
      primaryChangedDuringFailover: true,
    },
    deployment: {
      namespace: 'qinglong3-system',
      service: 'ql3-approval-management',
      port: 8447,
      replicas: 2,
      readyReplicas: 2,
      podIdentitySha256: [digest('4'), digest('5')],
      nodeIdentitySha256: [digest('6'), digest('7')],
      serviceAccount: 'ql3-approval-management',
      automountServiceAccountToken: false,
      requiredPodAntiAffinity: true,
      podDisruptionBudgetMinAvailable: 1,
      maxUnavailable: 0,
      maxConnectionsPerPod: 2,
    },
    client: {
      binary: 'ql3-approval-client',
      operations: ['approval.inspect', 'approval.decide'],
      inputKind: 'Secret',
      inputImmutable: true,
      callerDrivenJob: true,
      backoffLimit: 0,
      serviceAccountTokenMounted: false,
      rbacGranted: false,
      transportProtocol: 'TLSv1.3',
      mutualTls: true,
      servernameVerified: true,
      exactPodRequests: 5,
      inspectStatuses: ['found', 'found', 'found'],
      decisionStatuses: ['decided', 'existing'],
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
      approvalVersion: 2,
      approvalState: 'approved',
      decisionIdSha256: digest('c'),
      allowedAuditCount: 4,
      deniedAuditCount: 1,
      duplicateDecisionCount: 0,
      identityGeneration: 3,
      survivedCloudNativePgFailover: true,
    },
    gates: {
      realThreeNodeKubernetes: true,
      realCniPolicy: true,
      threeInstanceCloudNativePg: true,
      twoManagerPodsOnDistinctNodes: true,
      tls13ProductClientAcrossBothPods: true,
      strongUserDecision: true,
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
  return validateApprovalManagementKubernetesLiveReport(report);
}

test('accepts the exact content-free Kubernetes approval live report', () => {
  assert.deepEqual(
    validateApprovalManagementKubernetesLiveReport(validReport()),
    {
      schemaVersion: 1,
      fixture: FIXTURE,
      findings: [],
      compatible: true,
    },
  );
});

test('rejects topology, migration and approval deployment weakening', () => {
  for (const [code, change] of [
    [
      'QL3_APPROVAL_KUBERNETES_LIVE_PLATFORM',
      (report) => {
        report.platform.workerNodes = 1;
      },
    ],
    [
      'QL3_APPROVAL_KUBERNETES_LIVE_DATABASE',
      (report) => {
        report.database.migrationCount = 52;
      },
    ],
    [
      'QL3_APPROVAL_KUBERNETES_LIVE_DEPLOYMENT',
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
      'QL3_APPROVAL_KUBERNETES_LIVE_CLIENT',
      (report) => {
        report.client.rbacGranted = true;
      },
    ],
    [
      'QL3_APPROVAL_KUBERNETES_LIVE_IDENTITY_ROTATION',
      (report) => {
        report.identityRotation.revokedOldAssertionRejected = false;
      },
    ],
    [
      'QL3_APPROVAL_KUBERNETES_LIVE_CERTIFICATE_ROTATION',
      (report) => {
        report.certificateRotation.fullPodReplacement = false;
      },
    ],
    [
      'QL3_APPROVAL_KUBERNETES_LIVE_AVAILABILITY',
      (report) => {
        report.availability.stalePodsDidNotRecoverInPlace = false;
      },
    ],
  ]) {
    assert.ok(mutate(change).findings.some((entry) => entry.code === code));
  }
});

test('rejects incomplete isolation and durable approval drift', () => {
  assert.ok(
    mutate((report) => {
      report.isolation.publicInternetEgressDenied = false;
    }).findings.some(
      ({ code }) => code === 'QL3_APPROVAL_KUBERNETES_LIVE_ISOLATION',
    ),
  );
  assert.ok(
    mutate((report) => {
      report.durability.approvalVersion = 1;
    }).findings.some(
      ({ code }) => code === 'QL3_APPROVAL_KUBERNETES_LIVE_DURABILITY',
    ),
  );
});

test('rejects secret material, widened schema, false gates and hidden limitations', () => {
  for (const [code, change] of [
    [
      'QL3_APPROVAL_KUBERNETES_LIVE_SECRET_EXPOSURE',
      (report) => {
        report.client.assertion =
          'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJvcGVyYXRvciJ9.signature0123456789';
      },
    ],
    [
      'QL3_APPROVAL_KUBERNETES_LIVE_REPORT_SHAPE',
      (report) => {
        report.debug = true;
      },
    ],
    [
      'QL3_APPROVAL_KUBERNETES_LIVE_GATES',
      (report) => {
        report.gates.passed = false;
      },
    ],
    [
      'QL3_APPROVAL_KUBERNETES_LIVE_LIMITATIONS',
      (report) => {
        report.limitations = [];
      },
    ],
  ]) {
    assert.ok(mutate(change).findings.some((entry) => entry.code === code));
  }
});
