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
      images: ['control', 'control-ai', 'admin', 'local'],
      nativeArchitectures: ['amd64', 'arm64'],
      runtimeInventory: true,
      clusterAdminProductFacade: true,
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
      workerManagementEvidence: {
        sourceAware: true,
        privateEphemeralRunner: true,
        maximumAgeSeconds: 86400,
        artifactUpload: false,
      },
      cloudNativePgDisasterRecoveryEvidence: {
        sourceAware: true,
        privateEphemeralRunner: true,
        maximumAgeSeconds: 86400,
        artifactUpload: false,
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
      images: ['control', 'control-ai', 'admin', 'local'],
      platforms: ['linux/amd64', 'linux/arm64'],
      keylessSignature: true,
      buildkitAttestations: ['sbom', 'provenance'],
      githubAttestations: ['provenance', 'sbom', 'os-vulnerability'],
      publication: {
        copier: 'regctl@0.11.5',
        copierSha256:
          'c93aa7638749f5aaac1a8e01787321889c78f0101809bb2880343478d0ba0467',
        rebuildAfterScan: false,
        tagAfterVerification: true,
      },
      localRolloutPreflight: true,
      localRolloutApply: true,
      postPublishVerification: [
        'manifest',
        'cosign',
        'provenance',
        'cyclonedx',
        'os-vulnerability',
        'release-tags',
      ],
    },
  });
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
    /depend on both protected ephemeral private evidence jobs/,
  );
});

test('rejects release publication without the OS vulnerability dependency', () => {
  const mutated = releaseSource.replace(
    '      - os-vulnerability',
    '      - os-vulnerability-disabled',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /depend on both protected ephemeral private evidence jobs/,
  );
});

test('rejects release publication without current disaster-recovery evidence', () => {
  const mutated = releaseSource.replace(
    '      - cluster-dr-release-evidence',
    '      - cluster-dr-release-evidence-disabled',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /depend on both protected ephemeral private evidence jobs/,
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
    '          - image: local\n            runner: ubuntu-24.04-arm\n            node_arch: arm64\n            image_arch: arm64\n            dockerfile: deploy/containers/ql3-local-application/Dockerfile',
    '          - image: local\n            runner: ubuntu-24.04-arm\n            node_arch: arm64\n            image_arch: disabled\n            dockerfile: deploy/containers/ql3-local-application/Dockerfile',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /OS vulnerability matrix must scan exact/,
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
    /protected ephemeral private evidence job/,
  );
});

test('rejects private evidence uploaded as a workflow artifact', () => {
  const mutated = releaseSource.replace(
    '      - name: Re-audit commit-scoped private production evidence',
    '      - uses: actions/upload-artifact@v4\n      - name: Re-audit commit-scoped private production evidence',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /only the reviewed|never persist private evidence/,
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
    '- image: admin\n            repository: qinglong3-cluster-admin\n            runtime_root: deploy/containers/ql3-cluster-admin/runtime-dependencies',
    '- image: admin-disabled\n            repository: qinglong3-cluster-admin\n            runtime_root: deploy/containers/ql3-cluster-admin/runtime-dependencies',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /matrix must contain only exact/,
  );
});

test('rejects a release missing the AI-excluded local image', () => {
  const mutated = releaseSource.replace(
    '- image: local\n            repository: qinglong3-local-application\n            runtime_root: deploy/containers/ql3-local-application/runtime-dependencies',
    '- image: local-disabled\n            repository: qinglong3-local-application\n            runtime_root: deploy/containers/ql3-local-application/runtime-dependencies',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /matrix must contain only exact/,
  );
});

test('rejects an additional repository in the privileged release matrix', () => {
  const mutated = releaseSource.replace(
    '            runtime_root: deploy/containers/ql3-local-application/runtime-dependencies\n    steps:',
    '            runtime_root: deploy/containers/ql3-local-application/runtime-dependencies\n          - image: unreviewed\n            repository: unreviewed\n            dockerfile: Dockerfile\n            runtime_root: unreviewed\n    steps:',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /matrix must contain only exact/,
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
    /privileged publisher|immutable checkout action/,
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
    '          retention-days: 1',
    '          retention-days: 2',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /upload only bound immutable evidence/,
  );
});

test('rejects overwrite authority on a scanned native artifact', () => {
  const mutated = releaseSource.replace(
    '          overwrite: false',
    '          overwrite: true',
  );
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /upload only bound immutable evidence/,
  );
});

test('rejects a movable upload-artifact action', () => {
  const mutated = releaseSource.replace(
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
    'actions/upload-artifact@v7.0.1',
  );
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
    /before final tag promotion/,
  );
});

test('rejects any publisher step after immutable tag promotion', () => {
  const mutated = `${releaseSource}\n      - name: Post-promotion mutation\n        run: echo unsafe\n`;
  assert.throws(
    () => auditReleaseWorkflow(mutated),
    /before final tag promotion/,
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
