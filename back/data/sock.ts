export class SockMessage {
  message?: string;
  type?: SockMessageType;
  references?: number[];
  status?: number | string;

  constructor(options: SockMessage) {
    this.type = options.type;
    this.message = options.message;
    this.references = options.references;
    this.status = options.status;
  }
}

export type SockMessageType =
  | 'ping'
  | 'installDependence'
  | 'uninstallDependence'
  | 'updateSystemVersion'
  | 'manuallyRunScript'
  | 'runSubscriptionEnd'
  | 'reloadSystem'
  | 'updateNodeMirror'
  | 'updateLinuxMirror';
