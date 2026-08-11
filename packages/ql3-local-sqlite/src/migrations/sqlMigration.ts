import { createHash } from 'node:crypto';
import type { MigrationStreamStep } from '@qinglong/runtime-core/migration-stream';
import type { DatabaseSync } from 'node:sqlite';

export interface LocalSqliteMigrationContext {
  readonly client: DatabaseSync;
}

export function defineLocalSqliteMigration(options: {
  readonly id: string;
  readonly statements: readonly string[];
}): MigrationStreamStep<LocalSqliteMigrationContext> {
  const statements = Object.freeze(
    options.statements.map((statement) => statement.trim()),
  );
  if (
    statements.length === 0 ||
    statements.length > 64 ||
    statements.some(
      (statement) => statement.length === 0 || statement.length > 64 * 1024,
    )
  ) {
    throw new TypeError('Local SQLite migration statements are invalid');
  }
  const checksum = createHash('sha256')
    .update(statements.join('\n-- ql3-statement-boundary --\n'))
    .digest('hex');
  return Object.freeze({
    id: options.id,
    checksum,
    async up(context: LocalSqliteMigrationContext) {
      for (const statement of statements) context.client.exec(statement);
    },
  });
}

/**
 * Defines a reviewed migration whose bounded row transformation cannot be
 * expressed by SQLite alone. `program` is the immutable audit description
 * covered by the migration checksum and must change with transformation
 * semantics as well as with schema SQL.
 */
export function defineLocalSqliteProgrammaticMigration(options: {
  readonly id: string;
  readonly program: readonly string[];
  readonly up: (
    context: LocalSqliteMigrationContext,
  ) => void | Promise<void>;
}): MigrationStreamStep<LocalSqliteMigrationContext> {
  const program = Object.freeze(
    options.program.map((instruction) => instruction.trim()),
  );
  if (
    program.length === 0 ||
    program.length > 64 ||
    program.some(
      (instruction) =>
        instruction.length === 0 || instruction.length > 64 * 1024,
    ) ||
    typeof options.up !== 'function'
  ) {
    throw new TypeError('Local SQLite migration program is invalid');
  }
  const checksum = createHash('sha256')
    .update('ql3-local-sqlite-programmatic-migration-v1\0', 'utf8')
    .update(program.join('\n-- ql3-program-boundary --\n'), 'utf8')
    .digest('hex');
  return Object.freeze({
    id: options.id,
    checksum,
    async up(context: LocalSqliteMigrationContext) {
      await options.up(context);
    },
  });
}
