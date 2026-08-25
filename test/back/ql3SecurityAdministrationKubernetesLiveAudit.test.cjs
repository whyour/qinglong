const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  FIXTURE,
  LIMITATIONS,
  validateSecurityAdministrationKubernetesLiveReport,
} = require('../../scripts/ql3-security-administration-kubernetes-live-audit.cjs');

const digest = (value) => `sha256:${value.repeat(64)}`;

function report() {
  return {
    schemaVersion: 1,
    fixture: FIXTURE,
    observedAt: '2026-08-25T04:00:00.000Z',
    platform: {
      distribution: 'k3s',
      kubernetesVersion: 'v1.34.3+k3s1',
      architecture: 'amd64',
      kubernetesImageId: digest('1'),
      administrationImageId: digest('2'),
      controlImageId: digest('4'),
      cniName: 'flannel',
      cniDistributionBinding: 'rancher/k3s:v1.34.3-k3s1',
      controlPlaneNodes: 1,
      workerNodes: 2,
      readyNodes: 3,
    },
    database: {
      operator: 'cloudnative-pg',
      operatorVersion: '1.30.0',
      postgresVersionNumber: 180004,
      postgresImageId: digest('3'),
      instances: 3,
      readyInstances: 3,
      administrationRole: 'ql3_admin',
      roleConnectionLimit: 4,
      commandConnectionLimit: 1,
      migrationCount: 71,
      controlCoreCapability: 70,
      tlsVerified: true,
      leastPrivilege: true,
    },
    ceremony: {
      operations: [
        'identity.register',
        'audit.list',
        'credential.issue.old',
        'credential.issue.old.replay',
        'credential.key-references.before-activate',
        'credential.issue.new',
        'credential.rotate.new',
        'credential.key-references.after-activate',
        'credential.revoke.old',
        'credential.key-references.after-converge',
      ],
      completedJobs: 10,
      failedJobs: 1,
      authenticationProbeJobs: 5,
      controlReplicas: 2,
      controlRollouts: 3,
      controlReplicaAntiAffinity: true,
      callerDriven: true,
      backoffLimit: 0,
      activeDeadlineSeconds: 300,
      ttlSecondsAfterFinished: 600,
      serviceAccount: 'ql3-security-administration',
      serviceAccountTokenMounted: false,
      rbacGranted: false,
      responseLossReplayObserved: true,
      overlapGenerationCount: 2,
      contractedGenerationCount: 1,
      activeGenerationChanged: true,
      oldReferencesBeforeActivation: 1,
      oldReferencesAfterActivation: 1,
      oldReferencesAfterConvergence: 0,
      oldAuthenticationBeforeActivation: true,
      oldAuthenticationDuringOverlap: true,
      newAuthenticationDuringOverlap: true,
      oldAuthenticationRejectedAfterConvergence: true,
      newAuthenticationAfterContraction: true,
      contractedToActiveGeneration: true,
      sensitiveMaterialReported: false,
    },
    inputBoundary: {
      immutableSecret: true,
      projectedMode0440: true,
      memoryBackedPrivateStage: true,
      targetDirectoryMode0700: true,
      targetFilesMode0600: true,
      kubeletAtomicWriterProjectionAccepted: true,
      worldReadableProjectionRejected: true,
      mainContainerNotStartedAfterStageFailure: true,
    },
    deliveryCustody: {
      persistentVolumeClaim: true,
      accessMode: 'ReadWriteOnce',
      fixtureRootProvisioned: true,
      fixtureRootMode: '2770',
      fixtureProvisionerRanAsRoot: true,
      privateDirectoryMode: '0700',
      fileMode: '0600',
      fileCount: 3,
      issueDigest: digest('4'),
      rotationDigest: digest('5'),
      distinctRotationMaterial: true,
      persistentAcrossJobs: true,
      noReplaceReplayPreserved: true,
      deliverySchemaValidated: true,
      bearerFormatValidatedInPod: true,
      sensitiveMaterialReported: false,
    },
    isolation: {
      dnsAndDatabaseEgressAllowed: true,
      kubernetesApiEgressDenied: true,
      publicInternetEgressDenied: true,
      secretReadRbacDenied: true,
      jobMutationRbacDenied: true,
    },
    durability: {
      identityVersion: 1,
      identityStatus: 'active',
      oldCredentialVersion: 2,
      oldCredentialState: 'revoked',
      newCredentialVersion: 2,
      newCredentialState: 'active',
      identityMutationCount: 1,
      credentialMutationCount: 4,
      issueMutationCount: 1,
      credentialVersionCount: 4,
      oldGenerationVersionCount: 1,
      newGenerationVersionCount: 3,
      latestGenerationsAreNew: true,
      allowedAuditCount: 5,
      authenticationDeniedAuditCount: 4,
      authenticationRejectedAuditCount: 1,
    },
    cleanup: {
      jobsDeleted: true,
      inputSecretsDeleted: true,
      evidenceJobsDeleted: true,
      storageProvisionJobDeleted: true,
      deliveryVolumeClaimDeleted: true,
      controlDeploymentDeleted: true,
      controlServiceDeleted: true,
      controlRuntimeSecretDeleted: true,
    },
    gates: {
      realThreeNodeKubernetes: true,
      realCloudNativePg: true,
      realKubeletSecretProjection: true,
      realAdministrationProductCommands: true,
      realPersistentCredentialCustody: true,
      realClusterControlAuthenticationRotation: true,
      responseLossReplay: true,
      failedInputStageClosed: true,
      leastPrivilege: true,
      contentFreeEvidence: true,
      passed: true,
    },
    limitations: [...LIMITATIONS],
  };
}

test('accepts the exact content-free Security Administration live report', () => {
  const result = validateSecurityAdministrationKubernetesLiveReport(report());
  assert.equal(result.compatible, true);
  assert.deepEqual(result.findings, []);
});

test('rejects widened authority, false custody and replay duplication', () => {
  const candidate = report();
  candidate.ceremony.serviceAccountTokenMounted = true;
  candidate.deliveryCustody.noReplaceReplayPreserved = false;
  candidate.durability.issueMutationCount = 2;
  candidate.ceremony.oldReferencesAfterConvergence = 1;
  candidate.gates.passed = false;
  const codes = validateSecurityAdministrationKubernetesLiveReport(
    candidate,
  ).findings.map((finding) => finding.code);
  assert.ok(
    codes.includes('QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_CEREMONY'),
  );
  assert.ok(
    codes.includes('QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_DELIVERY'),
  );
  assert.ok(
    codes.includes('QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_DURABILITY'),
  );
  assert.ok(codes.includes('QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_GATES'));
});

test('rejects any credential or assertion material in evidence', () => {
  const candidate = report();
  candidate.deliveryCustody.proof = {
    token: 'ql3c_example_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const result = validateSecurityAdministrationKubernetesLiveReport(candidate);
  assert.equal(result.compatible, false);
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.code ===
        'QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE_MATERIAL_EXPOSURE',
    ),
  );
});
