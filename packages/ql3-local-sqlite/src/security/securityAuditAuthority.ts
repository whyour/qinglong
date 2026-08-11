import {
  InvalidProjectPolicyValueError,
  assertProjectPolicyProjectId,
  normalizeProjectPolicySubject,
} from '@qinglong/runtime-core/project-policy';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';

import { resolveLocalInstanceAuthorityProjectId } from '../authority/instanceAuthorityProject';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import type { LocalSqliteAuthenticatedUserCredentialFence } from '../administration/packageManagement';
import {
  LOCAL_ROLE_BINDING_SELECT,
  localRoleBindingFromRow,
} from './securityPersistence';

type Row = Record<string, unknown>;

export interface LocalSecurityAuditInstanceAuthorization {
  readonly authorityProjectId: string;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
}

function exactFence(value: SecurityPolicyFence): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'bindingVersion,projectVersion' ||
    !Number.isSafeInteger(value.projectVersion) ||
    value.projectVersion < 1 ||
    !Number.isSafeInteger(value.bindingVersion) ||
    (value.bindingVersion as number) < 1
  ) {
    throw new InvalidProjectPolicyValueError('authorization fence is invalid');
  }
}

function integer(row: Row | undefined, key: string): number {
  const value = row?.[key];
  if (!Number.isSafeInteger(value)) {
    throw new InvalidProjectPolicyValueError(
      'authority Project version is invalid',
    );
  }
  return value as number;
}

export function normalizeLocalSecurityAuditInstanceAuthorization(
  value: LocalSecurityAuditInstanceAuthorization,
): Readonly<LocalSecurityAuditInstanceAuthorization> {
  try {
    assertProjectPolicyProjectId(value.authorityProjectId);
    const actor = normalizeProjectPolicySubject(value.actor);
    exactFence(value.fence);
    return Object.freeze({
      authorityProjectId: value.authorityProjectId,
      actor,
      fence: Object.freeze({ ...value.fence }),
    });
  } catch (error) {
    if (error instanceof InvalidProjectPolicyValueError) throw error;
    throw new InvalidProjectPolicyValueError(
      'Local security audit authorization is invalid',
    );
  }
}

export function assertLocalSecurityAuditInstanceOwnerInTransaction(
  authority: LocalSqliteOperationAuthority,
  input: Readonly<LocalSecurityAuditInstanceAuthorization>,
  beforeOperation: () => void,
  conflict: () => Error,
): void {
  try {
    beforeOperation();
  } catch {
    throw conflict();
  }
  const client = authority.client;
  if (
    resolveLocalInstanceAuthorityProjectId(client) !== input.authorityProjectId
  ) {
    throw conflict();
  }
  const project = client
    .prepare(
      `SELECT "status" AS "status", "version" AS "version"
       FROM "QingLong3Projects"
       WHERE "id" = ?`,
    )
    .get(input.authorityProjectId) as Row | undefined;
  const actorRow = client
    .prepare(
      `SELECT ${LOCAL_ROLE_BINDING_SELECT}
       FROM "QingLong3ProjectRoleBindings"
       WHERE "project_id" = ? AND "subject_type" = ?
         AND "subject_id" = ?
       ORDER BY "version" DESC LIMIT 1`,
    )
    .get(input.authorityProjectId, input.actor.type, input.actor.id) as
    | Row
    | undefined;
  if (
    !project ||
    project.status !== 'active' ||
    integer(project, 'version') !== input.fence.projectVersion ||
    !actorRow
  ) {
    throw conflict();
  }
  const binding = localRoleBindingFromRow(actorRow);
  if (
    binding.version !== input.fence.bindingVersion ||
    binding.state !== 'active' ||
    binding.role !== 'owner'
  ) {
    throw conflict();
  }
}

export function sameLocalSqliteAuthenticatedUserCredentialFence(
  left: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  right: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
): boolean {
  return (
    left.credentialId === right.credentialId &&
    left.credentialVersion === right.credentialVersion &&
    left.pepperKeyId === right.pepperKeyId &&
    left.materialDigest === right.materialDigest &&
    left.subjectType === right.subjectType &&
    left.subjectId === right.subjectId &&
    left.secretDigest === right.secretDigest &&
    left.notBeforeAtMs === right.notBeforeAtMs &&
    left.expiresAtMs === right.expiresAtMs
  );
}
