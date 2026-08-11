import { randomUUID } from 'node:crypto';

import {
  PostgresProjectPolicyRepository,
  PostgresRunManualRetryRepository,
  PostgresSecurityAuditRepository,
} from '@qinglong/cluster-postgres/run-manager';
import type { PostgresPool } from '@qinglong/runtime-core';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import {
  InvalidRunManualRetryError,
  RunManualRetryFenceRejectedError,
  RunManualRetryNotFoundError,
  RunManualRetryRateLimitedError,
  RunManualRetryUnavailableError,
  type RunManualRetryResult,
  type RunManualRetrySourceStatus,
} from '@qinglong/runtime-core/run-manual-retry';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyFence,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import { normalizeSecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ClusterRunManagementRetryRequest {
  readonly projectId: string;
  readonly sourceRunId: string;
  readonly mutationId: string;
  readonly expectedRunVersion: number;
  readonly expectedRunStatus: RunManualRetrySourceStatus;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly failureAuditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
}

export interface ClusterRunManagementService {
  retry(
    request: Readonly<ClusterRunManagementRetryRequest>,
  ): Promise<Readonly<RunManualRetryResult>>;
}

export interface ClusterRunManagementOptions {
  readonly pool: PostgresPool;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
}

export class ClusterRunManagementConfigurationError extends TypeError {
  readonly code = 'CLUSTER_RUN_MANAGEMENT_CONFIGURATION_INVALID';
  constructor() {
    super('Cluster Run management configuration is invalid');
    this.name = 'ClusterRunManagementConfigurationError';
  }
}

export class ClusterRunManagementRequestError extends TypeError {
  readonly code = 'CLUSTER_RUN_MANAGEMENT_REQUEST_INVALID';
  constructor() {
    super('Cluster Run management request is invalid');
    this.name = 'ClusterRunManagementRequestError';
  }
}

export class ClusterRunManagementAuthorizationError extends Error {
  readonly code = 'CLUSTER_RUN_MANAGEMENT_FORBIDDEN';
  constructor() {
    super('Cluster Run management is forbidden');
    this.name = 'ClusterRunManagementAuthorizationError';
  }
}

export class ClusterRunManagementTargetUnavailableError extends Error {
  readonly code = 'CLUSTER_RUN_MANAGEMENT_TARGET_UNAVAILABLE';
  constructor() {
    super('Cluster Run management target is unavailable');
    this.name = 'ClusterRunManagementTargetUnavailableError';
  }
}

export class ClusterRunManagementConflictError extends Error {
  readonly code = 'CLUSTER_RUN_MANAGEMENT_CONFLICT';
  constructor() {
    super('Cluster Run management conflicts with durable state');
    this.name = 'ClusterRunManagementConflictError';
  }
}

export class ClusterRunManagementRateLimitedError extends Error {
  readonly code = 'CLUSTER_RUN_MANAGEMENT_RATE_LIMITED';
  constructor(readonly retryAfterMs: number) {
    super('Cluster Run management rate limit is exhausted');
    this.name = 'ClusterRunManagementRateLimitedError';
  }
}

export class ClusterRunManagementUnavailableError extends Error {
  readonly code = 'CLUSTER_RUN_MANAGEMENT_UNAVAILABLE';
  constructor(options?: ErrorOptions) {
    super('Cluster Run management is unavailable', options);
    this.name = 'ClusterRunManagementUnavailableError';
  }
}

function exactRequest(
  value: unknown,
): asserts value is Readonly<ClusterRunManagementRetryRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'auditEventId',
        'expectedRunStatus',
        'expectedRunVersion',
        'failureAuditEventId',
        'mutationId',
        'principal',
        'projectId',
        'requestId',
        'sourceRunId',
      ]
        .sort()
        .join('\0')
  ) {
    throw new ClusterRunManagementRequestError();
  }
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function failureReason(error: unknown): string {
  if (error instanceof ClusterRunManagementAuthorizationError) {
    return 'authorization_rejected';
  }
  if (error instanceof RunManualRetryNotFoundError) return 'run_not_found';
  if (error instanceof RunManualRetryRateLimitedError) return 'rate_limited';
  if (error instanceof RunManualRetryFenceRejectedError) return error.reason;
  return 'management_unavailable';
}

/** Strong OIDC Run management composition over one run-manager Pool. */
export function createClusterRunManagementService(
  options: ClusterRunManagementOptions,
): Readonly<ClusterRunManagementService> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) => key !== 'pool' && key !== 'now' && key !== 'randomUuid',
    ) ||
    !options.pool ||
    typeof options.pool.query !== 'function' ||
    typeof options.pool.connect !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.randomUuid !== undefined && typeof options.randomUuid !== 'function')
  ) {
    throw new ClusterRunManagementConfigurationError();
  }
  const now = options.now ?? Date.now;
  const createId = options.randomUuid ?? randomUUID;
  const policy = new ProjectPolicyEngine(
    new PostgresProjectPolicyRepository(options.pool),
  );
  const retries = new PostgresRunManualRetryRepository(options.pool);
  const audit = new PostgresSecurityAuditRepository(options.pool);

  return Object.freeze({
    async retry(requestValue: Readonly<ClusterRunManagementRetryRequest>) {
      exactRequest(requestValue);
      const observedAtMs = now();
      let principal: Readonly<SecurityPrincipal>;
      if (
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < 0 ||
        !IDENTIFIER_PATTERN.test(requestValue.projectId) ||
        !IDENTIFIER_PATTERN.test(requestValue.sourceRunId) ||
        !IDENTIFIER_PATTERN.test(requestValue.requestId) ||
        !validUuid(requestValue.mutationId) ||
        !validUuid(requestValue.auditEventId) ||
        !validUuid(requestValue.failureAuditEventId) ||
        requestValue.auditEventId === requestValue.failureAuditEventId
      ) {
        throw new ClusterRunManagementRequestError();
      }
      try {
        principal = normalizeSecurityPrincipal(
          requestValue.principal,
          observedAtMs,
        );
      } catch {
        throw new ClusterRunManagementRequestError();
      }

      let fence: Readonly<SecurityPolicyFence> | null = null;
      try {
        const decision = await policy.authorize(
          principal,
          requestValue.projectId,
          'run.retry',
        );
        fence = decision.fence;
        if (
          decision.effect !== 'allow' ||
          !fence ||
          fence.bindingVersion === null
        ) {
          throw new ClusterRunManagementAuthorizationError();
        }
        return await retries.retryRun({
          projectId: requestValue.projectId,
          sourceRunId: requestValue.sourceRunId,
          mutationId: requestValue.mutationId,
          expectedRunVersion: requestValue.expectedRunVersion,
          expectedRunStatus: requestValue.expectedRunStatus,
          runId: createId(),
          attemptId: createId(),
          createdEventId: createId(),
          queuedEventId: createId(),
          auditEventId: requestValue.auditEventId,
          requestId: requestValue.requestId,
          principal,
          policyFence: fence,
        });
      } catch (error) {
        try {
          await audit.record(
            normalizeSecurityAuditRecord({
              eventId: requestValue.failureAuditEventId,
              requestId: requestValue.requestId,
              operationId: 'run.retry',
              projectId: requestValue.projectId,
              subject: principal.subject,
              authenticationId: principal.authenticationId,
              outcome: 'denied',
              reasons: [failureReason(error)],
              fence,
              occurredAtMs: observedAtMs,
            }),
          );
        } catch (auditError) {
          throw new ClusterRunManagementUnavailableError({ cause: auditError });
        }
        if (error instanceof ClusterRunManagementAuthorizationError) throw error;
        if (error instanceof InvalidRunManualRetryError) {
          throw new ClusterRunManagementRequestError();
        }
        if (error instanceof RunManualRetryNotFoundError) {
          throw new ClusterRunManagementTargetUnavailableError();
        }
        if (error instanceof RunManualRetryFenceRejectedError) {
          throw new ClusterRunManagementConflictError();
        }
        if (error instanceof RunManualRetryRateLimitedError) {
          throw new ClusterRunManagementRateLimitedError(error.retryAfterMs);
        }
        if (error instanceof RunManualRetryUnavailableError) {
          throw new ClusterRunManagementUnavailableError({ cause: error });
        }
        throw new ClusterRunManagementUnavailableError({ cause: error });
      }
    },
  });
}
