#!/usr/bin/env node

import {
  runProductionClusterControlProcess,
  type ClusterControlProcessEvent,
  type ClusterControlProcessSignal,
  type ClusterControlProcessSignalSource,
} from './production-process/processApplication';

const USAGE = 'Usage: ql3-cluster-control';

const nodeSignals: ClusterControlProcessSignalSource = Object.freeze({
  subscribe(
    listener: (signal: ClusterControlProcessSignal) => void,
  ) {
    const handlers: Readonly<
      Record<ClusterControlProcessSignal, () => void>
    > = Object.freeze({
      SIGINT: () => listener('SIGINT'),
      SIGTERM: () => listener('SIGTERM'),
    });
    process.once('SIGINT', handlers.SIGINT);
    process.once('SIGTERM', handlers.SIGTERM);
    return () => {
      process.off('SIGINT', handlers.SIGINT);
      process.off('SIGTERM', handlers.SIGTERM);
    };
  },
});

function emit(record: ClusterControlProcessEvent): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function failureFact(error: unknown): Readonly<Record<string, unknown>> {
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
  };
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-cluster-control',
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

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (argv.length !== 0) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_CLUSTER_CONTROL_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const stopResult = await runProductionClusterControlProcess({
      environment: process.env,
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
