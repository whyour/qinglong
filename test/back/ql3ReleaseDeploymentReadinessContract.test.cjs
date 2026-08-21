'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  SCHEMA,
  auditDeploymentReadinessReceipt,
  createDeploymentReadinessReceipt,
  parseArguments,
  validateDeploymentReadinessReceipt,
} = require('../../scripts/ql3-release-deployment-readiness-contract.cjs');

const VERSION = '3.0.0-alpha.0';
const REVISION = 'd'.repeat(40);
const OWNER = 'qinglong-release';
const SOURCE_REPOSITORY = `${OWNER}/qinglong`;
const MANIFEST_DIGEST = `sha256:${'a'.repeat(64)}`;
const RELEASE_SET_DIGEST = `sha256:${'b'.repeat(64)}`;

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function identity(scope) {
  return {
    version: VERSION,
    sourceRevision: REVISION,
    sourceRef: `refs/tags/v${VERSION}`,
    releaseScope: scope,
    repositoryOwner: OWNER,
    sourceRepository: SOURCE_REPOSITORY,
  };
}

function consumption(scope, marker) {
  return {
    compatible: true,
    releaseScope: scope,
    sourceRepository: SOURCE_REPOSITORY,
    workflowIdentity: `https://github.com/${SOURCE_REPOSITORY}/.github/workflows/ql3-image-release.yml@refs/tags/v${VERSION}`,
    releaseSetDigest: RELEASE_SET_DIGEST,
    catalogManifestDigest: MANIFEST_DIGEST,
    immutableReference: `ghcr.io/${OWNER}/qinglong3-release-catalog@${MANIFEST_DIGEST}`,
    imageCount: scope === 'all' ? 5 : scope === 'local' ? 1 : 4,
    discoveryTagAuthority: 'none',
    externalToolResultsReplayed: false,
    deploymentMutation: false,
    contentDigest: sha256(marker),
    releaseSet: {
      release: {
        version: VERSION,
        sourceRevision: REVISION,
        sourceRef: `refs/tags/v${VERSION}`,
        scope,
      },
      releaseSetDigest: RELEASE_SET_DIGEST,
    },
  };
}

function reportEntry(value) {
  return {
    value,
    digest: sha256(`${JSON.stringify(value)}\n`),
  };
}

function localReport(scope, catalog, profile) {
  return reportEntry({
    schemaVersion: 1,
    profile,
    generation: 2,
    exactRepoDigest: true,
    composeMerge: true,
    rolloutActive: true,
    durableReceipt: true,
    sqliteWriteContract: 50,
    sqliteBackup: true,
    sqliteWriteObservation: { committed: true },
    sqliteRestorePrepared: true,
    sqliteRestoreCommitted: true,
    sqliteRestoreRolloutRecovered: true,
    sqliteRestoreReplayUnchanged: true,
    sqliteEvidenceCollected: true,
    sqliteCollectedRolloutReplayUnchanged: true,
    gracefulCleanup: true,
    releaseAuthority: {
      mode: 'verified_release_catalog',
      sourceRevision: REVISION,
      sourceRef: `refs/tags/v${VERSION}`,
      scope,
      releaseSetDigest: RELEASE_SET_DIGEST,
      catalogManifestDigest: MANIFEST_DIGEST,
      catalogConsumptionDigest: catalog.contentDigest,
      selectionDigest: sha256('selection'),
    },
    compatible: true,
  });
}

function clusterReport(scope, catalog) {
  return reportEntry({
    schemaVersion: 1,
    schema: 'qinglong/kubernetes-deployment-live-evidence@v1',
    kubernetes: {
      serverVersion: 'v1.34.3+k3s1',
      architecture: 'linux/amd64',
      nodeCount: 3,
      clusterUid: 'fixture-cluster',
    },
    deployment: {
      namespace: 'qinglong3-system',
      resourceCount: 7,
      deploymentCount: 4,
      replicas: 0,
      fieldManager: 'qinglong3-catalog-lock',
      immutableImages: true,
      headName: 'ql3-deployment-head',
      headPhase: 'committed',
      headGeneration: 2,
      deploymentDigest: sha256('deployment'),
      resourceInventoryCount: 6,
    },
    releaseAuthority: {
      mode: 'verified_release_catalog',
      version: VERSION,
      sourceRevision: REVISION,
      sourceRef: `refs/tags/v${VERSION}`,
      scope,
      releaseSetDigest: RELEASE_SET_DIGEST,
      catalogManifestDigest: MANIFEST_DIGEST,
      catalogConsumptionDigest: catalog.contentDigest,
      immutableReference: catalog.immutableReference,
    },
    preflightDigest: sha256('preflight'),
    receiptDigest: sha256('receipt'),
    receiptAuditCompatible: true,
    retirement: {
      preflightDigest: sha256('retirement-preflight'),
      receiptDigest: sha256('retirement-receipt'),
      receiptAuditCompatible: true,
      targetCount: 1,
      targetAbsent: true,
      uidResourceVersionDeletePreconditions: true,
      deploymentHeadCas: true,
      inventoryCount: 6,
      unixSocketProxy: true,
    },
    serverSideDryRun: true,
    serverSideApply: true,
    convergenceRead: true,
    deploymentHeadCas: true,
    resourceInventoryClosed: true,
    crossResourceAtomicity: false,
    cleanupComplete: true,
  });
}

function fixture(scope = 'all') {
  const finalizerConsumption = consumption(scope, 'finalizer');
  const input = {
    identity: identity(scope),
    finalizerConsumption,
  };
  if (scope !== 'cluster') {
    const localConsumption = consumption(scope, 'local');
    input.local = {
      consumption: localConsumption,
      edge: localReport(scope, localConsumption, 'edge'),
      standalone: localReport(scope, localConsumption, 'standalone'),
    };
  }
  if (scope !== 'local') {
    const clusterConsumption = consumption(scope, 'cluster');
    input.cluster = {
      consumption: clusterConsumption,
      report: clusterReport(scope, clusterConsumption),
    };
  }
  return { input, receipt: createDeploymentReadinessReceipt(input) };
}

test('requires the exact deployment families for Local, Cluster and All', () => {
  for (const [scope, families, reportCount] of [
    ['local', ['local'], 2],
    ['cluster', ['cluster'], 1],
    ['all', ['local', 'cluster'], 3],
  ]) {
    const { input, receipt } = fixture(scope);
    assert.equal(receipt.schema, SCHEMA);
    assert.deepEqual(receipt.requiredDeploymentFamilies, families);
    assert.equal(
      auditDeploymentReadinessReceipt(receipt, input).reportCount,
      reportCount,
    );
    assert.equal(
      validateDeploymentReadinessReceipt(receipt, {
        release: receipt.release,
        sourceRepository: SOURCE_REPOSITORY,
        releaseSetDigest: RELEASE_SET_DIGEST,
        catalogManifestDigest: MANIFEST_DIGEST,
        immutableReference: receipt.catalog.immutableReference,
      }),
      receipt,
    );
  }
});

test('rejects missing, extra and cross-scope deployment evidence', () => {
  const local = fixture('local').input;
  assert.throws(
    () =>
      createDeploymentReadinessReceipt({
        ...local,
        local: undefined,
      }),
    /local deployment catalog consumption is invalid/,
  );
  assert.throws(
    () =>
      createDeploymentReadinessReceipt({
        ...local,
        cluster: fixture('cluster').input.cluster,
      }),
    /cluster deployment evidence is forbidden/,
  );
  const all = fixture('all').input;
  assert.throws(
    () =>
      createDeploymentReadinessReceipt({
        ...all,
        cluster: undefined,
      }),
    /cluster deployment catalog consumption is invalid/,
  );
});

test('rejects reports detached from the independently consumed catalog', () => {
  const current = fixture('all').input;
  const drifted = structuredClone(current);
  drifted.local.consumption.catalogManifestDigest = sha256('other-manifest');
  drifted.local.consumption.immutableReference = `ghcr.io/${OWNER}/qinglong3-release-catalog@${drifted.local.consumption.catalogManifestDigest}`;
  drifted.local.edge.value.releaseAuthority.catalogManifestDigest =
    drifted.local.consumption.catalogManifestDigest;
  drifted.local.standalone.value.releaseAuthority.catalogManifestDigest =
    drifted.local.consumption.catalogManifestDigest;
  assert.throws(
    () => createDeploymentReadinessReceipt(drifted),
    /detached from the finalizer catalog/,
  );
});

test('rejects synthetic, incomplete and unclean deployment reports', () => {
  for (const mutate of [
    (input) => {
      input.local.edge.value.releaseAuthority.mode = 'synthetic_live_fixture';
    },
    (input) => {
      input.local.standalone.value.gracefulCleanup = false;
    },
    (input) => {
      input.local.edge.value.sqliteWriteContract = 0;
    },
    (input) => {
      input.cluster.report.value.receiptAuditCompatible = false;
    },
    (input) => {
      input.cluster.report.value.cleanupComplete = false;
    },
  ]) {
    const input = structuredClone(fixture('all').input);
    mutate(input);
    assert.throws(
      () => createDeploymentReadinessReceipt(input),
      /deployment evidence is invalid/,
    );
  }
});

test('requires one bounded SQLite write contract across Local profiles', () => {
  const input = structuredClone(fixture('local').input);
  input.local.standalone.value.sqliteWriteContract = 49;
  assert.throws(
    () => createDeploymentReadinessReceipt(input),
    /different SQLite write contracts/,
  );
});

test('rejects tampered, recomputed or authority-detached receipts', () => {
  const { receipt } = fixture('all');
  const tampered = structuredClone(receipt);
  tampered.receiptDigest = sha256('tampered');
  assert.throws(
    () => validateDeploymentReadinessReceipt(tampered),
    /receipt digest is invalid/,
  );
  const recomputed = structuredClone(receipt);
  recomputed.evidence[0].unexpected = true;
  delete recomputed.receiptDigest;
  recomputed.receiptDigest = sha256(JSON.stringify(recomputed));
  assert.throws(
    () => validateDeploymentReadinessReceipt(recomputed),
    /evidence summary is invalid/,
  );
  assert.throws(
    () =>
      validateDeploymentReadinessReceipt(receipt, {
        releaseSetDigest: sha256('another-release-set'),
      }),
    /authority is detached/,
  );
});

test('accepts only closed scope-specific CLI argument sets', () => {
  const common = [
    '--mode=create',
    `--version=${VERSION}`,
    `--source-revision=${REVISION}`,
    `--source-ref=refs/tags/v${VERSION}`,
    '--release-scope=local',
    `--repository-owner=${OWNER}`,
    `--source-repository=${SOURCE_REPOSITORY}`,
    '--finalizer-consumption-bundle=/tmp/finalizer',
    '--local-consumption-bundle=/tmp/local',
    '--edge-report=/tmp/edge',
    '--standalone-report=/tmp/standalone',
    '--output=/tmp/receipt',
  ];
  assert.equal(parseArguments(common).releaseScope, 'local');
  assert.throws(
    () => parseArguments([...common, '--cluster-report=/tmp/cluster']),
    /arguments are invalid/,
  );
  assert.throws(
    () => parseArguments(common.filter((entry) => !entry.startsWith('--edge'))),
    /arguments are invalid/,
  );
});
