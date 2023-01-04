export class SockMessage {
  message?: string;
  type?: SockMessageType;
  references?: number[];

  constructor(options: SockMessage) {
    this.type = options.type;
    this.message = options.message;
    this.references = options.references;
  }
}

export type SockMessageType =
  | 'ping'
  | 'installDependence'
  | 'uninstallDependence'
  | 'updateSystemVersion'
  | 'manuallyRunScript'
  | 'runSubscriptionEnd';
