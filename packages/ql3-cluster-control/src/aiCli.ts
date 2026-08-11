#!/usr/bin/env node

import type { ModelGatewayProfileAudit } from '@qinglong/ai/profile';

import {
  loadProductionClusterAiConfig,
  startProductionClusterAiControlApplication,
} from './application-runtime/aiProductionApplication';
import {
  runProductionClusterControlProcess,
  type ClusterControlProcessEvent,
  type ClusterControlProcessSignal,
  type ClusterControlProcessSignalSource,
} from './production-process/processApplication';

const USAGE = 'Usage: ql3-cluster-control-ai';

const nodeSignals: ClusterControlProcessSignalSource = Object.freeze({
  subscribe(listener: (signal: ClusterControlProcessSignal) => void) {
    const handlers = Object.freeze({
      SIGINT: () => listener('SIGINT' as const),
      SIGTERM: () => listener('SIGTERM' as const),
    });
    process.once('SIGINT', handlers.SIGINT);
    process.once('SIGTERM', handlers.SIGTERM);
    return () => {
      process.off('SIGINT', handlers.SIGINT);
      process.off('SIGTERM', handlers.SIGTERM);
    };
  },
});

function write(record: object): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function emit(record: ClusterControlProcessEvent): void {
  write(record);
}

function audit(record: Readonly<ModelGatewayProfileAudit>): void {
  write(
    Object.freeze({
      schemaVersion: 1,
      component: 'qinglong3-cluster-ai',
      level: record.state === 'failed' ? 'error' : 'info',
      event: 'activation',
      profile: record.profile,
      state: record.state,
      ...(record.maxConcurrent === undefined
        ? {}
        : { maxConcurrent: record.maxConcurrent }),
      ...(record.recoveryLimit === undefined
        ? {}
        : { recoveryLimit: record.recoveryLimit }),
      ...(record.recovered === undefined
        ? {}
        : { recovered: record.recovered }),
      ...(record.alreadyCompleted === undefined
        ? {}
        : { alreadyCompleted: record.alreadyCompleted }),
    }),
  );
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (argv.length !== 0) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_CLUSTER_AI_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const ai = loadProductionClusterAiConfig(process.env);
    const stopResult = await runProductionClusterControlProcess({
      environment: process.env,
      signals: nodeSignals,
      emit,
      start: (control) =>
        startProductionClusterAiControlApplication({ control, ai, audit }),
    });
    if (stopResult !== 'stopped') process.exitCode = 1;
  } catch (error) {
    const candidate = error as { readonly name?: unknown; readonly code?: unknown };
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-cluster-ai',
        level: 'error',
        event: 'process_failed',
        name:
          typeof candidate?.name === 'string' ? candidate.name : 'Error',
        ...(typeof candidate?.code === 'string'
          ? { code: candidate.code }
          : {}),
      })}\n`,
    );
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
