#!/usr/bin/env node

/** One-shot Prompt Output key retirement CLI boundary. */
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';

import { type ClusterPromptOutputKubernetesSecretKeyringOptions } from './promptOutputKubernetesSecretKeyring';
import { openPromptOutputKubernetesSecretAuthority } from './promptOutputKubernetesSecretAuthority';
import { runClusterPromptOutputKeyRetirementProcess } from './promptOutputKeyRetirementProcess';
import { loadPromptOutputPostgresMaintenanceConnection } from './promptOutputPostgresMaintenanceConnection';

const USAGE =
  'Usage: ql3-prompt-output-key-retire run --command-file /absolute/retirement.json';
const MAX_COMMAND_FILE_BYTES = 16 * 1024;

interface RetirementCommand {
  readonly schemaVersion: 1;
  readonly operation: 'cluster.prompt-output-key.retire';
  readonly kubernetes: ClusterPromptOutputKubernetesSecretKeyringOptions;
  readonly request: Readonly<{
    keyId: string;
    retirementId: string;
    requestId: string;
    mutationId: string;
  }>;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function commandFile(filePath: string): RetirementCommand {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    filePath.includes('\0') ||
    Buffer.byteLength(filePath, 'utf8') > 4096
  ) {
    throw new TypeError('Retirement command file path is invalid');
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_COMMAND_FILE_BYTES) {
      throw new TypeError('Retirement command file is invalid');
    }
    const parsed = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !exactKeys(parsed, [
        'kubernetes',
        'operation',
        'request',
        'schemaVersion',
      ])
    ) {
      throw new TypeError('Retirement command shape is invalid');
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.schemaVersion !== 1 ||
      candidate.operation !== 'cluster.prompt-output-key.retire' ||
      !candidate.kubernetes ||
      typeof candidate.kubernetes !== 'object' ||
      Array.isArray(candidate.kubernetes) ||
      !candidate.request ||
      typeof candidate.request !== 'object' ||
      Array.isArray(candidate.request)
    ) {
      throw new TypeError('Retirement command value is invalid');
    }
    const kubernetes = candidate.kubernetes as Record<string, unknown>;
    const request = candidate.request as Record<string, unknown>;
    if (
      !exactKeys(kubernetes, [
        'dataKey',
        'expectedSecretUid',
        'namespace',
        'secretName',
      ]) ||
      !exactKeys(request, ['keyId', 'mutationId', 'requestId', 'retirementId'])
    ) {
      throw new TypeError('Retirement command nested shape is invalid');
    }
    return Object.freeze(parsed as RetirementCommand);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (
    argv.length !== 3 ||
    argv[0] !== 'run' ||
    argv[1] !== '--command-file' ||
    !argv[2]
  ) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_PROMPT_OUTPUT_KEY_RETIREMENT_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  let authority:
    | Awaited<ReturnType<typeof openPromptOutputKubernetesSecretAuthority>>
    | undefined;
  try {
    const command = commandFile(argv[2]);
    authority = await openPromptOutputKubernetesSecretAuthority(
      command.kubernetes,
    );
    const result = await runClusterPromptOutputKeyRetirementProcess({
      database: {
        connection: loadPromptOutputPostgresMaintenanceConnection(process.env),
        pool: {
          applicationName: 'qinglong3-prompt-output-key-retirement',
          maxConnections: 1,
        },
      },
      request: command.request,
      materials: authority.materials,
    });
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-prompt-output-key-retirement',
        event: 'key_retirement_completed',
        status: result.status,
        keyId: result.keyId,
        retirementId: result.retirementId,
        preparationDigest: result.preparationDigest,
        completionDigest: result.completionDigest,
        completedAtMs: result.completedAtMs,
      })}\n`,
    );
  } catch (error) {
    const candidate = error as {
      readonly code?: unknown;
      readonly name?: unknown;
    };
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-prompt-output-key-retirement',
        event: 'key_retirement_failed',
        name:
          typeof candidate.name === 'string'
            ? candidate.name.slice(0, 128)
            : 'Error',
        ...(typeof candidate.code === 'string'
          ? { code: candidate.code.slice(0, 128) }
          : {}),
      })}\n`,
    );
    process.exitCode = 1;
  } finally {
    authority?.dispose();
  }
}

void main(process.argv.slice(2));
