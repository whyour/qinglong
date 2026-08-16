'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  auditReleaseSet,
  createReleaseSet,
  createVerifiedImageRecord,
  inspectReleaseSet,
  parseArguments,
  runCli,
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
  sourceRevision: 'b'.repeat(40),
  sourceRef: `refs/tags/v${version}`,
  repositoryOwner: 'qinglong-release',
});

function candidate(scope) {
  return createReleaseCandidateContract({
    root,
    version,
    sourceRevision: identity.sourceRevision,
    sourceRef: identity.sourceRef,
    releaseScope: scope,
  });
}

function recordsFor(releaseCandidate) {
  return releaseCandidate.images.map((entry, index) =>
    createVerifiedImageRecord({
      root,
      candidate: releaseCandidate,
      ...identity,
      releaseScope: releaseCandidate.release.scope,
      image: entry.image,
      digest: `sha256:${String(index + 1).repeat(64)}`,
    }),
  );
}

function temporaryDirectory(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-release-set-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeCanonical(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

test('aggregates the independent Local image into one immutable release set', () => {
  const releaseCandidate = candidate('local');
  const records = recordsFor(releaseCandidate);
  const releaseSet = createReleaseSet({
    root,
    candidate: releaseCandidate,
    records,
    ...identity,
    releaseScope: 'local',
  });
  assert.deepEqual(
    releaseSet.images.map((entry) => entry.name),
    ['local'],
  );
  assert.equal(releaseSet.deploymentFamilies.local.selected, true);
  assert.equal(releaseSet.deploymentFamilies.cluster.selected, false);
  assert.match(releaseSet.images[0].reference, /@sha256:1{64}$/u);
  assert.equal(releaseSet.promotion.authority, 'complete_verified_release_set');
  assert.match(releaseSet.releaseSetDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    auditReleaseSet(releaseSet, {
      root,
      candidate: releaseCandidate,
      records,
      ...identity,
      releaseScope: 'local',
    }).compatible,
    true,
  );
});

test('closes cluster and all scopes over the exact candidate image order', () => {
  const clusterCandidate = candidate('cluster');
  const clusterSet = createReleaseSet({
    root,
    candidate: clusterCandidate,
    records: recordsFor(clusterCandidate).reverse(),
    ...identity,
    releaseScope: 'cluster',
  });
  assert.deepEqual(
    clusterSet.images.map((entry) => entry.name),
    ['control', 'control-ai', 'admin', 'worker'],
  );
  assert.deepEqual(clusterSet.deploymentFamilies.cluster.images, [
    'control',
    'control-ai',
    'admin',
    'worker',
  ]);

  const allCandidate = candidate('all');
  const allSet = createReleaseSet({
    root,
    candidate: allCandidate,
    records: recordsFor(allCandidate),
    ...identity,
    releaseScope: 'all',
  });
  assert.equal(allSet.images.length, 5);
  assert.deepEqual(allSet.deploymentFamilies.local.images, ['local']);
});

test('rejects missing, duplicate and cross-candidate image evidence', () => {
  const releaseCandidate = candidate('cluster');
  const records = recordsFor(releaseCandidate);
  assert.throws(
    () =>
      createReleaseSet({
        root,
        candidate: releaseCandidate,
        records: records.slice(1),
        ...identity,
        releaseScope: 'cluster',
      }),
    /record count differs/,
  );
  assert.throws(
    () =>
      createReleaseSet({
        root,
        candidate: releaseCandidate,
        records: [records[0], records[0], records[2], records[3]],
        ...identity,
        releaseScope: 'cluster',
      }),
    /records must be unique/,
  );
  const mutated = JSON.parse(JSON.stringify(records[0]));
  mutated.release.sourceRevision = 'c'.repeat(40);
  assert.throws(
    () =>
      createReleaseSet({
        root,
        candidate: releaseCandidate,
        records: [mutated, ...records.slice(1)],
        ...identity,
        releaseScope: 'cluster',
      }),
    /image record drifted/,
  );
});

test('rejects mutable identity, malformed owner and post-aggregate drift', () => {
  const releaseCandidate = candidate('local');
  assert.throws(
    () =>
      createVerifiedImageRecord({
        root,
        candidate: releaseCandidate,
        ...identity,
        repositoryOwner: 'UPPERCASE',
        releaseScope: 'local',
        image: 'local',
        digest: `sha256:${'1'.repeat(64)}`,
      }),
    /lowercase GitHub owner/,
  );
  assert.throws(
    () =>
      createVerifiedImageRecord({
        root,
        candidate: releaseCandidate,
        ...identity,
        releaseScope: 'local',
        image: 'local',
        digest: 'latest',
      }),
    /exact SHA-256 digest/,
  );
  const records = recordsFor(releaseCandidate);
  const releaseSet = createReleaseSet({
    root,
    candidate: releaseCandidate,
    records,
    ...identity,
    releaseScope: 'local',
  });
  const mutated = JSON.parse(JSON.stringify(releaseSet));
  mutated.images[0].versionTag = 'ghcr.io/qinglong-release/other:latest';
  assert.throws(
    () =>
      auditReleaseSet(mutated, {
        root,
        candidate: releaseCandidate,
        records,
        ...identity,
        releaseScope: 'local',
      }),
    /differs from the verified image records/,
  );
});

test('inspects a release set without short-lived candidate or image records', () => {
  for (const scope of ['local', 'cluster', 'all']) {
    const releaseCandidate = candidate(scope);
    const releaseSet = createReleaseSet({
      root,
      candidate: releaseCandidate,
      records: recordsFor(releaseCandidate),
      ...identity,
      releaseScope: scope,
    });
    const inspection = inspectReleaseSet(releaseSet, {
      ...identity,
      releaseScope: scope,
    });
    assert.equal(inspection.compatible, true);
    assert.equal(inspection.imageCount, releaseCandidate.images.length);
    assert.equal(inspection.sourceRecordsReplayed, false);
  }
});

test('standalone inspection rejects image, family and self-digest drift', () => {
  const releaseCandidate = candidate('cluster');
  const releaseSet = createReleaseSet({
    root,
    candidate: releaseCandidate,
    records: recordsFor(releaseCandidate),
    ...identity,
    releaseScope: 'cluster',
  });
  for (const mutate of [
    (value) => {
      value.images[0].repository = 'other';
    },
    (value) => {
      value.deploymentFamilies.cluster.images.pop();
    },
    (value) => {
      value.releaseSetDigest = `sha256:${'0'.repeat(64)}`;
    },
  ]) {
    const drifted = JSON.parse(JSON.stringify(releaseSet));
    mutate(drifted);
    assert.throws(
      () =>
        inspectReleaseSet(drifted, {
          ...identity,
          releaseScope: 'cluster',
        }),
      /standalone release set/,
    );
  }
  assert.throws(
    () =>
      inspectReleaseSet(releaseSet, {
        ...identity,
        version: '3.0.0+unreviewed',
        sourceRef: 'refs/tags/v3.0.0+unreviewed',
        releaseScope: 'cluster',
      }),
    /expected release identity is invalid/,
  );
});

test('CLI records, aggregates and audits exact no-replace files', (t) => {
  const directory = temporaryDirectory(t);
  const recordsDirectory = path.join(directory, 'records');
  fs.mkdirSync(recordsDirectory);
  const releaseCandidate = candidate('local');
  const candidatePath = path.join(directory, 'candidate.json');
  writeCanonical(candidatePath, releaseCandidate);
  const recordPath = path.join(recordsDirectory, 'local.json');
  const common = [
    `--version=${version}`,
    `--source-revision=${identity.sourceRevision}`,
    `--source-ref=${identity.sourceRef}`,
    '--release-scope=local',
    `--repository-owner=${identity.repositoryOwner}`,
    `--candidate=${candidatePath}`,
  ];
  const output = { write() {} };
  runCli(
    [
      '--mode=record-image',
      ...common,
      '--image=local',
      `--digest=sha256:${'1'.repeat(64)}`,
      `--output=${recordPath}`,
    ],
    root,
    output,
  );
  assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
  const setPath = path.join(directory, 'release-set.json');
  runCli(
    [
      '--mode=aggregate',
      ...common,
      `--records=${recordsDirectory}`,
      `--output=${setPath}`,
    ],
    root,
    output,
  );
  assert.equal(
    runCli(
      [
        '--mode=audit',
        ...common,
        `--records=${recordsDirectory}`,
        `--report=${setPath}`,
      ],
      root,
      output,
    ).compatible,
    true,
  );
  assert.equal(
    runCli(
      [
        '--mode=inspect',
        `--version=${version}`,
        `--source-revision=${identity.sourceRevision}`,
        `--source-ref=${identity.sourceRef}`,
        '--release-scope=local',
        `--repository-owner=${identity.repositoryOwner}`,
        `--report=${setPath}`,
      ],
      root,
      output,
    ).verification,
    'standalone_structure_identity_and_self_digest',
  );
  assert.throws(
    () =>
      runCli(
        [
          '--mode=aggregate',
          ...common,
          `--records=${recordsDirectory}`,
          `--output=${setPath}`,
        ],
        root,
        output,
      ),
    /output must be unused/,
  );
});

test('CLI rejects extra records, symlinks and open argument shapes', (t) => {
  const directory = temporaryDirectory(t);
  const recordsDirectory = path.join(directory, 'records');
  fs.mkdirSync(recordsDirectory);
  const releaseCandidate = candidate('local');
  const candidatePath = path.join(directory, 'candidate.json');
  writeCanonical(candidatePath, releaseCandidate);
  writeCanonical(
    path.join(recordsDirectory, 'local.json'),
    recordsFor(releaseCandidate)[0],
  );
  writeCanonical(path.join(recordsDirectory, 'extra.json'), {});
  const common = [
    `--version=${version}`,
    `--source-revision=${identity.sourceRevision}`,
    `--source-ref=${identity.sourceRef}`,
    '--release-scope=local',
    `--repository-owner=${identity.repositoryOwner}`,
    `--candidate=${candidatePath}`,
  ];
  assert.throws(
    () =>
      runCli(
        [
          '--mode=aggregate',
          ...common,
          `--records=${recordsDirectory}`,
          `--output=${path.join(directory, 'set.json')}`,
        ],
        root,
        { write() {} },
      ),
    /exact selected image set/,
  );
  fs.unlinkSync(path.join(recordsDirectory, 'extra.json'));
  fs.renameSync(candidatePath, path.join(directory, 'candidate-target.json'));
  fs.symlinkSync('candidate-target.json', candidatePath);
  assert.throws(
    () =>
      runCli(
        [
          '--mode=aggregate',
          ...common,
          `--records=${recordsDirectory}`,
          `--output=${path.join(directory, 'set.json')}`,
        ],
        root,
        { write() {} },
      ),
    /canonical regular file/,
  );
  assert.throws(
    () => parseArguments(['--mode=audit', '--extra=true']),
    /arguments are invalid/,
  );
});
