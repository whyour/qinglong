const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const yaml = require('js-yaml');
const { platforms } = require('../../scripts/publish-upgrade-bundles.cjs');

test('candidate verification covers all platforms without writing development or production channels', () => {
  const text = fs.readFileSync(
    '.github/workflows/sqlite-migration-candidate.yml',
    'utf8',
  );
  const workflow = yaml.load(text);
  assert.match(
    workflow.jobs['build-static'].if,
    /head.repo.full_name == github.repository/,
  );
  assert.match(
    workflow.jobs['build-static'].if,
    /codex\/sqlite-runtime-migration/,
  );
  assert.equal(
    workflow.env.SOURCE_COMMIT,
    '${{ github.event.pull_request.head.sha || github.sha }}',
  );
  assert.deepEqual(
    workflow.jobs['build-bundles'].strategy.matrix.include
      .map((t) => `linux-${t.name}`)
      .sort(),
    [...platforms].sort(),
  );
  assert(
    !/publish-static|node scripts\/publish-upgrade-bundles\.cjs|sync-static|pub\.sh/.test(
      text,
    ),
  );
  const images = workflow.jobs['build-images'].steps.find(
    (step) => step.with?.tags,
  );
  assert.match(images.with.tags, /:migration-candidate-/);
  assert(!/latest|:develop|:debian-dev/.test(images.with.tags));
  assert.equal(workflow.permissions.contents, 'read');
  const production = yaml.load(
    fs.readFileSync('.github/workflows/build-docker-image.yml', 'utf8'),
  );
  const exporter = production.jobs['build-upgrade-bundles'].steps.find(
    (step) => step.env?.BUNDLE_PLATFORM,
  );
  assert.match(exporter.run, /Dockerfile\.upgrade-bridge/);
  assert.match(exporter.run, /LEGACY_IMAGE=\$legacy/);
});
