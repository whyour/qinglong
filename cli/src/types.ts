export interface Credentials {
  url: string;
  clientId: string;
  clientSecret: string;
}

export interface StoredConfig extends Credentials {
  token?: string;
  expiration?: number;
}

export interface Session extends Credentials {
  token: string;
  expiration: number;
}

export interface ApiResponse<T> {
  code: 200;
  data: T;
}

// Preserve additional 2.x fields without depending on backend modules or ORM types.
export interface Task {
  id: number;
  [field: string]: unknown;
}

export interface TaskList {
  data: Task[];
  total: number;
}

export interface LogResponse extends ApiResponse<string> {
  logStatus?: string;
  truncated: boolean;
}

export type Command =
  | { kind: 'help' }
  | { kind: 'login'; url: string }
  | { kind: 'status'; scope?: 'crons' | 'subscriptions' }
  | { kind: 'logout' }
  | { kind: 'list'; search?: string; page: number; size: number }
  | { kind: 'get'; id: number }
  | { kind: 'logs'; id: number; tail: number }
  | { kind: 'run' | 'stop'; id: number };
