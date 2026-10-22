import { Repository, RecordRow } from './repository';

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

export type AppScope =
  | 'envs'
  | 'crons'
  | 'configs'
  | 'scripts'
  | 'logs'
  | 'system'
  | 'dashboard';

export type AppInstance = RecordRow<App>;
export const AppModel = new Repository<App>('App');
