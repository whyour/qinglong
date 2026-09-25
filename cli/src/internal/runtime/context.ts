import path from 'node:path';
import { translate } from '../../shared/i18n/index';
import fs from 'node:fs';
import { runProcess } from './process';
import { fail } from '../../shared/errors';
import type { Invocation } from '../../shared/cli/arguments';

export interface LocalContext {
  root: string;
  data: string;
  env: NodeJS.ProcessEnv;
  paths: Record<string, string>;
}

export function createContext(
  options: Record<string, string | boolean | undefined> = {},
  inherited: NodeJS.ProcessEnv = process.env,
): LocalContext {
  const configuredRoot =
    typeof options.root === 'string' ? options.root : inherited.QL_DIR;
  if (!configuredRoot || !path.isAbsolute(configuredRoot))
    fail(
      translate(inherited, '本机命令需要通过 --root 或 QL_DIR 指定绝对路径。'),
      2,
    );
  const root = path.resolve(configuredRoot);
  const data = path.resolve(
    typeof options['data-dir'] === 'string'
      ? options['data-dir']
      : inherited.QL_DATA_DIR || path.join(root, 'data'),
  );
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory())
    fail(translate(inherited, '面板安装目录不存在或不是目录。'), 2);
  const paths: Record<string, string> = {};
  for (const [name, value] of Object.entries({
    root,
    data,
    tmp: path.join(root, '.tmp'),
    static: path.join(root, 'static'),
    shell: path.join(root, 'shell'),
    preload: path.join(root, 'shell/preload'),
    sample: path.join(root, 'sample'),
    config: path.join(data, 'config'),
    scripts: path.join(data, 'scripts'),
    repo: path.join(data, 'repo'),
    raw: path.join(data, 'raw'),
    log: path.join(data, 'log'),
    db: path.join(data, 'db'),
    dep: path.join(data, 'deps'),
    list_tmp: path.join(data, 'log/.tmp'),
    update_log: path.join(data, 'log/update'),
  }))
    paths[`dir_${name}`] = value;
  for (const [name, value] of Object.entries({
    config_sample: 'sample/config.sample.sh',
    auth_sample: 'sample/auth.sample.json',
    task_sample: 'sample/task.sample.sh',
    extra_sample: 'sample/extra.sample.sh',
    notify_py_sample: 'sample/notify.py',
    notify_js_sample: 'sample/notify.js',
    test_js_sample: 'sample/ql_sample.js',
    test_py_sample: 'sample/ql_sample.py',
    env: 'shell/preload/env.sh',
    preload_js: 'shell/preload/sitecustomize.js',
  }))
    paths[`file_${name}`] = path.join(root, value);
  for (const [name, value] of Object.entries({
    config_user: 'config/config.sh',
    auth_user: 'config/auth.json',
    auth_token: 'config/token.json',
    extra_shell: 'config/extra.sh',
    task_before: 'config/task_before.sh',
    task_before_js: 'config/task_before.js',
    task_before_py: 'config/task_before.py',
    task_after: 'config/task_after.sh',
    notify_py: 'scripts/notify.py',
    notify_js: 'scripts/sendNotify.js',
    test_js: 'scripts/ql_sample.js',
    test_py: 'scripts/ql_sample.py',
    sharecode: 'config/sharecode.sh',
  }))
    paths[`file_${name}`] = path.join(data, value);
  paths.dep_notify_py = path.join(data, 'deps/notify.py');
  paths.dep_notify_js = path.join(data, 'deps/sendNotify.js');
  paths.list_crontab_user = path.join(data, 'config/crontab.list');
  return {
    root,
    data,
    paths,
    env: {
      ...inherited,
      ...paths,
      QL_DIR: root,
      QL_DATA_DIR: data,
      PYTHONUNBUFFERED: '1',
      cmd_task: 'task',
      cmd_ql: 'ql',
      is_macos: process.platform === 'darwin' ? '1' : '0',
      is_termux: inherited.PATH?.includes('com.termux') ? '1' : '0',
    },
  };
}

// This bridge interprets user configuration only; it never sources product shell/*.sh.
// Move the parent transport from fd 3 to an internal descriptor before user
// configuration can reuse fd 3 (or fd 9 for a lock).
export async function sourceEnvironment(
  env: NodeJS.ProcessEnv,
  files: string[],
  args: string[] = [],
  options: {
    command?: string;
    signal?: AbortSignal;
    output?: (chunk: Buffer) => void;
    stderrOutput?: (chunk: Buffer) => void;
  } = {},
): Promise<NodeJS.ProcessEnv> {
  const script = `exec 19>&3 3>&-
__ql_env="$1"; __ql_files="$2"; __ql_command="$3"; shift 3
set -a
while IFS= read -r __ql_file; do
  if [ -f "$__ql_file" ]; then . "$__ql_file" "$@"; fi
done <<< "$__ql_files"
if [ -n "$__ql_command" ]; then eval "$__ql_command"; fi
__ql_shopts=""
while read -r __ql_builtin __ql_state __ql_option; do
  if [ "$__ql_state" = '-s' ]; then
    __ql_shopts="\${__ql_shopts:+$__ql_shopts:}$__ql_option"
  fi
done < <(shopt -p)
__ql_shellopts="$SHELLOPTS" __ql_bashopts="$__ql_shopts" "$__ql_env" -0 >&19
`;
  const execution = await runProcess(
    'bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      script,
      'ql-config',
      '/usr/bin/env',
      files.join('\n'),
      options.command ?? '',
      ...args,
    ],
    {
      env,
      capture: true,
      captureFd: 3,
      maxCaptureBytes: 4 * 1024 * 1024,
      timeoutMs: 30000,
      graceMs: 1000,
      output: options.output,
      stderrOutput: options.stderrOutput,
      signal: options.signal,
    },
  );
  if (options.signal?.aborted) {
    const error = new Error(
      translate(env, '用户配置加载已取消。'),
    ) as NodeJS.ErrnoException;
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    throw error;
  }
  if (execution.code !== 0)
    throw new Error(translate(env, '用户配置加载失败。'));
  try {
    // NUL framing preserves newlines, '=' characters and exported Bash
    // functions without launching another Node process to serialize JSON.
    if (!execution.stdout.endsWith('\0')) throw new Error();
    const result: NodeJS.ProcessEnv = Object.create(null);
    for (const entry of execution.stdout.slice(0, -1).split('\0')) {
      const separator = entry.indexOf('=');
      if (separator <= 0) throw new Error();
      result[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
    if (
      typeof result.__ql_shellopts !== 'string' ||
      typeof result.__ql_bashopts !== 'string'
    )
      throw new Error();
    result.SHELLOPTS = result.__ql_shellopts
      .split(':')
      .filter((value) => value !== 'allexport')
      .join(':');
    result.BASHOPTS = result.__ql_bashopts;
    result.QL_CLI_SHELLOPTS = result.SHELLOPTS;
    result.QL_CLI_BASHOPTS = result.BASHOPTS;
    for (const key of Object.keys(result))
      if (key.startsWith('__ql_')) delete result[key];
    return result;
  } catch {
    throw new Error(translate(env, '用户配置返回了无效的环境数据。'));
  }
}

export async function localContext(
  command: Pick<Invocation, 'values' | 'positionals'>,
  options: { signal?: AbortSignal } = {},
): Promise<LocalContext> {
  const context = createContext(command.values);
  context.env = await sourceEnvironment(
    context.env,
    [
      context.paths.file_config_user!,
      path.join(context.paths.dir_preload!, 'lang_env.sh'),
    ],
    command.positionals,
    options,
  );
  return context;
}
