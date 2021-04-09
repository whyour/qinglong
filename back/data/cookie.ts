export class Cookie {
  value?: string;
  timestamp?: string;
  created?: number;
  _id?: string;
  status?: CookieStatus;
  position?: number;

  constructor(options: Cookie) {
    this.value = options.value;
    this._id = options._id;
    this.created = options.created || new Date().valueOf();
    this.status = options.status || CookieStatus.noacquired;
    this.timestamp = new Date().toString();
    this.position = options.position;
  }
}

export enum CookieStatus {
  'noacquired',
  'normal',
  'disabled',
  'invalid',
  'abnormal',
}

export const initCookiePosition = 9999999999;
