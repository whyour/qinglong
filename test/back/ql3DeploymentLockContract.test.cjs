'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const yaml = require('js-yaml');
const {
  auditDeploymentImageSurfaces,
  auditKubernetesLock,
  auditLocalSelection,
  createKubernetesLock,
  createLocalSelection,
  parseArguments,
  runCli,
} = require('../../scripts/ql3-deployment-lock-contract.cjs');
const {
  ARTIFACT_TYPE,
  FILE_MEDIA_TYPE,
  OCI_EMPTY_CONFIG_DIGEST,
  OCI_EMPTY_CONFIG_MEDIA_TYPE,
  OCI_MANIFEST_MEDIA_TYPE,
  createCatalogPlan,
} = require('../../scripts/ql3-release-catalog-contract.cjs');
const {
  runCeremony,
} = require('../../scripts/ql3-release-catalog-consumption-ceremony.cjs');
const {
  createReleaseSet,
  createVerifiedImageRecord,
} = require('../../scripts/ql3-release-set-contract.cjs');
const {
  createReleaseCandidateContract,
} = require('../../scripts/ql3-release-candidate-contract.cjs');
const {
  readReleaseIdentity,
} = require('../../scripts/lib/ql3-release-identity.cjs');
const {
  catalogLockedArtifacts,
  deploymentArtifacts,
} = require('../../scripts/ql3-kubernetes-deployment-live-contract.cjs');
const {
  privateReleaseEvidenceReceipts,
} = require('./ql3ReleaseEvidenceFixture.cjs');

const root = path.resolve(__dirname, '../..');
const version = readReleaseIdentity(root).version;
const identity = Object.freeze({
  version,
  sourceRevision: 'd'.repeat(40),
  sourceRef: `refs/tags/v${version}`,
  repositoryOwner: 'qinglong-release',
  sourceRepository: 'qinglong-release/qinglong',
});
const roleOrder = Object.freeze(['control', 'control-ai', 'admin', 'worker']);

function executableOnPath(name) {
  const candidates = [
    process.env.QL3_KUBECTL_BIN,
    '/Applications/Docker.app/Contents/Resources/bin/kubectl',
    ...(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, name)),
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.lstatSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

const kubectlPath = executableOnPath('kubectl');

function releaseSet(scope) {
  const candidate = createReleaseCandidateContract({
    root,
    version,
    sourceRevision: identity.sourceRevision,
    sourceRef: identity.sourceRef,
    releaseScope: scope,
  });
  const records = candidate.images.map((entry, index) =>
    createVerifiedImageRecord({
      root,
      candidate,
      ...identity,
      releaseScope: scope,
      image: entry.image,
      digest: `sha256:${String(index + 1).repeat(64)}`,
    }),
  );
  return createReleaseSet({
    root,
    candidate,
    records,
    evidenceReceipts: privateReleaseEvidenceReceipts(candidate.release),
    ...identity,
    validationClockMs: Date.parse('2026-08-18T00:05:00.000Z'),
    releaseScope: scope,
  });
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function consumptionAuthority(set) {
  const manifestDigest = sha256(
    Buffer.from(`catalog:${set.release.scope}`, 'utf8'),
  );
  return Object.freeze({
    compatible: true,
    releaseScope: set.release.scope,
    sourceRepository: identity.sourceRepository,
    workflowIdentity: `https://github.com/${identity.sourceRepository}/.github/workflows/ql3-image-release.yml@${identity.sourceRef}`,
    releaseSetDigest: set.releaseSetDigest,
    catalogManifestDigest: manifestDigest,
    immutableReference: `ghcr.io/${identity.repositoryOwner}/qinglong3-release-catalog@${manifestDigest}`,
    imageCount: set.images.length,
    discoveryTagAuthority: 'none',
    externalToolResultsReplayed: false,
    deploymentMutation: false,
    contentDigest: sha256(Buffer.from(`report:${set.release.scope}`, 'utf8')),
  });
}

function options(set, extra = {}) {
  return Object.freeze({
    ...identity,
    releaseScope: set.release.scope,
    consumption: consumptionAuthority(set),
    ...extra,
  });
}

function references(set) {
  return Object.fromEntries(
    set.images.map((image) => [image.name, image.reference]),
  );
}

function fixtureManifest() {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ql3-control
spec:
  template:
    metadata:
      labels:
        app: ql3-control
    spec:
      initContainers:
        - name: migrate
          image: ghcr.io/example/qinglong3-cluster-control:source
      containers:
        - name: control
          image: qinglong3-cluster-control@sha256:${'0'.repeat(64)}
        - name: sidecar
          image: busybox:1.36
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ql3-control-ai
spec:
  template:
    metadata: {}
    spec:
      containers:
        - name: control-ai
          image: registry.example:5000/team/qinglong3-cluster-control-ai:source
---
apiVersion: batch/v1
kind: Job
metadata:
  name: ql3-admin
spec:
  template:
    metadata: {}
    spec:
      restartPolicy: Never
      containers:
        - name: admin
          image: qinglong3-cluster-admin@sha256:${'0'.repeat(64)}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ql3-worker
spec:
  template:
    metadata: {}
    spec:
      initContainers:
        - name: worker-init
          image: qinglong3-worker:source
      containers:
        - name: worker
          image: ghcr.io/example/qinglong3-worker@sha256:${'0'.repeat(64)}
      ephemeralContainers:
        - name: worker-debug
          image: qinglong3-worker:debug
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ql3-plugin-package-secret-action-admission
data:
  image: qinglong3-cluster-admin@sha256:${'0'.repeat(64)}
---
apiVersion: v1
kind: Service
metadata:
  name: ql3-control
spec:
  selector:
    app: ql3-control
  ports:
    - port: 80
`;
}

function temporaryDirectory(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-deployment-lock-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function catalogManifest(set) {
  const plan = createCatalogPlan(set, {
    ...identity,
    releaseScope: set.release.scope,
  });
  return {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST_MEDIA_TYPE,
    artifactType: ARTIFACT_TYPE,
    config: {
      mediaType: OCI_EMPTY_CONFIG_MEDIA_TYPE,
      digest: OCI_EMPTY_CONFIG_DIGEST,
      size: 2,
    },
    layers: [
      {
        mediaType: FILE_MEDIA_TYPE,
        digest: plan.releaseSet.contentDigest,
        size: plan.releaseSet.bytes,
        annotations: {
          'org.opencontainers.image.title': plan.releaseSet.fileName,
        },
      },
    ],
    annotations: { ...plan.catalog.annotations },
  };
}

function consumptionBundle(t, parent, name, set) {
  const toolRoot = path.join(parent, `${name}-tools`);
  fs.mkdirSync(toolRoot, { mode: 0o700 });
  const releaseText = `${JSON.stringify(set)}\n`;
  const manifestText = JSON.stringify(catalogManifest(set));
  const manifestDigest = sha256(Buffer.from(manifestText, 'utf8'));
  const tools = {};
  for (const toolName of ['regctl', 'cosign', 'gh']) {
    const toolPath = path.join(toolRoot, toolName);
    const behavior =
      toolName === 'regctl'
        ? `
if (args[0] === 'image' && args[1] === 'digest') {
  process.stdout.write(${JSON.stringify(`${manifestDigest}\n`)});
} else if (args[0] === 'artifact' && args[1] === 'get') {
  process.stdout.write(${JSON.stringify(releaseText)});
} else if (args[0] === 'manifest' && args[1] === 'get') {
  process.stdout.write(${JSON.stringify(manifestText)});
} else {
  process.exitCode = 7;
}
`
        : '';
    fs.writeFileSync(
      toolPath,
      `#!${process.execPath}\n'use strict';\nconst args = process.argv.slice(2);\n${behavior}`,
      { mode: 0o700 },
    );
    tools[toolName] = toolPath;
  }
  const tokenFile = path.join(toolRoot, 'github-token');
  fs.writeFileSync(tokenFile, 'github_pat_deployment_lock_fixture', {
    mode: 0o600,
  });
  const outputDirectory = path.join(parent, `${name}-bundle`);
  runCeremony({
    ...identity,
    releaseScope: set.release.scope,
    outputDirectory,
    regctl: tools.regctl,
    cosign: tools.cosign,
    gh: tools.gh,
    githubTokenFile: tokenFile,
  });
  t.after(() => {
    if (fs.existsSync(outputDirectory)) {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
  return outputDirectory;
}

function kubernetesOptions(set, extra = {}) {
  return options(set, {
    requiredImages: roleOrder.join(','),
    ...extra,
  });
}

test('materializes the Kubernetes live lock from one audited catalog consumption bundle', function materializesCatalogBoundLiveLock() {
  const set = releaseSet('cluster');
  const consumption = Object.freeze({
    ...consumptionAuthority(set),
    releaseSet: set,
  });
  const consumptionBundle = '/private/ql3-release-catalog-consumption';
  let auditedOptions;
  const artifacts = catalogLockedArtifacts(
    {
      ...identity,
      releaseScope: 'cluster',
      consumptionBundle,
    },
    {
      auditCeremonyBundle(options) {
        auditedOptions = options;
        return consumption;
      },
    },
  );
  assert.deepEqual(auditedOptions, {
    ...identity,
    releaseScope: 'cluster',
    outputDirectory: consumptionBundle,
  });
  assert.equal(artifacts.report.releaseSetDigest, set.releaseSetDigest);
  assert.equal(
    artifacts.report.catalog.manifestDigest,
    consumption.catalogManifestDigest,
  );
  assert.equal(artifacts.releaseAuthority.mode, 'verified_release_catalog');
  assert.equal(
    artifacts.releaseAuthority.catalogConsumptionDigest,
    consumption.contentDigest,
  );
  assert.deepEqual(artifacts.imageReferences, references(set));
  assert.equal(artifacts.report.manifest.resources, 7);
  assert.equal(artifacts.report.manifest.changedResources, 5);
  assert.equal(artifacts.report.manifest.admissionAuthorityCount, 1);
  const resources = [];
  yaml.loadAll(artifacts.manifest, (resource) => resources.push(resource));
  assert.equal(resources.length, 7);
  assert.equal(
    resources.find(
      (resource) => resource.metadata?.name === 'ql3-retirement-live-target',
    )?.data?.purpose,
    'catalog-bound-retirement-live-contract',
  );
  for (const resource of resources.filter(
    (entry) => entry.kind === 'Deployment',
  )) {
    assert.equal(
      resource.metadata.annotations['qinglong.io/release-set-digest'],
      set.releaseSetDigest,
    );
    assert.match(
      resource.spec.template.spec.containers[0].image,
      /^ghcr\.io\/qinglong-release\/qinglong3-[a-z-]+@sha256:[a-f0-9]{64}$/u,
    );
  }
});

test('selects catalog-backed live artifacts only for one complete environment', function selectsCompleteCatalogLiveEnvironment() {
  assert.equal(
    deploymentArtifacts({}).releaseAuthority.mode,
    'synthetic_live_fixture',
  );
  assert.throws(
    () =>
      deploymentArtifacts({
        QL3_RELEASE_CATALOG_CONSUMPTION_BUNDLE: '/private/bundle',
      }),
    /configuration is incomplete/u,
  );
  assert.throws(
    () =>
      catalogLockedArtifacts({
        ...identity,
        releaseScope: 'local',
        consumptionBundle: '/private/bundle',
      }),
    /requires cluster or all scope/u,
  );
  const set = releaseSet('all');
  const consumption = Object.freeze({
    ...consumptionAuthority(set),
    releaseSet: set,
  });
  const environment = {
    QL3_RELEASE_CATALOG_CONSUMPTION_BUNDLE: '/private/bundle',
    QL3_RELEASE_SOURCE_REVISION: identity.sourceRevision,
    QL3_RELEASE_SOURCE_REF: identity.sourceRef,
    QL3_RELEASE_SCOPE: 'all',
    QL3_RELEASE_REPOSITORY_OWNER: identity.repositoryOwner,
    QL3_RELEASE_SOURCE_REPOSITORY: identity.sourceRepository,
  };
  const artifacts = deploymentArtifacts(environment, {
    auditCeremonyBundle: () => consumption,
  });
  assert.equal(artifacts.releaseAuthority.mode, 'verified_release_catalog');
  assert.equal(artifacts.releaseAuthority.scope, 'all');
  assert.equal(artifacts.report.release.scope, 'all');
  assert.equal(artifacts.report.requiredImages.length, 4);
});

test('selects one immutable Local Compose image without adding device work', () => {
  for (const scope of ['local', 'all']) {
    const set = releaseSet(scope);
    const selection = createLocalSelection(
      set,
      options(set, { allowRootService: false }),
    );
    assert.equal(selection.deploymentFamily, 'local');
    assert.equal(selection.schema, 'qinglong/local-compose-release-image@v2');
    assert.equal(selection.releaseSetDigest, set.releaseSetDigest);
    assert.equal(
      selection.catalog.releaseSetDigest,
      selection.releaseSetDigest,
    );
    assert.match(
      selection.catalog.immutableReference,
      /^ghcr\.io\/qinglong-release\/qinglong3-release-catalog@sha256:[a-f0-9]{64}$/u,
    );
    assert.equal(selection.catalog.discoveryTagAuthority, 'none');
    assert.equal(selection.service.kind, 'compose');
    assert.equal(selection.service.image, references(set).local);
    assert.equal(selection.service.allowRootService, false);
    assert.equal(selection.verification.networkAccess, false);
    assert.equal(selection.verification.deploymentMutation, false);
    assert.equal(
      selection.verification.catalogConsumption,
      'offline_reconstructed',
    );
    assert.equal(selection.verification.externalToolResultsReplayed, false);
    assert.match(selection.selectionDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(
      auditLocalSelection(
        selection,
        set,
        options(set, { allowRootService: false }),
      ).compatible,
      true,
    );
  }
});

test('Local selection rejects cluster scope, implicit root policy and drift', () => {
  const clusterSet = releaseSet('cluster');
  assert.throws(
    () =>
      createLocalSelection(
        clusterSet,
        options(clusterSet, { allowRootService: false }),
      ),
    /local or all release set/,
  );
  const localSet = releaseSet('local');
  assert.throws(
    () => createLocalSelection(localSet, options(localSet)),
    /explicit boolean/,
  );
  const selection = createLocalSelection(
    localSet,
    options(localSet, { allowRootService: true }),
  );
  const drifted = JSON.parse(JSON.stringify(selection));
  drifted.service.image = 'ghcr.io/example/qinglong3-local:latest';
  assert.throws(
    () =>
      auditLocalSelection(
        drifted,
        localSet,
        options(localSet, { allowRootService: true }),
      ),
    /differs from the verified release set/,
  );
});

test('deployment materialization rejects missing or mismatched catalog authority', () => {
  const set = releaseSet('local');
  assert.throws(
    () =>
      createLocalSelection(set, {
        ...identity,
        releaseScope: 'local',
        allowRootService: false,
      }),
    /catalog consumption authority is invalid/,
  );
  const drifted = {
    ...consumptionAuthority(set),
    contentDigest: `sha256:${'0'.repeat(64)}`,
    releaseSetDigest: `sha256:${'1'.repeat(64)}`,
  };
  assert.throws(
    () =>
      createLocalSelection(set, {
        ...options(set, { allowRootService: false }),
        consumption: drifted,
      }),
    /catalog consumption authority is invalid/,
  );
});

test('materializes every supported Kubernetes image authority from one release set', () => {
  const set = releaseSet('cluster');
  const expectedReferences = references(set);
  const created = createKubernetesLock(
    set,
    fixtureManifest(),
    kubernetesOptions(set),
  );
  const resources = [];
  yaml.loadAll(created.outputManifest, (resource) => resources.push(resource));
  const renderedImages = resources.flatMap((resource) => {
    const podSpec =
      resource.kind === 'Job'
        ? resource.spec?.template?.spec
        : resource.spec?.template?.spec;
    return ['initContainers', 'containers', 'ephemeralContainers'].flatMap(
      (key) => podSpec?.[key]?.map((container) => container.image) ?? [],
    );
  });
  assert.deepEqual(created.report.requiredImages, roleOrder);
  assert.deepEqual(
    created.report.imageOccurrences.map(({ name, count }) => [name, count]),
    [
      ['control', 2],
      ['control-ai', 1],
      ['admin', 2],
      ['worker', 3],
    ],
  );
  assert.equal(created.report.manifest.resources, 6);
  assert.equal(created.report.schema, 'qinglong/kubernetes-deployment-lock@v2');
  assert.equal(created.report.catalog.releaseSetDigest, set.releaseSetDigest);
  assert.equal(created.report.manifest.changedResources, 5);
  assert.equal(created.report.manifest.admissionAuthorityCount, 1);
  assert.equal(created.report.verification.unknownImageAuthorities, 0);
  assert.equal(created.report.verification.mutableQingLongImages, 0);
  assert.equal(created.report.verification.networkAccess, false);
  assert.equal(created.report.verification.kubernetesMutation, false);
  assert.equal(renderedImages.includes('busybox:1.36'), true);
  for (const role of roleOrder) {
    assert.equal(
      renderedImages.includes(expectedReferences[role]) || role === 'admin',
      true,
    );
  }
  const admission = resources.find(
    (resource) =>
      resource.kind === 'ConfigMap' &&
      resource.metadata.name === 'ql3-plugin-package-secret-action-admission',
  );
  assert.equal(admission.data.image, expectedReferences.admin);
  for (const resource of resources.filter(
    (entry) => entry.kind !== 'Service',
  )) {
    assert.equal(
      resource.metadata.annotations['qinglong.io/release-set-digest'],
      set.releaseSetDigest,
    );
    assert.equal(
      resource.metadata.annotations[
        'qinglong.io/release-catalog-manifest-digest'
      ],
      created.report.catalog.manifestDigest,
    );
    assert.equal(
      resource.metadata.annotations[
        'qinglong.io/release-catalog-report-digest'
      ],
      created.report.catalog.consumptionReportDigest,
    );
  }
  assert.equal(
    created.outputManifest.includes('qinglong3-cluster-control:source'),
    false,
  );
  assert.equal(
    auditKubernetesLock(
      created.outputManifest,
      created.report,
      set,
      fixtureManifest(),
      kubernetesOptions(set),
    ).compatible,
    true,
  );
});

test('Kubernetes materialization rejects unsupported scope and incomplete role closure', () => {
  const localSet = releaseSet('local');
  assert.throws(
    () =>
      createKubernetesLock(localSet, fixtureManifest(), {
        ...options(localSet),
        requiredImages: 'control',
      }),
    /cluster or all release set/,
  );
  const clusterSet = releaseSet('cluster');
  const withoutWorker = fixtureManifest().replace(
    /---\napiVersion: apps\/v1\nkind: Deployment\nmetadata:\n  name: ql3-worker[\s\S]*?(?=---\napiVersion: v1\nkind: ConfigMap)/u,
    '',
  );
  assert.throws(
    () =>
      createKubernetesLock(
        clusterSet,
        withoutWorker,
        kubernetesOptions(clusterSet),
      ),
    /required image was not rendered: worker/,
  );
});

test('rejects mutable, malformed and hidden QingLong image authorities', () => {
  const set = releaseSet('cluster');
  const hidden = `${fixtureManifest()}---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: hidden-authority\ndata:\n  image: ${
    references(set).control
  }\n`;
  assert.throws(
    () => createKubernetesLock(set, hidden, kubernetesOptions(set)),
    /unhandled QingLong image authority: data.image/,
  );
  assert.throws(
    () =>
      createKubernetesLock(
        set,
        fixtureManifest().replace(
          'qinglong3-cluster-control@sha256:',
          'qinglong3-cluster-control-not-an-image@sha256:',
        ),
        kubernetesOptions(set),
      ),
    /unhandled QingLong image authority|container image is malformed/,
  );
  assert.throws(
    () =>
      createKubernetesLock(
        set,
        fixtureManifest().replace(
          'qinglong3-worker:source',
          'qinglong3-worker',
        ),
        kubernetesOptions(set),
      ),
    /container image is malformed/,
  );
});

test('rejects unsafe YAML structure and invalid admission authority', () => {
  const set = releaseSet('cluster');
  assert.throws(
    () =>
      createKubernetesLock(
        set,
        'apiVersion: v1\nkind: Pod\nkind: Job\n',
        kubernetesOptions(set, { requiredImages: 'control' }),
      ),
    /duplicate-free YAML/,
  );
  assert.throws(
    () =>
      createKubernetesLock(
        set,
        '- not\n- a\n- resource\n',
        kubernetesOptions(set, { requiredImages: 'control' }),
      ),
    /resource must be one mapping/,
  );
  assert.throws(
    () =>
      createKubernetesLock(
        set,
        fixtureManifest().replace(
          'data:\n  image: qinglong3-cluster-admin',
          'data:\n  image: busybox',
        ),
        kubernetesOptions(set),
      ),
    /admission image authority is invalid/,
  );
});

test('audit detects source, locked manifest and report drift', () => {
  const set = releaseSet('cluster');
  const created = createKubernetesLock(
    set,
    fixtureManifest(),
    kubernetesOptions(set),
  );
  const report = JSON.parse(JSON.stringify(created.report));
  report.manifest.resources += 1;
  assert.throws(
    () =>
      auditKubernetesLock(
        created.outputManifest,
        report,
        set,
        fixtureManifest(),
        kubernetesOptions(set),
      ),
    /differs from the verified release set/,
  );
  assert.throws(
    () =>
      auditKubernetesLock(
        `${created.outputManifest}\n`,
        created.report,
        set,
        fixtureManifest(),
        kubernetesOptions(set),
      ),
    /differs from the verified release set/,
  );
  assert.throws(
    () =>
      auditKubernetesLock(
        created.outputManifest,
        created.report,
        set,
        `${fixtureManifest()}\n`,
        kubernetesOptions(set),
      ),
    /differs from the verified release set/,
  );
});

test('CLI creates and audits no-replace Local and Kubernetes outputs', (t) => {
  const directory = temporaryDirectory(t);
  const output = { write() {} };
  const localSet = releaseSet('local');
  const localBundle = consumptionBundle(t, directory, 'local', localSet);
  const selectionPath = path.join(directory, 'selection.json');
  const localIdentity = [
    `--version=${version}`,
    `--source-revision=${identity.sourceRevision}`,
    `--source-ref=${identity.sourceRef}`,
    '--release-scope=local',
    `--repository-owner=${identity.repositoryOwner}`,
    `--source-repository=${identity.sourceRepository}`,
    `--consumption-bundle=${localBundle}`,
    '--allow-root-service=false',
  ];
  runCli(
    ['--mode=local-create', ...localIdentity, `--output=${selectionPath}`],
    root,
    output,
  );
  assert.equal(fs.statSync(selectionPath).mode & 0o777, 0o600);
  assert.equal(
    runCli(
      ['--mode=local-audit', ...localIdentity, `--selection=${selectionPath}`],
      root,
      output,
    ).compatible,
    true,
  );
  assert.throws(
    () =>
      runCli(
        ['--mode=local-create', ...localIdentity, `--output=${selectionPath}`],
        root,
        output,
      ),
    /output must be unused/,
  );

  const clusterSet = releaseSet('cluster');
  const clusterBundle = consumptionBundle(t, directory, 'cluster', clusterSet);
  const sourcePath = path.join(directory, 'rendered.yaml');
  const lockedPath = path.join(directory, 'locked.yaml');
  const reportPath = path.join(directory, 'lock.json');
  fs.writeFileSync(sourcePath, fixtureManifest(), { mode: 0o600 });
  const clusterIdentity = [
    `--version=${version}`,
    `--source-revision=${identity.sourceRevision}`,
    `--source-ref=${identity.sourceRef}`,
    '--release-scope=cluster',
    `--repository-owner=${identity.repositoryOwner}`,
    `--source-repository=${identity.sourceRepository}`,
    `--consumption-bundle=${clusterBundle}`,
    `--manifest=${sourcePath}`,
    `--required-images=${roleOrder.join(',')}`,
  ];
  runCli(
    [
      '--mode=kubernetes-create',
      ...clusterIdentity,
      `--output-manifest=${lockedPath}`,
      `--output-report=${reportPath}`,
    ],
    root,
    output,
  );
  assert.equal(fs.statSync(lockedPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(reportPath).mode & 0o777, 0o600);
  assert.equal(
    runCli(
      [
        '--mode=kubernetes-audit',
        ...clusterIdentity,
        `--locked-manifest=${lockedPath}`,
        `--report=${reportPath}`,
      ],
      root,
      output,
    ).compatible,
    true,
  );
});

test('CLI rejects symlinks, open arguments, output aliasing and policy ambiguity', (t) => {
  const directory = temporaryDirectory(t);
  const localSet = releaseSet('local');
  const localBundle = consumptionBundle(t, directory, 'local', localSet);
  const linkedBundle = path.join(directory, 'linked-bundle');
  fs.symlinkSync(localBundle, linkedBundle, 'dir');
  const base = [
    '--mode=local-create',
    `--version=${version}`,
    `--source-revision=${identity.sourceRevision}`,
    `--source-ref=${identity.sourceRef}`,
    '--release-scope=local',
    `--repository-owner=${identity.repositoryOwner}`,
    `--source-repository=${identity.sourceRepository}`,
    `--consumption-bundle=${linkedBundle}`,
    '--allow-root-service=false',
    `--output=${path.join(directory, 'selection.json')}`,
  ];
  assert.throws(
    () => runCli(base, root, { write() {} }),
    /canonical directory/,
  );
  assert.throws(
    () => parseArguments([...base, '--extra=value']),
    /arguments are invalid/,
  );
  assert.throws(
    () =>
      parseArguments(
        base.map((argument) =>
          argument === '--allow-root-service=false'
            ? '--allow-root-service=maybe'
            : argument,
        ),
      ),
    /must be true or false/,
  );
  assert.throws(
    () =>
      parseArguments(
        base.map((argument) =>
          argument.startsWith('--consumption-bundle=')
            ? `--release-set=${path.join(directory, 'loose-release-set.json')}`
            : argument,
        ),
      ),
    /arguments are invalid/,
  );

  const clusterSet = releaseSet('cluster');
  const clusterBundle = consumptionBundle(t, directory, 'cluster', clusterSet);
  const sourcePath = path.join(directory, 'rendered.yaml');
  const aliasedOutput = path.join(directory, 'same-output');
  fs.writeFileSync(sourcePath, fixtureManifest(), { mode: 0o600 });
  assert.throws(
    () =>
      runCli(
        [
          '--mode=kubernetes-create',
          `--version=${version}`,
          `--source-revision=${identity.sourceRevision}`,
          `--source-ref=${identity.sourceRef}`,
          '--release-scope=cluster',
          `--repository-owner=${identity.repositoryOwner}`,
          `--source-repository=${identity.sourceRepository}`,
          `--consumption-bundle=${clusterBundle}`,
          `--manifest=${sourcePath}`,
          `--required-images=${roleOrder.join(',')}`,
          `--output-manifest=${aliasedOutput}`,
          `--output-report=${aliasedOutput}`,
        ],
        root,
        { write() {} },
      ),
    /paths must differ/,
  );
});

test('source-surface audit freezes every reviewed cluster and worker authority', () => {
  assert.deepEqual(auditDeploymentImageSurfaces(root), {
    schemaVersion: 1,
    deploymentYamlFiles: 241,
    imageOccurrences: {
      control: 2,
      'control-ai': 1,
      admin: 28,
      worker: 2,
    },
    admissionAuthorityCount: 2,
    materialization: 'offline_post_render',
    networkAccess: false,
    kubernetesMutation: false,
    compatible: true,
  });
  assert.deepEqual(
    runCli(['--mode=surfaces-audit'], root, { write() {} }),
    auditDeploymentImageSurfaces(root),
  );
});

test('deployment-lock CLI cannot regress to a loose release-set input', () => {
  const source = fs.readFileSync(
    path.join(root, 'scripts/ql3-deployment-lock-contract.cjs'),
    'utf8',
  );
  assert.match(source, /auditCeremonyBundle\(/u);
  assert.match(source, /'consumption-bundle'/u);
  assert.match(source, /'source-repository'/u);
  assert.doesNotMatch(source, /['"]release-set['"]/u);
  assert.match(source, /qinglong\/local-compose-release-image@v2/u);
  assert.match(source, /qinglong\/kubernetes-deployment-lock@v2/u);
});

test(
  'real Kustomize renders are locked after nested overlay transforms',
  { skip: kubectlPath ? false : 'kubectl is unavailable' },
  () => {
    const set = releaseSet('cluster');
    const expectedReferences = references(set);
    for (const entry of [
      {
        directory: 'deploy/kubernetes/ql3-cluster/overlays/cloudnative-pg',
        requiredImages: ['control'],
      },
      {
        directory: 'deploy/kubernetes/ql3-cluster/overlays/cluster-ai-example',
        requiredImages: ['control-ai'],
      },
      {
        directory: 'deploy/kubernetes/ql3-worker/overlays/node',
        requiredImages: ['worker'],
      },
      {
        directory:
          'deploy/kubernetes/ql3-cluster/operations/plugin-package-executor/cloudnative-pg',
        requiredImages: ['admin'],
      },
    ]) {
      const rendered = spawnSync(
        kubectlPath,
        ['kustomize', path.join(root, entry.directory)],
        {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      assert.equal(
        rendered.status,
        0,
        `${entry.directory}: ${rendered.stderr}`,
      );
      const created = createKubernetesLock(
        set,
        rendered.stdout,
        kubernetesOptions(set, {
          requiredImages: entry.requiredImages.join(','),
        }),
      );
      for (const role of entry.requiredImages) {
        assert.equal(
          created.outputManifest.includes(expectedReferences[role]),
          true,
        );
        assert.equal(
          created.report.imageOccurrences.find((image) => image.name === role)
            .count > 0,
          true,
        );
      }
      assert.equal(
        created.outputManifest.includes(
          '@sha256:0000000000000000000000000000000000000000000000000000000000000000',
        ),
        false,
      );
    }
  },
);
