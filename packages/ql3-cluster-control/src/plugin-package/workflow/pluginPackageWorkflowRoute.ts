// Plugin Package Workflow owns its bounded inspect/start/cancel transport adapter.
import { randomUUID } from 'node:crypto';
import {
  CLUSTER_RUN_CANCELLATION_SCHEMA,
  createClusterRunCancellationResponseBody,
  parseClusterRunCancellationRequestBody,
} from '@qinglong/runtime-core/cluster-run-cancellation';
import {
  DEFAULT_PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_PAGE_SIZE,
  DEFAULT_PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_PAGE_SIZE,
  DEFAULT_PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_PAGE_SIZE,
  MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_PAGE_SIZE,
  MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_PAGE_SIZE,
  MAX_PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_PAGE_SIZE,
} from '@qinglong/runtime-core/plugin-package-workflow-administration';
import type { ClusterControlAdmissionResponse } from '../../transport/httpSurface';
import type { ClusterPluginPackageWorkflowAdministrationCapability } from './pluginPackageWorkflowAdministration';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../../transport/routeRegistry';

export const CLUSTER_PLUGIN_PACKAGE_WORKFLOW_LIST_RESPONSE_SCHEMA =
  'qinglong/cluster-plugin-package-workflow-list@v1' as const;
export const CLUSTER_PLUGIN_PACKAGE_WORKFLOW_START_REQUEST_SCHEMA =
  'qinglong/cluster-plugin-package-workflow-start-request@v1' as const;
export const CLUSTER_PLUGIN_PACKAGE_WORKFLOW_START_RESPONSE_SCHEMA =
  'qinglong/cluster-plugin-package-workflow-start-response@v1' as const;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESOURCE_ID = /^[a-z][a-z0-9-]{0,62}$/;

function parseRunListQuery(
  query: Readonly<Record<string, readonly string[]>>,
): Readonly<{
  limit: number;
  after: Readonly<{ admittedAtMs: number; runId: string }> | null;
}> {
  const limitValues = query.limit;
  const admittedAtValues = query.after_admitted_at_ms;
  const runIdValues = query.after_run_id;
  if (
    (limitValues !== undefined && limitValues.length !== 1) ||
    (admittedAtValues !== undefined && admittedAtValues.length !== 1) ||
    (runIdValues !== undefined && runIdValues.length !== 1) ||
    (admittedAtValues === undefined) !== (runIdValues === undefined)
  ) {
    throw new TypeError();
  }
  const limit =
    limitValues === undefined
      ? DEFAULT_PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_PAGE_SIZE
      : Number(limitValues[0]);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_PAGE_SIZE ||
    (limitValues !== undefined && String(limit) !== limitValues[0])
  ) {
    throw new TypeError();
  }
  if (admittedAtValues === undefined || runIdValues === undefined) {
    return Object.freeze({ limit, after: null });
  }
  const admittedAtMs = Number(admittedAtValues[0]);
  const runId = runIdValues[0]!;
  if (
    !Number.isSafeInteger(admittedAtMs) ||
    admittedAtMs < 0 ||
    String(admittedAtMs) !== admittedAtValues[0] ||
    !UUID_V4.test(runId)
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    limit,
    after: Object.freeze({ admittedAtMs, runId }),
  });
}

function parseStepRunListQuery(
  query: Readonly<Record<string, readonly string[]>>,
): Readonly<{
  limit: number;
  after: Readonly<{ stepKey: string; id: string }> | null;
}> {
  const limitValues = query.limit;
  const stepKeyValues = query.after_step_key;
  const stepRunIdValues = query.after_step_run_id;
  if (
    (limitValues !== undefined && limitValues.length !== 1) ||
    (stepKeyValues !== undefined && stepKeyValues.length !== 1) ||
    (stepRunIdValues !== undefined && stepRunIdValues.length !== 1) ||
    (stepKeyValues === undefined) !== (stepRunIdValues === undefined)
  ) {
    throw new TypeError();
  }
  const limit =
    limitValues === undefined
      ? DEFAULT_PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_PAGE_SIZE
      : Number(limitValues[0]);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_PAGE_SIZE ||
    (limitValues !== undefined && String(limit) !== limitValues[0])
  ) {
    throw new TypeError();
  }
  if (stepKeyValues === undefined || stepRunIdValues === undefined) {
    return Object.freeze({ limit, after: null });
  }
  const stepKey = stepKeyValues[0]!;
  const id = stepRunIdValues[0]!;
  if (!RESOURCE_ID.test(stepKey) || !UUID_V4.test(id)) {
    throw new TypeError();
  }
  return Object.freeze({
    limit,
    after: Object.freeze({ stepKey, id }),
  });
}

function parseRunEventListQuery(
  query: Readonly<Record<string, readonly string[]>>,
): Readonly<{ limit: number; afterSequence: number }> {
  const limitValues = query.limit;
  const afterValues = query.after_sequence;
  if (
    (limitValues !== undefined && limitValues.length !== 1) ||
    (afterValues !== undefined && afterValues.length !== 1)
  ) {
    throw new TypeError();
  }
  const limit =
    limitValues === undefined
      ? DEFAULT_PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_PAGE_SIZE
      : Number(limitValues[0]);
  const afterSequence = afterValues === undefined ? 0 : Number(afterValues[0]);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_PAGE_SIZE ||
    (limitValues !== undefined && String(limit) !== limitValues[0]) ||
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 0 ||
    (afterValues !== undefined && String(afterSequence) !== afterValues[0])
  ) {
    throw new TypeError();
  }
  return Object.freeze({ limit, afterSequence });
}

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function parseBody(value: unknown): Readonly<{
  planId: string;
  runId: string;
  stepRunIds: Readonly<Record<string, string>>;
}> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError();
  }
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).sort().join(',') !== 'planId,runId,schema,stepRunIds' ||
    body.schema !== CLUSTER_PLUGIN_PACKAGE_WORKFLOW_START_REQUEST_SCHEMA ||
    typeof body.planId !== 'string' ||
    !UUID_V4.test(body.planId) ||
    typeof body.runId !== 'string' ||
    !UUID_V4.test(body.runId) ||
    !body.stepRunIds ||
    typeof body.stepRunIds !== 'object' ||
    Array.isArray(body.stepRunIds) ||
    Object.getPrototypeOf(body.stepRunIds) !== Object.prototype
  ) {
    throw new TypeError();
  }
  const entries = Object.entries(body.stepRunIds as Record<string, unknown>);
  if (
    entries.length < 1 ||
    entries.length > 128 ||
    entries.some(
      ([key, id]) =>
        !RESOURCE_ID.test(key) || typeof id !== 'string' || !UUID_V4.test(id),
    ) ||
    new Set(entries.map(([, id]) => id)).size !== entries.length
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    planId: body.planId,
    runId: body.runId,
    stepRunIds: Object.freeze(
      Object.fromEntries(entries) as Record<string, string>,
    ),
  });
}

function errorResponse(error: unknown): ClusterControlAdmissionResponse {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : null;
  if (code === 'CLUSTER_PLUGIN_PACKAGE_WORKFLOW_NOT_FOUND') {
    return response(404, { code: 'workflow_not_found' });
  }
  if (
    code === 'CLUSTER_PLUGIN_PACKAGE_WORKFLOW_CONFLICT' ||
    code === 'PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_MUTATION_CONFLICT' ||
    code === 'PLUGIN_PACKAGE_WORKFLOW_ADMISSION_CONFLICT'
  ) {
    return response(409, { code: 'workflow_start_conflict' });
  }
  if (
    code ===
    'PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_AUTHORIZATION_FENCE_CONFLICT'
  ) {
    return response(409, { code: 'authorization_fence_changed' });
  }
  if (code === 'CLUSTER_RUN_CANCELLATION_NOT_FOUND') {
    return response(404, { code: 'workflow_run_not_found' });
  }
  if (code === 'CLUSTER_RUN_CANCELLATION_FENCE_REJECTED') {
    const candidateReason =
      error && typeof error === 'object' && 'reason' in error
        ? (error as { reason?: unknown }).reason
        : null;
    const reason =
      candidateReason === 'authorization_changed' ||
      candidateReason === 'project_mismatch' ||
      candidateReason === 'state_mismatch'
        ? candidateReason
        : 'state_mismatch';
    return response(409, {
      code: 'workflow_cancellation_fence_rejected',
      reason,
    });
  }
  return response(503, { code: 'workflow_administration_unavailable' });
}

function runInspectionErrorResponse(
  error: unknown,
): ClusterControlAdmissionResponse {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : null;
  if (
    code ===
    'PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_AUTHORIZATION_FENCE_CONFLICT'
  ) {
    return response(409, { code: 'authorization_fence_changed' });
  }
  return response(503, { code: 'workflow_run_query_unavailable' });
}

function runListErrorResponse(error: unknown): ClusterControlAdmissionResponse {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : null;
  if (
    code ===
    'PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_AUTHORIZATION_FENCE_CONFLICT'
  ) {
    return response(409, { code: 'authorization_fence_changed' });
  }
  return response(503, { code: 'workflow_run_list_unavailable' });
}

function stepRunListErrorResponse(
  error: unknown,
): ClusterControlAdmissionResponse {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : null;
  if (
    code ===
    'PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_AUTHORIZATION_FENCE_CONFLICT'
  ) {
    return response(409, { code: 'authorization_fence_changed' });
  }
  return response(503, { code: 'workflow_step_run_query_unavailable' });
}

function runEventListErrorResponse(
  error: unknown,
): ClusterControlAdmissionResponse {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : null;
  if (
    code ===
    'PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_AUTHORIZATION_FENCE_CONFLICT'
  ) {
    return response(409, { code: 'authorization_fence_changed' });
  }
  return response(503, { code: 'workflow_run_event_query_unavailable' });
}

export function createClusterControlPluginPackageWorkflowRoutes(
  capability: ClusterPluginPackageWorkflowAdministrationCapability,
  now: () => number = Date.now,
  createEventId: () => string = randomUUID,
): readonly Readonly<ClusterControlRouteDefinition>[] {
  if (
    !capability ||
    typeof capability.inspect !== 'function' ||
    typeof capability.inspectRun !== 'function' ||
    typeof capability.listRuns !== 'function' ||
    typeof capability.listStepRuns !== 'function' ||
    typeof capability.listRunEvents !== 'function' ||
    typeof capability.start !== 'function' ||
    typeof capability.cancel !== 'function' ||
    typeof now !== 'function' ||
    typeof createEventId !== 'function'
  ) {
    throw new TypeError('Cluster-control Workflow capability is invalid');
  }
  const common = {
    projectParameter: 'projectId' as const,
  };
  return Object.freeze([
    Object.freeze({
      ...common,
      method: 'GET' as const,
      path: '/api/v3/projects/{projectId}/packages/{packageName}/workflows',
      operationId: 'workflow.read',
      permission: 'run.read',
      async handle(
        authorized: ClusterControlAuthorizedOperationRequest,
        parameters: ClusterControlRouteParameters,
      ) {
        if (
          authorized.projectId === null ||
          typeof parameters.packageName !== 'string' ||
          !PACKAGE_NAME.test(parameters.packageName)
        ) {
          return response(503, { code: 'workflow_administration_unavailable' });
        }
        try {
          const result = await capability.inspect(
            authorized.projectId,
            parameters.packageName,
          );
          return response(200, {
            schema: CLUSTER_PLUGIN_PACKAGE_WORKFLOW_LIST_RESPONSE_SCHEMA,
            ...result,
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
    }),
    Object.freeze({
      ...common,
      method: 'GET' as const,
      path: '/api/v3/projects/{projectId}/packages/{packageName}/workflows/{workflowId}/runs',
      operationId: 'workflow.run.list',
      permission: 'run.read',
      allowedQuery: Object.freeze([
        'after_admitted_at_ms',
        'after_run_id',
        'limit',
      ]),
      async handle(
        authorized: ClusterControlAuthorizedOperationRequest,
        parameters: ClusterControlRouteParameters,
      ) {
        if (authorized.request.body !== null) {
          return response(400, { code: 'invalid_request_body' });
        }
        let page;
        try {
          page = parseRunListQuery(authorized.request.query);
        } catch {
          return response(400, { code: 'invalid_workflow_run_query' });
        }
        const observedAtMs = now();
        if (
          authorized.projectId === null ||
          typeof parameters.packageName !== 'string' ||
          !PACKAGE_NAME.test(parameters.packageName) ||
          typeof parameters.workflowId !== 'string' ||
          !RESOURCE_ID.test(parameters.workflowId) ||
          !authorized.policyFence ||
          authorized.policyFence.bindingVersion === null ||
          !Number.isSafeInteger(observedAtMs) ||
          observedAtMs < 0
        ) {
          return response(503, { code: 'workflow_run_list_unavailable' });
        }
        try {
          const result = await capability.listRuns({
            projectId: authorized.projectId,
            packageName: parameters.packageName,
            workflowId: parameters.workflowId,
            limit: page.limit,
            after: page.after,
            requestId: authorized.request.requestId,
            auditEventId: createEventId(),
            principal: authorized.principal,
            policyFence: authorized.policyFence,
            observedAtMs,
          });
          return response(200, { ...result });
        } catch (error) {
          return runListErrorResponse(error);
        }
      },
    }),
    Object.freeze({
      ...common,
      method: 'GET' as const,
      path: '/api/v3/projects/{projectId}/packages/{packageName}/workflows/{workflowId}/runs/{runId}',
      operationId: 'workflow.run.read',
      permission: 'run.read',
      async handle(
        authorized: ClusterControlAuthorizedOperationRequest,
        parameters: ClusterControlRouteParameters,
      ) {
        const observedAtMs = now();
        if (authorized.request.body !== null) {
          return response(400, { code: 'invalid_request_body' });
        }
        if (
          authorized.projectId === null ||
          typeof parameters.packageName !== 'string' ||
          !PACKAGE_NAME.test(parameters.packageName) ||
          typeof parameters.workflowId !== 'string' ||
          !RESOURCE_ID.test(parameters.workflowId) ||
          typeof parameters.runId !== 'string' ||
          !UUID_V4.test(parameters.runId) ||
          !authorized.policyFence ||
          authorized.policyFence.bindingVersion === null ||
          !Number.isSafeInteger(observedAtMs) ||
          observedAtMs < 0
        ) {
          return response(503, { code: 'workflow_run_query_unavailable' });
        }
        try {
          const result = await capability.inspectRun({
            projectId: authorized.projectId,
            packageName: parameters.packageName,
            workflowId: parameters.workflowId,
            runId: parameters.runId,
            requestId: authorized.request.requestId,
            auditEventId: createEventId(),
            principal: authorized.principal,
            policyFence: authorized.policyFence,
            observedAtMs,
          });
          return result.found
            ? response(200, { ...result })
            : response(404, { code: 'workflow_run_not_found' });
        } catch (error) {
          return runInspectionErrorResponse(error);
        }
      },
    }),
    Object.freeze({
      ...common,
      method: 'GET' as const,
      path: '/api/v3/projects/{projectId}/packages/{packageName}/workflows/{workflowId}/runs/{runId}/steps',
      operationId: 'workflow.step.list',
      permission: 'run.read',
      allowedQuery: Object.freeze([
        'after_step_key',
        'after_step_run_id',
        'limit',
      ]),
      async handle(
        authorized: ClusterControlAuthorizedOperationRequest,
        parameters: ClusterControlRouteParameters,
      ) {
        if (authorized.request.body !== null) {
          return response(400, { code: 'invalid_request_body' });
        }
        let page;
        try {
          page = parseStepRunListQuery(authorized.request.query);
        } catch {
          return response(400, { code: 'invalid_step_run_query' });
        }
        const observedAtMs = now();
        if (
          authorized.projectId === null ||
          typeof parameters.packageName !== 'string' ||
          !PACKAGE_NAME.test(parameters.packageName) ||
          typeof parameters.workflowId !== 'string' ||
          !RESOURCE_ID.test(parameters.workflowId) ||
          typeof parameters.runId !== 'string' ||
          !UUID_V4.test(parameters.runId) ||
          !authorized.policyFence ||
          authorized.policyFence.bindingVersion === null ||
          !Number.isSafeInteger(observedAtMs) ||
          observedAtMs < 0
        ) {
          return response(503, { code: 'workflow_step_run_query_unavailable' });
        }
        try {
          const result = await capability.listStepRuns({
            projectId: authorized.projectId,
            packageName: parameters.packageName,
            workflowId: parameters.workflowId,
            runId: parameters.runId,
            limit: page.limit,
            after: page.after,
            requestId: authorized.request.requestId,
            auditEventId: createEventId(),
            principal: authorized.principal,
            policyFence: authorized.policyFence,
            observedAtMs,
          });
          return result.found
            ? response(200, { ...result })
            : response(404, { code: 'workflow_run_not_found' });
        } catch (error) {
          return stepRunListErrorResponse(error);
        }
      },
    }),
    Object.freeze({
      ...common,
      method: 'GET' as const,
      path: '/api/v3/projects/{projectId}/packages/{packageName}/workflows/{workflowId}/runs/{runId}/events',
      operationId: 'workflow.event.list',
      permission: 'run.read',
      allowedQuery: Object.freeze(['after_sequence', 'limit']),
      async handle(
        authorized: ClusterControlAuthorizedOperationRequest,
        parameters: ClusterControlRouteParameters,
      ) {
        if (authorized.request.body !== null) {
          return response(400, { code: 'invalid_request_body' });
        }
        let page;
        try {
          page = parseRunEventListQuery(authorized.request.query);
        } catch {
          return response(400, { code: 'invalid_run_event_query' });
        }
        const observedAtMs = now();
        if (
          authorized.projectId === null ||
          typeof parameters.packageName !== 'string' ||
          !PACKAGE_NAME.test(parameters.packageName) ||
          typeof parameters.workflowId !== 'string' ||
          !RESOURCE_ID.test(parameters.workflowId) ||
          typeof parameters.runId !== 'string' ||
          !UUID_V4.test(parameters.runId) ||
          !authorized.policyFence ||
          authorized.policyFence.bindingVersion === null ||
          !Number.isSafeInteger(observedAtMs) ||
          observedAtMs < 0
        ) {
          return response(503, {
            code: 'workflow_run_event_query_unavailable',
          });
        }
        try {
          const result = await capability.listRunEvents({
            projectId: authorized.projectId,
            packageName: parameters.packageName,
            workflowId: parameters.workflowId,
            runId: parameters.runId,
            limit: page.limit,
            afterSequence: page.afterSequence,
            requestId: authorized.request.requestId,
            auditEventId: createEventId(),
            principal: authorized.principal,
            policyFence: authorized.policyFence,
            observedAtMs,
          });
          return result.found
            ? response(200, { ...result })
            : response(404, { code: 'workflow_run_not_found' });
        } catch (error) {
          return runEventListErrorResponse(error);
        }
      },
    }),
    Object.freeze({
      ...common,
      method: 'POST' as const,
      path: '/api/v3/projects/{projectId}/packages/{packageName}/workflows/{workflowId}/runs',
      operationId: 'workflow.start',
      permission: 'run.start',
      async handle(
        authorized: ClusterControlAuthorizedOperationRequest,
        parameters: ClusterControlRouteParameters,
      ) {
        let body;
        try {
          body = parseBody(authorized.request.body);
        } catch {
          return response(400, { code: 'invalid_workflow_start_request' });
        }
        const plannedAtMs = now();
        if (
          authorized.projectId === null ||
          typeof parameters.packageName !== 'string' ||
          !PACKAGE_NAME.test(parameters.packageName) ||
          typeof parameters.workflowId !== 'string' ||
          !RESOURCE_ID.test(parameters.workflowId) ||
          !authorized.policyFence ||
          authorized.policyFence.bindingVersion === null ||
          !Number.isSafeInteger(plannedAtMs) ||
          plannedAtMs < 0
        ) {
          return response(503, { code: 'workflow_administration_unavailable' });
        }
        try {
          const result = await capability.start({
            projectId: authorized.projectId,
            packageName: parameters.packageName,
            workflowId: parameters.workflowId,
            planId: body.planId,
            runId: body.runId,
            stepRunIds: body.stepRunIds,
            principal: authorized.principal,
            policyFence: authorized.policyFence,
            plannedAtMs,
          });
          return response(result.status === 'created' ? 201 : 200, {
            schema: CLUSTER_PLUGIN_PACKAGE_WORKFLOW_START_RESPONSE_SCHEMA,
            status: result.status,
            replayed: result.status === 'existing',
            planId: result.plan.planId,
            runId: result.plan.runId,
            receiptDigest: result.receipt.receiptDigest,
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
    }),
    Object.freeze({
      ...common,
      method: 'POST' as const,
      path: '/api/v3/projects/{projectId}/packages/{packageName}/workflows/{workflowId}/runs/{runId}/cancellation',
      operationId: 'workflow.cancel',
      permission: 'run.stop',
      async handle(
        authorized: ClusterControlAuthorizedOperationRequest,
        parameters: ClusterControlRouteParameters,
      ) {
        let body;
        try {
          body = parseClusterRunCancellationRequestBody(
            authorized.request.body,
          );
        } catch {
          return response(400, {
            code: 'invalid_workflow_cancellation_request',
            schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
          });
        }
        if (
          authorized.projectId === null ||
          typeof parameters.packageName !== 'string' ||
          !PACKAGE_NAME.test(parameters.packageName) ||
          typeof parameters.workflowId !== 'string' ||
          !RESOURCE_ID.test(parameters.workflowId) ||
          typeof parameters.runId !== 'string' ||
          !UUID_V4.test(parameters.runId) ||
          !authorized.policyFence ||
          authorized.policyFence.bindingVersion === null
        ) {
          return response(503, {
            code: 'workflow_administration_unavailable',
          });
        }
        try {
          const result = await capability.cancel({
            projectId: authorized.projectId,
            packageName: parameters.packageName,
            workflowId: parameters.workflowId,
            runId: parameters.runId,
            mutationId: body.mutationId,
            eventId: createEventId(),
            principal: authorized.principal,
            policyFence: authorized.policyFence,
          });
          return response(
            result.status === 'accepted' ? 202 : 200,
            createClusterRunCancellationResponseBody(result),
          );
        } catch (error) {
          return errorResponse(error);
        }
      },
    }),
  ]);
}
