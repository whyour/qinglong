import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Shared SQLite storage boundary for path, Profile and connection policy.
export type LocalSqliteProfile = 'edge' | 'standalone';

export interface LocalSqliteDatabaseOptions {
  readonly databasePath: string;
  readonly profile: LocalSqliteProfile;
  readonly busyTimeoutMs?: number;
}

export class LocalSqliteConfigurationError extends TypeError {
  readonly code = 'LOCAL_SQLITE_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(`Local SQLite configuration is invalid: ${message}`);
    this.name = 'LocalSqliteConfigurationError';
  }
}

export function assertLocalSqliteOptions(
  options: LocalSqliteDatabaseOptions,
): void {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !path.isAbsolute(options.databasePath) ||
    options.databasePath.length > 4096 ||
    options.databasePath.includes('\0')
  ) {
    throw new LocalSqliteConfigurationError(
      'databasePath must be a bounded absolute path',
    );
  }
  if (options.profile !== 'edge' && options.profile !== 'standalone') {
    throw new LocalSqliteConfigurationError(
      'profile must be edge or standalone',
    );
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 100 ||
    busyTimeoutMs > 30_000
  ) {
    throw new LocalSqliteConfigurationError(
      'busyTimeoutMs must be between 100 and 30000',
    );
  }
}

export function assertLocalSqlitePathBoundary(
  databasePath: string,
  allowMissing: boolean,
): void {
  const parent = fs.lstatSync(path.dirname(databasePath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new LocalSqliteConfigurationError(
      'database parent must be a real directory',
    );
  }
  try {
    const target = fs.lstatSync(databasePath);
    if (!target.isFile() || target.isSymbolicLink()) {
      throw new LocalSqliteConfigurationError(
        'database target must be a regular file',
      );
    }
  } catch (error) {
    if (
      allowMissing &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return;
    }
    throw error;
  }
}

function expectedJournalMode(profile: LocalSqliteProfile): 'delete' | 'wal' {
  return profile === 'edge' ? 'delete' : 'wal';
}

/** Opens one bounded local authority; callers own and must close the handle. */
export function openLocalSqliteClient(
  options: LocalSqliteDatabaseOptions,
  readOnly: boolean,
): DatabaseSync {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  const client = new DatabaseSync(options.databasePath, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly,
    timeout: busyTimeoutMs,
  });
  try {
    client.enableDefensive(true);
    client.exec('PRAGMA trusted_schema = OFF');
    client.exec('PRAGMA recursive_triggers = OFF');
    client.exec('PRAGMA foreign_keys = ON');
    if (!readOnly) {
      const expected = expectedJournalMode(options.profile);
      const journal = client
        .prepare(`PRAGMA journal_mode = ${expected.toUpperCase()}`)
        .get() as { journal_mode?: unknown } | undefined;
      if (journal?.journal_mode !== expected) {
        throw new LocalSqliteConfigurationError(
          `${options.profile} database does not support ${expected} journal mode`,
        );
      }
      client.exec('PRAGMA synchronous = FULL');
      if (options.profile === 'standalone') {
        client.exec('PRAGMA wal_autocheckpoint = 1000');
      }
      client.exec(
        `PRAGMA journal_size_limit = ${
          options.profile === 'edge' ? 8 * 1024 * 1024 : 64 * 1024 * 1024
        }`,
      );
      client.exec(
        `PRAGMA cache_size = ${options.profile === 'edge' ? -4096 : -16384}`,
      );
      client.exec(
        `PRAGMA mmap_size = ${
          options.profile === 'edge' ? 0 : 64 * 1024 * 1024
        }`,
      );
    } else {
      client.exec('PRAGMA query_only = ON');
    }
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
