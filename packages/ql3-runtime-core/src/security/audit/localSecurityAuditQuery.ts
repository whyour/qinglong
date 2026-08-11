import type { SecurityPolicyFence, SecuritySubject } from '../security';
import type { SecurityAuditRecord, SecurityAuditSink } from './securityAudit';
import type {
  SecurityAuditQuery,
  SecurityAuditQueryPage,
} from './securityAuditQuery';

export const MAX_LOCAL_SECURITY_AUDIT_QUERY_PAGE_SIZE = 64;

export interface LocalSecurityAuditQueryAuthorization {
  readonly authorityProjectId: string;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
}

export interface ListAuthorizedLocalSecurityAuditCommand {
  readonly query: SecurityAuditQuery;
  readonly authorization: LocalSecurityAuditQueryAuthorization;
  readonly audit: SecurityAuditRecord;
}

export interface ListAuthorizedLocalSecurityAuditResult
  extends SecurityAuditQueryPage {
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface LocalSecurityAuditQueryRepository extends SecurityAuditSink {
  listAuthorized(
    command: ListAuthorizedLocalSecurityAuditCommand,
  ): Promise<ListAuthorizedLocalSecurityAuditResult>;
}

export class LocalSecurityAuditQueryAuthorizationFenceConflictError extends Error {
  readonly code = 'LOCAL_SECURITY_AUDIT_QUERY_AUTHORIZATION_FENCE_CONFLICT';

  constructor() {
    super('Local security audit query authorization fence changed');
    this.name = 'LocalSecurityAuditQueryAuthorizationFenceConflictError';
  }
}

export class LocalSecurityAuditQueryUnavailableError extends Error {
  readonly code = 'LOCAL_SECURITY_AUDIT_QUERY_UNAVAILABLE';

  constructor() {
    super('Local security audit query is unavailable');
    this.name = 'LocalSecurityAuditQueryUnavailableError';
  }
}
