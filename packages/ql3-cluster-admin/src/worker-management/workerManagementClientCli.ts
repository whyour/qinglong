#!/usr/bin/env node

import { ClusterPluginPackageManagementClientRemoteError } from '../management-support/pluginPackageManagementClient';
import { executeClusterWorkerManagementClient } from './workerManagementClient';
import {
  createWorkerSessionInspectionCommand,
  createWorkerSessionListCommand,
  formatWorkerSessionInspectionCard,
  formatWorkerSessionListCard,
  projectWorkerSessionInspection,
  projectWorkerSessionList,
} from './workerManagementProduct';

const USAGE = [
  'Usage: ql3-worker-client inspect --config=/absolute/client.json --assertion=/absolute/assertion.jwt --project=PROJECT --worker=WORKER [--format=text|json]',
  '       ql3-worker-client list    --config=/absolute/client.json --assertion=/absolute/assertion.jwt --project=PROJECT [--after=WORKER] [--format=text|json]',
  '',
  'One invocation performs one bounded read; it never retries, polls or auto-pages.',
].join('\n');
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type WorkerClientArguments = Readonly<{
  kind: 'inspect' | 'list';
  configFile: string;
  assertionFile: string;
  projectId: string;
  workerId?: string;
  afterWorkerId?: string;
  format: 'text' | 'json';
}>;

function argumentsFrom(argv: readonly string[]): WorkerClientArguments | null {
  const modes = argv.filter(
    (argument) => argument === 'inspect' || argument === 'list',
  );
  if (modes.length !== 1 || argv.length < 4 || argv.length > 6) return null;
  const kind = modes[0] as 'inspect' | 'list';
  const values = new Map<string, string>();
  for (const argument of argv) {
    if (argument === kind) continue;
    const match =
      /^--(config|assertion|project|worker|after|format)=(.+)$/.exec(argument);
    if (!match || values.has(match[1]!)) return null;
    values.set(match[1]!, match[2]!);
  }
  if (
    !values.get('config')?.startsWith('/') ||
    !values.get('assertion')?.startsWith('/') ||
    !IDENTIFIER.test(values.get('project') ?? '') ||
    (kind === 'inspect' &&
      (!IDENTIFIER.test(values.get('worker') ?? '') || values.has('after'))) ||
    (kind === 'list' &&
      (values.has('worker') ||
        (values.has('after') && !IDENTIFIER.test(values.get('after')!)))) ||
    (values.has('format') &&
      values.get('format') !== 'text' &&
      values.get('format') !== 'json')
  ) {
    return null;
  }
  return Object.freeze({
    kind,
    configFile: values.get('config')!,
    assertionFile: values.get('assertion')!,
    projectId: values.get('project')!,
    ...(kind === 'inspect' ? { workerId: values.get('worker')! } : {}),
    ...(kind === 'list' && values.has('after')
      ? { afterWorkerId: values.get('after')! }
      : {}),
    format: (values.get('format') ?? 'text') as 'text' | 'json',
  });
}

function failureFact(error: unknown): Readonly<Record<string, unknown>> {
  const candidate = error as { readonly code?: unknown };
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-worker-management-client',
    event: 'inspection_failed',
    code:
      typeof candidate?.code === 'string'
        ? candidate.code
        : 'QL3_WORKER_MANAGEMENT_CLIENT_FAILED',
    ...(error instanceof ClusterPluginPackageManagementClientRemoteError
      ? {
          statusCode: error.statusCode,
          responseCode: error.responseCode,
          requestId: error.requestId,
          ...(error.retryAfterSeconds === null
            ? {}
            : { retryAfterSeconds: error.retryAfterSeconds }),
        }
      : {}),
  });
}

async function run(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const argumentsValue = argumentsFrom(argv);
  if (argumentsValue === null) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-worker-management-client',
        event: 'usage_invalid',
        code: 'QL3_WORKER_MANAGEMENT_CLIENT_USAGE_INVALID',
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const command =
      argumentsValue.kind === 'inspect'
        ? createWorkerSessionInspectionCommand(
            argumentsValue.projectId,
            argumentsValue.workerId!,
          )
        : createWorkerSessionListCommand(
            argumentsValue.projectId,
            argumentsValue.afterWorkerId,
          );
    const response = await executeClusterWorkerManagementClient({
      configFile: argumentsValue.configFile,
      assertionFile: argumentsValue.assertionFile,
      command,
    });
    const projection =
      argumentsValue.kind === 'inspect'
        ? projectWorkerSessionInspection(argumentsValue.projectId, response)
        : projectWorkerSessionList(argumentsValue.projectId, response);
    process.stdout.write(
      argumentsValue.format === 'json'
        ? `${JSON.stringify(projection)}\n`
        : `${
            projection.schema === 'qinglong/worker-session-inspection@v1'
              ? formatWorkerSessionInspectionCard(projection)
              : formatWorkerSessionListCard(projection)
          }\n`,
    );
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failureFact(error))}\n`);
    process.exitCode = 1;
  }
}

void run(process.argv.slice(2));
