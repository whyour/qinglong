import type { LocalOwnerPepperReferenceRepository } from '@qinglong/runtime-core/local-owner-pepper';
import type { LocalOwnerPepperMaterialGcRepository } from '@qinglong/runtime-core/local-owner-pepper-material-gc';
import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  LocalSqliteConfigurationError,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '../storage/config';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteOwnerPepperMaterialGcRepository } from '../local-owner/ownerPepperMaterialGcRepository';
import { LocalSqliteOwnerPepperRepository } from '../local-owner/ownerPepperRepository';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../readiness/readiness';

/** Short-lived authority for one reviewed pepper material GC operation. */
export interface LocalSqlitePepperGcDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly ownerPepper: LocalOwnerPepperReferenceRepository;
  readonly materialGc: LocalOwnerPepperMaterialGcRepository;
  close(): Promise<void>;
}

export async function openLocalSqlitePepperGcDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqlitePepperGcDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    const ownerPepper = new LocalSqliteOwnerPepperRepository(authority);
    const materialGc = new LocalSqliteOwnerPepperMaterialGcRepository(
      authority,
    );
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      ownerPepper,
      materialGc,
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
