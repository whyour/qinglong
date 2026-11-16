import dayjs from 'dayjs';
import { installTriggerHistory } from './triggerHistory';
import { repairLegacyDailyStatistics } from './legacyDailyStatistics';
import { QueryTypes, Sequelize } from 'sequelize';

export const prunedExitMigrationId = 'preserve-pruned-bound-exits-v1';

// Append new entries; IDs are persisted and must not be renumbered or reused.
const columns = [
  {
    table: 'CrontabViews',
    column: 'filterRelation',
    type: 'VARCHAR(255)',
  },
  { table: 'Subscriptions', column: 'proxy', type: 'VARCHAR(255)' },
  { table: 'CrontabViews', column: 'type', type: 'NUMBER' },
  { table: 'Subscriptions', column: 'autoAddCron', type: 'NUMBER' },
  { table: 'Subscriptions', column: 'autoDelCron', type: 'NUMBER' },
  { table: 'Crontabs', column: 'sub_id', type: 'NUMBER' },
  { table: 'Crontabs', column: 'extra_schedules', type: 'JSON' },
  { table: 'Crontabs', column: 'task_before', type: 'TEXT' },
  { table: 'Crontabs', column: 'task_after', type: 'TEXT' },
  { table: 'Crontabs', column: 'log_name', type: 'VARCHAR(255)' },
  {
    table: 'Crontabs',
    column: 'allow_multiple_instances',
    type: 'NUMBER',
  },
  { table: 'Crontabs', column: 'work_dir', type: 'VARCHAR(255)' },
  { table: 'Envs', column: 'isPinned', type: 'NUMBER' },
  { table: 'Envs', column: 'labels', type: 'JSON' },
  { table: 'Crontabs', column: 'queued_token', type: 'VARCHAR(255)' },
  { table: 'Crontabs', column: 'max_queue_wait', type: 'INTEGER' },
  { table: 'Crontabs', column: 'catchup_seconds', type: 'INTEGER' },
  { table: 'Crontabs', column: 'skip_if_pending', type: 'BOOLEAN' },
  { table: 'Crontabs', column: 'recovery_from', type: 'BIGINT' },
  { table: 'Crontabs', column: 'last_instance_id', type: 'INTEGER' },
  { table: 'CrontabStats', column: 'untimed_count', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'CrontabStats', column: 'fixed_max_time', type: 'NUMBER' },
];

export async function migrateSchema(database: Sequelize): Promise<void> {
  await database.transaction(async (transaction) => {
    await database.query(
      'CREATE TABLE IF NOT EXISTS "SchemaMigrations" ("id" TEXT PRIMARY KEY, "applied_at" TEXT NOT NULL)',
      { transaction },
    );
    await installTriggerHistory(database, transaction);
    const applied = await database.query<{ id: string }>(
      'SELECT "id" FROM "SchemaMigrations"',
      { type: QueryTypes.SELECT, transaction },
    );
    const appliedIds = new Set(applied.map(({ id }) => id));
    for (const { table, column, type } of columns) {
      const id = `add-${table}-${column}`;
      const fields = await database.query<{ name: string }>(
        `PRAGMA table_info("${table}")`,
        {
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      if (fields.length === 0)
        throw new Error(`Migration table is missing: ${table}`);
      if (!fields.some((field) => field.name === column)) {
        // table/column/type come only from the static migration manifest above.
        await database.query(
          `ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`,
          { transaction },
        );
      }
      if (!appliedIds.has(id)) {
        await database.query(
          'INSERT INTO "SchemaMigrations" ("id", "applied_at") VALUES (:id, :appliedAt)',
          {
            replacements: { id, appliedAt: new Date().toISOString() },
            transaction,
          },
        );
      }
    }

    const repairId = 'repair-legacy-daily-statistics-v3';
    const prior = appliedIds.has('repair-legacy-daily-statistics-v2') ? 2
      : appliedIds.has('repair-legacy-daily-statistics-v1') ? 1 : 0;
    const retentionId = 'preserve-cron-stat-retention-v1';
    if (!appliedIds.has(retentionId)) {
      if (prior || appliedIds.has(repairId)) {
        // Old cleanup removed complete date prefixes but kept no cutoff. Every
        // surviving date and yesterday (the minimum supported retention) is
        // safe to keep. Older empty dates cannot be distinguished from deletions.
        await database.query(`INSERT OR IGNORE INTO CronStatRetention(id,first_day)
          SELECT 1, MIN(COALESCE(MIN(date),$yesterday),$yesterday) FROM CrontabStats`,
          { bind: { yesterday: dayjs().subtract(1,'day').format('YYYY-MM-DD') }, transaction });
      }
      await database.query('INSERT INTO SchemaMigrations(id,applied_at) VALUES ($id,CURRENT_TIMESTAMP)',
        { bind: { id: retentionId }, transaction });
    }
    if (!appliedIds.has(repairId)) {
      await repairLegacyDailyStatistics(database, transaction, prior);
      // This reconciliation includes v1 and v2. Record all on fresh installations
      // so rolling back and upgrading again cannot replay the superseded repair.
      await database.query(`INSERT OR IGNORE INTO SchemaMigrations(id,applied_at)
        VALUES ('repair-legacy-daily-statistics-v1',CURRENT_TIMESTAMP),('repair-legacy-daily-statistics-v2',CURRENT_TIMESTAMP),($id,CURRENT_TIMESTAMP)`,
        { transaction, bind: { id: repairId } });
    }

    if (!appliedIds.has(prunedExitMigrationId)) {
      // Earlier versions could reclaim the last file before upgrading. The
      // surviving bound booking still identifies the original exit exactly.
      await database.query(`INSERT OR IGNORE INTO CronUnmatchedBoundExits(trigger_id,outcome,finished_at)
        SELECT b.trigger_id,b.outcome,b.finished_at FROM CronLegacyExitBookings b
        WHERE b.bound=1 AND NOT EXISTS (SELECT 1 FROM CronTriggers WHERE id=b.trigger_id)
          AND NOT EXISTS (SELECT 1 FROM CronBoundExitConflicts WHERE trigger_id=b.trigger_id)`, { transaction });
      await database.query('INSERT INTO SchemaMigrations(id,applied_at) VALUES ($id,CURRENT_TIMESTAMP)',
        { bind: { id: prunedExitMigrationId }, transaction });
    }

    // Older databases can contain non-JSON values in Envs.labels. Sequelize
    // parses this column on every environment read, including HTTP startup.
    await database.query(
      `UPDATE "Envs" SET "labels" = '[]'
       WHERE CASE WHEN json_valid("labels")
         THEN json_type("labels") <> 'array'
         ELSE 1
       END`,
      { transaction },
    );
  });
}
