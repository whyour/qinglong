import {
  LocalSecurityAuditQueryAuthorizationFenceConflictError,
  LocalSecurityAuditQueryUnavailableError,
  MAX_LOCAL_SECURITY_AUDIT_QUERY_PAGE_SIZE,
  type ListAuthorizedLocalSecurityAuditResult,
  type LocalSecurityAuditQueryRepository,
} from '@qinglong/runtime-core/local-security-audit-query';
import {
  ProjectPolicyEngine,
  assertProjectPolicyProjectId,
  type ProjectPolicyRepository,
} from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';
import {
  normalizeSecurityAuditQuery,
  type SecurityAuditQuery,
} from '@qinglong/runtime-core/security-audit-query';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STRONG_USER_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);

export interface ListLocalSecurityAuditRequest {
  readonly authorityProjectId: string;
  readonly query: SecurityAuditQuery;
  readonly auditEventId: string;
  readonly requestId: string;
  readonly principal: SecurityPrincipal;
}

export interface LocalSecurityAuditQueryService {
  list(
    request: ListLocalSecurityAuditRequest,
  ): Promise<ListAuthorizedLocalSecurityAuditResult>;
}

export class LocalSecurityAuditQueryConfigurationError extends TypeError {
  readonly code = 'LOCAL_SECURITY_AUDIT_QUERY_INVALID';

  constructor(message: string) {
    super(`Local security audit query is invalid: ${message}`);
    this.name = 'LocalSecurityAuditQueryConfigurationError';
  }
}

export class LocalSecurityAuditQueryAuthenticationError extends Error {
  readonly code = 'LOCAL_SECURITY_AUDIT_QUERY_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Local security audit query requires a strong User');
    this.name = 'LocalSecurityAuditQueryAuthenticationError';
  }
}

export class LocalSecurityAuditQueryAuthorizationError extends Error {
  readonly code = 'LOCAL_SECURITY_AUDIT_QUERY_FORBIDDEN';

  constructor() {
    super('Local security audit query is not authorized');
    this.name = 'LocalSecurityAuditQueryAuthorizationError';
  }
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new LocalSecurityAuditQueryConfigurationError(
      `${label} shape is invalid`,
    );
  }
}

function normalizeRequest(
  value: ListLocalSecurityAuditRequest,
): Readonly<ListLocalSecurityAuditRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalSecurityAuditQueryConfigurationError(
      'request must be an object',
    );
  }
  exactKeys(
    value,
    ['authorityProjectId', 'query', 'auditEventId', 'requestId', 'principal'],
    'request',
  );
  try {
    assertProjectPolicyProjectId(value.authorityProjectId);
  } catch {
    throw new LocalSecurityAuditQueryConfigurationError(
      'authority Project identity is invalid',
    );
  }
  if (
    typeof value.auditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(value.auditEventId) ||
    typeof value.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(value.requestId)
  ) {
    throw new LocalSecurityAuditQueryConfigurationError(
      'audit or request identity is invalid',
    );
  }
  let query: Readonly<SecurityAuditQuery>;
  try {
    query = normalizeSecurityAuditQuery(value.query);
  } catch {
    throw new LocalSecurityAuditQueryConfigurationError(
      'filter, cursor, or limit is invalid',
    );
  }
  if (query.limit > MAX_LOCAL_SECURITY_AUDIT_QUERY_PAGE_SIZE) {
    throw new LocalSecurityAuditQueryConfigurationError(
      'limit exceeds the local maximum of 64',
    );
  }
  return Object.freeze({ ...value, query });
}

function strongUser(
  value: SecurityPrincipal,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(value, nowMs);
  } catch {
    throw new LocalSecurityAuditQueryAuthenticationError();
  }
  if (
    principal.subject.type !== 'user' ||
    !STRONG_USER_ASSURANCES.has(principal.assurance)
  ) {
    throw new LocalSecurityAuditQueryAuthenticationError();
  }
  return principal;
}

function auditRecord(options: {
  readonly request: Readonly<ListLocalSecurityAuditRequest>;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly outcome: SecurityAuditRecord['outcome'];
  readonly reasons: readonly string[];
  readonly fence: SecurityAuditRecord['fence'];
  readonly occurredAtMs: number;
}): Readonly<SecurityAuditRecord> {
  return normalizeSecurityAuditRecord({
    eventId: options.request.auditEventId,
    requestId: options.request.requestId,
    operationId: 'security.audit.list',
    projectId: options.request.authorityProjectId,
    subject: options.principal.subject,
    authenticationId: options.principal.authenticationId,
    outcome: options.outcome,
    reasons: options.reasons,
    fence: options.fence,
    occurredAtMs: options.occurredAtMs,
  });
}

export function createLocalSecurityAuditQueryService(
  projectPolicy: ProjectPolicyRepository,
  repository: LocalSecurityAuditQueryRepository,
  options: { readonly now?: () => number } = {},
): LocalSecurityAuditQueryService {
  if (
    !projectPolicy ||
    typeof projectPolicy.resolve !== 'function' ||
    !repository ||
    typeof repository.listAuthorized !== 'function' ||
    typeof repository.record !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new LocalSecurityAuditQueryConfigurationError(
      'dependencies are invalid',
    );
  }
  const now = options.now ?? Date.now;
  const policy = new ProjectPolicyEngine(projectPolicy);
  return Object.freeze({
    async list(input: ListLocalSecurityAuditRequest) {
      const request = normalizeRequest(input);
      const occurredAtMs = now();
      const principal = strongUser(request.principal, occurredAtMs);
      let decision;
      try {
        decision = await policy.authorize(
          principal,
          request.authorityProjectId,
          'project.manage',
        );
      } catch {
        try {
          await repository.record(
            auditRecord({
              request,
              principal,
              outcome: 'authorization_unavailable',
              reasons: ['policy_unavailable'],
              fence: null,
              occurredAtMs,
            }),
          );
        } catch {
          throw new LocalSecurityAuditQueryUnavailableError();
        }
        throw new LocalSecurityAuditQueryUnavailableError();
      }
      if (decision.effect !== 'allow' || !decision.fence?.bindingVersion) {
        try {
          await repository.record(
            auditRecord({
              request,
              principal,
              outcome:
                decision.effect === 'require_approval'
                  ? 'approval_required'
                  : 'denied',
              reasons: decision.reasons,
              fence: decision.fence,
              occurredAtMs,
            }),
          );
        } catch {
          throw new LocalSecurityAuditQueryUnavailableError();
        }
        throw new LocalSecurityAuditQueryAuthorizationError();
      }
      try {
        return await repository.listAuthorized({
          query: request.query,
          authorization: {
            authorityProjectId: request.authorityProjectId,
            actor: principal.subject,
            fence: decision.fence,
          },
          audit: auditRecord({
            request,
            principal,
            outcome: 'allowed',
            reasons: ['instance_authority_security_audit_query'],
            fence: decision.fence,
            occurredAtMs,
          }),
        });
      } catch (error) {
        if (
          error instanceof
          LocalSecurityAuditQueryAuthorizationFenceConflictError
        ) {
          throw error;
        }
        throw new LocalSecurityAuditQueryUnavailableError();
      }
    },
  });
}
