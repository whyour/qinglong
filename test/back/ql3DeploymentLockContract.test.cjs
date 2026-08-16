'use strict';

const assert = require('node:assert/strict');
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
  createReleaseSet,
  createVerifiedImageRecord,
} = require('../../scripts/ql3-release-set-contract.cjs');
const {
  createReleaseCandidateContract,
} = require('../../scripts/ql3-release-candidate-contract.cjs');
const {
  readReleaseIdentity,
} = require('../../scripts/lib/ql3-release-identity.cjs');

const root = path.resolve(__dirname, '../..');
const version = readReleaseIdentity(root).version;
const identity = Object.freeze({
  version,
  sourceRevision: 'd'.repeat(40),
  sourceRef: `refs/tags/v${version}`,
  repositoryOwner: 'qinglong-release',
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
    ...identity,
    releaseScope: scope,
  });
}

function options(scope, extra = {}) {
  return Object.freeze({
    ...identity,
    releaseScope: scope,
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

function writeCanonical(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function kubernetesOptions(extra = {}) {
  return options('cluster', {
    requiredImages: roleOrder.join(','),
    ...extra,
  });
}

test('selects one immutable Local Compose image without adding device work', () => {
  for (const scope of ['local', 'all']) {
    const set = releaseSet(scope);
    const selection = createLocalSelection(
      set,
      options(scope, { allowRootService: false }),
    );
    assert.equal(selection.deploymentFamily, 'local');
    assert.equal(selection.releaseSetDigest, set.releaseSetDigest);
    assert.equal(selection.service.kind, 'compose');
    assert.equal(selection.service.image, references(set).local);
    assert.equal(selection.service.allowRootService, false);
    assert.equal(selection.verification.networkAccess, false);
    assert.equal(selection.verification.deploymentMutation, false);
    assert.match(selection.selectionDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(
      auditLocalSelection(
        selection,
        set,
        options(scope, { allowRootService: false }),
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
        options('cluster', { allowRootService: false }),
      ),
    /local or all release set/,
  );
  const localSet = releaseSet('local');
  assert.throws(
    () => createLocalSelection(localSet, options('local')),
    /explicit boolean/,
  );
  const selection = createLocalSelection(
    localSet,
    options('local', { allowRootService: true }),
  );
  const drifted = JSON.parse(JSON.stringify(selection));
  drifted.service.image = 'ghcr.io/example/qinglong3-local:latest';
  assert.throws(
    () =>
      auditLocalSelection(
        drifted,
        localSet,
        options('local', { allowRootService: true }),
      ),
    /differs from the verified release set/,
  );
});

test('materializes every supported Kubernetes image authority from one release set', () => {
  const set = releaseSet('cluster');
  const expectedReferences = references(set);
  const created = createKubernetesLock(
    set,
    fixtureManifest(),
    kubernetesOptions(),
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
      kubernetesOptions(),
    ).compatible,
    true,
  );
});

test('Kubernetes materialization rejects unsupported scope and incomplete role closure', () => {
  const localSet = releaseSet('local');
  assert.throws(
    () =>
      createKubernetesLock(localSet, fixtureManifest(), {
        ...options('local'),
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
    () => createKubernetesLock(clusterSet, withoutWorker, kubernetesOptions()),
    /required image was not rendered: worker/,
  );
});

test('rejects mutable, malformed and hidden QingLong image authorities', () => {
  const set = releaseSet('cluster');
  const hidden = `${fixtureManifest()}---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: hidden-authority\ndata:\n  image: ${
    references(set).control
  }\n`;
  assert.throws(
    () => createKubernetesLock(set, hidden, kubernetesOptions()),
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
        kubernetesOptions(),
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
        kubernetesOptions(),
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
        kubernetesOptions({ requiredImages: 'control' }),
      ),
    /duplicate-free YAML/,
  );
  assert.throws(
    () =>
      createKubernetesLock(
        set,
        '- not\n- a\n- resource\n',
        kubernetesOptions({ requiredImages: 'control' }),
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
        kubernetesOptions(),
      ),
    /admission image authority is invalid/,
  );
});

test('audit detects source, locked manifest and report drift', () => {
  const set = releaseSet('cluster');
  const created = createKubernetesLock(
    set,
    fixtureManifest(),
    kubernetesOptions(),
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
        kubernetesOptions(),
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
        kubernetesOptions(),
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
        kubernetesOptions(),
      ),
    /differs from the verified release set/,
  );
});

test('CLI creates and audits no-replace Local and Kubernetes outputs', (t) => {
  const directory = temporaryDirectory(t);
  const output = { write() {} };
  const localSet = releaseSet('local');
  const localSetPath = path.join(directory, 'local-set.json');
  const selectionPath = path.join(directory, 'selection.json');
  writeCanonical(localSetPath, localSet);
  const localIdentity = [
    `--version=${version}`,
    `--source-revision=${identity.sourceRevision}`,
    `--source-ref=${identity.sourceRef}`,
    '--release-scope=local',
    `--repository-owner=${identity.repositoryOwner}`,
    `--release-set=${localSetPath}`,
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
  const clusterSetPath = path.join(directory, 'cluster-set.json');
  const sourcePath = path.join(directory, 'rendered.yaml');
  const lockedPath = path.join(directory, 'locked.yaml');
  const reportPath = path.join(directory, 'lock.json');
  writeCanonical(clusterSetPath, clusterSet);
  fs.writeFileSync(sourcePath, fixtureManifest(), { mode: 0o600 });
  const clusterIdentity = [
    `--version=${version}`,
    `--source-revision=${identity.sourceRevision}`,
    `--source-ref=${identity.sourceRef}`,
    '--release-scope=cluster',
    `--repository-owner=${identity.repositoryOwner}`,
    `--release-set=${clusterSetPath}`,
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
  const localSetPath = path.join(directory, 'local-set.json');
  const linkedSetPath = path.join(directory, 'linked-set.json');
  writeCanonical(localSetPath, releaseSet('local'));
  fs.symlinkSync(localSetPath, linkedSetPath);
  const base = [
    '--mode=local-create',
    `--version=${version}`,
    `--source-revision=${identity.sourceRevision}`,
    `--source-ref=${identity.sourceRef}`,
    '--release-scope=local',
    `--repository-owner=${identity.repositoryOwner}`,
    `--release-set=${linkedSetPath}`,
    '--allow-root-service=false',
    `--output=${path.join(directory, 'selection.json')}`,
  ];
  assert.throws(
    () => runCli(base, root, { write() {} }),
    /canonical regular file/,
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

  const clusterSetPath = path.join(directory, 'cluster-set.json');
  const sourcePath = path.join(directory, 'rendered.yaml');
  const aliasedOutput = path.join(directory, 'same-output');
  writeCanonical(clusterSetPath, releaseSet('cluster'));
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
          `--release-set=${clusterSetPath}`,
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
    deploymentYamlFiles: 224,
    imageOccurrences: {
      control: 2,
      'control-ai': 1,
      admin: 26,
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
        kubernetesOptions({
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
