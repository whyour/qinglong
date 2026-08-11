import { LocalIdentityCredentialAdministrationUnavailableError } from '@qinglong/runtime-core/local-identity-credential-administration';
import { type SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';
import { resolveLocalInstanceAuthorityProjectId } from '../../authority/instanceAuthorityProject';
import { LocalSqliteSecurityAuthorityStore } from '../securityAuthorityStore';

export function record(
  authority: LocalSqliteOperationAuthority,
  audit: SecurityAuditRecord,
): Promise<void> {
  return new LocalSqliteSecurityAuthorityStore(authority).record(audit);
}

export function resolveAuthorityProjectId(
  authority: LocalSqliteOperationAuthority,
): Promise<string | null> {
  return authority.enqueue(
    async () => resolveLocalInstanceAuthorityProjectId(authority.client),
    () => new LocalIdentityCredentialAdministrationUnavailableError(),
  );
}
