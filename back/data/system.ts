import { sequelize } from '.';
import { DataTypes, Model, ModelDefined } from 'sequelize';
import { NotificationInfo } from './notify';

export class SystemInfo {
  ip?: string;
  type: AuthDataType;
  info?: SystemModelInfo;
  id?: number;

  constructor(options: SystemInfo) {
    this.ip = options.ip;
    this.info = options.info;
    this.type = options.type;
    this.id = options.id;
  }
}

export enum LoginStatus {
  'success',
  'fail',
}

export enum AuthDataType {
  'loginLog' = 'loginLog',
  'authToken' = 'authToken',
  'notification' = 'notification',
  'removeLogFrequency' = 'removeLogFrequency',
  'systemConfig' = 'systemConfig',
  'authConfig' = 'authConfig',
}

export interface SystemConfigInfo {
  logRemoveFrequency?: number;
  cronConcurrency?: number;
  dependenceProxy?: string;
  nodeMirror?: string;
  pythonMirror?: string;
  linuxMirror?: string;
}

export interface LoginLogInfo {
  timestamp?: number;
  address?: string;
  ip?: string;
  platform?: string;
  status?: LoginStatus;
}

export interface AuthInfo {
  username: string;
  password: string;
  retries: number;
  lastlogon: number;
  lastip: string;
  lastaddr: string;
  platform: string;
  isTwoFactorChecking: boolean;
  token: string;
  tokens: Record<string, string>;
  twoFactorActivated: boolean;
  twoFactorActived: boolean;
  twoFactorSecret: string;
  avatar: string;
}

export type SystemModelInfo = SystemConfigInfo &
  Partial<NotificationInfo> &
  LoginLogInfo &
  Partial<AuthInfo>;

export interface SystemInstance
  extends Model<SystemInfo, SystemInfo>,
    SystemInfo {}
export const SystemModel = sequelize.define<SystemInstance>('Auth', {
  ip: DataTypes.STRING,
  type: DataTypes.STRING,
  info: {
    type: DataTypes.JSON,
    allowNull: true,
  },
});
