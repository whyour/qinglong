import {
  createRunManualRetryResponseBody,
  parseRunManualRetryRequestBody,
  type RunManualRetryResponseBody,
} from '@qinglong/runtime-core/run-manual-retry';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import type { ClusterRunManagementService } from './runManagement';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STRONG_ASSURANCES = new Set(['multi_factor', 'hardware']);

export type ClusterRunManagementCommand = Readonly<{
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

export type ClusterRunManagementTransportResult = Readonly<{
  schemaVersion: 1;
  operation: 'run.retry';
  retry: Readonly<RunManualRetryResponseBody>;
}>;

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

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
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
  if (envelope.schemaVersion !== 1 || envelope.operation !== 'run.retry') invalid();
  const request = exact(envelope.request, [
    'projectId',
    'sourceRunId',
    'requestId',
    'auditEventId',
    'failureAuditEventId',
    'body',
  ]);
  let body: ReturnType<typeof parseRunManualRetryRequestBody>;
  try {
    body = parseRunManualRetryRequestBody(request.body);
  } catch {
    invalid();
  }
  const auditEventId = uuid(request.auditEventId);
  const failureAuditEventId = uuid(request.failureAuditEventId);
  if (auditEventId === failureAuditEventId) invalid();
  return Object.freeze({
    schemaVersion: 1,
    operation: 'run.retry',
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

export function createClusterRunManagementTransport(options: Readonly<{
  service: ClusterRunManagementService;
  now?: () => number;
}>): Readonly<ClusterRunManagementTransport> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'service' && key !== 'now') ||
    !options.service ||
    typeof options.service.retry !== 'function' ||
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
        principal = normalizeSecurityPrincipal(candidate as SecurityPrincipal, now());
      } catch {
        throw new ClusterRunManagementTransportAuthenticationError();
      }
      if (
        principal.subject.type !== 'user' ||
        !STRONG_ASSURANCES.has(principal.assurance)
      ) {
        throw new ClusterRunManagementTransportAuthenticationError();
      }
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
        operation: 'run.retry',
        retry: createRunManualRetryResponseBody(result),
      });
    },
  });
}
