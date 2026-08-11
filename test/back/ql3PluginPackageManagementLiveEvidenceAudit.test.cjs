const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  validatePluginPackageManagementLiveEvidence,
} = require('../../scripts/ql3-plugin-package-management-live-evidence-audit.cjs');

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function validReport() {
  return {
    schemaVersion: 1,
    fixture: 'qinglong/plugin-package-management-live-evidence@v1',
    observedAt: '2026-07-25T12:00:00.000Z',
    platform: {
      kubernetesVersion: 'v1.34.2',
      architecture: 'arm64',
      managementImageId: digest('1'),
      postgresVersionNumber: 180004,
      postgresImageId: digest('2'),
      cniName: 'cilium',
      cniVersion: '1.17.1',
      controlPlaneNodes: 3,
      workerNodes: 2,
    },
    deployment: {
      namespace: 'qinglong3-system',
      service: 'ql3-plugin-package-management',
      replicas: 2,
      readyReplicas: 2,
      podIdentitySha256: [digest('3'), digest('4')],
      nodeIdentitySha256: [digest('5'), digest('6')],
      serviceAccount: 'ql3-plugin-package-management',
      automountServiceAccountToken: false,
      databaseRole: 'ql3_package_manager',
      migrationCount: 25,
      controlCoreCapability: 24,
      tableCount: 38,
    },
    identity: {
      providerKind: 'external_oidc',
      issuer: 'https://login.example.com/',
      discoveryDocumentSha256: digest('7'),
      jwksSha256: digest('8'),
      audience: 'qinglong3-package-management',
      requesterSubjectSha256: digest('9'),
      reviewerSubjectSha256: digest('a'),
      requesterAssurance: 'multi_factor',
      reviewerAssurance: 'hardware',
      keysetGenerations: [7, 8, 9],
      finalLedgerGeneration: 9,
      finalRevokedKeyCount: 2,
    },
    ceremony: {
      requesterProposeAccepted: true,
      requesterSelfDecisionRejected: true,
      reviewerDecisionAccepted: true,
      requesterAndReviewerDistinct: true,
      inspectionAuthorized: true,
      durableAuditObserved: true,
    },
    isolation: {
      labelledClientAllowed: true,
      unlabelledClientDenied: true,
      wrongPortDenied: true,
      kubernetesApiEgressDenied: true,
      publicInternetEgressDenied: true,
      postgresEgressAllowed: true,
      managerSecretReadDenied: true,
      managerExecutorMutationDenied: true,
    },
    rotation: {
      overlapOldAssertionAccepted: true,
      newAssertionAccepted: true,
      revokedOldAssertionRejected: true,
      previousTlsSerialSha256: digest('b'),
      currentTlsSerialSha256: digest('c'),
      previousTlsSecretVersionSha256: digest('d'),
      currentTlsSecretVersionSha256: digest('e'),
      allReplicasReadyThroughout: true,
      tls13BeforeAndAfter: true,
    },
    gates: {
      externalIdentity: true,
      separationOfDuty: true,
      twoReplicaAvailability: true,
      networkPolicy: true,
      keysetRotation: true,
      tlsRotation: true,
      leastPrivilege: true,
      schema: true,
      passed: true,
    },
  };
}

function mutate(change) {
  const report = structuredClone(validReport());
  change(report);
  return validatePluginPackageManagementLiveEvidence(report);
}

test('accepts only the exact low-sensitive real management evidence envelope', () => {
  assert.deepEqual(validatePluginPackageManagementLiveEvidence(validReport()), {
    schemaVersion: 1,
    fixture: 'qinglong/plugin-package-management-live-evidence@v1',
    findings: [],
    compatible: true,
  });
  assert.equal(
    mutate((report) => {
      report.platform.kubernetesVersion = 'v1.34.2-eks-1-34-2';
    }).compatible,
    true,
  );
  assert.ok(
    mutate((report) => {
      report.platform.kubernetesVersion = 'v1.34.2-';
    }).findings.some(
      ({ code }) => code === 'QL3_PLUGIN_MANAGEMENT_LIVE_PLATFORM',
    ),
  );
});

test('rejects fixture issuers and non-distinct or weak user identity', () => {
  for (const result of [
    mutate((report) => {
      report.identity.issuer = 'https://identity.example.test/';
    }),
    mutate((report) => {
      report.identity.reviewerSubjectSha256 =
        report.identity.requesterSubjectSha256;
    }),
    mutate((report) => {
      report.identity.requesterAssurance = 'single_factor';
    }),
  ]) {
    assert.equal(result.compatible, false);
    assert.ok(
      result.findings.some(
        ({ code }) => code === 'QL3_PLUGIN_MANAGEMENT_LIVE_IDENTITY',
      ),
    );
  }
});

test('rejects weak topology, stale schema and incomplete isolation', () => {
  assert.ok(
    mutate((report) => {
      report.platform.controlPlaneNodes = 1;
    }).findings.some(
      ({ code }) => code === 'QL3_PLUGIN_MANAGEMENT_LIVE_PLATFORM',
    ),
  );
  assert.ok(
    mutate((report) => {
      report.deployment.controlCoreCapability = 22;
    }).findings.some(
      ({ code }) => code === 'QL3_PLUGIN_MANAGEMENT_LIVE_DEPLOYMENT',
    ),
  );
  assert.ok(
    mutate((report) => {
      report.isolation.publicInternetEgressDenied = false;
    }).findings.some(
      ({ code }) => code === 'QL3_PLUGIN_MANAGEMENT_LIVE_ISOLATION',
    ),
  );
});

test('rejects incomplete ceremony, non-rotating TLS and false summary gates', () => {
  assert.ok(
    mutate((report) => {
      report.ceremony.requesterSelfDecisionRejected = false;
    }).findings.some(
      ({ code }) => code === 'QL3_PLUGIN_MANAGEMENT_LIVE_CEREMONY',
    ),
  );
  assert.ok(
    mutate((report) => {
      report.rotation.currentTlsSerialSha256 =
        report.rotation.previousTlsSerialSha256;
    }).findings.some(
      ({ code }) => code === 'QL3_PLUGIN_MANAGEMENT_LIVE_ROTATION',
    ),
  );
  assert.ok(
    mutate((report) => {
      report.gates.passed = false;
    }).findings.some(({ code }) => code === 'QL3_PLUGIN_MANAGEMENT_LIVE_GATES'),
  );
});

test('rejects any assertion, token, credential or private material', () => {
  const result = mutate((report) => {
    report.token = 'must-not-enter-evidence';
  });
  assert.equal(result.compatible, false);
  assert.ok(
    result.findings.some(
      ({ code }) => code === 'QL3_PLUGIN_MANAGEMENT_LIVE_SECRET_EXPOSURE',
    ),
  );
});
