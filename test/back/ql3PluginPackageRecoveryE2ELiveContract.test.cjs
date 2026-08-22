const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const yaml = require('js-yaml');
const {
  createFixture,
} = require('../../scripts/ql3-plugin-package-recovery-e2e-fixture.cjs');
const {
  MIGRATION_COUNT,
} = require('../../scripts/ql3-plugin-package-recovery-e2e-live-audit.cjs');
const {
  postgresqlMainMigrationStream,
} = require('../../packages/ql3-cluster-postgres/dist/migration/migration.js');

const root = path.resolve(__dirname, '../..');
const livePath = path.join(
  root,
  'scripts/ql3-plugin-package-recovery-e2e-live-contract.cjs',
);
const fixturePath = path.join(
  root,
  'scripts/ql3-plugin-package-recovery-e2e-fixture.cjs',
);
const live = fs.readFileSync(livePath, 'utf8');
const fixture = fs.readFileSync(fixturePath, 'utf8');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const workflow = yaml.load(
  fs.readFileSync(path.join(root, '.github/workflows/ql3-ci.yml'), 'utf8'),
);

test('E2E live gate is opt-in and owns only one exact disposable Kind cluster', () => {
  assert.match(live, /QL3_PLUGIN_PACKAGE_RECOVERY_E2E_LIVE !== '1'/);
  assert.match(live, /\^ql3-plugin-recovery-e2e/);
  assert.match(live, /Refusing to reuse or delete pre-existing Kind cluster/);
  assert.match(live, /kind\(\['delete', 'cluster', '--name', clusterName\]/);
  assert.match(live, /QL3_KEEP_KIND_CLUSTER/);
  assert.match(live, /kindest\/node:v1\.32\.8@sha256:/);
  assert.match(
    live,
    /image', 'tag', POSTGRES_IMAGE_REFERENCE, POSTGRES_RUNTIME_IMAGE/,
  );
  assert.match(live, /image: POSTGRES_RUNTIME_IMAGE/);
  assert.match(live, /imagePullPolicy: 'Never'/);
  assert.match(
    live,
    /condition\.type === 'Failed' && condition\.status === 'True'/,
  );
});

test('fixture uses a real HTTPS and content-addressed OCI Distribution surface', () => {
  assert.match(fixture, /https\.createServer/);
  assert.match(fixture, /docker-distribution-api-version/);
  assert.match(fixture, /\/referrers\/sha256:/);
  assert.match(fixture, /PLUGIN_PACKAGE_OCI_SIGNATURE_ARTIFACT_TYPE/);
  assert.match(fixture, /pluginPackagePublisherSignaturePayload/);
  assert.match(fixture, /canonicalTar/);
  assert.match(live, /NODE_EXTRA_CA_CERTS/);
  assert.match(live, /createRegistryCertificate/);
  assert.match(live, /requestCount: packageRequests\.length/);
});

test('report migration evidence follows the complete PostgreSQL stream', () => {
  assert.equal(MIGRATION_COUNT, postgresqlMainMigrationStream.migrations.length);
});

test('fixture locks are bound to durable version-three approval dispatches', () => {
  const value = createFixture({
    registry: 'registry.fixture.test',
    architecture: 'amd64',
    createdAtMs: 1_000,
  });
  for (const selected of [value.initial, value.upgrade]) {
    const proposal = selected.authority.proposalCommand.proposal;
    const dispatch = selected.authority.dispatch;
    assert.equal(selected.lock.approval.requestVersion, 3);
    assert.equal(selected.lock.approval.dispatchId, dispatch.id);
    assert.equal(selected.lock.actionDigest, proposal.actionDigest);
    assert.equal(selected.lock.planDigest, proposal.previewDigest);
    assert.equal(dispatch.action.actionRef, proposal.actionRef);
    assert.equal(
      selected.authority.consumptionCommand.dispatchId,
      dispatch.id,
    );
  }
});

test('gate runs migration, healthy activation and a durable rejected upgrade', () => {
  assert.match(live, /operations\/base\/migrate-job\.yaml/);
  assert.match(
    live,
    /CREATE ROLE ql3_automation_manager LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/,
  );
  assert.match(
    live,
    /CREATE ROLE ql3_approval_manager LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/,
  );
  assert.match(
    live,
    /CREATE ROLE ql3_run_manager LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/,
  );
  assert.match(live, /plugin-package-recovery\/base\/recover-job\.yaml/);
  assert.match(fixture, /PostgresPluginPackageInstallRepository/);
  assert.match(fixture, /PostgresPluginPackageInstallProposalRepository/);
  assert.match(fixture, /PostgresApprovalRequestRepository/);
  assert.match(fixture, /PostgresApprovedActionExecutionRepository/);
  assert.match(fixture, /PostgresProjectPolicyRepository/);
  assert.match(fixture, /\.createProposal\(selected\.authority\.proposalCommand\)/);
  assert.match(fixture, /\.consume\(selected\.authority\.consumptionCommand\)/);
  assert.match(fixture, /repository\.admit\(/);
  assert.doesNotMatch(fixture, /pluginPackageInstallCreate/);
  assert.match(
    fixture,
    /PostgresPluginPackagePublisherTrustAuthorityRepository/,
  );
  assert.match(fixture, /createPluginPackagePublisherTrustSnapshot/);
  assert.match(fixture, /role: 'package-manager'/);
  assert.match(fixture, /authorityId: 'cluster'/);
  assert.match(fixture, /publisherTrustStatus/);
  assert.match(live, /QL3_E2E_POSTGRES_PACKAGE_MANAGER_USER/);
  assert.match(live, /key: 'package-manager-password'/);
  assert.match(live, /QL3_E2E_POSTGRES_RUNTIME_USER/);
  assert.match(live, /key: 'runtime-password'/);
  assert.doesNotMatch(fixture, /commit-transition/);
  assert.match(live, /initialSeed\.state, 'queued'/);
  assert.match(live, /upgradeSeed\.state, 'queued'/);
  assert.match(live, /value\.migrationCount, MIGRATION_COUNT/);
  assert.match(live, /value\.capabilityVersion, 64/);
  assert.match(live, /postgresEnvironment\(\s*'PACKAGE_EXECUTOR'/);
  assert.match(fixture, /assertPostgresPackageExecutorSchemaReady/);
  assert.match(live, /value\.initialState, 'active'/);
  assert.match(live, /value\.upgradeState, 'failed'/);
  assert.match(live, /value\.upgradeFailureReason, 'activation_fact_conflict'/);
  assert.match(live, /value\.upgradeRevisionCount, 0/);
  assert.match(live, /value\.recoverableCount, 0/);
});

test('deployment controller rejects the upgrade before creating runtime', () => {
  const rejectionWait = live.indexOf('waitForJob(UPGRADE_RECOVERY_JOB)');
  const pointerProof = live.indexOf(
    'assert.deepEqual(pointerAfterRejection, pointerBeforeUpgrade)',
  );
  const runtimeApply = live.indexOf(
    'const runtime = applyRuntimeAfterRecovery(',
  );
  assert.ok(rejectionWait > 0);
  assert.ok(pointerProof > rejectionWait);
  assert.ok(runtimeApply > pointerProof);
  assert.match(live, /activePointerUnchanged: true/);
  assert.doesNotMatch(live, /missingTransitionFailedClosed/);
  assert.match(live, /qinglong\.io\/plugin-recovery-job-uid/);
  assert.match(live, /qinglong\.io\/plugin-recovery-completed-at/);
  assert.match(live, /rollout[\s\S]*status/);
  assert.match(live, /availableReplicas, 2/);
  assert.match(
    live,
    /new Set\(pods\.items\.map\(\(pod\) => pod\.spec\.nodeName\)\)/,
  );
});

test('recovery Job keeps exact ConfigMap-only RBAC and runtime cannot read install authority', () => {
  assert.match(
    live,
    /resources: \['configmaps'\],[\s\S]*verbs: \['get', 'create', 'update'\]/,
  );
  assert.match(live, /listConfigMaps: false/);
  assert.match(live, /deleteConfigMaps: false/);
  assert.match(live, /getSecrets: false/);
  assert.match(live, /SELECT count\(\*\) FROM ql3\.plugin_package_installs/);
  assert.match(live, /permission denied/i);
});

test('package script and independent CI job execute the full gate', () => {
  assert.equal(
    packageJson.scripts['test:plugin-package-recovery-e2e:ql3'],
    'pnpm --filter @qinglong/cluster-admin check && pnpm --filter @qinglong/cluster-control check && node scripts/ql3-plugin-package-recovery-e2e-live-contract.cjs',
  );
  const job = workflow.jobs['cluster-plugin-package-recovery-e2e'];
  assert.ok(job);
  assert.equal(job['timeout-minutes'], 35);
  assert.equal(
    packageJson.scripts['audit:plugin-package-recovery-e2e:ql3'],
    'node scripts/ql3-plugin-package-recovery-e2e-live-audit.cjs',
  );
  assert.ok(
    job.steps.some(
      (step) =>
        String(step.run).includes(
          'pnpm test:plugin-package-recovery-e2e:ql3',
        ) &&
        String(step.run).includes('--report=') &&
        String(step.run).includes('pnpm audit:plugin-package-recovery-e2e:ql3'),
    ),
  );
  assert.ok(
    job.steps.some(
      (step) =>
        step.env?.QL3_SOURCE_REVISION === '${{ github.sha }}' &&
        step.env?.QL3_PLUGIN_PACKAGE_RECOVERY_E2E_LIVE === '1',
    ),
  );
  assert.ok(
    job.steps.some(
      (step) =>
        step.if === 'always()' &&
        String(step.uses).startsWith('actions/upload-artifact@') &&
        step.with?.['retention-days'] === 14,
    ),
  );
  assert.ok(
    job.steps.some((step) =>
      String(step.run).includes(
        'postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296',
      ),
    ),
  );
});

test('gate persists only a source-bound low-sensitive private report', () => {
  assert.match(live, /privateReportPath\(argv\)/);
  assert.match(live, /writePrivateReport\(reportFile, report\)/);
  assert.match(live, /QL3_SOURCE_REVISION/);
  assert.match(live, /org\.opencontainers\.image\.revision/);
  assert.match(live, /activeJsonDigest/);
  assert.doesNotMatch(live, /activePointer: pointerAfterRejection/);
  assert.match(live, /reportWritten: true/);
});

test('private Registry evidence uses one exact Secret file and authenticated requests', () => {
  assert.match(fixture, /request\.headers\.authorization !== authorization/);
  assert.match(fixture, /www-authenticate/);
  assert.match(fixture, /authenticated,/);
  assert.match(live, /QL3_PLUGIN_PACKAGE_REGISTRY_CREDENTIAL_FILE/);
  assert.match(live, /qinglong\/plugin-package-registry-credentials@v1/);
  assert.match(live, /secretName: 'ql3-e2e-registry-auth'/);
  assert.match(live, /defaultMode: 288/);
  assert.match(live, /authentication: 'exact-registry-basic'/);
  assert.match(
    live,
    /packageRequests\.every\(\(event\) => event\.authenticated === true\)/,
  );
});
