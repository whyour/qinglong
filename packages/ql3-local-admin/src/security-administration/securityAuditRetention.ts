import {
  LocalSecurityAuditCompactionMutationConflictError,
  LocalSecurityAuditRetentionAuthorizationFenceConflictError,
  LocalSecurityAuditRetentionUnavailableError,
  MAX_LOCAL_SECURITY_AUDIT_RETENTION_MS,
  MAX_STANDALONE_SECURITY_AUDIT_COMPACTION_BATCH_SIZE,
  MIN_LOCAL_SECURITY_AUDIT_RETENTION_MS,
  type CompactAuthorizedLocalSecurityAuditResult,
  type LocalSecurityAuditRetentionRepository,
} from '@qinglong/runtime-core/local-security-audit-retention';
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

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STRONG_USER_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);

export interface CompactLocalSecurityAuditRequest {
  readonly authorityProjectId: string;
  readonly retentionMs: number;
  readonly eligibleBeforeMs: number;
  readonly limit: number;
  readonly mutationId: string;
  readonly requestId: string;
  readonly failureAuditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface LocalSecurityAuditRetentionService {
  compact(
    request: CompactLocalSecurityAuditRequest,
  ): Promise<CompactAuthorizedLocalSecurityAuditResult>;
}

export class LocalSecurityAuditRetentionConfigurationError extends TypeError {
  readonly code = 'LOCAL_SECURITY_AUDIT_RETENTION_INVALID';

  constructor(message: string) {
    super(`Local security audit retention is invalid: ${message}`);
    this.name = 'LocalSecurityAuditRetentionConfigurationError';
  }
}

export class LocalSecurityAuditRetentionAuthenticationError extends Error {
  readonly code = 'LOCAL_SECURITY_AUDIT_RETENTION_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Local security audit retention requires a strong User');
    this.name = 'LocalSecurityAuditRetentionAuthenticationError';
  }
}

export class LocalSecurityAuditRetentionAuthorizationError extends Error {
  readonly code = 'LOCAL_SECURITY_AUDIT_RETENTION_FORBIDDEN';

  constructor() {
    super('Local security audit retention is not authorized');
    this.name = 'LocalSecurityAuditRetentionAuthorizationError';
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
    throw new LocalSecurityAuditRetentionConfigurationError(
      `${label} shape is invalid`,
    );
  }
}

function request(
  value: CompactLocalSecurityAuditRequest,
  nowMs: number,
): Readonly<CompactLocalSecurityAuditRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalSecurityAuditRetentionConfigurationError(
      'request must be an object',
    );
  }
  exactKeys(
    value,
    [
      'authorityProjectId',
      'retentionMs',
      'eligibleBeforeMs',
      'limit',
      'mutationId',
      'requestId',
      'failureAuditEventId',
      'principal',
    ],
    'request',
  );
  try {
    assertProjectPolicyProjectId(value.authorityProjectId);
  } catch {
    throw new LocalSecurityAuditRetentionConfigurationError(
      'authority Project identity is invalid',
    );
  }
  if (
    !UUID_V4_PATTERN.test(value.mutationId) ||
    !UUID_V4_PATTERN.test(value.failureAuditEventId) ||
    value.mutationId === value.failureAuditEventId ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    !Number.isSafeInteger(value.retentionMs) ||
    value.retentionMs < MIN_LOCAL_SECURITY_AUDIT_RETENTION_MS ||
    value.retentionMs > MAX_LOCAL_SECURITY_AUDIT_RETENTION_MS ||
    !Number.isSafeInteger(value.eligibleBeforeMs) ||
    value.eligibleBeforeMs < 0 ||
    value.eligibleBeforeMs + value.retentionMs > nowMs ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > MAX_STANDALONE_SECURITY_AUDIT_COMPACTION_BATCH_SIZE
  ) {
    throw new LocalSecurityAuditRetentionConfigurationError(
      'identity, retention fence, or limit is invalid',
    );
  }
  return Object.freeze({ ...value });
}

function strongUser(
  value: SecurityPrincipal,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(value, nowMs);
  } catch {
    throw new LocalSecurityAuditRetentionAuthenticationError();
  }
  if (
    principal.subject.type !== 'user' ||
    !STRONG_USER_ASSURANCES.has(principal.assurance)
  ) {
    throw new LocalSecurityAuditRetentionAuthenticationError();
  }
  return principal;
}

function auditRecord(options: {
  readonly eventId: string;
  readonly request: Readonly<CompactLocalSecurityAuditRequest>;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly outcome: SecurityAuditRecord['outcome'];
  readonly reasons: readonly string[];
  readonly fence: SecurityAuditRecord['fence'];
  readonly occurredAtMs: number;
}): Readonly<SecurityAuditRecord> {
  return normalizeSecurityAuditRecord({
    eventId: options.eventId,
    requestId: options.request.requestId,
    operationId: 'security.audit.compact',
    projectId: options.request.authorityProjectId,
    subject: options.principal.subject,
    authenticationId: options.principal.authenticationId,
    outcome: options.outcome,
    reasons: options.reasons,
    fence: options.fence,
    occurredAtMs: options.occurredAtMs,
  });
}

export function createLocalSecurityAuditRetentionService(
  projectPolicy: ProjectPolicyRepository,
  repository: LocalSecurityAuditRetentionRepository,
  options: { readonly now?: () => number } = {},
): LocalSecurityAuditRetentionService {
  if (
    !projectPolicy ||
    typeof projectPolicy.resolve !== 'function' ||
    !repository ||
    typeof repository.resolveCompaction !== 'function' ||
    typeof repository.compactAuthorized !== 'function' ||
    typeof repository.record !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new LocalSecurityAuditRetentionConfigurationError(
      'dependencies are invalid',
    );
  }
  const now = options.now ?? Date.now;
  const policy = new ProjectPolicyEngine(projectPolicy);
  return Object.freeze({
    async compact(input: CompactLocalSecurityAuditRequest) {
      const occurredAtMs = now();
      if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
        throw new LocalSecurityAuditRetentionConfigurationError(
          'trusted clock is invalid',
        );
      }
      const command = request(input, occurredAtMs);
      const principal = strongUser(command.principal, occurredAtMs);
      let decision;
      try {
        decision = await policy.authorize(
          principal,
          command.authorityProjectId,
          'project.manage',
        );
      } catch {
        try {
          await repository.record(
            auditRecord({
              eventId: command.failureAuditEventId,
              request: command,
              principal,
              outcome: 'authorization_unavailable',
              reasons: ['policy_unavailable'],
              fence: null,
              occurredAtMs,
            }),
          );
        } catch {
          throw new LocalSecurityAuditRetentionUnavailableError();
        }
        throw new LocalSecurityAuditRetentionUnavailableError();
      }
      if (decision.effect !== 'allow' || !decision.fence?.bindingVersion) {
        try {
          await repository.record(
            auditRecord({
              eventId: command.failureAuditEventId,
              request: command,
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
          throw new LocalSecurityAuditRetentionUnavailableError();
        }
        throw new LocalSecurityAuditRetentionAuthorizationError();
      }
      try {
        return await repository.compactAuthorized({
          mutationId: command.mutationId,
          requestId: command.requestId,
          retentionMs: command.retentionMs,
          eligibleBeforeMs: command.eligibleBeforeMs,
          limit: command.limit,
          authorization: {
            authorityProjectId: command.authorityProjectId,
            actor: principal.subject,
            fence: decision.fence,
          },
          audit: auditRecord({
            eventId: command.mutationId,
            request: command,
            principal,
            outcome: 'allowed',
            reasons: ['instance_authority_security_audit_compaction'],
            fence: decision.fence,
            occurredAtMs,
          }),
        });
      } catch (error) {
        if (
          error instanceof
            LocalSecurityAuditRetentionAuthorizationFenceConflictError ||
          error instanceof LocalSecurityAuditCompactionMutationConflictError
        ) {
          throw error;
        }
        throw new LocalSecurityAuditRetentionUnavailableError();
      }
    },
  });
}
