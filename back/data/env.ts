import { sequelize } from '.';
import { DataTypes, Model, ModelDefined } from 'sequelize';

export class Env {
  value?: string;
  timestamp?: string;
  id?: number;
  status?: EnvStatus;
  position?: number;
  name?: string;
  remarks?: string;

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
});
