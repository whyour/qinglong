// Remote Execution transport owns capability-bound Secret delivery.
import {
  MAX_REMOTE_SECRET_DELIVERY_REQUEST_BYTES,
  MAX_REMOTE_SECRET_DELIVERY_RESPONSE_BYTES,
  createRemoteWorkerSecretDeliveryRequestBody,
  parseRemoteWorkerSecretDeliveryResponse,
} from '@qinglong/runtime-core/remote-secret-delivery';
import { createClusterRemoteExecutionOffer } from '@qinglong/runtime-core/remote-dispatch';
import type { WorkerRemoteExecutionInbox } from '../executionInbox';
import type {
  WorkerRemoteSecretEnvironmentProvider,
  WorkerRemoteSecretResolution,
} from '../executionContextMaterializer';
import {
  WorkerIngressHttpsClient,
  type WorkerIngressHttpsPostRequest,
} from './workerIngressHttpsClient';

export class WorkerRemoteSecretHttpsProviderError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'offer_unavailable'
      | 'authority_mismatch'
      | 'delivery_unavailable'
      | 'response_invalid',
  ) {
    super(`Worker remote Secret HTTPS provider failed: ${reason}`);
    this.name = 'WorkerRemoteSecretHttpsProviderError';
  }
}

export interface WorkerRemoteSecretHttpsProviderOptions {
  readonly client: Pick<WorkerIngressHttpsClient, 'postJson'>;
  readonly inbox: Pick<WorkerRemoteExecutionInbox, 'readOffer'>;
}

export class WorkerRemoteSecretHttpsProvider
  implements WorkerRemoteSecretEnvironmentProvider {
  private readonly client: Pick<WorkerIngressHttpsClient, 'postJson'>;
  private readonly inbox: Pick<WorkerRemoteExecutionInbox, 'readOffer'>;

  constructor(options: WorkerRemoteSecretHttpsProviderOptions) {
    if (
      !options ||
      typeof options.client?.postJson !== 'function' ||
      typeof options.inbox?.readOffer !== 'function'
    ) throw new WorkerRemoteSecretHttpsProviderError('invalid_configuration');
    this.client = options.client;
    this.inbox = options.inbox;
  }

  async resolve(request: Parameters<WorkerRemoteSecretEnvironmentProvider['resolve']>[0])
    : Promise<WorkerRemoteSecretResolution | undefined> {
    let record;
    try {
      record = await this.inbox.readOffer(request.offerId);
    } catch {
      throw new WorkerRemoteSecretHttpsProviderError('offer_unavailable');
    }
    if (!record || record.state !== 'starting_acknowledged') {
      throw new WorkerRemoteSecretHttpsProviderError('offer_unavailable');
    }
    let offer;
    try {
      offer = createClusterRemoteExecutionOffer(record.offer);
    } catch {
      throw new WorkerRemoteSecretHttpsProviderError('authority_mismatch');
    }
    const expectedRefs = Object.freeze([
      ...new Set(offer.executionRevision.environment.flatMap((binding) =>
        binding.kind === 'secret' ? [binding.secretRef] : [])),
    ]);
    if (
      offer.offerId !== request.offerId ||
      offer.executionDigest !== request.executionDigest ||
      offer.candidate.projectId !== request.projectId ||
      offer.candidate.taskId !== request.taskId ||
      offer.candidate.taskRevision !== request.taskRevision ||
      offer.candidate.runId !== request.runId ||
      offer.candidate.attemptId !== request.attemptId ||
      JSON.stringify(expectedRefs) !== JSON.stringify(request.secretRefs)
    ) throw new WorkerRemoteSecretHttpsProviderError('authority_mismatch');

    const path = `/api/v3/worker-ingress/workers/${offer.worker.workerId}` +
      `/sessions/${offer.worker.sessionId}/secrets`;
    const body = createRemoteWorkerSecretDeliveryRequestBody({
      workerId: offer.worker.workerId,
      workerSessionId: offer.worker.sessionId,
      workerGeneration: offer.worker.generation,
      runId: offer.candidate.runId,
      attemptId: offer.candidate.attemptId,
      projectId: offer.candidate.projectId,
      taskId: offer.candidate.taskId,
      taskRevision: offer.candidate.taskRevision,
      executionDigest: offer.executionDigest,
      offerId: offer.offerId,
      leaseGeneration: offer.lease.leaseGeneration,
      leaseToken: offer.leaseToken,
      expectedLeaseVersion: offer.lease.version,
      secretRefs: expectedRefs,
    });
    let serialized: Uint8Array;
    try {
      const transportRequest: WorkerIngressHttpsPostRequest = {
        path,
        body,
        maximumRequestBytes: MAX_REMOTE_SECRET_DELIVERY_REQUEST_BYTES,
        maximumResponseBytes: MAX_REMOTE_SECRET_DELIVERY_RESPONSE_BYTES,
      };
      serialized = await this.client.postJson(transportRequest);
    } catch {
      throw new WorkerRemoteSecretHttpsProviderError('delivery_unavailable');
    }
    try {
      const delivered = parseRemoteWorkerSecretDeliveryResponse(serialized, {
        runId: offer.candidate.runId,
        attemptId: offer.candidate.attemptId,
        offerId: offer.offerId,
        executionDigest: offer.executionDigest,
        secretRefs: expectedRefs,
      });
      const values = Object.freeze(delivered.values.map((entry) =>
        Object.freeze({ secretRef: entry.secretRef, value: entry.value })));
      return Object.freeze({
        values,
        dispose() {
          // JavaScript strings cannot be zeroized. Drop all retained references;
          // the transport bytes were already scrubbed by the parser.
        },
      });
    } catch {
      throw new WorkerRemoteSecretHttpsProviderError('response_invalid');
    } finally {
      if (Buffer.isBuffer(serialized)) serialized.fill(0);
    }
  }
}
