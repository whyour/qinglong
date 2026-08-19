import {
  RUN_MANUAL_RETRY_SCHEMA,
  normalizeRunManualRetryResult,
} from '@qinglong/runtime-core/run-manual-retry';
import {
  RUN_CANCELLATION_SCHEMA,
  normalizeRunCancellationResult,
} from '@qinglong/runtime-core/run-cancellation';
import { RUN_STATUSES } from '@qinglong/runtime-core/run';
import {
  CANCELLATION_DISPATCH_RESULTS,
  CANCELLATION_DISPATCH_STATUSES,
} from '@qinglong/runtime-core/cancellation-dispatch';
import {
  ClusterPluginPackageManagementClientRequestError,
  executeClusterAuthenticatedManagementClient,
  type ClusterAuthenticatedManagementClientResult,
  type ClusterPluginPackageManagementClientConnectionOptions,
  type ClusterPluginPackageManagementClientPaths,
} from '../management-support/pluginPackageManagementClient';
import {
  RUN_CANCELLATION_DISPATCH_DIAGNOSTIC_SCHEMA,
  RUN_CANCELLATION_DISPATCH_REARM_RECEIPT_SCHEMA,
  RUN_CANCELLATION_DISPATCH_SUMMARY_SCHEMA,
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

function safeInteger(value: unknown, minimum = 0): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum
  );
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
  if (command.operation === 'run.cancellation.summary') {
    const envelope = exact(value, ['schemaVersion', 'operation', 'summary']);
    if (
      envelope.schemaVersion !== 1 ||
      envelope.operation !== command.operation
    ) {
      invalid();
    }
    const summary = exact(envelope.summary, [
      'schema',
      'projectId',
      'observedAtMs',
      'assessment',
      'operatorAction',
      'dispatches',
      'signals',
      'blockingResults',
      ...(Object.hasOwn(envelope.summary as object, 'oldestBlockedAtMs')
        ? ['oldestBlockedAtMs']
        : []),
    ]);
    const dispatches = exact(summary.dispatches, [
      'total',
      'pending',
      'leased',
      'retryWait',
      'dispatched',
      'blocked',
    ]);
    const signals = exact(summary.signals, ['due', 'expiredLease']);
    const blockingResults = exact(summary.blockingResults, [
      'identityMismatch',
      'pidMismatch',
      'unsupported',
      'invalid',
    ]);
    const dispatchCounts = [
      dispatches.total,
      dispatches.pending,
      dispatches.leased,
      dispatches.retryWait,
      dispatches.dispatched,
      dispatches.blocked,
    ];
    const blockingCounts = [
      blockingResults.identityMismatch,
      blockingResults.pidMismatch,
      blockingResults.unsupported,
      blockingResults.invalid,
    ];
    if (
      summary.schema !== RUN_CANCELLATION_DISPATCH_SUMMARY_SCHEMA ||
      summary.projectId !== command.request.projectId ||
      !safeInteger(summary.observedAtMs) ||
      !['clear', 'converging', 'attention_required'].includes(
        summary.assessment as string,
      ) ||
      !['none', 'wait', 'inspect'].includes(summary.operatorAction as string) ||
      dispatchCounts.some((count) => !safeInteger(count)) ||
      !safeInteger(signals.due) ||
      !safeInteger(signals.expiredLease) ||
      blockingCounts.some((count) => !safeInteger(count)) ||
      dispatches.total !==
        (dispatches.pending as number) +
          (dispatches.leased as number) +
          (dispatches.retryWait as number) +
          (dispatches.dispatched as number) +
          (dispatches.blocked as number) ||
      dispatches.blocked !==
        (blockingResults.identityMismatch as number) +
          (blockingResults.pidMismatch as number) +
          (blockingResults.unsupported as number) +
          (blockingResults.invalid as number) ||
      (signals.due as number) >
        (dispatches.pending as number) + (dispatches.retryWait as number) ||
      (signals.expiredLease as number) > (dispatches.leased as number) ||
      (Object.hasOwn(summary, 'oldestBlockedAtMs') &&
        (!safeInteger(summary.oldestBlockedAtMs) ||
          (summary.oldestBlockedAtMs as number) >
            (summary.observedAtMs as number))) ||
      ((dispatches.blocked as number) === 0) !==
        !Object.hasOwn(summary, 'oldestBlockedAtMs')
    ) {
      invalid();
    }
    const active =
      (dispatches.pending as number) +
      (dispatches.leased as number) +
      (dispatches.retryWait as number) +
      (dispatches.blocked as number);
    const expectedAssessment =
      (dispatches.blocked as number) > 0
        ? 'attention_required'
        : active > 0
          ? 'converging'
          : 'clear';
    const expectedOperatorAction =
      (dispatches.blocked as number) > 0
        ? 'inspect'
        : active > 0
          ? 'wait'
          : 'none';
    if (
      summary.assessment !== expectedAssessment ||
      summary.operatorAction !== expectedOperatorAction
    ) {
      invalid();
    }
    return Object.freeze(
      envelope as unknown as ClusterRunManagementTransportResult,
    );
  }
  if (command.operation === 'run.cancellation.inspect') {
    const envelope = exact(value, [
      'schemaVersion',
      'operation',
      'diagnostic',
    ]);
    if (
      envelope.schemaVersion !== 1 ||
      envelope.operation !== command.operation
    ) {
      invalid();
    }
    const diagnostic = exact(envelope.diagnostic, [
      'schema',
      'projectId',
      'runId',
      'runStatus',
      'runVersion',
      'eventSequence',
      ...(Object.hasOwn(envelope.diagnostic as object, 'cancelRequestedAtMs')
        ? ['cancelRequestedAtMs', 'cancelReason']
        : []),
      'operatorAction',
      'dispatch',
    ]);
    if (
      diagnostic.schema !== RUN_CANCELLATION_DISPATCH_DIAGNOSTIC_SCHEMA ||
      diagnostic.projectId !== command.request.projectId ||
      diagnostic.runId !== command.request.runId ||
      !RUN_STATUSES.includes(diagnostic.runStatus as never) ||
      !safeInteger(diagnostic.runVersion, 1) ||
      !safeInteger(diagnostic.eventSequence) ||
      !['none', 'wait', 'rearm'].includes(diagnostic.operatorAction as string) ||
      (Object.hasOwn(diagnostic, 'cancelRequestedAtMs') &&
        (!safeInteger(diagnostic.cancelRequestedAtMs) ||
          !['user', 'policy', 'shutdown', 'reconcile', 'timeout'].includes(
            diagnostic.cancelReason as string,
          )))
    ) {
      invalid();
    }
    let dispatchStatus: string | null = null;
    if (diagnostic.dispatch !== null) {
      const dispatch = exact(diagnostic.dispatch, [
        'attemptId',
        'status',
        'version',
        'dispatchCount',
        ...(Object.hasOwn(diagnostic.dispatch as object, 'nextAttemptAtMs')
          ? ['nextAttemptAtMs']
          : []),
        ...(Object.hasOwn(diagnostic.dispatch as object, 'leaseExpiresAtMs')
          ? ['leaseExpiresAtMs']
          : []),
        ...(Object.hasOwn(diagnostic.dispatch as object, 'lastResult')
          ? ['lastResult']
          : []),
        ...(Object.hasOwn(
          diagnostic.dispatch as object,
          'lastDispatchedAtMs',
        )
          ? ['lastDispatchedAtMs']
          : []),
        'createdAtMs',
        'updatedAtMs',
      ]);
      if (
        typeof dispatch.attemptId !== 'string' ||
        dispatch.attemptId.length < 1 ||
        !CANCELLATION_DISPATCH_STATUSES.includes(dispatch.status as never) ||
        !safeInteger(dispatch.version) ||
        !safeInteger(dispatch.dispatchCount) ||
        !safeInteger(dispatch.createdAtMs) ||
        !safeInteger(dispatch.updatedAtMs) ||
        (Object.hasOwn(dispatch, 'nextAttemptAtMs') &&
          !safeInteger(dispatch.nextAttemptAtMs)) ||
        (Object.hasOwn(dispatch, 'leaseExpiresAtMs') &&
          !safeInteger(dispatch.leaseExpiresAtMs)) ||
        (Object.hasOwn(dispatch, 'lastDispatchedAtMs') &&
          !safeInteger(dispatch.lastDispatchedAtMs)) ||
        (Object.hasOwn(dispatch, 'lastResult') &&
          !CANCELLATION_DISPATCH_RESULTS.includes(dispatch.lastResult as never))
      ) {
        invalid();
      }
      dispatchStatus = dispatch.status as string;
    }
    const expectedOperatorAction =
      dispatchStatus === 'blocked'
        ? 'rearm'
        : dispatchStatus !== null && dispatchStatus !== 'dispatched'
          ? 'wait'
          : dispatchStatus === null &&
              Object.hasOwn(diagnostic, 'cancelRequestedAtMs')
            ? 'wait'
            : 'none';
    if (diagnostic.operatorAction !== expectedOperatorAction) invalid();
    return Object.freeze(
      envelope as unknown as ClusterRunManagementTransportResult,
    );
  }
  if (command.operation === 'run.cancellation.rearm') {
    const envelope = exact(value, ['schemaVersion', 'operation', 'rearm']);
    if (
      envelope.schemaVersion !== 1 ||
      envelope.operation !== command.operation
    ) {
      invalid();
    }
    const rearm = exact(envelope.rearm, [
      'schema',
      'status',
      'projectId',
      'runId',
      'attemptId',
      'previousDispatchVersion',
      'dispatchVersion',
      'previousResult',
      'retryDelayMs',
      'nextAttemptAtMs',
      'runVersion',
      'eventSequence',
    ]);
    if (
      rearm.schema !== RUN_CANCELLATION_DISPATCH_REARM_RECEIPT_SCHEMA ||
      rearm.status !== 'rearmed' ||
      rearm.projectId !== command.request.projectId ||
      rearm.runId !== command.request.runId ||
      typeof rearm.attemptId !== 'string' ||
      rearm.attemptId.length < 1 ||
      rearm.previousDispatchVersion !==
        command.request.body.expectedDispatchVersion ||
      rearm.dispatchVersion !== rearm.previousDispatchVersion + 1 ||
      rearm.previousResult !== command.request.body.expectedLastResult ||
      rearm.retryDelayMs !== command.request.body.retryDelayMs ||
      !safeInteger(rearm.nextAttemptAtMs) ||
      !safeInteger(rearm.runVersion, 1) ||
      !safeInteger(rearm.eventSequence, 1)
    ) {
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
