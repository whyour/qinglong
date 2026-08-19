#!/usr/bin/env node

import { ClusterPluginPackageManagementClientRemoteError } from '../management-support/pluginPackageManagementClient';
import {
  executeClusterRunManagementClient,
  executeClusterRunManagementCommand,
} from './runManagementClient';
import {
  createRunCancellationStatusCommand,
  formatRunCancellationStatusCard,
  projectRunCancellationStatus,
} from './runCancellationStatus';

const USAGE = [
  'Usage: ql3-run-client --config=/absolute/client.json --command=/absolute/command.json --assertion=/absolute/assertion.jwt',
  '       ql3-run-client status --config=/absolute/client.json --assertion=/absolute/assertion.jwt --project=PROJECT [--format=text|json]',
  '',
  'Status exit codes: 0=clear, 10=converging, 20=attention_required.',
].join('\n');
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type RunManagementClientArguments =
  | Readonly<{
      kind: 'command';
      configFile: string;
      commandFile: string;
      assertionFile: string;
    }>
  | Readonly<{
      kind: 'status';
      configFile: string;
      assertionFile: string;
      projectId: string;
      format: 'text' | 'json';
    }>;

function argumentsFrom(
  argv: readonly string[],
): Readonly<RunManagementClientArguments> | null {
  const statusCount = argv.filter((argument) => argument === 'status').length;
  if (statusCount > 0) {
    if (statusCount !== 1 || argv.length < 4 || argv.length > 5) return null;
    const values = new Map<string, string>();
    for (const argument of argv) {
      if (argument === 'status') continue;
      const match = /^--(config|assertion|project|format)=(.+)$/.exec(argument);
      if (!match || values.has(match[1]!)) return null;
      values.set(match[1]!, match[2]!);
    }
    if (
      !values.has('config') ||
      !values.get('config')!.startsWith('/') ||
      !values.has('assertion') ||
      !values.get('assertion')!.startsWith('/') ||
      !values.has('project') ||
      !PROJECT_ID.test(values.get('project')!) ||
      (values.has('format') &&
        values.get('format') !== 'text' &&
        values.get('format') !== 'json')
    ) {
      return null;
    }
    return Object.freeze({
      kind: 'status',
      configFile: values.get('config')!,
      assertionFile: values.get('assertion')!,
      projectId: values.get('project')!,
      format: (values.get('format') ?? 'text') as 'text' | 'json',
    });
  }
  if (argv.length !== 3) return null;
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--(config|command|assertion)=(\/.+)$/.exec(argument);
    if (!match || values.has(match[1]!)) return null;
    values.set(match[1]!, match[2]!);
  }
  if (
    !values.has('config') ||
    !values.has('command') ||
    !values.has('assertion')
  )
    return null;
  return Object.freeze({
    kind: 'command',
    configFile: values.get('config')!,
    commandFile: values.get('command')!,
    assertionFile: values.get('assertion')!,
  });
}

function failureFact(error: unknown): Readonly<Record<string, unknown>> {
  const candidate = error as { readonly code?: unknown };
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-run-management-client',
    event: 'command_failed',
    code:
      typeof candidate?.code === 'string'
        ? candidate.code
        : 'QL3_RUN_MANAGEMENT_CLIENT_FAILED',
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
  const paths = argumentsFrom(argv);
  if (!paths) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-run-management-client',
        event: 'usage_invalid',
        code: 'QL3_RUN_MANAGEMENT_CLIENT_USAGE_INVALID',
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    if (paths.kind === 'status') {
      const result = await executeClusterRunManagementCommand({
        configFile: paths.configFile,
        assertionFile: paths.assertionFile,
        command: createRunCancellationStatusCommand(paths.projectId),
      });
      const status = projectRunCancellationStatus(result);
      process.stdout.write(
        paths.format === 'json'
          ? `${JSON.stringify(status)}\n`
          : `${formatRunCancellationStatusCard(status)}\n`,
      );
      process.exitCode = status.exitCode;
      return;
    }
    const result = await executeClusterRunManagementClient(paths);
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-run-management-client',
        event: 'command_completed',
        requestId: result.requestId,
        result: result.result,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failureFact(error))}\n`);
    process.exitCode = 1;
  }
}

void run(process.argv.slice(2));
