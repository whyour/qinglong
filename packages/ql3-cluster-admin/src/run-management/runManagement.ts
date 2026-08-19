import { randomUUID } from 'node:crypto';

import {
  InvalidRunCancellationDispatchManagementError,
  PostgresClusterRunCancellationRepository,
  PostgresProjectPolicyRepository,
  PostgresRunCancellationDispatchManagementRepository,
  PostgresRunManualRetryRepository,
  PostgresSecurityAuditRepository,
  RunCancellationDispatchManagementConflictError,
  RunCancellationDispatchManagementNotFoundError,
  RunCancellationDispatchManagementUnavailableError,
  type BlockingCancellationDispatchResult,
  type RunCancellationDispatchBlockedCursor,
  type RunCancellationDispatchBlockedPage,
  type RunCancellationDispatchDiagnostic,
  type RunCancellationDispatchRearmReceipt,
  type RunCancellationDispatchSummary,
} from '@qinglong/cluster-postgres/run-manager';
import type { PostgresPool } from '@qinglong/runtime-core';
import { CANCELLATION_DISPATCH_BLOCKING_RESULTS } from '@qinglong/runtime-core/cancellation-dispatch';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import {
  ClusterRunCancellationFenceRejectedError,
  ClusterRunCancellationNotFoundError,
  ClusterRunCancellationUnavailableError,
  InvalidClusterRunCancellationError,
  type ClusterRunCancellationResult,
} from '@qinglong/runtime-core/run-cancellation';
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

export interface ClusterRunManagementStopRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly failureAuditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
}

export interface ClusterRunManagementCancellationInspectRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly failureAuditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
}

export interface ClusterRunManagementCancellationSummaryRequest {
  readonly projectId: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly failureAuditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
}

export interface ClusterRunManagementCancellationBlockedListRequest
  extends ClusterRunManagementCancellationSummaryRequest {
  readonly after?: Readonly<RunCancellationDispatchBlockedCursor>;
}

export interface ClusterRunManagementCancellationRearmRequest
  extends ClusterRunManagementCancellationInspectRequest {
  readonly mutationId: string;
  readonly expectedDispatchVersion: number;
  readonly expectedLastResult: BlockingCancellationDispatchResult;
  readonly retryDelayMs: number;
}

export interface ClusterRunManagementService {
  retry(
    request: Readonly<ClusterRunManagementRetryRequest>,
  ): Promise<Readonly<RunManualRetryResult>>;
  stop(
    request: Readonly<ClusterRunManagementStopRequest>,
  ): Promise<Readonly<ClusterRunCancellationResult>>;
  summarizeCancellation(
    request: Readonly<ClusterRunManagementCancellationSummaryRequest>,
  ): Promise<Readonly<RunCancellationDispatchSummary>>;
  listBlockedCancellations(
    request: Readonly<ClusterRunManagementCancellationBlockedListRequest>,
  ): Promise<Readonly<RunCancellationDispatchBlockedPage>>;
  inspectCancellation(
    request: Readonly<ClusterRunManagementCancellationInspectRequest>,
  ): Promise<Readonly<RunCancellationDispatchDiagnostic>>;
  rearmCancellation(
    request: Readonly<ClusterRunManagementCancellationRearmRequest>,
  ): Promise<Readonly<RunCancellationDispatchRearmReceipt>>;
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

function exactRetryRequest(
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

function exactStopRequest(
  value: unknown,
): asserts value is Readonly<ClusterRunManagementStopRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'auditEventId',
        'failureAuditEventId',
        'mutationId',
        'principal',
        'projectId',
        'requestId',
        'runId',
      ]
        .sort()
        .join('\0')
  ) {
    throw new ClusterRunManagementRequestError();
  }
}

function exactCancellationInspectRequest(
  value: unknown,
): asserts value is Readonly<ClusterRunManagementCancellationInspectRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'auditEventId',
        'failureAuditEventId',
        'principal',
        'projectId',
        'requestId',
        'runId',
      ]
        .sort()
        .join('\0')
  ) {
    throw new ClusterRunManagementRequestError();
  }
}

function exactCancellationSummaryRequest(
  value: unknown,
): asserts value is Readonly<ClusterRunManagementCancellationSummaryRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'auditEventId',
        'failureAuditEventId',
        'principal',
        'projectId',
        'requestId',
      ]
        .sort()
        .join('\0')
  ) {
    throw new ClusterRunManagementRequestError();
  }
}

function exactCancellationBlockedListRequest(
  value: unknown,
): asserts value is Readonly<ClusterRunManagementCancellationBlockedListRequest> {
  const hasAfter =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'after');
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'auditEventId',
        'failureAuditEventId',
        'principal',
        'projectId',
        'requestId',
        ...(hasAfter ? ['after'] : []),
      ]
        .sort()
        .join('\0')
  ) {
    throw new ClusterRunManagementRequestError();
  }
}

function exactCancellationRearmRequest(
  value: unknown,
): asserts value is Readonly<ClusterRunManagementCancellationRearmRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'auditEventId',
        'expectedDispatchVersion',
        'expectedLastResult',
        'failureAuditEventId',
        'mutationId',
        'principal',
        'projectId',
        'requestId',
        'retryDelayMs',
        'runId',
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
  if (error instanceof ClusterRunCancellationNotFoundError) {
    return 'run_not_found';
  }
  if (error instanceof ClusterRunCancellationFenceRejectedError) {
    return error.reason;
  }
  if (error instanceof RunCancellationDispatchManagementNotFoundError) {
    return 'run_not_found';
  }
  if (error instanceof RunCancellationDispatchManagementConflictError) {
    return error.reason;
  }
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
    (options.randomUuid !== undefined &&
      typeof options.randomUuid !== 'function')
  ) {
    throw new ClusterRunManagementConfigurationError();
  }
  const now = options.now ?? Date.now;
  const createId = options.randomUuid ?? randomUUID;
  const policy = new ProjectPolicyEngine(
    new PostgresProjectPolicyRepository(options.pool),
  );
  const retries = new PostgresRunManualRetryRepository(options.pool);
  const cancellations = new PostgresClusterRunCancellationRepository(
    options.pool,
  );
  const cancellationDispatches =
    new PostgresRunCancellationDispatchManagementRepository(options.pool);
  const audit = new PostgresSecurityAuditRepository(options.pool);

  return Object.freeze({
    async retry(requestValue: Readonly<ClusterRunManagementRetryRequest>) {
      exactRetryRequest(requestValue);
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
        if (error instanceof ClusterRunManagementAuthorizationError)
          throw error;
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
    async stop(requestValue: Readonly<ClusterRunManagementStopRequest>) {
      exactStopRequest(requestValue);
      const observedAtMs = now();
      let principal: Readonly<SecurityPrincipal>;
      if (
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < 0 ||
        !IDENTIFIER_PATTERN.test(requestValue.projectId) ||
        !IDENTIFIER_PATTERN.test(requestValue.runId) ||
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
          'run.stop',
        );
        fence = decision.fence;
        if (
          decision.effect !== 'allow' ||
          !fence ||
          fence.bindingVersion === null
        ) {
          throw new ClusterRunManagementAuthorizationError();
        }
        return await cancellations.requestUserCancellationAudited({
          projectId: requestValue.projectId,
          runId: requestValue.runId,
          mutationId: requestValue.mutationId,
          eventId: createId(),
          requestId: requestValue.requestId,
          auditEventId: requestValue.auditEventId,
          principal,
          policyFence: fence,
        });
      } catch (error) {
        try {
          await audit.record(
            normalizeSecurityAuditRecord({
              eventId: requestValue.failureAuditEventId,
              requestId: requestValue.requestId,
              operationId: 'run.stop',
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
        if (error instanceof ClusterRunManagementAuthorizationError)
          throw error;
        if (error instanceof InvalidClusterRunCancellationError) {
          throw new ClusterRunManagementRequestError();
        }
        if (error instanceof ClusterRunCancellationNotFoundError) {
          throw new ClusterRunManagementTargetUnavailableError();
        }
        if (error instanceof ClusterRunCancellationFenceRejectedError) {
          throw new ClusterRunManagementConflictError();
        }
        if (error instanceof ClusterRunCancellationUnavailableError) {
          throw new ClusterRunManagementUnavailableError({ cause: error });
        }
        throw new ClusterRunManagementUnavailableError({ cause: error });
      }
    },
    async summarizeCancellation(
      requestValue: Readonly<ClusterRunManagementCancellationSummaryRequest>,
    ) {
      exactCancellationSummaryRequest(requestValue);
      const observedAtMs = now();
      let principal: Readonly<SecurityPrincipal>;
      if (
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < 0 ||
        !IDENTIFIER_PATTERN.test(requestValue.projectId) ||
        !IDENTIFIER_PATTERN.test(requestValue.requestId) ||
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
          'run.read',
        );
        fence = decision.fence;
        if (
          decision.effect !== 'allow' ||
          !fence ||
          fence.bindingVersion === null
        ) {
          throw new ClusterRunManagementAuthorizationError();
        }
        return await cancellationDispatches.summary({
          projectId: requestValue.projectId,
          requestId: requestValue.requestId,
          auditEventId: requestValue.auditEventId,
          principal,
          policyFence: fence,
        });
      } catch (error) {
        try {
          await audit.record(
            normalizeSecurityAuditRecord({
              eventId: requestValue.failureAuditEventId,
              requestId: requestValue.requestId,
              operationId: 'run.cancellation.summary',
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
        if (error instanceof InvalidRunCancellationDispatchManagementError) {
          throw new ClusterRunManagementRequestError();
        }
        if (error instanceof RunCancellationDispatchManagementConflictError) {
          throw new ClusterRunManagementConflictError();
        }
        if (error instanceof RunCancellationDispatchManagementUnavailableError) {
          throw new ClusterRunManagementUnavailableError({ cause: error });
        }
        throw new ClusterRunManagementUnavailableError({ cause: error });
      }
    },
    async listBlockedCancellations(
      requestValue: Readonly<ClusterRunManagementCancellationBlockedListRequest>,
    ) {
      exactCancellationBlockedListRequest(requestValue);
      const observedAtMs = now();
      let principal: Readonly<SecurityPrincipal>;
      const after = requestValue.after;
      if (
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < 0 ||
        !IDENTIFIER_PATTERN.test(requestValue.projectId) ||
        !IDENTIFIER_PATTERN.test(requestValue.requestId) ||
        !validUuid(requestValue.auditEventId) ||
        !validUuid(requestValue.failureAuditEventId) ||
        requestValue.auditEventId === requestValue.failureAuditEventId ||
        (after !== undefined &&
          (!after ||
            typeof after !== 'object' ||
            Array.isArray(after) ||
            Object.keys(after).sort().join('\0') !==
              ['blockedAtMs', 'runId', 'snapshotAtMs'].join('\0') ||
            !Number.isSafeInteger(after.snapshotAtMs) ||
            after.snapshotAtMs < 0 ||
            !Number.isSafeInteger(after.blockedAtMs) ||
            after.blockedAtMs < 0 ||
            after.blockedAtMs > after.snapshotAtMs ||
            !IDENTIFIER_PATTERN.test(after.runId)))
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
          'run.read',
        );
        fence = decision.fence;
        if (
          decision.effect !== 'allow' ||
          !fence ||
          fence.bindingVersion === null
        ) {
          throw new ClusterRunManagementAuthorizationError();
        }
        return await cancellationDispatches.listBlocked({
          projectId: requestValue.projectId,
          requestId: requestValue.requestId,
          auditEventId: requestValue.auditEventId,
          principal,
          policyFence: fence,
          ...(after === undefined ? {} : { after }),
        });
      } catch (error) {
        try {
          await audit.record(
            normalizeSecurityAuditRecord({
              eventId: requestValue.failureAuditEventId,
              requestId: requestValue.requestId,
              operationId: 'run.cancellation.blocked.list',
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
        if (error instanceof InvalidRunCancellationDispatchManagementError) {
          throw new ClusterRunManagementRequestError();
        }
        if (error instanceof RunCancellationDispatchManagementConflictError) {
          throw new ClusterRunManagementConflictError();
        }
        if (error instanceof RunCancellationDispatchManagementUnavailableError) {
          throw new ClusterRunManagementUnavailableError({ cause: error });
        }
        throw new ClusterRunManagementUnavailableError({ cause: error });
      }
    },
    async inspectCancellation(
      requestValue: Readonly<ClusterRunManagementCancellationInspectRequest>,
    ) {
      exactCancellationInspectRequest(requestValue);
      const observedAtMs = now();
      let principal: Readonly<SecurityPrincipal>;
      if (
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < 0 ||
        !IDENTIFIER_PATTERN.test(requestValue.projectId) ||
        !IDENTIFIER_PATTERN.test(requestValue.runId) ||
        !IDENTIFIER_PATTERN.test(requestValue.requestId) ||
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
          'run.read',
        );
        fence = decision.fence;
        if (
          decision.effect !== 'allow' ||
          !fence ||
          fence.bindingVersion === null
        ) {
          throw new ClusterRunManagementAuthorizationError();
        }
        return await cancellationDispatches.inspect({
          projectId: requestValue.projectId,
          runId: requestValue.runId,
          requestId: requestValue.requestId,
          auditEventId: requestValue.auditEventId,
          principal,
          policyFence: fence,
        });
      } catch (error) {
        try {
          await audit.record(
            normalizeSecurityAuditRecord({
              eventId: requestValue.failureAuditEventId,
              requestId: requestValue.requestId,
              operationId: 'run.cancellation.inspect',
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
        if (error instanceof InvalidRunCancellationDispatchManagementError) {
          throw new ClusterRunManagementRequestError();
        }
        if (error instanceof RunCancellationDispatchManagementNotFoundError) {
          throw new ClusterRunManagementTargetUnavailableError();
        }
        if (error instanceof RunCancellationDispatchManagementConflictError) {
          throw new ClusterRunManagementConflictError();
        }
        if (error instanceof RunCancellationDispatchManagementUnavailableError) {
          throw new ClusterRunManagementUnavailableError({ cause: error });
        }
        throw new ClusterRunManagementUnavailableError({ cause: error });
      }
    },
    async rearmCancellation(
      requestValue: Readonly<ClusterRunManagementCancellationRearmRequest>,
    ) {
      exactCancellationRearmRequest(requestValue);
      const observedAtMs = now();
      let principal: Readonly<SecurityPrincipal>;
      if (
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < 0 ||
        !IDENTIFIER_PATTERN.test(requestValue.projectId) ||
        !IDENTIFIER_PATTERN.test(requestValue.runId) ||
        !IDENTIFIER_PATTERN.test(requestValue.requestId) ||
        !validUuid(requestValue.mutationId) ||
        !validUuid(requestValue.auditEventId) ||
        !validUuid(requestValue.failureAuditEventId) ||
        requestValue.auditEventId === requestValue.failureAuditEventId ||
        !Number.isSafeInteger(requestValue.expectedDispatchVersion) ||
        requestValue.expectedDispatchVersion < 1 ||
        requestValue.expectedDispatchVersion >= 2_147_483_647 ||
        !CANCELLATION_DISPATCH_BLOCKING_RESULTS.includes(
          requestValue.expectedLastResult,
        ) ||
        !Number.isSafeInteger(requestValue.retryDelayMs) ||
        requestValue.retryDelayMs < 1_000 ||
        requestValue.retryDelayMs > 24 * 60 * 60_000
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
          'run.stop',
        );
        fence = decision.fence;
        if (
          decision.effect !== 'allow' ||
          !fence ||
          fence.bindingVersion === null
        ) {
          throw new ClusterRunManagementAuthorizationError();
        }
        return await cancellationDispatches.rearm({
          projectId: requestValue.projectId,
          runId: requestValue.runId,
          requestId: requestValue.requestId,
          auditEventId: requestValue.auditEventId,
          principal,
          policyFence: fence,
          mutationId: requestValue.mutationId,
          eventId: createId(),
          expectedDispatchVersion: requestValue.expectedDispatchVersion,
          expectedLastResult: requestValue.expectedLastResult,
          retryDelayMs: requestValue.retryDelayMs,
        });
      } catch (error) {
        try {
          await audit.record(
            normalizeSecurityAuditRecord({
              eventId: requestValue.failureAuditEventId,
              requestId: requestValue.requestId,
              operationId: 'run.cancellation.rearm',
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
        if (error instanceof InvalidRunCancellationDispatchManagementError) {
          throw new ClusterRunManagementRequestError();
        }
        if (error instanceof RunCancellationDispatchManagementNotFoundError) {
          throw new ClusterRunManagementTargetUnavailableError();
        }
        if (error instanceof RunCancellationDispatchManagementConflictError) {
          throw new ClusterRunManagementConflictError();
        }
        if (error instanceof RunCancellationDispatchManagementUnavailableError) {
          throw new ClusterRunManagementUnavailableError({ cause: error });
        }
        throw new ClusterRunManagementUnavailableError({ cause: error });
      }
    },
  });
}
