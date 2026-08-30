#!/usr/bin/env node

import {
  runProductionLocalApplicationProcess,
  type LocalApplicationProcessEvent,
  type LocalApplicationProcessSignal,
  type LocalApplicationProcessSignalSource,
} from './production-process/processApplication';
import { runProductionLocalApplicationCutoverProbe } from './production-process/cutoverProbeProcess';

const USAGE =
  'Usage: ql3-local-application [--cutover-probe] --config /absolute/private-config.json';

const nodeSignals: LocalApplicationProcessSignalSource = Object.freeze({
  subscribe(
    listener: (signal: LocalApplicationProcessSignal) => void,
  ): () => void {
    const handlers: Readonly<
      Record<LocalApplicationProcessSignal, () => void>
    > = Object.freeze({
      SIGINT: () => listener('SIGINT'),
      SIGTERM: () => listener('SIGTERM'),
    });
    process.on('SIGINT', handlers.SIGINT);
    process.on('SIGTERM', handlers.SIGTERM);
    return () => {
      process.off('SIGINT', handlers.SIGINT);
      process.off('SIGTERM', handlers.SIGTERM);
    };
  },
});

function emit(record: Readonly<LocalApplicationProcessEvent>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function failureFact(error: unknown): Readonly<Record<string, unknown>> {
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
  };
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-local-application',
    level: 'error',
    event: 'process_failed',
    name:
      typeof candidate?.name === 'string' && candidate.name.length <= 128
        ? candidate.name
        : 'Error',
    ...(typeof candidate?.code === 'string' && candidate.code.length <= 128
      ? { code: candidate.code }
      : {}),
  });
}

function configFileArgument(argv: readonly string[]): Readonly<{
  configFilePath: string;
  mode: 'application' | 'cutover_probe';
}> | null {
  if (argv.length === 2 && argv[0] === '--config' && argv[1]) {
    return Object.freeze({
      configFilePath: argv[1],
      mode: 'application' as const,
    });
  }
  if (
    argv.length === 3 &&
    argv[0] === '--cutover-probe' &&
    argv[1] === '--config' &&
    argv[2]
  ) {
    return Object.freeze({
      configFilePath: argv[2],
      mode: 'cutover_probe' as const,
    });
  }
  return null;
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const command = configFileArgument(argv);
  if (command === null) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_LOCAL_APPLICATION_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const stopResult =
      command.mode === 'cutover_probe'
        ? await runProductionLocalApplicationCutoverProbe({
            configFilePath: command.configFilePath,
            signals: nodeSignals,
            emit,
          })
        : await runProductionLocalApplicationProcess({
            configFilePath: command.configFilePath,
            signals: nodeSignals,
            emit,
          });
    if (stopResult !== 'stopped') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failureFact(error))}\n`);
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
