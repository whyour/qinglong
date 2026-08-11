#!/usr/bin/env node

// Keep the one-shot setup binary beside its lifecycle command.
import { executeLocalSetupCommandFile } from './localSetup';

const USAGE =
  'Usage: ql3-local-setup run --command-file /absolute/private-command.json';

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (argv.length !== 3 || argv[0] !== 'run' || argv[1] !== '--command-file') {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_LOCAL_SETUP_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    process.stdout.write(
      `${JSON.stringify(await executeLocalSetupCommandFile(argv[2]!))}\n`,
    );
  } catch (error) {
    const candidate = error as {
      readonly code?: unknown;
      readonly name?: unknown;
    };
    process.stderr.write(
      `${JSON.stringify({
        code:
          typeof candidate.code === 'string'
            ? candidate.code
            : 'QL3_LOCAL_SETUP_FAILED',
        name: typeof candidate.name === 'string' ? candidate.name : 'Error',
      })}\n`,
    );
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
