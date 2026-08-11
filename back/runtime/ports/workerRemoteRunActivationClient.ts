import type {
  AcknowledgeRemoteRunRunningCommand,
  AcknowledgeRemoteRunStartingCommand,
  FailRemoteRunStartCommand,
  RemoteRunActivationResult,
} from '../application/remoteRunActivationService';

export interface WorkerRemoteRunActivationClient {
  acknowledgeStarting(
    command: AcknowledgeRemoteRunStartingCommand,
  ): Promise<RemoteRunActivationResult>;
  acknowledgeRunning(
    command: AcknowledgeRemoteRunRunningCommand,
  ): Promise<RemoteRunActivationResult>;
  failStart(
    command: FailRemoteRunStartCommand,
  ): Promise<RemoteRunActivationResult>;
}
