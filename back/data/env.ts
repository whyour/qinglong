import { DataTypes, Model } from 'sequelize';
import { sequelize } from '.';

export class Env {
  value?: string;
  timestamp?: string;
  id?: number;
  status?: EnvStatus;
  position?: number;
  name?: string;
  remarks?: string;
  isPinned?: 1 | 0;

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

export interface EnvInstance extends Model<Env, Env>, Env {}
export const EnvModel = sequelize.define<EnvInstance>('Env', {
  value: { type: DataTypes.STRING, unique: 'compositeIndex' },
  timestamp: DataTypes.STRING,
  status: DataTypes.NUMBER,
  position: DataTypes.NUMBER,
  name: { type: DataTypes.STRING, unique: 'compositeIndex' },
  remarks: DataTypes.STRING,
  isPinned: DataTypes.NUMBER,
});
