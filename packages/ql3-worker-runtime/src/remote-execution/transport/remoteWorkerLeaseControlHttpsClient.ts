// Remote Execution transport owns fenced lease-control exchange.
import {
  MAX_REMOTE_WORKER_LEASE_CONTROL_REQUEST_BYTES,
  MAX_REMOTE_WORKER_LEASE_CONTROL_RESPONSE_BYTES,
  createRemoteWorkerLeaseControlRequestBody,
  parseRemoteWorkerLeaseControlResponse,
  type RemoteWorkerLeaseControlCommand,
  type RemoteWorkerLeaseControlResult,
} from '@qinglong/runtime-core/remote-worker-lease-control';
import {
  WorkerIngressHttpsClient,
  WorkerIngressHttpsClientError,
} from './workerIngressHttpsClient';

export interface WorkerRemoteLeaseControlClient {
  control(
    command: RemoteWorkerLeaseControlCommand,
  ): Promise<Readonly<RemoteWorkerLeaseControlResult>>;
}

export interface WorkerRemoteLeaseControlHttpsClientOptions {
  readonly client: WorkerIngressHttpsClient;
}

export class WorkerRemoteLeaseControlHttpsError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'request_invalid'
      | 'transport_unavailable'
      | 'response_invalid',
    options?: ErrorOptions,
  ) {
    super(`Worker remote lease control failed: ${reason}`, options);
    this.name = 'WorkerRemoteLeaseControlHttpsError';
  }
}

function path(command: RemoteWorkerLeaseControlCommand): string {
  return '/api/v3/worker-ingress/workers/' + command.workerId +
    '/sessions/' + command.workerSessionId + '/lease-control';
}

export class WorkerRemoteLeaseControlHttpsClient
  implements WorkerRemoteLeaseControlClient {
  private readonly client: WorkerIngressHttpsClient;

  constructor(options: WorkerRemoteLeaseControlHttpsClientOptions) {
    if (!options || !(options.client instanceof WorkerIngressHttpsClient)) {
      throw new WorkerRemoteLeaseControlHttpsError('invalid_configuration');
    }
    this.client = options.client;
  }

  async control(
    command: RemoteWorkerLeaseControlCommand,
  ): Promise<Readonly<RemoteWorkerLeaseControlResult>> {
    let body;
    try {
      body = createRemoteWorkerLeaseControlRequestBody(command);
    } catch (error) {
      throw new WorkerRemoteLeaseControlHttpsError(
        'request_invalid', { cause: error },
      );
    }
    let serialized: Uint8Array;
    try {
      serialized = await this.client.postJson({
        path: path(command),
        body,
        maximumRequestBytes: MAX_REMOTE_WORKER_LEASE_CONTROL_REQUEST_BYTES,
        maximumResponseBytes: MAX_REMOTE_WORKER_LEASE_CONTROL_RESPONSE_BYTES,
      });
    } catch (error) {
      if (error instanceof WorkerIngressHttpsClientError) {
        throw new WorkerRemoteLeaseControlHttpsError(
          'transport_unavailable', { cause: error },
        );
      }
      throw error;
    }
    try {
      const result = parseRemoteWorkerLeaseControlResponse(serialized);
      if (
        result.projectId !== command.projectId ||
        result.runId !== command.runId ||
        result.attemptId !== command.attemptId ||
        result.offerId !== command.offerId ||
        result.leaseGeneration !== command.leaseGeneration ||
        (result.status !== 'terminal' &&
          result.leaseVersion !== command.expectedLeaseVersion + 1)
      ) throw new TypeError('lease control response authority mismatch');
      return result;
    } catch (error) {
      throw new WorkerRemoteLeaseControlHttpsError(
        'response_invalid', { cause: error },
      );
    } finally {
      Buffer.from(serialized.buffer, serialized.byteOffset, serialized.byteLength)
        .fill(0);
    }
  }
}
