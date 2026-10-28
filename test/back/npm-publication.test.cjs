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
const publication = workflow.jobs.publish.steps.find(
  (step) => step.name === 'Publish npm package with OIDC',
).run;

test('npm publication waits for every supported release image', () => {
  for (const name of [
    'build-alpine',
    'build-debian',
  ])
    assert.ok(workflow.jobs.publish.needs.includes(name), name);
});

for (const [scenario, expectedStatus, published] of [
  ['existing', 0, false],
  ['missing', 0, true],
  ['unauthorized', 1, false],
  ['network', 1, false],
  ['unexpected-version', 1, false],
]) {
  test(`npm publication handles ${scenario} without publishing an unverified version`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-npm-publication-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: '@fixture/unrelated-source', version: '0.0.0' }),
    );
    fs.mkdirSync(path.join(root, 'package'));
    fs.mkdirSync(path.join(root, 'npm-panel'));
    fs.writeFileSync(
      path.join(root, 'package/package.json'),
      JSON.stringify({ name: '@whyour/qinglong', version: '2.22.0' }),
    );
    const packed = spawnSync('tar', ['-czf', 'npm-panel/verified.tgz', 'package'], { cwd: root });
    assert.equal(packed.status, 0, String(packed.stderr));
    fs.writeFileSync(
      path.join(bin, 'npm'),
      `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'publish') { fs.writeFileSync('published', JSON.stringify(process.argv.slice(3))); process.exit(0); }
if (process.argv[2] !== 'view') process.exit(99);
if (process.argv[3] !== '@whyour/qinglong@2.22.0') process.exit(98);
switch (process.env.QL_PUBLISH_SCENARIO) {
case 'existing': console.log(JSON.stringify('2.22.0')); break;
case 'unexpected-version': console.log(JSON.stringify('2.21.0')); break;
case 'missing': console.log(JSON.stringify({error:{code:'E404'}})); process.exit(1);
case 'unauthorized': console.log(JSON.stringify({error:{code:'E401'}})); process.exit(1);
case 'network': console.log('upstream unavailable'); process.exit(1);
}
`,
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
      },
    });
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    assert.equal(fs.existsSync(path.join(root, 'published')), published);
    if (published)
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'published'), 'utf8')), [
        './npm-panel/verified.tgz', '--ignore-scripts', '--access', 'public', '--registry=https://registry.npmjs.org',
      ]);
  });
}
