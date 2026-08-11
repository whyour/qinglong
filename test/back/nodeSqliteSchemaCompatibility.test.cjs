require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { DataTypes, Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  RUN_ATTEMPT_TABLE,
  RUN_EVENT_TABLE,
  RUN_TABLE,
} = require('../../back/migrations/0002-run-schema');
const {
  RUN_CANCELLATION_DISPATCH_TABLE,
} = require('../../back/migrations/0005-run-cancellation-dispatch');
const { migrations } = require('../../back/migrations');
const { runMigrations } = require('../../back/migrations/runner');
const {
  parseArguments: parseLegacySchemaAuditArguments,
} = require('../../scripts/ql3-schema-audit.cjs');

let nodeSqlite;
try {
  nodeSqlite = require('node:sqlite');
} catch {
  nodeSqlite = undefined;
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
const temporaryDirectories = [];

test('legacy schema audit never selects a live database implicitly', () => {
  assert.throws(
    () => parseLegacySchemaAuditArguments([]),
    /requires an explicit --database path/,
  );
  assert.throws(
    () =>
      parseLegacySchemaAuditArguments([
        '--database=/tmp/a.sqlite',
        '--database=/tmp/b.sqlite',
      ]),
    /must not be duplicated/,
  );
});

async function createMigratedDatabase() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-node-sqlite-'));
  temporaryDirectories.push(root);
  const storage = path.join(root, 'database.sqlite');
  const database = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
  });
  const queryInterface = database.getQueryInterface();
  for (const table of ['CrontabViews', 'Subscriptions', 'Crontabs', 'Envs']) {
    await queryInterface.createTable(table, {
      id: { type: DataTypes.INTEGER, primaryKey: true },
    });
  }
  await queryInterface.createTable('RunningInstances', {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    started_at: { type: DataTypes.INTEGER, allowNull: false },
  });
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations,
    logger: { info() {} },
  });
  await database.close();
  return storage;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

test(
  'Node 24 opens the Sequelize migration chain with defensive node:sqlite options',
  { skip: nodeMajor < 24 },
  async () => {
    assert.equal(typeof nodeSqlite?.DatabaseSync, 'function');
    const storage = await createMigratedDatabase();
    const database = new nodeSqlite.DatabaseSync(storage, {
      allowExtension: false,
      allowUnknownNamedParameters: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readOnly: true,
      timeout: 1_000,
    });

    try {
      assert.equal(
        database.prepare('PRAGMA integrity_check').get().integrity_check,
        'ok',
      );
      const tables = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      for (const table of [
        RUN_TABLE,
        RUN_ATTEMPT_TABLE,
        RUN_EVENT_TABLE,
        RUN_CANCELLATION_DISPATCH_TABLE,
        'SchemaMigrations',
      ]) {
        assert.ok(tables.includes(table), `missing ${table}`);
      }

      const runColumns = database
        .prepare(`PRAGMA table_info(${RUN_TABLE})`)
        .all()
        .map((row) => row.name);
      for (const column of [
        'id',
        'status',
        'version',
        'event_sequence',
        'cancel_requested_at_ms',
      ]) {
        assert.ok(runColumns.includes(column), `missing Runs.${column}`);
      }
      const attemptColumns = database
        .prepare(`PRAGMA table_info(${RUN_ATTEMPT_TABLE})`)
        .all()
        .map((row) => row.name);
      assert.ok(
        attemptColumns.includes('deadline_at_ms'),
        'missing RunAttempts.deadline_at_ms',
      );

      assert.throws(
        () => database.exec('CREATE TABLE must_not_write(id INTEGER)'),
        /read.?only/i,
      );
    } finally {
      database.close();
    }

    const audit = JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.resolve(__dirname, '../../scripts/ql3-schema-audit.cjs'),
          '--json',
          `--database=${storage}`,
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(audit.compatible, true);
    assert.equal(audit.driftDetected, false);
  },
);
