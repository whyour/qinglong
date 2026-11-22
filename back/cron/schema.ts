import { QueryTypes, Sequelize, Transaction } from 'sequelize';

export async function installTriggerHistory(
  database: Sequelize,
  transaction: Transaction,
) {
  const conflictTable = `CREATE TABLE IF NOT EXISTS CronBoundExitConflicts (
    trigger_id TEXT NOT NULL, outcome TEXT NOT NULL, finished_at INTEGER NOT NULL,
    PRIMARY KEY(trigger_id,outcome,finished_at)) WITHOUT ROWID`;
  const statements = [
    `CREATE TABLE IF NOT EXISTS CronPlanSwitches (seq INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL,
      staged_at INTEGER NOT NULL, first_at INTEGER, last_at INTEGER)`,
    'CREATE TABLE IF NOT EXISTS CronPlanCoverage (id INTEGER PRIMARY KEY CHECK(id=1), since INTEGER NOT NULL)',
    `CREATE TABLE IF NOT EXISTS CronPlanRules (
      cron_id TEXT NOT NULL, rule_index INTEGER NOT NULL, schedule TEXT NOT NULL, zone TEXT NOT NULL,
      since INTEGER NOT NULL, until INTEGER)`,
    'CREATE UNIQUE INDEX IF NOT EXISTS cron_plan_active ON CronPlanRules(cron_id,rule_index) WHERE until IS NULL',
    `CREATE TABLE IF NOT EXISTS CronTriggers (
      id TEXT PRIMARY KEY, cron_id INTEGER NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL,
      scheduled_at INTEGER, queued_at INTEGER, started_at INTEGER, finished_at INTEGER,
      reason TEXT, exit_code INTEGER, log_path TEXT, counted INTEGER NOT NULL DEFAULT 0,
      owner TEXT, observed_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS CronShellBindings (
      receipt TEXT PRIMARY KEY, trigger_id TEXT NOT NULL REFERENCES CronTriggers(id) ON DELETE CASCADE)`,
    'CREATE INDEX IF NOT EXISTS cron_shell_binding_trigger ON CronShellBindings(trigger_id)',
    `CREATE TABLE IF NOT EXISTS CronExitObservations (
      trigger_id TEXT NOT NULL REFERENCES CronTriggers(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL, finished_at INTEGER NOT NULL,
      PRIMARY KEY(trigger_id,outcome,finished_at)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS CronLegacyExitBookings (
      trigger_id TEXT PRIMARY KEY, cron_id INTEGER NOT NULL, source TEXT NOT NULL, started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL, outcome TEXT NOT NULL, day TEXT NOT NULL, stopped INTEGER NOT NULL DEFAULT 0,
      stat_id INTEGER REFERENCES CrontabStats(id) ON DELETE SET NULL, disputed INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS CronPrunedUnknownRuns (
      trigger_id TEXT PRIMARY KEY, cron_id INTEGER NOT NULL REFERENCES Crontabs(id) ON DELETE CASCADE,
      source TEXT NOT NULL, started_at INTEGER NOT NULL, last_possible_day TEXT NOT NULL) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS cron_pruned_unknown_day ON CronPrunedUnknownRuns(last_possible_day)',
    `CREATE TABLE IF NOT EXISTS CronSystemPlans (id INTEGER PRIMARY KEY, staged INTEGER NOT NULL, confirmed INTEGER, zone TEXT NOT NULL, rules TEXT NOT NULL)`,
    conflictTable,
    `CREATE TABLE IF NOT EXISTS CronUnmatchedBoundExits (
      trigger_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, finished_at INTEGER NOT NULL) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS cron_legacy_booking_stat ON CronLegacyExitBookings(stat_id) WHERE stat_id IS NOT NULL',
    'CREATE TABLE IF NOT EXISTS CronStatRetention (id INTEGER PRIMARY KEY CHECK(id=1), first_day TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS CronHistoryRetention (id INTEGER PRIMARY KEY CHECK(id=1), cutoff INTEGER NOT NULL)',
    `CREATE TABLE IF NOT EXISTS CronStopBatches (
      request_id TEXT PRIMARY KEY, cron_ids TEXT NOT NULL, snapshot TEXT)`,
    'CREATE INDEX IF NOT EXISTS cron_stop_batch_pending ON CronStopBatches(request_id) WHERE snapshot IS NOT NULL',
    `CREATE TABLE IF NOT EXISTS CronStopRequests (
      instance_id INTEGER PRIMARY KEY, cron_id INTEGER NOT NULL, pid INTEGER NOT NULL, targets TEXT, signalled INTEGER NOT NULL DEFAULT 0)`,
    'CREATE INDEX IF NOT EXISTS cron_trigger_recent ON CronTriggers(cron_id, observed_at DESC)',
    "CREATE INDEX IF NOT EXISTS cron_trigger_running_task ON CronTriggers(cron_id) WHERE state='running'",
    "CREATE INDEX IF NOT EXISTS cron_trigger_queued_task ON CronTriggers(cron_id) WHERE state='queued'",
    'CREATE INDEX IF NOT EXISTS cron_trigger_day ON CronTriggers(observed_at)',
    'CREATE INDEX IF NOT EXISTS cron_trigger_slot ON CronTriggers(scheduled_at) WHERE scheduled_at IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS cron_trigger_active ON CronTriggers(source, state) WHERE finished_at IS NULL',
  ];
  for (const sql of statements) await database.query(sql, { transaction });
  const planFields = await database.query<{ name: string }>(
    'PRAGMA table_info(CronPlanRules)',
    { transaction, type: QueryTypes.SELECT },
  );
  for (const column of ['opened_by', 'closed_by']) {
    if (!planFields.some((field) => field.name === column))
      await database.query(
        `ALTER TABLE CronPlanRules ADD COLUMN ${column} TEXT`,
        { transaction },
      );
  }
  const conflictFields = await database.query<{ name: string }>(
    'PRAGMA table_info(CronBoundExitConflicts)',
    { transaction, type: QueryTypes.SELECT },
  );
  if (conflictFields.some((field) => field.name === 'other_outcome')) {
    await database.query(
      'ALTER TABLE CronBoundExitConflicts RENAME TO CronBoundExitConflictPairs',
      { transaction },
    );
    await database.query(conflictTable, { transaction });
    await database.query(
      `INSERT INTO CronBoundExitConflicts(trigger_id,outcome,finished_at)
      SELECT trigger_id,outcome,finished_at FROM CronBoundExitConflictPairs UNION
      SELECT trigger_id,other_outcome,other_finished_at FROM CronBoundExitConflictPairs`,
      { transaction },
    );
    await database.query('DROP TABLE CronBoundExitConflictPairs', {
      transaction,
    });
  }
  const bookingFields = await database.query<{ name: string }>(
    'PRAGMA table_info(CronLegacyExitBookings)',
    { transaction, type: QueryTypes.SELECT },
  );
  if (!bookingFields.some((field) => field.name === 'bound'))
    await database.query(
      'ALTER TABLE CronLegacyExitBookings ADD COLUMN bound INTEGER NOT NULL DEFAULT 0',
      { transaction },
    );
  const batchFields = await database.query<{ name: string }>(
    'PRAGMA table_info(CronStopBatches)',
    { transaction, type: QueryTypes.SELECT },
  );
  if (!batchFields.some((column) => column.name === 'status_code'))
    await database.query(
      'ALTER TABLE CronStopBatches ADD COLUMN status_code INTEGER NOT NULL DEFAULT 200',
      { transaction },
    );
  const stopFields = await database.query<{ name: string }>(
    'PRAGMA table_info(CronStopRequests)',
    { transaction, type: QueryTypes.SELECT },
  );
  if (!stopFields.some((column) => column.name === 'signalled_at'))
    await database.query(
      'ALTER TABLE CronStopRequests ADD COLUMN signalled_at INTEGER',
      { transaction },
    );
  if (!stopFields.some((column) => column.name === 'root_identity'))
    await database.query(
      'ALTER TABLE CronStopRequests ADD COLUMN root_identity TEXT',
      { transaction },
    );
  if (!stopFields.some((column) => column.name === 'namespace_owner'))
    await database.query(
      'ALTER TABLE CronStopRequests ADD COLUMN namespace_owner TEXT',
      { transaction },
    );
  const fields = await database.query<{ name: string }>(
    'PRAGMA table_info(CronTriggers)',
    { transaction, type: QueryTypes.SELECT },
  );
  for (const [column, type] of [
    ['queue_live_context', 'TEXT'],
    ['dequeued_at', 'INTEGER'],
    ['system_dispatch_at', 'INTEGER'],
    ['queue_context', 'TEXT'],
    ['system_rule', 'TEXT'],
    ['command_started_at', 'INTEGER'],
    ['instance_id', 'INTEGER'],
    ['script_started_at', 'INTEGER'],
    ['stop_requested', 'INTEGER'],
    ['process_identity', 'TEXT'],
    ['command_identity', 'TEXT'],
    ['stop_exit_at', 'INTEGER'],
    ['stop_exit_verified', 'INTEGER'],
    ['exit_pending', 'INTEGER'],
  ]) {
    if (!fields.some((field) => field.name === column))
      await database.query(
        `ALTER TABLE CronTriggers ADD COLUMN ${column} ${type}`,
        { transaction },
      );
  }
  await database.query(
    `CREATE TRIGGER IF NOT EXISTS cron_exit_observations_settled AFTER UPDATE OF counted ON CronTriggers
    WHEN OLD.exit_pending=1 AND OLD.counted=0 AND NEW.counted=1 BEGIN
      DELETE FROM CronExitObservations WHERE trigger_id=NEW.id;
    END`,
    { transaction },
  );
  await database.query(
    "CREATE INDEX IF NOT EXISTS cron_system_dispatch ON CronTriggers(COALESCE(system_dispatch_at,observed_at)) WHERE source='system'",
    { transaction },
  );
  await database.query(
    'CREATE INDEX IF NOT EXISTS cron_trigger_pending_exit ON CronTriggers(id) WHERE exit_pending=1',
    { transaction },
  );
  await database.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS cron_trigger_instance ON CronTriggers(instance_id) WHERE instance_id IS NOT NULL',
    { transaction },
  );
}
