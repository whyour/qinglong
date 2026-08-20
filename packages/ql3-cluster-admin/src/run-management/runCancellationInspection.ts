import { randomUUID } from 'node:crypto';

import type { ClusterRunManagementClientResult } from './runManagementClient';
import {
  RUN_CANCELLATION_DISPATCH_INSPECT_REQUEST_SCHEMA,
  normalizeClusterRunManagementCommand,
  type ClusterRunManagementCancellationInspectCommand,
  type ClusterRunManagementCancellationInspectTransportResult,
} from './runManagementTransport';

export const RUN_CANCELLATION_INSPECTION_SCHEMA =
  'qinglong/run-cancellation-inspection@v1' as const;

type CancellationDiagnostic =
  ClusterRunManagementCancellationInspectTransportResult['diagnostic'];

export type RunCancellationInspectionObservation = Readonly<
  {
    schemaVersion: 1;
    schema: typeof RUN_CANCELLATION_INSPECTION_SCHEMA;
    component: 'qinglong3-run-management-client';
    event: 'cancellation_inspected';
    requestId: string;
  } & Omit<CancellationDiagnostic, 'schema'>
>;

export function createRunCancellationInspectionCommand(
  projectId: string,
  runId: string,
  createUuid: () => string = randomUUID,
): Readonly<ClusterRunManagementCancellationInspectCommand> {
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
    operation: 'run.cancellation.inspect',
    request: {
      projectId,
      runId,
      requestId,
      auditEventId,
      failureAuditEventId,
      body: { schema: RUN_CANCELLATION_DISPATCH_INSPECT_REQUEST_SCHEMA },
    },
  }) as Readonly<ClusterRunManagementCancellationInspectCommand>;
}

export function projectRunCancellationInspection(
  result: Readonly<ClusterRunManagementClientResult>,
): Readonly<RunCancellationInspectionObservation> {
  if (result.result.operation !== 'run.cancellation.inspect') {
    throw new TypeError(
      'Run cancellation inspection requires an inspect result',
    );
  }
  const { schema: _schema, ...diagnostic } = result.result.diagnostic;
  return Object.freeze({
    schemaVersion: 1,
    schema: RUN_CANCELLATION_INSPECTION_SCHEMA,
    component: 'qinglong3-run-management-client',
    event: 'cancellation_inspected',
    requestId: result.requestId,
    ...diagnostic,
  });
}
