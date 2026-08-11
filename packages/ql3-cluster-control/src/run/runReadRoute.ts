// Run owns its bounded read projection and masks cross-Project storage facts.
import {
  EXECUTION_ORIGINS,
  RUN_STATUSES,
  type ExecutionOrigin,
  type ExecutionOwner,
  type RunRecord,
  type RunRepositoryReader,
  type RunStatus,
} from '@qinglong/runtime-core';
import type { ClusterControlAdmissionResponse } from '../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../transport/routeRegistry';

export interface ClusterControlRunReadRepository
  extends Pick<RunRepositoryReader, 'findRunById'> {}

export interface ClusterControlRunView {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: string;
  readonly status: RunStatus;
  readonly version: number;
  readonly eventSequence: number;
  readonly priority: number;
  readonly executionOrigin: ExecutionOrigin;
  readonly executionOwner: ExecutionOwner;
  readonly createdAtMs: number;
  readonly queuedAtMs: number | null;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
}

export const CLUSTER_CONTROL_RUN_READ_ROUTE = Object.freeze({
  method: 'GET' as const,
  path: '/api/v3/projects/{projectId}/runs/{runId}',
  operationId: 'run.get',
  permission: 'run.read',
  projectParameter: 'projectId',
});

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function optionalTimestamp(value: unknown): value is number | undefined {
  return value === undefined || nonNegativeInteger(value);
}

function projectRunView(
  run: RunRecord,
  runId: string,
): Readonly<ClusterControlRunView> | null {
  if (
    !run ||
    typeof run !== 'object' ||
    Array.isArray(run) ||
    run.id !== runId ||
    !boundedText(run.id, 128) ||
    !boundedText(run.projectId, 128) ||
    !boundedText(run.taskId, 255) ||
    !boundedText(run.taskRevision, 255) ||
    !RUN_STATUSES.includes(run.status) ||
    !EXECUTION_ORIGINS.includes(run.executionOrigin) ||
    (run.executionOwner !== 'legacy' && run.executionOwner !== 'runtime') ||
    !Number.isSafeInteger(run.version) ||
    run.version < 0 ||
    !nonNegativeInteger(run.eventSequence) ||
    !Number.isSafeInteger(run.priority) ||
    !nonNegativeInteger(run.createdAtMs) ||
    !optionalTimestamp(run.queuedAtMs) ||
    !optionalTimestamp(run.startedAtMs) ||
    !optionalTimestamp(run.finishedAtMs)
  ) {
    return null;
  }
  return Object.freeze({
    id: run.id,
    projectId: run.projectId,
    taskId: run.taskId,
    taskRevision: run.taskRevision,
    status: run.status,
    version: run.version,
    eventSequence: run.eventSequence,
    priority: run.priority,
    executionOrigin: run.executionOrigin,
    executionOwner: run.executionOwner,
    createdAtMs: run.createdAtMs,
    queuedAtMs: run.queuedAtMs ?? null,
    startedAtMs: run.startedAtMs ?? null,
    finishedAtMs: run.finishedAtMs ?? null,
  });
}

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

/**
 * Defines the first reviewed cluster-control business route. The response is a
 * deliberately low-sensitive projection: refs, trigger identity, request IDs,
 * executor handles, error summaries and output locations never cross the wire.
 */
export function createClusterControlRunReadRoute(
  repository: ClusterControlRunReadRepository,
): Readonly<ClusterControlRouteDefinition> {
  if (!repository || typeof repository.findRunById !== 'function') {
    throw new TypeError('Cluster-control Run read repository is invalid');
  }
  return Object.freeze({
    ...CLUSTER_CONTROL_RUN_READ_ROUTE,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      parameters: ClusterControlRouteParameters,
    ) {
      if (authorized.request.body !== null) {
        return response(400, { code: 'invalid_request_body' });
      }
      const runId = parameters.runId;
      if (!boundedText(runId, 128)) {
        return response(503, { code: 'run_query_unavailable' });
      }
      let run: RunRecord | null;
      try {
        run = await repository.findRunById(runId);
      } catch {
        return response(503, { code: 'run_query_unavailable' });
      }
      if (!run) {
        return response(404, { code: 'run_not_found' });
      }
      const view = projectRunView(run, runId);
      if (!view) {
        return response(503, { code: 'run_query_unavailable' });
      }
      if (view.projectId !== authorized.projectId) {
        return response(404, { code: 'run_not_found' });
      }
      return response(200, { run: view });
    },
  });
}

export * from './runCancellationRoute';
export * from './runListRoute';
export * from './runEventListRoute';
export * from './runStepListRoute';
