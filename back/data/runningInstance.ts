import { Repository, RecordRow } from './repository';

export enum InstanceStatus {
  'running' = 0,
  'finished' = 1,
  'stopped' = 2,
  'error' = 3,
}

export interface RunningInstanceAttributes {
  id?: number;
  cron_id: number;
  pid?: number;
  log_path?: string;
  started_at: number;
  finished_at?: number;
  status: InstanceStatus;
  exit_code?: number;
}

export class RunningInstance {
  id?: number;
  cron_id!: number;
  pid?: number;
  log_path?: string;
  started_at!: number;
  finished_at?: number;
  status!: InstanceStatus;
  exit_code?: number;

  constructor(options: RunningInstanceAttributes) {
    this.id = options.id;
    this.cron_id = options.cron_id;
    this.pid = options.pid;
    this.log_path = options.log_path;
    this.started_at = options.started_at;
    this.finished_at = options.finished_at;
    this.status = options.status;
    this.exit_code = options.exit_code;
  }
}

export type RunningInstanceModel = RecordRow<RunningInstanceAttributes>;
export const RunningInstanceModel = new Repository<RunningInstanceAttributes>(
  'RunningInstance',
);
