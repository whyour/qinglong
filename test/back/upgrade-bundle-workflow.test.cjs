const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const yaml = require('js-yaml');

const workflow = yaml.load(
  fs.readFileSync('.github/workflows/build-docker-image.yml', 'utf8'),
);

test('shared server runtime changes trigger the image and upgrade verification workflow', () => {
  const paths = workflow.on.push.paths;
  assert.ok(
    paths.indexOf('cli/src/internal/maintenance/nodeRuntime.cjs') >
      paths.indexOf('!cli/**'),
  );
});
// These conditions use GitHub's boolean operators and format(), which have the
// same semantics for the boolean/string contexts exercised here.
const evaluate = (expression, github, inputs = {}) => {
  const run = (code) =>
    vm.runInNewContext(code, {
      github: { run_id: '100', run_attempt: '1', ...github },
      inputs,
      format: (template, ...values) =>
        template.replace(/\{(\d+)\}/g, (_, i) => values[i]),
    });
  const exact = expression.match(/^\$\{\{([\s\S]*?)\}\}$/);
  return exact
    ? run(exact[1])
    : expression.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, code) =>
        String(run(code)),
      );
};

test('both channels automatically build bundles, with static-only and Git-tag runs excluded', () => {
  const cases = [
    ['push', 'refs/heads/develop', {}, true],
    ['workflow_dispatch', 'refs/heads/develop', {}, true],
    [
      'workflow_dispatch',
      'refs/heads/develop',
      { static_sync_only: true },
      false,
    ],
    ['push', 'refs/heads/master', {}, true],
    ['workflow_dispatch', 'refs/heads/master', {}, true],
    [
      'workflow_dispatch',
      'refs/heads/master',
      { static_sync_only: true },
      false,
    ],
    ['push', 'refs/tags/v2.24.0', {}, false],
    ['workflow_dispatch', 'refs/tags/v2.24.0', {}, false],
  ];
  for (const name of ['build-upgrade-bundles', 'publish-upgrade-bundles'])
    for (const [event_name, ref, inputs, expected] of cases)
      assert.equal(
        Boolean(evaluate(workflow.jobs[name].if, { event_name, ref }, inputs)),
        expected,
        `${name}: ${event_name} ${ref} ${JSON.stringify(inputs)}`,
      );
  assert.deepEqual(workflow.jobs['build-upgrade-bundles'].needs, [
    'build-alpine',
    'build-debian',
  ]);
  assert.ok(
    workflow.jobs['build-upgrade-bundles'].steps.some(
      (step) =>
        step.env?.ALPINE_DIGEST ===
          '${{ needs.build-alpine.outputs.image-digest }}' &&
        step.env?.DEBIAN_DIGEST ===
          '${{ needs.build-debian.outputs.image-digest }}',
    ),
  );
});

test('development image and bundle publication serialize separately from production and static-only runs', () => {
  const group = (event_name, ref, inputs = {}, run_id = '100') =>
    evaluate(workflow.concurrency.group, { event_name, ref, run_id }, inputs);
  const master = group('push', 'refs/heads/master');
  const development = group('push', 'refs/heads/develop');
  assert.equal(
    development,
    group('workflow_dispatch', 'refs/heads/develop', {}, '101'),
  );
  assert.equal(master, group('push', 'refs/heads/master', {}, '101'));
  assert.notEqual(master, development);
  assert.notEqual(
    development,
    group('workflow_dispatch', 'refs/heads/develop', {
      static_sync_only: true,
    }),
  );
  assert.notEqual(
    group('push', 'refs/tags/v2.24.0'),
    group('push', 'refs/tags/v2.24.0', {}, '101'),
  );
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
});

test('bundle targets exactly match the source image platforms and publisher requirements', () => {
  const targets =
    workflow.jobs['build-upgrade-bundles'].strategy.matrix.include;
  for (const [job, libc] of [
    ['build-alpine', 'musl'],
    ['build-debian', 'glibc'],
  ]) {
    const platforms = workflow.jobs[job].steps
      .find((step) => step.with?.platforms)
      .with.platforms.split(',');
    assert.deepEqual(
      targets
        .filter((t) => t.libc === libc)
        .map((t) => t.platform)
        .sort(),
      platforms.sort(),
    );
  }
  const { platforms } = require('../../scripts/publish-upgrade-bundles.cjs');
  assert.deepEqual(
    targets.map((t) => `linux-${t.name}`).sort(),
    [...platforms].sort(),
  );
  assert.ok(platforms.includes('linux-armv6-musl'));
  assert.ok(!platforms.includes('linux-armv6-glibc'));
});
