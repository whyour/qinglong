const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { planRelease, applyRelease } = require('../dist/developer/release');

async function fixture(t) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ql-release-')),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'source'),
    remote = path.join(base, 'remote.git');
  await fs.mkdir(root);
  const git = (...args) =>
    execFileSync('/usr/bin/git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  git('init', '-q', '-b', 'develop');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('init', '--bare', '-q', remote);
  git('remote', 'add', 'origin', remote);
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  await fs.writeFile(path.join(root, 'version.yaml'), 'version: 2.21.0\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  const first = git('rev-parse', 'HEAD');
  git('push', 'origin', 'HEAD:refs/heads/master');
  git('tag', '-a', 'v2.21.0', '-m', 'old');
  git('push', 'origin', 'refs/tags/v2.21.0');
  git('tag', 'unrelated-local');
  await fs.writeFile(path.join(root, 'release.txt'), 'new version');
  git('add', '.');
  git('commit', '-qm', 'new');
  for (const name of ['qiniu', 'dotenv'])
    await fs.mkdir(path.join(root, 'node_modules', name), { recursive: true });
  await fs.writeFile(
    path.join(root, 'node_modules/dotenv/index.js'),
    'exports.config=()=>({});',
  );
  await fs.writeFile(
    path.join(root, 'node_modules/qiniu/index.js'),
    `
    class Empty { constructor(...args){} uploadToken(){return 'fixture-token';} }
    class Uploader { putFile(token,key,file,extra,callback){
      require('node:fs').appendFileSync(process.env.UPLOAD_LOG,key+'\\n');
      if(process.env.RACE_REF) require('node:child_process').execFileSync('/usr/bin/git',['push','origin',process.env.RACE_REF+':refs/heads/master','--force']);
      callback(null,{}, {statusCode:Number(process.env.UPLOAD_STATUS||200)});
    }}
    module.exports={auth:{digest:{Mac:Empty}},rs:{PutPolicy:Empty},conf:{Config:Empty},zone:{Zone_z1:{}},form_up:{FormUploader:Uploader,PutExtra:Empty}};
  `,
  );
  const options = {
    root,
    remote: 'origin',
    branch: 'master',
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      QINIU_AK: 'fixture',
      QINIU_SK: 'fixture',
      QINIU_SCOPE: 'fixture',
      UPLOAD_LOG: path.join(base, 'upload'),
    },
  };
  return { root, git, first, options, base };
}

test('release plan does not mutate refs; apply replaces only the selected branch and tag', async (t) => {
  const { git, first, options } = await fixture(t);
  const plan = await planRelease(options);
  assert.equal(plan.previousBranch, first);
  assert.equal(plan.tag, 'v2.21.0');
  assert.equal(git('branch', '--show-current'), 'develop');
  await assert.rejects(fs.stat(options.env.UPLOAD_LOG), { code: 'ENOENT' });
  await applyRelease(options, plan.commit);
  assert.equal(git('branch', '--show-current'), 'master');
  const refs = git('ls-remote', 'origin');
  assert.ok(refs.includes(plan.commit + '\trefs/heads/master'));
  assert.ok(refs.includes(plan.commit + '\trefs/tags/v2.21.0^{}'));
  assert.ok(!refs.includes('unrelated-local'));
  assert.equal(
    await fs.readFile(options.env.UPLOAD_LOG, 'utf8'),
    'version.yaml\n',
  );
});

test('CDN failure does not change remote release refs', async (t) => {
  const { git, options } = await fixture(t);
  const before = git('ls-remote', 'origin');
  const plan = await planRelease(options);
  options.env.UPLOAD_STATUS = '500';
  await assert.rejects(
    applyRelease(options, plan.commit),
    /Required executable failed|必要的可执行程序失败/,
  );
  assert.equal(git('ls-remote', 'origin'), before);
});

test('stale commit and dirty tree are rejected before CDN upload', async (t) => {
  const { root, options, first } = await fixture(t);
  await assert.rejects(
    applyRelease(options, first),
    /reviewed release commit|已审阅的发布提交/,
  );
  await assert.rejects(fs.stat(options.env.UPLOAD_LOG), { code: 'ENOENT' });
  await fs.writeFile(path.join(root, 'dirty'), 'untracked');
  await assert.rejects(planRelease(options), /clean working tree|干净的工作区/);
});

test('remote lease rejects concurrent branch changes and leaves the remote tag intact', async (t) => {
  const { git, options } = await fixture(t);
  const plan = await planRelease(options);
  git('checkout', '-qb', 'racing');
  await fs.writeFile(path.join(options.root, 'racing'), 'other publisher');
  git('add', '.');
  git('commit', '-qm', 'racing');
  const racing = git('rev-parse', 'HEAD');
  git('checkout', 'develop');
  options.env.RACE_REF = racing;
  await assert.rejects(
    applyRelease(options, plan.commit),
    /Required executable failed|必要的可执行程序失败/,
  );
  assert.equal(
    git('ls-remote', '--refs', 'origin', 'refs/heads/master').split(/\s+/)[0],
    racing,
  );
  assert.equal(
    git('ls-remote', '--refs', 'origin', 'refs/tags/v2.21.0').split(/\s+/)[0],
    plan.previousTag,
  );
});

for (const language of ['zh', 'en', 'unsupported']) {
  test(`release validation and CDN failure diagnostics honor locale: ${language}`, async (t) => {
    const { root, git, options, first } = await fixture(t);
    options.env.QL_LANG = language;
    const expected = (zh, en) => (language === 'en' ? en : zh);
    const before = git('ls-remote', 'origin');
    for (const [change, chinese, english] of [
      [{ root: 'relative' }, /必须为绝对路径/, /must be absolute/],
      [{ remote: '-invalid' }, /Git 远端名称/, /Git remote name/],
      [{ branch: 'bad..branch' }, /发布分支无效/, /Invalid release branch/],
    ])
      await assert.rejects(planRelease({ ...options, ...change }), (error) => {
        assert.equal(error.exitCode, 2);
        assert.match(error.message, expected(chinese, english));
        return true;
      });
    const plan = await planRelease(options);
    assert.equal(plan.steps.length, 4);
    assert.match(plan.steps[0], expected(/已审阅的提交/, /reviewed commit/));
    await assert.rejects(
      applyRelease(options, first),
      expected(/已审阅的发布提交/, /reviewed release commit/),
    );
    await assert.rejects(fs.access(options.env.UPLOAD_LOG), { code: 'ENOENT' });
    const { uploadReleaseMetadata } = require('../dist/developer/release');
    const { withOperationOutput } = require('../dist/local/output');
    for (const missing of [true, false]) {
      const env = { ...options.env, UPLOAD_STATUS: '500' };
      if (missing) delete env.QINIU_AK;
      let output = '';
      await assert.rejects(
        withOperationOutput(
          (chunk) => {
            output += chunk;
          },
          () => uploadReleaseMetadata({ ...options, env }),
        ),
        (error) => error.exitCode === 1,
      );
      assert.match(
        output,
        missing
          ? expected(/缺少 CDN 发布凭据/, /Missing CDN release credentials/)
          : expected(
              /CDN 拒绝了发布元数据/,
              /CDN rejected the release metadata/,
            ),
      );
      assert.doesNotMatch(output, /fixture-token/);
      assert.equal(git('ls-remote', 'origin'), before);
    }
    await fs.writeFile(path.join(root, 'dirty'), 'keep');
    await assert.rejects(
      planRelease(options),
      expected(/干净的工作区/, /clean working tree/),
    );
    await fs.rm(path.join(root, 'dirty'));
    await fs.writeFile(path.join(root, 'version.yaml'), 'version: invalid\n');
    git('add', 'version.yaml');
    git('commit', '-qm', 'invalid fixture version');
    await assert.rejects(
      planRelease(options),
      expected(/有效的发布版本/, /valid release version/),
    );
    assert.equal(git('ls-remote', 'origin'), before);
  });
}
