import { sequelize } from '.';
import { DataTypes, Model, ModelDefined } from 'sequelize';

export class Crontab {
  name?: string;
  command: string;
  schedule?: string;
  timestamp?: string;
  saved?: boolean;
  id?: number;
  status?: CrontabStatus;
  isSystem?: 1 | 0;
  pid?: number;
  isDisabled?: 1 | 0;
  log_path?: string;
  isPinned?: 1 | 0;
  labels?: string[];
  last_running_time?: number;
  last_execution_time?: number;

  constructor(options: Crontab) {
    this.name = options.name;
    this.command = options.command;
    this.schedule = options.schedule;
    this.saved = options.saved;
    this.id = options.id;
    this.status =
      options.status && CrontabStatus[options.status]
        ? options.status
        : CrontabStatus.idle;
    this.timestamp = new Date().toString();
    this.isSystem = options.isSystem || 0;
    this.pid = options.pid;
    this.isDisabled = options.isDisabled || 0;
    this.log_path = options.log_path || '';
    this.isPinned = options.isPinned || 0;
    this.labels = options.labels || [];
    this.last_running_time = options.last_running_time || 0;
    this.last_execution_time = options.last_execution_time || 0;
  }
}

export enum CrontabStatus {
  'running',
  'idle',
  'disabled',
  'queued',
}

interface CronInstance extends Model<Crontab, Crontab>, Crontab {}
export const CrontabModel = sequelize.define<CronInstance>('Crontab', {
  name: {
    unique: 'compositeIndex',
    type: DataTypes.STRING,
  },
  command: {
    unique: 'compositeIndex',
    type: DataTypes.STRING,
  },
  schedule: {
    unique: 'compositeIndex',
    type: DataTypes.STRING,
  },
  timestamp: DataTypes.STRING,
  saved: DataTypes.BOOLEAN,
  status: DataTypes.NUMBER,
  isSystem: DataTypes.NUMBER,
  pid: DataTypes.NUMBER,
  isDisabled: DataTypes.NUMBER,
  isPinned: DataTypes.NUMBER,
  log_path: DataTypes.STRING,
  labels: DataTypes.JSON,
  last_running_time: DataTypes.NUMBER,
  last_execution_time: DataTypes.NUMBER,
});
