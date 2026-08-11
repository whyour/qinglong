import { createHash } from 'crypto';
import type { MigrationStreamStep } from '@qinglong/runtime-core';
import type { PostgresMigrationContext } from './postgresMigrationStreamStore';

export interface PostgresSqlMigrationDefinition {
  readonly id: string;
  readonly statements: readonly string[];
}

export function checksumPostgresStatements(
  statements: readonly string[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        format: 1,
        statements,
      }),
    )
    .digest('hex');
}

export function definePostgresSqlMigration(
  definition: PostgresSqlMigrationDefinition,
): MigrationStreamStep<PostgresMigrationContext> {
  const statements = Object.freeze([...definition.statements]);
  return Object.freeze({
    id: definition.id,
    checksum: checksumPostgresStatements(statements),
    async up(context: PostgresMigrationContext) {
      for (const statement of statements) await context.query(statement);
    },
  });
}
