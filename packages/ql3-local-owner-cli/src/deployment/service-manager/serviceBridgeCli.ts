#!/usr/bin/env node

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { runLocalServiceBridge } from './serviceBridge';
import { runLocalServiceManagerLegacyRollbackBridge } from './legacy-rollback/bridge';

const USAGE =
  'Usage: ql3-service-bridge run --command-file /absolute/root-owned-command.json';

function main(argv: readonly string[]): void {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (argv.length !== 3 || argv[0] !== 'run' || argv[1] !== '--command-file') {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_SERVICE_BRIDGE_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const command = readPrivateLocalCommandFile(argv[2]!);
    const operation =
      command && typeof command === 'object' && !Array.isArray(command)
        ? (command as Record<string, unknown>).operation
        : undefined;
    const result =
      operation === 'local.deployment.service-manager.legacy-rollback.execute'
        ? runLocalServiceManagerLegacyRollbackBridge(command)
        : runLocalServiceBridge(command);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.state === 'manual_required') process.exitCode = 2;
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
            : 'QL3_SERVICE_BRIDGE_FAILED',
        name: typeof candidate.name === 'string' ? candidate.name : 'Error',
      })}\n`,
    );
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
