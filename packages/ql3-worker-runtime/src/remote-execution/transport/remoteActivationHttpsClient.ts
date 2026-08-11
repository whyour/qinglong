// Remote Execution transport owns starting, running, and start-failure acknowledgements.
import {
  assertAcknowledgeRemoteRunRunningCommand,
  assertAcknowledgeRemoteRunStartingCommand,
  assertFailRemoteRunStartCommand,
  type AcknowledgeRemoteRunRunningCommand,
  type AcknowledgeRemoteRunStartingCommand,
  type FailRemoteRunStartCommand,
  type RemoteRunActivationResult,
} from '@qinglong/runtime-core/remote-activation';
import {
  MAX_REMOTE_RUN_ACTIVATION_RESPONSE_BYTES,
  parseRemoteRunActivationResponse,
} from '@qinglong/runtime-core/remote-activation-delivery';
import type { WorkerRemoteExecutionActivationClient } from '../executionInboxProcessor';
import {
  WorkerIngressHttpsClient,
  WorkerIngressHttpsClientError,
} from './workerIngressHttpsClient';

type ActivationCommand =
  | AcknowledgeRemoteRunStartingCommand
  | AcknowledgeRemoteRunRunningCommand
  | FailRemoteRunStartCommand;

export interface WorkerRemoteExecutionHttpsActivationClientOptions {
  readonly client: WorkerIngressHttpsClient;
}

export class WorkerRemoteExecutionHttpsActivationError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'request_invalid'
      | 'transport_unavailable'
      | 'response_invalid',
    options?: ErrorOptions,
  ) {
    super(`Worker remote execution activation failed: ${reason}`, options);
    this.name = 'WorkerRemoteExecutionHttpsActivationError';
  }
}

function path(command: ActivationCommand, operation: string): string {
  return '/api/v3/worker-ingress/workers/' + command.workerId +
    '/sessions/' + command.workerSessionId + '/' + operation;
}

function fenceBody(command: ActivationCommand): Readonly<{
  runId: string;
  attemptId: string;
  workerGeneration: number;
  offerId: string;
  leaseGeneration: number;
  leaseToken: string;
  expectedLeaseVersion: number;
}> {
  return Object.freeze({
    runId: command.runId,
    attemptId: command.attemptId,
    workerGeneration: command.workerGeneration,
    offerId: command.offerId,
    leaseGeneration: command.leaseGeneration,
    leaseToken: command.leaseToken,
    expectedLeaseVersion: command.expectedLeaseVersion,
  });
}

export class WorkerRemoteExecutionHttpsActivationClient
  implements WorkerRemoteExecutionActivationClient {
  private readonly client: WorkerIngressHttpsClient;

  constructor(options: WorkerRemoteExecutionHttpsActivationClientOptions) {
    if (!options || !(options.client instanceof WorkerIngressHttpsClient)) {
      throw new WorkerRemoteExecutionHttpsActivationError(
        'invalid_configuration',
      );
    }
    this.client = options.client;
  }

  async acknowledgeStarting(
    command: AcknowledgeRemoteRunStartingCommand,
  ): Promise<Readonly<RemoteRunActivationResult>> {
    try {
      assertAcknowledgeRemoteRunStartingCommand(command);
    } catch (error) {
      throw new WorkerRemoteExecutionHttpsActivationError(
        'request_invalid',
        { cause: error },
      );
    }
    return this.exchange('starting', command, fenceBody(command));
  }

  async acknowledgeRunning(
    command: AcknowledgeRemoteRunRunningCommand,
  ): Promise<Readonly<RemoteRunActivationResult>> {
    try {
      assertAcknowledgeRemoteRunRunningCommand(command);
    } catch (error) {
      throw new WorkerRemoteExecutionHttpsActivationError(
        'request_invalid',
        { cause: error },
      );
    }
    return this.exchange('running', command, Object.freeze({
      ...fenceBody(command),
      executorHandle: command.executorHandle,
      logArtifactId: command.logArtifactId ?? null,
      callbackSequence: command.callbackSequence,
      callbackTokenDigest: command.callbackTokenDigest,
    }));
  }

  async failStart(
    command: FailRemoteRunStartCommand,
  ): Promise<Readonly<RemoteRunActivationResult>> {
    try {
      assertFailRemoteRunStartCommand(command);
    } catch (error) {
      throw new WorkerRemoteExecutionHttpsActivationError(
        'request_invalid',
        { cause: error },
      );
    }
    return this.exchange('start-failure', command, fenceBody(command));
  }

  private async exchange(
    operation: 'starting' | 'running' | 'start-failure',
    command: ActivationCommand,
    body: unknown,
  ): Promise<Readonly<RemoteRunActivationResult>> {
    let serialized: Uint8Array;
    try {
      serialized = await this.client.postJson({
        path: path(command, operation),
        body,
        maximumResponseBytes: MAX_REMOTE_RUN_ACTIVATION_RESPONSE_BYTES,
      });
    } catch (error) {
      if (error instanceof WorkerIngressHttpsClientError) {
        throw new WorkerRemoteExecutionHttpsActivationError(
          'transport_unavailable',
          { cause: error },
        );
      }
      throw error;
    }
    try {
      const result = parseRemoteRunActivationResponse(serialized);
      if (
        result.snapshot.runId !== command.runId ||
        result.snapshot.attemptId !== command.attemptId ||
        result.snapshot.leaseGeneration !== command.leaseGeneration
      ) {
        throw new TypeError('activation response authority mismatch');
      }
      return result;
    } catch (error) {
      throw new WorkerRemoteExecutionHttpsActivationError(
        'response_invalid',
        { cause: error },
      );
    } finally {
      Buffer.from(serialized.buffer, serialized.byteOffset, serialized.byteLength)
        .fill(0);
    }
  }
}
