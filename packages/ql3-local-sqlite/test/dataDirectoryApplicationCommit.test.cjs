const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  LocalDataDirectoryApplicationCommitError,
  createLocalDataDirectoryApplicationCommit,
  normalizeLocalDataDirectoryApplicationCommit,
} = require('../dist/adoption/data-directory/dataDirectoryAdoptionDatabase.js');

function adoptionRecord() {
  return {
    mutationId: '00000000-0000-4000-8000-000000000001',
    projectId: 'project-edge-1',
    profile: 'edge',
    sourceStageManifestDigest: '1'.repeat(64),
    transformationDigest: '2'.repeat(64),
    modelDigest: '3'.repeat(64),
    publicationDigest: '4'.repeat(64),
    receiptDigest: '5'.repeat(64),
    committedAtMs: 1_000,
    receipt: {
      secretCount: 3,
      environmentSecretCount: 2,
      sshSecretCount: 1,
    },
  };
}

test('canonical data application commit is exact and replayable', () => {
  const commit = createLocalDataDirectoryApplicationCommit(adoptionRecord());
  assert.equal(commit.kind, 'qinglong3-legacy-data-directory-application');
  assert.equal(commit.state, 'committed');
  assert.equal(commit.profile, 'edge');
  assert.equal(commit.receiptDigest, '5'.repeat(64));
  assert.equal(commit.commitDigest.length, 64);
  assert.deepEqual(
    normalizeLocalDataDirectoryApplicationCommit(
      JSON.parse(JSON.stringify(commit)),
    ),
    commit,
  );
});

test('data application commit rejects shape, count, and digest drift', () => {
  const commit = createLocalDataDirectoryApplicationCommit(adoptionRecord());
  for (const drift of [
    { ...commit, unexpected: true },
    { ...commit, secretCount: 4 },
    { ...commit, receiptDigest: '0'.repeat(64) },
    {
      ...commit,
      reclamation: { ...commit.reclamation, physicalErasureGuaranteed: true },
    },
  ]) {
    assert.throws(
      () => normalizeLocalDataDirectoryApplicationCommit(drift),
      LocalDataDirectoryApplicationCommitError,
    );
  }
});
