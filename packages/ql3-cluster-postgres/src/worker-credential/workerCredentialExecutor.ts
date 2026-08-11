// Worker Credential executor composition is owned by this PostgreSQL domain.
export {
  PgPoolBinding,
  createPostgresDatabaseOpener,
  isPostgresTlsDnsServername,
  type OpenPostgresDatabaseOptions,
  type PostgresConnectionOptions,
  type PostgresDatabaseRole,
  type PostgresPoolOptions,
  type PostgresTlsOptions,
  type QingLongPostgresClient,
  type QingLongPostgresDatabaseResource,
  type QingLongPostgresPool,
  type QingLongPostgresQueryResult,
} from '../connection/pool';

export {
  PostgresConnectionEnvironmentError,
  loadPostgresConnectionEnvironment,
  type PostgresConnectionEnvironment,
  type PostgresConnectionEnvironmentKeys,
} from '../connection/connectionEnvironment';

export {
  POSTGRES_CA_FILE_ERROR_CODES,
  POSTGRES_CA_MAX_CERTIFICATES,
  POSTGRES_CA_MAX_FILE_BYTES,
  PostgresCertificateAuthorityFileError,
  inspectPostgresCertificateAuthorityFile,
  loadPostgresCertificateAuthorityFile,
  type PostgresCertificateAuthorityFileErrorCode,
  type PostgresCertificateAuthorityFileInspection,
} from '../connection/certificateAuthority';

export {
  POSTGRES_SCHEMA_READINESS_ERROR_CODES,
  PostgresSchemaReadinessError,
  assertPostgresWorkerCredentialExecutorSchemaReady,
  type PostgresSchemaReadinessErrorCode,
  type PostgresSchemaReadinessReport,
} from '../schema/schemaReadiness';

export { postgresqlMainMigrationManifest } from '../migration/migrationManifest';
export { PostgresApprovalRequestRepository } from '../approved-action/approvalRequestRepository';
export { PostgresApprovedActionExecutionRepository } from '../approved-action/approvedActionExecutionRepository';
export { PostgresProjectPolicyRepository } from '../security/projectPolicyRepository';
export { PostgresWorkerCredentialManagementPlanReader } from './workerCredentialManagementPlanRepository';
export { PostgresWorkerCredentialAdministrationRepository } from './workerCredentialAdministrationRepository';
export { PostgresRemoteWorkerSecretDeliveryAuthorityRepository } from './remoteWorkerSecretDeliveryRepository';
