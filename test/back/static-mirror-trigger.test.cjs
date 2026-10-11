const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const notify = path.resolve('scripts/wait-for-mirror.sh');
const verify = notify;
const triggerRef = 'refs/heads/gitee-sync-trigger';
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim();

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-mirror-trigger-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const work = path.join(tmp, 'work');
  const source = path.join(tmp, 'source.git');
  const mirror = path.join(tmp, 'mirror.git');
  for (const repo of [source, mirror]) git('init', '--bare', repo);
  git('init', work);
  for (const repo of [source, work]) {
    git('-C', repo, 'config', 'user.name', 'Fixture');
    git('-C', repo, 'config', 'user.email', 'fixture@example.invalid');
  }
  git('-C', work, 'checkout', '-b', 'develop');
  fs.writeFileSync(path.join(work, 'snapshot'), 'static artifact');
  git('-C', work, 'add', '.');
  git('-C', work, 'commit', '-m', 'snapshot');
  git('-C', work, 'push', source, 'develop');
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  // Model GitHub's Git Data API with real Git objects and non-forced ref updates.
  // The fixture's post-receive hook simulates Gitee receiving the push event.
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const endpoint = args.find((arg) => arg.startsWith('repos/'));
const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
const fields = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-f' || args[i] === '-F') {
    const field = args[++i];
    const separator = field.indexOf('=');
    fields[field.slice(0, separator)] = field.slice(separator + 1);
  }
}
fs.appendFileSync(process.env.QL_TEST_API_LOG, JSON.stringify({method, endpoint, fields, time: Date.now()}) + '\\n');
const source = process.env.QL_TEST_SOURCE;
const git = (...args) => execFileSync('git', ['-C', source, ...args], {encoding: 'utf8', stdio: 'pipe'}).trim();
const fail = (status) => { console.error('gh: API failure (HTTP ' + status + ')'); process.exit(1); };
const ref = 'refs/heads/gitee-sync-trigger';
const isUpdate = method === 'PATCH' || endpoint.endsWith('/git/refs');
if (process.env.QL_TEST_API_HANG) spawnSync('sleep', ['30'], {stdio: 'ignore'});
if (process.env.QL_TEST_API_REJECT) fail(500);
if (isUpdate && process.env.QL_TEST_COLLISION && !fs.existsSync(process.env.QL_TEST_COLLISION)) {
  const current = git('rev-parse', ref);
  const tree = git('rev-parse', current + '^{tree}');
  const peer = git('commit-tree', tree, '-p', current, '-m', 'Concurrent notifier');
  git('update-ref', ref, peer);
  fs.writeFileSync(process.env.QL_TEST_COLLISION, peer);
}
if (isUpdate && process.env.QL_TEST_UPDATE_FAILURE && !fs.existsSync(process.env.QL_TEST_UPDATE_FAILURE)) {
  fs.writeFileSync(process.env.QL_TEST_UPDATE_FAILURE, 'failed');
  fail(500);
}
try {
  if (method === 'GET' && endpoint.includes('/git/ref/')) {
    console.log(git('rev-parse', '--verify', 'refs/' + endpoint.split('/git/ref/')[1]));
  } else if (method === 'GET' && endpoint.includes('/git/commits/')) {
    console.log(git('rev-parse', endpoint.split('/git/commits/')[1] + '^{tree}'));
  } else if (endpoint.endsWith('/git/trees')) {
    const body = JSON.parse(fs.readFileSync(0, 'utf8'));
    const entries = body.tree.map((entry) => {
      const blob = execFileSync('git', ['-C', source, 'hash-object', '-w', '--stdin'], {encoding: 'utf8', input: entry.content}).trim();
      return entry.mode + ' blob ' + blob + '\\t' + entry.path + '\\n';
    }).join('');
    console.log(execFileSync('git', ['-C', source, 'mktree'], {encoding: 'utf8', input: entries}).trim());
  } else if (endpoint.endsWith('/git/commits')) {
    const parents = fields['parents[]'] ? ['-p', fields['parents[]']] : [];
    console.log(git('commit-tree', fields.tree, ...parents, '-m', fields.message));
  } else if (isUpdate) {
    const current = spawnSync('git', ['-C', source, 'rev-parse', '--verify', ref], {encoding: 'utf8'});
    const old = current.status === 0 ? current.stdout.trim() : '0'.repeat(40);
    if (method === 'PATCH') {
      if (fields.force !== 'false' || current.status !== 0 || spawnSync('git', ['-C', source, 'merge-base', '--is-ancestor', old, fields.sha]).status !== 0) fail(422);
    } else if (current.status === 0 || fields.ref !== ref) fail(422);
    git('update-ref', ref, fields.sha, old);
    const hook = path.join(source, 'hooks/post-receive');
    if (fs.existsSync(hook)) execFileSync(hook, {cwd: source, input: old + ' ' + fields.sha + ' ' + ref + '\\n', env: {...process.env, GIT_DIR: source}, stdio: ['pipe', 'pipe', 'pipe']});
  } else fail(400);
} catch (error) { fail(method === 'GET' ? 404 : 422); }
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    QL_TEST_SOURCE: source,
    QL_TEST_API_LOG: path.join(tmp, 'api.log'),
    QL_MIRROR_NOTIFY_REPO: 'fixture/source',
    QL_MIRROR_INCLUDE_VERSION_BRANCH: 'true',
    QL_MIRROR_WAIT_SECONDS: '4',
    QL_MIRROR_RETRY_AFTER_SECONDS: '1',
    QL_MIRROR_POLL_INTERVAL: '1',
    QL_MIRROR_QUERY_TIMEOUT: '1',
  };
  return { tmp, work, source, mirror, env };
}

test('static notifications use a tiny REST branch with unchanged trees and preserve published refs', (t) => {
  const { source, env } = fixture(t);
  const snapshot = git('-C', source, 'rev-parse', 'develop');
  execFileSync('bash', [notify, source, source, 'develop', 'branch'], {
    stdio: 'pipe',
    env,
  });
  const first = git('-C', source, 'rev-parse', triggerRef);
  execFileSync('bash', [notify, source, source, 'develop', 'branch'], {
    stdio: 'pipe',
    env,
  });
  const second = git('-C', source, 'rev-parse', triggerRef);
  assert.notEqual(first, second);
  assert.equal(git('-C', source, 'rev-parse', `${second}^`), first);
  assert.equal(
    git('-C', source, 'ls-tree', '-r', '--name-only', second),
    '.gitee-sync-trigger',
  );
  assert.equal(git('-C', source, 'diff', '--name-only', first, second), '');
  assert.equal(git('-C', source, 'rev-parse', 'develop'), snapshot);
  assert.match(
    git('-C', source, 'log', '-1', '--format=%s', second),
    new RegExp(snapshot),
  );
});

test('REST notifications retry a newer parent and GitHub 500s with backoff', (t) => {
  const { tmp, source, env } = fixture(t);
  execFileSync('bash', [notify, source, source, 'develop'], {
    stdio: 'pipe',
    env,
  });
  const parent = git('-C', source, 'rev-parse', triggerRef);
  const flag = path.join(tmp, 'collision');
  const collision = spawnSync('bash', [notify, source, source, 'develop'], {
    encoding: 'utf8',
    env: { ...env, QL_TEST_COLLISION: flag },
  });
  assert.equal(collision.status, 0, collision.stderr + collision.stdout);
  assert.match(collision.stdout, /notification update failed \(attempt 1\)/);
  const peer = fs.readFileSync(flag, 'utf8');
  assert.equal(git('-C', source, 'rev-parse', `${peer}^`), parent);
  assert.equal(git('-C', source, 'rev-parse', `${triggerRef}^`), peer);
  const failed = path.join(tmp, 'failed');
  const recovery = spawnSync('bash', [notify, source, source, 'develop'], {
    encoding: 'utf8',
    env: { ...env, QL_TEST_UPDATE_FAILURE: failed },
  });
  assert.equal(recovery.status, 0, recovery.stderr + recovery.stdout);
  assert.match(recovery.stderr, /HTTP 500/);
  const calls = fs
    .readFileSync(env.QL_TEST_API_LOG, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const updates = calls.filter((call) => call.method === 'PATCH');
  assert.ok(updates.every((call) => call.fields.force === 'false'));
  const last = updates.slice(-2);
  assert.ok(
    last[1].time - last[0].time >= 1900,
    'failed API updates must back off',
  );
});

test('missing snapshots fail before sending any notification', (t) => {
  const { source, env } = fixture(t);
  const missing = spawnSync('bash', [notify, source, source, 'missing'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(missing.status, 1, missing.stderr + missing.stdout);
  assert.match(missing.stdout, /Published source ref.*does not exist/);
  assert.equal(fs.existsSync(env.QL_TEST_API_LOG), false);
});

test('notification failure does not prevent an already synchronized mirror from passing', (t) => {
  const { source, mirror, env } = fixture(t);
  git('-C', source, 'push', mirror, 'develop');
  const result = spawnSync('bash', [verify, source, mirror, 'develop'], {
    encoding: 'utf8',
    env: { ...env, QL_TEST_API_REJECT: 'true' },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(
    result.stdout,
    /Could not send the mirror notification; continuing/,
  );
  assert.match(result.stdout, /Mirror matches the latest source refs/);
});

test('a failed delayed notification keeps polling until the mirror updates', async (t) => {
  const { source, mirror, env } = fixture(t);
  const child = spawn('bash', [verify, source, mirror, 'develop'], {
    env: {
      ...env,
      QL_MIRROR_NOTIFY_ON_START: 'false',
      QL_MIRROR_WAIT_SECONDS: '10',
      QL_TEST_API_REJECT: 'true',
    },
  });
  let output = '';
  let error = '';
  let synchronized = false;
  child.stderr.on('data', (data) => {
    error += data;
  });
  child.stdout.on('data', (data) => {
    output += data;
    if (
      !synchronized &&
      output.includes('Could not read notification ref (attempt 1)')
    ) {
      synchronized = true;
      git('-C', source, 'push', mirror, 'develop');
    }
  });
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.ok(synchronized);
  assert.equal(status, 0, error + output);
  assert.match(output, /Mirror matches the latest source refs/);
});

test('failed or hung notifications preserve the mirror polling deadline', (t) => {
  const { source, mirror, env } = fixture(t);
  for (const failure of ['QL_TEST_API_REJECT', 'QL_TEST_API_HANG']) {
    const started = Date.now();
    const result = spawnSync('bash', [verify, source, mirror, 'develop'], {
      encoding: 'utf8',
      timeout: 6000,
      env: {
        ...env,
        QL_MIRROR_NOTIFY_ON_START: 'false',
        QL_MIRROR_WAIT_SECONDS: '3',
        [failure]: 'true',
      },
    });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.ok(Date.now() - started < 5000);
    assert.match(result.stdout, /::error::Mirror did not match.*within 3s/);
  }
});

test('static verification retries a small GitHub notification after a missed sync interval', (t) => {
  const { tmp, source, mirror, env } = fixture(t);
  const snapshot = git('-C', source, 'rev-parse', 'develop');
  git('-C', source, 'update-ref', 'refs/heads/v2.22.0', snapshot);
  git('-C', source, 'update-ref', 'refs/tags/v2.22.0', snapshot);
  const countFile = path.join(tmp, 'requests');
  fs.writeFileSync(
    path.join(source, 'hooks/post-receive'),
    `#!/bin/sh
while read before after ref; do
  if [ "$ref" = refs/heads/gitee-sync-trigger ]; then
    count=0
    if [ -f "$QL_TEST_COUNT" ]; then count=$(cat "$QL_TEST_COUNT"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$QL_TEST_COUNT"
    if [ "$count" -ge 2 ]; then
      git push --quiet "$QL_TEST_MIRROR" refs/heads/v2.22.0:refs/heads/v2.22.0 refs/tags/v2.22.0:refs/tags/v2.22.0
    fi
  fi
done
`,
    { mode: 0o755 },
  );
  const result = spawnSync('bash', [verify, source, mirror, 'v2.22.0', 'tag'], {
    encoding: 'utf8',
    env: {
      ...env,
      QL_TEST_COUNT: countFile,
      QL_TEST_MIRROR: mirror,
    },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(fs.readFileSync(countFile, 'utf8'), '2');
  assert.match(result.stdout, /Retrying the GitHub notification/);
  assert.match(result.stdout, /Mirror matches the latest source refs/);
  assert.doesNotMatch(result.stdout, /::error::/);
  for (const ref of ['refs/heads/v2.22.0', 'refs/tags/v2.22.0']) {
    assert.equal(git('-C', mirror, 'rev-parse', ref), snapshot);
  }
});

test('static verification still fails when fresh notifications never synchronize the mirror', (t) => {
  const { source, mirror, env } = fixture(t);
  const result = spawnSync(
    'bash',
    [verify, source, mirror, 'develop', 'branch'],
    {
      encoding: 'utf8',
      env: {
        ...env,
        QL_MIRROR_WAIT_SECONDS: '2',
      },
    },
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  // The retry contract is checked above. A short polling deadline can expire
  // while the REST fixture is still sending its second notification.
  const notifications = Number(
    git('-C', source, 'rev-list', '--count', triggerRef),
  );
  assert.ok(notifications >= 1 && notifications <= 2);
  assert.match(result.stdout, /::error::Mirror did not match/);
  const invalid = spawnSync(
    'bash',
    [verify, source, mirror, 'develop', 'branch'],
    {
      encoding: 'utf8',
      env: { ...env, QL_MIRROR_WAIT_SECONDS: '0' },
    },
  );
  assert.equal(invalid.status, 2);
});

test('code mirrors that already match do not send another notification', (t) => {
  const { source, mirror, env } = fixture(t);
  git('-C', source, 'push', mirror, 'develop');
  const codeEnv = {
    ...env,
    QL_MIRROR_NOTIFY_REPO: 'fixture/source',
    QL_MIRROR_NOTIFY_ON_START: 'false',
    QL_MIRROR_INCLUDE_VERSION_BRANCH: 'false',
  };
  const result = spawnSync(
    'bash',
    [verify, source, mirror, 'develop', 'branch'],
    {
      encoding: 'utf8',
      env: codeEnv,
    },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Mirror matches the latest source refs/);
  assert.doesNotMatch(result.stdout, /Sent a small GitHub push event via REST/);
  assert.notEqual(
    spawnSync('git', ['-C', source, 'rev-parse', '--verify', triggerRef])
      .status,
    0,
  );
  const invalid = spawnSync(
    'bash',
    [verify, source, mirror, 'develop', 'branch'],
    {
      encoding: 'utf8',
      env: { ...codeEnv, QL_MIRROR_NOTIFY_ON_START: 'later' },
    },
  );
  assert.equal(invalid.status, 2);
});

test('code mirrors notify after the sync interval and verify tags without version branches', (t) => {
  const { tmp, work, source, mirror, env } = fixture(t);
  const snapshot = git('-C', source, 'rev-parse', 'develop');
  git('-C', work, 'tag', '-a', 'v2.22.0', '-m', 'release');
  git('-C', work, 'push', source, 'refs/tags/v2.22.0');
  const tag = git('-C', source, 'rev-parse', 'refs/tags/v2.22.0');
  const countFile = path.join(tmp, 'requests');
  fs.writeFileSync(
    path.join(source, 'hooks/post-receive'),
    `#!/bin/sh
while read before after ref; do
  if [ "$ref" = refs/heads/gitee-sync-trigger ]; then
    printf 'notification\n' >> "$QL_TEST_COUNT"
    git push --quiet "$QL_TEST_MIRROR" refs/tags/v2.22.0:refs/tags/v2.22.0
  fi
done
`,
    { mode: 0o755 },
  );
  const started = Date.now();
  const result = spawnSync('bash', [verify, source, mirror, 'v2.22.0', 'tag'], {
    encoding: 'utf8',
    env: {
      ...env,
      QL_MIRROR_NOTIFY_REPO: 'fixture/source',
      QL_MIRROR_NOTIFY_ON_START: 'false',
      QL_MIRROR_INCLUDE_VERSION_BRANCH: 'false',
      QL_MIRROR_RETRY_AFTER_SECONDS: '1',
      QL_TEST_COUNT: countFile,
      QL_TEST_MIRROR: mirror,
    },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(
    Date.now() - started >= 900,
    'notification should wait for the sync interval',
  );
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'notification\n');
  assert.equal(git('-C', source, 'rev-list', '--count', triggerRef), '1');
  assert.equal(git('-C', source, 'rev-parse', 'develop'), snapshot);
  assert.equal(git('-C', mirror, 'rev-parse', 'refs/tags/v2.22.0'), tag);
  assert.notEqual(
    spawnSync('git', [
      '-C',
      mirror,
      'rev-parse',
      '--verify',
      'refs/heads/v2.22.0',
    ]).status,
    0,
  );
});

test('code mirrors that never synchronize fail after one delayed notification', (t) => {
  const { source, mirror, env } = fixture(t);
  const result = spawnSync(
    'bash',
    [verify, source, mirror, 'develop', 'branch'],
    {
      encoding: 'utf8',
      env: {
        ...env,
        QL_MIRROR_NOTIFY_REPO: 'fixture/source',
        QL_MIRROR_NOTIFY_ON_START: 'false',
        QL_MIRROR_WAIT_SECONDS: '3',
        QL_MIRROR_RETRY_AFTER_SECONDS: '1',
      },
    },
  );
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.equal(git('-C', source, 'rev-list', '--count', triggerRef), '1');
  assert.match(result.stdout, /::error::Mirror did not match/);
});
