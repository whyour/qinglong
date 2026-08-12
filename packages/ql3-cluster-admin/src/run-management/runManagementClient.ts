import {
  RUN_MANUAL_RETRY_SCHEMA,
  normalizeRunManualRetryResult,
} from '@qinglong/runtime-core/run-manual-retry';
import {
  RUN_CANCELLATION_SCHEMA,
  normalizeRunCancellationResult,
} from '@qinglong/runtime-core/run-cancellation';
import {
  ClusterPluginPackageManagementClientRequestError,
  executeClusterAuthenticatedManagementClient,
  type ClusterAuthenticatedManagementClientResult,
  type ClusterPluginPackageManagementClientConnectionOptions,
  type ClusterPluginPackageManagementClientPaths,
} from '../management-support/pluginPackageManagementClient';
import {
  normalizeClusterRunManagementCommand,
  type ClusterRunManagementCommand,
  type ClusterRunManagementTransportResult,
} from './runManagementTransport';

const MANAGEMENT_PATH = '/api/v3/runs/management';

export type ClusterRunManagementClientPaths =
  ClusterPluginPackageManagementClientPaths;
export type ClusterRunManagementClientConnectionOptions =
  ClusterPluginPackageManagementClientConnectionOptions;
export type ClusterRunManagementClientResult =
  ClusterAuthenticatedManagementClientResult<ClusterRunManagementTransportResult>;

function invalid(): never {
  throw new ClusterPluginPackageManagementClientRequestError();
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const actual = Object.keys(value as object).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
  return value as Record<string, unknown>;
}

export function validateClusterRunManagementClientResult(
  value: unknown,
  command: Readonly<ClusterRunManagementCommand>,
): Readonly<ClusterRunManagementTransportResult> {
  if (command.operation === 'run.retry') {
    const envelope = exact(value, ['schemaVersion', 'operation', 'retry']);
    if (
      envelope.schemaVersion !== 1 ||
      envelope.operation !== command.operation
    ) {
      invalid();
    }
    const retry = exact(envelope.retry, [
      'schema',
      'status',
      'projectId',
      'sourceRunId',
      'sourceRunStatus',
      'sourceRunVersion',
      'runId',
      'retryOfRunId',
      'taskId',
      'taskRevision',
      'attemptId',
      'runStatus',
      'runVersion',
      'eventSequence',
      'executorType',
      'executionRevisionDigest',
      'createdAtMs',
    ]);
    if (retry.schema !== RUN_MANUAL_RETRY_SCHEMA) invalid();
    try {
      const { schema: _schema, ...result } = retry;
      const normalized = normalizeRunManualRetryResult(result as never);
      if (
        normalized.projectId !== command.request.projectId ||
        normalized.sourceRunId !== command.request.sourceRunId ||
        normalized.sourceRunVersion !==
          command.request.body.expectedRunVersion ||
        normalized.sourceRunStatus !== command.request.body.expectedRunStatus ||
        normalized.executorType !== 'remote_worker'
      ) {
        invalid();
      }
    } catch {
      invalid();
    }
    return Object.freeze(
      envelope as unknown as ClusterRunManagementTransportResult,
    );
  }
  const envelope = exact(value, ['schemaVersion', 'operation', 'stop']);
  if (
    envelope.schemaVersion !== 1 ||
    envelope.operation !== command.operation
  ) {
    invalid();
  }
  const stop = exact(envelope.stop, [
    'schema',
    'status',
    'projectId',
    'runId',
    'runStatus',
    'runVersion',
    'eventSequence',
    ...(Object.hasOwn(envelope.stop as object, 'cancelRequestedAtMs')
      ? ['cancelRequestedAtMs', 'cancelReason']
      : []),
  ]);
  if (stop.schema !== RUN_CANCELLATION_SCHEMA) invalid();
  try {
    const { schema: _schema, ...result } = stop;
    const normalized = normalizeRunCancellationResult(result as never);
    if (
      normalized.projectId !== command.request.projectId ||
      normalized.runId !== command.request.runId
    ) {
      invalid();
    }
  } catch {
    invalid();
  }
  return Object.freeze(
    envelope as unknown as ClusterRunManagementTransportResult,
  );
}

const PROTOCOL = Object.freeze({
  managementPath: MANAGEMENT_PATH,
  clientCertificate: 'required' as const,
  normalizeCommand: normalizeClusterRunManagementCommand,
  validateResult: validateClusterRunManagementClientResult,
});

export function executeClusterRunManagementClient(
  paths: ClusterRunManagementClientPaths,
  connectionOptions?: ClusterRunManagementClientConnectionOptions,
): Promise<Readonly<ClusterRunManagementClientResult>> {
  return executeClusterAuthenticatedManagementClient(
    paths,
    PROTOCOL,
    connectionOptions,
  );
}
