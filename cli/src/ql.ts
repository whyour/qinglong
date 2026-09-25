#!/usr/bin/env node
import { main } from './main';
import { routeCommands } from './framework/router';
import { commands, helpFor } from './framework/registry';
import { standaloneHelp } from './i18n/standalone';

const remoteTaskActions = new Set(commands.filter(command => !command.local && command.name.startsWith('task ')).map(command => command.name.slice(5)));
const operatorActions = new Set(
  commands.filter(command => command.local).map(command => command.name.slice(6)),
);

// Normalize only the leading legacy positional token. Values belonging to
// named options and arguments after -- must never be reinterpreted.
export function operatorArguments(args: string[]): string[] {
  const [action, value, ...rest] = args;
  if (action === 'update' && (value === 'true' || value === 'false'))
    return [action, ...(value === 'false' ? ['--download-only'] : []), ...rest];
  if (action === 'reload' && ['services', 'system', 'data'].includes(value ?? ''))
    return [action, '--target', value!, ...rest];
  return args;
}

function splitPrefix(args: string[]): { prefix: string[]; body: string[] } {
  let offset = 0;
  while (args[offset] === '--json') offset++;
  return { prefix: args.slice(0, offset), body: args.slice(offset) };
}

function writeHelp(help: string, json: boolean): number {
  process.stdout.write((json ? JSON.stringify({ code: 200, data: { help } }) : help) + '\n');
  return 0;
}

function groupHelp(group: 'root' | 'task' | 'local'): string {
  const english = process.env.QL_LANG === 'en';
  if (group === 'task')
    return helpFor(undefined, 'task') + '\n\n' + standaloneHelp('runner') + '\n' +
      (english
        ? 'task is shorthand for ql task. API actions are listed above. Use ql task exec <script> for a script with a reserved action name.'
        : 'task 是 ql task 的简写。以上动作名保留为 API 操作；同名脚本使用 ql task exec <script>。');
  if (group === 'local')
    return helpFor(undefined, undefined, 'local') + '\n\n' + standaloneHelp('worker');
  return (english ? 'Usage: ql <command> [options]\n' : '用法：ql <命令> [选项]\n') +
    '\n  auth          ' + (english ? 'Panel authentication' : '面板认证') +
    '\n  task          ' + (english ? 'Panel tasks or local scripts (alias: task)' : '面板任务或本机脚本（简写：task）') +
    '\n  subscription  ' + (english ? 'Panel subscription management' : '面板订阅管理') +
    '\n  update/reload/check/start/rmlog/extra/bot/repair-config' +
    '\n                ' + (english ? 'Local maintenance (use <command> --help)' : '本机运维（使用 <命令> --help 查看选项）') +
    '\n  resetlet/resettfa/resetpwd/resetname' +
    '\n                ' + (english ? 'Local account recovery' : '本机账号恢复') +
    '\n  repo/raw      ' + (english ? 'Local subscription workers' : '本机订阅执行器') +
    '\n\n  ql task run 12\n  ql task exec --root /ql demo.js now\n  task demo.js now\n  ql update --help\n' +
    (english ? '\nUse --help for each group. QL_LANG=en selects English; --json selects JSON output. ql local <command> remains an alias; legacy positional arguments remain supported.'
      : '\n各命令组使用 --help 查看详情；QL_LANG=en 切换英文，--json 输出 JSON。ql local <命令> 保留为兼容写法，旧位置参数继续兼容。');
}

export async function taskMain(args = process.argv.slice(2)): Promise<number> {
  const { prefix, body } = splitPrefix(args);
  if (body.some(arg => ['--help', '-h'].includes(arg)) &&
      body.every(arg => ['--help', '-h', '--json'].includes(arg)))
    return writeHelp(groupHelp('task'), args.includes('--json'));
  const execute = async (scriptArgs: string[]) => {
    const { runnerMain } = await import('./runner');
    return runnerMain([...prefix, ...scriptArgs]);
  };
  return routeCommands('task', body, {
    ...Object.fromEntries([...remoteTaskActions].map(action => [
      action, (rest: string[]) => main([...prefix, 'task', action, ...rest]),
    ])),
    exec: execute,
  }, () => execute(body));
}

export async function qlMain(args = process.argv.slice(2)): Promise<number> {
  const { prefix, body } = splitPrefix(args);
  const [group, ...rest] = body;
  if (!group || body.every(arg => ['help', '--help', '-h', '--json'].includes(arg)))
    return writeHelp(groupHelp('root'), args.includes('--json'));
  const local = async (localArgs: string[]): Promise<number> => {
    if (!localArgs.length || localArgs.every(arg => ['--help', '-h', '--json'].includes(arg)))
      return writeHelp(groupHelp('local'), args.includes('--json'));
    if (localArgs[0] === 'repo' || localArgs[0] === 'raw') {
      if (localArgs.slice(1).some(arg => arg === '--help' || arg === '-h') &&
          localArgs.slice(1).every(arg => ['--help', '-h', '--json'].includes(arg)))
        return writeHelp(standaloneHelp('worker'), args.includes('--json'));
      const { subscriptionWorker } = await import('./subscription-worker');
      return subscriptionWorker(localArgs);
    }
    const { withCommandCancellation, cancellableOperation, interruptedCode } =
      await import('./local/cancellation');
    return withCommandCancellation(async signal => {
      try {
        return await cancellableOperation(signal, () => main([...prefix, 'local', ...operatorArguments(localArgs)], 'local', signal));
      } catch (error) {
        const code = interruptedCode(signal);
        if (code !== undefined) return code;
        throw error;
      }
    });
  };
  // The legacy -l prefix predates option-based command routing.
  if (!prefix.length && group === '-l') {
    const { compatibilityMain } = await import('./compat');
    return compatibilityMain(body);
  }
  return routeCommands('ql', body, {
    task: rest => taskMain([...prefix, ...rest]),
    local,
    ...Object.fromEntries([...operatorActions, 'repo', 'raw'].map(action => [
      action, (rest: string[]) => local([action, ...rest]),
    ])),
    ...Object.fromEntries(['auth', 'subscription', 'login'].map(action => [
      action, (rest: string[]) => main([...prefix, action, ...rest]),
    ])),
  }, () => main(args));
}

if (require.main === module)
  void qlMain().then(code => { process.exitCode = code; });
