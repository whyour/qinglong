import { DataTypes, Model } from 'sequelize';
import { sequelize } from '.';

export class SshKey {
  id?: number;
  alias: string;
  private_key: string;
  remarks?: string;
  status?: SshKeyStatus;
  timestamp?: string;

  constructor(options: SshKey) {
    this.id = options.id;
    this.alias = options.alias;
    this.private_key = options.private_key;
    this.remarks = options.remarks || '';
    this.status =
      typeof options.status === 'number' && SshKeyStatus[options.status]
        ? options.status
        : SshKeyStatus.normal;
    this.timestamp = new Date().toString();
  }
}

export enum SshKeyStatus {
  'normal',
  'disabled',
}

export interface SshKeyInstance extends Model<SshKey, SshKey>, SshKey {}
export const SshKeyModel = sequelize.define<SshKeyInstance>('SshKey', {
  alias: { type: DataTypes.STRING, unique: true },
  private_key: DataTypes.TEXT,
  remarks: DataTypes.STRING,
  status: DataTypes.NUMBER,
  timestamp: DataTypes.STRING,
});
