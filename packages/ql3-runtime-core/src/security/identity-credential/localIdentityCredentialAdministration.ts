import type { ApiCredentialRecord } from './apiCredential';
import type { ApiCredentialMutationRecord } from './apiCredentialAdministration';
import type {
  IdentitySubjectMutationRecord,
  IdentitySubjectRecord,
  ResolvedIdentitySubjectMutation,
} from './identityAdministration';
import type { SecurityPolicyFence, SecuritySubject } from '../security';
import type { SecurityAuditRecord } from '../audit/securityAudit';

export interface LocalIdentityAdministrationAuthorization {
  readonly projectId: string;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
}

export interface AppendAuthorizedLocalIdentityCommand {
  readonly expectedCurrentVersion: number;
  readonly mutation: IdentitySubjectMutationRecord;
  readonly authorization: LocalIdentityAdministrationAuthorization;
  readonly audit: SecurityAuditRecord;
}

export interface AppendAuthorizedLocalIdentityResult {
  readonly status: 'inserted' | 'existing';
  readonly identity: Readonly<IdentitySubjectRecord>;
  readonly mutation: Readonly<IdentitySubjectMutationRecord>;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface InspectAuthorizedLocalIdentityCommand {
  readonly target: SecuritySubject;
  readonly authorization: LocalIdentityAdministrationAuthorization;
  readonly audit: SecurityAuditRecord;
}

export interface InspectAuthorizedLocalIdentityResult {
  readonly identity: Readonly<IdentitySubjectRecord> | null;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface LocalCredentialDeliveryFact {
  readonly digest: string;
}

export interface AppendAuthorizedLocalApiCredentialCommand {
  readonly expectedCurrentVersion: number;
  readonly credential: ApiCredentialRecord;
  readonly mutation: ApiCredentialMutationRecord;
  readonly authorization: LocalIdentityAdministrationAuthorization;
  readonly delivery: Readonly<LocalCredentialDeliveryFact> | null;
  readonly audit: SecurityAuditRecord;
}

export interface AppendAuthorizedLocalApiCredentialResult {
  readonly status: 'inserted' | 'existing';
  readonly credential: Readonly<ApiCredentialRecord>;
  readonly mutation: Readonly<ApiCredentialMutationRecord>;
  readonly delivery: Readonly<LocalCredentialDeliveryFact> | null;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface InspectAuthorizedLocalApiCredentialCommand {
  readonly credentialId: string;
  readonly authorization: LocalIdentityAdministrationAuthorization;
  readonly audit: SecurityAuditRecord;
}

export interface InspectAuthorizedLocalApiCredentialResult {
  readonly credential: Readonly<ApiCredentialRecord> | null;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface LocalCredentialDeliveryAcknowledgementRecord {
  readonly credentialMutationId: string;
  readonly acknowledgementMutationId: string;
  readonly projectId: string;
  readonly deliveryDigest: string;
  readonly acknowledgedBy: SecuritySubject;
  readonly acknowledgedAtMs: number;
}

export interface AppendAuthorizedLocalCredentialDeliveryAcknowledgementCommand {
  readonly acknowledgement: LocalCredentialDeliveryAcknowledgementRecord;
  readonly authorization: LocalIdentityAdministrationAuthorization;
  readonly audit: SecurityAuditRecord;
}

export interface AppendAuthorizedLocalCredentialDeliveryAcknowledgementResult {
  readonly status: 'inserted' | 'existing';
  readonly acknowledgement: Readonly<LocalCredentialDeliveryAcknowledgementRecord>;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface ResolvedLocalIdentitySubjectMutation
  extends ResolvedIdentitySubjectMutation {
  readonly projectId: string;
}

export interface ResolvedLocalApiCredentialMutation {
  readonly projectId: string;
  readonly credential: Readonly<ApiCredentialRecord>;
  readonly mutation: Readonly<ApiCredentialMutationRecord>;
  readonly delivery: Readonly<LocalCredentialDeliveryFact> | null;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface LocalIdentityCredentialAdministrationRepository {
  resolveAuthorityProjectId(): Promise<string | null>;
  resolveIdentity(
    subject: SecuritySubject,
  ): Promise<Readonly<IdentitySubjectRecord> | null>;
  resolveIdentityMutation(
    mutationId: string,
  ): Promise<Readonly<ResolvedLocalIdentitySubjectMutation> | null>;
  appendAuthorizedIdentity(
    command: AppendAuthorizedLocalIdentityCommand,
  ): Promise<AppendAuthorizedLocalIdentityResult>;
  inspectAuthorizedIdentity(
    command: InspectAuthorizedLocalIdentityCommand,
  ): Promise<InspectAuthorizedLocalIdentityResult>;
  resolveCredentialMutation(
    mutationId: string,
  ): Promise<Readonly<ResolvedLocalApiCredentialMutation> | null>;
  appendAuthorizedCredential(
    command: AppendAuthorizedLocalApiCredentialCommand,
  ): Promise<AppendAuthorizedLocalApiCredentialResult>;
  inspectAuthorizedCredential(
    command: InspectAuthorizedLocalApiCredentialCommand,
  ): Promise<InspectAuthorizedLocalApiCredentialResult>;
  resolveDeliveryAcknowledgement(
    credentialMutationId: string,
  ): Promise<Readonly<LocalCredentialDeliveryAcknowledgementRecord> | null>;
  appendAuthorizedDeliveryAcknowledgement(
    command: AppendAuthorizedLocalCredentialDeliveryAcknowledgementCommand,
  ): Promise<AppendAuthorizedLocalCredentialDeliveryAcknowledgementResult>;
  record(audit: SecurityAuditRecord): Promise<void>;
}

export class LocalIdentityCredentialAuthorizationFenceConflictError extends Error {
  readonly code = 'LOCAL_IDENTITY_CREDENTIAL_AUTHORIZATION_FENCE_CONFLICT';

  constructor() {
    super('Local Identity credential authorization fence changed');
    this.name = 'LocalIdentityCredentialAuthorizationFenceConflictError';
  }
}

export class LocalIdentityOwnerBindingConflictError extends Error {
  readonly code = 'LOCAL_IDENTITY_OWNER_BINDING_CONFLICT';

  constructor() {
    super('Local Identity remains an active Project Owner');
    this.name = 'LocalIdentityOwnerBindingConflictError';
  }
}

export class LocalCredentialOwnerContinuityError extends Error {
  readonly code = 'LOCAL_CREDENTIAL_OWNER_CONTINUITY_REQUIRED';

  constructor() {
    super('An active Project Owner must retain an active credential');
    this.name = 'LocalCredentialOwnerContinuityError';
  }
}

export class LocalCredentialDeliveryMutationConflictError extends Error {
  readonly code = 'LOCAL_CREDENTIAL_DELIVERY_MUTATION_CONFLICT';

  constructor() {
    super('Local credential delivery mutation conflicts with previous use');
    this.name = 'LocalCredentialDeliveryMutationConflictError';
  }
}

export class LocalIdentityCredentialAdministrationUnavailableError extends Error {
  readonly code = 'LOCAL_IDENTITY_CREDENTIAL_ADMINISTRATION_UNAVAILABLE';

  constructor() {
    super('Local Identity credential administration is unavailable');
    this.name = 'LocalIdentityCredentialAdministrationUnavailableError';
  }
}
