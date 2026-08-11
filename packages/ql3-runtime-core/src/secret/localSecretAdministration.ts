import type {
  AppendLocalSecretEnvelopeResult,
  LocalSecretEnvelope,
} from './localSecret';
import type { SecurityPolicyFence, SecuritySubject } from '../security/security';
import type {
  SecurityAuditRecord,
  SecurityAuditSink,
} from '../security/audit/securityAudit';

export interface LocalSecretAdministrationMutation {
  readonly envelope: LocalSecretEnvelope;
  readonly audit: SecurityAuditRecord;
}

export interface AppendAuthorizedLocalSecretEnvelopeCommand {
  readonly expectedCurrentVersion: number;
  readonly envelope: LocalSecretEnvelope;
  readonly subject: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface AppendAuthorizedLocalSecretEnvelopeResult
  extends AppendLocalSecretEnvelopeResult {
  readonly audit: Readonly<SecurityAuditRecord>;
}

/**
 * Short-lived management authority. Implementations must revalidate the
 * Project/RoleBinding fence and append the envelope plus audit atomically.
 */
export interface LocalSecretAdministrationRepository
  extends SecurityAuditSink {
  resolveLocalSecretAdministrationMutation(
    projectId: string,
    name: string,
    mutationId: string,
  ): Promise<Readonly<LocalSecretAdministrationMutation> | null>;
  appendAuthorizedLocalSecretEnvelope(
    command: AppendAuthorizedLocalSecretEnvelopeCommand,
  ): Promise<AppendAuthorizedLocalSecretEnvelopeResult>;
}

export class LocalSecretAuthorizationFenceConflictError extends Error {
  readonly code = 'LOCAL_SECRET_AUTHORIZATION_FENCE_CONFLICT';

  constructor() {
    super('Local Secret authorization changed');
    this.name = 'LocalSecretAuthorizationFenceConflictError';
  }
}
