import { sequelize } from '.';
import { DataTypes, Model, ModelDefined } from 'sequelize';
import { SimpleIntervalSchedule } from 'toad-scheduler';

type SimpleIntervalScheduleUnit = keyof SimpleIntervalSchedule;
export class Subscription {
  id?: number;
  name?: string;
  type?: 'public-repo' | 'private-repo' | 'file';
  schedule_type?: 'crontab' | 'interval';
  schedule?: string;
  interval_schedule?: { type: SimpleIntervalScheduleUnit; value: number };
  url?: string;
  whitelist?: string;
  blacklist?: string;
  dependences?: string;
  branch?: string;
  status?: SubscriptionStatus;
  pull_type?: 'ssh-key' | 'user-pwd';
  pull_option?:
    | { private_key: string }
    | { username: string; password: string };
  pid?: number;
  is_disabled?: 1 | 0;
  log_path?: string;
  alias: string;
  command?: string;
  extensions?: string;
  sub_before?: string;
  sub_after?: string;

  constructor(options: Subscription) {
    this.id = options.id;
    this.name = options.name || options.alias;
    this.type = options.type;
    this.schedule = options.schedule;
    this.status =
      options.status && SubscriptionStatus[options.status]
        ? options.status
        : SubscriptionStatus.idle;
    this.url = options.url;
    this.whitelist = options.whitelist;
    this.blacklist = options.blacklist;
    this.dependences = options.dependences;
    this.branch = options.branch;
    this.pull_type = options.pull_type;
    this.pull_option = options.pull_option;
    this.pid = options.pid;
    this.is_disabled = options.is_disabled;
    this.log_path = options.log_path;
    this.schedule_type = options.schedule_type;
    this.alias = options.alias;
    this.interval_schedule = options.interval_schedule;
    this.extensions = options.extensions;
    this.sub_before = options.sub_before;
    this.sub_after = options.sub_after;
  }
}

export enum SubscriptionStatus {
  'running',
  'idle',
  'disabled',
  'queued',
}

interface SubscriptionInstance
  extends Model<Subscription, Subscription>,
    Subscription {}
export const SubscriptionModel = sequelize.define<SubscriptionInstance>(
  'Subscription',
  {
    name: {
      unique: 'compositeIndex',
      type: DataTypes.STRING,
    },
    url: {
      unique: 'compositeIndex',
      type: DataTypes.STRING,
    },
    schedule: {
      unique: 'compositeIndex',
      type: DataTypes.STRING,
    },
    interval_schedule: {
      unique: 'compositeIndex',
      type: DataTypes.JSON,
    },
    type: DataTypes.STRING,
    whitelist: DataTypes.STRING,
    blacklist: DataTypes.STRING,
    status: DataTypes.NUMBER,
    dependences: DataTypes.STRING,
    extensions: DataTypes.STRING,
    sub_before: DataTypes.STRING,
    sub_after: DataTypes.STRING,
    branch: DataTypes.STRING,
    pull_type: DataTypes.STRING,
    pull_option: DataTypes.JSON,
    pid: DataTypes.NUMBER,
    is_disabled: DataTypes.NUMBER,
    log_path: DataTypes.STRING,
    schedule_type: DataTypes.STRING,
    alias: { type: DataTypes.STRING, unique: 'alias' },
  },
);
