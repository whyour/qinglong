// Local lifecycle owns short-lived readiness inspection.
import fs from 'node:fs';
import path from 'node:path';

import {
  inspectLocalSqliteReadinessPath,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteReadinessEvidence,
} from '@qinglong/local-sqlite/readiness-inspection';

const MAX_PATH_BYTES = 4_096;

export interface LocalReadinessResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.readiness.inspect';
  readonly status: 'ready';
  readonly profile: 'edge' | 'standalone';
  readonly storage: Readonly<{
    contractName: string;
    contractVersion: number;
    migrationCount: number;
    tableCount: number;
    sqliteVersion: string;
    journalMode: 'delete' | 'wal';
  }>;
}

export class LocalReadinessConfigurationError extends TypeError {
  readonly code = 'QL3_LOCAL_READINESS_CONFIGURATION_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`Local readiness configuration is invalid: ${message}`, options);
    this.name = 'LocalReadinessConfigurationError';
  }
}

export class LocalReadinessIncompatibleError extends Error {
  readonly code = 'QL3_LOCAL_READINESS_INCOMPATIBLE';

  constructor(message: string, options?: ErrorOptions) {
    super(`Local readiness is incompatible: ${message}`, options);
    this.name = 'LocalReadinessIncompatibleError';
  }
}

function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    process.getuid() !== process.geteuid()
  ) {
    throw new LocalReadinessConfigurationError(
      'real and effective POSIX users must match',
    );
  }
  return process.getuid();
}

function normalizedDatabasePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LocalReadinessConfigurationError(
      'databasePath must be a normalized bounded absolute non-root path',
    );
  }
  return value;
}

function inspectPrivateDatabaseFile(databasePath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(databasePath);
  } catch (error) {
    throw new LocalReadinessConfigurationError('database is unavailable', {
      cause: error,
    });
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== currentUid() ||
    (stat.mode & 0o777) !== 0o600 ||
    fs.realpathSync(databasePath) !== databasePath
  ) {
    throw new LocalReadinessConfigurationError(
      'database must be a canonical current-UID mode-0600 regular file',
    );
  }
}

export function normalizeLocalReadinessOptions(
  value: unknown,
): Readonly<LocalSqliteDatabaseOptions> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalReadinessConfigurationError('options must be an object');
  }
  const candidate = value as Record<string, unknown>;
  const expectedKeys = [
    'databasePath',
    'profile',
    ...(Object.hasOwn(candidate, 'busyTimeoutMs') ? ['busyTimeoutMs'] : []),
  ].sort();
  const actualKeys = Object.keys(candidate).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new LocalReadinessConfigurationError('options shape is invalid');
  }
  if (candidate.profile !== 'edge' && candidate.profile !== 'standalone') {
    throw new LocalReadinessConfigurationError(
      'profile must be edge or standalone',
    );
  }
  const busyTimeoutMs = candidate.busyTimeoutMs;
  if (
    busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(busyTimeoutMs) ||
      (busyTimeoutMs as number) < 100 ||
      (busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalReadinessConfigurationError(
      'busyTimeoutMs must be between 100 and 30000',
    );
  }
  return Object.freeze({
    databasePath: normalizedDatabasePath(candidate.databasePath),
    profile: candidate.profile,
    ...(busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: busyTimeoutMs as number }),
  });
}

export function parseLocalReadinessArguments(
  argv: readonly string[],
): Readonly<LocalSqliteDatabaseOptions> {
  const values = new Map<string, string>();
  for (const argument of argv) {
    if (argument === '--') continue;
    const match = /^--(database|profile|busy-timeout-ms)=(.+)$/.exec(argument);
    if (!match || values.has(match[1]!)) {
      throw new LocalReadinessConfigurationError(
        'arguments must contain one --database and one --profile, with optional --busy-timeout-ms',
      );
    }
    values.set(match[1]!, match[2]!);
  }
  if (
    values.size < 2 ||
    values.size > 3 ||
    !values.has('database') ||
    !values.has('profile')
  ) {
    throw new LocalReadinessConfigurationError(
      'arguments must contain one --database and one --profile, with optional --busy-timeout-ms',
    );
  }
  const rawTimeout = values.get('busy-timeout-ms');
  return normalizeLocalReadinessOptions({
    databasePath: values.get('database'),
    profile: values.get('profile'),
    ...(rawTimeout === undefined ? {} : { busyTimeoutMs: Number(rawTimeout) }),
  });
}

function resultFromEvidence(
  profile: 'edge' | 'standalone',
  evidence: LocalSqliteReadinessEvidence,
): Readonly<LocalReadinessResult> {
  const expectedJournalMode = profile === 'edge' ? 'delete' : 'wal';
  if (evidence.journalMode !== expectedJournalMode) {
    throw new LocalReadinessIncompatibleError(
      `${profile} requires ${expectedJournalMode} journal mode`,
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.readiness.inspect' as const,
    status: 'ready' as const,
    profile,
    storage: Object.freeze({
      contractName: evidence.contractName,
      contractVersion: evidence.contractVersion,
      migrationCount: evidence.migrationIds.length,
      tableCount: evidence.tableCount,
      sqliteVersion: evidence.sqliteVersion,
      journalMode: expectedJournalMode,
    }),
  });
}

export async function inspectLocalReadiness(
  value: unknown,
): Promise<Readonly<LocalReadinessResult>> {
  const options = normalizeLocalReadinessOptions(value);
  inspectPrivateDatabaseFile(options.databasePath);
  let evidence: LocalSqliteReadinessEvidence;
  try {
    evidence = await inspectLocalSqliteReadinessPath(options);
  } catch (error) {
    throw new LocalReadinessIncompatibleError('storage audit failed', {
      cause: error,
    });
  }
  return resultFromEvidence(options.profile, evidence);
}
