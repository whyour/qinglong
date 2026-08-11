import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

import {
  LocalSqliteAdoptionError,
  type LocalSqliteAdoptionManifest,
} from './contracts';
import {
  assertRealParent,
  assertRegularFile,
  removeCreatedFile,
  sha256File,
} from './filesystem';
import { inspectLegacySqlitePath, openLegacySource } from './inspection';
import { verifyLegacyBackup } from './staging';

export function assertBusyTimeout(value: number | undefined): number {
  const timeout = value ?? 5_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) {
    throw new LocalSqliteAdoptionError(
      'busyTimeoutMs must be between 100 and 30000',
    );
  }
  return timeout;
}

export function acquireSourceWriteFence(
  sourcePath: string,
  busyTimeoutMs?: number,
  label: 'legacy source' | 'target database' = 'legacy source',
): DatabaseSync {
  assertRealParent(sourcePath, 'source');
  assertRegularFile(sourcePath, 'source');
  const client = new DatabaseSync(sourcePath, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: assertBusyTimeout(busyTimeoutMs),
  });
  try {
    client.enableDefensive(true);
    client.exec('PRAGMA trusted_schema = OFF');
    client.exec('PRAGMA recursive_triggers = OFF');
    client.exec('PRAGMA foreign_keys = ON');
    client.exec('BEGIN IMMEDIATE');
    return client;
  } catch (error) {
    client.close();
    throw new LocalSqliteAdoptionError(
      `${label} write fence could not be acquired`,
      error,
    );
  }
}

export function releaseSourceWriteFence(client: DatabaseSync): void {
  try {
    if (client.isTransaction) client.exec('ROLLBACK');
  } finally {
    client.close();
  }
}

export async function verifySourceSnapshotWhileFenced(
  sourcePath: string,
  recoveryPath: string,
  adoption: LocalSqliteAdoptionManifest,
): Promise<void> {
  const current = inspectLegacySqlitePath({
    sourcePath,
    profile: adoption.profile,
    ...(adoption.tasks.timezone === null
      ? {}
      : { legacyTimezone: adoption.tasks.timezone }),
  });
  if (
    current.source.pathDigest !== adoption.source.pathDigest ||
    current.catalog.digest !== adoption.catalog.digest ||
    current.tasks.inventoryDigest !== adoption.tasks.inventoryDigest
  ) {
    throw new LocalSqliteAdoptionError(
      'legacy source identity or catalog changed after staging',
    );
  }
  const temporaryPath = path.join(
    path.dirname(recoveryPath),
    `.${path.basename(recoveryPath)}.${randomUUID()}.verify`,
  );
  try {
    const source = openLegacySource(sourcePath);
    try {
      await backup(source, temporaryPath, { rate: 64 });
    } finally {
      source.close();
    }
    await verifyLegacyBackup(
      temporaryPath,
      adoption.catalog.digest,
      adoption.tasks,
    );
    const temporaryStat = fs.statSync(temporaryPath);
    const temporarySha256 = await sha256File(temporaryPath);
    if (
      temporaryStat.size !== adoption.recovery.bytes ||
      temporarySha256 !== adoption.recovery.sha256
    ) {
      throw new LocalSqliteAdoptionError(
        'legacy source content changed after staging',
      );
    }
  } finally {
    await removeCreatedFile(temporaryPath);
  }
}
