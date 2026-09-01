#!/usr/bin/env node

import type {
  LocalApplicationProcessSignal,
  LocalApplicationProcessSignalSource,
} from '@qinglong/local-application/process';

import {
  localApiCliFailureFact,
  parseLocalApiCliCommand,
} from './production-process/cliCommand';
import { runProductionLocalApiCutoverProbe } from './production-process/cutoverProbeProcess';
import { runProductionLocalApiProcess } from './production-process/processApplication';

const USAGE =
  'Usage: ql3-local-api [--cutover-probe] --config /absolute/private-config.json';

const nodeSignals: LocalApplicationProcessSignalSource = Object.freeze({
  subscribe(
    listener: (signal: LocalApplicationProcessSignal) => void,
  ): () => void {
    const handlers = Object.freeze({
      SIGINT: () => listener('SIGINT' as const),
      SIGTERM: () => listener('SIGTERM' as const),
    });
    process.on('SIGINT', handlers.SIGINT);
    process.on('SIGTERM', handlers.SIGTERM);
    return () => {
      process.off('SIGINT', handlers.SIGINT);
      process.off('SIGTERM', handlers.SIGTERM);
    };
  },
});

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const command = parseLocalApiCliCommand(argv);
  if (command === null) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_LOCAL_API_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const options = {
      configFilePath: command.configFilePath,
      signals: nodeSignals,
      emit(event: Readonly<Record<string, unknown>>) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      },
    };
    const stopResult =
      command.mode === 'cutover_probe'
        ? await runProductionLocalApiCutoverProbe(options)
        : await runProductionLocalApiProcess(options);
    if (stopResult !== 'stopped') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify(localApiCliFailureFact(error))}\n`);
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
