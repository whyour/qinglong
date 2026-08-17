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
const {
  privateReleaseEvidenceReceipts,
} = require('./ql3ReleaseEvidenceFixture.cjs');

const root = path.resolve(__dirname, '../..');
const version = readReleaseIdentity(root).version;
const identity = Object.freeze({
  version,
  sourceRevision: 'b'.repeat(40),
  sourceRef: `refs/tags/v${version}`,
  repositoryOwner: 'qinglong-release',
  validationClockMs: Date.parse('2026-08-18T00:05:00.000Z'),
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

function evidenceFor(releaseCandidate) {
  return privateReleaseEvidenceReceipts(releaseCandidate.release);
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
  const { validationClockMs: _unused, ...localIdentity } = identity;
  const releaseSet = createReleaseSet({
    root,
    candidate: releaseCandidate,
    records,
    evidenceReceipts: evidenceFor(releaseCandidate),
    ...localIdentity,
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
      evidenceReceipts: evidenceFor(releaseCandidate),
      ...localIdentity,
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
    evidenceReceipts: evidenceFor(clusterCandidate),
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
  assert.deepEqual(
    clusterSet.evidenceReceipts.map((entry) => entry.evidenceKind),
    ['worker-management', 'cloudnativepg-disaster-recovery'],
  );

  const allCandidate = candidate('all');
  const allSet = createReleaseSet({
    root,
    candidate: allCandidate,
    records: recordsFor(allCandidate),
    evidenceReceipts: evidenceFor(allCandidate),
    ...identity,
    releaseScope: 'all',
  });
  assert.equal(allSet.images.length, 5);
  assert.deepEqual(allSet.deploymentFamilies.local.images, ['local']);
});

test('requires exact private evidence receipts only for Cluster-capable scopes', () => {
  const releaseCandidate = candidate('cluster');
  const records = recordsFor(releaseCandidate);
  const receipts = evidenceFor(releaseCandidate);
  assert.throws(
    () =>
      createReleaseSet({
        root,
        candidate: releaseCandidate,
        records,
        evidenceReceipts: receipts.slice(1),
        ...identity,
        releaseScope: 'cluster',
      }),
    /receipt count differs/,
  );
  const drifted = JSON.parse(JSON.stringify(receipts));
  drifted[0].release.sourceRevision = 'c'.repeat(40);
  assert.throws(
    () =>
      createReleaseSet({
        root,
        candidate: releaseCandidate,
        records,
        evidenceReceipts: drifted,
        ...identity,
        releaseScope: 'cluster',
      }),
    /receipt shape|release binding/,
  );
  const localCandidate = candidate('local');
  assert.throws(
    () =>
      createReleaseSet({
        root,
        candidate: localCandidate,
        records: recordsFor(localCandidate),
        evidenceReceipts: [receipts[0]],
        ...identity,
        releaseScope: 'local',
      }),
    /receipt count differs/,
  );
});

test('revalidates private evidence freshness at closure without changing release-set bytes', () => {
  const releaseCandidate = candidate('cluster');
  const records = recordsFor(releaseCandidate);
  const evidenceReceipts = evidenceFor(releaseCandidate);
  const createAt = (validationClockMs) =>
    createReleaseSet({
      root,
      candidate: releaseCandidate,
      records,
      evidenceReceipts,
      ...identity,
      validationClockMs,
      releaseScope: 'cluster',
    });
  const first = createAt(Date.parse('2026-08-18T00:05:00.000Z'));
  const second = createAt(Date.parse('2026-08-18T00:15:00.000Z'));
  assert.deepEqual(second, first);
  assert.throws(
    () => createAt(Date.parse('2026-08-19T00:00:01.000Z')),
    /release freshness window/,
  );
  assert.throws(
    () => createAt(Date.parse('2026-08-17T23:54:59.000Z')),
    /release freshness window/,
  );
  assert.throws(
    () =>
      createReleaseSet({
        root,
        candidate: releaseCandidate,
        records,
        evidenceReceipts,
        version: identity.version,
        sourceRevision: identity.sourceRevision,
        sourceRef: identity.sourceRef,
        repositoryOwner: identity.repositoryOwner,
        releaseScope: 'cluster',
      }),
    /closure validation clock/,
  );
  assert.equal(
    auditReleaseSet(first, {
      root,
      candidate: releaseCandidate,
      records,
      evidenceReceipts,
      ...identity,
      releaseScope: 'cluster',
    }).privateEvidenceFreshnessRevalidatedAtClosure,
    true,
  );
  assert.equal(
    inspectReleaseSet(first, {
      ...identity,
      releaseScope: 'cluster',
    }).privateEvidenceReplayed,
    false,
  );
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
        evidenceReceipts: evidenceFor(releaseCandidate),
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
        evidenceReceipts: evidenceFor(releaseCandidate),
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
        evidenceReceipts: evidenceFor(releaseCandidate),
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
    evidenceReceipts: evidenceFor(releaseCandidate),
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
        evidenceReceipts: evidenceFor(releaseCandidate),
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
      evidenceReceipts: evidenceFor(releaseCandidate),
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
    evidenceReceipts: evidenceFor(releaseCandidate),
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
    (value) => {
      value.evidenceReceipts[0].receiptDigest = `sha256:${'0'.repeat(64)}`;
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
      /standalone release set|receipt digest/,
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
  const evidenceDirectory = path.join(directory, 'evidence');
  fs.mkdirSync(recordsDirectory);
  fs.mkdirSync(evidenceDirectory);
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
      `--evidence-receipts=${evidenceDirectory}`,
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
        `--evidence-receipts=${evidenceDirectory}`,
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
          `--evidence-receipts=${evidenceDirectory}`,
          `--output=${setPath}`,
        ],
        root,
        output,
      ),
    /output must be unused/,
  );
});

test('CLI rejects stale private receipts at closure and keeps valid retries byte-identical', (t) => {
  const directory = temporaryDirectory(t);
  const recordsDirectory = path.join(directory, 'records');
  const evidenceDirectory = path.join(directory, 'evidence');
  fs.mkdirSync(recordsDirectory);
  fs.mkdirSync(evidenceDirectory);
  const releaseCandidate = candidate('cluster');
  const candidatePath = path.join(directory, 'candidate.json');
  writeCanonical(candidatePath, releaseCandidate);
  for (const record of recordsFor(releaseCandidate)) {
    writeCanonical(
      path.join(recordsDirectory, `${record.image.name}.json`),
      record,
    );
  }
  for (const receipt of evidenceFor(releaseCandidate)) {
    writeCanonical(
      path.join(evidenceDirectory, `${receipt.evidenceKind}.json`),
      receipt,
    );
  }
  const common = [
    '--mode=aggregate',
    `--version=${version}`,
    `--source-revision=${identity.sourceRevision}`,
    `--source-ref=${identity.sourceRef}`,
    '--release-scope=cluster',
    `--repository-owner=${identity.repositoryOwner}`,
    `--candidate=${candidatePath}`,
    `--records=${recordsDirectory}`,
    `--evidence-receipts=${evidenceDirectory}`,
  ];
  const firstPath = path.join(directory, 'first.json');
  const secondPath = path.join(directory, 'second.json');
  runCli(
    [...common, `--output=${firstPath}`],
    root,
    { write() {} },
    { now: () => Date.parse('2026-08-18T00:05:00.000Z') },
  );
  runCli(
    [...common, `--output=${secondPath}`],
    root,
    { write() {} },
    { now: () => Date.parse('2026-08-18T00:15:00.000Z') },
  );
  assert.equal(
    fs.readFileSync(secondPath, 'utf8'),
    fs.readFileSync(firstPath, 'utf8'),
  );
  const stalePath = path.join(directory, 'stale.json');
  assert.throws(
    () =>
      runCli(
        [...common, `--output=${stalePath}`],
        root,
        { write() {} },
        { now: () => Date.parse('2026-08-19T00:00:01.000Z') },
      ),
    /release freshness window/,
  );
  assert.equal(fs.existsSync(stalePath), false);
});

test('CLI rejects extra records, symlinks and open argument shapes', (t) => {
  const directory = temporaryDirectory(t);
  const recordsDirectory = path.join(directory, 'records');
  const evidenceDirectory = path.join(directory, 'evidence');
  fs.mkdirSync(recordsDirectory);
  fs.mkdirSync(evidenceDirectory);
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
          `--evidence-receipts=${evidenceDirectory}`,
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
          `--evidence-receipts=${evidenceDirectory}`,
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
