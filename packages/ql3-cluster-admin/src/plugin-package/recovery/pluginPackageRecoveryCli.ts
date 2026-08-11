#!/usr/bin/env node
// Cluster Plugin Package recovery boundary; keep the operational CLI explicit.

import { runClusterPluginPackageRecoveryProcess } from './pluginPackageRecoveryProcess';

const USAGE = 'Usage: ql3-plugin-package-recover';

function failureFact(error: unknown): Readonly<Record<string, unknown>> {
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
  };
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-plugin-package-recovery',
    event: 'recovery_failed',
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
        code: 'QL3_PLUGIN_PACKAGE_RECOVERY_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    await runClusterPluginPackageRecoveryProcess({
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
