// Session ownership: exchange bounded register, heartbeat, and transition messages.
import {
  MAX_WORKER_SESSION_REGISTER_REQUEST_BYTES,
  MAX_WORKER_SESSION_REQUEST_BYTES,
  MAX_WORKER_SESSION_RESPONSE_BYTES,
  createWorkerSessionHeartbeatRequestBody,
  createWorkerSessionRegisterRequestBody,
  createWorkerSessionTransitionRequestBody,
  parseWorkerSessionHeartbeatResponseBody,
  parseWorkerSessionRegisterResponseBody,
  parseWorkerSessionTransitionResponseBody,
  type WorkerSessionHeartbeatResponseBody,
  type WorkerSessionRegisterResponseBody,
  type WorkerSessionTransitionResponseBody,
} from '@qinglong/runtime-core/worker-session-transport';
import type {
  HeartbeatWorkerSessionCommand,
  RegisterWorkerSessionCommand,
  TransitionWorkerSessionCommand,
} from '@qinglong/runtime-core/worker-session';
import {
  WorkerIngressHttpsClient,
  WorkerIngressHttpsClientError,
} from '../remote-execution/transport/workerIngressHttpsClient';

export interface WorkerSessionHttpsClientOptions {
  readonly client: WorkerIngressHttpsClient;
}

export class WorkerSessionHttpsClientError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'request_invalid'
      | 'credential_rejected'
      | 'session_fenced'
      | 'transport_unavailable'
      | 'response_invalid',
    options?: ErrorOptions,
  ) {
    super(`Worker Session HTTPS client failed: ${reason}`, options);
    this.name = 'WorkerSessionHttpsClientError';
  }
}

function path(
  command: Readonly<{ workerId: string; sessionId: string }>,
  operation: 'register' | 'heartbeat' | 'transition',
): string {
  return '/api/v3/worker-ingress/workers/' + command.workerId +
    '/sessions/' + command.sessionId + '/' + operation;
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'),
  ) as unknown;
}

export class WorkerSessionHttpsClient {
  private readonly client: WorkerIngressHttpsClient;

  constructor(options: WorkerSessionHttpsClientOptions) {
    if (!options || !(options.client instanceof WorkerIngressHttpsClient)) {
      throw new WorkerSessionHttpsClientError('invalid_configuration');
    }
    this.client = options.client;
  }

  async register(
    command: RegisterWorkerSessionCommand,
    signal?: AbortSignal,
  ): Promise<WorkerSessionRegisterResponseBody> {
    let body;
    try {
      body = createWorkerSessionRegisterRequestBody(command);
    } catch (error) {
      throw new WorkerSessionHttpsClientError(
        'request_invalid', { cause: error },
      );
    }
    const response = await this.exchange(
      path(command, 'register'),
      body,
      MAX_WORKER_SESSION_REGISTER_REQUEST_BYTES,
      signal,
    );
    try {
      const result = parseWorkerSessionRegisterResponseBody(parseJson(response));
      if (
        result.workerId !== command.workerId ||
        result.sessionId !== command.sessionId ||
        result.status !== 'online'
      ) throw new TypeError('register response authority mismatch');
      return result;
    } catch (error) {
      throw new WorkerSessionHttpsClientError(
        'response_invalid', { cause: error },
      );
    } finally {
      Buffer.from(response.buffer, response.byteOffset, response.byteLength)
        .fill(0);
    }
  }

  async heartbeat(
    command: HeartbeatWorkerSessionCommand,
    signal?: AbortSignal,
  ): Promise<WorkerSessionHeartbeatResponseBody> {
    let body;
    try {
      body = createWorkerSessionHeartbeatRequestBody(command);
    } catch (error) {
      throw new WorkerSessionHttpsClientError(
        'request_invalid', { cause: error },
      );
    }
    const response = await this.exchange(
      path(command, 'heartbeat'),
      body,
      MAX_WORKER_SESSION_REQUEST_BYTES,
      signal,
    );
    try {
      const result = parseWorkerSessionHeartbeatResponseBody(parseJson(response));
      if (
        result.workerId !== command.workerId ||
        result.sessionId !== command.sessionId ||
        result.generation !== command.generation ||
        result.version !== command.expectedVersion + 1 ||
        result.status === 'offline'
      ) throw new TypeError('heartbeat response authority mismatch');
      return result;
    } catch (error) {
      throw new WorkerSessionHttpsClientError(
        'response_invalid', { cause: error },
      );
    } finally {
      Buffer.from(response.buffer, response.byteOffset, response.byteLength)
        .fill(0);
    }
  }

  async transition(
    command: TransitionWorkerSessionCommand,
    signal?: AbortSignal,
  ): Promise<WorkerSessionTransitionResponseBody> {
    let body;
    try {
      body = createWorkerSessionTransitionRequestBody(command);
    } catch (error) {
      throw new WorkerSessionHttpsClientError(
        'request_invalid', { cause: error },
      );
    }
    const response = await this.exchange(
      path(command, 'transition'),
      body,
      MAX_WORKER_SESSION_REQUEST_BYTES,
      signal,
    );
    try {
      const result = parseWorkerSessionTransitionResponseBody(parseJson(response));
      if (
        result.workerId !== command.workerId ||
        result.sessionId !== command.sessionId ||
        result.generation !== command.generation ||
        result.version !== command.expectedVersion + 1 ||
        result.status !== command.status
      ) throw new TypeError('transition response authority mismatch');
      return result;
    } catch (error) {
      throw new WorkerSessionHttpsClientError(
        'response_invalid', { cause: error },
      );
    } finally {
      Buffer.from(response.buffer, response.byteOffset, response.byteLength)
        .fill(0);
    }
  }

  private async exchange(
    requestPath: string,
    body: unknown,
    maximumRequestBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      return await this.client.postJson({
        path: requestPath,
        body,
        maximumRequestBytes,
        maximumResponseBytes: MAX_WORKER_SESSION_RESPONSE_BYTES,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof WorkerIngressHttpsClientError) {
        if (error.httpStatus === 401 || error.httpStatus === 403) {
          throw new WorkerSessionHttpsClientError(
            'credential_rejected', { cause: error },
          );
        }
        if (error.httpStatus === 409) {
          throw new WorkerSessionHttpsClientError(
            'session_fenced', { cause: error },
          );
        }
        throw new WorkerSessionHttpsClientError(
          'transport_unavailable', { cause: error },
        );
      }
      throw error;
    }
  }
}
