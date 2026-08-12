#!/usr/bin/env node

const USAGE = [
  'Usage: ql3-run retry --command-file /absolute/private-command.json',
  '       ql3-run stop --command-file /absolute/private-command.json',
].join('\n');

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const operation = argv[0];
  const commandFilePath = argv[2];
  if (
    argv.length !== 3 ||
    (operation !== 'retry' && operation !== 'stop') ||
    argv[1] !== '--command-file' ||
    commandFilePath === undefined
  ) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'LOCAL_RUN_MANAGEMENT_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const result =
      operation === 'retry'
        ? await import('./runRetryCommand.js').then(
            ({ runLocalRunRetryCommandFile }) =>
              runLocalRunRetryCommandFile(commandFilePath),
          )
        : await import('./runStopCommand.js').then(
            ({ runLocalRunStopCommandFile }) =>
              runLocalRunStopCommandFile(commandFilePath),
          );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const candidate = error as {
      readonly code?: unknown;
      readonly name?: unknown;
      readonly message?: unknown;
      readonly retryAfterMs?: unknown;
    };
    process.stderr.write(
      `${JSON.stringify({
        code:
          typeof candidate.code === 'string'
            ? candidate.code
            : 'LOCAL_RUN_MANAGEMENT_CLI_FAILED',
        name: typeof candidate.name === 'string' ? candidate.name : 'Error',
        message:
          typeof candidate.message === 'string'
            ? candidate.message
            : 'Local Run management command failed',
        ...(Number.isSafeInteger(candidate.retryAfterMs)
          ? { retryAfterMs: candidate.retryAfterMs }
          : {}),
      })}\n`,
    );
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
