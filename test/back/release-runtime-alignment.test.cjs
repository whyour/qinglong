const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const productionNode = read('.nvmrc').trim();
const workflow = (name) => yaml.load(read(`.github/workflows/${name}.yml`));
const verifier = path.join(root, 'scripts/verify-runtime-dependencies.cjs');

test('CI uses the pinned production Node, retaining explicit compatibility coverage', () => {
  assert.match(productionNode, /^24\.\d+\.\d+$/);
  for (const file of ['docker/Dockerfile', 'docker/Dockerfile.310']) {
    const versions = [...read(file).matchAll(/\bnode:(\d+\.\d+\.\d+)-alpine/g)];
    assert.ok(versions.length >= 2, file);
    for (const [, version] of versions) assert.equal(version, productionNode, file);
    const packageVersion = read(file).match(/\bnodejs=(\d+\.\d+\.\d+)-r\d+/);
    assert.ok(packageVersion, `${file}: pin the Alpine Node package`);
    assert.equal(packageVersion[1], productionNode, file);
    assert.ok(read(file).includes(`test "$(node --version)" = "v${productionNode}"`), file);
  }
  assert.equal(read('docker/install-node-debian.sh').match(/^version=(.*)$/m)[1], productionNode);
  for (const file of ['docker/Dockerfile.debian', 'docker/Dockerfile.debian310']) {
    const versions = [...read(file).matchAll(/"v(\d+\.\d+\.\d+)"/g)];
    assert.ok(versions.length >= 2, file);
    for (const [, version] of versions) assert.equal(version, productionNode, file);
  }
  for (const name of ['validate', 'release-readiness', 'build-docker-image', 'cli-package']) {
    for (const [jobName, job] of Object.entries(workflow(name).jobs)) {
      const steps = job.steps || [];
      for (const [index, step] of steps.entries()) {
        if (!step.uses?.startsWith('actions/setup-node@')) continue;
        assert.equal(step.with['node-version-file'], '.nvmrc', `${name}/${jobName}`);
        assert.ok(steps.slice(0, index).some((s) => s.uses?.startsWith('actions/checkout@')), `${name}/${jobName}: checkout before version file`);
        const version = step.with['node-version'];
        if (!version) continue;
        assert.equal(name, 'cli-package');
        assert.equal(jobName, 'package');
        for (const node of job.strategy.matrix.node) {
          const resolved = vm.runInNewContext(version.slice(3, -2), { matrix: { node } });
          assert.equal(resolved || productionNode, node === '22.12.0' ? node : productionNode);
        }
      }
    }
  }
  const build = workflow('build-docker-image');
  const runtime = build.jobs['build-static'].steps.find((s) => s.id === 'runtime');
  assert.match(runtime.run, /cat \.nvmrc/);
  assert.equal(build.jobs['build-static'].outputs['node-version'], '${{ steps.runtime.outputs.node-version }}');
  const verify = build.jobs['verify-npm-package'];
  const expression = verify.container.match(/\$\{\{(.*?)\}\}/)[1]
    .replace('needs.build-static.outputs.node-version', JSON.stringify(productionNode));
  for (const node of verify.strategy.matrix.node) {
    const version = vm.runInNewContext(expression, { matrix: { node } });
    assert.equal(version, node === '20.18.1' ? node : productionNode);
  }
});

test('release readiness runs the source verifier offline and watches its inputs', () => {
  const readiness = workflow('release-readiness');
  for (const file of ['.nvmrc', '.github/workflows/validate.yml', 'docker/install-node-debian.sh', 'scripts/verify-runtime-dependencies.cjs', 'test/back/release-runtime-alignment.test.cjs']) {
    assert.ok(readiness.on.pull_request.paths.includes(file), file);
  }
  const step = readiness.jobs.images.steps.find((s) => s.name === 'Verify native production runtime without external networking');
  assert.match(step.run, /docker run --rm -i --network none --entrypoint node/);
  assert.match(step.run, /< scripts\/verify-runtime-dependencies\.cjs/);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-release-deps-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = { dependencies: {} };
  const lock = { dependencies: {}, packages: {} };
  const write = (file, data) => {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data));
  };
  const install = (name, version, parent) => {
    const prefix = `node_modules/${parent ? `${parent}/node_modules/` : ''}${name}`;
    write(`${prefix}/package.json`, { name, version, main: 'index.js' });
    write(`${prefix}/index.js`, 'module.exports = {};');
  };
  for (const name of ['@grpc/grpc-js', 'compression', 'multer', 'sequelize', 'express', 'sockjs']) {
    manifest.dependencies[name] = '1.0.0';
    lock.dependencies[name] = { specifier: '1.0.0', version: '1.0.0' };
    install(name, '1.0.0');
  }
  for (const [parent, name] of [['express', 'proxy-addr'], ['sockjs', 'websocket-driver']]) {
    lock.packages[`/${parent}@1.0.0`] = { dependencies: { [name]: '1.0.0' } };
    install(name, '1.0.0', parent);
    // A healthy root copy must not mask a stale copy resolved by the parent.
    install(name, '1.0.0');
  }
  for (const name of ['sqlite3', 'nodemailer', 'undici']) install(name, '1.0.0');
  write('.nvmrc', process.versions.node);
  lock.dependencies.sequelize.version = '1.0.0(@whyour/sqlite3@1.1.5)';
  const run = (stdin = false) => {
    write('package.json', manifest);
    write('pnpm-lock.yaml', yaml.dump(lock));
    return spawnSync(process.execPath, stdin ? [] : [verifier], {
      cwd: directory, encoding: 'utf8', timeout: 10000,
      ...(stdin ? { input: fs.readFileSync(verifier, 'utf8'), env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') } } : {}),
    });
  };
  return { manifest, lock, install, run, write };
}

test('runtime verification follows dependency upgrades without a second version list, including stdin execution', (t) => {
  const f = fixture(t);
  f.manifest.dependencies.multer = '2.9.0';
  f.lock.dependencies.multer = { specifier: '2.9.0', version: '2.9.0' };
  f.install('multer', '2.9.0');
  f.lock.packages['/express@1.0.0'].dependencies['proxy-addr'] = '3.0.0';
  f.install('proxy-addr', '3.0.0', 'express');
  for (const stdin of [false, true]) {
    const result = f.run(stdin);
    assert.equal(result.status, 0, result.stderr);
  }
});

for (const scenario of ['node-version', 'manifest', 'direct', 'transitive', 'missing-lock', 'missing-import']) {
  test(`runtime verification rejects ${scenario} drift`, (t) => {
    const f = fixture(t);
    let expected;
    if (scenario === 'node-version') {
      f.write('.nvmrc', '0.0.0');
      expected = /Node runtime differs from the production version/;
    } else if (scenario === 'manifest') {
      f.manifest.dependencies.multer = '2.0.0';
      expected = /multer: manifest\/lock mismatch/;
    } else if (scenario === 'direct') {
      f.install('multer', '0.9.0');
      expected = /multer: installed\/lock mismatch/;
    } else if (scenario === 'transitive') {
      f.install('proxy-addr', '0.9.0', 'express');
      expected = /express > proxy-addr: installed\/lock mismatch/;
    } else if (scenario === 'missing-lock') {
      delete f.lock.packages['/sockjs@1.0.0'];
      expected = /sockjs > websocket-driver: missing lock entry/;
    } else {
      f.write('node_modules/sqlite3/index.js', 'throw new Error("native binding unavailable")');
      expected = /native binding unavailable/;
    }
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  });
}
