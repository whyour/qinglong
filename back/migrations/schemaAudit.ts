import {
  SqliteSchemaOwnershipManifest,
  sqliteSchemaOwnership,
} from './schemaOwnership';

export interface SqliteSchemaSnapshotTable {
  name: string;
  columns: readonly string[];
  indexes: readonly string[];
}

export interface SqliteSchemaSnapshot {
  tables: readonly SqliteSchemaSnapshotTable[];
  migrationIds: readonly string[];
}

export interface SchemaColumnFinding {
  table: string;
  column: string;
}

export interface SqliteSchemaAuditReport {
  compatible: boolean;
  driftDetected: boolean;
  missingTables: string[];
  missingColumns: SchemaColumnFinding[];
  missingIndexes: string[];
  missingMigrationIds: string[];
  unknownTables: string[];
  unknownColumns: SchemaColumnFinding[];
  unknownIndexes: string[];
  extraMigrationIds: string[];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortColumns(values: SchemaColumnFinding[]): SchemaColumnFinding[] {
  return values.sort(
    (left, right) =>
      left.table.localeCompare(right.table) ||
      left.column.localeCompare(right.column),
  );
}

export function auditSqliteSchema(
  snapshot: SqliteSchemaSnapshot,
  manifest: SqliteSchemaOwnershipManifest = sqliteSchemaOwnership,
): SqliteSchemaAuditReport {
  const actualTables = new Map(
    snapshot.tables.map((table) => [
      table.name,
      {
        columns: new Set(table.columns),
        indexes: new Set(table.indexes),
      },
    ]),
  );
  const ownedTables = new Map(
    manifest.tables.map((table) => [table.name, table]),
  );
  const actualIndexes = new Set(
    snapshot.tables.flatMap((table) => [...table.indexes]),
  );
  const ownedIndexes = new Set(manifest.indexes.map((index) => index.name));
  const actualMigrations = new Set(snapshot.migrationIds);
  const ownedMigrations = new Set(manifest.migrationIds);
  const missingTables: string[] = [];
  const missingColumns: SchemaColumnFinding[] = [];
  const unknownColumns: SchemaColumnFinding[] = [];

  for (const table of manifest.tables) {
    const actual = actualTables.get(table.name);
    if (!actual) {
      if (table.mode === 'unmanaged-legacy') continue;
      missingTables.push(table.name);
      continue;
    }
    for (const column of table.requiredColumns) {
      if (!actual.columns.has(column)) {
        missingColumns.push({ table: table.name, column });
      }
    }
    if (table.mode === 'full') {
      const ownedColumns = new Set(table.requiredColumns);
      for (const column of actual.columns) {
        if (!ownedColumns.has(column)) {
          unknownColumns.push({ table: table.name, column });
        }
      }
    }
  }

  const missingIndexes = manifest.indexes
    .map((index) => index.name)
    .filter((index) => !actualIndexes.has(index));
  const missingMigrationIds = manifest.migrationIds.filter(
    (migrationId) => !actualMigrations.has(migrationId),
  );
  const unknownTables = snapshot.tables
    .map((table) => table.name)
    .filter(
      (table) => !table.startsWith('sqlite_') && !ownedTables.has(table),
    );
  const reportableIndexes = new Set(
    snapshot.tables.flatMap((table) => {
      const ownership = ownedTables.get(table.name);
      return !ownership || ownership.mode === 'full' ? [...table.indexes] : [];
    }),
  );
  const unknownIndexes = [...reportableIndexes].filter(
    (index) => !index.startsWith('sqlite_autoindex_') && !ownedIndexes.has(index),
  );
  const extraMigrationIds = snapshot.migrationIds.filter(
    (migrationId) => !ownedMigrations.has(migrationId),
  );
  const compatible =
    missingTables.length === 0 &&
    missingColumns.length === 0 &&
    missingIndexes.length === 0 &&
    missingMigrationIds.length === 0;
  const driftDetected =
    unknownTables.length > 0 ||
    unknownColumns.length > 0 ||
    unknownIndexes.length > 0 ||
    extraMigrationIds.length > 0;

  return {
    compatible,
    driftDetected,
    missingTables: sortedUnique(missingTables),
    missingColumns: sortColumns(missingColumns),
    missingIndexes: sortedUnique(missingIndexes),
    missingMigrationIds: sortedUnique(missingMigrationIds),
    unknownTables: sortedUnique(unknownTables),
    unknownColumns: sortColumns(unknownColumns),
    unknownIndexes: sortedUnique(unknownIndexes),
    extraMigrationIds: sortedUnique(extraMigrationIds),
  };
}
