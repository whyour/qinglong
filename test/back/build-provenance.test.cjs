const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

test('build verification accepts matching source and rejects stale or dirty artifacts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-build-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init');
  git('config', 'user.name', 'Build test');
  git('config', 'user.email', 'build-test@example.invalid');
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'static/\n');
  git('add', '.');
  git('commit', '-m', 'fixture');
  fs.mkdirSync(path.join(dir, 'static/build'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'static/dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'static/build/app.js'), '');
  fs.writeFileSync(path.join(dir, 'static/dist/index.html'), '');
  const write = path.resolve('scripts/write-build-info.cjs');
  const verify = path.resolve('docker/verify-build.cjs');
  execFileSync(process.execPath, [write], { cwd: dir });
  execFileSync(process.execPath, [verify], { cwd: dir });
  const manifestPath = path.join(dir, 'static/build-info.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  for (const invalid of [
    { ...manifest, sourceCommit: '0'.repeat(40) },
    { ...manifest, dirty: true },
    { ...manifest, lockfileSha256: '0'.repeat(64) },
  ]) {
    fs.writeFileSync(manifestPath, JSON.stringify(invalid));
    assert.notEqual(
      spawnSync(process.execPath, [verify], { cwd: dir }).status,
      0,
    );
  }
});

test('release images receive the same-run artifact and verify it before use', () => {
  const yaml = require('js-yaml');
  const workflow = yaml.load(
    fs.readFileSync('.github/workflows/build-docker-image.yml', 'utf8'),
  );
  assert.equal(workflow.jobs['build-static'].needs, 'validate');
  const upload = workflow.jobs['build-static'].steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with['include-hidden-files'], true);
  for (const name of [
    'build-alpine',
    'build-debian',
    'build-alpine310',
    'build-debian310',
  ]) {
    const job = workflow.jobs[name];
    assert.equal(job.needs, 'build-static');
    const download = job.steps.find((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    );
    assert.equal(download.with.name, 'qinglong-static-${{ github.sha }}');
    assert.equal(download.with.path, 'static/');
    const build = job.steps.find((step) =>
      step.uses?.startsWith('docker/build-push-action@'),
    );
    assert.match(
      build.with['build-args'],
      /SOURCE_COMMIT=\$\{\{ github.sha \}\}/,
    );
    const dockerfile = fs.readFileSync(build.with.file, 'utf8');
    assert.doesNotMatch(dockerfile, /git clone.*qinglong-static/);
    assert.match(
      dockerfile,
      /git fetch --depth=1 origin "\$\{SOURCE_COMMIT\}"/,
    );
    assert.match(dockerfile, /node \/tmp\/verify-build.cjs/);
  }
});

test('complete artifact manifests reject changed, missing, extra files and untracked build inputs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-build-manifest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init');
  git('config', 'user.name', 'Build test');
  git('config', 'user.email', 'build-test@example.invalid');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'static/\n');
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n');
  git('add', '.');
  git('commit', '-m', 'fixture');
  const artifacts = [
    'build/app.js',
    'build/services/http.js',
    'dist/index.html',
    'dist/chunks/main.js',
    'dist/assets/main.css',
    'dist/.well-known/config',
  ];
  for (const file of artifacts) {
    fs.mkdirSync(path.dirname(path.join(dir, 'static', file)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(dir, 'static', file), file);
  }
  const write = path.resolve('scripts/write-build-info.cjs');
  const verify = path.resolve('docker/verify-build.cjs');
  const run = (script) =>
    spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
  assert.equal(run(write).status, 0);
  const manifestFile = path.join(dir, 'static/build-info.json');
  const original = fs.readFileSync(manifestFile, 'utf8');
  assert.deepEqual(
    Object.keys(JSON.parse(original).files).sort(),
    artifacts.sort(),
  );
  assert.equal(run(write).status, 0);
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), original);
  assert.equal(run(verify).status, 0);
  for (const name of [
    'build/services/http.js',
    'dist/chunks/main.js',
    'dist/assets/main.css',
    'dist/.well-known/config',
  ]) {
    const file = path.join(dir, 'static', name);
    fs.writeFileSync(file, 'stale');
    assert.notEqual(run(verify).status, 0);
    fs.unlinkSync(file);
    assert.notEqual(run(verify).status, 0);
    fs.writeFileSync(file, name);
    assert.equal(run(verify).status, 0);
  }
  const extra = path.join(dir, 'static/build/stale.js');
  fs.writeFileSync(extra, 'extra');
  assert.notEqual(run(verify).status, 0);
  fs.unlinkSync(extra);
  const source = path.join(dir, 'custom.config.js');
  fs.writeFileSync(source, 'untracked build input');
  assert.equal(run(write).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(manifestFile)).dirty, true);
  assert.notEqual(run(verify).status, 0);
  fs.unlinkSync(source);
  assert.equal(run(write).status, 0);
  assert.equal(run(verify).status, 0);
  fs.symlinkSync(path.join(dir, 'pnpm-lock.yaml'), extra);
  assert.notEqual(run(write).status, 0);
  assert.notEqual(run(verify).status, 0);
});
