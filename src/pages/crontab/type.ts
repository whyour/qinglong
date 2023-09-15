export enum CrontabStatus {
  'running' = 0,
  'queued' = 0.5,
  'idle' = 1,
  'disabled',
}

export enum OperationName {
  '启用',
  '禁用',
  '运行',
  '停止',
  '置顶',
  '取消置顶',
}

export enum OperationPath {
  'enable',
  'disable',
  'run',
  'stop',
  'pin',
  'unpin',
}

export interface ICrontab {
  name: string;
  command: string;
  schedule: string;
  id: number;
  status: number;
  isDisabled?: 1 | 0;
  isPinned?: 1 | 0;
  labels?: string[];
  last_running_time?: number;
  last_execution_time?: number;
  nextRunTime: Date;
  sub_id: number;
  extra_schedules?: Array<{ schedule: string; }>;
}
