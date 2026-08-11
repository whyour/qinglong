#!/usr/bin/env node

/** One-shot Worker credential management client CLI boundary. */
import { ClusterPluginPackageManagementClientRemoteError } from '../management-support/pluginPackageManagementClient';
import { executeClusterWorkerCredentialManagementClient } from './workerCredentialManagementClient';

const USAGE =
  'Usage: ql3-worker-credential-client --config=/absolute/client.json --command=/absolute/command.json --assertion=/absolute/assertion.jwt';

function parseArguments(
  argv: readonly string[],
): Readonly<{
  configFile: string;
  commandFile: string;
  assertionFile: string;
}> | null {
  if (argv.length !== 3) return null;
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--(config|command|assertion)=(\/.+)$/.exec(argument);
    if (!match || values.has(match[1]!)) return null;
    values.set(match[1]!, match[2]!);
  }
  if (
    !values.has('config') ||
    !values.has('command') ||
    !values.has('assertion')
  ) {
    return null;
  }
  return Object.freeze({
    configFile: values.get('config')!,
    commandFile: values.get('command')!,
    assertionFile: values.get('assertion')!,
  });
}

function failureFact(error: unknown): Readonly<Record<string, unknown>> {
  const candidate = error as { readonly code?: unknown };
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-worker-credential-management-client',
    event: 'command_failed',
    code:
      typeof candidate?.code === 'string' && candidate.code.length <= 128
        ? candidate.code
        : 'QL3_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_FAILED',
    ...(error instanceof ClusterPluginPackageManagementClientRemoteError
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
  const paths = parseArguments(argv);
  if (!paths) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-worker-credential-management-client',
        event: 'usage_invalid',
        code: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_USAGE_INVALID',
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const result = await executeClusterWorkerCredentialManagementClient(paths);
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-worker-credential-management-client',
        event: 'command_completed',
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
