#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

import {
  executeClusterCopilotCommand,
  executeClusterProjectApiRead,
  probeClusterCopilotClientReadiness,
  validateClusterCopilotClientConfiguration,
  validateClusterCopilotClientCredentialFile,
} from '../copilot-client/client';
import { readCanonicalFile } from '../management-support/managementClientConfiguration';
import {
  executeClusterPluginPackageManagementCommand,
  validateClusterAuthenticatedManagementClientConfiguration,
} from '../management-support/pluginPackageManagementClient';
import {
  createPluginPackageInstallationInspectionCommand,
  createPluginPackageInstallationListCommand,
  projectPluginPackageInstallationInspection,
  projectPluginPackageInstallationList,
} from '../plugin-package/management/pluginPackageInstallationProduct';
import {
  createRunCancellationBlockedListCommand,
  projectRunCancellationBlockedList,
} from '../run-management/runCancellationBlockedList';
import {
  createRunCancellationInspectionCommand,
  projectRunCancellationInspection,
} from '../run-management/runCancellationInspection';
import {
  createRunCancellationStatusCommand,
  projectRunCancellationStatus,
} from '../run-management/runCancellationStatus';
import { executeClusterRunManagementCommand } from '../run-management/runManagementClient';
import { executeClusterWorkerManagementClient } from '../worker-management/workerManagementClient';
import {
  createWorkerSessionInspectionCommand,
  createWorkerSessionListCommand,
  projectWorkerSessionInspection,
  projectWorkerSessionList,
} from '../worker-management/workerManagementProduct';
import { loadClusterCopilotConsoleAssets } from './assets';
import {
  CLUSTER_COPILOT_CONSOLE_READ_OPERATIONS,
  clusterCopilotConsoleClientCommand,
  clusterCopilotConsoleProjectReadPath,
  type ClusterCopilotConsoleReadRequest,
} from './contracts';
import {
  clusterCopilotConsoleSessionDigest,
  startClusterCopilotConsoleServer,
} from './server';

const USAGE = [
  'Usage:',
  '  ql3-copilot-console --config /absolute/client.json --credential /absolute/credential --session /absolute/session [--port=0..65535]',
  '  ql3-copilot-console --check --config /absolute/client.json --credential /absolute/credential --session /absolute/session',
  '  ql3-copilot-console --container-published-loopback --port=1024..65535 --config /absolute/client.json --credential /absolute/credential --session /absolute/session [--check]',
  '  Optional Run reads: --run-management-config /absolute/run-client.json --run-management-assertion /absolute/assertion.jwt',
  '  Optional Worker reads: --worker-management-config /absolute/worker-client.json --worker-management-assertion /absolute/assertion.jwt',
  '  Optional Package reads: --package-management-config /absolute/package-client.json --package-management-assertion /absolute/assertion.jwt',
  '',
  'Native mode binds 127.0.0.1. Container mode requires host-loopback port publication.',
  'The browser session key remains in a separate owner-private 0600 file.',
].join('\n');

interface ClusterCopilotConsoleCliArguments {
  readonly check: boolean;
  readonly configFile: string;
  readonly credentialFile: string;
  readonly networkBoundary: 'host-loopback' | 'container-published-loopback';
  readonly packageManagementAssertionFile?: string;
  readonly packageManagementConfigFile?: string;
  readonly runManagementAssertionFile?: string;
  readonly runManagementConfigFile?: string;
  readonly workerManagementAssertionFile?: string;
  readonly workerManagementConfigFile?: string;
  readonly sessionFile: string;
  readonly port: number;
}

const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MANAGEMENT_ASSERTION = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAXIMUM_SESSION_BYTES = 128;
const MAXIMUM_MANAGEMENT_ASSERTION_BYTES = 16 * 1024;
const RUN_MANAGEMENT_OPERATIONS = new Set([
  'run_cancellation_status',
  'run_cancellation_blocked_list',
  'run_cancellation_inspect',
]);
const WORKER_MANAGEMENT_OPERATIONS = new Set(['worker_list', 'worker_inspect']);
const PACKAGE_MANAGEMENT_OPERATIONS = new Set([
  'package_list',
  'package_inspect',
]);

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
  let runManagementConfigFile: string | undefined;
  let runManagementAssertionFile: string | undefined;
  let workerManagementConfigFile: string | undefined;
  let workerManagementAssertionFile: string | undefined;
  let packageManagementConfigFile: string | undefined;
  let packageManagementAssertionFile: string | undefined;
  let port = 0;
  let portSeen = false;
  let containerPublishedLoopback = false;
  for (let index = 0; index < argv.length; ) {
    const current = argv[index];
    if (current === '--check' && !check) {
      check = true;
      index += 1;
      continue;
    }
    if (
      current === '--container-published-loopback' &&
      !containerPublishedLoopback
    ) {
      containerPublishedLoopback = true;
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
    const runManagementConfig = argumentValue(
      argv,
      index,
      '--run-management-config',
    );
    if (runManagementConfig) {
      if (runManagementConfigFile !== undefined) return usageFailure();
      runManagementConfigFile = runManagementConfig.value;
      index += runManagementConfig.consumed;
      continue;
    }
    const runManagementAssertion = argumentValue(
      argv,
      index,
      '--run-management-assertion',
    );
    if (runManagementAssertion) {
      if (runManagementAssertionFile !== undefined) return usageFailure();
      runManagementAssertionFile = runManagementAssertion.value;
      index += runManagementAssertion.consumed;
      continue;
    }
    const workerManagementConfig = argumentValue(
      argv,
      index,
      '--worker-management-config',
    );
    if (workerManagementConfig) {
      if (workerManagementConfigFile !== undefined) return usageFailure();
      workerManagementConfigFile = workerManagementConfig.value;
      index += workerManagementConfig.consumed;
      continue;
    }
    const workerManagementAssertion = argumentValue(
      argv,
      index,
      '--worker-management-assertion',
    );
    if (workerManagementAssertion) {
      if (workerManagementAssertionFile !== undefined) return usageFailure();
      workerManagementAssertionFile = workerManagementAssertion.value;
      index += workerManagementAssertion.consumed;
      continue;
    }
    const packageManagementConfig = argumentValue(
      argv,
      index,
      '--package-management-config',
    );
    if (packageManagementConfig) {
      if (packageManagementConfigFile !== undefined) return usageFailure();
      packageManagementConfigFile = packageManagementConfig.value;
      index += packageManagementConfig.consumed;
      continue;
    }
    const packageManagementAssertion = argumentValue(
      argv,
      index,
      '--package-management-assertion',
    );
    if (packageManagementAssertion) {
      if (packageManagementAssertionFile !== undefined) return usageFailure();
      packageManagementAssertionFile = packageManagementAssertion.value;
      index += packageManagementAssertion.consumed;
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
    (runManagementConfigFile === undefined) !==
      (runManagementAssertionFile === undefined) ||
    (workerManagementConfigFile === undefined) !==
      (workerManagementAssertionFile === undefined) ||
    (packageManagementConfigFile === undefined) !==
      (packageManagementAssertionFile === undefined) ||
    (containerPublishedLoopback && port === 0) ||
    (!containerPublishedLoopback && check && port !== 0)
  ) {
    return usageFailure();
  }
  return Object.freeze({
    check,
    configFile,
    credentialFile,
    networkBoundary: containerPublishedLoopback
      ? 'container-published-loopback'
      : 'host-loopback',
    ...(runManagementConfigFile !== undefined &&
    runManagementAssertionFile !== undefined
      ? { runManagementConfigFile, runManagementAssertionFile }
      : {}),
    ...(workerManagementConfigFile !== undefined &&
    workerManagementAssertionFile !== undefined
      ? { workerManagementConfigFile, workerManagementAssertionFile }
      : {}),
    ...(packageManagementConfigFile !== undefined &&
    packageManagementAssertionFile !== undefined
      ? { packageManagementConfigFile, packageManagementAssertionFile }
      : {}),
    sessionFile,
    port,
  });
}

function validateManagementAuthority(
  configFile: string | undefined,
  assertionFile: string | undefined,
  kind: 'package' | 'run' | 'worker',
): boolean {
  if (configFile === undefined || assertionFile === undefined) return false;
  validateClusterAuthenticatedManagementClientConfiguration(configFile, kind);
  let bytes: Buffer | undefined;
  try {
    bytes = readCanonicalFile(
      assertionFile,
      MAXIMUM_MANAGEMENT_ASSERTION_BYTES,
      'private',
    );
    if (
      bytes.some((byte) => byte > 0x7f) ||
      !MANAGEMENT_ASSERTION.test(bytes.toString('ascii'))
    ) {
      throw new Error('invalid management assertion');
    }
    return true;
  } finally {
    bytes?.fill(0);
  }
}

function availableOperations(
  runManagementAuthority: boolean,
  workerManagementAuthority: boolean,
  packageManagementAuthority: boolean,
) {
  return CLUSTER_COPILOT_CONSOLE_READ_OPERATIONS.filter(
    (operation) =>
      (runManagementAuthority || !RUN_MANAGEMENT_OPERATIONS.has(operation)) &&
      (workerManagementAuthority ||
        !WORKER_MANAGEMENT_OPERATIONS.has(operation)) &&
      (packageManagementAuthority ||
        !PACKAGE_MANAGEMENT_OPERATIONS.has(operation)),
  );
}

function commandIdSource(requestId: string): () => string {
  let first = true;
  return () => {
    if (first) {
      first = false;
      return requestId;
    }
    return randomUUID();
  };
}

async function executeConsoleRead(
  request: Readonly<ClusterCopilotConsoleReadRequest>,
  parsed: Readonly<ClusterCopilotConsoleCliArguments>,
) {
  if (request.operation === 'inspect' || request.operation === 'output') {
    return executeClusterCopilotCommand({
      configFile: parsed.configFile,
      credentialFile: parsed.credentialFile,
      command: clusterCopilotConsoleClientCommand(request),
    });
  }
  if (
    request.operation === 'run_cancellation_status' ||
    request.operation === 'run_cancellation_blocked_list' ||
    request.operation === 'run_cancellation_inspect'
  ) {
    if (
      parsed.runManagementConfigFile === undefined ||
      parsed.runManagementAssertionFile === undefined
    ) {
      throw new Error('Run management authority is disabled');
    }
    const createUuid = commandIdSource(request.requestId);
    const command =
      request.operation === 'run_cancellation_status'
        ? createRunCancellationStatusCommand(request.projectId, createUuid)
        : request.operation === 'run_cancellation_blocked_list'
        ? createRunCancellationBlockedListCommand(
            request.projectId,
            request.cursor ?? undefined,
            createUuid,
          )
        : createRunCancellationInspectionCommand(
            request.projectId,
            request.runId,
            createUuid,
          );
    const result = await executeClusterRunManagementCommand({
      configFile: parsed.runManagementConfigFile,
      assertionFile: parsed.runManagementAssertionFile,
      command,
    });
    const projected =
      request.operation === 'run_cancellation_status'
        ? projectRunCancellationStatus(result)
        : request.operation === 'run_cancellation_blocked_list'
        ? projectRunCancellationBlockedList(result)
        : projectRunCancellationInspection(result);
    return Object.freeze({
      schemaVersion: 1 as const,
      requestId: request.requestId,
      result: projected as unknown as Readonly<Record<string, unknown>>,
    });
  }
  if (
    request.operation === 'worker_list' ||
    request.operation === 'worker_inspect'
  ) {
    if (
      parsed.workerManagementConfigFile === undefined ||
      parsed.workerManagementAssertionFile === undefined
    ) {
      throw new Error('Worker management authority is disabled');
    }
    const createUuid = commandIdSource(request.requestId);
    const command =
      request.operation === 'worker_list'
        ? createWorkerSessionListCommand(
            request.projectId,
            request.afterWorkerId ?? undefined,
            createUuid,
          )
        : createWorkerSessionInspectionCommand(
            request.projectId,
            request.workerId,
            createUuid,
          );
    const result = await executeClusterWorkerManagementClient({
      configFile: parsed.workerManagementConfigFile,
      assertionFile: parsed.workerManagementAssertionFile,
      command,
    });
    const projected =
      request.operation === 'worker_list'
        ? projectWorkerSessionList(request.projectId, result)
        : projectWorkerSessionInspection(request.projectId, result);
    return Object.freeze({
      schemaVersion: 1 as const,
      requestId: request.requestId,
      result: projected as unknown as Readonly<Record<string, unknown>>,
    });
  }
  if (
    request.operation === 'package_list' ||
    request.operation === 'package_inspect'
  ) {
    if (
      parsed.packageManagementConfigFile === undefined ||
      parsed.packageManagementAssertionFile === undefined
    ) {
      throw new Error('Package management authority is disabled');
    }
    const createUuid = commandIdSource(request.requestId);
    const command =
      request.operation === 'package_list'
        ? createPluginPackageInstallationListCommand(
            request.projectId,
            request.afterPackageName ?? undefined,
            createUuid,
          )
        : createPluginPackageInstallationInspectionCommand(
            request.projectId,
            request.packageName,
            createUuid,
          );
    const result = await executeClusterPluginPackageManagementCommand({
      configFile: parsed.packageManagementConfigFile,
      assertionFile: parsed.packageManagementAssertionFile,
      command,
    });
    const projected =
      request.operation === 'package_list'
        ? projectPluginPackageInstallationList(request.projectId, result)
        : projectPluginPackageInstallationInspection(
            request.projectId,
            request.packageName,
            result,
          );
    return Object.freeze({
      schemaVersion: 1 as const,
      requestId: request.requestId,
      result: projected as unknown as Readonly<Record<string, unknown>>,
    });
  }
  return executeClusterProjectApiRead({
    configFile: parsed.configFile,
    credentialFile: parsed.credentialFile,
    path: clusterCopilotConsoleProjectReadPath(request),
    requestId: request.requestId,
  });
}

function readSessionDigest(sessionFile: string): Buffer {
  let bytes: Buffer | undefined;
  try {
    bytes = readCanonicalFile(sessionFile, MAXIMUM_SESSION_BYTES, 'private');
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
  const runManagementAuthority = validateManagementAuthority(
    parsed.runManagementConfigFile,
    parsed.runManagementAssertionFile,
    'run',
  );
  const workerManagementAuthority = validateManagementAuthority(
    parsed.workerManagementConfigFile,
    parsed.workerManagementAssertionFile,
    'worker',
  );
  const packageManagementAuthority = validateManagementAuthority(
    parsed.packageManagementConfigFile,
    parsed.packageManagementAssertionFile,
    'package',
  );
  const operations = availableOperations(
    runManagementAuthority,
    workerManagementAuthority,
    packageManagementAuthority,
  );
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
          networkBoundary: parsed.networkBoundary,
          publishedHostAddress: '127.0.0.1',
          browserCredential: 'forbidden',
          clusterCredential: 'server_only',
          runManagementAuthority: runManagementAuthority
            ? 'server_only'
            : 'disabled',
          workerManagementAuthority: workerManagementAuthority
            ? 'server_only'
            : 'disabled',
          packageManagementAuthority: packageManagementAuthority
            ? 'server_only'
            : 'disabled',
          operations,
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
      execute(request: Readonly<ClusterCopilotConsoleReadRequest>) {
        return executeConsoleRead(request, parsed);
      },
    }),
    networkBoundary: parsed.networkBoundary,
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
      networkBoundary: parsed.networkBoundary,
      publishedHostAddress: '127.0.0.1',
      browserCredential: 'forbidden',
      clusterCredential: 'server_only',
      runManagementAuthority: runManagementAuthority
        ? 'server_only'
        : 'disabled',
      workerManagementAuthority: workerManagementAuthority
        ? 'server_only'
        : 'disabled',
      packageManagementAuthority: packageManagementAuthority
        ? 'server_only'
        : 'disabled',
      operations,
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
