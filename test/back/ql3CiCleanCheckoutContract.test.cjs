const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github/workflows/ql3-ci.yml'),
  'utf8',
);
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
);
const LOCAL_PROFILE_AUDIT = fs.readFileSync(
  path.join(ROOT, 'scripts/ql3-local-profile-artifact-audit.cjs'),
  'utf8',
);

function jobSource(name, nextName) {
  const source = WORKFLOW.match(
    nextName
      ? new RegExp(`  ${name}:\\n([\\s\\S]*?)\\n  ${nextName}:`)
      : new RegExp(`  ${name}:\\n([\\s\\S]*)$`),
  )?.[1];
  assert.ok(source, `${name} job is missing`);
  return source;
}

function assertOrdered(source, values) {
  let cursor = -1;
  for (const value of values) {
    const next = source.indexOf(value, cursor + 1);
    assert.notEqual(next, -1, `${value} is missing`);
    assert.ok(next > cursor, `${value} is out of order`);
    cursor = next;
  }
}

test('pins backend CI to the released Node line and bootstraps a clean checkout', () => {
  const backend = jobSource('backend', 'service-manager-bridge');
  assert.doesNotMatch(backend, /node: '20'/);
  assert.equal(backend.match(/node: '24\.18\.0'/g)?.length, 2);
  assertOrdered(backend, [
    'pnpm install --frozen-lockfile --ignore-scripts',
    'cp .env.example .env',
    'mkdir -p data/db',
    'pnpm rebuild @whyour/sqlite3',
    'pnpm build:back',
    'pnpm run build:packages:ql3',
    'pnpm test:back',
  ]);
  assert.doesNotMatch(backend, /if: matrix\.node == '24'/);
});

test('provisions every role required by the PostgreSQL migration stream', () => {
  const postgres = jobSource('cluster-postgres', 'cluster-postgres-ha');
  for (const role of [
    'ql3_automation_manager',
    'ql3_approval_manager',
    'ql3_run_manager',
    'ql3_package_manager',
  ]) {
    assert.match(postgres, new RegExp(`CREATE ROLE ${role} LOGIN PASSWORD`));
  }
});

test('bootstraps jobs that previously depended on local modules or artifacts', () => {
  const serviceManager = jobSource(
    'service-manager-bridge',
    'linux-resource-envelopes',
  );
  assertOrdered(serviceManager, [
    'pnpm install --frozen-lockfile --ignore-scripts',
    'pnpm run build:packages:ql3',
    'pnpm --filter @qinglong/local-owner-cli test',
  ]);

  const worker = jobSource('worker-runtime', 'local-profiles');
  assertOrdered(worker, [
    'pnpm install --frozen-lockfile --ignore-scripts',
    'cp .env.example .env',
    'pnpm audit:edge-imports:ql3',
  ]);

  const clusterImage = jobSource(
    'cluster-image',
    'cluster-console-capacity-release-evidence',
  );
  const oci = jobSource('image-oci', 'worker-runtime');
  for (const source of [clusterImage, oci]) {
    assert.match(source, /pnpm\/action-setup@v6/);
    assert.match(source, /pnpm install --frozen-lockfile --ignore-scripts/);
  }

  const providerLive = jobSource(
    'cluster-provider-credential-test-kubernetes-live',
    'cluster-plugin-package-kubernetes-live',
  );
  assertOrdered(providerLive, [
    'pnpm install --frozen-lockfile --ignore-scripts',
    'pnpm run build:packages:ql3',
    'pnpm test:provider-credential-test-kubernetes-live:ql3',
  ]);
});

test('rebuilds the only native legacy binding used by resource evidence', () => {
  const resource = jobSource(
    'linux-resource-envelopes',
    'linux-resource-release-evidence',
  );
  assertOrdered(resource, [
    'pnpm install --frozen-lockfile --ignore-scripts',
    'pnpm rebuild @whyour/sqlite3',
    'pnpm build:back',
  ]);
});

test('does not forward a literal separator into recovery evidence CLIs', () => {
  const recovery = jobSource('cluster-plugin-package-recovery-e2e');
  assert.doesNotMatch(
    recovery,
    /pnpm (?:test|audit):plugin-package-recovery-e2e:ql3 -- \\/,
  );
  assert.match(recovery, /pnpm test:plugin-package-recovery-e2e:ql3 \\/);
  assert.match(recovery, /pnpm audit:plugin-package-recovery-e2e:ql3 \\/);
});

test('keeps container TypeScript builds in workspace dependency order', () => {
  const localDockerfile = fs.readFileSync(
    path.join(ROOT, 'deploy/containers/ql3-local-application/Dockerfile'),
    'utf8',
  );
  assertOrdered(localDockerfile, [
    '-p packages/ql3-runtime-core/tsconfig.json',
    '-p packages/ql3-local-command-file/tsconfig.json',
    '-p packages/ql3-local-process/tsconfig.json',
    '-p packages/ql3-local-sqlite/tsconfig.json',
    '-p packages/ql3-ai/tsconfig.json',
    '-p packages/ql3-local-secret/tsconfig.json',
    '-p packages/ql3-local-admin/tsconfig.json',
    '-p packages/ql3-local-execution/tsconfig.json',
    '-p packages/ql3-local-application/tsconfig.json',
  ]);

  const defaultControlConfig = JSON.parse(
    fs.readFileSync(
      path.join(
        ROOT,
        'deploy/containers/ql3-cluster-control/tsconfig.default.json',
      ),
      'utf8',
    ),
  );
  assert.deepEqual(defaultControlConfig.include, [
    '../../../packages/ql3-cluster-control/src/cli.ts',
  ]);
  assert.deepEqual(defaultControlConfig.exclude, [
    '../../../packages/ql3-cluster-control/src/aiCli.ts',
    '../../../packages/ql3-cluster-control/src/application-runtime/aiProductionApplication.ts',
  ]);
  assert.doesNotMatch(
    fs.readFileSync(
      path.join(
        ROOT,
        'packages/ql3-cluster-control/src/copilot/failure-diagnosis/failureDiagnosisCancellationRoute.ts',
      ),
      'utf8',
    ),
    /@qinglong\/ai/,
  );
});

test('pins patched transitive versions for the QL3 importer audit', () => {
  assert.equal(
    MANIFEST.pnpm.overrides['@kubernetes/client-node>js-yaml'],
    '4.3.1',
  );
  assert.equal(MANIFEST.pnpm.overrides['socks>ip-address'], '10.3.1');
});

test('keeps the Node 24 compact Profile RSS budget below application and MCP tiers', () => {
  assert.match(
    LOCAL_PROFILE_AUDIT,
    /DEFAULT_MAX_RSS_DELTA_BYTES = 20 \* 1024 \* 1024/,
  );
  assert.match(
    LOCAL_PROFILE_AUDIT,
    /DEFAULT_MAX_APPLICATION_RSS_DELTA_BYTES = 24 \* 1024 \* 1024/,
  );
  assert.match(
    LOCAL_PROFILE_AUDIT,
    /DEFAULT_MAX_MCP_RSS_DELTA_BYTES = 48 \* 1024 \* 1024/,
  );
});
