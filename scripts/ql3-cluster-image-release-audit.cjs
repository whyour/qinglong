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
      dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
      target: 'runtime',
    },
    {
      runner: 'ubuntu-24.04-arm',
      node_arch: 'arm64',
      image_arch: 'arm64',
      image: 'control',
      dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
      target: 'runtime',
    },
    {
      runner: 'ubuntu-24.04',
      node_arch: 'x64',
      image_arch: 'amd64',
      image: 'control-ai',
      dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
      target: 'runtime-ai',
    },
    {
      runner: 'ubuntu-24.04-arm',
      node_arch: 'arm64',
      image_arch: 'arm64',
      image: 'control-ai',
      dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
      target: 'runtime-ai',
    },
    {
      runner: 'ubuntu-24.04',
      node_arch: 'x64',
      image_arch: 'amd64',
      image: 'admin',
      dockerfile: 'deploy/containers/ql3-cluster-admin/Dockerfile',
      target: 'runtime',
    },
    {
      runner: 'ubuntu-24.04-arm',
      node_arch: 'arm64',
      image_arch: 'arm64',
      image: 'admin',
      dockerfile: 'deploy/containers/ql3-cluster-admin/Dockerfile',
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
      'image CI matrices must contain only exact control/control-ai/admin/local amd64/arm64 evidence targets',
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
      'qinglong3-cluster-${{ matrix.image }}:ci-${{ matrix.image_arch }}',
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
    /node --test test\/back\/ql3ClusterImageSbom\.test\.cjs test\/back\/ql3ClusterImageReleaseAudit\.test\.cjs/,
    'cluster image CI must run SBOM and release-contract negative tests',
  );
  requirePattern(
    source,
    /pnpm audit:image-release:ql3/,
    'image CI must audit the shared release workflow contract',
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
    /--read-only[\s\S]*--user 10001:10001[\s\S]*--inventory-root=\/opt\/qinglong\/node_modules/,
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
    /runOperatorContextContract\(image\);[\s\S]*operatorContext: true,[\s\S]*contextPreflight: true/,
    'native admin image contract must verify owner-private operator context injection and offline preflight',
  );
  requirePattern(
    source,
    /^  image-oci:\s*$/m,
    'QL3 CI must contain a multi-architecture OCI evidence job',
  );
  requirePattern(
    source,
    /- image: control\s+dockerfile: deploy\/containers\/ql3-cluster-control\/Dockerfile\s+target: runtime\s+- image: control-ai\s+dockerfile: deploy\/containers\/ql3-cluster-control\/Dockerfile\s+target: runtime-ai\s+- image: admin\s+dockerfile: deploy\/containers\/ql3-cluster-admin\/Dockerfile\s+target: runtime\s+- image: local\s+dockerfile: deploy\/containers\/ql3-local-application\/Dockerfile\s+target: runtime/,
    'OCI evidence CI must build independent control, control-ai, admin and local images',
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
    images: ['control', 'control-ai', 'admin', 'local'],
    nativeArchitectures: ['amd64', 'arm64'],
    runtimeInventory: true,
    clusterAdminProductFacade: true,
    clusterAdminOperatorContext: true,
    clusterAdminContextPreflight: true,
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
  const evidenceJob = workflow?.jobs?.['worker-management-release-evidence'];
  const drEvidenceJob = workflow?.jobs?.['cluster-dr-release-evidence'];
  const osVulnerabilityJob = workflow?.jobs?.['os-vulnerability'];
  const publishJob = workflow?.jobs?.publish;
  const expectedReleaseMatrix = [
    {
      image: 'control',
      repository: 'qinglong3-cluster-control',
      runtime_root:
        'deploy/containers/ql3-cluster-control/runtime-dependencies',
    },
    {
      image: 'control-ai',
      repository: 'qinglong3-cluster-control-ai',
      runtime_root:
        'deploy/containers/ql3-cluster-control/runtime-dependencies',
    },
    {
      image: 'admin',
      repository: 'qinglong3-cluster-admin',
      runtime_root: 'deploy/containers/ql3-cluster-admin/runtime-dependencies',
    },
    {
      image: 'local',
      repository: 'qinglong3-local-application',
      runtime_root:
        'deploy/containers/ql3-local-application/runtime-dependencies',
    },
  ];
  const expectedOsVulnerabilityMatrix = [
    {
      image: 'control',
      runner: 'ubuntu-24.04',
      node_arch: 'x64',
      image_arch: 'amd64',
      dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
      target: 'runtime',
    },
    {
      image: 'control',
      runner: 'ubuntu-24.04-arm',
      node_arch: 'arm64',
      image_arch: 'arm64',
      dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
      target: 'runtime',
    },
    {
      image: 'control-ai',
      runner: 'ubuntu-24.04',
      node_arch: 'x64',
      image_arch: 'amd64',
      dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
      target: 'runtime-ai',
    },
    {
      image: 'control-ai',
      runner: 'ubuntu-24.04-arm',
      node_arch: 'arm64',
      image_arch: 'arm64',
      dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
      target: 'runtime-ai',
    },
    {
      image: 'admin',
      runner: 'ubuntu-24.04',
      node_arch: 'x64',
      image_arch: 'amd64',
      dockerfile: 'deploy/containers/ql3-cluster-admin/Dockerfile',
      target: 'runtime',
    },
    {
      image: 'admin',
      runner: 'ubuntu-24.04-arm',
      node_arch: 'arm64',
      image_arch: 'arm64',
      dockerfile: 'deploy/containers/ql3-cluster-admin/Dockerfile',
      target: 'runtime',
    },
    {
      image: 'local',
      runner: 'ubuntu-24.04',
      node_arch: 'x64',
      image_arch: 'amd64',
      dockerfile: 'deploy/containers/ql3-local-application/Dockerfile',
      target: 'runtime',
    },
    {
      image: 'local',
      runner: 'ubuntu-24.04-arm',
      node_arch: 'arm64',
      image_arch: 'arm64',
      dockerfile: 'deploy/containers/ql3-local-application/Dockerfile',
      target: 'runtime',
    },
  ];
  if (
    JSON.stringify(publishJob?.strategy?.matrix?.include) !==
    JSON.stringify(expectedReleaseMatrix)
  ) {
    throw new Error(
      'release workflow matrix must contain only exact control, control-ai, admin and local image authorities',
    );
  }
  if (
    JSON.stringify(osVulnerabilityJob?.strategy?.matrix?.include) !==
      JSON.stringify(expectedOsVulnerabilityMatrix) ||
    osVulnerabilityJob?.strategy?.['fail-fast'] !== false ||
    osVulnerabilityJob?.['runs-on'] !== '${{ matrix.runner }}' ||
    osVulnerabilityJob?.['timeout-minutes'] !== 45 ||
    JSON.stringify(osVulnerabilityJob?.permissions) !==
      JSON.stringify({ contents: 'read' })
  ) {
    throw new Error(
      'release OS vulnerability matrix must scan exact control, control-ai, admin and local amd64/arm64 candidates with read-only authority',
    );
  }
  requirePattern(
    source,
    /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+version:/,
    'release workflow must support an explicit version input',
  );
  if (/^  (?:push|pull_request|schedule):/m.test(source)) {
    throw new Error(
      'release workflow must require an explicit protected-tag dispatch',
    );
  }
  if (
    JSON.stringify(workflow?.permissions) !==
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
      })
  ) {
    throw new Error(
      'release permissions must keep evidence read-only and grant writes only to the gated publisher',
    );
  }
  if (
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
    JSON.stringify(publishJob?.needs) !==
      JSON.stringify([
        'worker-management-release-evidence',
        'cluster-dr-release-evidence',
        'os-vulnerability',
      ]) ||
    publishJob?.if !== undefined
  ) {
    throw new Error(
      'release publisher must depend on both protected ephemeral private evidence jobs',
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
  const promotionIndex = publishSteps?.findIndex((step) =>
    /Promote only the verified digest/.test(step.name || ''),
  );
  if (
    !Array.isArray(publishSteps) ||
    publishSteps[0]?.uses !==
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803' ||
    publishSteps[0]?.with?.['persist-credentials'] !== false ||
    mergeIndex < 0 ||
    loginIndex <= mergeIndex ||
    importIndex <= loginIndex ||
    promotionIndex !== publishSteps.length - 1 ||
    publishSteps.filter((step) => /\bimage copy\b/.test(step.run || ''))
      .length !== 1 ||
    publishSteps.some(
      (step) =>
        step.uses?.startsWith('docker/build-push-action@') ||
        /(?:^|\n)\s*docker (?:build|buildx build)\b/.test(step.run || ''),
    )
  ) {
    throw new Error(
      'privileged publisher must re-audit, import and verify the scanned bundle without any rebuild before final tag promotion',
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
    4,
    'all release jobs must pin the reviewed immutable checkout action',
  );
  requireOccurrences(
    source,
    /uses: actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6/g,
    4,
    'all release jobs must pin the reviewed immutable Node setup action',
  );
  requirePattern(
    source,
    /- image: control\s+repository: qinglong3-cluster-control\s+runtime_root: deploy\/containers\/ql3-cluster-control\/runtime-dependencies/,
    'release workflow must publish the exact control image authority',
  );
  requirePattern(
    source,
    /- image: control-ai\s+repository: qinglong3-cluster-control-ai\s+runtime_root: deploy\/containers\/ql3-cluster-control\/runtime-dependencies/,
    'release workflow must publish the exact optional control-ai image authority',
  );
  requirePattern(
    source,
    /- image: admin\s+repository: qinglong3-cluster-admin\s+runtime_root: deploy\/containers\/ql3-cluster-admin\/runtime-dependencies/,
    'release workflow must publish the exact admin image authority',
  );
  requirePattern(
    source,
    /- image: local\s+repository: qinglong3-local-application\s+runtime_root: deploy\/containers\/ql3-local-application\/runtime-dependencies/,
    'release workflow must publish the exact local image authority',
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
    3,
    'release workflow must create provenance, SBOM and OS vulnerability attestations',
  );
  requireOccurrences(
    source,
    /push-to-registry: true/g,
    3,
    'all GitHub attestations must be pushed beside the OCI image',
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
    3,
    'release workflow must independently verify provenance, CycloneDX and OS vulnerability attestations',
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
    requireOccurrences(source, pattern, 3, finding);
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
    /name: Promote only the verified digest to immutable release tags[\s\S]*image copy "\$\{IMAGE\}@\$\{DIGEST\}" "\$\{IMAGE\}:\$\{VERSION\}"[\s\S]*image copy "\$\{IMAGE\}@\$\{DIGEST\}" "\$\{IMAGE\}:sha-\$\{GITHUB_SHA\}"[\s\S]*image digest "\$\{IMAGE\}:\$\{VERSION\}"[\s\S]*image digest "\$\{IMAGE\}:sha-\$\{GITHUB_SHA\}"/,
    'release tags must be promoted only after all digest verification succeeds',
  );
  return {
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
