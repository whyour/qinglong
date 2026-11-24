import {
  defineCrontabModel,
  defineRunningInstanceModel,
  defineCrontabStatModel,
  defineSystemModel,
} from './executionModelDefinitions';
import {
  DataTypes,
  Model,
  ModelStatic,
  Sequelize,
  ModelAttributes,
} from 'sequelize';
import type { Literal, Fn, Col } from 'sequelize/types/utils';
import type { CronInstance } from './cron';
import type { RunningInstanceModel } from './runningInstance';
import type { CrontabStatInstance } from './cronStats';
import type { SystemInstance } from './system';
import type { TriggerSource, TriggerState } from '../cron/types';

// Ledger tables are installed by versioned migrations, not Model.sync().
// Bind each mapping to its caller's connection: workers and test databases must
// never share the application's singleton or silently open another transaction.
interface LedgerRows {
  CronPlanCoverage: { id: number; since: number };
  CronTriggers: {
    id: string;
    source: TriggerSource;
    state: TriggerState;
    reason: string | null;
    log_path: string | null;
    owner: string | null;
    queue_context: string | null;
    queue_live_context: string | null;
    system_rule: string | null;
    process_identity: string | null;
    command_identity: string | null;
    cron_id: number;
    scheduled_at: number | null;
    queued_at: number | null;
    started_at: number | null;
    finished_at: number | null;
    exit_code: number | null;
    counted: number;
    observed_at: number;
    dequeued_at: number | null;
    system_dispatch_at: number | null;
    command_started_at: number | null;
    instance_id: number | null;
    script_started_at: number | null;
    stop_requested: number | null;
    resume_pending: number | null;
    stop_exit_at: number | null;
    stop_exit_verified: number | null;
    exit_pending: number | null;
  };
  CronConcurrencyLeases: {
    trigger_id: string;
    token: string;
    owner: string;
    command_identity: string | null;
  };
  CronConcurrencyWaiters: {
    trigger_id: string;
    token: string;
    owner: string;
  };
  CronStopRequests: {
    targets: string | null;
    root_identity: string | null;
    namespace_owner: string | null;
    instance_id: number;
    cron_id: number;
    pid: number | null;
    signalled: number;
    signalled_at: number | null;
  };
  CronStopBatches: {
    request_id: string;
    cron_ids: string;
    snapshot: string | null;
    status_code: number;
  };
  CronManualSubmissions: {
    trigger_id: string;
    token: string;
    snapshot: string;
  };
  CronShellBindings: {
    receipt: string;
    trigger_id: string | null;
  };
  CronExitObservations: {
    trigger_id: string;
    outcome: string;
    finished_at: number;
  };
  CronBoundExitConflicts: {
    trigger_id: string;
    outcome: string;
    finished_at: number;
  };
  CronUnmatchedBoundExits: {
    trigger_id: string;
    outcome: string | null;
    finished_at: number | null;
  };
  CronLegacyExitBookings: {
    trigger_id: string;
    source: TriggerSource;
    outcome: string | null;
    day: string | null;
    cron_id: number;
    started_at: number | null;
    finished_at: number | null;
    stopped: number | null;
    stat_id: number | null;
    disputed: number | null;
    bound: number | null;
  };
  CronPrunedUnknownRuns: {
    trigger_id: string;
    source: TriggerSource;
    last_possible_day: string;
    cron_id: number;
    started_at: number;
  };
  CronHistoryRetention: {
    id: number;
    cutoff: number;
  };
  CronPlanSwitches: {
    token: string;
    seq: number;
    staged_at: number | null;
    first_at: number | null;
    last_at: number | null;
  };
  CronSystemPlans: {
    zone: string;
    rules: string;
    id: number;
    staged: number;
    confirmed: number | null;
  };
  SchemaMigrations: {
    id: string;
    applied_at: string;
  };
}

type Persisted<T> = {
  [K in keyof T]-?: undefined extends T[K]
    ? Exclude<T[K], undefined> | null
    : T[K];
} & { id: number; createdAt: Date; updatedAt: Date };
type ExistingRows = {
  Crontabs: Persisted<CronInstance['_attributes']>;
  RunningInstances: Persisted<RunningInstanceModel['_attributes']>;
  CrontabStats: Persisted<CrontabStatInstance['_attributes']>;
  Auths: Persisted<SystemInstance['_attributes']>;
};
type Rows = LedgerRows & ExistingRows;
type Creation<T> = { [K in keyof T]?: T[K] | Literal | Fn | Col };
type RowModel<T extends object> = Model<T, Creation<T>> & T;
const definitions: {
  [K in keyof LedgerRows]: ModelAttributes<RowModel<LedgerRows[K]>>;
} = {
  CronPlanCoverage: {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    since: DataTypes.BIGINT,
  },
  CronTriggers: {
    id: { type: DataTypes.TEXT, primaryKey: true },
    source: DataTypes.TEXT,
    state: DataTypes.TEXT,
    reason: DataTypes.TEXT,
    log_path: DataTypes.TEXT,
    owner: DataTypes.TEXT,
    queue_context: DataTypes.TEXT,
    queue_live_context: DataTypes.TEXT,
    system_rule: DataTypes.TEXT,
    process_identity: DataTypes.TEXT,
    command_identity: DataTypes.TEXT,
    cron_id: DataTypes.BIGINT,
    scheduled_at: DataTypes.BIGINT,
    queued_at: DataTypes.BIGINT,
    started_at: DataTypes.BIGINT,
    finished_at: DataTypes.BIGINT,
    exit_code: DataTypes.BIGINT,
    counted: DataTypes.BIGINT,
    observed_at: DataTypes.BIGINT,
    dequeued_at: DataTypes.BIGINT,
    system_dispatch_at: DataTypes.BIGINT,
    command_started_at: DataTypes.BIGINT,
    instance_id: DataTypes.BIGINT,
    script_started_at: DataTypes.BIGINT,
    stop_requested: DataTypes.BIGINT,
    resume_pending: DataTypes.BIGINT,
    stop_exit_at: DataTypes.BIGINT,
    stop_exit_verified: DataTypes.BIGINT,
    exit_pending: DataTypes.BIGINT,
  },
  CronConcurrencyLeases: {
    trigger_id: { type: DataTypes.TEXT, primaryKey: true },
    token: DataTypes.TEXT,
    owner: DataTypes.TEXT,
    command_identity: DataTypes.TEXT,
  },
  CronConcurrencyWaiters: {
    trigger_id: { type: DataTypes.TEXT, primaryKey: true },
    token: DataTypes.TEXT,
    owner: DataTypes.TEXT,
  },
  CronStopRequests: {
    targets: DataTypes.TEXT,
    root_identity: DataTypes.TEXT,
    namespace_owner: DataTypes.TEXT,
    instance_id: { type: DataTypes.INTEGER, primaryKey: true },
    cron_id: DataTypes.BIGINT,
    pid: DataTypes.BIGINT,
    signalled: DataTypes.BIGINT,
    signalled_at: DataTypes.BIGINT,
  },
  CronStopBatches: {
    request_id: { type: DataTypes.TEXT, primaryKey: true },
    cron_ids: DataTypes.TEXT,
    snapshot: DataTypes.TEXT,
    status_code: DataTypes.BIGINT,
  },
  CronManualSubmissions: {
    trigger_id: { type: DataTypes.TEXT, primaryKey: true },
    token: DataTypes.TEXT,
    snapshot: DataTypes.TEXT,
  },
  CronShellBindings: {
    receipt: { type: DataTypes.TEXT, primaryKey: true },
    trigger_id: DataTypes.TEXT,
  },
  CronExitObservations: {
    trigger_id: { type: DataTypes.TEXT, primaryKey: true },
    outcome: { type: DataTypes.TEXT, primaryKey: true },
    finished_at: { type: DataTypes.INTEGER, primaryKey: true },
  },
  CronBoundExitConflicts: {
    trigger_id: { type: DataTypes.TEXT, primaryKey: true },
    outcome: { type: DataTypes.TEXT, primaryKey: true },
    finished_at: { type: DataTypes.INTEGER, primaryKey: true },
  },
  CronUnmatchedBoundExits: {
    trigger_id: { type: DataTypes.TEXT, primaryKey: true },
    outcome: DataTypes.TEXT,
    finished_at: DataTypes.BIGINT,
  },
  CronLegacyExitBookings: {
    trigger_id: { type: DataTypes.TEXT, primaryKey: true },
    source: DataTypes.TEXT,
    outcome: DataTypes.TEXT,
    day: DataTypes.TEXT,
    cron_id: DataTypes.BIGINT,
    started_at: DataTypes.BIGINT,
    finished_at: DataTypes.BIGINT,
    stopped: DataTypes.BIGINT,
    stat_id: DataTypes.BIGINT,
    disputed: DataTypes.BIGINT,
    bound: DataTypes.BIGINT,
  },
  CronPrunedUnknownRuns: {
    trigger_id: { type: DataTypes.TEXT, primaryKey: true },
    source: DataTypes.TEXT,
    last_possible_day: DataTypes.TEXT,
    cron_id: DataTypes.BIGINT,
    started_at: DataTypes.BIGINT,
  },
  CronHistoryRetention: {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    cutoff: DataTypes.BIGINT,
  },
  CronPlanSwitches: {
    token: DataTypes.TEXT,
    seq: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    staged_at: DataTypes.BIGINT,
    first_at: DataTypes.BIGINT,
    last_at: DataTypes.BIGINT,
  },
  CronSystemPlans: {
    zone: DataTypes.TEXT,
    rules: DataTypes.TEXT,
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    staged: DataTypes.BIGINT,
    confirmed: DataTypes.BIGINT,
  },
  SchemaMigrations: {
    id: { type: DataTypes.TEXT, primaryKey: true },
    applied_at: DataTypes.TEXT,
  },
};
const existingNames: Record<keyof ExistingRows, string> = {
  Crontabs: 'Crontab',
  RunningInstances: 'RunningInstance',
  CrontabStats: 'CrontabStat',
  Auths: 'Auth',
};

export function executionModel<K extends keyof Rows>(
  database: Sequelize,
  table: K,
): ModelStatic<RowModel<Rows[K]>> {
  const name =
    table in existingNames ? existingNames[table as keyof ExistingRows] : table;
  if (!database.isDefined(name)) {
    if (table === 'Crontabs') defineCrontabModel(database);
    else if (table === 'RunningInstances') defineRunningInstanceModel(database);
    else if (table === 'CrontabStats') defineCrontabStatModel(database);
    else if (table === 'Auths') defineSystemModel(database);
    else
      database.define(
        name,
        definitions[table as keyof LedgerRows] as ModelAttributes,
        { tableName: table, timestamps: false, freezeTableName: true },
      );
  }
  return database.model(name) as ModelStatic<RowModel<Rows[K]>>;
}

const relationships = {
  leaseTrigger: [
    'CronConcurrencyLeases',
    'CronTriggers',
    'trigger',
    'trigger_id',
    'id',
  ],
  waiterTrigger: [
    'CronConcurrencyWaiters',
    'CronTriggers',
    'trigger',
    'trigger_id',
    'id',
  ],
  submissionTrigger: [
    'CronManualSubmissions',
    'CronTriggers',
    'trigger',
    'trigger_id',
    'id',
  ],
  triggerStop: [
    'CronTriggers',
    'CronStopRequests',
    'stop',
    'instance_id',
    'instance_id',
  ],
  triggerTask: ['CronTriggers', 'Crontabs', 'task', 'cron_id', 'id'],
  instanceTrigger: [
    'RunningInstances',
    'CronTriggers',
    'trigger',
    'instance_id',
    'id',
  ],
} as const;

// Associations describe existing joins only; migrations own foreign keys.
export function executionAssociation(
  database: Sequelize,
  relation: keyof typeof relationships,
) {
  const [from, to, as, foreignKey, key] = relationships[relation];
  const source: ModelStatic<Model> = executionModel(database, from);
  if (!source.associations[as]) {
    const target: ModelStatic<Model> = executionModel(database, to);
    if (relation === 'instanceTrigger')
      source.hasOne(target, {
        as,
        foreignKey,
        sourceKey: key,
        constraints: false,
      });
    else
      source.belongsTo(target, {
        as,
        foreignKey,
        targetKey: key,
        constraints: false,
      });
  }
  return source.associations[as];
}
