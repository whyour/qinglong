#!/usr/bin/env node

// Worker Process owns the OS signal and diagnostic stream CLI adapter.
import {
  runProductionWorkerProcess,
  type WorkerProcessSignal,
  type WorkerProcessSignalSource,
} from './workerProcessApplication';

function signalSource(): WorkerProcessSignalSource {
  return Object.freeze({
    subscribe(listener: (signal: WorkerProcessSignal) => void): () => void {
      const onInterrupt = () => listener('SIGINT');
      const onTerminate = () => listener('SIGTERM');
      process.once('SIGINT', onInterrupt);
      process.once('SIGTERM', onTerminate);
      return () => {
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onTerminate);
      };
    },
  });
}

async function main(): Promise<void> {
  await runProductionWorkerProcess({
    environment: process.env,
    signals: signalSource(),
    emit(event) {
      const output = `${JSON.stringify(event)}\n`;
      if (event.level === 'error') process.stderr.write(output);
      else process.stdout.write(output);
    },
  });
}

void main().catch((error: unknown) => {
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
  };
  process.stderr.write(
    `${JSON.stringify({
      schemaVersion: 1,
      component: 'qinglong3-worker',
      level: 'error',
      event: 'process_failed',
      name:
        typeof candidate?.name === 'string'
          ? candidate.name.slice(0, 128)
          : 'Error',
      ...(typeof candidate?.code === 'string'
        ? { code: candidate.code.slice(0, 128) }
        : {}),
    })}\n`,
  );
  process.exitCode = 1;
});
