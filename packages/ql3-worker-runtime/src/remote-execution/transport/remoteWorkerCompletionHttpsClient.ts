// Remote Execution transport owns Artifact upload and completion acknowledgement.
import {
  MAX_REMOTE_WORKER_ARTIFACT_RESPONSE_BYTES,
  MAX_REMOTE_WORKER_COMPLETION_REQUEST_BYTES,
  MAX_REMOTE_WORKER_COMPLETION_RESPONSE_BYTES,
  createRemoteWorkerArtifactUploadPreamble,
  createRemoteWorkerCompletionRequestBody,
  parseRemoteWorkerArtifactUploadResponse,
  parseRemoteWorkerCompletionResponse,
  type RemoteWorkerCompletionCommand,
} from '@qinglong/runtime-core/remote-worker-completion';
import type {
  WorkerRemoteExecutionCompletionClient,
  WorkerRemoteExecutionCompletionCommand,
  WorkerRemoteExecutionCompletionResult,
  WorkerRemoteLogArtifactUploadCommand,
  WorkerRemoteLogArtifactUploadResult,
  WorkerRemoteLogArtifactUploader,
} from '../../execution/workerCompletionCoordinator';
import type { WorkerIngressHttpsClient } from './workerIngressHttpsClient';

export class WorkerRemoteCompletionHttpsError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'request_invalid'
      | 'transport_unavailable'
      | 'response_invalid',
    options?: ErrorOptions,
  ) {
    super(`Worker remote completion HTTPS failed: ${reason}`, options);
    this.name = 'WorkerRemoteCompletionHttpsError';
  }
}

export interface WorkerRemoteArtifactHttpsUploaderOptions {
  readonly client: Pick<WorkerIngressHttpsClient, 'postStream'>;
}

export interface WorkerRemoteExecutionHttpsCompletionClientOptions {
  readonly client: Pick<WorkerIngressHttpsClient, 'postJson'>;
}

function path(
  command: Readonly<{ workerId: string; workerSessionId: string }>,
  operation: 'artifacts' | 'completion',
): string {
  return `/api/v3/worker-ingress/workers/${command.workerId}` +
    `/sessions/${command.workerSessionId}/${operation}`;
}

function erase(value: Uint8Array | undefined): void {
  if (!value) return;
  Buffer.from(value.buffer, value.byteOffset, value.byteLength).fill(0);
}

export class WorkerRemoteArtifactHttpsUploader
  implements WorkerRemoteLogArtifactUploader {
  private readonly client: Pick<WorkerIngressHttpsClient, 'postStream'>;

  constructor(options: WorkerRemoteArtifactHttpsUploaderOptions) {
    if (!options || typeof options.client?.postStream !== 'function') {
      throw new WorkerRemoteCompletionHttpsError('invalid_configuration');
    }
    this.client = options.client;
  }

  async upload(
    command: WorkerRemoteLogArtifactUploadCommand,
  ): Promise<Readonly<WorkerRemoteLogArtifactUploadResult>> {
    let preamble: Buffer;
    try {
      preamble = createRemoteWorkerArtifactUploadPreamble({
        workerId: command.workerId,
        workerSessionId: command.workerSessionId,
        workerGeneration: command.workerGeneration,
        projectId: command.projectId,
        runId: command.runId,
        attemptId: command.attemptId,
        offerId: command.offerId,
        leaseGeneration: command.leaseGeneration,
        leaseToken: command.leaseToken,
        expectedLeaseVersion: command.expectedLeaseVersion,
        logArtifactId: command.logArtifactId,
        byteLength: command.byteLength,
        ...(command.truncated === undefined
          ? {}
          : { truncated: command.truncated }),
      });
    } catch (error) {
      throw new WorkerRemoteCompletionHttpsError('request_invalid', {
        cause: error,
      });
    }
    let serialized: Uint8Array | undefined;
    try {
      const content = command.content;
      serialized = await this.client.postStream({
        path: path(command, 'artifacts'),
        body: (async function* () {
          yield preamble;
          for await (const chunk of content) yield chunk;
        })(),
        byteLength: preamble.byteLength + command.byteLength,
        maximumResponseBytes: MAX_REMOTE_WORKER_ARTIFACT_RESPONSE_BYTES,
      });
    } catch (error) {
      throw new WorkerRemoteCompletionHttpsError('transport_unavailable', {
        cause: error,
      });
    } finally {
      preamble.fill(0);
    }
    try {
      const receipt = parseRemoteWorkerArtifactUploadResponse(serialized);
      if (
        receipt.projectId !== command.projectId ||
        receipt.runId !== command.runId ||
        receipt.attemptId !== command.attemptId ||
        receipt.logArtifactId !== command.logArtifactId ||
        receipt.byteLength !== command.byteLength ||
        receipt.truncated !== command.truncated
      ) {
        throw new TypeError('Artifact response authority does not match');
      }
      return Object.freeze({
        status: receipt.status,
        logArtifactId: receipt.logArtifactId,
        byteLength: receipt.byteLength,
        sha256: receipt.sha256,
      });
    } catch (error) {
      throw new WorkerRemoteCompletionHttpsError('response_invalid', {
        cause: error,
      });
    } finally {
      erase(serialized);
    }
  }
}

export class WorkerRemoteExecutionHttpsCompletionClient
  implements WorkerRemoteExecutionCompletionClient {
  private readonly client: Pick<WorkerIngressHttpsClient, 'postJson'>;

  constructor(options: WorkerRemoteExecutionHttpsCompletionClientOptions) {
    if (!options || typeof options.client?.postJson !== 'function') {
      throw new WorkerRemoteCompletionHttpsError('invalid_configuration');
    }
    this.client = options.client;
  }

  async complete(
    command: WorkerRemoteExecutionCompletionCommand,
  ): Promise<Readonly<WorkerRemoteExecutionCompletionResult>> {
    let body;
    try {
      if (command.executorType !== 'remote_worker') {
        throw new TypeError('completion executor type is invalid');
      }
      const wire: RemoteWorkerCompletionCommand = {
        workerId: command.workerId,
        workerSessionId: command.workerSessionId,
        workerGeneration: command.workerGeneration,
        projectId: command.projectId,
        runId: command.runId,
        attemptId: command.attemptId,
        offerId: command.offerId,
        leaseGeneration: command.leaseGeneration,
        leaseToken: command.leaseToken,
        expectedLeaseVersion: command.expectedLeaseVersion,
        callbackSequence: command.callbackSequence,
        callbackTokenDigest: command.callbackTokenDigest,
        result: command.result,
        artifact: command.artifact,
      };
      body = createRemoteWorkerCompletionRequestBody(wire);
    } catch (error) {
      throw new WorkerRemoteCompletionHttpsError('request_invalid', {
        cause: error,
      });
    }
    let serialized: Uint8Array | undefined;
    try {
      serialized = await this.client.postJson({
        path: path(command, 'completion'),
        body,
        maximumRequestBytes: MAX_REMOTE_WORKER_COMPLETION_REQUEST_BYTES,
        maximumResponseBytes: MAX_REMOTE_WORKER_COMPLETION_RESPONSE_BYTES,
      });
    } catch (error) {
      throw new WorkerRemoteCompletionHttpsError('transport_unavailable', {
        cause: error,
      });
    }
    try {
      const completed = parseRemoteWorkerCompletionResponse(serialized);
      if (
        completed.runId !== command.runId ||
        completed.attemptId !== command.attemptId ||
        completed.callbackSequence !== command.callbackSequence
      ) {
        throw new TypeError('completion response authority does not match');
      }
      return completed;
    } catch (error) {
      throw new WorkerRemoteCompletionHttpsError('response_invalid', {
        cause: error,
      });
    } finally {
      erase(serialized);
    }
  }
}
