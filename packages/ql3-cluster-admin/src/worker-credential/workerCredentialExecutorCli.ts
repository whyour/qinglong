#!/usr/bin/env node

/** One-shot Worker credential executor CLI boundary. */
import { runClusterWorkerCredentialExecutorProcess } from './workerCredentialExecutorProcess';

const USAGE = 'Usage: ql3-worker-credential-execute';

function failureFact(error: unknown): Readonly<Record<string, unknown>> {
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-worker-credential-executor',
    event: 'execution_failed',
    name:
      typeof candidate?.name === 'string' && candidate.name.length <= 128
        ? candidate.name
        : 'Error',
    ...(typeof candidate?.code === 'string' && candidate.code.length <= 128
      ? { code: candidate.code }
      : {}),
  });
}

async function run(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (argv.length !== 0) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_WORKER_CREDENTIAL_EXECUTOR_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const result = await runClusterWorkerCredentialExecutorProcess({
      environment: process.env,
    });
    process.stdout.write(
      `${JSON.stringify(
        result.status === 'disabled'
          ? {
              schemaVersion: 1,
              component: 'qinglong3-worker-credential-executor',
              event: 'execution_disabled',
            }
          : {
              schemaVersion: 1,
              component: 'qinglong3-worker-credential-executor',
              event: 'execution_completed',
              actionRef: result.command.actionRef,
              dispatchId: result.command.dispatchId,
              executionStatus: result.run.execution.status,
              deliveryStatus: result.run.result.status,
              tokenRequestUsed: result.run.tokenRequest !== null,
            },
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failureFact(error))}\n`);
    process.exitCode = 1;
  }
}

void run(process.argv.slice(2));
