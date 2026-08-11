import { type ApiCredentialMutationRecord } from '@qinglong/runtime-core/api-credential-administration';
import {
  normalizeApiCredentialRecord,
  type ApiCredentialRecord,
} from '@qinglong/runtime-core/api-credential';
import {
  normalizeIdentitySubjectRecord,
  type IdentitySubjectMutationRecord,
  type IdentitySubjectRecord,
} from '@qinglong/runtime-core/identity-administration';
import {
  LocalIdentityCredentialAdministrationUnavailableError,
  type LocalIdentityAdministrationAuthorization,
  type ResolvedLocalApiCredentialMutation,
  type ResolvedLocalIdentitySubjectMutation,
} from '@qinglong/runtime-core/local-identity-credential-administration';
import {
  assertProjectPolicyProjectId,
  normalizeProjectPolicySubject,
} from '@qinglong/runtime-core/project-policy';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';
import { sameSecurityAuditSemantic } from '../securityPersistence';

export type Row = Record<string, unknown>;

export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const ADMINISTRABLE_SUBJECT_TYPES = new Set([
  'user',
  'api_app',
  'mcp_client',
  'agent',
]);

export const IDENTITY_MUTATION_SELECT = `
  mutation."mutation_id" AS "mutationId",
  mutation."project_id" AS "mutationProjectId",
  mutation."operation" AS "operation",
  mutation."subject_type" AS "targetSubjectType",
  mutation."subject_id" AS "targetSubjectId",
  mutation."subject_version" AS "subjectVersion",
  mutation."expected_previous_version" AS "expectedPreviousVersion",
  mutation."status" AS "status",
  mutation."changed_by_type" AS "changedByType",
  mutation."changed_by_id" AS "changedById",
  mutation."identity_created_at_ms" AS "identityCreatedAtMs",
  mutation."created_at_ms" AS "createdAtMs"
`;

export const CREDENTIAL_MUTATION_SELECT = `
  mutation."mutation_id" AS "mutationId",
  mutation."project_id" AS "mutationProjectId",
  mutation."operation" AS "operation",
  mutation."credential_id" AS "credentialId",
  mutation."credential_version" AS "credentialVersion",
  mutation."expected_previous_version" AS "expectedPreviousVersion",
  mutation."subject_type" AS "targetSubjectType",
  mutation."subject_id" AS "targetSubjectId",
  mutation."subject_status" AS "subjectStatus",
  mutation."state" AS "state",
  mutation."pepper_key_id" AS "pepperKeyId",
  mutation."secret_digest" AS "secretDigest",
  mutation."not_before_at_ms" AS "notBeforeAtMs",
  mutation."expires_at_ms" AS "expiresAtMs",
  mutation."delivery_digest" AS "deliveryDigest",
  mutation."changed_by_type" AS "changedByType",
  mutation."changed_by_id" AS "changedById",
  mutation."created_at_ms" AS "createdAtMs"
`;

export const ADMIN_AUDIT_SELECT = `
  audit."event_id" AS "eventId",
  audit."request_id" AS "requestId",
  audit."operation_id" AS "operationId",
  audit."project_id" AS "projectId",
  audit."subject_type" AS "subjectType",
  audit."subject_id" AS "subjectId",
  audit."authentication_id" AS "authenticationId",
  audit."outcome" AS "outcome",
  audit."reasons_json" AS "reasonsJson",
  audit."fence_project_version" AS "fenceProjectVersion",
  audit."fence_binding_version" AS "fenceBindingVersion",
  audit."occurred_at_ms" AS "occurredAtMs"
`;

export function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) {
    throw new LocalIdentityCredentialAdministrationUnavailableError();
  }
  return value as number;
}

export function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new LocalIdentityCredentialAdministrationUnavailableError();
  }
  return value;
}

export function optionalText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== 'string') {
    throw new LocalIdentityCredentialAdministrationUnavailableError();
  }
  return value as string | null;
}

export function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

export function exactFence(
  value: SecurityPolicyFence,
): Readonly<SecurityPolicyFence> {
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
    throw new TypeError('Local Identity administration fence is invalid');
  }
  return Object.freeze({
    projectVersion: value.projectVersion,
    bindingVersion: value.bindingVersion,
  });
}

export function authorization(
  value: LocalIdentityAdministrationAuthorization,
): Readonly<LocalIdentityAdministrationAuthorization> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'actor,fence,projectId'
  ) {
    throw new TypeError(
      'Local Identity administration authorization is invalid',
    );
  }
  assertProjectPolicyProjectId(value.projectId);
  const actor = normalizeProjectPolicySubject(value.actor);
  if (actor.type !== 'user') {
    throw new TypeError('Local Identity administration actor is invalid');
  }
  return Object.freeze({
    projectId: value.projectId,
    actor,
    fence: exactFence(value.fence),
  });
}

export function assertAllowedAudit(
  input: SecurityAuditRecord,
  operationId: string,
  mutationId: string,
  auth: Readonly<LocalIdentityAdministrationAuthorization>,
): Readonly<SecurityAuditRecord> {
  const audit = normalizeSecurityAuditRecord(input);
  if (
    audit.eventId !== mutationId ||
    audit.operationId !== operationId ||
    audit.projectId !== auth.projectId ||
    !audit.subject ||
    !sameSubject(audit.subject, auth.actor) ||
    audit.outcome !== 'allowed' ||
    audit.fence?.projectVersion !== auth.fence.projectVersion ||
    audit.fence.bindingVersion !== auth.fence.bindingVersion
  ) {
    throw new TypeError('Local Identity administration audit is invalid');
  }
  return audit;
}

export function identityFromRow(row: Row): Readonly<IdentitySubjectRecord> {
  return normalizeIdentitySubjectRecord({
    subject: {
      type: text(row, 'subjectType') as SecuritySubject['type'],
      id: text(row, 'subjectId'),
    },
    status: text(row, 'status') as IdentitySubjectRecord['status'],
    version: integer(row, 'version'),
    createdAtMs: integer(row, 'createdAtMs'),
    updatedAtMs: integer(row, 'updatedAtMs'),
  });
}

export function identityMutationFromRow(
  row: Row,
): Readonly<IdentitySubjectMutationRecord> {
  return Object.freeze({
    mutationId: text(row, 'mutationId'),
    operation: text(
      row,
      'operation',
    ) as IdentitySubjectMutationRecord['operation'],
    subject: Object.freeze({
      type: text(row, 'targetSubjectType') as SecuritySubject['type'],
      id: text(row, 'targetSubjectId'),
    }),
    subjectVersion: integer(row, 'subjectVersion'),
    expectedPreviousVersion: integer(row, 'expectedPreviousVersion'),
    status: text(row, 'status') as IdentitySubjectMutationRecord['status'],
    changedBy: Object.freeze({
      type: text(row, 'changedByType') as SecuritySubject['type'],
      id: text(row, 'changedById'),
    }),
    createdAtMs: integer(row, 'createdAtMs'),
  });
}

export function identityResultFromMutationRow(
  row: Row,
): Readonly<IdentitySubjectRecord> {
  return normalizeIdentitySubjectRecord({
    subject: {
      type: text(row, 'targetSubjectType') as SecuritySubject['type'],
      id: text(row, 'targetSubjectId'),
    },
    status: text(row, 'status') as IdentitySubjectRecord['status'],
    version: integer(row, 'subjectVersion'),
    createdAtMs: integer(row, 'identityCreatedAtMs'),
    updatedAtMs: integer(row, 'createdAtMs'),
  });
}

export function credentialFromMutationRow(
  row: Row,
): Readonly<ApiCredentialRecord> {
  return normalizeApiCredentialRecord({
    credentialId: text(row, 'credentialId'),
    version: integer(row, 'credentialVersion'),
    pepperKeyId: text(row, 'pepperKeyId'),
    state: text(row, 'state') as ApiCredentialRecord['state'],
    subject: {
      type: text(row, 'targetSubjectType') as SecuritySubject['type'],
      id: text(row, 'targetSubjectId'),
    },
    subjectStatus: text(
      row,
      'subjectStatus',
    ) as ApiCredentialRecord['subjectStatus'],
    secretDigest: text(row, 'secretDigest'),
    createdAtMs: integer(row, 'createdAtMs'),
    notBeforeAtMs: integer(row, 'notBeforeAtMs'),
    expiresAtMs: integer(row, 'expiresAtMs'),
  });
}

export function credentialMutationFromRow(
  row: Row,
): Readonly<ApiCredentialMutationRecord> {
  return Object.freeze({
    mutationId: text(row, 'mutationId'),
    operation: text(
      row,
      'operation',
    ) as ApiCredentialMutationRecord['operation'],
    credentialId: text(row, 'credentialId'),
    credentialVersion: integer(row, 'credentialVersion'),
    expectedPreviousVersion: integer(row, 'expectedPreviousVersion'),
    changedBy: Object.freeze({
      type: text(row, 'changedByType') as SecuritySubject['type'],
      id: text(row, 'changedById'),
    }),
    createdAtMs: integer(row, 'createdAtMs'),
  });
}

export function sameIdentitySemantic(
  existing: Readonly<ResolvedLocalIdentitySubjectMutation>,
  expected: Readonly<{
    projectId: string;
    identity: IdentitySubjectRecord;
    mutation: IdentitySubjectMutationRecord;
    audit: SecurityAuditRecord;
  }>,
): boolean {
  return (
    existing.projectId === expected.projectId &&
    sameSubject(existing.identity.subject, expected.identity.subject) &&
    existing.identity.status === expected.identity.status &&
    existing.identity.version === expected.identity.version &&
    existing.mutation.operation === expected.mutation.operation &&
    existing.mutation.subjectVersion === expected.mutation.subjectVersion &&
    existing.mutation.expectedPreviousVersion ===
      expected.mutation.expectedPreviousVersion &&
    sameSubject(existing.mutation.changedBy, expected.mutation.changedBy) &&
    sameSecurityAuditSemantic(existing.audit, expected.audit)
  );
}

export function sameCredentialSemantic(
  existing: Readonly<ResolvedLocalApiCredentialMutation>,
  expected: Readonly<{
    projectId: string;
    credential: ApiCredentialRecord;
    mutation: ApiCredentialMutationRecord;
    deliveryDigest: string | null;
    audit: SecurityAuditRecord;
  }>,
): boolean {
  const left = existing.credential;
  const right = expected.credential;
  return (
    existing.projectId === expected.projectId &&
    existing.mutation.operation === expected.mutation.operation &&
    existing.mutation.credentialId === expected.mutation.credentialId &&
    existing.mutation.credentialVersion ===
      expected.mutation.credentialVersion &&
    existing.mutation.expectedPreviousVersion ===
      expected.mutation.expectedPreviousVersion &&
    sameSubject(existing.mutation.changedBy, expected.mutation.changedBy) &&
    left.credentialId === right.credentialId &&
    left.version === right.version &&
    left.pepperKeyId === right.pepperKeyId &&
    left.state === right.state &&
    sameSubject(left.subject, right.subject) &&
    left.subjectStatus === right.subjectStatus &&
    left.secretDigest === right.secretDigest &&
    left.notBeforeAtMs === right.notBeforeAtMs &&
    left.expiresAtMs === right.expiresAtMs &&
    (existing.delivery?.digest ?? null) === expected.deliveryDigest &&
    sameSecurityAuditSemantic(existing.audit, expected.audit)
  );
}
