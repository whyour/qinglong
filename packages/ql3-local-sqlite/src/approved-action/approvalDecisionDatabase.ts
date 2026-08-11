import type { ApiCredentialRepository } from '@qinglong/runtime-core/api-credential';
import type { ApprovalRequestRepository } from '@qinglong/runtime-core/approved-action';
import type { ApprovalRequestDetailSource } from '@qinglong/runtime-core/approval-discovery';
import type { LocalOwnerPepperRepository } from '@qinglong/runtime-core/local-owner-pepper';
import type { ProjectPolicyRepository } from '@qinglong/runtime-core/project-policy';
import type { SecurityAuditSink } from '@qinglong/runtime-core/security-audit';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteOwnerPepperRepository } from '../local-owner/ownerPepperRepository';
import {
  confirmLocalSqliteAuthenticatedUserCredentialFence,
  LocalSqliteAuthenticatedManagementFenceError,
  type LocalSqliteAuthenticatedUserCredentialFence,
} from '../administration/packageManagement';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../readiness/readiness';
import { LocalSqliteApiCredentialRepository } from '../security/apiCredentialRepository';
import { LocalSqliteProjectPolicyRepository } from '../security/projectPolicyRepository';
import { LocalSqliteSecurityAuthorityStore } from '../security/securityAuthorityStore';
import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '../storage/config';
import { LocalSqliteApprovalRequestRepository } from './approvalRequestRepository';
import { LocalSqliteApprovalRequestSource } from './approvalRequestSource';

export interface LocalSqliteApprovalDecisionDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly apiCredentials: ApiCredentialRepository;
  readonly ownerPepper: Pick<LocalOwnerPepperRepository, 'resolveKey'>;
  readonly projectPolicy: ProjectPolicyRepository;
  readonly approvals: Pick<ApprovalRequestRepository, 'findById' | 'decide'>;
  readonly approvalDetails: ApprovalRequestDetailSource;
  readonly securityAudit: SecurityAuditSink;
  activateUserCredentialFence(
    fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  ): void;
  confirmUserCredentialFence(): void;
  close(): Promise<void>;
}

function sameCredentialFence(
  left: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  right: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
): boolean {
  return (
    left.credentialId === right.credentialId &&
    left.credentialVersion === right.credentialVersion &&
    left.pepperKeyId === right.pepperKeyId &&
    left.materialDigest === right.materialDigest &&
    left.subjectType === right.subjectType &&
    left.subjectId === right.subjectId &&
    left.secretDigest === right.secretDigest &&
    left.notBeforeAtMs === right.notBeforeAtMs &&
    left.expiresAtMs === right.expiresAtMs
  );
}

/** Short-lived Owner authority; it never migrates schema or starts workers. */
export async function openLocalSqliteApprovalDecisionDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteApprovalDecisionDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    let activeFence:
      | Readonly<LocalSqliteAuthenticatedUserCredentialFence>
      | undefined;
    const confirmActiveFence = () => {
      if (!activeFence) {
        throw new LocalSqliteAuthenticatedManagementFenceError();
      }
      confirmLocalSqliteAuthenticatedUserCredentialFence(authority, activeFence);
    };
    const securityAuthority = new LocalSqliteSecurityAuthorityStore(authority);
    const approvals = new LocalSqliteApprovalRequestRepository(
      authority,
      confirmActiveFence,
    );
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      apiCredentials: new LocalSqliteApiCredentialRepository(authority),
      ownerPepper: new LocalSqliteOwnerPepperRepository(authority),
      projectPolicy: new LocalSqliteProjectPolicyRepository(authority),
      approvals,
      approvalDetails: new LocalSqliteApprovalRequestSource(authority),
      securityAudit: securityAuthority,
      activateUserCredentialFence(
        fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
      ) {
        confirmLocalSqliteAuthenticatedUserCredentialFence(authority, fence);
        if (activeFence && !sameCredentialFence(activeFence, fence)) {
          throw new LocalSqliteAuthenticatedManagementFenceError();
        }
        activeFence = Object.freeze({ ...fence });
      },
      confirmUserCredentialFence: confirmActiveFence,
      close() {
        if (closePromise) return closePromise;
        closePromise = authority.close();
        return closePromise;
      },
    });
  } catch (error) {
    if (client.isOpen) client.close();
    throw error;
  }
}
