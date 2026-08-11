const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { getTableName } = require('drizzle-orm');
const { getTableConfig } = require('drizzle-orm/sqlite-core');
const { migrateLocalSqlitePath } = require('../dist/migration/migration');
const { localSqliteSchema } = require('../dist/storage/schema');

function sorted(values) {
  return [...values].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function tableSql(client, tableName) {
  const row = client
    .prepare(
      `SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?`,
    )
    .get(tableName);
  assert.equal(typeof row?.sql, 'string');
  return row.sql;
}

function catalogChecks(sql) {
  return [...sql.matchAll(/CONSTRAINT\s+([A-Za-z0-9_]+)\s+CHECK\b/gi)].map(
    (match) => match[1],
  );
}

function catalogForeignKeys(client, tableName) {
  const grouped = new Map();
  for (const entry of client
    .prepare(`PRAGMA foreign_key_list("${tableName}")`)
    .all()) {
    const current = grouped.get(entry.id) ?? {
      columns: [],
      foreignTable: entry.table,
      foreignColumns: [],
      onDelete: entry.on_delete,
      onUpdate: entry.on_update,
    };
    current.columns[entry.seq] = entry.from;
    current.foreignColumns[entry.seq] = entry.to;
    grouped.set(entry.id, current);
  }
  return [...grouped.values()];
}

function drizzleForeignKeys(config) {
  return config.foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      columns: reference.columns.map(({ name }) => name),
      foreignTable: getTableName(reference.foreignTable),
      foreignColumns: reference.foreignColumns.map(({ name }) => name),
      onDelete: (foreignKey.onDelete ?? 'no action').toUpperCase(),
      onUpdate: (foreignKey.onUpdate ?? 'no action').toUpperCase(),
    };
  });
}

test('typed SQLite schema matches every reviewed table, column, index, check and foreign key', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-schema-lockstep-'));
  const databasePath = path.join(directory, 'qinglong3.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });

  const client = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const actualTables = client
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map(({ name }) => name);
    const drizzleTables = Object.values(localSqliteSchema).map(getTableConfig);
    assert.deepEqual(
      actualTables,
      drizzleTables.map(({ name }) => name).sort(),
    );

    for (const config of drizzleTables) {
      const columns = client
        .prepare(`PRAGMA table_info("${config.name}")`)
        .all()
        .map(({ name }) => name);
      assert.deepEqual(
        columns,
        config.columns.map(({ name }) => name),
        `${config.name} columns`,
      );

      const indexes = client
        .prepare(`PRAGMA index_list("${config.name}")`)
        .all()
        .map(({ name }) => name)
        .filter((name) => !name.startsWith('sqlite_autoindex_'));
      assert.deepEqual(
        indexes.sort(),
        config.indexes.map(({ config: value }) => value.name).sort(),
        `${config.name} indexes`,
      );
      assert.deepEqual(
        catalogChecks(tableSql(client, config.name)).sort(),
        config.checks.map(({ name }) => name).sort(),
        `${config.name} checks`,
      );
      assert.deepEqual(
        sorted(catalogForeignKeys(client, config.name)),
        sorted(drizzleForeignKeys(config)),
        `${config.name} foreign keys`,
      );
    }
  } finally {
    client.close();
  }
});
