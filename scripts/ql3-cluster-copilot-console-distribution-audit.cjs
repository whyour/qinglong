'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILES = Object.freeze({
  launcher: 'deploy/console/ql3-cluster-copilot/docker-loopback.sh',
  verifier: 'deploy/console/ql3-cluster-copilot/verify-release.sh',
  environment:
    'deploy/console/ql3-cluster-copilot/host-environment.example.json',
  image: 'deploy/containers/ql3-cluster-admin/Dockerfile',
  workflow: '.github/workflows/ql3-image-release.yml',
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
    ],
    'QL3_COPILOT_CONSOLE_LAUNCHER_CONTRACT_DRIFT',
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
    ],
    'QL3_CLUSTER_ADMIN_RELEASE_VERIFIER_DRIFT',
  );
  rejectFragments(
    'verifier',
    [':latest', 'refs/heads/', '--insecure-ignore-tlog', '--certificate-identity-regexp'],
    'QL3_CLUSTER_ADMIN_RELEASE_VERIFIER_WIDENED',
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
    QL3_COPILOT_CONSOLE_PRIVATE_ROOT:
      '/absolute/private/ql3-copilot-console',
    QL3_COPILOT_CONSOLE_NETWORK: 'qinglong3-copilot-console-egress',
    QL3_COPILOT_CONSOLE_PORT: '5701',
    QL3_COPILOT_CONSOLE_RESOURCE_CLASS: 'compact',
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
    ],
    'QL3_COPILOT_CONSOLE_IMAGE_DISTRIBUTION_DRIFT',
  );
  requireFragments(
    'workflow',
    [
      'image: admin',
      'image_arch: amd64',
      'image_arch: arm64',
      'cosign sign --yes "${IMAGE}@${DIGEST}"',
      'predicate-type: https://qinglong.dev/attestations/image-os-vulnerability/v1',
      'gh attestation verify "oci://${IMAGE}@${DIGEST}"',
      '--predicate-type "https://cyclonedx.org/bom"',
      '--deny-self-hosted-runners',
      '--bundle-from-oci',
      'Promote only the verified digest to immutable release tags',
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
