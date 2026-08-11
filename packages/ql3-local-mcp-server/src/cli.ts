#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { openProductionLocalMcpServer } from './production-process/processApplication';

const USAGE = 'Usage: ql3-mcp --config /absolute/private-config.json';

function configFileArgument(argv: readonly string[]): string | null {
  if (argv.length !== 2 || argv[0] !== '--config' || !argv[1]) return null;
  return argv[1];
}

function failureFact(error: unknown): Readonly<Record<string, unknown>> {
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-local-mcp',
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
  const configFilePath = configFileArgument(argv);
  if (configFilePath === null) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'LOCAL_MCP_SERVER_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }

  let active: Awaited<ReturnType<typeof openProductionLocalMcpServer>> | undefined;
  let handle: ReturnType<typeof serveStdio> | undefined;
  let stopPromise: Promise<void> | undefined;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (handle) await handle.close();
      if (active) await active.close();
    })();
    return stopPromise;
  };

  try {
    active = await openProductionLocalMcpServer({ configFilePath });
    handle = serveStdio(() => active!.createServer(), {
      onerror: () => {
        process.stderr.write(
          `${JSON.stringify({
            schemaVersion: 1,
            component: 'qinglong3-local-mcp',
            level: 'error',
            event: 'transport_error',
          })}\n`,
        );
      },
      maxSubscriptions: 1,
    });
    const shutdown = () => {
      void stop().catch((error) => {
        process.stderr.write(`${JSON.stringify(failureFact(error))}\n`);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.stdin.once('end', shutdown);
  } catch (error) {
    try {
      await stop();
    } catch {
      // Preserve the startup failure.
    }
    process.stderr.write(`${JSON.stringify(failureFact(error))}\n`);
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
