#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { probeClusterCopilotClientReadiness } from '../copilot-client/client';
import { readClusterCopilotMcpServerConfig } from './config';
import { createQingLongClusterCopilotMcpServer } from './server';

const USAGE = [
  'Usage: ql3-copilot-mcp --config /absolute/private-config.json [--concurrency-ceiling=1..16]',
  '       ql3-copilot-mcp --check --config /absolute/private-config.json [--concurrency-ceiling=1..16]',
].join('\n');

interface ClusterCopilotMcpCliArguments {
  readonly check: boolean;
  readonly configFile: string;
  readonly concurrencyCeiling: number;
}

function configArgument(
  argv: readonly string[],
): Readonly<ClusterCopilotMcpCliArguments> | null {
  const check = argv[0] === '--check';
  const offset = check ? 1 : 0;
  if (
    (argv.length !== offset + 2 && argv.length !== offset + 3) ||
    argv[offset] !== '--config' ||
    !argv[offset + 1]
  ) {
    return null;
  }
  let concurrencyCeiling = 16;
  if (argv.length === offset + 3) {
    const match = /^--concurrency-ceiling=([1-9]|1[0-6])$/u.exec(
      argv[offset + 2] ?? '',
    );
    if (!match) return null;
    concurrencyCeiling = Number(match[1]);
  }
  return Object.freeze({
    check,
    configFile: argv[offset + 1]!,
    concurrencyCeiling,
  });
}

function fact(event: 'process_failed' | 'transport_error'): string {
  return JSON.stringify({
    schemaVersion: 1,
    component: 'qinglong3-cluster-copilot-mcp',
    level: 'error',
    event,
  });
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const command = configArgument(argv);
  if (command === null) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_CLUSTER_COPILOT_MCP_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }

  let handle: ReturnType<typeof serveStdio> | undefined;
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= handle?.close() ?? Promise.resolve();
    return stopPromise;
  };

  try {
    const config = readClusterCopilotMcpServerConfig(command.configFile);
    if (config.maxConcurrentRequests > command.concurrencyCeiling) {
      throw new TypeError('Cluster Copilot MCP concurrency ceiling exceeded');
    }
    if (command.check) {
      const readiness = await probeClusterCopilotClientReadiness(
        config.clientConfigFile,
      );
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          component: 'qinglong3-cluster-copilot-mcp',
          event: 'preflight_checked',
          transport: readiness.transport,
          ready: readiness.ready,
          configuration: 'valid',
          credential: 'valid',
          maxConcurrentRequests: config.maxConcurrentRequests,
          concurrencyCeiling: command.concurrencyCeiling,
          requestMethod: 'GET',
          requestPath: '/readyz',
          mutation: false,
        })}\n`,
      );
      if (!readiness.ready) process.exitCode = 69;
      return;
    }
    handle = serveStdio(
      () => createQingLongClusterCopilotMcpServer({ config }),
      {
        maxSubscriptions: 1,
        onerror: () => process.stderr.write(`${fact('transport_error')}\n`),
      },
    );
    const shutdown = () => {
      void stop().catch(() => {
        process.stderr.write(`${fact('process_failed')}\n`);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.stdin.once('end', shutdown);
  } catch {
    try {
      await stop();
    } catch {
      // Preserve the startup failure.
    }
    process.stderr.write(`${fact('process_failed')}\n`);
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
