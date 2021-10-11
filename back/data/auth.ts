export class AuthInfo {
  ip?: string;
  type: AuthDataType;
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

export enum AuthDataType {
  'loginLog' = 'loginLog',
  'authToken' = 'authToken',
  'notification' = 'notification',
  'removeLogFrequency' = 'removeLogFrequency',
}
