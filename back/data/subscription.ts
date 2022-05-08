import { sequelize } from '.';
import { DataTypes, Model, ModelDefined } from 'sequelize';
import { SimpleIntervalSchedule } from 'toad-scheduler';

export class Subscription {
  name?: string;
  type?: 'public-repo' | 'private-repo' | 'file';
  schedule?: string | SimpleIntervalSchedule;
  url?: string;
  whitelist?: string;
  blacklist?: string;
  dependences?: string;
  branch?: string;
  status?: SubscriptionStatus;
  pull_type?: 'ssh-key' | 'user-pwd';
  pull_option?:
    | { private_key: string; key_alias: string }
    | { username: string; password: string };
  pid?: string;

  constructor(options: Subscription) {
    this.name = options.name;
    this.type = options.type;
    this.schedule = options.schedule;
    this.url = options.url;
    this.whitelist = options.whitelist;
    this.blacklist = options.blacklist;
    this.dependences = options.dependences;
    this.branch = options.branch;
    this.status = options.status;
    this.pull_type = options.pull_type;
    this.pull_option = options.pull_option;
    this.pid = options.pid;
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
export const CrontabModel = sequelize.define<SubscriptionInstance>(
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
    whitelist: DataTypes.STRING,
    blacklist: DataTypes.STRING,
    status: DataTypes.NUMBER,
    dependences: DataTypes.STRING,
    branch: DataTypes.STRING,
    pull_type: DataTypes.STRING,
    pull_option: DataTypes.JSON,
    pid: DataTypes.NUMBER,
  },
);
