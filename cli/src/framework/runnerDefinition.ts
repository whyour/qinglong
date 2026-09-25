import { quietCommand, addFlags } from './options';

// The parser and Commander help share the same options. Script modes and
// arguments after the script remain the legacy execution adapter's concern.
export const runnerOptions = {
  root: {
    type: 'string',
    description: 'Installed panel root',
    chinese: '面板安装目录',
  },
  'data-dir': {
    type: 'string',
    description: 'Panel data directory',
    chinese: '面板数据目录',
  },
  timeout: {
    type: 'string',
    short: 'm',
    description: 'Execution timeout',
    chinese: '执行超时',
  },
  log: {
    type: 'boolean',
    short: 'l',
    description: 'Legacy compatibility flag',
    chinese: '旧命令兼容选项',
  },
  json: {
    type: 'boolean',
    description: 'JSON result; script output on stderr',
    chinese: 'JSON 结果；脚本输出写入 stderr',
  },
  help: {
    type: 'boolean',
    short: 'h',
    description: 'Show help',
    chinese: '显示帮助',
  },
} as const;

export function runnerHelp(env: NodeJS.ProcessEnv): string {
  const english = env.QL_LANG === 'en';
  const command = quietCommand('ql task exec')
    .arguments('[script] [args...]')
    .description(english ? 'QingLong local task runner' : '青龙本机任务执行器');
  addFlags(
    command,
    Object.fromEntries(
      Object.entries(runnerOptions).map(([name, option]) => [
        name,
        {
          ...option,
          description: english ? option.description : option.chinese,
        },
      ]),
    ),
  );
  const notes = english
    ? 'task is shorthand for ql task. Omit the script to list available JS scripts.\nCLI options precede the script; -- passes script arguments through.\nModes: <script> now; <script> conc|desi <variable> [account-ranges...].\nRemote task actions require the separate @qinglong/cli npm entry. Use task exec for scripts with reserved API action names.'
    : 'task 是 ql task 的简写。不指定脚本时列出可用 JS 脚本。\nCLI 选项放在脚本之前；-- 后的参数原样传给脚本。\n模式：<script> now；<script> conc|desi <variable> [account-ranges...]。\n远程任务操作使用独立的 @qinglong/cli npm 入口；同名脚本使用 task exec。';
  return (
    command
      .helpInformation()
      .replace(/^Usage:/m, english ? 'Usage:' : '用法：')
      .replace(/^Options:/m, english ? 'Options:' : '选项：') +
    '\n' +
    notes +
    '\n'
  );
}
