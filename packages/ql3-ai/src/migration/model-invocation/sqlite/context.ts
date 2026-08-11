import type { DatabaseSync } from 'node:sqlite';

export interface LocalMigrationContext {
  readonly client: DatabaseSync;
}
