export class AuthInfo {
  ip?: string;
  type: AuthInfoType;
  info?: any;
  _id?: string;

  constructor(options: AuthInfo) {
    this.ip = options.ip;
    this.info = options.info;
    this.type = options.type;
    this._id = options._id;
  }
}

export enum LoginStatus {
  'success',
  'fail',
}

export type AuthInfoType = 'loginLog' | 'authToken';
