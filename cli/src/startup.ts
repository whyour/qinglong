#!/usr/bin/env node
import { standaloneHelp } from './i18n/standalone';
import {
  withCommandCancellation,
  cancellableOperation,
  interruptedCode,
} from './local/cancellation';

// The legacy qinglong command starts the host installation; reload is its only
// positional mode. All remaining validation belongs to the shared registry.
export function startupArguments(args: string[]): string[] {
  return args[0] === 'reload'
    ? ['start', '--reload', ...args.slice(1)]
    : ['start', ...args];
}

export async function startupMain(
  args = process.argv.slice(2),
): Promise<number> {
  if (
    args.length &&
    args.every((arg) => ['--help', '-h', '--json'].includes(arg)) &&
    args.some((arg) => arg === '--help' || arg === '-h')
  ) {
    const help = standaloneHelp('startup');
    process.stdout.write(
      (args.includes('--json')
        ? JSON.stringify({ code: 200, data: { help } })
        : help) + '\n',
    );
    return 0;
  }
  return withCommandCancellation(async (signal) => {
    try {
      const { main } = await import('./main');
      return await cancellableOperation(signal, () =>
        main(startupArguments(args), 'local', signal),
      );
    } catch (error) {
      const code = interruptedCode(signal);
      if (code !== undefined) return code;
      throw error;
    }
  });
}

if (require.main === module)
  void startupMain().then((code) => {
    process.exitCode = code;
  });
