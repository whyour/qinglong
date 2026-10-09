const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const workflow = yaml.load(
  fs.readFileSync('.github/workflows/build-docker-image.yml', 'utf8'),
);
const publicationStep = workflow.jobs.publish.steps.find(
  (step) => step.name === 'Publish the verified npm archive with OIDC',
);
assert.ok(publicationStep, 'Verified archive publication step must exist');
const publication = publicationStep.run;

test('npm publication waits for the archive gate and every release image, including Python 3.10', () => {
  assert.deepEqual(workflow.jobs.publish.needs, [
    'build-alpine',
    'build-debian',
    'build-alpine310',
    'build-debian310',
    'npm-package',
  ]);
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
});

for (const [scenario, expectedStatus, published] of [
  ['existing', 0, false],
  ['missing', 0, true],
  ['unauthorized', 1, false],
  ['network', 1, false],
  ['unexpected-version', 1, false],
  ['wrong-npm-version', 1, false],
]) {
  test(`npm publication handles ${scenario} without publishing an unverified version`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-npm-publication-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const npmCLI = path.join(
      root,
      'npm-publisher-tools/lib/node_modules/npm/bin/npm-cli.js',
    );
    fs.mkdirSync(path.dirname(npmCLI), { recursive: true });
    const tarball = path.join(root, 'verified qinglong-2.23.0.tgz');
    fs.writeFileSync(tarball, 'Fixture only: never install or publish this file.\n');
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: '@fixture/qinglong', version: '2.23.0' }),
    );
    fs.writeFileSync(
      npmCLI,
      `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('npm-calls.jsonl', JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
  console.log(process.env.QL_PUBLISH_SCENARIO === 'wrong-npm-version' ? '12.1.0' : '12.2.0');
  process.exit(0);
}
if (args[0] === 'publish') { fs.writeFileSync('published', JSON.stringify(args)); process.exit(0); }
if (args[0] !== 'view') process.exit(99);
switch (process.env.QL_PUBLISH_SCENARIO) {
case 'existing': console.log(JSON.stringify('2.23.0')); break;
case 'unexpected-version': console.log(JSON.stringify('2.22.0')); break;
case 'missing': console.log(JSON.stringify({error:{code:'E404'}})); process.exit(1);
case 'unauthorized': console.log(JSON.stringify({error:{code:'E401'}})); process.exit(1);
case 'network': console.log('upstream unavailable'); process.exit(1);
}
`,
    );
    fs.writeFileSync(
      path.join(bin, 'npm'),
      '#!/bin/sh\nprintf wrong-client > wrong-path-npm\nexit 97\n',
      { mode: 0o755 },
    );
    const result = spawnSync('bash', ['-c', publication], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        RUNNER_TEMP: root,
        QL_PUBLISH_SCENARIO: scenario,
        QINGLONG_PUBLISH_TARBALL: tarball,
      },
    });
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    assert.equal(fs.existsSync(path.join(root, 'published')), published);
    assert.equal(fs.existsSync(path.join(root, 'wrong-path-npm')), false);
    const calls = fs
      .readFileSync(path.join(root, 'npm-calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const expectedCalls = [['--version']];
    if (scenario !== 'wrong-npm-version')
      expectedCalls.push([
        'view',
        '@fixture/qinglong@2.23.0',
        'version',
        '--json',
        '--registry=https://registry.npmjs.org',
      ]);
    if (published) {
      const publishArgs = [
        'publish',
        tarball,
        '--ignore-scripts',
        '--access',
        'public',
        '--registry=https://registry.npmjs.org',
      ];
      expectedCalls.push(publishArgs);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(root, 'published'))),
        publishArgs,
      );
    }
    assert.deepEqual(calls, expectedCalls);
  });
}
