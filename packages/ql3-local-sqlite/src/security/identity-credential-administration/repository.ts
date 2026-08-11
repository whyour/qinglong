import { type IdentitySubjectRecord } from '@qinglong/runtime-core/identity-administration';
import {
  type AppendAuthorizedLocalApiCredentialCommand,
  type AppendAuthorizedLocalApiCredentialResult,
  type AppendAuthorizedLocalCredentialDeliveryAcknowledgementCommand,
  type AppendAuthorizedLocalCredentialDeliveryAcknowledgementResult,
  type AppendAuthorizedLocalIdentityCommand,
  type AppendAuthorizedLocalIdentityResult,
  type InspectAuthorizedLocalApiCredentialCommand,
  type InspectAuthorizedLocalApiCredentialResult,
  type InspectAuthorizedLocalIdentityCommand,
  type InspectAuthorizedLocalIdentityResult,
  type LocalCredentialDeliveryAcknowledgementRecord,
  type LocalIdentityCredentialAdministrationRepository,
  type ResolvedLocalApiCredentialMutation,
  type ResolvedLocalIdentitySubjectMutation,
} from '@qinglong/runtime-core/local-identity-credential-administration';
import type { SecuritySubject } from '@qinglong/runtime-core/security';
import { type SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';

import * as commonOperations from './commonOperations';

import * as identityOperations from './identityOperations';

import * as credentialOperations from './credentialOperations';

import * as deliveryOperations from './deliveryOperations';

export class LocalSqliteIdentityCredentialAdministrationRepository
  implements LocalIdentityCredentialAdministrationRepository
{
  constructor(
    private readonly authority: LocalSqliteOperationAuthority,
    private readonly beforeMutation: () => void,
  ) {
    if (
      !(authority instanceof LocalSqliteOperationAuthority) ||
      typeof beforeMutation !== 'function'
    ) {
      throw new TypeError(
        'Local SQLite Identity administration dependencies are invalid',
      );
    }
  }

  record(audit: SecurityAuditRecord): Promise<void> {
    return commonOperations.record(this.authority, audit);
  }

  resolveAuthorityProjectId(): Promise<string | null> {
    return commonOperations.resolveAuthorityProjectId(this.authority);
  }

  resolveIdentity(
    requested: SecuritySubject,
  ): Promise<Readonly<IdentitySubjectRecord> | null> {
    return identityOperations.resolveIdentity(this.authority, requested);
  }

  resolveIdentityMutation(
    requestedMutationId: string,
  ): Promise<Readonly<ResolvedLocalIdentitySubjectMutation> | null> {
    return identityOperations.resolveIdentityMutation(
      this.authority,
      requestedMutationId,
    );
  }

  inspectAuthorizedIdentity(
    input: InspectAuthorizedLocalIdentityCommand,
  ): Promise<InspectAuthorizedLocalIdentityResult> {
    return identityOperations.inspectAuthorizedIdentity(
      this.authority,
      this.beforeMutation,
      input,
    );
  }

  appendAuthorizedIdentity(
    input: AppendAuthorizedLocalIdentityCommand,
  ): Promise<AppendAuthorizedLocalIdentityResult> {
    return identityOperations.appendAuthorizedIdentity(
      this.authority,
      this.beforeMutation,
      input,
    );
  }

  resolveCredentialMutation(
    requestedMutationId: string,
  ): Promise<Readonly<ResolvedLocalApiCredentialMutation> | null> {
    return credentialOperations.resolveCredentialMutation(
      this.authority,
      requestedMutationId,
    );
  }

  inspectAuthorizedCredential(
    input: InspectAuthorizedLocalApiCredentialCommand,
  ): Promise<InspectAuthorizedLocalApiCredentialResult> {
    return credentialOperations.inspectAuthorizedCredential(
      this.authority,
      this.beforeMutation,
      input,
    );
  }

  appendAuthorizedCredential(
    input: AppendAuthorizedLocalApiCredentialCommand,
  ): Promise<AppendAuthorizedLocalApiCredentialResult> {
    return credentialOperations.appendAuthorizedCredential(
      this.authority,
      this.beforeMutation,
      input,
    );
  }

  resolveDeliveryAcknowledgement(
    credentialMutationId: string,
  ): Promise<Readonly<LocalCredentialDeliveryAcknowledgementRecord> | null> {
    return deliveryOperations.resolveDeliveryAcknowledgement(
      this.authority,
      credentialMutationId,
    );
  }

  appendAuthorizedDeliveryAcknowledgement(
    input: AppendAuthorizedLocalCredentialDeliveryAcknowledgementCommand,
  ): Promise<AppendAuthorizedLocalCredentialDeliveryAcknowledgementResult> {
    return deliveryOperations.appendAuthorizedDeliveryAcknowledgement(
      this.authority,
      this.beforeMutation,
      input,
    );
  }
}
