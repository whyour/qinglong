/**
 * Storage compatibility entrypoint for development tooling. Deployment Profile
 * packages must import /runtime or /migration explicitly so executable DDL is
 * not pulled into a long-lived process by accident.
 */
export * from '../runtime/runtimeDatabase';
export {
  localSqliteMigrationDefinition,
  localSqliteMigrationManifest,
  migrateLocalSqliteDatabase,
  migrateLocalSqlitePath,
  type LocalSqliteMigrationResult,
} from '../migration/migration';
