import {
  QueryTypes,
  Sequelize,
  Transaction,
  DataTypes,
  ModelAttributes,
} from 'sequelize';

export async function installTriggerHistory(
  database: Sequelize,
  transaction: Transaction,
) {
  const conflictTable = `CREATE TABLE IF NOT EXISTS CronBoundExitConflicts (
    trigger_id TEXT NOT NULL, outcome TEXT NOT NULL, finished_at INTEGER NOT NULL,
    PRIMARY KEY(trigger_id,outcome,finished_at)) WITHOUT ROWID`;
  const statements: Array<
    string | { table: string; attributes: ModelAttributes }
  > = [
    `CREATE TABLE IF NOT EXISTS CronConcurrencyLeases (
      trigger_id TEXT PRIMARY KEY, token TEXT NOT NULL, owner TEXT NOT NULL,
      command_identity TEXT) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS CronConcurrencyWaiters (
      trigger_id TEXT PRIMARY KEY REFERENCES CronTriggers(id) ON DELETE CASCADE,
      token TEXT NOT NULL, owner TEXT NOT NULL) WITHOUT ROWID`,
    {
      table: 'CronPlanSwitches',
      attributes: {
        seq: { type: DataTypes.INTEGER, primaryKey: true },
        token: { type: DataTypes.TEXT, allowNull: false, unique: true },
        staged_at: { type: DataTypes.INTEGER, allowNull: false },
        first_at: { type: DataTypes.INTEGER },
        last_at: { type: DataTypes.INTEGER },
      },
    },
    'CREATE TABLE IF NOT EXISTS CronPlanCoverage (id INTEGER PRIMARY KEY CHECK(id=1), since INTEGER NOT NULL)',
    {
      table: 'CronPlanRules',
      attributes: {
        cron_id: { type: DataTypes.TEXT, allowNull: false },
        rule_index: { type: DataTypes.INTEGER, allowNull: false },
        schedule: { type: DataTypes.TEXT, allowNull: false },
        zone: { type: DataTypes.TEXT, allowNull: false },
        since: { type: DataTypes.INTEGER, allowNull: false },
        until: { type: DataTypes.INTEGER },
      },
    },
    'CREATE UNIQUE INDEX IF NOT EXISTS cron_plan_active ON CronPlanRules(cron_id,rule_index) WHERE until IS NULL',
    {
      table: 'CronTriggers',
      attributes: {
        id: { type: DataTypes.TEXT, primaryKey: true },
        cron_id: { type: DataTypes.INTEGER, allowNull: false },
        source: { type: DataTypes.TEXT, allowNull: false },
        state: { type: DataTypes.TEXT, allowNull: false },
        scheduled_at: { type: DataTypes.INTEGER },
        queued_at: { type: DataTypes.INTEGER },
        started_at: { type: DataTypes.INTEGER },
        finished_at: { type: DataTypes.INTEGER },
        reason: { type: DataTypes.TEXT },
        exit_code: { type: DataTypes.INTEGER },
        log_path: { type: DataTypes.TEXT },
        counted: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        owner: { type: DataTypes.TEXT },
        observed_at: { type: DataTypes.INTEGER, allowNull: false },
      },
    },
    `CREATE TABLE IF NOT EXISTS CronManualSubmissions (
      trigger_id TEXT PRIMARY KEY REFERENCES CronTriggers(id) ON DELETE CASCADE,
      token TEXT NOT NULL, snapshot TEXT NOT NULL) WITHOUT ROWID`,
    {
      table: 'CronShellBindings',
      attributes: {
        receipt: { type: DataTypes.TEXT, primaryKey: true },
        trigger_id: {
          type: DataTypes.TEXT,
          allowNull: false,
          references: { model: 'CronTriggers', key: 'id' },
          onDelete: 'CASCADE',
        },
      },
    },
    'CREATE INDEX IF NOT EXISTS cron_shell_binding_trigger ON CronShellBindings(trigger_id)',
    `CREATE TABLE IF NOT EXISTS CronExitObservations (
      trigger_id TEXT NOT NULL REFERENCES CronTriggers(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL, finished_at INTEGER NOT NULL,
      PRIMARY KEY(trigger_id,outcome,finished_at)) WITHOUT ROWID`,
    {
      table: 'CronLegacyExitBookings',
      attributes: {
        trigger_id: { type: DataTypes.TEXT, primaryKey: true },
        cron_id: { type: DataTypes.INTEGER, allowNull: false },
        source: { type: DataTypes.TEXT, allowNull: false },
        started_at: { type: DataTypes.INTEGER, allowNull: false },
        finished_at: { type: DataTypes.INTEGER, allowNull: false },
        outcome: { type: DataTypes.TEXT, allowNull: false },
        day: { type: DataTypes.TEXT, allowNull: false },
        stopped: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        stat_id: {
          type: DataTypes.INTEGER,
          references: { model: 'CrontabStats', key: 'id' },
          onDelete: 'SET NULL',
        },
        disputed: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
      },
    },
    `CREATE TABLE IF NOT EXISTS CronPrunedUnknownRuns (
      trigger_id TEXT PRIMARY KEY, cron_id INTEGER NOT NULL REFERENCES Crontabs(id) ON DELETE CASCADE,
      source TEXT NOT NULL, started_at INTEGER NOT NULL, last_possible_day TEXT NOT NULL) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS cron_pruned_unknown_day ON CronPrunedUnknownRuns(last_possible_day)',
    {
      table: 'CronSystemPlans',
      attributes: {
        id: { type: DataTypes.INTEGER, primaryKey: true },
        staged: { type: DataTypes.INTEGER, allowNull: false },
        confirmed: { type: DataTypes.INTEGER },
        zone: { type: DataTypes.TEXT, allowNull: false },
        rules: { type: DataTypes.TEXT, allowNull: false },
      },
    },
    conflictTable,
    `CREATE TABLE IF NOT EXISTS CronUnmatchedBoundExits (
      trigger_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, finished_at INTEGER NOT NULL) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS cron_legacy_booking_stat ON CronLegacyExitBookings(stat_id) WHERE stat_id IS NOT NULL',
    'CREATE TABLE IF NOT EXISTS CronStatRetention (id INTEGER PRIMARY KEY CHECK(id=1), first_day TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS CronHistoryRetention (id INTEGER PRIMARY KEY CHECK(id=1), cutoff INTEGER NOT NULL)',
    {
      table: 'CronStopBatches',
      attributes: {
        request_id: { type: DataTypes.TEXT, primaryKey: true },
        cron_ids: { type: DataTypes.TEXT, allowNull: false },
        snapshot: { type: DataTypes.TEXT },
      },
    },
    'CREATE INDEX IF NOT EXISTS cron_stop_batch_pending ON CronStopBatches(request_id) WHERE snapshot IS NOT NULL',
    {
      table: 'CronStopRequests',
      attributes: {
        instance_id: { type: DataTypes.INTEGER, primaryKey: true },
        cron_id: { type: DataTypes.INTEGER, allowNull: false },
        pid: { type: DataTypes.INTEGER, allowNull: false },
        targets: { type: DataTypes.TEXT },
        signalled: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
      },
    },
    'CREATE INDEX IF NOT EXISTS cron_trigger_recent ON CronTriggers(cron_id, observed_at DESC)',
    "CREATE INDEX IF NOT EXISTS cron_trigger_running_task ON CronTriggers(cron_id) WHERE state='running'",
    "CREATE INDEX IF NOT EXISTS cron_trigger_queued_task ON CronTriggers(cron_id) WHERE state='queued'",
    'CREATE INDEX IF NOT EXISTS cron_trigger_day ON CronTriggers(observed_at)',
    'CREATE INDEX IF NOT EXISTS cron_trigger_slot ON CronTriggers(scheduled_at) WHERE scheduled_at IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS cron_trigger_active ON CronTriggers(source, state) WHERE finished_at IS NULL',
  ];
  for (const statement of statements) {
    if (typeof statement === 'string')
      await database.query(statement, { transaction });
    else
      await database
        .getQueryInterface()
        .createTable(statement.table, statement.attributes, { transaction });
  }
  // Sequelize 6 describeTable cannot inspect expression indexes (the indexed
  // column name is null). Keep PRAGMA introspection for upgrade compatibility.
  const planFields = await database.query<{ name: string }>(
    'PRAGMA table_info(CronPlanRules)',
    { transaction, type: QueryTypes.SELECT },
  );
  for (const column of ['opened_by', 'closed_by']) {
    if (!planFields.some((field) => field.name === column))
      await database
        .getQueryInterface()
        .addColumn(
          'CronPlanRules',
          column,
          { type: DataTypes.TEXT },
          { transaction },
        );
  }
  const conflictFields = await database.query<{ name: string }>(
    'PRAGMA table_info(CronBoundExitConflicts)',
    { transaction, type: QueryTypes.SELECT },
  );
  if (conflictFields.some((field) => field.name === 'other_outcome')) {
    await database
      .getQueryInterface()
      .renameTable('CronBoundExitConflicts', 'CronBoundExitConflictPairs', {
        transaction,
      });
    await database.query(conflictTable, { transaction });
    await database.query(
      `INSERT INTO CronBoundExitConflicts(trigger_id,outcome,finished_at)
      SELECT trigger_id,outcome,finished_at FROM CronBoundExitConflictPairs UNION
      SELECT trigger_id,other_outcome,other_finished_at FROM CronBoundExitConflictPairs`,
      { transaction },
    );
    await database
      .getQueryInterface()
      .dropTable('CronBoundExitConflictPairs', { transaction });
  }
  const bookingFields = await database.query<{ name: string }>(
    'PRAGMA table_info(CronLegacyExitBookings)',
    { transaction, type: QueryTypes.SELECT },
  );
  if (!bookingFields.some((field) => field.name === 'bound'))
    await database
      .getQueryInterface()
      .addColumn(
        'CronLegacyExitBookings',
        'bound',
        { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        { transaction },
      );
  const batchFields = await database.query<{ name: string }>(
    'PRAGMA table_info(CronStopBatches)',
    { transaction, type: QueryTypes.SELECT },
  );
  if (!batchFields.some((column) => column.name === 'status_code'))
    await database
      .getQueryInterface()
      .addColumn(
        'CronStopBatches',
        'status_code',
        { type: DataTypes.INTEGER, allowNull: false, defaultValue: 200 },
        { transaction },
      );
  const stopFields = await database.query<{ name: string }>(
    'PRAGMA table_info(CronStopRequests)',
    { transaction, type: QueryTypes.SELECT },
  );
  if (!stopFields.some((column) => column.name === 'signalled_at'))
    await database
      .getQueryInterface()
      .addColumn(
        'CronStopRequests',
        'signalled_at',
        { type: DataTypes.INTEGER },
        { transaction },
      );
  if (!stopFields.some((column) => column.name === 'root_identity'))
    await database
      .getQueryInterface()
      .addColumn(
        'CronStopRequests',
        'root_identity',
        { type: DataTypes.TEXT },
        { transaction },
      );
  if (!stopFields.some((column) => column.name === 'namespace_owner'))
    await database
      .getQueryInterface()
      .addColumn(
        'CronStopRequests',
        'namespace_owner',
        { type: DataTypes.TEXT },
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
    ['resume_pending', 'INTEGER'],
    ['process_identity', 'TEXT'],
    ['command_identity', 'TEXT'],
    ['stop_exit_at', 'INTEGER'],
    ['stop_exit_verified', 'INTEGER'],
    ['exit_pending', 'INTEGER'],
  ]) {
    if (!fields.some((field) => field.name === column))
      await database
        .getQueryInterface()
        .addColumn(
          'CronTriggers',
          column,
          { type: type === 'TEXT' ? DataTypes.TEXT : DataTypes.INTEGER },
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
