import { Repository, RecordRow } from './repository';

export class Env {
  value?: string;
  timestamp?: string;
  id?: number;
  status?: EnvStatus;
  position?: number;
  name?: string;
  remarks?: string;
  isPinned?: 1 | 0;
  labels?: string[];

  constructor(options: Env) {
    this.value = options.value;
    this.id = options.id;
    this.status =
      typeof options.status === 'number' && EnvStatus[options.status]
        ? options.status
        : EnvStatus.normal;
    this.timestamp = new Date().toString();
    this.position = options.position;
    this.name = options.name;
    this.remarks = options.remarks || '';
    this.isPinned = options.isPinned || 0;
    this.labels = options.labels || [];
  }
}

export enum EnvStatus {
  'normal',
  'disabled',
}

export const maxPosition = 9000000000000000;
export const initPosition = 4500000000000000;
export const stepPosition = 10000000000;
export const minPosition = 100;

export type EnvInstance = RecordRow<Env>;
export const EnvModel = new Repository<Env>('Env');
