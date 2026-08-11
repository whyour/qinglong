import {
  LocalIdentityCredentialAuthorizationFenceConflictError,
  type LocalIdentityAdministrationAuthorization,
} from '@qinglong/runtime-core/local-identity-credential-administration';
import type { SecuritySubject } from '@qinglong/runtime-core/security';
import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';
import { resolveLocalInstanceAuthorityProjectId } from '../../authority/instanceAuthorityProject';
import {
  LOCAL_ROLE_BINDING_SELECT,
  localRoleBindingFromRow,
} from '../securityPersistence';

import { integer, type Row } from './codec';

export function assertAuthorizationInTransaction(
  authority: LocalSqliteOperationAuthority,
  auth: Readonly<LocalIdentityAdministrationAuthorization>,
  beforeMutation: () => void,
): void {
  try {
    beforeMutation();
  } catch {
    throw new LocalIdentityCredentialAuthorizationFenceConflictError();
  }
  if (
    resolveLocalInstanceAuthorityProjectId(authority.client) !== auth.projectId
  ) {
    throw new LocalIdentityCredentialAuthorizationFenceConflictError();
  }
  const project = authority.client
    .prepare(
      `SELECT "status" AS "status", "version" AS "version"
       FROM "QingLong3Projects" WHERE "id" = ?`,
    )
    .get(auth.projectId) as Row | undefined;
  const actorRow = authority.client
    .prepare(
      `SELECT ${LOCAL_ROLE_BINDING_SELECT}
       FROM "QingLong3ProjectRoleBindings"
       WHERE "project_id" = ? AND "subject_type" = ?
         AND "subject_id" = ?
       ORDER BY "version" DESC LIMIT 1`,
    )
    .get(auth.projectId, auth.actor.type, auth.actor.id) as Row | undefined;
  if (
    !project ||
    project.status !== 'active' ||
    integer(project, 'version') !== auth.fence.projectVersion ||
    !actorRow
  ) {
    throw new LocalIdentityCredentialAuthorizationFenceConflictError();
  }
  const binding = localRoleBindingFromRow(actorRow);
  if (
    binding.version !== auth.fence.bindingVersion ||
    binding.state !== 'active' ||
    binding.role !== 'owner'
  ) {
    throw new LocalIdentityCredentialAuthorizationFenceConflictError();
  }
}

export function activeOwnerBindingExists(
  authority: LocalSqliteOperationAuthority,
  subject: Readonly<SecuritySubject>,
): boolean {
  return !!authority.client
    .prepare(
      `SELECT 1 AS "present"
       FROM "QingLong3ProjectRoleBindings" AS binding
       WHERE binding."subject_type" = ? AND binding."subject_id" = ?
         AND binding."state" = 'active' AND binding."role" = 'owner'
         AND binding."version" = (
           SELECT max(latest."version")
           FROM "QingLong3ProjectRoleBindings" AS latest
           WHERE latest."project_id" = binding."project_id"
             AND latest."subject_type" = binding."subject_type"
             AND latest."subject_id" = binding."subject_id"
         )
       LIMIT 1`,
    )
    .get(subject.type, subject.id);
}

export function anotherActiveCredentialExists(
  authority: LocalSqliteOperationAuthority,
  subject: Readonly<SecuritySubject>,
  excludedCredentialId: string,
  nowMs: number,
): boolean {
  return !!authority.client
    .prepare(
      `SELECT 1 AS "present"
       FROM "QingLong3ApiCredentials" AS credential
       JOIN "QingLong3ApiCredentialPepperBindings" AS binding
         ON binding."credential_id" = credential."credential_id"
        AND binding."credential_version" = credential."version"
       JOIN "QingLong3LocalOwnerPepperKeys" AS pepper
         ON pepper."pepper_key_id" = binding."pepper_key_id"
       WHERE credential."subject_type" = ?
         AND credential."subject_id" = ?
         AND credential."credential_id" <> ?
         AND credential."state" = 'active'
         AND credential."not_before_at_ms" <= ?
         AND credential."expires_at_ms" > ?
         AND pepper."state" IN ('active','retired')
         AND credential."version" = (
           SELECT max(latest."version")
           FROM "QingLong3ApiCredentials" AS latest
           WHERE latest."credential_id" = credential."credential_id"
         )
       LIMIT 1`,
    )
    .get(subject.type, subject.id, excludedCredentialId, nowMs, nowMs);
}
