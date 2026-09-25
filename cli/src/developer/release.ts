import { translate } from '../i18n';
import path from 'node:path';
import { checkedProcess, runProcess } from '../local/process';
import { fail } from '../errors';

export interface ReleaseOptions {
  root: string;
  remote: string;
  branch: string;
  env?: NodeJS.ProcessEnv;
}
export interface ReleasePlan {
  commit: string;
  branch: string;
  tag: string;
  remote: string;
  previousBranch: string;
  previousTag: string;
  steps: string[];
}

export async function uploadReleaseMetadata(
  options: ReleaseOptions,
): Promise<void> {
  // Load the installed repository's release SDK, not a CLI runtime dependency.
  // Unlike the legacy sample tool, non-200 responses produce a failing exit code.
  const script = `
    const qiniu = require('qiniu');
    require('dotenv').config({ quiet: true });
    const { QINIU_AK, QINIU_SK, QINIU_SCOPE } = process.env;
    if (!QINIU_AK || !QINIU_SK || !QINIU_SCOPE) {
      process.stderr.write(${JSON.stringify(
        translate(options.env ?? process.env, '缺少 CDN 发布凭据。') + '\n',
      )}); process.exit(1);
    }
    const mac = new qiniu.auth.digest.Mac(QINIU_AK, QINIU_SK);
    const policy = new qiniu.rs.PutPolicy({scope: QINIU_SCOPE + ':version.yaml'});
    const uploader = new qiniu.form_up.FormUploader(new qiniu.conf.Config({zone:qiniu.zone.Zone_z1}));
    const timer = setTimeout(() => { process.stderr.write(${JSON.stringify(
      translate(options.env ?? process.env, 'CDN 上传超时。') + '\n',
    )}); process.exit(1); }, 60000);
    uploader.putFile(policy.uploadToken(mac), 'version.yaml', 'version.yaml',
      new qiniu.form_up.PutExtra('', {}, 'text/plain; charset=utf-8'),
      (error, body, response) => {
        clearTimeout(timer);
        if (error || !response || response.statusCode !== 200) {
          process.stderr.write(${JSON.stringify(
            translate(options.env ?? process.env, 'CDN 拒绝了发布元数据。') +
              '\n',
          )}); process.exit(1);
        }
      });
  `;
  await checkedProcess(process.execPath, ['-e', script], {
    cwd: options.root,
    env: options.env,
    timeoutMs: 65000,
  });
}

async function git(options: ReleaseOptions, args: string[]): Promise<string> {
  return (
    await checkedProcess('git', args, {
      cwd: options.root,
      env: options.env,
      capture: true,
    })
  ).stdout.trim();
}

export async function planRelease(
  options: ReleaseOptions,
): Promise<ReleasePlan> {
  if (!path.isAbsolute(options.root))
    fail(
      translate(options.env ?? process.env, '发布仓库路径必须为绝对路径。'),
      2,
    );
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.remote))
    fail(
      translate(options.env ?? process.env, '必须指定已配置的 Git 远端名称。'),
      2,
    );
  const branchCheck = await runProcess(
    'git',
    ['check-ref-format', `refs/heads/${options.branch}`],
    { cwd: options.root, env: options.env, capture: true },
  );
  if (branchCheck.code !== 0 || options.branch.startsWith('-'))
    fail(translate(options.env ?? process.env, '发布分支无效。'), 2);
  if (await git(options, ['status', '--porcelain']))
    fail(
      translate(
        options.env ?? process.env,
        '发布需要干净的工作区，不能包含未跟踪文件。',
      ),
    );
  const commit = await git(options, ['rev-parse', '--verify', 'HEAD']);
  const versionFile = await git(options, ['show', `${commit}:version.yaml`]);
  const version = versionFile.match(
    /^version:\s*["']?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)["']?\s*$/m,
  )?.[1];
  if (!version)
    fail(
      translate(
        options.env ?? process.env,
        'version.yaml 必须包含有效的发布版本。',
      ),
    );
  const tag = `v${version}`;
  const refs = await git(options, [
    'ls-remote',
    '--refs',
    options.remote,
    `refs/heads/${options.branch}`,
    `refs/tags/${tag}`,
  ]);
  const remoteRefs = new Map(
    refs
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/) as [string, string])
      .map(([sha, ref]) => [ref, sha]),
  );
  return {
    commit,
    branch: options.branch,
    tag,
    remote: options.remote,
    previousBranch: remoteRefs.get(`refs/heads/${options.branch}`) ?? '',
    previousTag: remoteRefs.get(`refs/tags/${tag}`) ?? '',
    steps: [
      translate(options.env ?? process.env, '将本地发布分支重置到已审阅的提交'),
      translate(
        options.env ?? process.env,
        '使用已安装的七牛 SDK 上传 version.yaml',
      ),
      translate(options.env ?? process.env, '创建或替换带注释的发布标签'),
      translate(
        options.env ?? process.env,
        '通过显式远端租约原子推送发布分支和标签',
      ),
    ],
  };
}

export async function applyRelease(
  options: ReleaseOptions,
  expectedCommit: string,
): Promise<ReleasePlan> {
  const plan = await planRelease(options);
  if (expectedCommit !== plan.commit)
    fail(
      translate(
        options.env ?? process.env,
        'HEAD 与已审阅的发布提交不同，请重新生成计划。',
      ),
      2,
    );
  await git(options, ['checkout', '-B', options.branch, plan.commit]);
  await uploadReleaseMetadata(options);
  if (
    (await git(options, ['rev-parse', 'HEAD'])) !== plan.commit ||
    (await git(options, ['status', '--porcelain']))
  )
    fail(
      translate(
        options.env ?? process.env,
        'CDN 上传期间发布文件发生变化，未更新远端引用。',
      ),
    );
  await git(options, [
    'tag',
    '-f',
    '-a',
    plan.tag,
    '-m',
    `release ${plan.tag}`,
    plan.commit,
  ]);
  await git(options, [
    'push',
    '--atomic',
    '--set-upstream',
    `--force-with-lease=refs/heads/${plan.branch}:${plan.previousBranch}`,
    `--force-with-lease=refs/tags/${plan.tag}:${plan.previousTag}`,
    plan.remote,
    `${plan.commit}:refs/heads/${plan.branch}`,
    `refs/tags/${plan.tag}:refs/tags/${plan.tag}`,
  ]);
  return plan;
}
