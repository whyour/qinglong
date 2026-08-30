#!/usr/bin/env node

import {
  runProductionLocalApplicationProcess,
  type LocalApplicationProcessEvent,
  type LocalApplicationProcessSignal,
  type LocalApplicationProcessSignalSource,
} from './production-process/processApplication';
import { runProductionLocalApplicationCutoverProbe } from './production-process/cutoverProbeProcess';
import {
  localApplicationCliFailureFact,
  parseLocalApplicationCliCommand,
} from './production-process/cliCommand';

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

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const command = parseLocalApplicationCliCommand(argv);
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
    process.stderr.write(
      `${JSON.stringify(localApplicationCliFailureFact(error))}\n`,
    );
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
