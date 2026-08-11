import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
} from '../storage/config';
import {
  auditLocalSqliteReadiness,
  LOCAL_SQLITE_CONTRACT_NAME,
  LOCAL_SQLITE_CONTRACT_VERSION,
  LocalSqliteReadinessError,
  type LocalSqliteReadinessEvidence,
} from './readiness';

export async function inspectLocalSqliteReadinessPath(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteReadinessEvidence> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, true);
  try {
    return await auditLocalSqliteReadiness(client);
  } finally {
    client.close();
  }
}

export {
  LOCAL_SQLITE_CONTRACT_NAME,
  LOCAL_SQLITE_CONTRACT_VERSION,
  LocalSqliteReadinessError,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteReadinessEvidence,
};
