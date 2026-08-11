#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { runModelProviderCredentialTestExecutorProcess } from './modelProviderCredentialTestExecutorProcess';

const USAGE = 'Usage: ql3-provider-credential-test-execute';
const TERMINATION_MESSAGE_FILE = '/dev/termination-log';

function writeFact(
  value: Readonly<Record<string, unknown>>,
  stream: NodeJS.WriteStream,
): void {
  const serialized = JSON.stringify(value);
  stream.write(`${serialized}\n`);
  if (
    process.env.QL3_MODEL_PROVIDER_CREDENTIAL_TEST_WRITE_TERMINATION_MESSAGE ===
    'true'
  ) {
    writeFileSync(TERMINATION_MESSAGE_FILE, serialized, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

function failureFact(error: unknown): Readonly<Record<string, unknown>> {
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
  };
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-model-provider-credential-test-executor',
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
        code: 'QL3_MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTOR_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const result = await runModelProviderCredentialTestExecutorProcess({
      environment: process.env,
    });
    writeFact(
      result.status === 'disabled'
        ? {
            schemaVersion: 1,
            component: 'qinglong3-model-provider-credential-test-executor',
            event: 'execution_disabled',
          }
        : {
            schemaVersion: 1,
            component: 'qinglong3-model-provider-credential-test-executor',
            event:
              result.test.status === 'outcome_unknown'
                ? 'execution_outcome_unknown'
                : 'execution_completed',
            testId: result.test.plan.testId,
            executionId: result.test.execution.executionId,
            status: result.test.status,
            ...(result.test.result === null
              ? {}
              : {
                  outcome: result.test.result.outcome,
                  modelCount: result.test.result.modelCount,
                  durationMs: result.test.result.durationMs,
                  ...(result.transportFailureCode === undefined
                    ? {}
                    : {
                        transportFailureCode: result.transportFailureCode,
                        transportRequestDigest: result.transportRequestDigest,
                        ...(result.transportAddressSha256 === undefined
                          ? {}
                          : {
                              transportAddressSha256:
                                result.transportAddressSha256,
                              transportPort: result.transportPort,
                            }),
                      }),
                }),
          },
      process.stdout,
    );
  } catch (error) {
    writeFact(failureFact(error), process.stderr);
    process.exitCode = 1;
  }
}

void run(process.argv.slice(2));
