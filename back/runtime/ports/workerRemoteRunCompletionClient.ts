import type { RemoteRunCompletionCommand } from '../application/remoteRunCompletionService';
import type { PrimaryRunCompletionResult } from '../application/primaryRunCompletionService';

export interface WorkerRemoteRunCompletionClient {
  complete(
    command: RemoteRunCompletionCommand,
  ): Promise<PrimaryRunCompletionResult>;
}
