import { randomUUID } from 'node:crypto';

import {
  normalizeSecurityPolicyDecision,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditOutcome,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';
import type { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';

import type { LocalApiCredentialAuthenticator } from '../authentication/credentialAuthenticator';
import type { BoundedRunListInput } from '@qinglong/runtime-core/bounded-run-list-projection';
import type { BoundedRunEventListInput } from '@qinglong/runtime-core/bounded-run-event-list-projection';
import type { BoundedRunStepListInput } from '@qinglong/runtime-core/bounded-run-step-list-projection';
import type { BoundedTaskListInput } from '@qinglong/runtime-core/bounded-task-list-projection';
import type { LocalApiRunEventListRoute } from '../run/runEventListRoute';
import type { LocalApiRunListRoute } from '../run/runListRoute';
import type { LocalApiRunReadRoute } from '../run/runReadRoute';
import type { LocalApiRunStepListRoute } from '../run/runStepListRoute';
import type { LocalApiRunCancellationRoute } from '../run/runCancellationRoute';
import type { LocalApiRunAttemptLogReadRoute } from '../run/runAttemptLogReadRoute';
import type { LocalApiTaskListRoute } from '../task/taskListRoute';
import type { LocalApiTaskReadRoute } from '../task/taskReadRoute';
import type { LocalApiTaskStartRoute } from '../task/taskStartRoute';
import type { LocalApiTaskPutRoute } from '../task/taskPutRoute';
import type { LocalApiTaskAuthoringRoute } from '../task/taskAuthoringRoute';
import type {
  LocalApiTriggerListRoute,
  LocalApiTriggerReadRoute,
} from '../trigger/triggerReadRoutes';
import type { LocalApiTriggerPutRoute } from '../trigger/triggerPutRoute';
import type {
  LocalApiSecretListRoute,
  LocalApiSecretPutRoute,
} from '../secret/secretRoutes';
import type { LocalApiResponse } from '../transport/contract';

export type LocalApiAdmissionOperation =
  | Readonly<{
      operationId: 'run.get';
      projectId: string;
      runId: string;
    }>
  | Readonly<{
      operationId: 'run.list';
      projectId: string;
      input: Readonly<BoundedRunListInput>;
    }>
  | Readonly<{
      operationId: 'run.events.list';
      projectId: string;
      runId: string;
      input: Readonly<BoundedRunEventListInput>;
    }>
  | Readonly<{
      operationId: 'run.steps.list';
      projectId: string;
      runId: string;
      input: Readonly<BoundedRunStepListInput>;
    }>
  | Readonly<{
      operationId: 'run.log.read';
      projectId: string;
      runId: string;
      attemptId: string;
      offset: number;
      length: number;
    }>
  | Readonly<{
      operationId: 'run.cancel';
      projectId: string;
      runId: string;
    }>
  | Readonly<{
      operationId: 'task.list';
      projectId: string;
      input: Readonly<BoundedTaskListInput>;
    }>
  | Readonly<{
      operationId: 'task.get';
      projectId: string;
      taskId: string;
    }>
  | Readonly<{
      operationId: 'task.start';
      projectId: string;
      taskId: string;
    }>
  | Readonly<{
      operationId: 'task.put';
      projectId: string;
      taskId: string;
    }>
  | Readonly<{
      operationId: 'task.authoring';
      projectId: string;
      taskId: string;
    }>
  | Readonly<{
      operationId: 'trigger.list';
      projectId: string;
      limit: number;
      after?: Readonly<{ readonly triggerId: string }>;
    }>
  | Readonly<{
      operationId: 'trigger.get';
      projectId: string;
      triggerId: string;
    }>
  | Readonly<{
      operationId: 'trigger.put';
      projectId: string;
      triggerId: string;
    }>
  | Readonly<{
      operationId: 'secret.list';
      projectId: string;
      limit: number;
      after?: Readonly<{ readonly name: string }>;
    }>
  | Readonly<{
      operationId: 'secret.put';
      projectId: string;
    }>;

export interface LocalApiAdmissionRequest {
  readonly requestId: string;
  readonly operation: LocalApiAdmissionOperation;
  readonly authorization: string | null;
  readonly localPresence: string | null;
  readonly taskAuthoringLease: string | null;
  readonly signal: AbortSignal;
}

export interface LocalApiAdmission {
  prepare(
    request: Readonly<LocalApiAdmissionRequest>,
  ): Promise<LocalApiResponse | Readonly<LocalApiPreparedAdmission>>;
}

export interface LocalApiPreparedAdmission {
  readonly bodyMode: 'none' | 'json';
  readonly maximumBodyBytes: number;
  handle(body: unknown | null): Promise<LocalApiResponse>;
}

export interface LocalApiAdmissionOptions {
  readonly authenticator: LocalApiCredentialAuthenticator;
  readonly policy: Pick<ProjectPolicyEngine, 'authorize'>;
  readonly audit: SecurityAuditSink;
  readonly runReadRoute: LocalApiRunReadRoute;
  readonly runListRoute: LocalApiRunListRoute;
  readonly runEventListRoute: LocalApiRunEventListRoute;
  readonly runStepListRoute: LocalApiRunStepListRoute;
  readonly runCancellationRoute: LocalApiRunCancellationRoute;
  readonly runAttemptLogReadRoute: LocalApiRunAttemptLogReadRoute;
  readonly taskListRoute: LocalApiTaskListRoute;
  readonly taskReadRoute: LocalApiTaskReadRoute;
  readonly taskStartRoute: LocalApiTaskStartRoute;
  readonly taskPutRoute: LocalApiTaskPutRoute;
  readonly taskAuthoringRoute: LocalApiTaskAuthoringRoute;
  readonly triggerListRoute: LocalApiTriggerListRoute;
  readonly triggerReadRoute: LocalApiTriggerReadRoute;
  readonly triggerPutRoute: LocalApiTriggerPutRoute;
  readonly secretListRoute: LocalApiSecretListRoute;
  readonly secretPutRoute: LocalApiSecretPutRoute;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
}

function response(
  statusCode: number,
  code: string,
): Readonly<LocalApiResponse> {
  return Object.freeze({
    statusCode,
    body: Object.freeze({ code }),
  });
}

function timestamp(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('clock is unavailable');
  }
  return value;
}

async function recordAudit(
  audit: SecurityAuditSink,
  request: Readonly<LocalApiAdmissionRequest>,
  outcome: SecurityAuditOutcome,
  reasons: readonly string[],
  principal: Readonly<SecurityPrincipal> | null,
  fence: SecurityPolicyDecision['fence'],
  now: () => number,
  uuid: () => string,
): Promise<void> {
  await audit.record(
    normalizeSecurityAuditRecord({
      eventId: uuid(),
      requestId: request.requestId,
      operationId: request.operation.operationId,
      projectId: request.operation.projectId,
      subject: principal?.subject ?? null,
      authenticationId: principal?.authenticationId ?? null,
      outcome,
      reasons,
      fence,
      occurredAtMs: timestamp(now),
    }),
  );
}

async function audited(
  action: () => Promise<void>,
): Promise<LocalApiResponse | null> {
  try {
    await action();
    return null;
  } catch {
    return response(503, 'security_audit_unavailable');
  }
}

export function createLocalApiAdmission(
  options: LocalApiAdmissionOptions,
): Readonly<LocalApiAdmission> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.authenticator?.authenticate !== 'function' ||
    typeof options.policy?.authorize !== 'function' ||
    typeof options.audit?.record !== 'function' ||
    typeof options.runReadRoute?.handle !== 'function' ||
    typeof options.runListRoute?.handle !== 'function' ||
    typeof options.runEventListRoute?.handle !== 'function' ||
    typeof options.runStepListRoute?.handle !== 'function' ||
    typeof options.runCancellationRoute?.handle !== 'function' ||
    typeof options.runAttemptLogReadRoute?.handle !== 'function' ||
    typeof options.taskListRoute?.handle !== 'function' ||
    typeof options.taskReadRoute?.handle !== 'function' ||
    typeof options.taskStartRoute?.handle !== 'function' ||
    typeof options.taskPutRoute?.handle !== 'function' ||
    typeof options.taskAuthoringRoute?.handle !== 'function' ||
    typeof options.triggerListRoute?.handle !== 'function' ||
    typeof options.triggerReadRoute?.handle !== 'function' ||
    typeof options.triggerPutRoute?.handle !== 'function' ||
    typeof options.secretListRoute?.handle !== 'function' ||
    typeof options.secretPutRoute?.handle !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.randomUuid !== undefined &&
      typeof options.randomUuid !== 'function')
  ) {
    throw new TypeError('Local API admission options are invalid');
  }
  const now = options.now ?? Date.now;
  const uuid = options.randomUuid ?? randomUUID;

  return Object.freeze({
    async prepare(request: Readonly<LocalApiAdmissionRequest>) {
      if (request.signal.aborted) return response(503, 'request_unavailable');
      let authenticated;
      try {
        authenticated = await options.authenticator.authenticate(
          request.authorization,
        );
      } catch {
        const auditFailure = await audited(() =>
          recordAudit(
            options.audit,
            request,
            'authentication_unavailable',
            ['authentication_unavailable'],
            null,
            null,
            now,
            uuid,
          ),
        );
        return auditFailure ?? response(503, 'authentication_unavailable');
      }
      if (!authenticated) {
        const auditFailure = await audited(() =>
          recordAudit(
            options.audit,
            request,
            'authentication_rejected',
            ['authentication_rejected'],
            null,
            null,
            now,
            uuid,
          ),
        );
        return auditFailure ?? response(401, 'authentication_required');
      }
      if (request.signal.aborted) return response(503, 'request_unavailable');

      if (request.operation.operationId === 'task.put') {
        const taskPutOperation = request.operation;
        return Object.freeze({
          bodyMode: 'json' as const,
          maximumBodyBytes: 72 * 1_024,
          async handle(body: unknown | null) {
            return options.taskPutRoute.handle({
              requestId: request.requestId,
              projectId: taskPutOperation.projectId,
              taskId: taskPutOperation.taskId,
              body,
              presence: request.localPresence,
              authoringLease: request.taskAuthoringLease,
              authenticated,
              signal: request.signal,
            });
          },
        });
      }

      if (request.operation.operationId === 'task.authoring') {
        const taskAuthoringOperation = request.operation;
        return Object.freeze({
          bodyMode: 'none' as const,
          maximumBodyBytes: 0,
          async handle(body: unknown | null) {
            if (body !== null) return response(400, 'invalid_request_body');
            return options.taskAuthoringRoute.handle({
              requestId: request.requestId,
              projectId: taskAuthoringOperation.projectId,
              taskId: taskAuthoringOperation.taskId,
              presence: request.localPresence,
              authenticated,
              signal: request.signal,
            });
          },
        });
      }

      if (request.operation.operationId === 'trigger.put') {
        const triggerPutOperation = request.operation;
        return Object.freeze({
          bodyMode: 'json' as const,
          maximumBodyBytes: 20 * 1_024,
          async handle(body: unknown | null) {
            return options.triggerPutRoute.handle({
              requestId: request.requestId,
              projectId: triggerPutOperation.projectId,
              triggerId: triggerPutOperation.triggerId,
              body,
              presence: request.localPresence,
              authenticated,
              signal: request.signal,
            });
          },
        });
      }

      if (request.operation.operationId === 'secret.put') {
        const secretPutOperation = request.operation;
        return Object.freeze({
          bodyMode: 'json' as const,
          maximumBodyBytes: 20 * 1_024,
          async handle(body: unknown | null) {
            return options.secretPutRoute.handle({
              requestId: request.requestId,
              projectId: secretPutOperation.projectId,
              body,
              presence: request.localPresence,
              authenticated,
              signal: request.signal,
            });
          },
        });
      }

      let decision: Readonly<SecurityPolicyDecision>;
      try {
        decision = normalizeSecurityPolicyDecision(
          await options.policy.authorize(
            authenticated.principal,
            request.operation.projectId,
            request.operation.operationId === 'run.cancel'
              ? 'run.stop'
              : request.operation.operationId === 'run.log.read'
              ? 'artifact.read'
              : request.operation.operationId === 'task.start'
              ? 'run.start'
              : request.operation.operationId === 'task.list' ||
                request.operation.operationId === 'task.get' ||
                request.operation.operationId === 'trigger.list' ||
                request.operation.operationId === 'trigger.get'
              ? 'task.read'
              : request.operation.operationId === 'secret.list'
              ? 'secret.manage'
              : 'run.read',
          ),
        );
      } catch {
        const auditFailure = await audited(() =>
          recordAudit(
            options.audit,
            request,
            'authorization_unavailable',
            ['authorization_unavailable'],
            authenticated.principal,
            null,
            now,
            uuid,
          ),
        );
        return auditFailure ?? response(503, 'authorization_unavailable');
      }

      const outcome: SecurityAuditOutcome =
        decision.effect === 'allow'
          ? 'allowed'
          : decision.effect === 'require_approval'
          ? 'approval_required'
          : 'denied';
      const auditFailure = await audited(() =>
        recordAudit(
          options.audit,
          request,
          outcome,
          decision.reasons,
          authenticated.principal,
          decision.fence,
          now,
          uuid,
        ),
      );
      if (auditFailure) return auditFailure;
      if (decision.effect === 'deny') {
        return request.operation.operationId === 'run.log.read'
          ? response(404, 'artifact_not_found')
          : response(403, 'forbidden');
      }
      if (decision.effect === 'require_approval') {
        return request.operation.operationId === 'run.log.read'
          ? response(404, 'artifact_not_found')
          : response(403, 'approval_required');
      }
      if (request.signal.aborted) return response(503, 'request_unavailable');
      try {
        await authenticated.confirm();
      } catch {
        return response(503, 'authentication_unavailable');
      }
      if (request.signal.aborted) return response(503, 'request_unavailable');
      const bodyMode =
        request.operation.operationId === 'run.cancel' ||
        request.operation.operationId === 'task.start'
          ? 'json'
          : 'none';
      return Object.freeze({
        bodyMode,
        maximumBodyBytes: bodyMode === 'json' ? 512 : 0,
        async handle(body: unknown | null) {
          if (request.signal.aborted) {
            return response(503, 'request_unavailable');
          }
          switch (request.operation.operationId) {
            case 'run.get':
              if (body !== null) return response(400, 'invalid_request_body');
              return options.runReadRoute.handle({
                projectId: request.operation.projectId,
                runId: request.operation.runId,
              });
            case 'run.list':
              if (body !== null) return response(400, 'invalid_request_body');
              return options.runListRoute.handle({
                projectId: request.operation.projectId,
                input: request.operation.input,
              });
            case 'run.events.list':
              if (body !== null) return response(400, 'invalid_request_body');
              return options.runEventListRoute.handle({
                projectId: request.operation.projectId,
                runId: request.operation.runId,
                input: request.operation.input,
              });
            case 'run.steps.list':
              if (body !== null) return response(400, 'invalid_request_body');
              return options.runStepListRoute.handle({
                projectId: request.operation.projectId,
                runId: request.operation.runId,
                input: request.operation.input,
              });
            case 'run.cancel':
              return options.runCancellationRoute.handle({
                projectId: request.operation.projectId,
                runId: request.operation.runId,
                body,
                principal: authenticated.principal,
                policyFence: decision.fence,
              });
            case 'run.log.read':
              if (body !== null) return response(400, 'invalid_request_body');
              return options.runAttemptLogReadRoute.handle({
                projectId: request.operation.projectId,
                runId: request.operation.runId,
                attemptId: request.operation.attemptId,
                offset: request.operation.offset,
                length: request.operation.length,
                signal: request.signal,
              });
            case 'task.list':
              if (body !== null) return response(400, 'invalid_request_body');
              return options.taskListRoute.handle({
                projectId: request.operation.projectId,
                input: request.operation.input,
              });
            case 'task.get':
              if (body !== null) return response(400, 'invalid_request_body');
              return options.taskReadRoute.handle({
                projectId: request.operation.projectId,
                taskId: request.operation.taskId,
              });
            case 'task.start':
              return options.taskStartRoute.handle({
                projectId: request.operation.projectId,
                taskId: request.operation.taskId,
                body,
                principal: authenticated.principal,
                policyFence: decision.fence,
              });
            case 'trigger.list':
              if (body !== null) return response(400, 'invalid_request_body');
              return options.triggerListRoute.handle({
                projectId: request.operation.projectId,
                limit: request.operation.limit,
                ...(request.operation.after
                  ? { after: request.operation.after }
                  : {}),
              });
            case 'trigger.get':
              if (body !== null) return response(400, 'invalid_request_body');
              return options.triggerReadRoute.handle({
                projectId: request.operation.projectId,
                triggerId: request.operation.triggerId,
              });
            case 'secret.list':
              if (body !== null) return response(400, 'invalid_request_body');
              return options.secretListRoute.handle({
                projectId: request.operation.projectId,
                limit: request.operation.limit,
                ...(request.operation.after
                  ? { after: request.operation.after }
                  : {}),
              });
            case 'task.put':
            case 'task.authoring':
            case 'trigger.put':
            case 'secret.put':
              return response(503, 'request_unavailable');
          }
        },
      });
    },
  });
}
