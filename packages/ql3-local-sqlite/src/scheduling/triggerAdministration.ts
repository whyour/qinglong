import type { ApiCredentialRepository } from '@qinglong/runtime-core/api-credential';
import type { LocalOwnerPepperRepository } from '@qinglong/runtime-core/local-owner-pepper';
import type { ProjectPolicyRepository } from '@qinglong/runtime-core/project-policy';
import type { SecuritySubject } from '@qinglong/runtime-core/security';
import type { SecurityAuditSink } from '@qinglong/runtime-core/security-audit';
import type { TriggerSource } from '@qinglong/runtime-core/trigger';
import {
  TriggerAdministrationAuthorizationFenceConflictError,
  TriggerAdministrationMutationConflictError,
  normalizeAuthorizedTriggerRevisionMutation,
  type AuthorizedTriggerRevisionMutation,
  type TriggerAdministrationRepository,
} from '@qinglong/runtime-core/trigger-administration';

import { LocalSqliteApiCredentialRepository } from '../security/apiCredentialRepository';
import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '../storage/config';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteOwnerPepperRepository } from '../local-owner/ownerPepperRepository';
import {
  confirmLocalSqliteAuthenticatedUserCredentialFence,
  LocalSqliteAuthenticatedManagementFenceError,
  type LocalSqliteAuthenticatedUserCredentialFence,
} from '../administration/packageManagement';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../readiness/readiness';
import {
  LOCAL_ROLE_BINDING_SELECT,
  insertLocalSecurityAudit,
  localRoleBindingFromRow,
  localSecurityAuditFromRow,
  sameSecurityAuditSemantic,
} from '../security/securityPersistence';
import { LocalSqliteSecurityAuthorityStore } from '../security/securityAuthorityStore';
import { LocalSqliteTriggerRepository } from './triggerRepository';

type Row = Record<string, unknown>;

const AUDIT_SELECT = `
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

export interface LocalSqliteTriggerAdministrationDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly apiCredentials: ApiCredentialRepository;
  readonly ownerPepper: Pick<LocalOwnerPepperRepository, 'resolveKey'>;
  readonly projectPolicy: ProjectPolicyRepository;
  readonly triggers: TriggerSource;
  readonly triggerAdministration: TriggerAdministrationRepository;
  readonly securityAudit: SecurityAuditSink;
  activateUserCredentialFence(
    fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  ): void;
  close(): Promise<void>;
}

function integer(row: Row | undefined, key: string): number {
  const value = row?.[key];
  if (!Number.isSafeInteger(value)) {
    throw new TriggerAdministrationAuthorizationFenceConflictError();
  }
  return value as number;
}

function sameCredentialFence(
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

class LocalSqliteTriggerAdministrationRepository
  implements TriggerAdministrationRepository
{
  constructor(
    private readonly authority: LocalSqliteOperationAuthority,
    private readonly triggers: LocalSqliteTriggerRepository,
    private readonly beforeMutation: (actor: Readonly<SecuritySubject>) => void,
  ) {}

  private confirmAuthorization(
    mutation: Readonly<AuthorizedTriggerRevisionMutation>,
  ): void {
    this.beforeMutation(mutation.actor);
    const client = this.authority.client;
    const project = client
      .prepare(
        `SELECT "status" AS "status", "version" AS "version"
         FROM "QingLong3Projects" WHERE "id" = ?`,
      )
      .get(mutation.command.projectId) as Row | undefined;
    const bindingRow = client
      .prepare(
        `SELECT ${LOCAL_ROLE_BINDING_SELECT}
         FROM "QingLong3ProjectRoleBindings"
         WHERE "project_id" = ? AND "subject_type" = ?
           AND "subject_id" = ?
         ORDER BY "version" DESC LIMIT 1`,
      )
      .get(
        mutation.command.projectId,
        mutation.actor.type,
        mutation.actor.id,
      ) as Row | undefined;
    if (
      !project ||
      project.status !== 'active' ||
      integer(project, 'version') !== mutation.fence.projectVersion ||
      !bindingRow
    ) {
      throw new TriggerAdministrationAuthorizationFenceConflictError();
    }
    const binding = localRoleBindingFromRow(bindingRow);
    if (
      binding.version !== mutation.fence.bindingVersion ||
      binding.state !== 'active'
    ) {
      throw new TriggerAdministrationAuthorizationFenceConflictError();
    }
  }

  appendAuthorizedTriggerRevision(input: AuthorizedTriggerRevisionMutation) {
    const mutation = normalizeAuthorizedTriggerRevisionMutation(input);
    return this.triggers.appendTriggerRevision(
      mutation.command,
      ({ replay }) => {
        this.confirmAuthorization(mutation);
        const auditRow = this.authority.client
          .prepare(
            `SELECT ${AUDIT_SELECT}
             FROM "QingLong3SecurityAuditEvents"
             WHERE "event_id" = ?`,
          )
          .get(mutation.audit.eventId) as Row | undefined;
        if (replay) {
          if (
            !auditRow ||
            !sameSecurityAuditSemantic(
              localSecurityAuditFromRow(auditRow),
              mutation.audit,
            )
          ) {
            throw new TriggerAdministrationMutationConflictError();
          }
          return;
        }
        if (auditRow) {
          throw new TriggerAdministrationMutationConflictError();
        }
        insertLocalSecurityAudit(this.authority.client, mutation.audit);
      },
    );
  }
}

export async function openLocalSqliteTriggerAdministrationDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteTriggerAdministrationDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    const securityAuthority = new LocalSqliteSecurityAuthorityStore(authority);
    const triggerRepository = new LocalSqliteTriggerRepository(authority);
    let activeFence:
      | Readonly<LocalSqliteAuthenticatedUserCredentialFence>
      | undefined;
    const projectPolicy: ProjectPolicyRepository = Object.freeze({
      resolve: (
        ...[projectId, subject]: Parameters<ProjectPolicyRepository['resolve']>
      ) => securityAuthority.resolve(projectId, subject),
      append: (...[command]: Parameters<ProjectPolicyRepository['append']>) =>
        securityAuthority.append(command),
    });
    const triggerAdministration =
      new LocalSqliteTriggerAdministrationRepository(
        authority,
        triggerRepository,
        (actor) => {
          if (
            !activeFence ||
            actor.type !== activeFence.subjectType ||
            actor.id !== activeFence.subjectId
          ) {
            throw new LocalSqliteAuthenticatedManagementFenceError();
          }
          confirmLocalSqliteAuthenticatedUserCredentialFence(
            authority,
            activeFence,
          );
        },
      );
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      apiCredentials: new LocalSqliteApiCredentialRepository(authority),
      ownerPepper: new LocalSqliteOwnerPepperRepository(authority),
      projectPolicy,
      triggers: Object.freeze({
        findCurrentTrigger:
          triggerRepository.findCurrentTrigger.bind(triggerRepository),
        findTriggerRevision:
          triggerRepository.findTriggerRevision.bind(triggerRepository),
        listTriggers: triggerRepository.listTriggers.bind(triggerRepository),
      }),
      triggerAdministration,
      securityAudit: securityAuthority,
      activateUserCredentialFence(
        fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
      ) {
        confirmLocalSqliteAuthenticatedUserCredentialFence(authority, fence);
        if (activeFence && !sameCredentialFence(activeFence, fence)) {
          throw new LocalSqliteAuthenticatedManagementFenceError();
        }
        activeFence = Object.freeze({ ...fence });
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
