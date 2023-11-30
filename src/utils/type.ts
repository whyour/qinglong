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
