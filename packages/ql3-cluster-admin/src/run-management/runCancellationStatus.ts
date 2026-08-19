import { randomUUID } from 'node:crypto';

import type { ClusterRunManagementClientResult } from './runManagementClient';
import {
  RUN_CANCELLATION_DISPATCH_SUMMARY_REQUEST_SCHEMA,
  normalizeClusterRunManagementCommand,
  type ClusterRunManagementCancellationSummaryCommand,
  type ClusterRunManagementCancellationSummaryTransportResult,
} from './runManagementTransport';

export const RUN_CANCELLATION_STATUS_SCHEMA =
  'qinglong/run-cancellation-status@v1' as const;

export type RunCancellationStatusExitCode = 0 | 10 | 20;
export type RunCancellationStatusSeverity = 'ok' | 'warning' | 'critical';

type CancellationSummary =
  ClusterRunManagementCancellationSummaryTransportResult['summary'];

export interface RunCancellationStatusObservation {
  readonly schemaVersion: 1;
  readonly schema: typeof RUN_CANCELLATION_STATUS_SCHEMA;
  readonly component: 'qinglong3-run-management-client';
  readonly event: 'cancellation_status_observed';
  readonly requestId: string;
  readonly projectId: string;
  readonly observedAtMs: number;
  readonly assessment: CancellationSummary['assessment'];
  readonly operatorAction: CancellationSummary['operatorAction'];
  readonly severity: RunCancellationStatusSeverity;
  readonly exitCode: RunCancellationStatusExitCode;
  readonly dispatches: CancellationSummary['dispatches'];
  readonly signals: CancellationSummary['signals'];
  readonly blockingResults: CancellationSummary['blockingResults'];
  readonly oldestBlockedAtMs?: number;
}

export function createRunCancellationStatusCommand(
  projectId: string,
  createUuid: () => string = randomUUID,
): Readonly<ClusterRunManagementCancellationSummaryCommand> {
  const requestId = createUuid();
  const auditEventId = createUuid();
  let failureAuditEventId = createUuid();
  for (
    let attempts = 0;
    failureAuditEventId === auditEventId && attempts < 3;
    attempts += 1
  ) {
    failureAuditEventId = createUuid();
  }
  return normalizeClusterRunManagementCommand({
    schemaVersion: 1,
    operation: 'run.cancellation.summary',
    request: {
      projectId,
      requestId,
      auditEventId,
      failureAuditEventId,
      body: { schema: RUN_CANCELLATION_DISPATCH_SUMMARY_REQUEST_SCHEMA },
    },
  }) as Readonly<ClusterRunManagementCancellationSummaryCommand>;
}

export function projectRunCancellationStatus(
  result: Readonly<ClusterRunManagementClientResult>,
): Readonly<RunCancellationStatusObservation> {
  if (result.result.operation !== 'run.cancellation.summary') {
    throw new TypeError('Run cancellation status requires a summary result');
  }
  const summary = result.result.summary;
  const severity: RunCancellationStatusSeverity =
    summary.assessment === 'clear'
      ? 'ok'
      : summary.assessment === 'converging'
      ? 'warning'
      : 'critical';
  const exitCode: RunCancellationStatusExitCode =
    severity === 'ok' ? 0 : severity === 'warning' ? 10 : 20;
  return Object.freeze({
    schemaVersion: 1,
    schema: RUN_CANCELLATION_STATUS_SCHEMA,
    component: 'qinglong3-run-management-client',
    event: 'cancellation_status_observed',
    requestId: result.requestId,
    projectId: summary.projectId,
    observedAtMs: summary.observedAtMs,
    assessment: summary.assessment,
    operatorAction: summary.operatorAction,
    severity,
    exitCode,
    dispatches: summary.dispatches,
    signals: summary.signals,
    blockingResults: summary.blockingResults,
    ...(summary.oldestBlockedAtMs === undefined
      ? {}
      : { oldestBlockedAtMs: summary.oldestBlockedAtMs }),
  });
}

function label(value: string): string {
  return value.replaceAll('_', ' ').toUpperCase();
}

export function formatRunCancellationStatusCard(
  status: Readonly<RunCancellationStatusObservation>,
): string {
  const dispatch = status.dispatches;
  const blocking = status.blockingResults;
  return [
    'QingLong 3.0 / Cancellation Availability',
    `PROJECT       ${status.projectId}`,
    `ASSESSMENT    ${label(status.assessment)}`,
    `ACTION        ${label(status.operatorAction)}`,
    `ALERT         ${status.severity.toUpperCase()} (exit ${status.exitCode})`,
    `OBSERVED      ${new Date(status.observedAtMs).toISOString()}`,
    `DISPATCHES    total=${dispatch.total} pending=${dispatch.pending} leased=${dispatch.leased} retry_wait=${dispatch.retryWait} dispatched=${dispatch.dispatched} blocked=${dispatch.blocked}`,
    `SIGNALS       due=${status.signals.due} expired_lease=${status.signals.expiredLease}`,
    `BLOCKING      identity_mismatch=${blocking.identityMismatch} pid_mismatch=${blocking.pidMismatch} unsupported=${blocking.unsupported} invalid=${blocking.invalid}`,
    `OLDEST_BLOCK  ${
      status.oldestBlockedAtMs === undefined
        ? '-'
        : new Date(status.oldestBlockedAtMs).toISOString()
    }`,
    `REQUEST       ${status.requestId}`,
  ].join('\n');
}
