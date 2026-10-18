const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const yaml = require('js-yaml');

const workflow = yaml.load(
  fs.readFileSync('.github/workflows/build-docker-image.yml', 'utf8'),
);
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

test('both bundle jobs require master or an explicit development dispatch', () => {
  assert.equal(
    workflow.on.workflow_dispatch.inputs.build_development_bundles.default,
    false,
  );
  const cases = [
    ['push', 'refs/heads/develop', {}, false],
    ['push', 'refs/heads/develop', { build_development_bundles: true }, false],
    ['workflow_dispatch', 'refs/heads/develop', {}, false],
    [
      'workflow_dispatch',
      'refs/heads/develop',
      { build_development_bundles: true },
      true,
    ],
    [
      'workflow_dispatch',
      'refs/heads/develop',
      { build_development_bundles: true, static_sync_only: true },
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
    [
      'workflow_dispatch',
      'refs/tags/v2.24.0',
      { build_development_bundles: true },
      false,
    ],
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

test('manual development releases serialize separately while normal develop CI remains independent', () => {
  const group = (event_name, ref, inputs = {}, run_id = '100') =>
    evaluate(workflow.concurrency.group, { event_name, ref, run_id }, inputs);
  const master = group('push', 'refs/heads/master');
  const development = group('workflow_dispatch', 'refs/heads/develop', {
    build_development_bundles: true,
  });
  assert.equal(
    development,
    group(
      'workflow_dispatch',
      'refs/heads/develop',
      { build_development_bundles: true },
      '101',
    ),
  );
  assert.equal(master, group('push', 'refs/heads/master', {}, '101'));
  assert.notEqual(master, development);
  const push = group('push', 'refs/heads/develop');
  assert.notEqual(push, development);
  assert.notEqual(push, group('push', 'refs/heads/develop', {}, '101'));
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
});
