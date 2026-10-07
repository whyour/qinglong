const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const script = path.resolve('scripts/wait-for-mirror.sh');
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
const options = (env = {}) => ({
  encoding: 'utf8',
  env: {
    ...process.env,
    QL_MIRROR_WAIT_SECONDS: '3',
    QL_MIRROR_POLL_INTERVAL: '1',
    QL_MIRROR_QUERY_TIMEOUT: '1',
    ...env,
  },
});

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-mirror-status-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, 'source');
  const mirror = path.join(tmp, 'mirror.git');
  git('init', source);
  git('init', '--bare', mirror);
  git('-C', source, 'config', 'user.name', 'Fixture');
  git('-C', source, 'config', 'user.email', 'fixture@example.invalid');
  git('-C', source, 'checkout', '-b', 'develop');
  fs.writeFileSync(path.join(source, 'snapshot'), 'first');
  git('-C', source, 'add', '.');
  git('-C', source, 'commit', '-m', 'first');
  return { tmp, source, mirror };
}

test('mirror verification reads matching refs without changing either repository', (t) => {
  const { source, mirror } = fixture(t);
  git('-C', source, 'push', mirror, 'develop');
  const before = git('ls-remote', '--refs', mirror);
  const result = spawnSync(
    'bash',
    [script, source, mirror, 'develop'],
    options(),
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Mirror matches the latest source refs/);
  assert.equal(git('ls-remote', '--refs', mirror), before);
  assert.equal(git('-C', source, 'status', '--porcelain'), '');
});

test('mirror polling follows a source that advances while waiting', async (t) => {
  const { source, mirror } = fixture(t);
  git('-C', source, 'push', mirror, 'develop');
  fs.writeFileSync(path.join(source, 'snapshot'), 'second');
  git('-C', source, 'commit', '-am', 'second');
  const child = spawn(
    'bash',
    [script, source, mirror, 'develop'],
    options({
      QL_MIRROR_WAIT_SECONDS: '6',
    }),
  );
  let output = '';
  let error = '';
  let moved = false;
  child.stderr.on('data', (data) => {
    error += data;
  });
  child.stdout.on('data', (data) => {
    output += data;
    if (!moved && output.includes('Waiting for mirror')) {
      moved = true;
      fs.writeFileSync(path.join(source, 'snapshot'), 'third');
      git('-C', source, 'commit', '-am', 'third');
      git('-C', source, 'push', mirror, 'develop');
    }
  });
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(status, 0, error + output);
  assert.ok(moved);
  assert.match(output, new RegExp(git('-C', source, 'rev-parse', 'develop')));
});

test('empty or missing refs never count as a synchronized mirror', (t) => {
  const { source, mirror } = fixture(t);
  for (const ref of ['develop', 'missing']) {
    const result = spawnSync(
      'bash',
      [script, source, mirror, ref],
      options({
        QL_MIRROR_WAIT_SECONDS: '1',
      }),
    );
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /is missing refs\/heads\//);
    assert.match(result.stdout, /::error::Mirror did not match/);
  }
});

test('static releases require both the version branch and annotated tag object', (t) => {
  const { source, mirror } = fixture(t);
  git('-C', source, 'branch', 'v2.22.0');
  git('-C', source, 'tag', '-a', 'v2.22.0', '-m', 'release');
  git('-C', source, 'push', mirror, 'refs/tags/v2.22.0');
  const args = [script, source, mirror, 'v2.22.0', 'tag'];
  const env = {
    QL_MIRROR_INCLUDE_VERSION_BRANCH: 'true',
    QL_MIRROR_WAIT_SECONDS: '1',
  };
  const partial = spawnSync('bash', args, options(env));
  assert.equal(partial.status, 1, partial.stderr + partial.stdout);
  assert.match(partial.stdout, /mirror is missing refs\/heads\/v2.22.0/);
  git('-C', source, 'push', mirror, 'refs/heads/v2.22.0');
  const complete = spawnSync('bash', args, options(env));
  assert.equal(complete.status, 0, complete.stderr + complete.stdout);
  assert.match(
    complete.stdout,
    new RegExp(git('-C', source, 'rev-parse', 'refs/tags/v2.22.0')),
  );
  // A tag pointing to the same commit with different annotation is still stale.
  git('-C', source, 'tag', '-fa', 'v2.22.0', '-m', 'updated annotation');
  const stale = spawnSync('bash', args, options(env));
  assert.equal(stale.status, 1, stale.stderr + stale.stdout);
});

test('network failures and hung ref queries stop within the configured deadline', (t) => {
  const { tmp, source, mirror } = fixture(t);
  const failure = spawnSync(
    'bash',
    [script, source, path.join(tmp, 'absent'), 'develop'],
    options({
      QL_MIRROR_WAIT_SECONDS: '1',
    }),
  );
  assert.equal(failure.status, 1, failure.stderr + failure.stdout);
  assert.match(failure.stdout, /Could not read mirror refs/);

  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(
    path.join(bin, 'git'),
    '#!/bin/sh\nif [ "$1" = ls-remote ]; then sleep 30; fi\nexec "$QL_TEST_GIT" "$@"\n',
    { mode: 0o755 },
  );
  const started = Date.now();
  const hung = spawnSync('bash', [script, source, mirror, 'develop'], {
    ...options({
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      QL_TEST_GIT: realGit,
      QL_MIRROR_WAIT_SECONDS: '2',
      QL_MIRROR_QUERY_TIMEOUT: '20',
    }),
    timeout: 5000,
  });
  assert.equal(hung.status, 1, hung.stderr + hung.stdout);
  assert.ok(Date.now() - started < 4500);
  assert.match(hung.stdout, /within 2s/);
});

test('invalid mirror parameters fail before polling', (t) => {
  const { source, mirror } = fixture(t);
  for (const args of [
    [],
    [source, mirror, 'develop', 'other'],
    [source, mirror, 'bad ref'],
  ]) {
    assert.notEqual(spawnSync('bash', [script, ...args], options()).status, 0);
  }
  for (const value of ['0', '-1', '1.5', '1+2', '9999999999999']) {
    const result = spawnSync(
      'bash',
      [script, source, mirror, 'develop'],
      options({
        QL_MIRROR_WAIT_SECONDS: value,
      }),
    );
    assert.equal(result.status, 2, result.stderr + result.stdout);
  }
});

test('Gitee workflows verify both mirrors and do not gate image publication', () => {
  const workflow = require('js-yaml').load(
    fs.readFileSync('.github/workflows/build-docker-image.yml', 'utf8'),
  );
  assert.equal(workflow.jobs.code_gitee, undefined);
  assert.equal(workflow.jobs.static_gitee, undefined);
  const job = workflow.jobs['verify-gitee-mirrors'];
  assert.equal(job.needs, 'build-static');
  assert.equal(job['timeout-minutes'], 14);
  assert.deepEqual(job.permissions, { contents: 'write' });
  assert.deepEqual(job.strategy.matrix.repository, [
    'qinglong',
    'qinglong-static',
  ]);
  const verify = job.steps.find((step) => step.run);
  assert.equal(verify.env.MIRROR_REF, '${{ github.ref_name }}');
  assert.equal(verify.env.MIRROR_REF_TYPE, '${{ github.ref_type }}');
  assert.equal(
    verify.env.QL_MIRROR_INCLUDE_VERSION_BRANCH,
    "${{ matrix.repository == 'qinglong-static' }}",
  );
  assert.match(verify.run, /bash scripts\/wait-for-mirror.sh/);
  assert.equal(verify.if, "${{ matrix.repository == 'qinglong' }}");
  assert.equal(verify.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(verify.env.QL_MIRROR_NOTIFY_ON_START, 'false');
  assert.equal(verify.env.QL_MIRROR_NOTIFY_REPO, 'whyour/qinglong');
  assert.doesNotMatch(
    JSON.stringify(verify),
    /secrets\.|git push|sync-static|ssh-keyscan/,
  );
  const notify = job.steps.find((step) =>
    /Notify and wait/.test(step.name || ''),
  );
  assert.equal(notify.if, "${{ matrix.repository == 'qinglong-static' }}");
  assert.equal(notify.env.GH_TOKEN, '${{ secrets.API_TOKEN }}');
  assert.match(notify.run, /bash scripts\/wait-for-mirror.sh/);
  assert.equal(notify.env.QL_MIRROR_NOTIFY_REPO, 'whyour/qinglong-static');
  assert.equal(notify.env.QL_MIRROR_INCLUDE_VERSION_BRANCH, 'true');
  assert.doesNotMatch(
    JSON.stringify(job),
    /GITEE_TOKEN|git@gitee|sync-static|ssh-keyscan/,
  );
  const backfill = workflow.jobs['verify-existing-static-gitee'];
  assert.match(backfill.if, /workflow_dispatch.*inputs.static_sync_only/);
  assert.equal(backfill.needs, undefined);
  const verifyExisting = backfill.steps.find((step) => step.run);
  assert.equal(verifyExisting.env.MIRROR_REF, '${{ inputs.static_ref }}');
  assert.equal(
    verifyExisting.env.MIRROR_REF_TYPE,
    '${{ inputs.static_ref_type }}',
  );
  assert.equal(verifyExisting.env.GH_TOKEN, '${{ secrets.API_TOKEN }}');
  assert.match(verifyExisting.run, /wait-for-mirror.sh/);
  assert.equal(
    verifyExisting.env.QL_MIRROR_NOTIFY_REPO,
    'whyour/qinglong-static',
  );
  assert.equal(verifyExisting.env.QL_MIRROR_INCLUDE_VERSION_BRANCH, 'true');
  assert.deepEqual(workflow.on.push.branches, ['master', 'develop']);
  assert.doesNotMatch(
    JSON.stringify(backfill),
    /GITEE_TOKEN|git@gitee|sync-static|ssh-keyscan/,
  );
  for (const name of [
    'build-alpine',
    'build-debian',
    'build-alpine310',
    'build-debian310',
  ]) {
    assert.equal(workflow.jobs[name].needs, 'build-static');
  }
});
