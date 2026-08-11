#!/usr/bin/env node

/** One-shot Prompt Output garbage collection CLI boundary. */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  loadPostgresCertificateAuthorityFile,
  loadPostgresConnectionEnvironment,
  type PostgresConnectionOptions,
} from '@qinglong/cluster-postgres/ai-maintenance';
import type { PluginPackagePromptOutputRetentionPolicyCatalog } from '@qinglong/ai/plugin-package-prompt-output-retention';

import { runClusterPromptOutputGcProcess } from './promptOutputGcProcess';

const USAGE =
  'Usage: ql3-prompt-output-gc run --policy-file /absolute/retention-policies.json';
const MAX_POLICY_FILE_BYTES = 65_536;

function policyCatalog(
  filePath: string,
): PluginPackagePromptOutputRetentionPolicyCatalog {
  if (!path.isAbsolute(filePath) || filePath.includes('\0')) {
    throw new TypeError('Policy file path is invalid');
  }
  const bytes = readFileSync(filePath);
  if (bytes.length < 1 || bytes.length > MAX_POLICY_FILE_BYTES) {
    throw new TypeError('Policy file size is invalid');
  }
  return JSON.parse(
    bytes.toString('utf8'),
  ) as PluginPackagePromptOutputRetentionPolicyCatalog;
}

function limit(): number {
  const raw = process.env.QL3_PROMPT_OUTPUT_GC_LIMIT ?? '32';
  if (!/^\d+$/.test(raw)) throw new TypeError('GC limit is invalid');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 128) {
    throw new TypeError('GC limit is invalid');
  }
  return value;
}

function connection(): PostgresConnectionOptions {
  const base = loadPostgresConnectionEnvironment(process.env, {
    connectionString: 'QL3_POSTGRES_AI_MAINTENANCE_URL',
    host: 'QL3_POSTGRES_AI_MAINTENANCE_HOST',
    port: 'QL3_POSTGRES_AI_MAINTENANCE_PORT',
    database: 'QL3_POSTGRES_AI_MAINTENANCE_DATABASE',
    user: 'QL3_POSTGRES_AI_MAINTENANCE_USER',
    password: 'QL3_POSTGRES_AI_MAINTENANCE_PASSWORD',
  });
  const mode = process.env.QL3_POSTGRES_TLS_MODE ?? 'verify-full';
  if (mode === 'disable') {
    if (process.env.QL3_POSTGRES_ALLOW_INSECURE !== 'true') {
      throw new TypeError('Insecure PostgreSQL requires an explicit gate');
    }
    return Object.freeze({ ...base, tls: { mode: 'disable' as const } });
  }
  if (mode !== 'verify-full')
    throw new TypeError('PostgreSQL TLS mode is invalid');
  const caFile = process.env.QL3_POSTGRES_TLS_CA_FILE;
  const servername = process.env.QL3_POSTGRES_TLS_SERVERNAME;
  if (!caFile || !servername) {
    throw new TypeError('PostgreSQL TLS CA and servername are required');
  }
  return Object.freeze({
    ...base,
    tls: {
      mode: 'verify-full' as const,
      ca: loadPostgresCertificateAuthorityFile(caFile),
      servername,
    },
  });
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (
    argv.length !== 3 ||
    argv[0] !== 'run' ||
    argv[1] !== '--policy-file' ||
    !argv[2]
  ) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_PROMPT_OUTPUT_GC_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const result = await runClusterPromptOutputGcProcess({
      database: {
        connection: connection(),
        pool: {
          applicationName: 'qinglong3-prompt-output-gc',
          maxConnections: 1,
        },
      },
      retentionPolicyCatalog: policyCatalog(argv[2]),
      limit: limit(),
    });
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-prompt-output-gc',
        event: 'gc_completed',
        scanned: result.scanned,
        tombstoned: result.tombstoned,
        skipped: result.skipped,
        hasMore: result.hasMore,
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
        component: 'qinglong3-prompt-output-gc',
        event: 'gc_failed',
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
  }
}

void main(process.argv.slice(2));
