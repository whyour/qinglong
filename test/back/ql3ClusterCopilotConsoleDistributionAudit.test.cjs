'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  auditClusterCopilotConsoleDistribution,
} = require('../../scripts/ql3-cluster-copilot-console-distribution-audit.cjs');

const ROOT = path.resolve(__dirname, '../..');

function intercept(target, transform) {
  return (relativePath) => {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    return relativePath === target ? transform(source) : source;
  };
}

test('accepts the signed multi-architecture Admin OCI workstation distribution', () => {
  assert.deepEqual(auditClusterCopilotConsoleDistribution({ root: ROOT }), {
    schemaVersion: 1,
    component: 'cluster-copilot-console-distribution',
    artifact: 'signed-admin-oci',
    architectures: ['amd64', 'arm64'],
    hostPublication: '127.0.0.1',
    kubernetesResident: false,
    additionalWorkspacePackages: 0,
    externalWorkstationCeremony: 'source-tag-private-report',
    ceremonyStatus: 'implementation-ready-public-release-pending',
    findings: [],
    compatible: true,
  });
});

test('rejects remote publication and weakened image runtime authority', () => {
  for (const transform of [
    (source) =>
      source.replace('127.0.0.1:$port:$port/tcp', '0.0.0.0:$port:$port/tcp'),
    (source) => source.replace('--cap-drop ALL', '--privileged'),
    (source) => source.replace('--network "$network"', '--network host'),
  ]) {
    const report = auditClusterCopilotConsoleDistribution({
      root: ROOT,
      readFile: intercept(
        'deploy/console/ql3-cluster-copilot/docker-loopback.sh',
        transform,
      ),
    });
    assert.equal(report.compatible, false);
    assert.ok(
      report.findings.some(({ code }) =>
        code.startsWith('QL3_COPILOT_CONSOLE_LAUNCHER_'),
      ),
    );
  }
});

test('rejects verifier, embedded artifact and release workflow drift', () => {
  const fixtures = [
    [
      'deploy/console/ql3-cluster-copilot/verify-release.sh',
      (source) => source.replace('--deny-self-hosted-runners', ''),
      'QL3_CLUSTER_ADMIN_RELEASE_VERIFIER_DRIFT',
    ],
    [
      'deploy/containers/ql3-cluster-admin/Dockerfile',
      (source) => source.replace('COPY --chmod=0555', 'COPY --chmod=0777'),
      'QL3_COPILOT_CONSOLE_IMAGE_DISTRIBUTION_DRIFT',
    ],
    [
      '.github/workflows/ql3-image-release.yml',
      (source) =>
        source.replace(
          'Promote tags only after the complete set is verified',
          'Promote mutable release tags',
        ),
      'QL3_CLUSTER_ADMIN_RELEASE_WORKFLOW_DRIFT',
    ],
  ];
  for (const [target, transform, code] of fixtures) {
    const report = auditClusterCopilotConsoleDistribution({
      root: ROOT,
      readFile: intercept(target, transform),
    });
    assert.equal(report.compatible, false);
    assert.ok(report.findings.some((finding) => finding.code === code));
  }
});

test('rejects external workstation ceremony and offline audit widening', () => {
  const fixtures = [
    [
      'scripts/ql3-cluster-admin-release-workstation-ceremony.cjs',
      (source) =>
        source.replace(
          "'--network',\n          'none'",
          "'--network',\n          'default'",
        ),
      'QL3_CLUSTER_ADMIN_RELEASE_WORKSTATION_CEREMONY_DRIFT',
    ],
    [
      'scripts/ql3-cluster-admin-release-workstation-ceremony.cjs',
      (source) => source.replace('windowsHide: true', 'shell: true'),
      'QL3_CLUSTER_ADMIN_RELEASE_WORKSTATION_CEREMONY_WIDENED',
    ],
    [
      'scripts/ql3-cluster-admin-release-workstation-ceremony-audit.cjs',
      (source) =>
        source.replace(
          "externalResults: 'not_replayed'",
          "externalResults: 'verified'",
        ),
      'QL3_CLUSTER_ADMIN_RELEASE_WORKSTATION_AUDIT_DRIFT',
    ],
  ];
  for (const [target, transform, code] of fixtures) {
    const report = auditClusterCopilotConsoleDistribution({
      root: ROOT,
      readFile: intercept(target, transform),
    });
    assert.equal(report.compatible, false);
    assert.ok(report.findings.some((finding) => finding.code === code));
  }
});
