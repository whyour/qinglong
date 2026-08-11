import type { LocalOwnerBootstrapRepository } from '@qinglong/runtime-core/local-owner-bootstrap';
import type { LocalOwnerDeliveryAcknowledgementGcRepository } from '@qinglong/runtime-core/local-owner-delivery-acknowledgement-gc';
import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  LocalSqliteConfigurationError,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '../storage/config';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteOwnerBootstrapRepository } from '../local-owner/ownerBootstrapRepository';
import { LocalSqliteOwnerDeliveryAcknowledgementGcRepository } from '../local-owner/ownerDeliveryAcknowledgementGcRepository';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../readiness/readiness';

/** Short-lived authority for one reviewed acknowledgement compaction. */
export interface LocalSqliteAcknowledgementGcDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly ownerBootstrap: LocalOwnerBootstrapRepository;
  readonly acknowledgementGc: LocalOwnerDeliveryAcknowledgementGcRepository;
  close(): Promise<void>;
}

export async function openLocalSqliteAcknowledgementGcDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteAcknowledgementGcDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    const ownerBootstrap = new LocalSqliteOwnerBootstrapRepository(authority);
    const acknowledgementGc =
      new LocalSqliteOwnerDeliveryAcknowledgementGcRepository(authority);
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      ownerBootstrap,
      acknowledgementGc,
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
