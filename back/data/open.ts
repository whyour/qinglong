export class App {
  name: string;
  scopes: AppScope[];
  client_id: string;
  client_secret: string;
  tokens?: AppToken[];
  _id?: string;

  constructor(options: App) {
    this.name = options.name;
    this.scopes = options.scopes;
    this.client_id = options.client_id;
    this.client_secret = options.client_secret;
    this._id = options._id;
  }
}

export interface AppToken {
  value: string;
  type: 'Bearer';
  expiration: number;
}

export type AppScope = 'envs' | 'crons' | 'configs' | 'scripts' | 'logs';

export enum CrontabStatus {
  'running',
  'idle',
  'disabled',
  'queued',
}
