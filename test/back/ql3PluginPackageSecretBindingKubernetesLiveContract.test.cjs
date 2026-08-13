'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const CONTRACT = path.join(
  ROOT,
  'scripts/ql3-plugin-package-secret-binding-kubernetes-live-contract.cjs',
);
const BOOTSTRAP = path.join(
  ROOT,
  'scripts/ql3-plugin-package-secret-binding-kubernetes-live-bootstrap.cjs',
);

test('wires the Secret binding Kubernetes live gate as an explicit opt-in', () => {
  const scripts = require(path.join(ROOT, 'package.json')).scripts;
  assert.equal(
    scripts['test:plugin-package-secret-binding-kubernetes-live:ql3'],
    'pnpm --filter @qinglong/cluster-admin build && node scripts/ql3-plugin-package-secret-binding-kubernetes-live-contract.cjs',
  );
  assert.equal(
    scripts['audit:plugin-package-secret-binding-kubernetes-live:ql3'],
    'node scripts/ql3-plugin-package-secret-binding-kubernetes-live-audit.cjs',
  );
  const source = fs.readFileSync(CONTRACT, 'utf8');
  assert.match(source, /QL3_PLUGIN_PACKAGE_SECRET_BINDING_KUBERNETES_LIVE/);
  assert.match(source, /K3sDockerLiveFixture/);
  assert.match(source, /readyManagementPods/);
  assert.match(source, /hostAliases/);
  assert.match(source, /pluginPackageManagementClientCli\.js/);
  assert.match(source, /ql3-cluster-plugin-package-values/);
  assert.match(source, /automountServiceAccountToken: false/);
  assert.match(source, /can-i/);
  assert.match(source, /sensitiveMatchCount/);
});

test('keeps prerequisite construction in a one-shot cluster Job', () => {
  const source = fs.readFileSync(BOOTSTRAP, 'utf8');
  assert.match(source, /createClusterPluginPackageManagementService/);
  assert.match(source, /createClusterPluginPackageApprovedActionDispatcher/);
  assert.match(source, /secretProjectionFileName/);
  assert.doesNotMatch(source, /setInterval|setTimeout|watch\(/);
});
