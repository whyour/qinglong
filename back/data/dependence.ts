import { sequelize } from '.';
import { DataTypes, Model, ModelDefined } from 'sequelize';

export class Dependence {
  timestamp?: string;
  id?: number;
  status: DependenceStatus;
  type: DependenceTypes;
  name: string;
  log?: string[];
  remark?: string;
  userId?: number;

  constructor(options: Dependence) {
    this.id = options.id;
    this.status =
      typeof options.status === 'number' && DependenceStatus[options.status]
        ? options.status
        : DependenceStatus.queued;
    this.type = options.type || DependenceTypes.nodejs;
    this.timestamp = new Date().toString();
    this.name = options.name.trim();
    this.log = options.log || [];
    this.remark = options.remark || '';
    this.userId = options.userId;
  }
}

export enum DependenceStatus {
  'installing',
  'installed',
  'installFailed',
  'removing',
  'removed',
  'removeFailed',
  'queued',
  'cancelled',
}

export enum DependenceTypes {
  'nodejs',
  'python3',
  'linux',
}

export enum versionDependenceCommandTypes {
  '@',
  '==',
  '=',
}

export interface DependenceInstance
  extends Model<Dependence, Dependence>,
    Dependence {}
export const DependenceModel = sequelize.define<DependenceInstance>(
  'Dependence',
  {
    name: DataTypes.STRING,
    type: DataTypes.NUMBER,
    timestamp: DataTypes.STRING,
    status: DataTypes.NUMBER,
    log: DataTypes.JSON,
    remark: DataTypes.STRING,
    userId: { type: DataTypes.NUMBER, allowNull: true },
  },
);
