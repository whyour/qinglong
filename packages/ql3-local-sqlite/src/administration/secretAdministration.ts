import type { ApiCredentialRepository } from '@qinglong/runtime-core/api-credential';
import type { LocalOwnerPepperRepository } from '@qinglong/runtime-core/local-owner-pepper';
import type { LocalSecretAdministrationRepository } from '@qinglong/runtime-core/local-secret-administration';
import type { ProjectPolicyRepository } from '@qinglong/runtime-core/project-policy';
import type { SecurityAuditSink } from '@qinglong/runtime-core/security-audit';

import { LocalSqliteApiCredentialRepository } from '../security/apiCredentialRepository';
import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  LocalSqliteConfigurationError,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '../storage/config';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteOwnerPepperRepository } from '../local-owner/ownerPepperRepository';
import {
  confirmLocalSqliteAuthenticatedUserCredentialFence,
  LocalSqliteAuthenticatedManagementFenceError,
  type LocalSqliteAuthenticatedUserCredentialFence,
} from './packageManagement';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../readiness/readiness';
import { LocalSqliteSecurityAuthorityStore } from '../security/securityAuthorityStore';

/**
 * One short-lived authority for authenticated Secret creation and rotation.
 * It deliberately excludes task execution, scheduling, plugin management and
 * schema migration capabilities.
 */
export interface LocalSqliteSecretAdministrationDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly apiCredentials: ApiCredentialRepository;
  readonly ownerPepper: Pick<LocalOwnerPepperRepository, 'resolveKey'>;
  readonly projectPolicy: ProjectPolicyRepository;
  readonly localSecretAdministration: LocalSecretAdministrationRepository;
  readonly securityAudit: SecurityAuditSink;
  activateUserCredentialFence(
    fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  ): void;
  close(): Promise<void>;
}

function sameFence(
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

export async function openLocalSqliteSecretAdministrationDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteSecretAdministrationDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    let activeFence:
      | Readonly<LocalSqliteAuthenticatedUserCredentialFence>
      | undefined;
    const securityAuthority = new LocalSqliteSecurityAuthorityStore(authority, {
      beforeAuthorizedLocalSecretMutation() {
        if (!activeFence) {
          throw new LocalSqliteAuthenticatedManagementFenceError();
        }
        confirmLocalSqliteAuthenticatedUserCredentialFence(
          authority,
          activeFence,
        );
      },
    });
    const apiCredentials = new LocalSqliteApiCredentialRepository(authority);
    const ownerPepper = new LocalSqliteOwnerPepperRepository(authority);
    const projectPolicy: ProjectPolicyRepository = Object.freeze({
      resolve: (
        ...[projectId, subject]: Parameters<ProjectPolicyRepository['resolve']>
      ) => securityAuthority.resolve(projectId, subject),
      append: (...[command]: Parameters<ProjectPolicyRepository['append']>) =>
        securityAuthority.append(command),
    });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      apiCredentials,
      ownerPepper,
      projectPolicy,
      localSecretAdministration: securityAuthority,
      securityAudit: securityAuthority,
      activateUserCredentialFence(
        fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
      ) {
        confirmLocalSqliteAuthenticatedUserCredentialFence(authority, fence);
        if (activeFence && !sameFence(activeFence, fence)) {
          throw new LocalSqliteAuthenticatedManagementFenceError();
        }
        activeFence = Object.freeze({ ...fence });
      },
      close() {
        if (closePromise) return closePromise;
        closePromise = authority.close();
        return closePromise;
      },
    });
  } catch (error) {
    if (client.isOpen) client.close();
    if (error instanceof LocalSqliteConfigurationError) throw error;
    throw error;
  }
}
