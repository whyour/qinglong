const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github/workflows/ql3-cloudnativepg-dr-live.yml'),
  'utf8',
);
const RUNNER = fs.readFileSync(
  path.join(ROOT, 'scripts/ql3-cloudnativepg-barman-live-contract.cjs'),
  'utf8',
);

test('keeps the expensive CloudNativePG DR evidence gate manual and exact', () => {
  assert.match(WORKFLOW, /^on:\n  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(WORKFLOW, /^  (?:push|pull_request|schedule):/m);
  assert.match(WORKFLOW, /runs-on: ubuntu-24\.04/);
  assert.match(WORKFLOW, /timeout-minutes: 120/);
  assert.match(WORKFLOW, /at least 35 GiB free/);
  assert.match(WORKFLOW, /node-version: '24\.18\.0'/);
  assert.match(WORKFLOW, /version: '8\.3\.1'/);
  assert.match(WORKFLOW, /kubectl v1\.32\.8/);
  assert.match(
    WORKFLOW,
    /cert-manager\/cert-manager\/releases\/download\/v1\.20\.3/,
  );
  assert.match(WORKFLOW, /plugin-barman-cloud\/releases\/download\/v0\.13\.0/);
  assert.match(WORKFLOW, /cloudnative-pg\/releases\/download\/v1\.30\.0/);
  assert.match(WORKFLOW, /QL3_CLOUDNATIVEPG_BARMAN_LIVE: '1'/);
  assert.match(WORKFLOW, /QL3_SOURCE_REVISION: \$\{\{ github\.sha \}\}/);
  assert.match(WORKFLOW, /"--report=\$\{QL3_DR_REPORT\}"/);
  assert.match(WORKFLOW, /stat -c '%a'.*= '600'/);
  assert.match(WORKFLOW, /audit:cloudnativepg-dr-evidence:ql3/);
  assert.match(
    WORKFLOW,
    /test\/back\/ql3CloudNativePgBarmanWorkflow\.test\.cjs/,
  );
  assert.match(
    WORKFLOW,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/,
  );
  assert.match(WORKFLOW, /if-no-files-found: error/);
  assert.match(WORKFLOW, /retention-days: 14/);
  assert.match(WORKFLOW, /overwrite: false/);
});

test('fails closed on runner resource leaks without pruning shared Docker state', () => {
  assert.match(WORKFLOW, /ql3-dangling-volumes\.before/);
  assert.match(WORKFLOW, /ql3-dangling-volumes\.after/);
  assert.match(WORKFLOW, /diff --unified/);
  assert.match(WORKFLOW, /docker ps -aq --filter name=ql3-barman-dr-/);
  assert.match(WORKFLOW, /docker network ls -q --filter name=ql3-barman-dr-/);
  assert.match(
    WORKFLOW,
    /docker ps -aq --filter label=io\.qinglong\.ql3\.live=cloudnativepg-barman-disaster-recovery/,
  );
  assert.match(
    WORKFLOW,
    /docker network ls -q --filter label=io\.qinglong\.ql3\.live=cloudnativepg-barman-disaster-recovery/,
  );
  assert.doesNotMatch(WORKFLOW, /(?:system|builder|volume) prune/);
  assert.doesNotMatch(WORKFLOW, /continue-on-error/);
  assert.doesNotMatch(WORKFLOW, /ql3-cnpg-evidence-control-plane/);
  assert.match(
    RUNNER,
    /run\(docker, \['rm', '-f', '-v', container\], \{[\s\S]*?allowFailure: true/,
  );
});
