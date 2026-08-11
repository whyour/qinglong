// Remote Execution transport owns bounded offer exchange over the shared mTLS client.
import type { Agent } from 'node:https';
import type { WorkerRemoteOfferTransport } from '../remoteOfferDelivery';
import {
  WorkerIngressHttpsClient,
  WorkerIngressHttpsClientError,
  type WorkerIngressHttpsCredentialProvider,
  type WorkerIngressHttpsCredentials,
  type WorkerIngressHttpsRequestFactory,
} from './workerIngressHttpsClient';

const OFFER_PATH =
  /^\/api\/v3\/worker-ingress\/workers\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/offers$/;

export type WorkerRemoteOfferHttpsCredentials = WorkerIngressHttpsCredentials;
export type WorkerRemoteOfferHttpsCredentialProvider =
  WorkerIngressHttpsCredentialProvider;
export type WorkerRemoteOfferHttpsRequestFactory =
  WorkerIngressHttpsRequestFactory;

export interface WorkerRemoteOfferHttpsTransportOptions {
  readonly client?: WorkerIngressHttpsClient;
  readonly origin?: string | URL;
  readonly credentials?: WorkerRemoteOfferHttpsCredentialProvider;
  readonly requestTimeoutMs?: number;
  readonly agent?: Agent;
  /** Injectable only for deterministic transport contract tests. */
  readonly requestFactory?: WorkerRemoteOfferHttpsRequestFactory;
}

export class WorkerRemoteOfferHttpsTransportError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'credentials_unavailable'
      | 'request_rejected'
      | 'response_rejected'
      | 'response_too_large'
      | 'closed',
  ) {
    super(`Worker remote offer HTTPS transport failed: ${reason}`);
    this.name = 'WorkerRemoteOfferHttpsTransportError';
  }
}

export class WorkerRemoteOfferHttpsTransport
  implements WorkerRemoteOfferTransport {
  private readonly client: WorkerIngressHttpsClient;
  private readonly ownsClient: boolean;
  private closed = false;

  constructor(options: WorkerRemoteOfferHttpsTransportOptions) {
    if (!options) {
      throw new WorkerRemoteOfferHttpsTransportError('invalid_configuration');
    }
    if (options.client) {
      if (
        options.origin !== undefined ||
        options.credentials !== undefined ||
        options.requestTimeoutMs !== undefined ||
        options.agent !== undefined ||
        options.requestFactory !== undefined
      ) {
        throw new WorkerRemoteOfferHttpsTransportError('invalid_configuration');
      }
      this.client = options.client;
      this.ownsClient = false;
      return;
    }
    if (options.origin === undefined || options.credentials === undefined) {
      throw new WorkerRemoteOfferHttpsTransportError('invalid_configuration');
    }
    try {
      this.client = new WorkerIngressHttpsClient({
        origin: options.origin,
        credentials: options.credentials,
        ...(options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.requestTimeoutMs }),
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        ...(options.requestFactory === undefined
          ? {}
          : { requestFactory: options.requestFactory }),
      });
    } catch (error) {
      if (error instanceof WorkerIngressHttpsClientError) {
        throw new WorkerRemoteOfferHttpsTransportError(error.reason);
      }
      throw error;
    }
    this.ownsClient = true;
  }

  async exchange(request: Readonly<{
    path: string;
    body: Readonly<{
      workerGeneration: number;
      offerId: string;
      leaseToken: string;
    }>;
    maximumResponseBytes: number;
    signal?: AbortSignal;
  }>): Promise<Uint8Array> {
    if (this.closed) {
      throw new WorkerRemoteOfferHttpsTransportError('closed');
    }
    if (!request || typeof request.path !== 'string' || !OFFER_PATH.test(request.path)) {
      throw new WorkerRemoteOfferHttpsTransportError('request_rejected');
    }
    try {
      return await this.client.postJson(request);
    } catch (error) {
      if (error instanceof WorkerIngressHttpsClientError) {
        throw new WorkerRemoteOfferHttpsTransportError(error.reason);
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsClient) this.client.close();
  }
}
