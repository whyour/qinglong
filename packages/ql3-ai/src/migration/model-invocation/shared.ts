import { createHash } from 'node:crypto';

import {
  MigrationStreamHistoryCorruptionError,
  type MigrationStreamRecord,
  type MigrationStreamStep,
} from '@qinglong/runtime-core/migration-stream';

export interface HistoryRow extends Record<string, unknown> {
  readonly migrationId: unknown;
  readonly streamId: unknown;
  readonly dialect: unknown;
  readonly checksum: unknown;
  readonly appliedAtMs: unknown;
}

function checksum(statements: readonly string[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        format: 1,
        statements,
      }),
    )
    .digest('hex');
}

export function defineSqlMigration<TContext>(
  id: string,
  statementsValue: readonly string[],
  execute: (context: TContext, statement: string) => void | Promise<void>,
): MigrationStreamStep<TContext> {
  const statements = Object.freeze(
    statementsValue.map((statement) => statement.trim()),
  );
  if (
    statements.length < 1 ||
    statements.length > 32 ||
    statements.some(
      (statement) => statement.length < 1 || statement.length > 64 * 1024,
    )
  ) {
    throw new TypeError('ModelInvocation migration statements are invalid');
  }
  return Object.freeze({
    id,
    checksum: checksum(statements),
    async up(context: TContext): Promise<void> {
      for (const statement of statements) await execute(context, statement);
    },
  });
}

function appliedAtMs(value: unknown, migrationId: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new MigrationStreamHistoryCorruptionError(migrationId);
}

export function historyRecord(
  row: HistoryRow,
  expected: Readonly<{
    migrationIds: readonly string[];
    streamId: string;
    dialect: 'sqlite' | 'postgresql';
  }>,
): MigrationStreamRecord {
  const corruptionId =
    typeof row.migrationId === 'string'
      ? row.migrationId
      : expected.migrationIds[0] ?? expected.streamId;
  if (
    typeof row.migrationId !== 'string' ||
    !expected.migrationIds.includes(row.migrationId) ||
    row.streamId !== expected.streamId ||
    row.dialect !== expected.dialect ||
    typeof row.checksum !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.checksum)
  ) {
    throw new MigrationStreamHistoryCorruptionError(corruptionId);
  }
  return Object.freeze({
    migrationId: row.migrationId,
    streamId: row.streamId,
    dialect: expected.dialect,
    checksum: row.checksum,
    appliedAtMs: appliedAtMs(row.appliedAtMs, row.migrationId),
  });
}
