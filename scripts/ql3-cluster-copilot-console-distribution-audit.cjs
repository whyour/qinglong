'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILES = Object.freeze({
  launcher: 'deploy/console/ql3-cluster-copilot/docker-loopback.sh',
  verifier: 'deploy/console/ql3-cluster-copilot/verify-release.sh',
  ceremony: 'scripts/ql3-cluster-admin-release-workstation-ceremony.cjs',
  ceremonyAudit:
    'scripts/ql3-cluster-admin-release-workstation-ceremony-audit.cjs',
  environment:
    'deploy/console/ql3-cluster-copilot/host-environment.example.json',
  runManagementExample:
    'deploy/console/ql3-cluster-copilot/run-management-client-config.example.json',
  workerManagementExample:
    'deploy/console/ql3-cluster-copilot/worker-management-client-config.example.json',
  packageManagementExample:
    'deploy/console/ql3-cluster-copilot/package-management-client-config.example.json',
  image: 'deploy/containers/ql3-cluster-admin/Dockerfile',
  workflow: '.github/workflows/ql3-image-release.yml',
  candidate: 'scripts/ql3-release-candidate-contract.cjs',
  cli: 'packages/ql3-cluster-admin/src/copilot-console/cli.ts',
  server: 'packages/ql3-cluster-admin/src/copilot-console/server.ts',
});

function finding(code, target, detail) {
  return Object.freeze({ code, target, detail });
}

function auditClusterCopilotConsoleDistribution(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const readFile =
    options.readFile ||
    ((relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8'));
  const findings = [];
  const source = {};
  for (const [name, relativePath] of Object.entries(FILES)) {
    try {
      source[name] = readFile(relativePath);
    } catch (error) {
      findings.push(
        finding(
          'QL3_COPILOT_CONSOLE_DISTRIBUTION_FILE_MISSING',
          relativePath,
          error instanceof Error ? error.name : 'Error',
        ),
      );
    }
  }

  const requireFragments = (name, fragments, code) => {
    const contents = source[name];
    if (typeof contents !== 'string') return;
    for (const fragment of fragments) {
      if (!contents.includes(fragment)) {
        findings.push(finding(code, FILES[name], fragment));
      }
    }
  };
  const rejectFragments = (name, fragments, code) => {
    const contents = source[name];
    if (typeof contents !== 'string') return;
    for (const fragment of fragments) {
      if (contents.includes(fragment)) {
        findings.push(finding(code, FILES[name], fragment));
      }
    }
  };

  requireFragments(
    'launcher',
    [
      'docker run --rm --pull never --init --read-only',
      '--network "$network"',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--user 10001:10001',
      '--pids-limit "$pids"',
      '--memory "$memory"',
      '--cpus "$cpus"',
      '--tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m,mode=700,uid=10001,gid=10001',
      '--mount "type=bind,src=$private_root,dst=/var/run/secrets/qinglong3/copilot-console,readonly"',
      '--publish "127.0.0.1:$port:$port/tcp"',
      '--container-published-loopback',
      'bridge|default|host|none) fail',
      'compact)',
      'memory=192m',
      'standard)',
      'memory=512m',
      'QL3_COPILOT_CONSOLE_RUN_MANAGEMENT-disabled',
      '--run-management-config /var/run/secrets/qinglong3/copilot-console/run-management-client.json',
      '--run-management-assertion /var/run/secrets/qinglong3/copilot-console/run-management-assertion.jwt',
      'QL3_COPILOT_CONSOLE_WORKER_MANAGEMENT-disabled',
      '--worker-management-config /var/run/secrets/qinglong3/copilot-console/worker-management-client.json',
      '--worker-management-assertion /var/run/secrets/qinglong3/copilot-console/worker-management-assertion.jwt',
      'QL3_COPILOT_CONSOLE_PACKAGE_MANAGEMENT-disabled',
      '--package-management-config /var/run/secrets/qinglong3/copilot-console/package-management-client.json',
      '--package-management-assertion /var/run/secrets/qinglong3/copilot-console/package-management-assertion.jwt',
    ],
    'QL3_COPILOT_CONSOLE_LAUNCHER_CONTRACT_DRIFT',
  );
  requireFragments(
    'workerManagementExample',
    [
      '"schemaVersion": 1',
      '/api/v3/workers/management',
      'worker-management-client.crt',
      'worker-management-client.key',
    ],
    'QL3_COPILOT_CONSOLE_WORKER_MANAGEMENT_EXAMPLE_DRIFT',
  );
  requireFragments(
    'packageManagementExample',
    [
      '"schemaVersion": 1',
      '/api/v3/plugin-packages/management',
      'package-management-ca.pem',
    ],
    'QL3_COPILOT_CONSOLE_PACKAGE_MANAGEMENT_EXAMPLE_DRIFT',
  );
  rejectFragments(
    'launcher',
    ['--privileged', '--network host', '/var/run/docker.sock', '--pull always'],
    'QL3_COPILOT_CONSOLE_LAUNCHER_AUTHORITY_WIDENED',
  );

  requireFragments(
    'verifier',
    [
      'qinglong3-cluster-admin@sha256:',
      'cosign verify',
      '--certificate-identity "$certificate_identity"',
      '--certificate-oidc-issuer https://token.actions.githubusercontent.com',
      'gh attestation verify "oci://$image"',
      '--signer-workflow "$workflow"',
      '--source-digest "$source_revision"',
      '--source-ref "$source_ref"',
      '--deny-self-hosted-runners',
      '--bundle-from-oci',
      'https://cyclonedx.org/bom',
      'https://qinglong.dev/attestations/image-os-vulnerability/v1',
      'https://qinglong.dev/attestations/release-candidate-contract/v1',
    ],
    'QL3_CLUSTER_ADMIN_RELEASE_VERIFIER_DRIFT',
  );
  rejectFragments(
    'verifier',
    [
      ':latest',
      'refs/heads/',
      '--insecure-ignore-tlog',
      '--certificate-identity-regexp',
    ],
    'QL3_CLUSTER_ADMIN_RELEASE_VERIFIER_WIDENED',
  );

  requireFragments(
    'ceremony',
    [
      "'qinglong/cluster-admin-release-workstation-ceremony@v1'",
      'GH_TOKEN: token.token',
      "'--certificate-identity'",
      "'--certificate-oidc-issuer'",
      "'https://token.actions.githubusercontent.com'",
      "'--signer-workflow'",
      "'--source-digest'",
      "'--source-ref'",
      "'--deny-self-hosted-runners'",
      "'--bundle-from-oci'",
      "'https://cyclonedx.org/bom'",
      "'https://qinglong.dev/attestations/image-os-vulnerability/v1'",
      "'https://qinglong.dev/attestations/release-candidate-contract/v1'",
      "'immutable_image_pull'",
      "'local_digest_inspection'",
      "'embedded_evidence_verifier'",
      "'--read-only'",
      "'--network',\n          'none'",
      "'--cap-drop'",
      "'no-new-privileges'",
      "'10001:10001'",
      "'128m'",
      "'0.25'",
      "'evidence-verify'",
      "reportAttestation: 'none'",
      'writeNoReplace(options.output, report)',
    ],
    'QL3_CLUSTER_ADMIN_RELEASE_WORKSTATION_CEREMONY_DRIFT',
  );
  rejectFragments(
    'ceremony',
    [
      'shell: true',
      'env: process.env',
      ':latest',
      '--privileged',
      'GH_TOKEN: token.token,\n    ...publicEnv',
    ],
    'QL3_CLUSTER_ADMIN_RELEASE_WORKSTATION_CEREMONY_WIDENED',
  );
  requireFragments(
    'ceremonyAudit',
    [
      "'qinglong/cluster-admin-release-workstation-ceremony-audit@v1'",
      'report must be one canonical owner-private bounded file',
      "externalResults: 'not_replayed'",
      "offlineAudit: 'structure_and_digest_only'",
      "reportAttestation: 'none'",
      "actionAuthority: 'none'",
      'O_NOFOLLOW',
      'canonicalize(unsigned)',
    ],
    'QL3_CLUSTER_ADMIN_RELEASE_WORKSTATION_AUDIT_DRIFT',
  );

  let environment;
  try {
    environment = JSON.parse(source.environment);
  } catch (error) {
    if (typeof source.environment === 'string') {
      findings.push(
        finding(
          'QL3_COPILOT_CONSOLE_HOST_ENVIRONMENT_INVALID',
          FILES.environment,
          error instanceof Error ? error.name : 'Error',
        ),
      );
    }
  }
  const expectedEnvironment = {
    QL3_COPILOT_CONSOLE_IMAGE:
      'ghcr.io/replace-owner/qinglong3-cluster-admin@sha256:' + '0'.repeat(64),
    QL3_COPILOT_CONSOLE_PRIVATE_ROOT: '/absolute/private/ql3-copilot-console',
    QL3_COPILOT_CONSOLE_NETWORK: 'qinglong3-copilot-console-egress',
    QL3_COPILOT_CONSOLE_PORT: '5701',
    QL3_COPILOT_CONSOLE_RESOURCE_CLASS: 'compact',
    QL3_COPILOT_CONSOLE_RUN_MANAGEMENT: 'disabled',
    QL3_COPILOT_CONSOLE_WORKER_MANAGEMENT: 'disabled',
    QL3_COPILOT_CONSOLE_PACKAGE_MANAGEMENT: 'disabled',
  };
  if (
    environment &&
    JSON.stringify(environment) !== JSON.stringify(expectedEnvironment)
  ) {
    findings.push(
      finding(
        'QL3_COPILOT_CONSOLE_HOST_ENVIRONMENT_INVALID',
        FILES.environment,
        'exact digest, private-root, named-network, port and resource-class keys are required',
      ),
    );
  }

  requireFragments(
    'image',
    [
      'COPY --chmod=0555 deploy/console/ql3-cluster-copilot/docker-loopback.sh',
      'share/ql3-copilot-console/docker-loopback.sh',
      'COPY --chmod=0555 deploy/console/ql3-cluster-copilot/verify-release.sh',
      'share/ql3-copilot-console/verify-release.sh',
      'COPY --chmod=0444 deploy/console/ql3-cluster-copilot/host-environment.example.json',
      'share/ql3-copilot-console/host-environment.example.json',
      'COPY --chmod=0444 deploy/console/ql3-cluster-copilot/run-management-client-config.example.json',
      'share/ql3-copilot-console/run-management-client-config.example.json',
      'COPY --chmod=0444 deploy/console/ql3-cluster-copilot/worker-management-client-config.example.json',
      'share/ql3-copilot-console/worker-management-client-config.example.json',
      'COPY --chmod=0444 deploy/console/ql3-cluster-copilot/package-management-client-config.example.json',
      'share/ql3-copilot-console/package-management-client-config.example.json',
    ],
    'QL3_COPILOT_CONSOLE_IMAGE_DISTRIBUTION_DRIFT',
  );
  requireFragments(
    'candidate',
    [
      "image: 'admin'",
      "repository: 'qinglong3-cluster-admin'",
      "image: 'worker'",
      "repository: 'qinglong3-worker'",
      "profiles: ['edge', 'standalone']",
      'requiresClusterPrivateEvidence: false',
      'requiresClusterPrivateEvidence: true',
    ],
    'QL3_CLUSTER_ADMIN_RELEASE_CANDIDATE_DRIFT',
  );
  requireFragments(
    'workflow',
    [
      'fromJSON(needs.release-candidate.outputs.publish-matrix)',
      'fromJSON(needs.release-candidate.outputs.os-matrix)',
      'cosign sign --yes "${IMAGE}@${DIGEST}"',
      'predicate-type: https://qinglong.dev/attestations/image-os-vulnerability/v1',
      'predicate-type: https://qinglong.dev/attestations/release-candidate-contract/v1',
      'gh attestation verify "oci://${IMAGE}@${DIGEST}"',
      '--predicate-type "https://cyclonedx.org/bom"',
      '--predicate-type "https://qinglong.dev/attestations/release-candidate-contract/v1"',
      '--deny-self-hosted-runners',
      '--bundle-from-oci',
      'Attest the complete release-set file provenance',
      'Publish and round-trip the durable OCI release catalog',
      'Attest durable release-catalog provenance',
      'Verify the durable catalog and create its immutable receipt',
      'Attest the immutable release-catalog receipt',
      'Attest deployment readiness before any final tag mutation',
      'scripts/ql3-release-tag-finalizer.cjs',
      'Promote final tags only after every required deployment gate',
      'Close and audit the deployment-ready public tag set',
      'Attest the deployment-ready release publication closure receipt',
    ],
    'QL3_CLUSTER_ADMIN_RELEASE_WORKFLOW_DRIFT',
  );
  requireFragments(
    'cli',
    [
      "'container-published-loopback'",
      "publishedHostAddress: '127.0.0.1'",
      '(containerPublishedLoopback && port === 0)',
    ],
    'QL3_COPILOT_CONSOLE_NETWORK_BOUNDARY_DRIFT',
  );
  requireFragments(
    'server',
    [
      "networkBoundary === 'host-loopback' ? '127.0.0.1' : '0.0.0.0'",
      "networkBoundary === 'container-published-loopback'",
      'server.listen(record.port as number, listenAddress',
    ],
    'QL3_COPILOT_CONSOLE_NETWORK_BOUNDARY_DRIFT',
  );

  const kubernetesRoot = path.join(root, 'deploy/kubernetes');
  const pending = [kubernetesRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (
        entry.isFile() &&
        /\.ya?ml$/u.test(entry.name) &&
        fs.readFileSync(absolute, 'utf8').includes('ql3-copilot-console')
      ) {
        findings.push(
          finding(
            'QL3_COPILOT_CONSOLE_KUBERNETES_RESIDENT',
            path.relative(root, absolute),
            'workstation Console must remain outside the Cluster workload graph',
          ),
        );
      }
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    component: 'cluster-copilot-console-distribution',
    artifact: 'signed-admin-oci',
    architectures: Object.freeze(['amd64', 'arm64']),
    hostPublication: '127.0.0.1',
    kubernetesResident: false,
    additionalWorkspacePackages: 0,
    runManagementAuthorityDefault: 'disabled',
    workerManagementAuthorityDefault: 'disabled',
    packageManagementAuthorityDefault: 'disabled',
    externalWorkstationCeremony: 'source-tag-private-report',
    ceremonyStatus: 'implementation-ready-public-release-pending',
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

function main() {
  const report = auditClusterCopilotConsoleDistribution();
  process.stdout.write(JSON.stringify(report) + '\n');
  if (!report.compatible) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { auditClusterCopilotConsoleDistribution };
