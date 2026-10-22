import { Repository, RecordRow } from './repository';
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
  pid?: number | null;
  is_disabled?: 1 | 0;
  log_path?: string;
  alias: string;
  command?: string;
  extensions?: string;
  sub_before?: string;
  sub_after?: string;
  proxy?: string;
  autoAddCron?: 1 | 0;
  autoDelCron?: 1 | 0;

  constructor(options: Subscription) {
    this.id = options.id;
    this.name = options.name || options.alias;
    this.type = options.type;
    this.schedule = options.schedule;
    this.status = this.status =
      typeof options.status === 'number' && SubscriptionStatus[options.status]
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
    this.proxy = options.proxy;
    this.autoAddCron = options.autoAddCron ? 1 : 0;
    this.autoDelCron = options.autoDelCron ? 1 : 0;
  }
}

export enum SubscriptionStatus {
  'running',
  'idle',
  'disabled',
  'queued',
}

export type SubscriptionInstance = RecordRow<Subscription>;
export const SubscriptionModel = new Repository<Subscription>('Subscription');
