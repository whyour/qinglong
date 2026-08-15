#!/usr/bin/env node

import {
  ClusterCopilotClientRemoteError,
  executeClusterCopilotClient,
} from './client';

const USAGE =
  'Usage: ql3-copilot-client --config=/absolute/client.json --command=/absolute/command.json --credential=/absolute/credential';

function argumentsFrom(argv: readonly string[]): Readonly<{
  configFile: string;
  commandFile: string;
  credentialFile: string;
}> | null {
  if (argv.length !== 3) return null;
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--(config|command|credential)=(\/.+)$/.exec(argument);
    if (!match || values.has(match[1]!)) return null;
    values.set(match[1]!, match[2]!);
  }
  if (
    !values.has('config') ||
    !values.has('command') ||
    !values.has('credential')
  ) {
    return null;
  }
  return Object.freeze({
    configFile: values.get('config')!,
    commandFile: values.get('command')!,
    credentialFile: values.get('credential')!,
  });
}

function failureFact(error: unknown): Readonly<Record<string, unknown>> {
  const candidate = error as { readonly code?: unknown };
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-cluster-copilot-client',
    event: 'command_failed',
    code:
      typeof candidate?.code === 'string'
        ? candidate.code
        : 'QL3_CLUSTER_COPILOT_CLIENT_FAILED',
    ...(error instanceof ClusterCopilotClientRemoteError
      ? {
          statusCode: error.statusCode,
          responseCode: error.responseCode,
          requestId: error.requestId,
          ...(error.retryAfterSeconds === null
            ? {}
            : { retryAfterSeconds: error.retryAfterSeconds }),
        }
      : {}),
  });
}

async function run(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const paths = argumentsFrom(argv);
  if (!paths) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-cluster-copilot-client',
        event: 'usage_invalid',
        code: 'QL3_CLUSTER_COPILOT_CLIENT_USAGE_INVALID',
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const result = await executeClusterCopilotClient(paths);
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-cluster-copilot-client',
        event: 'command_completed',
        operation: result.operation,
        requestId: result.requestId,
        result: result.result,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failureFact(error))}\n`);
    process.exitCode = 1;
  }
}

void run(process.argv.slice(2));
