'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  argumentsValue,
  resolveReleaseSelection,
} = require('../../scripts/ql3-local-compose-rollout-live-contract.cjs');
const {
  writeSyntheticLocalReleaseSelection,
} = require('../../scripts/lib/ql3-local-release-selection-test-fixture.cjs');

const IMAGE = `ghcr.io/example/qinglong3-local-application@sha256:${'a'.repeat(
  64,
)}`;

function privateDirectory(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-local-catalog-selection-')),
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function catalogSelection(t) {
  const directory = privateDirectory(t);
  return {
    directory,
    releaseSelection: writeSyntheticLocalReleaseSelection({
      directory,
      image: IMAGE,
      allowRootService: process.getuid() === 0,
      sourceRevision: 'b'.repeat(40),
    }),
  };
}

test('preserves the existing synthetic rollout arguments', (t) => {
  const directory = privateDirectory(t);
  const socket = path.join(directory, 'docker.sock');
  fs.writeFileSync(socket, 'fixture', { mode: 0o600 });
  assert.deepEqual(
    argumentsValue([
      `--image=${IMAGE}`,
      `--docker-executable=${fs.realpathSync(process.execPath)}`,
      `--docker-socket=${fs.realpathSync(socket)}`,
      '--profile=edge',
    ]),
    {
      image: IMAGE,
      profile: 'edge',
      dockerExecutable: fs.realpathSync(process.execPath),
      dockerSocket: fs.realpathSync(socket),
    },
  );
});

test('accepts only a complete catalog selection handoff', (t) => {
  const { directory, releaseSelection } = catalogSelection(t);
  const socket = path.join(directory, 'docker.sock');
  fs.writeFileSync(socket, 'fixture', { mode: 0o600 });
  const common = [
    `--image=${IMAGE}`,
    `--docker-executable=${fs.realpathSync(process.execPath)}`,
    `--docker-socket=${fs.realpathSync(socket)}`,
    '--profile=standalone',
  ];
  assert.deepEqual(
    argumentsValue([
      ...common,
      `--release-selection=${releaseSelection.path}`,
      `--expected-selection-digest=${releaseSelection.expectedSelectionDigest}`,
    ]).releaseSelection,
    releaseSelection,
  );
  assert.throws(
    () =>
      argumentsValue([
        ...common,
        `--release-selection=${releaseSelection.path}`,
      ]),
    /usage/,
  );
  assert.throws(
    () =>
      argumentsValue([
        ...common,
        `--expected-selection-digest=${releaseSelection.expectedSelectionDigest}`,
      ]),
    /usage/,
  );
});

test('projects a content-free verified catalog authority from the exact selection', (t) => {
  const { directory, releaseSelection } = catalogSelection(t);
  const result = resolveReleaseSelection(
    { image: IMAGE, releaseSelection },
    directory,
    process.getuid(),
  );
  assert.equal(result.releaseSelection, releaseSelection);
  assert.deepEqual(result.authority, {
    mode: 'verified_release_catalog',
    sourceRevision: 'b'.repeat(40),
    sourceRef: 'refs/tags/v3.0.0-alpha.0',
    scope: 'local',
    releaseSetDigest: JSON.parse(fs.readFileSync(releaseSelection.path, 'utf8'))
      .releaseSetDigest,
    catalogManifestDigest: JSON.parse(
      fs.readFileSync(releaseSelection.path, 'utf8'),
    ).catalog.manifestDigest,
    catalogConsumptionDigest: JSON.parse(
      fs.readFileSync(releaseSelection.path, 'utf8'),
    ).catalog.consumptionReportDigest,
    selectionDigest: releaseSelection.expectedSelectionDigest,
  });
});

test('rejects selection drift, image substitution and wider permissions', (t) => {
  const first = catalogSelection(t);
  assert.throws(
    () =>
      resolveReleaseSelection(
        {
          image: IMAGE.replace('qinglong3-local-application', 'other'),
          releaseSelection: first.releaseSelection,
        },
        first.directory,
        process.getuid(),
      ),
    /incompatible/,
  );

  const second = catalogSelection(t);
  fs.chmodSync(second.releaseSelection.path, 0o640);
  assert.throws(
    () =>
      resolveReleaseSelection(
        { image: IMAGE, releaseSelection: second.releaseSelection },
        second.directory,
        process.getuid(),
      ),
    /incompatible/,
  );

  const third = catalogSelection(t);
  const selection = JSON.parse(
    fs.readFileSync(third.releaseSelection.path, 'utf8'),
  );
  selection.release.sourceRevision = 'c'.repeat(40);
  fs.writeFileSync(
    third.releaseSelection.path,
    `${JSON.stringify(selection)}\n`,
    { mode: 0o600 },
  );
  assert.throws(
    () =>
      resolveReleaseSelection(
        { image: IMAGE, releaseSelection: third.releaseSelection },
        third.directory,
        process.getuid(),
      ),
    /incompatible/,
  );
});

test('marks an ordinary PR rollout as a synthetic fixture', (t) => {
  const directory = privateDirectory(t);
  const result = resolveReleaseSelection(
    { image: IMAGE },
    directory,
    process.getuid(),
  );
  assert.deepEqual(result.authority, { mode: 'synthetic_live_fixture' });
  assert.equal(fs.existsSync(result.releaseSelection.path), true);
});
