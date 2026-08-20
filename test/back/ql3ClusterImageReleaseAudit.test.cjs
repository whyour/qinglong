'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  auditClusterImageCiWorkflow,
  auditClusterImageRelease,
  auditReleaseWorkflow,
} = require('../../scripts/ql3-cluster-image-release-audit.cjs');

const root = path.resolve(__dirname, '../..');
const ciSource = fs.readFileSync(
  path.join(root, '.github/workflows/ql3-ci.yml'),
  'utf8',
);
const releaseSource = fs.readFileSync(
  path.join(root, '.github/workflows/ql3-image-release.yml'),
  'utf8',
);

test('accepts the reviewed native CI and digest release contracts', () => {
  assert.deepEqual(auditClusterImageRelease(root), {
    ci: {
      images: ['control', 'control-ai', 'admin', 'local', 'worker'],
      nativeArchitectures: ['amd64', 'arm64'],
      runtimeInventory: true,
      clusterAdminProductFacade: true,
      clusterAdminOperatorContext: true,
      clusterAdminContextPreflight: true,
      clusterAdminContextReadiness: true,
      clusterCopilotConsoleCapacityEvidence: {
        nativeArchitectures: ['x64', 'arm64'],
        memoryLimitMiB: 192,
        minimumHeadroomMiB: 32,
        assertionRotation: true,
        assertionExpiryRejected: true,
        sourceBound: true,
      },
      releaseVersionAudit: true,
      deploymentLockMaterialization: true,
      ociAttestations: true,
      osVulnerabilityScan: {
        scanner: 'trivy@0.70.0',
        severities: ['HIGH', 'CRITICAL'],
        packageTypes: ['os'],
        ignoreUnfixed: false,
      },
    },
    release: {
      trigger: 'explicit protected v3 tag dispatch',
      releaseCandidateContract: {
        scopes: ['local', 'cluster', 'all'],
        workspacePackages: 18,
        sourceDerived: true,
        digestAttested: true,
        localClusterEvidenceRequired: false,
        clusterPrivateEvidenceRequired: true,
      },
      workerManagementEvidence: {
        sourceAware: true,
        privateEphemeralRunner: true,
        maximumAgeSeconds: 86400,
        privateReportUpload: false,
        contentFreeReceiptPublished: true,
      },
      cloudNativePgDisasterRecoveryEvidence: {
        sourceAware: true,
        privateEphemeralRunner: true,
        maximumAgeSeconds: 86400,
        privateReportUpload: false,
        contentFreeReceiptPublished: true,
        staticLocksReaudited: true,
      },
      osVulnerabilityScan: {
        scanner: 'trivy@0.70.0',
        actionCommit: 'ed142fd0673e97e23eac54620cfb913e5ce36c25',
        platforms: ['linux/amd64', 'linux/arm64'],
        severities: ['HIGH', 'CRITICAL'],
        packageTypes: ['os'],
        ignoreUnfixed: false,
        maximumExceptionDays: 30,
        buildOnce: true,
        immutableArtifactRetentionDays: 1,
        attestedToPublishedDigest: true,
      },
      images: ['control', 'control-ai', 'admin', 'worker', 'local'],
      platforms: ['linux/amd64', 'linux/arm64'],
      keylessSignature: true,
      buildkitAttestations: ['sbom', 'provenance'],
      githubAttestations: [
        'provenance',
        'sbom',
        'os-vulnerability',
        'release-candidate',
      ],
      publication: {
        copier: 'regctl@0.11.5',
        copierSha256:
          'c93aa7638749f5aaac1a8e01787321889c78f0101809bb2880343478d0ba0467',
        rebuildAfterScan: false,
        tagAfterVerification: true,
        tagAfterCompleteReleaseSet: true,
        tagAfterVerifiedCatalog: true,
        tagAfterRequiredDeploymentGates: true,
        boundedRepositoryTagInventory: true,
        allTagConflictsCheckedBeforeMutation: true,
        responseLossRecovery: 'reuse_exact_digest_only',
      },
      releaseSet: {
        sourceDerived: true,
        sameRunRecords: true,
        sameRunPrivateEvidenceReceipts: true,
        deterministicPrivateEvidenceReceipts: true,
        privateEvidenceFreshnessRevalidatedAtClosure: true,
        exactScopeClosure: true,
        standaloneInspection: true,
        tagPromotionAuthority: 'verified_catalog_bound_deployments',
        fileProvenanceAttested: true,
        artifactRetentionDays: 90,
        crossRepositoryAtomicity: false,
      },
      durableCatalog: {
        repository: 'qinglong3-release-catalog',
        artifactType: 'application/vnd.qinglong.release-set.v3+json',
        planSchema: 'qinglong/release-catalog-plan@v2',
        receiptSchema: 'qinglong/release-catalog-receipt@v2',
        tagInventoryDecisionSchema:
          'qinglong/release-catalog-tag-inventory-decision@v1',
        publicationDecisionSchema:
          'qinglong/release-catalog-publication-decision@v1',
        basenameOnly: true,
        crossRunnerDeterministic: true,
        byteExactRoundTrip: true,
        keylessSignatureVerified: true,
        githubProvenanceVerified: true,
        deterministicStagingTag: true,
        discoveryTagAuthority: 'none',
        discoveryTagConflictPolicy: 'fail_closed_without_overwrite',
        responseLossRecovery: 'reuse_exact_manifest_digest_only',
        registryTagCas: false,
        immutableDigestAuthority: 'verified',
        receiptAttested: true,
      },
      finalPublicationClosure: {
        finalizer: 'scripts/ql3-release-tag-finalizer.cjs',
        planSchema: 'qinglong/release-publication-plan@v2',
        tagObservationSchema: 'qinglong/release-publication-tag-observation@v1',
        receiptSchema: 'qinglong/release-publication-closure-receipt@v2',
        planValidatedBeforeRegistryAccess: true,
        hermeticResponseLossRehearsal: true,
        liveTerminalAuditBeforeClosure: true,
        catalogReadyBeforeTagMutation: true,
        deploymentReadyBeforeTagMutation: true,
        allTagsExactDigest: true,
        tagsPerImage: 2,
        conflictPolicy: 'fail_closed_before_any_tag_mutation',
        responseLossRecovery: 'reuse_exact_digest_only',
        crossRepositoryAtomicity: false,
        registryTagCas: false,
        receiptAttested: true,
      },
      deploymentReadiness: {
        receiptSchema: 'qinglong/release-deployment-readiness-receipt@v1',
        scopes: ['local', 'cluster', 'all'],
        localProfiles: ['edge', 'standalone'],
        clusterNodes: 3,
        independentFinalizerCatalogConsumption: true,
        exactEvidenceBytesAudited: true,
        jobResultOnlyAuthority: false,
        receiptAttestedBeforeTagMutation: true,
      },
      catalogDeploymentGate: {
        scopes: ['cluster', 'all'],
        catalogAuthority: 'immutable_digest_after_public_consumption',
        deploymentLockReconstructed: true,
        k3sNodes: 3,
        installReceiptAudited: true,
        fencedRetirementReceiptAudited: true,
        publicationAuthority: false,
        requiredForFinalization: true,
      },
      localCatalogDeploymentGate: {
        scopes: ['local', 'all'],
        catalogAuthority: 'immutable_digest_after_public_consumption',
        selectionReconstructed: true,
        profiles: ['edge', 'standalone'],
        rolloutReceiptAudited: true,
        gracefulCleanup: true,
        publicationAuthority: false,
        requiredForFinalization: true,
      },
      localRolloutPreflight: true,
      localRolloutApply: true,
      postPublishVerification: [
        'manifest',
        'cosign',
        'provenance',
        'cyclonedx',
        'os-vulnerability',
        'release-candidate',
        'release-set',
        'durable-catalog',
        'catalog-consumption',
        'catalog-bound-local-compose-deployment',
        'catalog-bound-k3s-deployment',
        'deployment-readiness',
        'release-tags',
        'release-publication-closure',
      ],
    },
  });
});

test('rejects removal of the source-derived release version audit', () => {
  const mutated = ciSource.replace(
    'pnpm audit:release-version:ql3',
    'echo release-version-audit-removed',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /source-derived release version identity/,
  );
});

test('rejects removal of the durable release-catalog contract tests', () => {
  const mutated = ciSource.replace(
    'test/back/ql3ReleaseCatalogContract.test.cjs',
    'test/back/catalog-tests-removed.test.cjs',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /durable catalog, deployment-lock.*workflow negative tests/,
  );
});

test('rejects removal of the final publication closure contract tests', () => {
  const mutated = ciSource.replace(
    'test/back/ql3ReleasePublicationClosureContract.test.cjs',
    'test/back/publication-closure-tests-removed.test.cjs',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /durable catalog, deployment-lock.*workflow negative tests/,
  );
});

test('rejects removal of the deployment readiness contract tests', () => {
  const mutated = ciSource.replace(
    'test/back/ql3ReleaseDeploymentReadinessContract.test.cjs',
    'test/back/deployment-readiness-tests-removed.test.cjs',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /durable catalog, deployment-lock.*workflow negative tests/,
  );
});

test('rejects removal of the fail-closed tag finalizer tests', () => {
  const mutated = ciSource.replace(
    'test/back/ql3ReleaseTagFinalizer.test.cjs',
    'test/back/tag-finalizer-tests-removed.test.cjs',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /tag finalizer.*workflow negative tests/,
  );
});

test('rejects removal of the private release evidence receipt contract tests', () => {
  const mutated = ciSource.replace(
    'test/back/ql3PrivateReleaseEvidenceReceiptContract.test.cjs',
    'test/back/private-receipt-tests-removed.test.cjs',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /private evidence receipt/,
  );
});

test('rejects removal of the deployment-lock materialization contract tests', () => {
  const mutated = ciSource.replace(
    'test/back/ql3DeploymentLockContract.test.cjs',
    'test/back/deployment-lock-tests-removed.test.cjs',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /deployment-lock.*workflow negative tests/,
  );
});

test('rejects removal of the deployment image surface audit', () => {
  const mutated = ciSource.replace(
    'pnpm audit:deployment-lock-surfaces:ql3',
    'echo deployment-image-surfaces-removed',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /reviewed deployment image surfaces/,
  );
});

test('rejects removal of the native arm64 image gate', () => {
  const mutated = ciSource.replace(
    'runner: ubuntu-24.04-arm\n            node_arch: arm64\n            image_arch: arm64\n            image: control',
    'runner: none\n            node_arch: arm64\n            image_arch: arm64\n            image: control',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /matrices must contain only exact/,
  );
});

test('rejects removal of the native Cluster Admin product facade gate', () => {
  const mutated = ciSource.replace(
    "QL3_CLUSTER_ADMIN_PRODUCT_LIVE: '1'",
    "QL3_CLUSTER_ADMIN_PRODUCT_LIVE: '0'",
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /bounded product facade contract/,
  );
});

test('rejects a Console capacity capture without the exact native live opt-in', () => {
  const mutated = ciSource.replace(
    "QL3_CLUSTER_COPILOT_CONSOLE_CAPACITY_LIVE: '1'",
    "QL3_CLUSTER_COPILOT_CONSOLE_CAPACITY_LIVE: '0'",
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /exact source-bound Console capacity envelope/,
  );
});

test('rejects removal of the Console capacity evidence protocol tests', () => {
  const mutated = ciSource.replace(
    'test/back/ql3ClusterCopilotConsoleCapacityEvidence.test.cjs',
    'test/back/ql3ClusterCopilotConsoleCapacityEvidence.removed.cjs',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /Console capacity evidence protocol tests/,
  );
});

test('rejects Console capacity evidence that is not gated by the native image matrix', () => {
  const mutated = ciSource.replace(
    'cluster-console-capacity-release-evidence:\n    name: Cross-architecture Cluster Copilot Console capacity evidence\n    needs: cluster-image',
    'cluster-console-capacity-release-evidence:\n    name: Cross-architecture Cluster Copilot Console capacity evidence\n    needs: image-oci',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /exact native x64 and arm64 reports/,
  );
});

test('rejects removal of the offline Console capacity release audit', () => {
  const mutated = ciSource.replace(
    '            --mode=audit \\\n',
    '            --mode=merge \\\n',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /exact native x64 and arm64 reports/,
  );
});

test('rejects a Cluster Admin live gate that omits operator context injection', () => {
  const contract = fs.readFileSync(
    path.join(root, 'scripts/ql3-cluster-admin-product-live-contract.cjs'),
    'utf8',
  );
  assert.throws(
    () =>
      auditClusterImageCiWorkflow(
        ciSource,
        contract.replace('operatorContext: true', 'operatorContext: false'),
      ),
    /owner-private operator context injection/,
  );
});

test('rejects a Cluster Admin live gate that omits offline context preflight', () => {
  const contract = fs.readFileSync(
    path.join(root, 'scripts/ql3-cluster-admin-product-live-contract.cjs'),
    'utf8',
  );
  assert.throws(
    () =>
      auditClusterImageCiWorkflow(
        ciSource,
        contract.replace(
          'operatorContext: true,\n      contextPreflight: true',
          'operatorContext: true,\n      contextPreflight: false',
        ),
      ),
    /offline preflight/,
  );
});

test('rejects a Cluster Admin live gate that omits read-only context readiness', () => {
  const contract = fs.readFileSync(
    path.join(root, 'scripts/ql3-cluster-admin-product-live-contract.cjs'),
    'utf8',
  );
  assert.throws(
    () =>
      auditClusterImageCiWorkflow(
        ciSource,
        contract.replace(
          'contextPreflight: true,\n      contextReadiness: true',
          'contextPreflight: true,\n      contextReadiness: false',
        ),
      ),
    /read-only readiness/,
  );
});

test('rejects removal of the native cluster-admin image gate', () => {
  const mutated = ciSource.replace(
    'image_arch: arm64\n            image: admin',
    'image_arch: arm64\n            image: disabled',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /matrices must contain only exact/,
  );
});

test('rejects removal of the native Worker image gate', () => {
  const mutated = ciSource.replace(
    '            image: worker\n            repository: qinglong3-worker\n            runtime_user: 65532:65532',
    '            image: worker-disabled\n            repository: qinglong3-worker\n            runtime_user: 65532:65532',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /matrices must contain only exact/,
  );
});

test('rejects an additional unreviewed CI image authority', () => {
  const mutated = ciSource.replace(
    '            target: runtime\n    steps:',
    '            target: runtime\n          - runner: ubuntu-24.04\n            node_arch: x64\n            image_arch: amd64\n            image: unreviewed\n            dockerfile: unreviewed/Dockerfile\n            target: runtime\n    steps:',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /matrices must contain only exact/,
  );
});

test('rejects removal of the attested OCI evidence job', () => {
  const mutated = ciSource.replace('  image-oci:', '  image-oci-disabled:');
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /matrices must contain only exact/,
  );
});

test('rejects a movable Trivy action in native image CI', () => {
  const mutated = ciSource.replace(
    'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0',
    'aquasecurity/trivy-action@v0.36.0',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /exact pinned OS-only Trivy failure gate/,
  );
});

test('rejects native image CI that hides unfixed OS vulnerabilities', () => {
  const mutated = ciSource.replace(
    "          ignore-unfixed: 'false'",
    "          ignore-unfixed: 'true'",
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /exact pinned OS-only Trivy failure gate/,
  );
});

test('rejects a release missing an architecture', () => {
  const mutated = releaseSource.replace(
    '--arm64-layout=${RUNNER_TEMP}/native/arm64/layout',
    '--arm64-layout=${RUNNER_TEMP}/native/amd64/layout',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /merge and re-audit the two scanned layouts/,
  );
});

test('rejects an automatic tag push that bypasses private evidence review', () => {
  const mutated = releaseSource.replace(
    'on:\n  workflow_dispatch:',
    "on:\n  push:\n    tags:\n      - 'v3.*'\n  workflow_dispatch:",
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /explicit protected-tag dispatch/,
  );
});

test('rejects release publication without the private evidence dependency', () => {
  const mutated = releaseSource.replace(
    '      - worker-management-release-evidence',
    '      - worker-management-release-evidence-disabled',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /always require candidate and OS gates/,
  );
});

test('rejects release publication without the OS vulnerability dependency', () => {
  const mutated = releaseSource.replace(
    '      - os-vulnerability',
    '      - os-vulnerability-disabled',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /always require candidate and OS gates/,
  );
});

test('rejects release publication without current disaster-recovery evidence', () => {
  const mutated = releaseSource.replace(
    '      - cluster-dr-release-evidence',
    '      - cluster-dr-release-evidence-disabled',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /always require candidate and OS gates/,
  );
});

test('rejects disaster-recovery evidence detached from the release source', () => {
  const marker = '--source-commit="${GITHUB_SHA}"';
  const first = releaseSource.indexOf(marker);
  const second = releaseSource.indexOf(marker, first + marker.length);
  assert.notEqual(first, -1);
  assert.notEqual(second, -1);
  const mutated = `${releaseSource.slice(
    0,
    second,
  )}--source-commit="detached"${releaseSource.slice(second + marker.length)}`;
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /bind the exact report to the release identity/,
  );
});

test('rejects an incomplete native OS vulnerability architecture matrix', () => {
  const mutated = releaseSource.replace(
    'include: ${{ fromJSON(needs.release-candidate.outputs.os-matrix) }}',
    'include: []',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /OS vulnerability matrix must come from/,
  );
});

test('rejects a movable Trivy action after the upstream supply-chain incident', () => {
  const mutated = releaseSource.replace(
    'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0',
    'aquasecurity/trivy-action@v0.36.0',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /build once, scan that exact OCI layout/,
  );
});

test('rejects hiding unfixed high or critical OS vulnerabilities', () => {
  const mutated = releaseSource.replace(
    "          ignore-unfixed: 'false'",
    "          ignore-unfixed: 'true'",
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /build once, scan that exact OCI layout/,
  );
});

test('rejects widening the OS exception policy to application libraries', () => {
  const mutated = releaseSource.replace(
    "          vuln-type: 'os'",
    "          vuln-type: 'os,library'",
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /build once, scan that exact OCI layout/,
  );
});

test('rejects persistent scanner cache in the privileged release workflow', () => {
  const mutated = releaseSource.replace(
    "          cache: 'false'",
    "          cache: 'true'",
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /build once, scan that exact OCI layout/,
  );
});

test('rejects a reusable private evidence runner', () => {
  const mutated = releaseSource.replace(
    'ql3-release-evidence-ephemeral',
    'ql3-release-evidence-persistent',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /always require candidate and OS gates/,
  );
});

test('rejects private report content uploaded instead of its digest-only receipt', () => {
  const mutated = releaseSource.replace(
    'path: ${{ runner.temp }}/ql3-private-release-evidence-receipts/worker-management.json',
    'path: /run/qinglong3-release-evidence/${{ github.sha }}/worker-management-release-evidence.json',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /content-free receipt and upload steps/,
  );
});

test('rejects a private evidence path not scoped to the release commit', () => {
  const mutated = releaseSource.replace(
    '/run/qinglong3-release-evidence/${GITHUB_SHA}',
    '/run/qinglong3-release-evidence/current',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /commit-scoped runner mount/,
  );
});

test('rejects write authority in the private evidence job', () => {
  const mutated = releaseSource.replace(
    '    timeout-minutes: 10\n    permissions:\n      contents: read',
    '    timeout-minutes: 10\n    permissions:\n      packages: write',
  );
  assert.throws(() => auditReleaseWorkflow(mutated), /keep evidence read-only/);
});

test('rejects a release missing the standalone digest signature', () => {
  const mutated = releaseSource.replace(
    'cosign sign --yes "${IMAGE}@${DIGEST}"',
    'cosign version',
  );
  assert.throws(() => auditReleaseWorkflow(mutated), /keylessly sign/);
});

test('rejects a release missing application SBOM attestation', () => {
  const mutated = releaseSource.replace(
    'sbom-path: ${{ runner.temp }}/${{ matrix.repository }}.cdx.json',
    'show-summary: true',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /reviewed application SBOM/,
  );
});

test('rejects a release missing the independent admin image', () => {
  const mutated = releaseSource.replace(
    'include: ${{ fromJSON(needs.release-candidate.outputs.publish-matrix) }}',
    'include: []',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /matrix must come only from/,
  );
});

test('rejects a release missing the AI-excluded local image', () => {
  const mutated = releaseSource.replace(
    '          - local\n          - cluster\n          - all',
    '          - cluster\n          - all',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /closed local, cluster or all/,
  );
});

test('rejects an additional repository in the privileged release matrix', () => {
  const mutated = releaseSource.replace(
    'include: ${{ fromJSON(needs.release-candidate.outputs.publish-matrix) }}',
    'include:\n          - image: unreviewed\n            repository: unreviewed\n            runtime_root: unreviewed',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /matrix must come only from/,
  );
});

test('rejects release publication without the vulnerability gate', () => {
  const mutated = releaseSource.replace(
    '          --audit-level=high',
    '          --audit-level=none',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /high or critical production dependency advisories/,
  );
});

test('rejects a release that does not select the image-specific SBOM', () => {
  const mutated = releaseSource.replace(
    'node scripts/ql3-cluster-image-sbom.cjs\n          --image=${{ matrix.image }}',
    'node scripts/ql3-cluster-image-sbom.cjs\n          --image=control',
  );
  assert.throws(() => auditReleaseWorkflow(mutated), /selected image SBOM/);
});

test('rejects a release with reduced OIDC authority', () => {
  const mutated = releaseSource.replace('id-token: write', 'id-token: read');
  assert.throws(() => auditReleaseWorkflow(mutated), /grant writes only/);
});

test('rejects a movable action tag in the privileged release job', () => {
  const pinned =
    'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6';
  const offset = releaseSource.lastIndexOf(pinned);
  const mutated = `${releaseSource.slice(
    0,
    offset,
  )}actions/checkout@v6${releaseSource.slice(offset + pinned.length)}`;
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /privileged publisher|immutable checkout action|release-set job|cluster release must read|release finalization/,
  );
});

test('rejects removal of the published manifest audit', () => {
  const mutated = releaseSource.replace(
    'node scripts/ql3-cluster-remote-manifest-audit.cjs',
    'node --version',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /published digest manifest/,
  );
});

test('rejects a local release without both live rollout Profiles', () => {
  const mutated = releaseSource.replace(
    '            --profile=standalone',
    '            --profile=edge',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /apply and stop both Profiles/,
  );
});

test('rejects signature verification without exact certificate identity', () => {
  const mutated = releaseSource.replace(
    '--certificate-identity "${certificate_identity}"',
    '--certificate-identity-regexp ".*"',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /exact keyless workflow identity/,
  );
});

test('rejects a GitHub attestation verification without source binding', () => {
  const mutated = releaseSource.replace(
    '--source-digest "${GITHUB_SHA}"',
    '--source-digest "movable"',
  );
  assert.throws(() => auditReleaseWorkflow(mutated), /bind the source commit/);
});

test('rejects CycloneDX verification without the exact predicate type', () => {
  const mutated = releaseSource.replace(
    '--predicate-type "https://cyclonedx.org/bom"',
    '--predicate-type "https://example.invalid/sbom"',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /CycloneDX predicate type/,
  );
});

test('rejects scanning a daemon tag instead of the exact OCI tar', () => {
  const mutated = releaseSource.replace(
    '          input: ${{ runner.temp }}/ql3-native/image.oci.tar',
    '          image-ref: movable-candidate:latest',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /build once, scan that exact OCI layout tar/,
  );
});

test('rejects retaining scanned native release artifacts for more than one day', () => {
  const mutated = releaseSource.replace(
    'name: ql3-release-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.image }}-${{ matrix.image_arch }}\n          path: ${{ runner.temp }}/ql3-native\n          if-no-files-found: error\n          retention-days: 1',
    'name: ql3-release-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.image }}-${{ matrix.image_arch }}\n          path: ${{ runner.temp }}/ql3-native\n          if-no-files-found: error\n          retention-days: 2',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /upload only bound immutable evidence/,
  );
});

test('rejects overwrite authority on a scanned native artifact', () => {
  const mutated = releaseSource.replace(
    'path: ${{ runner.temp }}/ql3-native\n          if-no-files-found: error\n          retention-days: 1\n          compression-level: 0\n          overwrite: false',
    'path: ${{ runner.temp }}/ql3-native\n          if-no-files-found: error\n          retention-days: 1\n          compression-level: 0\n          overwrite: true',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /upload only bound immutable evidence/,
  );
});

test('rejects a movable upload-artifact action', () => {
  const marker =
    '      - name: Upload the scanned immutable native OCI artifact';
  const offset = releaseSource.indexOf(marker);
  assert.notEqual(offset, -1);
  const mutated = `${releaseSource.slice(0, offset)}${releaseSource
    .slice(offset)
    .replace(
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
      'actions/upload-artifact@v7.0.1',
    )}`;
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /upload only bound immutable evidence/,
  );
});

test('rejects downloading an artifact not bound to the same run attempt', () => {
  const mutated = releaseSource.replace(
    'ql3-release-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.image }}-amd64',
    'ql3-release-${{ github.run_id }}-${{ matrix.image }}-amd64',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /same-run scanned native artifacts/,
  );
});

test('rejects any privileged rebuild after the native scan', () => {
  const mutated = releaseSource.replace(
    '          node scripts/ql3-image-release-bundle.cjs \\\n            --mode=merge',
    '          docker build .\n          node scripts/ql3-image-release-bundle.cjs \\\n            --mode=merge',
  );
  assert.throws(() => auditReleaseWorkflow(mutated), /without any rebuild/);
});

test('rejects a checksum drift in the exact OCI copier', () => {
  const mutated = releaseSource.replace(
    'c93aa7638749f5aaac1a8e01787321889c78f0101809bb2880343478d0ba0467',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /checksum-pin the exact regctl OCI copier/,
  );
});

test('rejects importing the scanned graph through an unverified tag', () => {
  const mutated = releaseSource.replace(
    'image import "${IMAGE}@${DIGEST}" "${ARCHIVE}"',
    'image import "${IMAGE}:candidate" "${ARCHIVE}"',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /import the audited OCI graph by digest/,
  );
});

test('rejects an image tag created before digest verification completes', () => {
  const mutated = releaseSource.replace(
    '          "${REGCTL}" image import "${IMAGE}@${DIGEST}" "${ARCHIVE}"',
    '          "${REGCTL}" image copy "${IMAGE}@${DIGEST}" "${IMAGE}:early"\n          "${REGCTL}" image import "${IMAGE}@${DIGEST}" "${ARCHIVE}"',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /without any rebuild or tag promotion before release-set closure/,
  );
});

test('rejects any publisher step after the deployment lock is published', () => {
  const marker = '\n  release-catalog-local-deployment-live:';
  assert.equal(releaseSource.includes(marker), true);
  const mutated = releaseSource.replace(
    marker,
    '\n      - name: Post-promotion mutation\n        run: echo unsafe\n' +
      marker,
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /release-set job must download only same-run records/,
  );
});

test('rejects removal of the downstream Local catalog deployment gate', function rejectsMissingLocalCatalogDeploymentGate() {
  const localMarker = '\n  release-catalog-local-deployment-live:';
  const clusterMarker = '\n  release-catalog-deployment-live:';
  const localOffset = releaseSource.indexOf(localMarker);
  const clusterOffset = releaseSource.indexOf(clusterMarker);
  assert.notEqual(localOffset, -1);
  assert.equal(clusterOffset > localOffset, true);
  const mutated = `${releaseSource.slice(0, localOffset)}${releaseSource.slice(
    clusterOffset,
  )}`;
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /keep evidence read-only|Local release must independently consume/,
  );
});

test('rejects running the Local catalog gate for Cluster-only releases', function rejectsClusterLocalCatalogDeploymentGate() {
  const mutated = releaseSource.replace(
    "inputs.release_scope != 'cluster'",
    "inputs.release_scope == 'cluster'",
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /Local release must independently consume/,
  );
});

test('rejects a Local rollout detached from the audited catalog selection', function rejectsDetachedLocalCatalogSelection() {
  const localMarker = '\n  release-catalog-local-deployment-live:';
  const clusterMarker = '\n  release-catalog-deployment-live:';
  const localOffset = releaseSource.indexOf(localMarker);
  const clusterOffset = releaseSource.indexOf(clusterMarker);
  const mutatedLocal = releaseSource
    .slice(localOffset, clusterOffset)
    .replace(
      '--release-selection="${RELEASE_SELECTION}"',
      '--release-selection="/tmp/unreviewed.json"',
    );
  assert.throws(
    () =>
      auditReleaseWorkflow(
        `${releaseSource.slice(
          0,
          localOffset,
        )}${mutatedLocal}${releaseSource.slice(clusterOffset)}`,
      ),
    /Local release must independently consume/,
  );
});

test('rejects publication authority in the post-publish Local catalog consumer', function rejectsLocalCatalogConsumerPublicationAuthority() {
  const localMarker = '\n  release-catalog-local-deployment-live:';
  const clusterMarker = '\n  release-catalog-deployment-live:';
  const localOffset = releaseSource.indexOf(localMarker);
  const clusterOffset = releaseSource.indexOf(clusterMarker);
  const mutatedLocal = releaseSource
    .slice(localOffset, clusterOffset)
    .replace('packages: read', 'packages: write');
  assert.throws(
    () =>
      auditReleaseWorkflow(
        `${releaseSource.slice(
          0,
          localOffset,
        )}${mutatedLocal}${releaseSource.slice(clusterOffset)}`,
      ),
    /keep evidence read-only|without publication authority/,
  );
});

test('rejects removal of the downstream catalog deployment release gate', function rejectsMissingCatalogDeploymentGate() {
  const marker = '\n  release-catalog-deployment-live:';
  const offset = releaseSource.indexOf(marker);
  assert.notEqual(offset, -1);
  assert.throws(
    () => auditReleaseWorkflow(releaseSource.slice(0, offset)),
    /keep evidence read-only|cluster release must read the newly published immutable catalog/,
  );
});

test('rejects running the cluster deployment gate for Local-only releases', function rejectsLocalCatalogDeploymentGate() {
  const mutated = releaseSource.replace(
    "inputs.release_scope != 'local'",
    "inputs.release_scope == 'local'",
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /cluster release must read the newly published immutable catalog/,
  );
});

test('rejects publication authority in the post-publish catalog consumer', function rejectsCatalogConsumerPublicationAuthority() {
  const marker = '\n  release-catalog-deployment-live:';
  const offset = releaseSource.indexOf(marker);
  assert.notEqual(offset, -1);
  const mutated = `${releaseSource.slice(0, offset)}${releaseSource
    .slice(offset)
    .replace('packages: read', 'packages: write')}`;
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /keep evidence read-only|without publication authority/,
  );
});

test('rejects release-set closure before every image publisher succeeds', () => {
  const mutated = releaseSource.replace(
    "      needs.publish.result == 'success'",
    "      needs.publish.result != 'success'",
  );
  assert.throws(() => auditReleaseWorkflow(mutated), /complete publish matrix/);
});

test('rejects release-set closure detached from same-run private evidence receipts', () => {
  const mutated = releaseSource.replace(
    'ql3-private-release-evidence-${{ github.run_id }}-${{ github.run_attempt }}-*',
    'ql3-private-release-evidence-${{ github.run_id }}-*',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /release-set job must download only same-run records/,
  );
});

test('rejects release-set aggregation that ignores private evidence receipts', () => {
  const marker =
    '      - name: Aggregate and independently audit the complete release set';
  const offset = releaseSource.indexOf(marker);
  assert.notEqual(offset, -1);
  const mutated = `${releaseSource.slice(0, offset)}${releaseSource
    .slice(offset)
    .replace(
      '            --evidence-receipts="${evidence_receipts}" \\',
      '            --evidence-receipts="${RUNNER_TEMP}/empty" \\',
    )}`;
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /release-set job must download only same-run records/,
  );
});

test('rejects image records detached from the same workflow attempt', () => {
  const mutated = releaseSource.replace(
    'ql3-release-record-${{ github.run_id }}-${{ github.run_attempt }}-*',
    'ql3-release-record-${{ github.run_id }}-*',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /download only same-run records/,
  );
});

test('rejects release-set aggregation without independent audit', () => {
  const releaseSetOffset = releaseSource.indexOf('\n  release-set:');
  assert.notEqual(releaseSetOffset, -1);
  const releaseSetSource = releaseSource.slice(releaseSetOffset);
  const mutatedReleaseSet = releaseSetSource.replace(
    '            --mode=audit \\',
    '            --mode=aggregate \\',
  );
  const mutated = `${releaseSource.slice(
    0,
    releaseSetOffset,
  )}${mutatedReleaseSet}`;
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /download only same-run records/,
  );
});

test('rejects a deployment lock without standalone inspection', () => {
  const releaseSetOffset = releaseSource.indexOf('\n  release-set:');
  assert.notEqual(releaseSetOffset, -1);
  const releaseSetSource = releaseSource.slice(releaseSetOffset);
  const mutated = `${releaseSource.slice(
    0,
    releaseSetOffset,
  )}${releaseSetSource.replace(
    '            --mode=inspect \\',
    '            --mode=audit \\',
  )}`;
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /independently inspect and durably publish/,
  );
});

test('rejects a catalog title that leaks the runner temporary path', () => {
  const mutated = releaseSource.replace(
    '            --strip-dirs \\',
    '            --index \\',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /independently inspect and durably publish/,
  );
});

test('rejects a catalog publication without byte-exact round trip', () => {
  const mutated = releaseSource.replace(
    '          cmp --silent "${RELEASE_SET}" "${roundtrip}"',
    '          echo roundtrip-not-checked',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /independently inspect and durably publish/,
  );
});

test('rejects direct overwrite publication to the catalog discovery tag', () => {
  const mutated = releaseSource.replace(
    '            "${local_tag}"',
    '            "${discovery_tag}"',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /independently inspect and durably publish/,
  );
});

test('rejects catalog publication without a conflict-aware decision', () => {
  const mutated = releaseSource.replace(
    '--mode=publication-decision',
    '--mode=receipt',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /independently inspect and durably publish/,
  );
});

test('rejects catalog publication without bounded tag inventory classification', () => {
  const mutated = releaseSource.replace(
    '--mode=tag-inventory',
    '--mode=publication-decision',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /independently inspect and durably publish/,
  );
});

test('rejects response-loss recovery that cannot reuse an exact catalog digest', () => {
  const mutated = releaseSource.replace(
    '          elif [[ "${action}" != "reuse_exact_digest" ]]; then',
    '          elif [[ "${action}" != "publish_if_absent" ]]; then',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /independently inspect and durably publish/,
  );
});

test('rejects using the mutable catalog discovery tag as deployment authority', () => {
  const mutated = releaseSource.replace(
    'artifact get --file "${file_name}" "${immutable_reference}"',
    'artifact get --file "${file_name}" "${discovery_tag}"',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /independently inspect and durably publish/,
  );
});

test('rejects durable catalog provenance detached from its manifest digest', () => {
  const mutated = releaseSource.replace(
    '          subject-digest: ${{ steps.catalog.outputs.digest }}',
    '          subject-digest: ${{ github.sha }}',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /independently inspect and durably publish/,
  );
});

test('rejects a release-catalog receipt without file provenance', () => {
  const mutated = releaseSource.replace(
    '          subject-path: ${{ steps.catalog-receipt.outputs.receipt }}',
    '          subject-path: ${{ steps.release-set.outputs.report }}',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /independently inspect and durably publish/,
  );
});

test('rejects final tag publication before deployment readiness', () => {
  const mutated = releaseSource.replace(
    'Promote final tags only after every required deployment gate',
    'Promote tags before deployment readiness',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /release finalization|release tags and the final closure receipt/,
  );
});

test('rejects finalization that ignores a required deployment job result', () => {
  const mutated = releaseSource.replace(
    "needs.release-catalog-local-deployment-live.result == 'success'",
    "needs.release-catalog-local-deployment-live.result != 'failure'",
  );
  assert.throws(() => auditReleaseWorkflow(mutated), /release finalization/);
});

test('rejects deployment readiness without exact downloaded evidence bundles', () => {
  const mutated = releaseSource.replace(
    '          path: ${{ runner.temp }}/ql3-release-catalog-deployment',
    '          path: ${{ runner.temp }}/ql3-release-catalog-deployment/report.json',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /cluster release must read the newly published immutable catalog/,
  );
});

test('rejects a publication plan detached from deployment readiness', () => {
  const mutated = releaseSource.replace(
    '            --deployment-readiness="${readiness}" \\',
    '            --deployment-readiness="${catalog_receipt}" \\',
  );
  assert.throws(() => auditReleaseWorkflow(mutated), /release finalization/);
});

test('rejects deployment readiness without its own pre-promotion attestation', () => {
  const mutated = releaseSource.replace(
    '          subject-path: ${{ steps.final-publication.outputs.readiness }}',
    '          subject-path: ${{ steps.final-publication.outputs.plan }}',
  );
  assert.throws(() => auditReleaseWorkflow(mutated), /release finalization/);
});

test('rejects final tag promotion that bypasses the validated finalizer', () => {
  const mutated = releaseSource.replace(
    '            --mode=finalize \\',
    '            --mode=audit \\',
  );
  assert.throws(() => auditReleaseWorkflow(mutated), /release finalization/);
});

test('rejects final tag promotion without a live read-only terminal audit', () => {
  const audited = [
    '            --mode=audit \\',
    '            --plan="${PUBLICATION_PLAN}" \\',
    '            --regctl="${REGCTL}"',
  ].join('\n');
  const unaudited = [
    '            --mode=finalize \\',
    '            --plan="${PUBLICATION_PLAN}" \\',
    '            --regctl="${REGCTL}"',
  ].join('\n');
  const mutated = releaseSource.replace(audited, unaudited);
  assert.throws(() => auditReleaseWorkflow(mutated), /release finalization/);
});

test('rejects omission of the final publication closure audit', () => {
  const mutated = releaseSource.replace(
    '            --mode=close \\',
    '            --mode=audit \\',
  );
  assert.throws(() => auditReleaseWorkflow(mutated), /release finalization/);
});

test('rejects omitting tag observations from the durable closure bundle', () => {
  const mutated = releaseSource.replace(
    'observations="${FINALIZATION_ROOT}/qinglong3-release-publication-tag-observation-',
    'observations="${RUNNER_TEMP}/qinglong3-release-publication-tag-observation-',
  );
  assert.throws(() => auditReleaseWorkflow(mutated), /release finalization/);
});

test('rejects a final closure receipt without its own attestation', () => {
  const mutated = releaseSource.replace(
    '          subject-path: ${{ steps.final-publication.outputs.closure }}',
    '          subject-path: ${{ steps.final-publication.outputs.readiness }}',
  );
  assert.throws(() => auditReleaseWorkflow(mutated), /release finalization/);
});

test('rejects a short-lived deployment digest lock', () => {
  const marker = '          retention-days: 90';
  assert.equal(releaseSource.includes(marker), true);
  const mutated = releaseSource.replace(marker, '          retention-days: 1');
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /release-set job|release finalization/,
  );
});

test('rejects removal of the digest-bound OS vulnerability attestation', () => {
  const mutated = releaseSource.replace(
    'predicate-type: https://qinglong.dev/attestations/image-os-vulnerability/v1',
    'predicate-type: https://example.invalid/not-os-evidence',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /digest-bound OS vulnerability evidence/,
  );
});

test('rejects removal of the digest-bound release candidate attestation', () => {
  const mutated = releaseSource.replace(
    'predicate-type: https://qinglong.dev/attestations/release-candidate-contract/v1',
    'predicate-type: https://example.invalid/not-a-candidate-contract',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /source-derived release candidate contract/,
  );
});

test('rejects treating skipped private evidence as cluster success', () => {
  const mutated = releaseSource.replace(
    "needs.release-candidate.outputs.cluster-evidence-required != 'true' ||",
    "needs.release-candidate.outputs.cluster-evidence-required == 'true' ||",
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /requiring private HA evidence only for a cluster family/,
  );
});

test('rejects a publisher matrix detached from the source-derived contract', () => {
  const mutated = releaseSource.replace(
    'include: ${{ fromJSON(needs.release-candidate.outputs.publish-matrix) }}',
    'include: ${{ fromJSON(inputs.publish_matrix) }}',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /matrix must come only from/,
  );
});
