export class Crontab {
  name?: string;
  command: string;
  schedule: string;
  timestamp?: string;
  created?: number;
  saved?: boolean;
  _id?: string;
  status?: CrontabStatus;
  isSystem?: 1 | 0;
  pid?: number;
  isDisabled?: 1 | 0;
  log_path?: string;

  constructor(options: Crontab) {
    this.name = options.name;
    this.command = options.command;
    this.schedule = options.schedule;
    this.saved = options.saved;
    this._id = options._id;
    this.created = options.created;
    this.status = CrontabStatus[options.status]
      ? options.status
      : CrontabStatus.idle;
    this.timestamp = new Date().toString();
    this.isSystem = options.isSystem || 0;
    this.pid = options.pid;
    this.isDisabled = options.isDisabled || 0;
    this.log_path = options.log_path || '';
  }
}

export enum CrontabStatus {
  'running',
  'idle',
  'disabled',
  'queued',
}
