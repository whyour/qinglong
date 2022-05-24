import { sequelize } from '.';
import { DataTypes, Model, ModelDefined } from 'sequelize';

export class Dependence {
  timestamp?: string;
  id?: number;
  status?: DependenceStatus;
  type?: DependenceTypes;
  name?: number;
  log?: string[];
  remark?: string;

  constructor(options: Dependence) {
    this.id = options.id;
    this.status = options.status || DependenceStatus.installing;
    this.type = options.type || DependenceTypes.nodejs;
    this.timestamp = new Date().toString();
    this.name = options.name;
    this.log = options.log || [];
    this.remark = options.remark || '';
  }
}

export enum DependenceStatus {
  'installing',
  'installed',
  'installFailed',
  'removing',
  'removed',
  'removeFailed',
}

export enum DependenceTypes {
  'nodejs',
  'python3',
  'linux',
}

export enum InstallDependenceCommandTypes {
  'pnpm add -g',
  'pip3 install',
  'apk add',
}

export enum unInstallDependenceCommandTypes {
  'pnpm remove -g',
  'pip3 uninstall -y',
  'apk del',
}

interface DependenceInstance
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
  },
);
