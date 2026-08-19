import {
  createRunManualRetryResponseBody,
  parseRunManualRetryRequestBody,
  type RunManualRetryResponseBody,
} from '@qinglong/runtime-core/run-manual-retry';
import {
  createRunCancellationResponseBody,
  parseRunCancellationRequestBody,
  type RunCancellationResponseBody,
} from '@qinglong/runtime-core/run-cancellation';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import { CANCELLATION_DISPATCH_BLOCKING_RESULTS } from '@qinglong/runtime-core/cancellation-dispatch';
import type { ClusterRunManagementService } from './runManagement';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STRONG_ASSURANCES = new Set(['multi_factor', 'hardware']);

export const RUN_CANCELLATION_DISPATCH_INSPECT_REQUEST_SCHEMA =
  'qinglong/run-cancellation-dispatch-inspect@v1';
export const RUN_CANCELLATION_DISPATCH_SUMMARY_REQUEST_SCHEMA =
  'qinglong/run-cancellation-dispatch-summary-request@v1';
export const RUN_CANCELLATION_DISPATCH_SUMMARY_SCHEMA =
  'qinglong/run-cancellation-dispatch-summary@v1';
export const RUN_CANCELLATION_DISPATCH_DIAGNOSTIC_SCHEMA =
  'qinglong/run-cancellation-dispatch-diagnostic@v1';
export const RUN_CANCELLATION_DISPATCH_REARM_REQUEST_SCHEMA =
  'qinglong/run-cancellation-dispatch-rearm-request@v1';
export const RUN_CANCELLATION_DISPATCH_REARM_RECEIPT_SCHEMA =
  'qinglong/run-cancellation-dispatch-rearm-receipt@v1';

export type ClusterRunManagementRetryCommand = Readonly<{
  schemaVersion: 1;
  operation: 'run.retry';
  request: Readonly<{
    projectId: string;
    sourceRunId: string;
    requestId: string;
    auditEventId: string;
    failureAuditEventId: string;
    body: Readonly<{
      schema: 'qinglong/run-manual-retry@v1';
      mutationId: string;
      expectedRunVersion: number;
      expectedRunStatus: 'failed' | 'cancelled' | 'timed_out';
    }>;
  }>;
}>;

export type ClusterRunManagementStopCommand = Readonly<{
  schemaVersion: 1;
  operation: 'run.stop';
  request: Readonly<{
    projectId: string;
    runId: string;
    requestId: string;
    auditEventId: string;
    failureAuditEventId: string;
    body: Readonly<{
      schema: 'qinglong/run-cancellation@v1';
      mutationId: string;
    }>;
  }>;
}>;

export type ClusterRunManagementCancellationInspectCommand = Readonly<{
  schemaVersion: 1;
  operation: 'run.cancellation.inspect';
  request: Readonly<{
    projectId: string;
    runId: string;
    requestId: string;
    auditEventId: string;
    failureAuditEventId: string;
    body: Readonly<{
      schema: typeof RUN_CANCELLATION_DISPATCH_INSPECT_REQUEST_SCHEMA;
    }>;
  }>;
}>;

export type ClusterRunManagementCancellationSummaryCommand = Readonly<{
  schemaVersion: 1;
  operation: 'run.cancellation.summary';
  request: Readonly<{
    projectId: string;
    requestId: string;
    auditEventId: string;
    failureAuditEventId: string;
    body: Readonly<{
      schema: typeof RUN_CANCELLATION_DISPATCH_SUMMARY_REQUEST_SCHEMA;
    }>;
  }>;
}>;

export type ClusterRunManagementCancellationRearmCommand = Readonly<{
  schemaVersion: 1;
  operation: 'run.cancellation.rearm';
  request: Readonly<{
    projectId: string;
    runId: string;
    requestId: string;
    auditEventId: string;
    failureAuditEventId: string;
    body: Readonly<{
      schema: typeof RUN_CANCELLATION_DISPATCH_REARM_REQUEST_SCHEMA;
      mutationId: string;
      expectedDispatchVersion: number;
      expectedLastResult:
        | 'identity_mismatch'
        | 'pid_mismatch'
        | 'unsupported'
        | 'invalid';
      retryDelayMs: number;
    }>;
  }>;
}>;

export type ClusterRunManagementCommand =
  | ClusterRunManagementRetryCommand
  | ClusterRunManagementStopCommand
  | ClusterRunManagementCancellationSummaryCommand
  | ClusterRunManagementCancellationInspectCommand
  | ClusterRunManagementCancellationRearmCommand;

export type ClusterRunManagementRetryTransportResult = Readonly<{
  schemaVersion: 1;
  operation: 'run.retry';
  retry: Readonly<RunManualRetryResponseBody>;
}>;

export type ClusterRunManagementStopTransportResult = Readonly<{
  schemaVersion: 1;
  operation: 'run.stop';
  stop: Readonly<RunCancellationResponseBody>;
}>;

export type ClusterRunManagementCancellationInspectTransportResult = Readonly<{
  schemaVersion: 1;
  operation: 'run.cancellation.inspect';
  diagnostic: Readonly<
    Awaited<ReturnType<ClusterRunManagementService['inspectCancellation']>> & {
      schema: typeof RUN_CANCELLATION_DISPATCH_DIAGNOSTIC_SCHEMA;
    }
  >;
}>;

export type ClusterRunManagementCancellationSummaryTransportResult = Readonly<{
  schemaVersion: 1;
  operation: 'run.cancellation.summary';
  summary: Readonly<
    Awaited<ReturnType<ClusterRunManagementService['summarizeCancellation']>> & {
      schema: typeof RUN_CANCELLATION_DISPATCH_SUMMARY_SCHEMA;
    }
  >;
}>;

export type ClusterRunManagementCancellationRearmTransportResult = Readonly<{
  schemaVersion: 1;
  operation: 'run.cancellation.rearm';
  rearm: Readonly<
    Awaited<ReturnType<ClusterRunManagementService['rearmCancellation']>> & {
      schema: typeof RUN_CANCELLATION_DISPATCH_REARM_RECEIPT_SCHEMA;
    }
  >;
}>;

export type ClusterRunManagementTransportResult =
  | ClusterRunManagementRetryTransportResult
  | ClusterRunManagementStopTransportResult
  | ClusterRunManagementCancellationSummaryTransportResult
  | ClusterRunManagementCancellationInspectTransportResult
  | ClusterRunManagementCancellationRearmTransportResult;

export interface ClusterRunManagementAuthentication {
  authenticate(): Promise<Readonly<SecurityPrincipal> | null>;
}

export interface ClusterRunManagementTransport {
  execute(
    command: unknown,
    authentication: ClusterRunManagementAuthentication,
  ): Promise<Readonly<ClusterRunManagementTransportResult>>;
}

export class ClusterRunManagementTransportConfigurationError extends TypeError {
  readonly code = 'CLUSTER_RUN_MANAGEMENT_TRANSPORT_CONFIGURATION_INVALID';
  constructor() {
    super('Cluster Run management transport configuration is invalid');
    this.name = 'ClusterRunManagementTransportConfigurationError';
  }
}

export class ClusterRunManagementTransportRequestError extends TypeError {
  readonly code = 'CLUSTER_RUN_MANAGEMENT_TRANSPORT_REQUEST_INVALID';
  constructor() {
    super('Cluster Run management transport request is invalid');
    this.name = 'ClusterRunManagementTransportRequestError';
  }
}

export class ClusterRunManagementTransportAuthenticationError extends Error {
  readonly code = 'CLUSTER_RUN_MANAGEMENT_TRANSPORT_AUTHENTICATION_REQUIRED';
  constructor() {
    super('Cluster Run management transport requires a strong User principal');
    this.name = 'ClusterRunManagementTransportAuthenticationError';
  }
}

export class ClusterRunManagementTransportUnavailableError extends Error {
  readonly code = 'CLUSTER_RUN_MANAGEMENT_TRANSPORT_UNAVAILABLE';
  constructor() {
    super('Cluster Run management transport is unavailable');
    this.name = 'ClusterRunManagementTransportUnavailableError';
  }
}

function invalid(): never {
  throw new ClusterRunManagementTransportRequestError();
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

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) invalid();
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid();
  return value;
}

export function normalizeClusterRunManagementCommand(
  value: unknown,
): Readonly<ClusterRunManagementCommand> {
  const envelope = exact(value, ['schemaVersion', 'operation', 'request']);
  if (envelope.schemaVersion !== 1) invalid();
  const operation = envelope.operation;
  if (
    operation !== 'run.retry' &&
    operation !== 'run.stop' &&
    operation !== 'run.cancellation.summary' &&
    operation !== 'run.cancellation.inspect' &&
    operation !== 'run.cancellation.rearm'
  ) {
    invalid();
  }
  const request = exact(
    envelope.request,
    operation === 'run.retry'
      ? [
          'projectId',
          'sourceRunId',
          'requestId',
          'auditEventId',
          'failureAuditEventId',
          'body',
        ]
      : operation === 'run.cancellation.summary'
        ? [
            'projectId',
            'requestId',
            'auditEventId',
            'failureAuditEventId',
            'body',
          ]
        : [
          'projectId',
          'runId',
          'requestId',
          'auditEventId',
          'failureAuditEventId',
          'body',
        ],
  );
  const auditEventId = uuid(request.auditEventId);
  const failureAuditEventId = uuid(request.failureAuditEventId);
  if (auditEventId === failureAuditEventId) invalid();
  if (operation === 'run.retry') {
    let body: ReturnType<typeof parseRunManualRetryRequestBody>;
    try {
      body = parseRunManualRetryRequestBody(request.body);
    } catch {
      invalid();
    }
    return Object.freeze({
      schemaVersion: 1,
      operation,
      request: Object.freeze({
        projectId: identifier(request.projectId),
        sourceRunId: identifier(request.sourceRunId),
        requestId: identifier(request.requestId),
        auditEventId,
        failureAuditEventId,
        body,
      }),
    });
  }
  if (operation === 'run.cancellation.summary') {
    const body = exact(request.body, ['schema']);
    if (body.schema !== RUN_CANCELLATION_DISPATCH_SUMMARY_REQUEST_SCHEMA) {
      invalid();
    }
    return Object.freeze({
      schemaVersion: 1,
      operation,
      request: Object.freeze({
        projectId: identifier(request.projectId),
        requestId: identifier(request.requestId),
        auditEventId,
        failureAuditEventId,
        body: Object.freeze({
          schema: RUN_CANCELLATION_DISPATCH_SUMMARY_REQUEST_SCHEMA,
        }),
      }),
    });
  }
  if (operation === 'run.cancellation.inspect') {
    const body = exact(request.body, ['schema']);
    if (body.schema !== RUN_CANCELLATION_DISPATCH_INSPECT_REQUEST_SCHEMA) {
      invalid();
    }
    return Object.freeze({
      schemaVersion: 1,
      operation,
      request: Object.freeze({
        projectId: identifier(request.projectId),
        runId: identifier(request.runId),
        requestId: identifier(request.requestId),
        auditEventId,
        failureAuditEventId,
        body: Object.freeze({
          schema: RUN_CANCELLATION_DISPATCH_INSPECT_REQUEST_SCHEMA,
        }),
      }),
    });
  }
  if (operation === 'run.cancellation.rearm') {
    const body = exact(request.body, [
      'schema',
      'mutationId',
      'expectedDispatchVersion',
      'expectedLastResult',
      'retryDelayMs',
    ]);
    if (
      body.schema !== RUN_CANCELLATION_DISPATCH_REARM_REQUEST_SCHEMA ||
      !CANCELLATION_DISPATCH_BLOCKING_RESULTS.includes(
        body.expectedLastResult as never,
      ) ||
      typeof body.expectedDispatchVersion !== 'number' ||
      !Number.isSafeInteger(body.expectedDispatchVersion) ||
      body.expectedDispatchVersion < 1 ||
      body.expectedDispatchVersion >= 2_147_483_647 ||
      typeof body.retryDelayMs !== 'number' ||
      !Number.isSafeInteger(body.retryDelayMs) ||
      body.retryDelayMs < 1_000 ||
      body.retryDelayMs > 24 * 60 * 60_000
    ) {
      invalid();
    }
    return Object.freeze({
      schemaVersion: 1,
      operation,
      request: Object.freeze({
        projectId: identifier(request.projectId),
        runId: identifier(request.runId),
        requestId: identifier(request.requestId),
        auditEventId,
        failureAuditEventId,
        body: Object.freeze({
          schema: RUN_CANCELLATION_DISPATCH_REARM_REQUEST_SCHEMA,
          mutationId: uuid(body.mutationId),
          expectedDispatchVersion: body.expectedDispatchVersion,
          expectedLastResult: body.expectedLastResult as
            ClusterRunManagementCancellationRearmCommand['request']['body']['expectedLastResult'],
          retryDelayMs: body.retryDelayMs,
        }),
      }),
    });
  }
  let body: ReturnType<typeof parseRunCancellationRequestBody>;
  try {
    body = parseRunCancellationRequestBody(request.body);
  } catch {
    invalid();
  }
  uuid(body.mutationId);
  return Object.freeze({
    schemaVersion: 1,
    operation,
    request: Object.freeze({
      projectId: identifier(request.projectId),
      runId: identifier(request.runId),
      requestId: identifier(request.requestId),
      auditEventId,
      failureAuditEventId,
      body,
    }),
  });
}

export function createClusterRunManagementTransport(
  options: Readonly<{
    service: ClusterRunManagementService;
    now?: () => number;
  }>,
): Readonly<ClusterRunManagementTransport> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'service' && key !== 'now') ||
    !options.service ||
    typeof options.service.retry !== 'function' ||
    typeof options.service.stop !== 'function' ||
    typeof options.service.summarizeCancellation !== 'function' ||
    typeof options.service.inspectCancellation !== 'function' ||
    typeof options.service.rearmCancellation !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new ClusterRunManagementTransportConfigurationError();
  }
  const now = options.now ?? Date.now;
  return Object.freeze({
    async execute(
      commandValue: unknown,
      authentication: ClusterRunManagementAuthentication,
    ) {
      const command = normalizeClusterRunManagementCommand(commandValue);
      if (
        !authentication ||
        typeof authentication !== 'object' ||
        Array.isArray(authentication) ||
        Object.keys(authentication).length !== 1 ||
        typeof authentication.authenticate !== 'function'
      ) {
        throw new ClusterRunManagementTransportConfigurationError();
      }
      let candidate: Readonly<SecurityPrincipal> | null;
      try {
        candidate = await authentication.authenticate();
      } catch {
        throw new ClusterRunManagementTransportUnavailableError();
      }
      let principal: Readonly<SecurityPrincipal>;
      try {
        principal = normalizeSecurityPrincipal(
          candidate as SecurityPrincipal,
          now(),
        );
      } catch {
        throw new ClusterRunManagementTransportAuthenticationError();
      }
      if (
        principal.subject.type !== 'user' ||
        !STRONG_ASSURANCES.has(principal.assurance)
      ) {
        throw new ClusterRunManagementTransportAuthenticationError();
      }
      if (command.operation === 'run.retry') {
        const result = await options.service.retry({
          projectId: command.request.projectId,
          sourceRunId: command.request.sourceRunId,
          mutationId: command.request.body.mutationId,
          expectedRunVersion: command.request.body.expectedRunVersion,
          expectedRunStatus: command.request.body.expectedRunStatus,
          requestId: command.request.requestId,
          auditEventId: command.request.auditEventId,
          failureAuditEventId: command.request.failureAuditEventId,
          principal,
        });
        return Object.freeze({
          schemaVersion: 1,
          operation: command.operation,
          retry: createRunManualRetryResponseBody(result),
        });
      }
      if (command.operation === 'run.cancellation.summary') {
        const result = await options.service.summarizeCancellation({
          projectId: command.request.projectId,
          requestId: command.request.requestId,
          auditEventId: command.request.auditEventId,
          failureAuditEventId: command.request.failureAuditEventId,
          principal,
        });
        return Object.freeze({
          schemaVersion: 1,
          operation: command.operation,
          summary: Object.freeze({
            schema: RUN_CANCELLATION_DISPATCH_SUMMARY_SCHEMA,
            ...result,
          }),
        });
      }
      if (command.operation === 'run.cancellation.inspect') {
        const result = await options.service.inspectCancellation({
          projectId: command.request.projectId,
          runId: command.request.runId,
          requestId: command.request.requestId,
          auditEventId: command.request.auditEventId,
          failureAuditEventId: command.request.failureAuditEventId,
          principal,
        });
        return Object.freeze({
          schemaVersion: 1,
          operation: command.operation,
          diagnostic: Object.freeze({
            schema: RUN_CANCELLATION_DISPATCH_DIAGNOSTIC_SCHEMA,
            ...result,
          }),
        });
      }
      if (command.operation === 'run.cancellation.rearm') {
        const result = await options.service.rearmCancellation({
          projectId: command.request.projectId,
          runId: command.request.runId,
          requestId: command.request.requestId,
          auditEventId: command.request.auditEventId,
          failureAuditEventId: command.request.failureAuditEventId,
          principal,
          mutationId: command.request.body.mutationId,
          expectedDispatchVersion:
            command.request.body.expectedDispatchVersion,
          expectedLastResult: command.request.body.expectedLastResult,
          retryDelayMs: command.request.body.retryDelayMs,
        });
        return Object.freeze({
          schemaVersion: 1,
          operation: command.operation,
          rearm: Object.freeze({
            schema: RUN_CANCELLATION_DISPATCH_REARM_RECEIPT_SCHEMA,
            ...result,
          }),
        });
      }
      const result = await options.service.stop({
        projectId: command.request.projectId,
        runId: command.request.runId,
        mutationId: command.request.body.mutationId,
        requestId: command.request.requestId,
        auditEventId: command.request.auditEventId,
        failureAuditEventId: command.request.failureAuditEventId,
        principal,
      });
      return Object.freeze({
        schemaVersion: 1,
        operation: command.operation,
        stop: createRunCancellationResponseBody(result),
      });
    },
  });
}
