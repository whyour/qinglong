import type { ApiCredentialRepository } from '@qinglong/runtime-core/api-credential';
import {
  LocalSecurityAuditQueryAuthorizationFenceConflictError,
  LocalSecurityAuditQueryUnavailableError,
  MAX_LOCAL_SECURITY_AUDIT_QUERY_PAGE_SIZE,
  type ListAuthorizedLocalSecurityAuditCommand,
  type ListAuthorizedLocalSecurityAuditResult,
  type LocalSecurityAuditQueryAuthorization,
  type LocalSecurityAuditQueryRepository,
} from '@qinglong/runtime-core/local-security-audit-query';
import type { LocalOwnerPepperRepository } from '@qinglong/runtime-core/local-owner-pepper';
import {
  MAX_EDGE_SECURITY_AUDIT_COMPACTION_BATCH_SIZE,
  MAX_STANDALONE_SECURITY_AUDIT_COMPACTION_BATCH_SIZE,
  type LocalSecurityAuditRetentionRepository,
} from '@qinglong/runtime-core/local-security-audit-retention';
import {
  InvalidProjectPolicyValueError,
  assertProjectPolicyProjectId,
  type ProjectPolicyRepository,
} from '@qinglong/runtime-core/project-policy';
import {
  SecurityAuditUnavailableError,
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';
import {
  InvalidSecurityAuditQueryError,
  normalizeSecurityAuditQuery,
} from '@qinglong/runtime-core/security-audit-query';

import { LocalSqliteApiCredentialRepository } from './apiCredentialRepository';
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
  assertLocalSecurityAuditInstanceOwnerInTransaction,
  normalizeLocalSecurityAuditInstanceAuthorization,
  sameLocalSqliteAuthenticatedUserCredentialFence,
} from './securityAuditAuthority';
import { LocalSqliteSecurityAuditRetentionRepository } from './securityAuditRetention';
import {
  insertLocalSecurityAudit,
  LOCAL_SECURITY_AUDIT_SELECT,
  localSecurityAuditFromRow,
} from './securityPersistence';
import { LocalSqliteSecurityAuthorityStore } from './securityAuthorityStore';

type Row = Record<string, unknown>;

function allowedAudit(
  value: SecurityAuditRecord,
  authority: Readonly<LocalSecurityAuditQueryAuthorization>,
): Readonly<SecurityAuditRecord> {
  const audit = normalizeSecurityAuditRecord(value);
  if (
    audit.operationId !== 'security.audit.list' ||
    audit.projectId !== authority.authorityProjectId ||
    audit.subject?.type !== authority.actor.type ||
    audit.subject.id !== authority.actor.id ||
    audit.outcome !== 'allowed' ||
    audit.fence?.projectVersion !== authority.fence.projectVersion ||
    audit.fence.bindingVersion !== authority.fence.bindingVersion
  ) {
    throw new InvalidProjectPolicyValueError(
      'Local security audit query audit is invalid',
    );
  }
  return audit;
}

export class LocalSqliteSecurityAuditQueryRepository
  implements LocalSecurityAuditQueryRepository
{
  constructor(
    private readonly authority: LocalSqliteOperationAuthority,
    private readonly beforeQuery: () => void,
  ) {
    if (
      !(authority instanceof LocalSqliteOperationAuthority) ||
      typeof beforeQuery !== 'function'
    ) {
      throw new TypeError(
        'Local SQLite security audit query dependencies are invalid',
      );
    }
  }

  record(value: SecurityAuditRecord): Promise<void> {
    return new LocalSqliteSecurityAuthorityStore(this.authority).record(value);
  }

  listAuthorized(
    input: ListAuthorizedLocalSecurityAuditCommand,
  ): Promise<ListAuthorizedLocalSecurityAuditResult> {
    const query = normalizeSecurityAuditQuery(input.query);
    if (query.limit > MAX_LOCAL_SECURITY_AUDIT_QUERY_PAGE_SIZE) {
      throw new InvalidSecurityAuditQueryError('local query limit exceeds 64');
    }
    const authorityInput = normalizeLocalSecurityAuditInstanceAuthorization(
      input.authorization,
    );
    const audit = allowedAudit(input.audit, authorityInput);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        client.exec('BEGIN IMMEDIATE');
        try {
          assertLocalSecurityAuditInstanceOwnerInTransaction(
            this.authority,
            authorityInput,
            this.beforeQuery,
            () => new LocalSecurityAuditQueryAuthorizationFenceConflictError(),
          );
          const subject = query.filter.subject;
          const before = query.before;
          const rows = client
            .prepare(
              `SELECT ${LOCAL_SECURITY_AUDIT_SELECT}
               FROM "QingLong3SecurityAuditEvents"
               WHERE (? IS NULL OR "project_id" = ?)
                 AND (? IS NULL OR "subject_type" = ?)
                 AND (? IS NULL OR "subject_id" = ?)
                 AND (? IS NULL OR "outcome" = ?)
                 AND (
                   ? IS NULL OR "occurred_at_ms" < ?
                   OR ("occurred_at_ms" = ? AND "event_id" < ?)
                 )
               ORDER BY "occurred_at_ms" DESC, "event_id" DESC
               LIMIT ?`,
            )
            .all(
              query.filter.projectId ?? null,
              query.filter.projectId ?? null,
              subject?.type ?? null,
              subject?.type ?? null,
              subject?.id ?? null,
              subject?.id ?? null,
              query.filter.outcome ?? null,
              query.filter.outcome ?? null,
              before?.occurredAtMs ?? null,
              before?.occurredAtMs ?? null,
              before?.occurredAtMs ?? null,
              before?.eventId ?? null,
              query.limit + 1,
            ) as Row[];
          const hasMore = rows.length > query.limit;
          const records = Object.freeze(
            rows
              .slice(0, query.limit)
              .map((row) => localSecurityAuditFromRow(row)),
          );
          const last = records.at(-1);
          insertLocalSecurityAudit(client, audit);
          client.exec('COMMIT');
          return Object.freeze({
            records,
            nextCursor:
              hasMore && last
                ? Object.freeze({
                    occurredAtMs: last.occurredAtMs,
                    eventId: last.eventId,
                  })
                : null,
            audit,
          });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (
            error instanceof
              LocalSecurityAuditQueryAuthorizationFenceConflictError ||
            error instanceof InvalidSecurityAuditQueryError ||
            error instanceof InvalidProjectPolicyValueError ||
            error instanceof SecurityAuditUnavailableError
          ) {
            throw error;
          }
          throw new LocalSecurityAuditQueryUnavailableError();
        }
      },
      () => new LocalSecurityAuditQueryUnavailableError(),
    );
  }
}

export interface LocalSqliteSecurityAuditQueryDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly apiCredentials: ApiCredentialRepository;
  readonly ownerPepper: Pick<LocalOwnerPepperRepository, 'resolveKey'>;
  readonly projectPolicy: ProjectPolicyRepository;
  readonly securityAuditQuery: LocalSecurityAuditQueryRepository;
  readonly securityAuditRetention: LocalSecurityAuditRetentionRepository;
  readonly securityAudit: SecurityAuditSink;
  activateUserCredentialFence(
    fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  ): void;
  close(): Promise<void>;
}

export async function openLocalSqliteSecurityAuditQueryDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteSecurityAuditQueryDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    const securityAuthority = new LocalSqliteSecurityAuthorityStore(authority);
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
    const confirmFence = () => {
      if (!activeFence) {
        throw new LocalSqliteAuthenticatedManagementFenceError();
      }
      confirmLocalSqliteAuthenticatedUserCredentialFence(
        authority,
        activeFence,
      );
    };
    const securityAuditQuery = new LocalSqliteSecurityAuditQueryRepository(
      authority,
      confirmFence,
    );
    const securityAuditRetention =
      new LocalSqliteSecurityAuditRetentionRepository(
        authority,
        confirmFence,
        options.profile === 'edge'
          ? MAX_EDGE_SECURITY_AUDIT_COMPACTION_BATCH_SIZE
          : MAX_STANDALONE_SECURITY_AUDIT_COMPACTION_BATCH_SIZE,
      );
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      apiCredentials: new LocalSqliteApiCredentialRepository(authority),
      ownerPepper: new LocalSqliteOwnerPepperRepository(authority),
      projectPolicy,
      securityAuditQuery,
      securityAuditRetention,
      securityAudit: securityAuthority,
      activateUserCredentialFence(
        fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
      ) {
        confirmLocalSqliteAuthenticatedUserCredentialFence(authority, fence);
        if (
          activeFence &&
          !sameLocalSqliteAuthenticatedUserCredentialFence(activeFence, fence)
        ) {
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
