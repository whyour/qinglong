'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  auditClusterCopilotConsole,
} = require('../../scripts/ql3-cluster-copilot-console-audit.cjs');

const root = path.resolve(__dirname, '../..');

function intercept(target, mutate) {
  return (relativePath) => {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    return relativePath === target ? mutate(source) : source;
  };
}

test('keeps the QingLong 3.0 Copilot Console independent and read-only', () => {
  const report = auditClusterCopilotConsole({ root });
  assert.deepEqual(report, {
    schemaVersion: 1,
    component: 'cluster-copilot-console',
    owner: '@qinglong/cluster-admin',
    lifecycle: 'operator-workstation-loopback',
    operations: [
      'inspect',
      'output',
      'run_cancellation_status',
      'run_cancellation_blocked_list',
      'run_cancellation_inspect',
      'worker_list',
      'worker_inspect',
      'run_list',
      'run_read',
      'run_event_list',
      'run_step_list',
      'task_list',
      'task_read',
      'workflow_list',
      'workflow_run_list',
      'workflow_run_read',
      'workflow_event_list',
      'workflow_step_list',
    ],
    legacyUiCoupled: false,
    kubernetesResident: false,
    assetCount: 4,
    evidenceBundle: {
      lifecycle: 'browser-local-explicit-export',
      maximumRecords: 16,
      maximumRawBytes: 8 * 1024 * 1024,
      maximumBundleBytes: 512 * 1024,
      upstreamReadsOnExport: 0,
      attestation: 'none',
      actionAuthority: 'none',
    },
    offlineVerifier: {
      lifecycle: 'operator-local-explicit-file-read',
      bundleDigest: 'recomputed',
      rawFactDigests: 'not_recomputed_without_raw_facts',
      serverSignature: 'not_verified',
      mutation: false,
      networkAccess: false,
      fileWrites: false,
    },
    sourceFileCount: 7,
    findings: [],
    compatible: true,
  });
});

test('rejects a remote listener or mutation vocabulary', () => {
  const listener = auditClusterCopilotConsole({
    root,
    readFile: intercept(
      'packages/ql3-cluster-admin/src/copilot-console/server.ts',
      (source) => source.replaceAll('127.0.0.1', '0.0.0.0'),
    ),
  });
  const mutation = auditClusterCopilotConsole({
    root,
    readFile: intercept(
      'packages/ql3-cluster-admin/src/copilot-console/contracts.ts',
      (source) => source.replace("'output',", "'output', 'cancel',"),
    ),
  });
  assert.equal(listener.compatible, false);
  assert.equal(mutation.compatible, false);
  assert.ok(
    listener.findings.some(
      ({ code }) => code === 'CLUSTER_COPILOT_CONSOLE_CONTRACT_MISSING',
    ),
  );
  assert.ok(
    mutation.findings.some(
      ({ code }) => code === 'CLUSTER_COPILOT_CONSOLE_AUTHORITY_WIDENED',
    ),
  );
});

test('rejects browser persistence, dynamic rendering and product drift', () => {
  for (const injected of ['localStorage', 'innerHTML', 'WebSocket']) {
    const report = auditClusterCopilotConsole({
      root,
      readFile: intercept(
        'packages/ql3-cluster-admin/assets/copilot-console/app.js',
        (source) => source + '\n// ' + injected + '\n',
      ),
    });
    assert.equal(report.compatible, false);
    assert.ok(
      report.findings.some(
        ({ code }) => code === 'CLUSTER_COPILOT_CONSOLE_AUTHORITY_WIDENED',
      ),
    );
  }
  const product = auditClusterCopilotConsole({
    root,
    readFile: intercept(
      'packages/ql3-cluster-admin/src/product-cli/productCommand.ts',
      (source) => source.replace("name: 'copilot-console'", "name: 'removed'"),
    ),
  });
  assert.equal(product.compatible, false);
  assert.ok(
    product.findings.some(
      ({ code }) => code === 'CLUSTER_COPILOT_CONSOLE_PRODUCT_ENTRY_MISSING',
    ),
  );
  const image = auditClusterCopilotConsole({
    root,
    readFile: intercept(
      'deploy/containers/ql3-cluster-admin/Dockerfile',
      (source) =>
        source.replaceAll(
          'packages/ql3-cluster-admin/assets/copilot-console',
          'packages/ql3-cluster-admin/assets/removed',
        ),
    ),
  });
  assert.equal(image.compatible, false);
  assert.ok(
    image.findings.some(
      ({ code, target }) =>
        code === 'CLUSTER_COPILOT_CONSOLE_CONTRACT_MISSING' &&
        target === 'deploy/containers/ql3-cluster-admin/Dockerfile',
    ),
  );
});

test('rejects evidence export network, persistence and authority widening', () => {
  for (const injected of [
    'fetch(',
    'navigator.share(',
    'localStorage',
    'setTimeout(',
  ]) {
    const report = auditClusterCopilotConsole({
      root,
      readFile: intercept(
        'packages/ql3-cluster-admin/assets/copilot-console/evidence-bundle.js',
        (source) => source + '\n// ' + injected + '\n',
      ),
    });
    assert.equal(report.compatible, false);
    assert.ok(
      report.findings.some(
        ({ code }) => code === 'CLUSTER_COPILOT_CONSOLE_AUTHORITY_WIDENED',
      ),
    );
  }
});

test('rejects offline verifier network, write and ambient authority widening', () => {
  for (const injected of [
    "require('node:https')",
    'writeFileSync(',
    'process.env',
    'process.stdin',
    'fetch(',
  ]) {
    const report = auditClusterCopilotConsole({
      root,
      readFile: intercept(
        'packages/ql3-cluster-admin/src/copilot-console/evidenceVerifier.ts',
        (source) => source + '\n// ' + injected + '\n',
      ),
    });
    assert.equal(report.compatible, false);
    assert.ok(
      report.findings.some(
        ({ code }) => code === 'CLUSTER_COPILOT_CONSOLE_AUTHORITY_WIDENED',
      ),
    );
  }
});

test('rejects coupling into the legacy UI or Kubernetes workloads', () => {
  const legacyTarget = 'src/pages/login/index.tsx';
  const legacy = auditClusterCopilotConsole({
    root,
    readFile: intercept(
      legacyTarget,
      (source) => source + '\n// ql3-copilot-console\n',
    ),
  });
  const kubernetesTarget = 'deploy/kubernetes/ql3-cluster/base/deployment.yaml';
  const kubernetes = auditClusterCopilotConsole({
    root,
    readFile: intercept(
      kubernetesTarget,
      (source) => source + '\n# ql3-copilot-console\n',
    ),
  });
  assert.equal(legacy.compatible, false);
  assert.equal(kubernetes.compatible, false);
  assert.ok(
    legacy.findings.some(
      ({ code, target }) =>
        code === 'CLUSTER_COPILOT_CONSOLE_LEGACY_UI_COUPLED' &&
        target === legacyTarget,
    ),
  );
  assert.ok(
    kubernetes.findings.some(
      ({ code, target }) =>
        code === 'CLUSTER_COPILOT_CONSOLE_KUBERNETES_RESIDENT' &&
        target === kubernetesTarget,
    ),
  );
});
