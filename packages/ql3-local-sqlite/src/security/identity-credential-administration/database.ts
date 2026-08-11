import { type ApiCredentialRepository } from '@qinglong/runtime-core/api-credential';
import {
  LocalIdentityCredentialAdministrationUnavailableError,
  type LocalIdentityCredentialAdministrationRepository,
} from '@qinglong/runtime-core/local-identity-credential-administration';
import { type ProjectPolicyRepository } from '@qinglong/runtime-core/project-policy';
import type { LocalOwnerPepperRepository } from '@qinglong/runtime-core/local-owner-pepper';
import { LocalSqliteApiCredentialRepository } from '../apiCredentialRepository';
import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '../../storage/config';
import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';
import { LocalSqliteOwnerPepperRepository } from '../../local-owner/ownerPepperRepository';
import {
  confirmLocalSqliteAuthenticatedUserCredentialFence,
  LocalSqliteAuthenticatedManagementFenceError,
  type LocalSqliteAuthenticatedUserCredentialFence,
} from '../../administration/packageManagement';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../../readiness/readiness';
import { LocalSqliteSecurityAuthorityStore } from '../securityAuthorityStore';

import { LocalSqliteIdentityCredentialAdministrationRepository } from './repository';

export interface LocalSqliteIdentityCredentialAdministrationDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly apiCredentials: ApiCredentialRepository;
  readonly ownerPepper: Pick<
    LocalOwnerPepperRepository,
    'resolveActive' | 'resolveKey'
  >;
  readonly projectPolicy: ProjectPolicyRepository;
  readonly identityCredentialAdministration: LocalIdentityCredentialAdministrationRepository;
  activateUserCredentialFence(
    fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  ): void;
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

export async function openLocalSqliteIdentityCredentialAdministrationDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteIdentityCredentialAdministrationDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    let activeFence:
      | Readonly<LocalSqliteAuthenticatedUserCredentialFence>
      | undefined;
    const securityAuthority = new LocalSqliteSecurityAuthorityStore(authority);
    const projectPolicy: ProjectPolicyRepository = Object.freeze({
      resolve: (
        ...[projectId, subject]: Parameters<ProjectPolicyRepository['resolve']>
      ) => securityAuthority.resolve(projectId, subject),
      append: (...[command]: Parameters<ProjectPolicyRepository['append']>) =>
        securityAuthority.append(command),
    });
    const identityCredentialAdministration =
      new LocalSqliteIdentityCredentialAdministrationRepository(
        authority,
        () => {
          if (!activeFence) {
            throw new LocalSqliteAuthenticatedManagementFenceError();
          }
          confirmLocalSqliteAuthenticatedUserCredentialFence(
            authority,
            activeFence,
          );
        },
      );
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      apiCredentials: new LocalSqliteApiCredentialRepository(authority),
      ownerPepper: new LocalSqliteOwnerPepperRepository(authority),
      projectPolicy,
      identityCredentialAdministration,
      activateUserCredentialFence(
        fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
      ) {
        confirmLocalSqliteAuthenticatedUserCredentialFence(authority, fence);
        if (activeFence && !sameCredentialFence(activeFence, fence)) {
          throw new LocalSqliteAuthenticatedManagementFenceError();
        }
        activeFence = Object.freeze({ ...fence });
      },
      close() {
        if (!closePromise) {
          closePromise = authority.close().catch(() => {
            throw new LocalIdentityCredentialAdministrationUnavailableError();
          });
        }
        return closePromise;
      },
    });
  } catch (error) {
    if (client.isOpen) client.close();
    throw error;
  }
}
