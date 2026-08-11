#!/usr/bin/env node
// Cluster Plugin Package executor boundary; keep the operational CLI explicit.

import { runClusterPluginPackageExecutorProcess } from './pluginPackageExecutorProcess';

const USAGE = 'Usage: ql3-plugin-package-execute';

function emit(value: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function run(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (argv.length !== 0) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_PLUGIN_PACKAGE_EXECUTOR_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const result = await runClusterPluginPackageExecutorProcess({
      environment: process.env,
    });
    if (result.status === 'disabled') {
      emit({
        schemaVersion: 1,
        component: 'qinglong3-plugin-package-executor',
        event: 'executor_disabled',
      });
      return;
    }
    emit({
      schemaVersion: 1,
      component: 'qinglong3-plugin-package-executor',
      event: 'executor_completed',
      databaseContractVersion: result.database.contractVersion,
      databaseMigrationCount: result.database.migrationIds.length,
      batches: result.batches,
    });
  } catch (error) {
    const candidate = error as {
      readonly name?: unknown;
      readonly code?: unknown;
    };
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-plugin-package-executor',
        event: 'executor_failed',
        name:
          typeof candidate?.name === 'string'
            ? candidate.name.slice(0, 128)
            : 'Error',
        ...(typeof candidate?.code === 'string'
          ? { code: candidate.code.slice(0, 128) }
          : {}),
      })}\n`,
    );
    process.exitCode = 1;
  }
}

void run(process.argv.slice(2));
