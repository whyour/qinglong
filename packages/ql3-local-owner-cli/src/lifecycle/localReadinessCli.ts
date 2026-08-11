#!/usr/bin/env node

// Keep the readiness binary beside its lifecycle inspection.
import {
  inspectLocalReadiness,
  parseLocalReadinessArguments,
} from './localReadiness';

const USAGE =
  'Usage: ql3-local-readiness --database=/absolute/qinglong3.sqlite --profile=<edge|standalone> [--busy-timeout-ms=5000]';

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    process.stdout.write(
      `${JSON.stringify(
        await inspectLocalReadiness(parseLocalReadinessArguments(argv)),
      )}\n`,
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
            : 'QL3_LOCAL_READINESS_FAILED',
        name: typeof candidate.name === 'string' ? candidate.name : 'Error',
      })}\n`,
    );
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
