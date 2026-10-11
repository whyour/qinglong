const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { writeManifest } = require('../helpers/upgrade-fixture.cjs');

test('static mirror receives complete orphan snapshots of each requested branch and reports rejection', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-static-mirror-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, 'source'),
    target = path.join(tmp, 'target.git');
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', source);
  git('init', '--bare', target);
  git('-C', source, 'config', 'user.name', 'Fixture');
  git('-C', source, 'config', 'user.email', 'fixture@example.invalid');
  const script = path.resolve('scripts/sync-static.sh');
  const env = { ...process.env, QL_STATIC_SOURCE: source };
  for (const branch of ['master', 'develop']) {
    git('-C', source, 'checkout', '--orphan', branch);
    fs.writeFileSync(path.join(source, 'build-info.json'), branch);
    git('-C', source, 'add', '.');
    git('-C', source, 'commit', '-m', branch);
    execFileSync('bash', [script, target, branch], { env, stdio: 'pipe' });
    assert.equal(
      git('-C', target, 'rev-parse', branch),
      git('-C', source, 'rev-parse', branch),
    );
    assert.equal(
      git('-C', target, 'rev-parse', '--is-shallow-repository'),
      'false',
    );
  }
  fs.writeFileSync(
    path.join(target, 'hooks/pre-receive'),
    '#!/bin/sh\nexit 1\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(source, 'build-info.json'), 'next');
  git('-C', source, 'add', '.');
  git('-C', source, 'commit', '-m', 'next');
  assert.notEqual(
    spawnSync('bash', [script, target, 'develop'], { env }).status,
    0,
  );
});

test('mirror jobs select the built branch, retain hidden artifacts and propagate failures', () => {
  const yaml = require('js-yaml');
  const workflow = yaml.load(
    fs.readFileSync('.github/workflows/build-docker-image.yml', 'utf8'),
  );
  for (const name of ['static_gitlab']) {
    const job = workflow.jobs[name],
      step = job.steps.find((step) => step.run);
    assert.equal(job.needs, 'build-static');
    assert.equal(step.env.STATIC_BRANCH, '${{ github.ref_name }}');
    assert.equal(step.env.STATIC_REF_TYPE, '${{ github.ref_type }}');
    assert.match(step.run, /set -euo pipefail/);
    assert.match(step.run, /bash scripts\/sync-static.sh.*"\$STATIC_BRANCH"/);
    assert.doesNotMatch(step.run, /warning|set \+e|--depth/);
  }
  const publish = workflow.jobs['build-static'].steps.find(
    (step) => step.name === 'copy to static repo',
  );
  assert.equal(publish.env.GITHUB_REF_TYPE, '${{ github.ref_type }}');
  assert.match(publish.run, /bash scripts\/publish-static.sh/);
  assert.match(
    fs.readFileSync('scripts/publish-static.sh', 'utf8'),
    /cp -a static\/\./,
  );
});

test('version static snapshots retain a matching branch and Git tag on all three remotes', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-version-static-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, 'source');
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', source);
  git('-C', source, 'config', 'user.name', 'Fixture');
  git('-C', source, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(source, 'version.yaml'), 'version: 2.22.0\n');
  fs.writeFileSync(path.join(source, '.gitignore'), 'static/\n');
  fs.writeFileSync(path.join(source, 'pnpm-lock.yaml'), 'fixture lock\n');
  git('-C', source, 'add', '.');
  git('-C', source, 'commit', '-m', 'source');
  const staticRoot = path.join(source, 'static');
  for (const filename of [
    'build/app.js',
    'dist/index.html',
    'dist/.well-known/config',
  ]) {
    fs.mkdirSync(path.dirname(path.join(staticRoot, filename)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(staticRoot, filename), filename);
  }
  writeManifest(source, staticRoot);
  const manifestFile = path.join(staticRoot, 'build-info.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.sourceCommit = git('-C', source, 'rev-parse', 'HEAD');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const remotes = ['github', 'gitlab', 'gitee'].map((name) =>
    path.join(tmp, `${name}.git`),
  );
  for (const remote of remotes) git('init', '--bare', remote);
  const publish = path.resolve('scripts/publish-static.sh'),
    sync = path.resolve('scripts/sync-static.sh');
  const options = { cwd: source, stdio: 'pipe', env: process.env };
  execFileSync('bash', [publish, remotes[0], 'master', 'branch'], options);
  execFileSync('bash', [publish, remotes[0], 'v2.22.0', 'tag'], options);
  for (const remote of remotes.slice(1))
    execFileSync('bash', [sync, remote, 'v2.22.0', 'tag'], {
      ...options,
      env: { ...process.env, QL_STATIC_SOURCE: remotes[0] },
    });
  const snapshot = git('-C', remotes[0], 'rev-parse', 'refs/heads/v2.22.0');
  for (const remote of remotes) {
    assert.equal(
      git('-C', remote, 'rev-parse', 'refs/heads/v2.22.0'),
      snapshot,
    );
    assert.equal(git('-C', remote, 'rev-parse', 'refs/tags/v2.22.0'), snapshot);
    assert.equal(
      git('-C', remote, 'show', 'v2.22.0:dist/.well-known/config'),
      'dist/.well-known/config',
    );
  }
  assert.notEqual(
    spawnSync('bash', [publish, remotes[0], 'v2.23.0', 'tag'], options).status,
    0,
  );
  assert.equal(
    spawnSync('git', [
      '-C',
      remotes[0],
      'rev-parse',
      '--verify',
      'refs/tags/v2.23.0',
    ]).status,
    128,
  );
});

test('static backfill uses existing snapshots and skips all source, build and image publication jobs', () => {
  const workflow = require('js-yaml').load(
    fs.readFileSync('.github/workflows/build-docker-image.yml', 'utf8'),
  );
  assert.equal(
    workflow.on.workflow_dispatch.inputs.static_sync_only.default,
    false,
  );
  const job = workflow.jobs['sync-existing-static'];
  assert.match(job.if, /workflow_dispatch.*inputs.static_sync_only/);
  assert.deepEqual(job.strategy.matrix.mirror, ['gitlab']);
  const sync = job.steps.find((step) => step.run);
  assert.equal(sync.env.STATIC_REF, '${{ inputs.static_ref }}');
  assert.equal(sync.env.STATIC_REF_TYPE, '${{ inputs.static_ref_type }}');
  assert.match(sync.run, /bash scripts\/sync-static.sh/);
  assert.doesNotMatch(sync.run, /publish-static|docker|pub.sh/);
  for (const name of ['validate', 'code_gitlab', 'build-static'])
    assert.match(workflow.jobs[name].if, /!inputs.static_sync_only/);
  // Downstream jobs require the skipped build; none bypass dependency failures.
  for (const name of [
    'static_gitlab',
    'verify-gitee-mirrors',
    'build-alpine',
    'build-debian',
    'build-alpine310',
    'build-debian310',
  ]) {
    assert.equal(workflow.jobs[name].needs, 'build-static');
    assert.doesNotMatch(workflow.jobs[name].if || '', /always\(/);
  }
});
