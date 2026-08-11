import type { ApiCredentialRepository } from '@qinglong/runtime-core/api-credential';
import type { LocalOwnerBootstrapRepository } from '@qinglong/runtime-core/local-owner-bootstrap';
import type { LocalOwnerCredentialRecoveryRepository } from '@qinglong/runtime-core/local-owner-credential-recovery';
import type { LocalOwnerPepperReferenceRepository } from '@qinglong/runtime-core/local-owner-pepper';
import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  LocalSqliteConfigurationError,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from './config';
import { LocalSqliteApiCredentialRepository } from '../security/apiCredentialRepository';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteOwnerBootstrapRepository } from '../local-owner/ownerBootstrapRepository';
import { LocalSqliteOwnerCredentialRecoveryRepository } from '../local-owner/ownerCredentialRecoveryRepository';
import { LocalSqliteOwnerPepperRepository } from '../local-owner/ownerPepperRepository';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../readiness/readiness';

/**
 * A deliberately narrow and short-lived local authority. It is excluded from
 * the default runtime entry point so a long-running application cannot retain
 * owner-bootstrap power by accident.
 */
export interface LocalSqliteBootstrapDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly apiCredentials: ApiCredentialRepository;
  readonly ownerBootstrap: LocalOwnerBootstrapRepository;
  readonly ownerCredentialRecovery: LocalOwnerCredentialRecoveryRepository;
  readonly ownerPepper: LocalOwnerPepperReferenceRepository;
  close(): Promise<void>;
}

export async function openLocalSqliteBootstrapDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteBootstrapDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    const apiCredentials = new LocalSqliteApiCredentialRepository(authority);
    const ownerBootstrap = new LocalSqliteOwnerBootstrapRepository(authority);
    const ownerCredentialRecovery =
      new LocalSqliteOwnerCredentialRecoveryRepository(authority);
    const ownerPepper = new LocalSqliteOwnerPepperRepository(authority);
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      apiCredentials,
      ownerBootstrap,
      ownerCredentialRecovery,
      ownerPepper,
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

export {
  LocalSqliteConfigurationError,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
};
export type { LocalSqliteReadinessEvidence } from '../readiness/readiness';
