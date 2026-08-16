#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const CI_WORKFLOW_PATH = '.github/workflows/ql3-ci.yml';
const RELEASE_WORKFLOW_PATH = '.github/workflows/ql3-image-release.yml';
const MAX_WORKFLOW_BYTES = 256 * 1024;

function readBoundedText(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_WORKFLOW_BYTES) {
    throw new Error(`invalid bounded workflow file: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function requirePattern(source, pattern, finding) {
  if (!pattern.test(source)) {
    throw new Error(finding);
  }
}

function requireOccurrences(source, pattern, minimum, finding) {
  const matches = source.match(pattern) || [];
  if (matches.length < minimum) {
    throw new Error(finding);
  }
}

function requireExactOccurrences(source, pattern, expected, finding) {
  const matches = source.match(pattern) || [];
  if (matches.length !== expected) {
    throw new Error(finding);
  }
}

function auditClusterImageCiWorkflow(
  source,
  adminProductLiveContract = readBoundedText(
    path.join(
      DEFAULT_ROOT,
      'scripts/ql3-cluster-admin-product-live-contract.cjs',
    ),
  ),
) {
  const workflow = yaml.load(source);
  const clusterImageJob = workflow?.jobs?.['cluster-image'];
  const localImageJob = workflow?.jobs?.['local-image'];
  const expectedNativeMatrix = [
    {
      runner: 'ubuntu-24.04',
      node_arch: 'x64',
      image_arch: 'amd64',
      image: 'control',
      repository: 'qinglong3-cluster-control',
      runtime_user: '10001:10001',
      dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
      target: 'runtime',
    },
    {
      runner: 'ubuntu-24.04-arm',
      node_arch: 'arm64',
      image_arch: 'arm64',
      image: 'control',
      repository: 'qinglong3-cluster-control',
      runtime_user: '10001:10001',
      dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
      target: 'runtime',
    },
    {
      runner: 'ubuntu-24.04',
      node_arch: 'x64',
      image_arch: 'amd64',
      image: 'control-ai',
      repository: 'qinglong3-cluster-control-ai',
      runtime_user: '10001:10001',
      dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
      target: 'runtime-ai',
    },
    {
      runner: 'ubuntu-24.04-arm',
      node_arch: 'arm64',
      image_arch: 'arm64',
      image: 'control-ai',
      repository: 'qinglong3-cluster-control-ai',
      runtime_user: '10001:10001',
      dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
      target: 'runtime-ai',
    },
    {
      runner: 'ubuntu-24.04',
      node_arch: 'x64',
      image_arch: 'amd64',
      image: 'admin',
      repository: 'qinglong3-cluster-admin',
      runtime_user: '10001:10001',
      dockerfile: 'deploy/containers/ql3-cluster-admin/Dockerfile',
      target: 'runtime',
    },
    {
      runner: 'ubuntu-24.04-arm',
      node_arch: 'arm64',
      image_arch: 'arm64',
      image: 'admin',
      repository: 'qinglong3-cluster-admin',
      runtime_user: '10001:10001',
      dockerfile: 'deploy/containers/ql3-cluster-admin/Dockerfile',
      target: 'runtime',
    },
    {
      runner: 'ubuntu-24.04',
      node_arch: 'x64',
      image_arch: 'amd64',
      image: 'worker',
      repository: 'qinglong3-worker',
      runtime_user: '65532:65532',
      dockerfile: 'deploy/containers/ql3-worker/Dockerfile',
      target: 'runtime',
    },
    {
      runner: 'ubuntu-24.04-arm',
      node_arch: 'arm64',
      image_arch: 'arm64',
      image: 'worker',
      repository: 'qinglong3-worker',
      runtime_user: '65532:65532',
      dockerfile: 'deploy/containers/ql3-worker/Dockerfile',
      target: 'runtime',
    },
  ];
  const expectedLocalNativeMatrix = [
    {
      runner: 'ubuntu-24.04',
      node_arch: 'x64',
      image_arch: 'amd64',
    },
    {
      runner: 'ubuntu-24.04-arm',
      node_arch: 'arm64',
      image_arch: 'arm64',
    },
  ];
  const expectedOciMatrix = [
    {
      image: 'control',
      dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
      target: 'runtime',
    },
    {
      image: 'control-ai',
      dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
      target: 'runtime-ai',
    },
    {
      image: 'admin',
      dockerfile: 'deploy/containers/ql3-cluster-admin/Dockerfile',
      target: 'runtime',
    },
    {
      image: 'local',
      dockerfile: 'deploy/containers/ql3-local-application/Dockerfile',
      target: 'runtime',
    },
    {
      image: 'worker',
      dockerfile: 'deploy/containers/ql3-worker/Dockerfile',
      target: 'runtime',
    },
  ];
  if (
    JSON.stringify(
      workflow?.jobs?.['cluster-image']?.strategy?.matrix?.include,
    ) !== JSON.stringify(expectedNativeMatrix) ||
    JSON.stringify(
      workflow?.jobs?.['local-image']?.strategy?.matrix?.include,
    ) !== JSON.stringify(expectedLocalNativeMatrix) ||
    JSON.stringify(workflow?.jobs?.['image-oci']?.strategy?.matrix?.include) !==
      JSON.stringify(expectedOciMatrix)
  ) {
    throw new Error(
      'image CI matrices must contain only exact control/control-ai/admin/local/worker amd64/arm64 evidence targets',
    );
  }
  const expectedTrivyInputs = {
    version: 'v0.70.0',
    scanners: 'vuln',
    'vuln-type': 'os',
    severity: 'HIGH,CRITICAL',
    'ignore-unfixed': 'false',
    'exit-code': '1',
    format: 'table',
    'hide-progress': 'true',
    timeout: '10m0s',
    cache: 'false',
  };
  for (const [job, imageRef, ignores, label] of [
    [
      localImageJob,
      'qinglong3-local-application:ci-${{ matrix.image_arch }}',
      '${{ runner.temp }}/ql3-local-${{ matrix.image_arch }}.trivyignore.yaml',
      'local',
    ],
    [
      clusterImageJob,
      '${{ matrix.repository }}:ci-${{ matrix.image_arch }}',
      '${{ runner.temp }}/ql3-${{ matrix.image }}-${{ matrix.image_arch }}.trivyignore.yaml',
      'cluster',
    ],
  ]) {
    const step = job?.steps?.find(
      (entry) =>
        entry.uses ===
        'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25',
    );
    if (
      !step ||
      step['continue-on-error'] !== undefined ||
      JSON.stringify(step.with) !==
        JSON.stringify({
          version: expectedTrivyInputs.version,
          'image-ref': imageRef,
          scanners: expectedTrivyInputs.scanners,
          'vuln-type': expectedTrivyInputs['vuln-type'],
          severity: expectedTrivyInputs.severity,
          'ignore-unfixed': expectedTrivyInputs['ignore-unfixed'],
          'exit-code': expectedTrivyInputs['exit-code'],
          format: expectedTrivyInputs.format,
          'hide-progress': expectedTrivyInputs['hide-progress'],
          timeout: expectedTrivyInputs.timeout,
          cache: expectedTrivyInputs.cache,
          trivyignores: ignores,
        })
    ) {
      throw new Error(
        `${label} native image CI must use the exact pinned OS-only Trivy failure gate`,
      );
    }
  }
  requireOccurrences(
    source,
    /node scripts\/ql3-image-os-vulnerability-policy\.cjs/g,
    2,
    'native image CI must materialize reviewed image-scoped Trivy exceptions',
  );
  requirePattern(
    source,
    /--image=local\s+--output=\$\{\{ runner\.temp \}\}\/ql3-local-\$\{\{ matrix\.image_arch \}\}\.trivyignore\.yaml/,
    'local native image CI must materialize the local exception view',
  );
  requirePattern(
    source,
    /--image=\$\{\{ matrix\.image \}\}\s+--output=\$\{\{ runner\.temp \}\}\/ql3-\$\{\{ matrix\.image \}\}-\$\{\{ matrix\.image_arch \}\}\.trivyignore\.yaml/,
    'cluster native image CI must materialize the selected exception view',
  );
  requirePattern(
    source,
    /^  cluster-image:\s*$/m,
    'QL3 CI must contain a dedicated cluster-image job',
  );
  requirePattern(
    source,
    /runner: ubuntu-24\.04\s+node_arch: x64\s+image_arch: amd64/,
    'cluster image CI must use a native x64 runner',
  );
  requirePattern(
    source,
    /runner: ubuntu-24\.04-arm\s+node_arch: arm64\s+image_arch: arm64/,
    'cluster image CI must use a native arm64 runner',
  );
  requirePattern(
    source,
    /node --test[\s\S]*test\/back\/ql3ClusterImageSbom\.test\.cjs[\s\S]*test\/back\/ql3ClusterImageReleaseAudit\.test\.cjs[\s\S]*test\/back\/ql3ReleaseCandidateContract\.test\.cjs[\s\S]*test\/back\/ql3ReleaseSetContract\.test\.cjs[\s\S]*test\/back\/ql3ReleaseCatalogContract\.test\.cjs[\s\S]*test\/back\/ql3ReleaseCatalogConsumptionCeremony\.test\.cjs[\s\S]*test\/back\/ql3DeploymentLockContract\.test\.cjs/,
    'cluster image CI must run SBOM, candidate, release-set, durable catalog, deployment-lock and workflow negative tests; catalog consumption ceremony is mandatory',
  );
  requirePattern(
    source,
    /pnpm audit:image-release:ql3/,
    'image CI must audit the shared release workflow contract',
  );
  requirePattern(
    source,
    /pnpm audit:deployment-lock-surfaces:ql3/,
    'supply-chain CI must freeze the reviewed deployment image surfaces',
  );
  requirePattern(
    source,
    /test\/back\/ql3VersionTransition\.test\.cjs/,
    'supply-chain CI must run release version transition negative tests',
  );
  requirePattern(
    source,
    /pnpm audit:release-version:ql3/,
    'supply-chain CI must audit the source-derived release version identity',
  );
  requirePattern(
    source,
    /docker build[\s\S]*--file \$\{\{ matrix\.dockerfile \}\}[\s\S]*--target \$\{\{ matrix\.target \}\}/,
    'cluster image CI must build each exact selected Dockerfile target',
  );
  for (const [image, runner, nodeArchitecture, imageArchitecture] of [
    ['control', 'ubuntu-24\\.04', 'x64', 'amd64'],
    ['control', 'ubuntu-24\\.04-arm', 'arm64', 'arm64'],
    ['control-ai', 'ubuntu-24\\.04', 'x64', 'amd64'],
    ['control-ai', 'ubuntu-24\\.04-arm', 'arm64', 'arm64'],
    ['admin', 'ubuntu-24\\.04', 'x64', 'amd64'],
    ['admin', 'ubuntu-24\\.04-arm', 'arm64', 'arm64'],
    ['worker', 'ubuntu-24\\.04', 'x64', 'amd64'],
    ['worker', 'ubuntu-24\\.04-arm', 'arm64', 'arm64'],
  ]) {
    requirePattern(
      source,
      new RegExp(
        `runner: ${runner}\\s+node_arch: ${nodeArchitecture}\\s+image_arch: ${imageArchitecture}\\s+image: ${image}`,
      ),
      `cluster image CI is missing native ${image} ${imageArchitecture}`,
    );
  }
  requireOccurrences(
    source,
    /--image=\$\{\{ matrix\.image \}\}/g,
    2,
    'cluster image CI must select the exact SBOM profile for build and inventory',
  );
  requirePattern(
    source,
    /--read-only[\s\S]*--user \$\{\{ matrix\.runtime_user \}\}[\s\S]*--inventory-root=\/opt\/qinglong\/node_modules/,
    'cluster image CI must reconcile the SBOM with a read-only non-root image inventory',
  );
  requirePattern(
    source,
    /unexpected image contract/,
    'cluster image CI must verify architecture and runtime user',
  );
  requirePattern(
    source,
    /name: Run the bounded Cluster Admin product facade\s+if: matrix\.image == 'admin'\s+env:\s+IMAGE: qinglong3-cluster-admin:ci-\$\{\{ matrix\.image_arch \}\}\s+QL3_CLUSTER_ADMIN_PRODUCT_LIVE: '1'\s+run: node scripts\/ql3-cluster-admin-product-live-contract\.cjs --image="\$\{IMAGE\}"/,
    'native admin image CI must run the bounded product facade contract',
  );
  requirePattern(
    adminProductLiveContract,
    /runOperatorContextContract\(image\);[\s\S]*operatorContext: true,[\s\S]*contextPreflight: true,[\s\S]*contextReadiness: true/,
    'native admin image contract must verify owner-private operator context injection, offline preflight and read-only readiness',
  );
  requirePattern(
    source,
    /^  image-oci:\s*$/m,
    'QL3 CI must contain a multi-architecture OCI evidence job',
  );
  requirePattern(
    source,
    /- image: control\s+dockerfile: deploy\/containers\/ql3-cluster-control\/Dockerfile\s+target: runtime\s+- image: control-ai\s+dockerfile: deploy\/containers\/ql3-cluster-control\/Dockerfile\s+target: runtime-ai\s+- image: admin\s+dockerfile: deploy\/containers\/ql3-cluster-admin\/Dockerfile\s+target: runtime\s+- image: local\s+dockerfile: deploy\/containers\/ql3-local-application\/Dockerfile\s+target: runtime\s+- image: worker\s+dockerfile: deploy\/containers\/ql3-worker\/Dockerfile\s+target: runtime/,
    'OCI evidence CI must build independent control, control-ai, admin, local and worker images',
  );
  requirePattern(
    source,
    /docker\/setup-qemu-action@96fe6ef7f33517b61c61be40b68a1882f3264fb8 # v4/,
    'OCI evidence CI must pin the reviewed QEMU action',
  );
  requirePattern(
    source,
    /docker\/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c # v4/,
    'OCI evidence CI must pin the reviewed Buildx action',
  );
  requirePattern(
    source,
    /--platform linux\/amd64,linux\/arm64[\s\S]*--target \$\{\{ matrix\.target \}\}[\s\S]*--attest type=provenance,mode=max[\s\S]*--attest type=sbom[\s\S]*--output type=oci/,
    'OCI evidence CI must build both platforms with SBOM and maximum provenance',
  );
  requirePattern(
    source,
    /ql3-cluster-oci-layout-audit\.cjs[\s\S]*--expected-revision="\$\{\{ github\.sha \}\}"/,
    'OCI evidence CI must audit the digest graph against the source revision',
  );
  requireOccurrences(
    source,
    /--image=local/g,
    2,
    'local image CI must generate and inventory-check the exact local SBOM profile',
  );
  return {
    images: ['control', 'control-ai', 'admin', 'local', 'worker'],
    nativeArchitectures: ['amd64', 'arm64'],
    runtimeInventory: true,
    clusterAdminProductFacade: true,
    clusterAdminOperatorContext: true,
    clusterAdminContextPreflight: true,
    clusterAdminContextReadiness: true,
    releaseVersionAudit: true,
    deploymentLockMaterialization: true,
    ociAttestations: true,
    osVulnerabilityScan: {
      scanner: 'trivy@0.70.0',
      severities: ['HIGH', 'CRITICAL'],
      packageTypes: ['os'],
      ignoreUnfixed: false,
    },
  };
}

function auditReleaseWorkflow(source) {
  const workflow = yaml.load(source);
  const candidateJob = workflow?.jobs?.['release-candidate'];
  const evidenceJob = workflow?.jobs?.['worker-management-release-evidence'];
  const drEvidenceJob = workflow?.jobs?.['cluster-dr-release-evidence'];
  const osVulnerabilityJob = workflow?.jobs?.['os-vulnerability'];
  const publishJob = workflow?.jobs?.publish;
  const releaseSetJob = workflow?.jobs?.['release-set'];
  if (
    publishJob?.strategy?.matrix?.include !==
    '${{ fromJSON(needs.release-candidate.outputs.publish-matrix) }}'
  ) {
    throw new Error(
      'publisher matrix must come only from the source-derived release candidate contract',
    );
  }
  if (
    osVulnerabilityJob?.strategy?.matrix?.include !==
      '${{ fromJSON(needs.release-candidate.outputs.os-matrix) }}' ||
    osVulnerabilityJob?.needs !== 'release-candidate' ||
    osVulnerabilityJob?.strategy?.['fail-fast'] !== false ||
    osVulnerabilityJob?.['runs-on'] !== '${{ matrix.runner }}' ||
    osVulnerabilityJob?.['timeout-minutes'] !== 45 ||
    JSON.stringify(osVulnerabilityJob?.permissions) !==
      JSON.stringify({ contents: 'read' })
  ) {
    throw new Error(
      'release OS vulnerability matrix must come from the source-derived deployment-family contract with read-only authority',
    );
  }
  requirePattern(
    source,
    /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+version:/,
    'release workflow must support an explicit version input',
  );
  requirePattern(
    source,
    /release_scope:\s+description: Deployment family to publish\s+required: true\s+default: all\s+type: choice\s+options:\s+- local\s+- cluster\s+- all/,
    'release workflow must select one closed local, cluster or all deployment family',
  );
  if (/^  (?:push|pull_request|schedule):/m.test(source)) {
    throw new Error(
      'release workflow must require an explicit protected-tag dispatch',
    );
  }
  if (
    JSON.stringify(workflow?.permissions) !==
      JSON.stringify({ contents: 'read' }) ||
    JSON.stringify(candidateJob?.permissions) !==
      JSON.stringify({ contents: 'read' }) ||
    JSON.stringify(evidenceJob?.permissions) !==
      JSON.stringify({ contents: 'read' }) ||
    JSON.stringify(drEvidenceJob?.permissions) !==
      JSON.stringify({ contents: 'read' }) ||
    JSON.stringify(publishJob?.permissions) !==
      JSON.stringify({
        contents: 'read',
        packages: 'write',
        'id-token': 'write',
        attestations: 'write',
        'artifact-metadata': 'write',
      }) ||
    JSON.stringify(releaseSetJob?.permissions) !==
      JSON.stringify({
        contents: 'read',
        packages: 'write',
        'id-token': 'write',
        attestations: 'write',
        'artifact-metadata': 'write',
      })
  ) {
    throw new Error(
      'release permissions must keep evidence read-only and grant writes only to gated image and release-set publishers',
    );
  }
  if (
    candidateJob?.['runs-on'] !== 'ubuntu-24.04' ||
    candidateJob?.['timeout-minutes'] !== 5 ||
    JSON.stringify(candidateJob?.outputs) !==
      JSON.stringify({
        'cluster-evidence-required':
          '${{ steps.contract.outputs.cluster-evidence-required }}',
        'os-matrix': '${{ steps.contract.outputs.os-matrix }}',
        'publish-matrix': '${{ steps.contract.outputs.publish-matrix }}',
      }) ||
    JSON.stringify(evidenceJob?.['runs-on']) !==
      JSON.stringify([
        'self-hosted',
        'linux',
        'ql3-release-evidence-ephemeral',
      ]) ||
    evidenceJob?.environment !== 'ql3-production-release-evidence' ||
    evidenceJob?.['timeout-minutes'] !== 10 ||
    JSON.stringify(drEvidenceJob?.['runs-on']) !==
      JSON.stringify([
        'self-hosted',
        'linux',
        'ql3-release-evidence-ephemeral',
      ]) ||
    drEvidenceJob?.environment !== 'ql3-production-release-evidence' ||
    drEvidenceJob?.['timeout-minutes'] !== 10 ||
    evidenceJob?.needs !== 'release-candidate' ||
    drEvidenceJob?.needs !== 'release-candidate' ||
    evidenceJob?.if !==
      "needs.release-candidate.outputs.cluster-evidence-required == 'true'" ||
    drEvidenceJob?.if !==
      "needs.release-candidate.outputs.cluster-evidence-required == 'true'" ||
    JSON.stringify(publishJob?.needs) !==
      JSON.stringify([
        'release-candidate',
        'worker-management-release-evidence',
        'cluster-dr-release-evidence',
        'os-vulnerability',
      ]) ||
    typeof publishJob?.if !== 'string' ||
    !/always\(\)[\s\S]*release-candidate\.result == 'success'[\s\S]*os-vulnerability\.result == 'success'[\s\S]*cluster-evidence-required != 'true'[\s\S]*worker-management-release-evidence\.result == 'success'[\s\S]*cluster-dr-release-evidence\.result == 'success'/.test(
      publishJob.if,
    ) ||
    JSON.stringify(releaseSetJob?.needs) !==
      JSON.stringify(['release-candidate', 'publish']) ||
    releaseSetJob?.['runs-on'] !== 'ubuntu-24.04' ||
    releaseSetJob?.['timeout-minutes'] !== 20 ||
    typeof releaseSetJob?.if !== 'string' ||
    !/always\(\)[\s\S]*release-candidate\.result == 'success'[\s\S]*publish\.result == 'success'/.test(
      releaseSetJob.if,
    )
  ) {
    throw new Error(
      'release publisher must always require candidate and OS gates while requiring private HA evidence only for a cluster family; release-set closure must additionally require the complete publish matrix',
    );
  }
  const candidateSteps = candidateJob?.steps;
  if (
    !Array.isArray(candidateSteps) ||
    candidateSteps.length !== 3 ||
    candidateSteps[0]?.uses !==
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803' ||
    candidateSteps[0]?.with?.['persist-credentials'] !== false ||
    candidateSteps[1]?.uses !==
      'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38' ||
    candidateSteps[1]?.with?.['node-version'] !== '24.18.0' ||
    candidateSteps[2]?.id !== 'contract' ||
    !/ql3-release-candidate-contract\.cjs[\s\S]*--mode=create[\s\S]*--version="\$\{RELEASE_VERSION\}"[\s\S]*--source-revision="\$\{GITHUB_SHA\}"[\s\S]*--source-ref="\$\{GITHUB_REF\}"[\s\S]*--release-scope="\$\{RELEASE_SCOPE\}"[\s\S]*GITHUB_OUTPUT/.test(
      candidateSteps[2]?.run ?? '',
    )
  ) {
    throw new Error(
      'release candidate job must derive bounded matrices from the exact tag, revision, version and deployment family',
    );
  }
  const osSteps = osVulnerabilityJob?.steps;
  const trivyStep = osSteps?.[7];
  const uploadStep = osSteps?.[9];
  if (
    !Array.isArray(osSteps) ||
    osSteps.length !== 10 ||
    osSteps[0]?.uses !==
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803' ||
    osSteps[0]?.with?.['persist-credentials'] !== false ||
    osSteps[1]?.uses !==
      'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38' ||
    osSteps[1]?.with?.['node-version'] !== '24.18.0' ||
    osSteps[2]?.uses !==
      'docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c' ||
    !/ql3-image-os-vulnerability-policy\.cjs/.test(osSteps[4]?.run ?? '') ||
    !/docker buildx build[\s\S]*--platform linux\/\$\{\{ matrix\.image_arch \}\}[\s\S]*--file \$\{\{ matrix\.dockerfile \}\}[\s\S]*--target \$\{\{ matrix\.target \}\}[\s\S]*--attest type=provenance,mode=max[\s\S]*--attest type=sbom[\s\S]*--output "type=oci,dest=\$\{RUNNER_TEMP\}\/ql3-native\/image\.oci\.tar"/.test(
      osSteps[5]?.run ?? '',
    ) ||
    !/ql3-image-os-vulnerability-policy\.cjs[\s\S]*--image=\$\{\{ matrix\.image \}\}[\s\S]*--output=\$\{\{ runner\.temp \}\}\/ql3-\$\{\{ matrix\.image \}\}-\$\{\{ matrix\.image_arch \}\}\.trivyignore\.yaml/.test(
      osSteps[6]?.run ?? '',
    ) ||
    trivyStep?.uses !==
      'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25' ||
    trivyStep?.['continue-on-error'] !== undefined ||
    JSON.stringify(trivyStep?.with) !==
      JSON.stringify({
        version: 'v0.70.0',
        input: '${{ runner.temp }}/ql3-native/image.oci.tar',
        scanners: 'vuln',
        'vuln-type': 'os',
        severity: 'HIGH,CRITICAL',
        'ignore-unfixed': 'false',
        'exit-code': '1',
        format: 'table',
        'hide-progress': 'true',
        timeout: '10m0s',
        cache: 'false',
        trivyignores:
          '${{ runner.temp }}/ql3-${{ matrix.image }}-${{ matrix.image_arch }}.trivyignore.yaml',
      }) ||
    !/mkdir "\$\{RUNNER_TEMP\}\/ql3-native\/layout"[\s\S]*tar -xf "\$\{RUNNER_TEMP\}\/ql3-native\/image\.oci\.tar"[\s\S]*-C "\$\{RUNNER_TEMP\}\/ql3-native\/layout"[\s\S]*ql3-image-release-bundle\.cjs[\s\S]*--mode=record-native[\s\S]*--image=\$\{\{ matrix\.image \}\}[\s\S]*--platform=linux\/\$\{\{ matrix\.image_arch \}\}[\s\S]*--layout=\$\{\{ runner\.temp \}\}\/ql3-native\/layout[\s\S]*--expected-revision=\$\{\{ github\.sha \}\}[\s\S]*--evidence=\$\{\{ runner\.temp \}\}\/ql3-native\/evidence\.json[\s\S]*rm "\$\{RUNNER_TEMP\}\/ql3-native\/image\.oci\.tar"/.test(
      osSteps[8]?.run ?? '',
    ) ||
    uploadStep?.uses !==
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a' ||
    JSON.stringify(uploadStep?.with) !==
      JSON.stringify({
        name: 'ql3-release-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.image }}-${{ matrix.image_arch }}',
        path: '${{ runner.temp }}/ql3-native',
        'if-no-files-found': 'error',
        'retention-days': 1,
        'compression-level': 0,
        overwrite: false,
        'include-hidden-files': false,
      })
  ) {
    throw new Error(
      'release OS vulnerability job must build once, scan that exact OCI layout tar and upload only bound immutable evidence',
    );
  }
  if (
    !Array.isArray(drEvidenceJob?.steps) ||
    drEvidenceJob.steps.length !== 3 ||
    drEvidenceJob.steps[0]?.uses !==
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803' ||
    drEvidenceJob.steps[0]?.with?.['persist-credentials'] !== false ||
    drEvidenceJob.steps[1]?.uses !==
      'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38' ||
    drEvidenceJob.steps[1]?.with?.['node-version'] !== '24.18.0' ||
    typeof drEvidenceJob.steps[2]?.run !== 'string'
  ) {
    throw new Error(
      'private disaster-recovery evidence job must contain only the reviewed credential-free checkout, Node setup and audit steps',
    );
  }
  const publishSteps = publishJob?.steps;
  const mergeIndex = publishSteps?.findIndex(
    (step) => step.id === 'bundle' && /--mode=merge/.test(step.run || ''),
  );
  const loginIndex = publishSteps?.findIndex(
    (step) =>
      step.uses ===
      'docker/login-action@06fb636fac595d6fb4b28a5dfcb21a6f5091859c',
  );
  const importIndex = publishSteps?.findIndex(
    (step) => step.id === 'push' && /image import/.test(step.run || ''),
  );
  const recordIndex = publishSteps?.findIndex((step) =>
    /Record the fully verified image/.test(step.name || ''),
  );
  const recordUploadIndex = publishSteps?.findIndex(
    (step) =>
      step.uses ===
        'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a' &&
      /same-run verified image record/.test(step.name || ''),
  );
  if (
    !Array.isArray(publishSteps) ||
    publishSteps[0]?.uses !==
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803' ||
    publishSteps[0]?.with?.['persist-credentials'] !== false ||
    mergeIndex < 0 ||
    loginIndex <= mergeIndex ||
    importIndex <= loginIndex ||
    recordIndex !== publishSteps.length - 2 ||
    recordUploadIndex !== publishSteps.length - 1 ||
    publishSteps.some((step) => /\bimage copy\b/.test(step.run || '')) ||
    publishSteps.some(
      (step) =>
        step.uses?.startsWith('docker/build-push-action@') ||
        /(?:^|\n)\s*docker (?:build|buildx build)\b/.test(step.run || ''),
    )
  ) {
    throw new Error(
      'privileged image publisher must re-audit, import and verify the scanned bundle without any rebuild or tag promotion before release-set closure',
    );
  }
  if (
    !/ql3-release-set-contract\.cjs[\s\S]*--mode=record-image[\s\S]*--version="\$\{RELEASE_VERSION\}"[\s\S]*--source-revision="\$\{GITHUB_SHA\}"[\s\S]*--source-ref="\$\{GITHUB_REF\}"[\s\S]*--release-scope="\$\{RELEASE_SCOPE\}"[\s\S]*--repository-owner="\$\{owner\}"[\s\S]*--candidate="\$\{RUNNER_TEMP\}\/\$\{\{ matrix\.repository \}\}-release-candidate-contract\.json"[\s\S]*--image="\$\{\{ matrix\.image \}\}"[\s\S]*--digest="\$\{DIGEST\}"/.test(
      publishSteps[recordIndex]?.run ?? '',
    ) ||
    JSON.stringify(publishSteps[recordUploadIndex]?.with) !==
      JSON.stringify({
        name: 'ql3-release-record-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.image }}',
        path: '${{ runner.temp }}/release-record/${{ matrix.image }}.json',
        'if-no-files-found': 'error',
        'retention-days': 1,
        'compression-level': 0,
        overwrite: false,
        'include-hidden-files': false,
      })
  ) {
    throw new Error(
      'each image publisher must upload one exact same-run digest record only after all image verification',
    );
  }
  const releaseSetSteps = releaseSetJob?.steps;
  if (
    !Array.isArray(releaseSetSteps) ||
    releaseSetSteps.length !== 15 ||
    releaseSetSteps[0]?.uses !==
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803' ||
    releaseSetSteps[0]?.with?.['persist-credentials'] !== false ||
    releaseSetSteps[1]?.uses !==
      'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38' ||
    releaseSetSteps[1]?.with?.['node-version'] !== '24.18.0' ||
    releaseSetSteps[2]?.uses !==
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c' ||
    JSON.stringify(releaseSetSteps[2]?.with) !==
      JSON.stringify({
        pattern:
          'ql3-release-record-${{ github.run_id }}-${{ github.run_attempt }}-*',
        path: '${{ runner.temp }}/release-records',
        'merge-multiple': true,
      }) ||
    releaseSetSteps[3]?.id !== 'release-set' ||
    !/ql3-release-candidate-contract\.cjs[\s\S]*--mode=create[\s\S]*ql3-release-set-contract\.cjs[\s\S]*--mode=aggregate[\s\S]*--records="\$\{RUNNER_TEMP\}\/release-records"[\s\S]*ql3-release-set-contract\.cjs[\s\S]*--mode=audit[\s\S]*--report="\$\{report\}"[\s\S]*ql3-release-set-contract\.cjs[\s\S]*--mode=inspect[\s\S]*ql3-release-catalog-contract\.cjs[\s\S]*--mode=plan[\s\S]*--source-repository="\$\{source_repository\}"[\s\S]*--release-set="\$\{report\}"[\s\S]*GITHUB_OUTPUT/.test(
      releaseSetSteps[3]?.run ?? '',
    ) ||
    !/v0\.11\.5\/regctl-linux-amd64[\s\S]*c93aa7638749f5aaac1a8e01787321889c78f0101809bb2880343478d0ba0467[\s\S]*sha256sum --check --strict/.test(
      releaseSetSteps[4]?.run ?? '',
    ) ||
    releaseSetSteps[5]?.uses !==
      'sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6' ||
    releaseSetSteps[6]?.uses !==
      'docker/login-action@06fb636fac595d6fb4b28a5dfcb21a6f5091859c' ||
    !/for \(const image of report\.images\)[\s\S]*image\.reference[\s\S]*image\.versionTag, image\.sourceTag[\s\S]*release tag already points at another digest[\s\S]*\['image', 'copy', state\.image\.reference, state\.tag\][\s\S]*promoted tag does not resolve to the release-set digest/.test(
      releaseSetSteps[7]?.run ?? '',
    ) ||
    releaseSetSteps[8]?.uses !==
      'actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6' ||
    JSON.stringify(releaseSetSteps[8]?.with) !==
      JSON.stringify({
        'subject-path': '${{ steps.release-set.outputs.report }}',
      }) ||
    releaseSetSteps[9]?.id !== 'catalog' ||
    !/artifact put[\s\S]*--artifact-type "\$\{artifact_type\}"[\s\S]*--file-media-type "\$\{file_media_type\}"[\s\S]*--file "\$\{RELEASE_SET\}"[\s\S]*--file-title[\s\S]*--strip-dirs[\s\S]*dev\.qinglong\.release\.scope[\s\S]*org\.opencontainers\.image\.revision[\s\S]*org\.opencontainers\.image\.source[\s\S]*org\.opencontainers\.image\.version[\s\S]*image digest "\$\{discovery_tag\}"[\s\S]*artifact get --file "\$\{file_name\}" "\$\{immutable_reference\}"[\s\S]*cmp --silent "\$\{RELEASE_SET\}" "\$\{roundtrip\}"[\s\S]*manifest get "\$\{immutable_reference\}" --format raw-body[\s\S]*GITHUB_OUTPUT/.test(
      releaseSetSteps[9]?.run ?? '',
    ) ||
    !/cosign sign --yes "\$\{CATALOG\}@\$\{DIGEST\}"/.test(
      releaseSetSteps[10]?.run ?? '',
    ) ||
    releaseSetSteps[11]?.uses !==
      'actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6' ||
    JSON.stringify(releaseSetSteps[11]?.with) !==
      JSON.stringify({
        'subject-name': '${{ steps.catalog.outputs.repository }}',
        'subject-digest': '${{ steps.catalog.outputs.digest }}',
        'push-to-registry': true,
      }) ||
    releaseSetSteps[12]?.id !== 'catalog-receipt' ||
    !/cosign verify[\s\S]*--certificate-identity "\$\{certificate_identity\}"[\s\S]*--certificate-oidc-issuer "https:\/\/token\.actions\.githubusercontent\.com"[\s\S]*"\$\{CATALOG\}@\$\{DIGEST\}"[\s\S]*gh attestation verify "oci:\/\/\$\{CATALOG\}@\$\{DIGEST\}"[\s\S]*--source-digest "\$\{GITHUB_SHA\}"[\s\S]*--source-ref "\$\{GITHUB_REF\}"[\s\S]*--deny-self-hosted-runners[\s\S]*--bundle-from-oci[\s\S]*ql3-release-catalog-contract\.cjs[\s\S]*--mode=receipt[\s\S]*--manifest-digest="\$\{DIGEST\}"[\s\S]*ql3-release-catalog-contract\.cjs[\s\S]*--mode=audit[\s\S]*GITHUB_OUTPUT/.test(
      releaseSetSteps[12]?.run ?? '',
    ) ||
    releaseSetSteps[13]?.uses !==
      'actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6' ||
    JSON.stringify(releaseSetSteps[13]?.with) !==
      JSON.stringify({
        'subject-path': '${{ steps.catalog-receipt.outputs.receipt }}',
      }) ||
    releaseSetSteps[14]?.uses !==
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a' ||
    JSON.stringify(releaseSetSteps[14]?.with) !==
      JSON.stringify({
        name: 'ql3-release-set-${{ inputs.version }}-${{ inputs.release_scope }}',
        path: '${{ steps.release-set.outputs.bundle }}',
        'if-no-files-found': 'error',
        'retention-days': 90,
        'compression-level': 0,
        overwrite: false,
        'include-hidden-files': false,
      })
  ) {
    throw new Error(
      'release-set job must download only same-run records, independently inspect, durably publish and attest one no-overwrite deployment lock bundle',
    );
  }
  if (
    !Array.isArray(evidenceJob?.steps) ||
    evidenceJob.steps.length !== 3 ||
    evidenceJob.steps[0]?.uses !==
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803' ||
    evidenceJob.steps[0]?.with?.['persist-credentials'] !== false ||
    evidenceJob.steps[1]?.uses !==
      'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38' ||
    evidenceJob.steps[1]?.with?.['node-version'] !== '24.18.0' ||
    typeof evidenceJob.steps[2]?.run !== 'string'
  ) {
    throw new Error(
      'private evidence job must contain only the reviewed credential-free checkout, Node setup and audit steps',
    );
  }
  if (/actions\/cache@/.test(source)) {
    throw new Error(
      'release workflow must never persist private evidence through caches',
    );
  }
  requirePattern(
    source,
    /GITHUB_REF_TYPE}" != "tag"[\s\S]*GITHUB_REF_NAME}" != "v\$\{RELEASE_VERSION\}"/,
    'private evidence gate must bind dispatch version to the exact tag',
  );
  requireExactOccurrences(
    source,
    /evidence_dir="\/run\/qinglong3-release-evidence\/\$\{GITHUB_SHA\}"/g,
    2,
    'the two private evidence jobs must each use exactly one commit-scoped runner mount',
  );
  requirePattern(
    source,
    /ql3-worker-credential-management-release-gate\.cjs[\s\S]*--report="\$\{evidence_dir\}\/worker-management-release-evidence\.json"[\s\S]*--ceremony-report="\$\{evidence_dir\}\/worker-management-ceremony\.json"[\s\S]*--durable-audit-report="\$\{evidence_dir\}\/worker-management-durable-audit\.json"[\s\S]*--pki-rotation-report="\$\{evidence_dir\}\/worker-management-pki-rotation-v2\.json"[\s\S]*--ca-rollover-report="\$\{evidence_dir\}\/worker-management-ca-rollover\.json"[\s\S]*--source-commit="\$\{GITHUB_SHA\}"[\s\S]*--release-version="\$\{RELEASE_VERSION\}"/,
    'private evidence gate must re-audit the exact five files and bind the release identity',
  );
  requirePattern(
    source,
    /ql3-cloudnativepg-backup-audit\.cjs[\s\S]*ql3-barman-cloud-supply-chain-audit\.cjs[\s\S]*ql3-cert-manager-selection-audit\.cjs[\s\S]*ql3-cloudnativepg-dr-release-gate\.cjs[\s\S]*--report="\$\{report\}"[\s\S]*--source-commit="\$\{GITHUB_SHA\}"[\s\S]*--release-version="\$\{RELEASE_VERSION\}"/,
    'private disaster-recovery gate must re-audit all static locks and bind the exact report to the release identity',
  );
  for (const action of [
    ['actions/checkout', 'd23441a48e516b6c34aea4fa41551a30e30af803', 'v6'],
    ['actions/setup-node', '249970729cb0ef3589644e2896645e5dc5ba9c38', 'v6'],
    [
      'docker/setup-buildx-action',
      'bb05f3f5519dd87d3ba754cc423b652a5edd6d2c',
      'v4',
    ],
    ['docker/login-action', '06fb636fac595d6fb4b28a5dfcb21a6f5091859c', 'v4'],
    [
      'actions/upload-artifact',
      '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'v7.0.1',
    ],
    [
      'actions/download-artifact',
      '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
      'v8.0.1',
    ],
    [
      'aquasecurity/trivy-action',
      'ed142fd0673e97e23eac54620cfb913e5ce36c25',
      'v0.36.0',
    ],
    [
      'sigstore/cosign-installer',
      '6f9f17788090df1f26f669e9d70d6ae9567deba6',
      'v4.1.2',
    ],
    ['actions/attest', 'f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6', 'v4'],
  ]) {
    const [repository, sha, version] = action;
    requirePattern(
      source,
      new RegExp(
        `uses: ${repository.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        )}@${sha} # ${version.replace('.', '\\.')}`,
      ),
      `release workflow is missing immutable action ${repository}@${sha}`,
    );
  }
  requireOccurrences(
    source,
    /uses: actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6/g,
    6,
    'all release jobs must pin the reviewed immutable checkout action',
  );
  requireOccurrences(
    source,
    /uses: actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6/g,
    6,
    'all release jobs must pin the reviewed immutable Node setup action',
  );
  requireOccurrences(
    source,
    /uses: sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6 # v4\.1\.2/g,
    2,
    'image and release-catalog publishers must both pin the reviewed Cosign installer',
  );
  requirePattern(
    source,
    /name: Recreate and audit the source-derived release candidate contract[\s\S]*ql3-release-candidate-contract\.cjs[\s\S]*--mode=create[\s\S]*--version="\$\{RELEASE_VERSION\}"[\s\S]*--source-revision="\$\{GITHUB_SHA\}"[\s\S]*--source-ref="\$\{GITHUB_REF\}"[\s\S]*--release-scope="\$\{RELEASE_SCOPE\}"[\s\S]*ql3-release-candidate-contract\.cjs[\s\S]*--mode=audit[\s\S]*--report="\$\{contract\}"/,
    'publisher must recreate and independently audit its exact source-derived candidate contract',
  );
  requirePattern(
    source,
    /IMAGE_REPOSITORY: \$\{\{ matrix\.repository \}\}[\s\S]*image="ghcr\.io\/\$\{owner\}\/\$\{IMAGE_REPOSITORY\}"/,
    'release identity must derive each exact matrix repository',
  );
  requirePattern(
    source,
    /ql3-cluster-image-sbom\.cjs\s+--image=\$\{\{ matrix\.image \}\}\s+--output=\$\{\{ runner\.temp \}\}\/\$\{\{ matrix\.repository \}\}\.cdx\.json/,
    'release workflow must generate the selected image SBOM',
  );
  requirePattern(
    source,
    /npm audit\s+--omit=dev\s+--audit-level=high\s+--prefix=\$\{\{ matrix\.runtime_root \}\}/,
    'release workflow must reject high or critical production dependency advisories',
  );
  requirePattern(
    source,
    /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c[\s\S]*name: ql3-release-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.image \}\}-amd64[\s\S]*actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c[\s\S]*name: ql3-release-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.image \}\}-arm64/,
    'publisher must download the exact same-run scanned native artifacts',
  );
  requirePattern(
    source,
    /ql3-image-release-bundle\.cjs[\s\S]*--mode=merge[\s\S]*--amd64-layout=\$\{RUNNER_TEMP\}\/native\/amd64\/layout[\s\S]*--arm64-layout=\$\{RUNNER_TEMP\}\/native\/arm64\/layout[\s\S]*--expected-revision=\$\{GITHUB_SHA\}[\s\S]*--predicate=\$\{RUNNER_TEMP\}\/\$\{\{ matrix\.repository \}\}-os-vulnerability\.json/,
    'publisher must merge and re-audit the two scanned layouts without rebuilding',
  );
  requirePattern(
    source,
    /v0\.11\.5\/regctl-linux-amd64[\s\S]*c93aa7638749f5aaac1a8e01787321889c78f0101809bb2880343478d0ba0467[\s\S]*sha256sum --check --strict/,
    'publisher must checksum-pin the exact regctl OCI copier',
  );
  requireExactOccurrences(
    source,
    /c93aa7638749f5aaac1a8e01787321889c78f0101809bb2880343478d0ba0467/g,
    2,
    'both image and release-set publishers must checksum-pin the exact regctl OCI copier',
  );
  requirePattern(
    source,
    /regctl[\s\S]*image import "\$\{IMAGE\}@\$\{DIGEST\}" "\$\{ARCHIVE\}"[\s\S]*image digest "\$\{IMAGE\}@\$\{DIGEST\}"/,
    'publisher must import the audited OCI graph by digest without rebuilding or tagging it',
  );
  requirePattern(
    source,
    /\^sha256:\[0-9a-f\]\{64\}\$/,
    'release workflow must reject malformed image digests',
  );
  requirePattern(
    source,
    /cosign sign --yes "\$\{IMAGE\}@\$\{DIGEST\}"/,
    'release workflow must keylessly sign the immutable image digest',
  );
  requireOccurrences(
    source,
    /uses: actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6 # v4/g,
    7,
    'release workflow must create four image attestations plus release-set, durable catalog and receipt provenance',
  );
  requireOccurrences(
    source,
    /push-to-registry: true/g,
    5,
    'all image and durable-catalog OCI attestations must be pushed beside their subject',
  );
  requirePattern(
    source,
    /sbom-path: \$\{\{ runner\.temp \}\}\/\$\{\{ matrix\.repository \}\}\.cdx\.json/,
    'release workflow must attest the reviewed application SBOM',
  );
  requirePattern(
    source,
    /predicate-type: https:\/\/qinglong\.dev\/attestations\/image-os-vulnerability\/v1\s+predicate-path: \$\{\{ runner\.temp \}\}\/\$\{\{ matrix\.repository \}\}-os-vulnerability\.json/,
    'release workflow must attest the digest-bound OS vulnerability evidence',
  );
  requirePattern(
    source,
    /predicate-type: https:\/\/qinglong\.dev\/attestations\/release-candidate-contract\/v1\s+predicate-path: \$\{\{ runner\.temp \}\}\/\$\{\{ matrix\.repository \}\}-release-candidate-contract\.json/,
    'release workflow must attest the source-derived release candidate contract',
  );
  requirePattern(
    source,
    /subject-digest: \$\{\{ steps\.push\.outputs\.digest \}\}/,
    'release attestations must bind the pushed digest',
  );
  requirePattern(
    source,
    /docker buildx imagetools inspect --raw "\$\{IMAGE\}@\$\{DIGEST\}"[\s\S]*ql3-cluster-remote-manifest-audit\.cjs[\s\S]*--expected-image="\$\{IMAGE\}"[\s\S]*--expected-digest="\$\{DIGEST\}"/,
    'release workflow must audit the published digest manifest and attestation bindings',
  );
  requirePattern(
    source,
    /name: Verify local rollout compatibility against the pushed digest\s+if: matrix\.image == 'local'[\s\S]*pnpm --filter @qinglong\/local-owner-cli check[\s\S]*docker pull "\$\{IMAGE\}@\$\{DIGEST\}"[\s\S]*ql3-local-compose-rollout-live-contract\.cjs[\s\S]*--image="\$\{IMAGE\}@\$\{DIGEST\}"[\s\S]*--profile=edge[\s\S]*ql3-local-compose-rollout-live-contract\.cjs[\s\S]*--profile=standalone/,
    'local release must apply and stop both Profiles against the pushed digest',
  );
  requirePattern(
    source,
    /certificate_identity="https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/ql3-image-release\.yml@\$\{GITHUB_REF\}"[\s\S]*cosign verify[\s\S]*--certificate-identity "\$\{certificate_identity\}"[\s\S]*--certificate-oidc-issuer "https:\/\/token\.actions\.githubusercontent\.com"[\s\S]*"\$\{IMAGE\}@\$\{DIGEST\}"/,
    'release workflow must verify the exact keyless workflow identity and OIDC issuer',
  );
  requireOccurrences(
    source,
    /gh attestation verify "oci:\/\/\$\{IMAGE\}@\$\{DIGEST\}"/g,
    4,
    'release workflow must independently verify provenance, CycloneDX, OS vulnerability and candidate attestations',
  );
  for (const [pattern, finding] of [
    [
      /--repo "\$\{GITHUB_REPOSITORY\}"/g,
      'GitHub attestation verification must bind the repository',
    ],
    [
      /--signer-workflow "\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/ql3-image-release\.yml"/g,
      'GitHub attestation verification must bind the signer workflow',
    ],
    [
      /--source-digest "\$\{GITHUB_SHA\}"/g,
      'GitHub attestation verification must bind the source commit',
    ],
    [
      /--source-ref "\$\{GITHUB_REF\}"/g,
      'GitHub attestation verification must bind the source ref',
    ],
    [
      /--deny-self-hosted-runners/g,
      'GitHub attestation verification must reject self-hosted builders',
    ],
    [
      /--bundle-from-oci/g,
      'GitHub attestation verification must read the published OCI bundle',
    ],
  ]) {
    requireOccurrences(source, pattern, 5, finding);
  }
  requirePattern(
    source,
    /--predicate-type "https:\/\/cyclonedx\.org\/bom"/,
    'release workflow must verify the CycloneDX predicate type explicitly',
  );
  requirePattern(
    source,
    /--predicate-type "https:\/\/qinglong\.dev\/attestations\/image-os-vulnerability\/v1"/,
    'release workflow must verify the OS vulnerability predicate type explicitly',
  );
  requirePattern(
    source,
    /--predicate-type "https:\/\/qinglong\.dev\/attestations\/release-candidate-contract\/v1"/,
    'release workflow must verify the release candidate predicate type explicitly',
  );
  requirePattern(
    source,
    /release-set:\s+name: Close and publish the complete deployment release set[\s\S]*needs:[\s\S]*- publish[\s\S]*name: Promote tags only after the complete set is verified[\s\S]*for \(const image of report\.images\)[\s\S]*image\.versionTag, image\.sourceTag[\s\S]*image', 'copy'[\s\S]*name: Attest the complete release-set file provenance[\s\S]*name: Publish and round-trip the durable OCI release catalog[\s\S]*name: Keylessly sign the immutable release-catalog digest[\s\S]*name: Attest durable release-catalog provenance[\s\S]*name: Verify the durable catalog and create its immutable receipt[\s\S]*name: Attest the immutable release-catalog receipt[\s\S]*name: Publish the deployment digest lock/,
    'release tags, durable OCI catalog and deployment bundle must be published only after every selected digest record is complete',
  );
  return {
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
    },
    releaseSet: {
      sourceDerived: true,
      sameRunRecords: true,
      exactScopeClosure: true,
      standaloneInspection: true,
      tagPromotionAuthority: 'complete_verified_release_set',
      fileProvenanceAttested: true,
      artifactRetentionDays: 90,
      crossRepositoryAtomicity: false,
    },
    durableCatalog: {
      repository: 'qinglong3-release-catalog',
      artifactType: 'application/vnd.qinglong.release-set.v1+json',
      basenameOnly: true,
      crossRunnerDeterministic: true,
      byteExactRoundTrip: true,
      keylessSignatureVerified: true,
      githubProvenanceVerified: true,
      discoveryTagAuthority: 'none',
      immutableDigestAuthority: 'verified',
      receiptAttested: true,
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
      'release-tags',
    ],
  };
}

function auditClusterImageRelease(root = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(root);
  const ci = auditClusterImageCiWorkflow(
    readBoundedText(path.join(resolvedRoot, CI_WORKFLOW_PATH)),
    readBoundedText(
      path.join(
        resolvedRoot,
        'scripts/ql3-cluster-admin-product-live-contract.cjs',
      ),
    ),
  );
  const release = auditReleaseWorkflow(
    readBoundedText(path.join(resolvedRoot, RELEASE_WORKFLOW_PATH)),
  );
  return { ci, release };
}

function main() {
  const report = auditClusterImageRelease(process.argv[2] || DEFAULT_ROOT);
  process.stdout.write(`${JSON.stringify({ ok: true, ...report })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  auditClusterImageCiWorkflow,
  auditClusterImageRelease,
  auditReleaseWorkflow,
};
