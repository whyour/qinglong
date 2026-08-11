import {
  runMigrationStream,
  type PostgresPool,
  type RunMigrationStreamOptions,
} from '@qinglong/runtime-core';
import {
  PostgresMigrationStreamStore,
  type PostgresMigrationContext,
} from '../migrations/postgresMigrationStreamStore';
import { postgresqlMainMigrationStream } from '../migrations';

export interface RunPostgresMigrationsOptions {
  readonly pool: PostgresPool;
  readonly clock?: () => number;
  readonly logger?: RunMigrationStreamOptions<PostgresMigrationContext>['logger'];
}

/** Executes the reviewed pg-* stream through a migration-role pool. */
export function runPostgresMigrations(
  options: RunPostgresMigrationsOptions,
): Promise<void> {
  return runMigrationStream({
    stream: postgresqlMainMigrationStream,
    store: new PostgresMigrationStreamStore(options.pool),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}
