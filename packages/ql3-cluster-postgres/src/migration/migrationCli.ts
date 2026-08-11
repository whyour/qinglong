#!/usr/bin/env node

// One-shot migration product entrypoint owned by the migration domain.
import { runPostgresMigrationProcess } from './migrationProcess';

const USAGE = 'Usage: ql3-cluster-migrate';

function failureFact(error: unknown): Readonly<Record<string, unknown>> {
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
  };
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-cluster-migration',
    event: 'migration_failed',
    name:
      typeof candidate?.name === 'string' && candidate.name.length <= 128
        ? candidate.name
        : 'Error',
    ...(typeof candidate?.code === 'string' && candidate.code.length <= 128
      ? { code: candidate.code }
      : {}),
  });
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (argv.length !== 0) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_CLUSTER_MIGRATION_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    await runPostgresMigrationProcess({
      environment: process.env,
      emit(record) {
        process.stdout.write(`${JSON.stringify(record)}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failureFact(error))}\n`);
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
