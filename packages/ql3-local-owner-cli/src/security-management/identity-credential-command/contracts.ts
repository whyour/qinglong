import type {
  createLocalIdentityCredentialAdministrationService,
  establishAuthenticatedLocalCommand,
  LocalCredentialAdministrationDeliveryRecord,
  LocalCredentialAdministrationDeliverySummary,
  LocalOwnerPepperKeyringFileProvider,
  openLocalSqliteIdentityCredentialAdministrationDatabase,
  SecuritySubject,
} from './contractAuthority';

export type IdentityCommandOperation =
  | 'identity.register'
  | 'identity.enable'
  | 'identity.disable';

export type CredentialCommandOperation =
  | 'credential.issue'
  | 'credential.rotate'
  | 'credential.revoke';

export type DeliveryCommandOperation = 'credential.delivery.acknowledge';

export type InspectionCommandOperation =
  | 'identity.inspect'
  | 'credential.inspect';

export interface LocalIdentityCredentialCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: 'edge' | 'standalone';
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly credentialDeliveryDirectory?: string;
  readonly busyTimeoutMs?: number;
}

export interface BaseMutationRequest {
  readonly projectId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly failureAuditEventId: string;
}

export interface BaseTargetMutationRequest extends BaseMutationRequest {
  readonly target: SecuritySubject;
  readonly expectedCurrentVersion: number;
}

export interface BaseInspectionRequest {
  readonly projectId: string;
  readonly requestId: string;
  readonly auditEventId: string;
}

export interface LocalIdentityInspectionCommand {
  readonly schemaVersion: 1;
  readonly operation: 'identity.inspect';
  readonly options: LocalIdentityCredentialCommandOptions;
  readonly request: BaseInspectionRequest & {
    readonly target: SecuritySubject;
  };
}

export interface LocalApiCredentialInspectionCommand {
  readonly schemaVersion: 1;
  readonly operation: 'credential.inspect';
  readonly options: LocalIdentityCredentialCommandOptions;
  readonly request: BaseInspectionRequest & {
    readonly credentialId: string;
  };
}

export interface LocalIdentityAdministrationCommand {
  readonly schemaVersion: 1;
  readonly operation: IdentityCommandOperation;
  readonly options: LocalIdentityCredentialCommandOptions;
  readonly request: BaseTargetMutationRequest;
}

export interface LocalApiCredentialIssueCommand {
  readonly schemaVersion: 1;
  readonly operation: 'credential.issue' | 'credential.rotate';
  readonly options: LocalIdentityCredentialCommandOptions & {
    readonly credentialDeliveryDirectory: string;
  };
  readonly request: BaseTargetMutationRequest & {
    readonly credentialId: string;
    readonly lifetimeMs: number;
  };
}

export interface LocalApiCredentialRevokeCommand {
  readonly schemaVersion: 1;
  readonly operation: 'credential.revoke';
  readonly options: LocalIdentityCredentialCommandOptions;
  readonly request: BaseTargetMutationRequest & {
    readonly credentialId: string;
  };
}

export interface LocalCredentialDeliveryAcknowledgeCommand {
  readonly schemaVersion: 1;
  readonly operation: DeliveryCommandOperation;
  readonly options: LocalIdentityCredentialCommandOptions & {
    readonly credentialDeliveryDirectory: string;
  };
  readonly request: BaseMutationRequest & {
    readonly credentialMutationId: string;
    readonly expectedDeliveryDigest: string;
  };
}

export type LocalIdentityCredentialCommand =
  | LocalIdentityInspectionCommand
  | LocalApiCredentialInspectionCommand
  | LocalIdentityAdministrationCommand
  | LocalApiCredentialIssueCommand
  | LocalApiCredentialRevokeCommand
  | LocalCredentialDeliveryAcknowledgeCommand;

export type LocalIdentityCredentialCommandResult =
  | Readonly<{
      schemaVersion: 1;
      operation: InspectionCommandOperation;
      projectId: string;
      found: false;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'identity.inspect';
      projectId: string;
      found: true;
      target: Readonly<SecuritySubject>;
      version: number;
      identityStatus: 'active' | 'disabled';
      createdAtMs: number;
      updatedAtMs: number;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'credential.inspect';
      projectId: string;
      found: true;
      credentialId: string;
      target: Readonly<SecuritySubject>;
      version: number;
      state: 'active' | 'revoked';
      subjectStatus: 'active' | 'disabled';
      createdAtMs: number;
      notBeforeAtMs: number;
      expiresAtMs: number;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: IdentityCommandOperation;
      status: 'inserted' | 'existing';
      projectId: string;
      target: Readonly<SecuritySubject>;
      version: number;
      identityStatus: 'active' | 'disabled';
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: CredentialCommandOperation;
      status: 'inserted' | 'existing';
      projectId: string;
      target: Readonly<SecuritySubject>;
      credentialId: string;
      version: number;
      state: 'active' | 'revoked';
      expiresAtMs: number;
      delivery?: Readonly<{
        fileName: string;
        digest: string;
      }>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: DeliveryCommandOperation;
      status: 'inserted' | 'existing';
      projectId: string;
      credentialMutationId: string;
      acknowledgementMutationId: string;
      deliveryDigest: string;
      cleanup: 'removed' | 'absent';
    }>;

export interface CredentialDelivery {
  readonly directory: string;
  prepare(
    record: LocalCredentialAdministrationDeliveryRecord,
  ): Readonly<LocalCredentialAdministrationDeliveryRecord>;
  digest(record: LocalCredentialAdministrationDeliveryRecord): string;
  publish(
    record: LocalCredentialAdministrationDeliveryRecord,
    expectedDeliveryDigest: string,
  ): Readonly<LocalCredentialAdministrationDeliverySummary>;
  removeAcknowledged(
    mutationId: string,
    expectedDeliveryDigest: string,
  ): 'removed' | 'absent';
}

export interface PepperMaterialProvider {
  resolve(
    pepperKeyId: string,
  ): ReturnType<LocalOwnerPepperKeyringFileProvider['resolve']>;
}

export interface LocalIdentityCredentialCommandRunner {
  run(
    commandFilePath: string,
  ): Promise<Readonly<LocalIdentityCredentialCommandResult>>;
}

export interface LocalIdentityCredentialCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteIdentityCredentialAdministrationDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly createService: typeof createLocalIdentityCredentialAdministrationService;
  readonly createDelivery: (directory: string) => CredentialDelivery;
  readonly createPepperProvider: (directory: string) => PepperMaterialProvider;
  readonly randomBytes: (size: number) => Buffer;
  readonly now: () => number;
}

export class LocalIdentityCredentialCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_IDENTITY_CREDENTIAL_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local Identity credential command is invalid: ${message}`);
    this.name = 'LocalIdentityCredentialCommandConfigurationError';
  }
}

export class LocalIdentityCredentialCommandPepperUnavailableError extends Error {
  readonly code = 'LOCAL_IDENTITY_CREDENTIAL_COMMAND_PEPPER_UNAVAILABLE';

  constructor() {
    super('Local Identity credential active pepper material is unavailable');
    this.name = 'LocalIdentityCredentialCommandPepperUnavailableError';
  }
}

export class LocalIdentityCredentialCommandCurrentCredentialError extends Error {
  readonly code =
    'LOCAL_IDENTITY_CREDENTIAL_COMMAND_CURRENT_CREDENTIAL_INVALID';

  constructor() {
    super('Local Identity credential current version is unavailable');
    this.name = 'LocalIdentityCredentialCommandCurrentCredentialError';
  }
}
