import type { ExecutionContext } from '../domain/execution';
import type { ClaimedExecutionOffer } from '../domain/runDispatchOffer';

export interface PreparedWorkerExecutionContext {
  context: ExecutionContext;
  logArtifactId?: string;
}

export interface WorkerExecutionContextFactory {
  prepare(
    offer: ClaimedExecutionOffer,
  ): Promise<PreparedWorkerExecutionContext>;
}
