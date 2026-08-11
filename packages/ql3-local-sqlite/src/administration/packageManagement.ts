import type { ApiCredentialRepository } from '@qinglong/runtime-core/api-credential';
import type { LocalOwnerPepperRepository } from '@qinglong/runtime-core/local-owner-pepper';
import type { PluginPackageQuarantineRepository } from '@qinglong/runtime-core/plugin-package-quarantine';
import type { PluginPackageAutomationPublicationRepository } from '@qinglong/runtime-core/plugin-package-automation-publication';
import type { LocalSecretEnvelopeRepository } from '@qinglong/runtime-core/local-secret';
import type { ProjectPolicyRepository } from '@qinglong/runtime-core/project-policy';
import type { SecurityAuditSink } from '@qinglong/runtime-core/security-audit';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';

import { LocalSqliteApiCredentialRepository } from '../security/apiCredentialRepository';
import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  LocalSqliteConfigurationError,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '../storage/config';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteOwnerPepperRepository } from '../local-owner/ownerPepperRepository';
import {
  EDGE_PLUGIN_PACKAGE_QUARANTINE_ACTIVE_SOURCE_LIMIT,
  LocalSqlitePluginPackageQuarantineRepository,
  STANDALONE_PLUGIN_PACKAGE_QUARANTINE_ACTIVE_SOURCE_LIMIT,
} from '../plugin-package/pluginPackageQuarantineRepository';
import { LocalSqlitePluginPackageAutomationPublicationRepository } from '../plugin-package/pluginPackageAutomationPublicationRepository';
import {
  insertLocalSecurityAudit,
  localSecurityAuditFromRow,
  sameSecurityAuditSemantic,
} from '../security/securityPersistence';
import { LocalSqliteSecurityAuthorityStore } from '../security/securityAuthorityStore';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../readiness/readiness';

/**
 * One short-lived local authority for authenticated package management.
 * It deliberately stays behind an explicit subpath and never migrates schema.
 */
export interface LocalSqlitePluginPackageManagementDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly authority: LocalSqliteOperationAuthority;
  readonly apiCredentials: ApiCredentialRepository;
  readonly ownerPepper: Pick<LocalOwnerPepperRepository, 'resolveKey'>;
  readonly pluginPackageQuarantine: PluginPackageQuarantineRepository;
  readonly securityAudit: SecurityAuditSink;
  confirmUserCredentialFence(
    fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  ): void;
  confirmDefaultProjectOwnerFence(
    fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  ): void;
  close(): Promise<void>;
}

export interface LocalSqliteOptionalFeatureRuntimeDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly authority: LocalSqliteOperationAuthority;
  readonly apiCredentials: ApiCredentialRepository;
  readonly ownerPepper: Pick<LocalOwnerPepperRepository, 'resolveKey'>;
  readonly projectPolicy: ProjectPolicyRepository;
  readonly automationPublications: Pick<
    PluginPackageAutomationPublicationRepository,
    'findCurrent' | 'findByDigest'
  >;
  readonly localSecrets: LocalSecretEnvelopeRepository;
  readonly securityAudit: SecurityAuditSink;
  close(): Promise<void>;
}

export interface LocalSqliteAuthenticatedUserCredentialFence {
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly pepperKeyId: string;
  readonly materialDigest: string;
  readonly subjectType: 'user';
  readonly subjectId: string;
  readonly secretDigest: string;
  readonly notBeforeAtMs: number;
  readonly expiresAtMs: number;
}

export class LocalSqliteAuthenticatedManagementFenceError extends Error {
  readonly code = 'LOCAL_SQLITE_AUTHENTICATED_MANAGEMENT_FENCE_REJECTED';

  constructor() {
    super('The authenticated local management credential fence was rejected');
    this.name = 'LocalSqliteAuthenticatedManagementFenceError';
  }
}

export class LocalSqliteAuthenticatedManagementOwnerError extends Error {
  readonly code = 'LOCAL_SQLITE_AUTHENTICATED_MANAGEMENT_OWNER_REJECTED';

  constructor() {
    super('The authenticated local management User is not a current Owner');
    this.name = 'LocalSqliteAuthenticatedManagementOwnerError';
  }
}

function exactFence(
  value: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'credentialId',
        'credentialVersion',
        'expiresAtMs',
        'materialDigest',
        'notBeforeAtMs',
        'pepperKeyId',
        'secretDigest',
        'subjectId',
        'subjectType',
      ]
        .sort()
        .join('\0') ||
    typeof value.credentialId !== 'string' ||
    value.credentialId.length < 1 ||
    value.credentialId.length > 128 ||
    !Number.isSafeInteger(value.credentialVersion) ||
    value.credentialVersion < 1 ||
    typeof value.pepperKeyId !== 'string' ||
    value.pepperKeyId.length < 1 ||
    value.pepperKeyId.length > 128 ||
    !/^[0-9a-f]{64}$/.test(value.materialDigest) ||
    value.subjectType !== 'user' ||
    typeof value.subjectId !== 'string' ||
    value.subjectId.length < 1 ||
    value.subjectId.length > 255 ||
    !/^[0-9a-f]{64}$/.test(value.secretDigest) ||
    !Number.isSafeInteger(value.notBeforeAtMs) ||
    value.notBeforeAtMs < 0 ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs <= value.notBeforeAtMs
  ) {
    throw new LocalSqliteAuthenticatedManagementFenceError();
  }
}

function confirmUserCredentialFence(
  authority: LocalSqliteOperationAuthority,
  fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
): void {
  exactFence(fence);
  try {
    const row = authority.client
      .prepare(
        `SELECT
           credential."state" AS "credentialState",
           credential."subject_type" AS "subjectType",
           credential."subject_id" AS "subjectId",
           credential."secret_digest" AS "secretDigest",
           credential."not_before_at_ms" AS "notBeforeAtMs",
           credential."expires_at_ms" AS "expiresAtMs",
           identity."status" AS "subjectStatus",
           binding."pepper_key_id" AS "pepperKeyId",
           pepper."state" AS "pepperState",
           pepper."material_digest" AS "materialDigest",
           CAST(unixepoch('subsec') * 1000 AS INTEGER) AS "nowMs"
         FROM "QingLong3ApiCredentials" AS credential
         JOIN "QingLong3IdentitySubjects" AS identity
           ON identity."subject_type" = credential."subject_type"
          AND identity."subject_id" = credential."subject_id"
         JOIN "QingLong3ApiCredentialPepperBindings" AS binding
           ON binding."credential_id" = credential."credential_id"
          AND binding."credential_version" = credential."version"
         JOIN "QingLong3LocalOwnerPepperKeys" AS pepper
           ON pepper."pepper_key_id" = binding."pepper_key_id"
         WHERE credential."credential_id" = ?
           AND credential."version" = ?`,
      )
      .get(fence.credentialId, fence.credentialVersion) as
      | Record<string, unknown>
      | undefined;
    if (
      !row ||
      row.credentialState !== 'active' ||
      row.subjectStatus !== 'active' ||
      row.subjectType !== fence.subjectType ||
      row.subjectId !== fence.subjectId ||
      row.secretDigest !== fence.secretDigest ||
      row.pepperKeyId !== fence.pepperKeyId ||
      (row.pepperState !== 'active' && row.pepperState !== 'retired') ||
      row.materialDigest !== fence.materialDigest ||
      row.notBeforeAtMs !== fence.notBeforeAtMs ||
      row.expiresAtMs !== fence.expiresAtMs ||
      !Number.isSafeInteger(row.nowMs) ||
      (row.nowMs as number) < fence.notBeforeAtMs ||
      (row.nowMs as number) >= fence.expiresAtMs
    ) {
      throw new LocalSqliteAuthenticatedManagementFenceError();
    }
  } catch (error) {
    if (error instanceof LocalSqliteAuthenticatedManagementFenceError) {
      throw error;
    }
    throw new LocalSqliteAuthenticatedManagementFenceError();
  }
}

export function confirmLocalSqliteAuthenticatedUserCredentialFence(
  authority: LocalSqliteOperationAuthority,
  fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
): void {
  confirmUserCredentialFence(authority, fence);
}

export function confirmLocalSqliteProjectPolicyFence(
  authority: LocalSqliteOperationAuthority,
  projectId: string,
  actor: Readonly<SecuritySubject>,
  fence: Readonly<SecurityPolicyFence>,
): void {
  try {
    if (
      !Number.isSafeInteger(fence.projectVersion) ||
      fence.projectVersion < 1 ||
      !Number.isSafeInteger(fence.bindingVersion) ||
      (fence.bindingVersion as number) < 1
    ) {
      throw new LocalSqliteAuthenticatedManagementFenceError();
    }
    const row = authority.client
      .prepare(
        `SELECT project."status" AS "projectStatus",
                project."version" AS "projectVersion",
                binding."state" AS "bindingState",
                binding."version" AS "bindingVersion"
           FROM "QingLong3Projects" AS project
           JOIN "QingLong3ProjectRoleBindings" AS binding
             ON binding."project_id" = project."id"
            AND binding."subject_type" = ?
            AND binding."subject_id" = ?
          WHERE project."id" = ?
            AND binding."version" = (
              SELECT max(latest."version")
                FROM "QingLong3ProjectRoleBindings" AS latest
               WHERE latest."project_id" = binding."project_id"
                 AND latest."subject_type" = binding."subject_type"
                 AND latest."subject_id" = binding."subject_id"
            )`,
      )
      .get(actor.type, actor.id, projectId) as
      | Record<string, unknown>
      | undefined;
    if (
      !row ||
      row.projectStatus !== 'active' ||
      row.bindingState !== 'active' ||
      row.projectVersion !== fence.projectVersion ||
      row.bindingVersion !== fence.bindingVersion
    ) {
      throw new LocalSqliteAuthenticatedManagementFenceError();
    }
  } catch (error) {
    if (error instanceof LocalSqliteAuthenticatedManagementFenceError) {
      throw error;
    }
    throw new LocalSqliteAuthenticatedManagementFenceError();
  }
}

const AUTHENTICATED_AUDIT_SELECT = `
  "event_id" AS "eventId",
  "request_id" AS "requestId",
  "operation_id" AS "operationId",
  "project_id" AS "auditProjectId",
  "subject_type" AS "subjectType",
  "subject_id" AS "subjectId",
  "authentication_id" AS "authenticationId",
  "outcome" AS "outcome",
  "reasons_json" AS "reasonsJson",
  "fence_project_version" AS "fenceProjectVersion",
  "fence_binding_version" AS "fenceBindingVersion",
  "occurred_at_ms" AS "occurredAtMs"`;

export function commitLocalSqliteSecurityAuditInTransaction(
  authority: LocalSqliteOperationAuthority,
  audit: Readonly<SecurityAuditRecord>,
  replay: boolean,
): void {
  try {
    if (!authority.client.isTransaction) {
      throw new LocalSqliteAuthenticatedManagementFenceError();
    }
    const row = authority.client
      .prepare(
        `SELECT ${AUTHENTICATED_AUDIT_SELECT}
           FROM "QingLong3SecurityAuditEvents" WHERE "event_id" = ?`,
      )
      .get(audit.eventId) as Record<string, unknown> | undefined;
    if (replay) {
      const stored = row ? localSecurityAuditFromRow(row) : null;
      const storedWithoutTime = stored
        ? Object.freeze({ ...stored, occurredAtMs: audit.occurredAtMs })
        : null;
      if (
        !storedWithoutTime ||
        !sameSecurityAuditSemantic(storedWithoutTime, audit)
      ) {
        throw new LocalSqliteAuthenticatedManagementFenceError();
      }
      return;
    }
    if (row) throw new LocalSqliteAuthenticatedManagementFenceError();
    insertLocalSecurityAudit(authority.client, audit);
  } catch (error) {
    if (error instanceof LocalSqliteAuthenticatedManagementFenceError) {
      throw error;
    }
    throw new LocalSqliteAuthenticatedManagementFenceError();
  }
}

function confirmDefaultProjectOwnerFence(
  authority: LocalSqliteOperationAuthority,
  fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
): void {
  exactFence(fence);
  try {
    const row = authority.client
      .prepare(
        `SELECT
           project."status" AS "projectStatus",
           binding."state" AS "bindingState",
           binding."role" AS "role"
         FROM "QingLong3Projects" AS project
         JOIN "QingLong3ProjectRoleBindings" AS binding
           ON binding."project_id" = project."id"
          AND binding."subject_type" = ?
          AND binding."subject_id" = ?
         WHERE project."id" = 'default'
           AND binding."version" = (
             SELECT max(latest."version")
             FROM "QingLong3ProjectRoleBindings" AS latest
             WHERE latest."project_id" = binding."project_id"
               AND latest."subject_type" = binding."subject_type"
               AND latest."subject_id" = binding."subject_id"
           )`,
      )
      .get(fence.subjectType, fence.subjectId) as
      | Record<string, unknown>
      | undefined;
    if (
      !row ||
      row.projectStatus !== 'active' ||
      row.bindingState !== 'active' ||
      row.role !== 'owner'
    ) {
      throw new LocalSqliteAuthenticatedManagementOwnerError();
    }
  } catch (error) {
    if (error instanceof LocalSqliteAuthenticatedManagementOwnerError) {
      throw error;
    }
    throw new LocalSqliteAuthenticatedManagementOwnerError();
  }
}

export async function openLocalSqlitePluginPackageManagementDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqlitePluginPackageManagementDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    const apiCredentials = new LocalSqliteApiCredentialRepository(authority);
    const ownerPepper = new LocalSqliteOwnerPepperRepository(authority);
    const pluginPackageQuarantine =
      new LocalSqlitePluginPackageQuarantineRepository(authority, {
        activeSourceLimit:
          options.profile === 'edge'
            ? EDGE_PLUGIN_PACKAGE_QUARANTINE_ACTIVE_SOURCE_LIMIT
            : STANDALONE_PLUGIN_PACKAGE_QUARANTINE_ACTIVE_SOURCE_LIMIT,
      });
    const securityAudit = new LocalSqliteSecurityAuthorityStore(authority);
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      authority,
      apiCredentials,
      ownerPepper,
      pluginPackageQuarantine,
      securityAudit,
      confirmUserCredentialFence(
        fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
      ) {
        confirmUserCredentialFence(authority, fence);
      },
      confirmDefaultProjectOwnerFence(
        fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
      ) {
        confirmDefaultProjectOwnerFence(authority, fence);
      },
      close() {
        if (closePromise) return closePromise;
        closePromise = authority.close();
        return closePromise;
      },
    });
  } catch (error) {
    if (client.isOpen) client.close();
    throw error;
  }
}

/**
 * Opens one explicit optional-feature runtime authority without loading any
 * feature implementation. Callers must inspect their durable feature head
 * before importing the optional package and must close this authority on every
 * inactive, failed, or stopped path.
 */
export async function openLocalSqliteOptionalFeatureRuntimeDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteOptionalFeatureRuntimeDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    const securityAuthority = new LocalSqliteSecurityAuthorityStore(authority);
    const projectPolicy: ProjectPolicyRepository = Object.freeze({
      resolve: (
        ...[projectId, subject]: Parameters<ProjectPolicyRepository['resolve']>
      ) => securityAuthority.resolve(projectId, subject),
      append: (...[command]: Parameters<ProjectPolicyRepository['append']>) =>
        securityAuthority.append(command),
    });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      authority,
      apiCredentials: new LocalSqliteApiCredentialRepository(authority),
      ownerPepper: new LocalSqliteOwnerPepperRepository(authority),
      projectPolicy,
      automationPublications:
        new LocalSqlitePluginPackageAutomationPublicationRepository(authority),
      localSecrets: securityAuthority,
      securityAudit: securityAuthority,
      close() {
        if (closePromise) return closePromise;
        closePromise = authority.close();
        return closePromise;
      },
    });
  } catch (error) {
    if (client.isOpen) client.close();
    throw error;
  }
}

/**
 * Neutral names for shared short-lived authenticated management ceremonies.
 * The historical Plugin Package names remain compatible aliases.
 */
export type LocalSqliteAuthenticatedManagementDatabase =
  LocalSqlitePluginPackageManagementDatabase;
export const openLocalSqliteAuthenticatedManagementDatabase =
  openLocalSqlitePluginPackageManagementDatabase;

export {
  LocalSqliteConfigurationError,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
};
export type { LocalSqliteReadinessEvidence } from '../readiness/readiness';
