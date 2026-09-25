#!/usr/bin/env node
import { main } from './main';
import { routeCommands } from './framework/router';
import { commands } from './framework/registry';
import { helpText } from './i18n/help';
import { quietCommand } from './framework/options';
import { standaloneHelp } from './i18n/standalone';

const remoteTaskActions = new Set(
  commands
    .filter((command) => !command.local && command.name.startsWith('task '))
    .map((command) => command.name.slice(5)),
);
const operatorActions = new Set(
  commands
    .filter((command) => command.local)
    .map((command) => command.name.slice(6)),
);

// Normalize only the leading legacy positional token. Values belonging to
// named options and arguments after -- must never be reinterpreted.
export function operatorArguments(args: string[]): string[] {
  const [action, value, ...rest] = args;
  if (action === 'update' && (value === 'true' || value === 'false'))
    return [action, ...(value === 'false' ? ['--download-only'] : []), ...rest];
  if (
    action === 'reload' &&
    ['services', 'system', 'data'].includes(value ?? '')
  )
    return [action, '--target', value!, ...rest];
  return args;
}

function splitPrefix(args: string[]): { prefix: string[]; body: string[] } {
  let offset = 0;
  while (args[offset] === '--json') offset++;
  return { prefix: args.slice(0, offset), body: args.slice(offset) };
}

function writeHelp(help: string, json: boolean): number {
  process.stdout.write(
    (json ? JSON.stringify({ code: 200, data: { help } }) : help) + '\n',
  );
  return 0;
}

function groupHelp(group: 'root' | 'task' | 'local'): string {
  const english = process.env.QL_LANG === 'en';
  if (group === 'task') return standaloneHelp('runner');
  const program = quietCommand(group === 'local' ? 'ql local' : 'ql');
  program.description(
    english ? 'QingLong panel-internal tools' : '青龙面板内部工具',
  );
  // Operator help and routing both derive from the command registry.
  for (const spec of commands.filter((command) => command.local)) {
    const child = quietCommand(spec.name.slice(6));
    child.description(helpText(spec.summary));
    if (spec.arguments) child.arguments(spec.arguments);
    program.addCommand(child);
  }
  for (const [name, description] of [
    ...(group === 'root'
      ? [
          [
            'task',
            english
              ? 'Execute local scripts (alias: task)'
              : '执行本机脚本（简写：task）',
          ],
        ]
      : []),
    ['repo', english ? 'Synchronize a repository locally' : '本机仓库同步'],
    ['raw', english ? 'Download a script locally' : '本机脚本下载'],
  ])
    program.addCommand(quietCommand(name!).description(description!));
  program
    .option('--json', english ? 'JSON output' : 'JSON 输出')
    .option('-h, --help', english ? 'Show help' : '显示帮助');
  return (
    program
      .helpInformation()
      .replace(/^Usage:/m, english ? 'Usage:' : '用法：')
      .replace(/^Options:/m, english ? 'Options:' : '选项：')
      .replace(/^Commands:/m, english ? 'Commands:' : '命令：') +
    (english
      ? '\nLocal tools only. Remote management uses the separate @qinglong/cli npm entry. ql local remains a maintenance alias.\n'
      : '\n仅操作本机；远程管理使用独立的 @qinglong/cli npm 入口。ql local 保留为运维兼容别名。\n')
  );
}

function internalOnly(args: string[]): number {
  const message =
    process.env.QL_LANG === 'en'
      ? 'Unknown or remote command. This entry only operates the local panel; use the separate @qinglong/cli entry for remote management. Use task exec for scripts named like API actions.'
      : '未知命令或远程命令。此入口仅操作本机面板；远程管理请使用独立的 @qinglong/cli 入口。同名脚本请使用 task exec。';
  process.stderr.write(
    (args.includes('--json') ? JSON.stringify({ code: 2, message }) : message) +
      '\n',
  );
  return 2;
}

export async function taskMain(args = process.argv.slice(2)): Promise<number> {
  const { prefix, body } = splitPrefix(args);
  if (
    body.some((arg) => ['--help', '-h'].includes(arg)) &&
    body.every((arg) => ['--help', '-h', '--json'].includes(arg))
  )
    return writeHelp(groupHelp('task'), args.includes('--json'));
  const execute = async (scriptArgs: string[]) => {
    const { runnerMain } = await import('./runner');
    return runnerMain([...prefix, ...scriptArgs]);
  };
  return routeCommands(
    'task',
    body,
    {
      ...Object.fromEntries(
        [...remoteTaskActions].map((action) => [
          action,
          async () => internalOnly(args),
        ]),
      ),
      exec: execute,
    },
    () => execute(body),
  );
}

export async function qlMain(args = process.argv.slice(2)): Promise<number> {
  const { prefix, body } = splitPrefix(args);
  const [group, ...rest] = body;
  if (
    !group ||
    body.every((arg) => ['help', '--help', '-h', '--json'].includes(arg))
  )
    return writeHelp(groupHelp('root'), args.includes('--json'));
  const local = async (localArgs: string[]): Promise<number> => {
    if (
      !localArgs.length ||
      localArgs.every((arg) => ['--help', '-h', '--json'].includes(arg))
    )
      return writeHelp(groupHelp('local'), args.includes('--json'));
    if (localArgs[0] === 'repo' || localArgs[0] === 'raw') {
      if (
        localArgs.slice(1).some((arg) => arg === '--help' || arg === '-h') &&
        localArgs
          .slice(1)
          .every((arg) => ['--help', '-h', '--json'].includes(arg))
      )
        return writeHelp(standaloneHelp('worker'), args.includes('--json'));
      const { subscriptionWorker } = await import('./subscription-worker');
      return subscriptionWorker(localArgs);
    }
    const { withCommandCancellation, cancellableOperation, interruptedCode } =
      await import('./local/cancellation');
    return withCommandCancellation(async (signal) => {
      try {
        return await cancellableOperation(signal, () =>
          main(
            [...prefix, 'local', ...operatorArguments(localArgs)],
            'local',
            signal,
          ),
        );
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
  return routeCommands(
    'ql',
    body,
    {
      task: (rest) => taskMain([...prefix, ...rest]),
      local,
      ...Object.fromEntries(
        [...operatorActions, 'repo', 'raw'].map((action) => [
          action,
          (rest: string[]) => local([action, ...rest]),
        ]),
      ),
    },
    async () => internalOnly(args),
  );
}

if (require.main === module)
  void qlMain().then((code) => {
    process.exitCode = code;
  });
