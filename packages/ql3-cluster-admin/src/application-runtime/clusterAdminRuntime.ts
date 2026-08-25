import type {
  OpenPostgresDatabase,
  PostgresDatabaseResource,
} from '@qinglong/runtime-core';
import { assertApiCredentialPepper } from '@qinglong/runtime-core/api-credential-token';
import { createSingletonApiCredentialPepperKeyring } from '@qinglong/runtime-core/api-credential-pepper-keyring';
import { LEGACY_API_CREDENTIAL_PEPPER_KEY_ID } from '@qinglong/runtime-core/api-credential';
import { assertWorkerCredentialPepper } from '@qinglong/runtime-core/worker-credential-token';
import type { SecurityAuditQueryRepository } from '@qinglong/runtime-core/security-audit-query';
import {
  PostgresApiCredentialAdministrationRepository,
  PostgresIdentityAdministrationRepository,
  PostgresSecurityAuditQueryRepository,
  PostgresWorkerCredentialAdministrationRepository,
  assertPostgresAdminSchemaReady,
  type PostgresSchemaReadinessReport,
} from '@qinglong/cluster-postgres/admin';
import {
  createClusterAdministrationService,
  type ClusterAdministrationOptions,
  type ClusterAdministrationService,
} from '../security-administration/clusterAdministration';
import {
  createWorkerCredentialAdministrationService,
  type WorkerCredentialAdministrationService,
} from '../worker-credential/workerCredentialAdministration';

export interface ClusterAdminBootstrapOptions
  extends ClusterAdministrationOptions {
  readonly openDatabase: OpenPostgresDatabase;
  readonly apiCredentialPepper: string;
  readonly workerCredentialPepper: string;
}

export interface ClusterAdminRuntime {
  readonly evidence: PostgresSchemaReadinessReport;
  readonly administration: ClusterAdministrationService;
  readonly audit: SecurityAuditQueryRepository;
  readonly workerCredentials: WorkerCredentialAdministrationService;
  close(): Promise<void>;
}

export async function bootstrapClusterAdmin(
  options: ClusterAdminBootstrapOptions,
): Promise<ClusterAdminRuntime> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Cluster admin bootstrap options are invalid');
  }
  if (typeof options.openDatabase !== 'function') {
    throw new TypeError('Cluster admin database opener is invalid');
  }
  const optionKeys = new Set([
    'openDatabase',
    'apiCredentialPepper',
    'workerCredentialPepper',
    'now',
    'randomBytes',
  ]);
  if (Object.keys(options).some((key) => !optionKeys.has(key))) {
    throw new TypeError('Cluster admin bootstrap options shape is invalid');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('Cluster admin clock is invalid');
  }
  if (
    options.randomBytes !== undefined &&
    typeof options.randomBytes !== 'function'
  ) {
    throw new TypeError('Cluster admin random source is invalid');
  }
  try {
    assertApiCredentialPepper(options.apiCredentialPepper);
  } catch {
    throw new TypeError('Cluster admin API credential pepper is invalid');
  }
  try {
    assertWorkerCredentialPepper(options.workerCredentialPepper);
  } catch {
    throw new TypeError('Cluster admin Worker credential pepper is invalid');
  }
  let database: PostgresDatabaseResource | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!database) return Promise.resolve();
    closePromise ??= database.close();
    return closePromise;
  };
  try {
    database = await options.openDatabase();
    const evidence = await assertPostgresAdminSchemaReady(database.pool);
    const identities = new PostgresIdentityAdministrationRepository(
      database.pool,
    );
    const credentials = new PostgresApiCredentialAdministrationRepository(
      database.pool,
    );
    return Object.freeze({
      evidence,
      administration: createClusterAdministrationService(
        identities,
        credentials,
        createSingletonApiCredentialPepperKeyring(
          options.apiCredentialPepper,
          LEGACY_API_CREDENTIAL_PEPPER_KEY_ID,
        ).keys[0]!,
        {
          ...(options.now ? { now: options.now } : {}),
          ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
        },
      ),
      audit: new PostgresSecurityAuditQueryRepository(database.pool),
      workerCredentials: createWorkerCredentialAdministrationService(
        new PostgresWorkerCredentialAdministrationRepository(database.pool),
        options.workerCredentialPepper,
        {
          ...(options.now ? { now: options.now } : {}),
          ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
        },
      ),
      close,
    });
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve configuration/readiness/assembly failure.
    }
    throw error;
  }
}

export * from '../security-administration/clusterAdministration';
export * from '../worker-credential/workerCredentialAdministration';
