#!/usr/bin/env node

// Keep the one-shot adoption binary beside its lifecycle command.
import { runLocalAdoptionProductCommandFile } from './adoptionCommand';

const USAGE =
  'Usage: ql3-adoption run --command-file /absolute/private-command.json';

function publicErrorCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== 'object') break;
    const candidate = current as { readonly code?: unknown; cause?: unknown };
    if (
      candidate.code === 'LEGACY_CRONTAB_ADOPTION_CLI_AUTHENTICATION_FAILED'
    ) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  const candidate = error as { readonly code?: unknown };
  return typeof candidate?.code === 'string'
    ? candidate.code
    : 'LEGACY_CRONTAB_ADOPTION_CLI_FAILED';
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (argv.length !== 3 || argv[0] !== 'run' || argv[1] !== '--command-file') {
    process.stderr.write(
      `${JSON.stringify({
        code: 'LEGACY_CRONTAB_ADOPTION_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const result = await runLocalAdoptionProductCommandFile(argv[2]!);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const candidate = error as {
      readonly code?: unknown;
      readonly name?: unknown;
      readonly message?: unknown;
    };
    process.stderr.write(
      `${JSON.stringify({
        code: publicErrorCode(error),
        name: typeof candidate.name === 'string' ? candidate.name : 'Error',
        message:
          typeof candidate.message === 'string'
            ? candidate.message
            : 'Legacy Crontab adoption command failed',
      })}\n`,
    );
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
