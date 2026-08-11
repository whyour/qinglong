// Transport owns authenticated, Policy-fenced and synchronously audited admission.
import { randomUUID } from 'node:crypto';
import {
  normalizeSecurityPolicyDecision,
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditOutcome,
  type SecurityAuditRecord,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';
import {
  ProjectPolicyEngine,
  normalizeProjectPermission,
  type ProjectPolicyRepository,
} from '@qinglong/runtime-core/project-policy';
import type {
  ClusterControlAdmissionMetadata,
  ClusterControlAdmissionPipeline,
} from './httpSurface';
import {
  ClusterControlRouteResolutionError,
  isClusterControlRouteRegistry,
  type ClusterControlAuthorizedOperationRequest,
  type ClusterControlRoute,
  type ClusterControlRouteRegistry,
} from './routeRegistry';

export type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRoute,
  ClusterControlRouteRegistry,
} from './routeRegistry';

export interface ClusterControlRequestAuthenticator {
  authenticate(
    request: ClusterControlAdmissionMetadata,
  ): SecurityPrincipal | null | Promise<SecurityPrincipal | null>;
}

export interface ClusterControlPolicyRequest {
  readonly principal: Readonly<SecurityPrincipal>;
  readonly operationId: string;
  readonly permission: string;
  readonly projectId: string | null;
  readonly signal: AbortSignal;
}

export interface ClusterControlPolicyAuthorizer {
  authorize(
    request: ClusterControlPolicyRequest,
  ): SecurityPolicyDecision | Promise<SecurityPolicyDecision>;
}

export type ClusterControlSecurityAuditOutcome = SecurityAuditOutcome;
export type ClusterControlSecurityAuditRecord = SecurityAuditRecord;
export type ClusterControlSecurityAuditSink = SecurityAuditSink;

export interface ClusterControlAdmissionPipelineOptions {
  readonly routes: ClusterControlRouteRegistry;
  readonly authenticator: ClusterControlRequestAuthenticator;
  readonly policy: ClusterControlPolicyAuthorizer;
  readonly audit: ClusterControlSecurityAuditSink;
  readonly now?: () => number;
}

export class ClusterControlAdmissionSecurityError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClusterControlAdmissionSecurityError';
  }
}

/** Adapts the shared Project Policy engine to cluster admission. */
export function createClusterControlProjectPolicyAuthorizer(
  repository: ProjectPolicyRepository,
): ClusterControlPolicyAuthorizer {
  const engine = new ProjectPolicyEngine(repository);
  return Object.freeze({
    authorize(request: ClusterControlPolicyRequest) {
      if (request.projectId === null) {
        return Object.freeze({
          effect: 'deny' as const,
          reasons: Object.freeze(['project_scope_required']),
          fence: null,
        });
      }
      return engine.authorize(
        request.principal,
        request.projectId,
        normalizeProjectPermission(request.permission),
      );
    },
  });
}

function securityError(
  statusCode: number,
  code: string,
  message: string,
): ClusterControlAdmissionSecurityError {
  return new ClusterControlAdmissionSecurityError(statusCode, code, message);
}

async function recordSecurityAudit(
  audit: ClusterControlSecurityAuditSink,
  record: Omit<SecurityAuditRecord, 'eventId' | 'occurredAtMs'>,
  now: () => number,
): Promise<void> {
  try {
    await audit.record(
      normalizeSecurityAuditRecord({
        ...record,
        eventId: randomUUID(),
        occurredAtMs: now(),
      }),
    );
  } catch {
    throw securityError(
      503,
      'security_audit_unavailable',
      'Cluster-control security audit is unavailable',
    );
  }
}

/**
 * Creates a fail-closed, two-phase admission pipeline. Route matching,
 * authentication, policy evaluation and durable security audit all complete
 * before the returned operation is allowed to receive a request body.
 */
export function createClusterControlAdmissionPipeline(
  options: ClusterControlAdmissionPipelineOptions,
): ClusterControlAdmissionPipeline {
  if (
    !options ||
    typeof options !== 'object' ||
    !isClusterControlRouteRegistry(options.routes) ||
    typeof options.authenticator?.authenticate !== 'function' ||
    typeof options.policy?.authorize !== 'function' ||
    typeof options.audit?.record !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new TypeError(
      'Cluster-control admission pipeline options are invalid',
    );
  }
  const now = options.now ?? Date.now;

  return Object.freeze({
    async prepare(request: ClusterControlAdmissionMetadata) {
      let route: ClusterControlRoute;
      try {
        const resolved = await options.routes.resolve(request);
        if (!resolved) {
          throw securityError(
            404,
            'route_not_found',
            'Cluster-control route was not found',
          );
        }
        route = resolved;
      } catch (error) {
        if (
          error instanceof ClusterControlAdmissionSecurityError ||
          error instanceof ClusterControlRouteResolutionError
        ) {
          throw error;
        }
        throw securityError(
          503,
          'route_resolution_unavailable',
          'Cluster-control route resolution is unavailable',
        );
      }

      let candidate: SecurityPrincipal | null;
      try {
        candidate = await options.authenticator.authenticate(request);
      } catch {
        await recordSecurityAudit(
          options.audit,
          {
            requestId: request.requestId,
            operationId: route.operationId,
            projectId: route.projectId,
            subject: null,
            authenticationId: null,
            outcome: 'authentication_unavailable',
            reasons: Object.freeze(['authentication_unavailable']),
            fence: null,
          },
          now,
        );
        throw securityError(
          503,
          'authentication_unavailable',
          'Cluster-control authentication is unavailable',
        );
      }
      if (!candidate) {
        await recordSecurityAudit(
          options.audit,
          {
            requestId: request.requestId,
            operationId: route.operationId,
            projectId: route.projectId,
            subject: null,
            authenticationId: null,
            outcome: 'authentication_rejected',
            reasons: Object.freeze(['authentication_rejected']),
            fence: null,
          },
          now,
        );
        throw securityError(
          401,
          'authentication_required',
          'Cluster-control authentication is required',
        );
      }

      let principal: Readonly<SecurityPrincipal>;
      try {
        principal = normalizeSecurityPrincipal(candidate, now());
      } catch {
        await recordSecurityAudit(
          options.audit,
          {
            requestId: request.requestId,
            operationId: route.operationId,
            projectId: route.projectId,
            subject: null,
            authenticationId: null,
            outcome: 'authentication_unavailable',
            reasons: Object.freeze(['invalid_principal']),
            fence: null,
          },
          now,
        );
        throw securityError(
          503,
          'authentication_unavailable',
          'Cluster-control authentication is unavailable',
        );
      }

      let decision: Readonly<SecurityPolicyDecision>;
      try {
        decision = normalizeSecurityPolicyDecision(
          await options.policy.authorize(
            Object.freeze({
              principal,
              operationId: route.operationId,
              permission: route.permission,
              projectId: route.projectId,
              signal: request.signal,
            }),
          ),
        );
      } catch {
        await recordSecurityAudit(
          options.audit,
          {
            requestId: request.requestId,
            operationId: route.operationId,
            projectId: route.projectId,
            subject: principal.subject,
            authenticationId: principal.authenticationId,
            outcome: 'authorization_unavailable',
            reasons: Object.freeze(['authorization_unavailable']),
            fence: null,
          },
          now,
        );
        throw securityError(
          503,
          'authorization_unavailable',
          'Cluster-control authorization is unavailable',
        );
      }

      const outcome =
        decision.effect === 'allow'
          ? 'allowed'
          : decision.effect === 'require_approval'
          ? 'approval_required'
          : 'denied';
      await recordSecurityAudit(
        options.audit,
        {
          requestId: request.requestId,
          operationId: route.operationId,
          projectId: route.projectId,
          subject: principal.subject,
          authenticationId: principal.authenticationId,
          outcome,
          reasons: decision.reasons,
          fence: decision.fence,
        },
        now,
      );
      if (decision.effect === 'deny') {
        if (route.permission === 'artifact.read') {
          throw securityError(
            404,
            'artifact_not_found',
            'Cluster-control Artifact is not available',
          );
        }
        throw securityError(
          403,
          'forbidden',
          'Cluster-control operation is forbidden',
        );
      }
      if (decision.effect === 'require_approval') {
        if (route.permission === 'artifact.read') {
          throw securityError(
            404,
            'artifact_not_found',
            'Cluster-control Artifact is not available',
          );
        }
        throw securityError(
          403,
          'approval_required',
          'Cluster-control operation requires approval',
        );
      }

      return Object.freeze({
        handle(body: unknown | null) {
          return route.handle(
            Object.freeze({
              request: Object.freeze({ ...request, body }),
              principal,
              operationId: route.operationId,
              permission: route.permission,
              projectId: route.projectId,
              policyFence: decision.fence,
            }),
          );
        },
      });
    },
  });
}
