#!/usr/bin/env node

import {
  executeClusterCopilotCommand,
  probeClusterCopilotClientReadiness,
  validateClusterCopilotClientConfiguration,
  validateClusterCopilotClientCredentialFile,
  type ClusterCopilotClientCommand,
} from '../copilot-client/client';
import { readCanonicalFile } from '../management-support/managementClientConfiguration';
import { loadClusterCopilotConsoleAssets } from './assets';
import {
  clusterCopilotConsoleSessionDigest,
  startClusterCopilotConsoleServer,
} from './server';

const USAGE = [
  'Usage:',
  '  ql3-copilot-console --config /absolute/client.json --credential /absolute/credential --session /absolute/session [--port=0..65535]',
  '  ql3-copilot-console --check --config /absolute/client.json --credential /absolute/credential --session /absolute/session',
  '',
  'The Console binds only 127.0.0.1 and exposes inspect/output reads.',
  'The browser session key remains in a separate owner-private 0600 file.',
].join('\n');

interface ClusterCopilotConsoleCliArguments {
  readonly check: boolean;
  readonly configFile: string;
  readonly credentialFile: string;
  readonly sessionFile: string;
  readonly port: number;
}

const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAXIMUM_SESSION_BYTES = 128;

function usageFailure(): never {
  process.stderr.write(USAGE + '\n');
  process.exit(64);
}

function argumentValue(
  argv: readonly string[],
  index: number,
  name: string,
): Readonly<{ value: string; consumed: number }> | null {
  const current = argv[index];
  if (current === name) {
    const next = argv[index + 1];
    if (typeof next !== 'string' || next === '' || next.startsWith('--')) {
      return usageFailure();
    }
    return Object.freeze({ value: next, consumed: 2 });
  }
  const prefix = name + '=';
  if (current?.startsWith(prefix) && current.length > prefix.length) {
    return Object.freeze({
      value: current.slice(prefix.length),
      consumed: 1,
    });
  }
  return null;
}

export function parseClusterCopilotConsoleCliArguments(
  argv: readonly string[],
): Readonly<ClusterCopilotConsoleCliArguments> {
  let check = false;
  let configFile: string | undefined;
  let credentialFile: string | undefined;
  let sessionFile: string | undefined;
  let port = 0;
  let portSeen = false;
  for (let index = 0; index < argv.length; ) {
    const current = argv[index];
    if (current === '--check' && !check) {
      check = true;
      index += 1;
      continue;
    }
    const config = argumentValue(argv, index, '--config');
    if (config) {
      if (configFile !== undefined) return usageFailure();
      configFile = config.value;
      index += config.consumed;
      continue;
    }
    const credential = argumentValue(argv, index, '--credential');
    if (credential) {
      if (credentialFile !== undefined) return usageFailure();
      credentialFile = credential.value;
      index += credential.consumed;
      continue;
    }
    const session = argumentValue(argv, index, '--session');
    if (session) {
      if (sessionFile !== undefined) return usageFailure();
      sessionFile = session.value;
      index += session.consumed;
      continue;
    }
    const portArgument = argumentValue(argv, index, '--port');
    if (portArgument) {
      if (portSeen || !/^(?:0|[1-9][0-9]{0,4})$/.test(portArgument.value)) {
        return usageFailure();
      }
      portSeen = true;
      port = Number(portArgument.value);
      if (
        !Number.isSafeInteger(port) ||
        (port !== 0 && (port < 1_024 || port > 65_535))
      ) {
        return usageFailure();
      }
      index += portArgument.consumed;
      continue;
    }
    return usageFailure();
  }
  if (
    configFile === undefined ||
    credentialFile === undefined ||
    sessionFile === undefined ||
    (check && port !== 0)
  ) {
    return usageFailure();
  }
  return Object.freeze({
    check,
    configFile,
    credentialFile,
    sessionFile,
    port,
  });
}

function readSessionDigest(sessionFile: string): Buffer {
  let bytes: Buffer | undefined;
  try {
    bytes = readCanonicalFile(
      sessionFile,
      MAXIMUM_SESSION_BYTES,
      'private',
    );
    if (
      bytes.some((byte) => byte > 0x7f) ||
      !SESSION_TOKEN.test(bytes.toString('ascii'))
    ) {
      throw new Error('invalid session token');
    }
    return clusterCopilotConsoleSessionDigest(bytes.toString('ascii'));
  } finally {
    bytes?.fill(0);
  }
}

async function main(): Promise<void> {
  if (
    process.argv.length === 3 &&
    (process.argv[2] === '--help' || process.argv[2] === '-h')
  ) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  const parsed = parseClusterCopilotConsoleCliArguments(process.argv.slice(2));
  const assets = loadClusterCopilotConsoleAssets(__dirname);
  validateClusterCopilotClientConfiguration(parsed.configFile);
  validateClusterCopilotClientCredentialFile(parsed.credentialFile);
  const sessionDigest = readSessionDigest(parsed.sessionFile);
  if (parsed.check) {
    try {
      const readiness = await probeClusterCopilotClientReadiness(
        parsed.configFile,
      );
      process.stdout.write(
        JSON.stringify({
          schemaVersion: 1,
          component: 'qinglong3-cluster-copilot-console',
          event: 'preflight_checked',
          ready: readiness.ready,
          listenAddress: '127.0.0.1',
          browserCredential: 'forbidden',
          clusterCredential: 'server_only',
          operations: ['inspect', 'output'],
          mutation: false,
        }) + '\n',
      );
      if (!readiness.ready) process.exitCode = 69;
      return;
    } finally {
      sessionDigest.fill(0);
    }
  }

  const server = await startClusterCopilotConsoleServer({
    assets,
    executor: Object.freeze({
      execute(command: Readonly<ClusterCopilotClientCommand>) {
        return executeClusterCopilotCommand({
          configFile: parsed.configFile,
          credentialFile: parsed.credentialFile,
          command,
        });
      },
    }),
    port: parsed.port,
    sessionDigest,
  });
  sessionDigest.fill(0);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      component: 'qinglong3-cluster-copilot-console',
      event: 'started',
      origin: server.origin,
      listenAddress: '127.0.0.1',
      browserCredential: 'forbidden',
      clusterCredential: 'server_only',
      operations: ['inspect', 'output'],
      mutation: false,
    }) + '\n',
  );

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void server.close().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

void main().catch(() => {
  process.stderr.write(
    JSON.stringify({
      schemaVersion: 1,
      component: 'qinglong3-cluster-copilot-console',
      event: 'process_failed',
    }) + '\n',
  );
  process.exitCode = 1;
});
