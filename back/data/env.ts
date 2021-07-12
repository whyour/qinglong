export class Env {
  value?: string;
  timestamp?: string;
  created?: number;
  _id?: string;
  status?: EnvStatus;
  position?: number;
  name?: number;
  remarks?: number;

  constructor(options: Env) {
    this.value = options.value;
    this._id = options._id;
    this.created = options.created || new Date().valueOf();
    this.status = options.status || EnvStatus.normal;
    this.timestamp = new Date().toString();
    this.position = options.position;
    this.name = options.name;
    this.remarks = options.remarks;
  }
}

export enum EnvStatus {
  'normal',
  'disabled',
}

export const initEnvPosition = 9999999999;
