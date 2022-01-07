import { sequelize } from '.';
import { DataTypes, Model, ModelDefined } from 'sequelize';

export class AuthInfo {
  ip?: string;
  type: AuthDataType;
  info?: any;
  id?: number;

  constructor(options: AuthInfo) {
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
}

interface AuthInstance extends Model<AuthInfo, AuthInfo>, AuthInfo {}
export const AuthModel = sequelize.define<AuthInstance>('Auth', {
  ip: DataTypes.STRING,
  type: DataTypes.STRING,
  info: {
    type: DataTypes.JSON,
    allowNull: true,
  },
});
