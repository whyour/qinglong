import type {
  AcknowledgeRemoteRunRunningCommand,
  AcknowledgeRemoteRunStartingCommand,
  FailRemoteRunStartCommand,
  RemoteRunActivationResult,
} from './remoteRunActivationService';
import { RemoteRunActivationService } from './remoteRunActivationService';
import type { AuthenticatedWorkerPrincipal } from './workerControlService';
import type { WorkerRemoteRunActivationClient } from '../ports/workerRemoteRunActivationClient';

/** The transport authenticates once; Worker request bodies cannot select a principal. */
export class BoundWorkerRemoteRunActivationClient
  implements WorkerRemoteRunActivationClient
{
  constructor(
    private readonly service: RemoteRunActivationService,
    private readonly principal: AuthenticatedWorkerPrincipal,
  ) {}

  acknowledgeStarting(
    command: AcknowledgeRemoteRunStartingCommand,
  ): Promise<RemoteRunActivationResult> {
    return this.service.acknowledgeStarting(this.principal, command);
  }

  acknowledgeRunning(
    command: AcknowledgeRemoteRunRunningCommand,
  ): Promise<RemoteRunActivationResult> {
    return this.service.acknowledgeRunning(this.principal, command);
  }

  failStart(
    command: FailRemoteRunStartCommand,
  ): Promise<RemoteRunActivationResult> {
    return this.service.failStart(this.principal, command);
  }
}
