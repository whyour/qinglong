import { sequelize } from '.';
import { DataTypes, Model, ModelDefined } from 'sequelize';

export class App {
  name: string;
  scopes: AppScope[];
  client_id: string;
  client_secret: string;
  tokens?: AppToken[];
  id?: number;

  constructor(options: App) {
    this.name = options.name;
    this.scopes = options.scopes;
    this.client_id = options.client_id;
    this.client_secret = options.client_secret;
    this.id = options.id;
  }
}

export interface AppToken {
  value: string;
  type?: 'Bearer';
  expiration: number;
}

export type AppScope = 'envs' | 'crons' | 'configs' | 'scripts' | 'logs';

export enum CrontabStatus {
  'running',
  'idle',
  'disabled',
  'queued',
}

interface AppInstance extends Model<App, App>, App {}
export const AppModel = sequelize.define<AppInstance>('App', {
  name: { type: DataTypes.STRING, unique: 'name' },
  scopes: DataTypes.JSON,
  client_id: DataTypes.STRING,
  client_secret: DataTypes.STRING,
  tokens: DataTypes.JSON,
});
