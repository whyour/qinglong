import type { WorkerRemoteRunCompletionClient } from '../ports/workerRemoteRunCompletionClient';
import type { PrimaryRunCompletionResult } from './primaryRunCompletionService';
import {
  RemoteRunCompletionService,
  type RemoteRunCompletionCommand,
} from './remoteRunCompletionService';
import type { AuthenticatedWorkerPrincipal } from './workerControlService';

/** The transport authenticates once; Worker request bodies cannot select a principal. */
export class BoundWorkerRemoteRunCompletionClient
  implements WorkerRemoteRunCompletionClient
{
  constructor(
    private readonly service: RemoteRunCompletionService,
    private readonly principal: AuthenticatedWorkerPrincipal,
  ) {}

  complete(
    command: RemoteRunCompletionCommand,
  ): Promise<PrimaryRunCompletionResult> {
    return this.service.complete(this.principal, command);
  }
}
