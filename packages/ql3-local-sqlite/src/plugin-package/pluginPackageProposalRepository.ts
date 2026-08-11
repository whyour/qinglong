import type { DatabaseSync } from 'node:sqlite';

import {
  PluginPackageInstallProposalConflictError,
  PluginPackageInstallProposalUnavailableError,
  normalizePluginPackageInstallProposal,
  type CreatePluginPackageInstallProposalCommand,
  type CreatePluginPackageInstallProposalResult,
  type PluginPackageInstallProposal,
  type PluginPackageInstallProposalRepository,
} from '@qinglong/runtime-core/plugin-package-proposal';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new PluginPackageInstallProposalUnavailableError();
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== 'string') {
    throw new PluginPackageInstallProposalUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) {
    throw new PluginPackageInstallProposalUnavailableError();
  }
  return value as number;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && !Number.isSafeInteger(value)) {
    throw new PluginPackageInstallProposalUnavailableError();
  }
  return value as number | null;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseProposal(row: Row): Readonly<PluginPackageInstallProposal> {
  try {
    const proposal = normalizePluginPackageInstallProposal(
      JSON.parse(text(row, 'proposalJson')) as PluginPackageInstallProposal,
    );
    if (proposal.proposalDigest !== text(row, 'proposalDigest')) {
      throw new PluginPackageInstallProposalUnavailableError();
    }
    return proposal;
  } catch (error) {
    if (error instanceof PluginPackageInstallProposalUnavailableError) {
      throw error;
    }
    throw new PluginPackageInstallProposalUnavailableError();
  }
}

export function findLocalPluginPackageInstallProposal(
  client: DatabaseSync,
  actionRef: string,
): Readonly<PluginPackageInstallProposal> | null {
  const row = client
    .prepare(
      `SELECT "proposal_json" AS "proposalJson",
              "proposal_digest" AS "proposalDigest"
       FROM "QingLong3PluginPackageInstallProposals"
       WHERE "action_ref" = ?`,
    )
    .get(actionRef) as Row | undefined;
  return row ? parseProposal(row) : null;
}

function parseAudit(row: Row): Readonly<SecurityAuditRecord> {
  try {
    const subjectType = nullableText(row, 'subjectType');
    const subjectId = nullableText(row, 'subjectId');
    const projectVersion = nullableInteger(row, 'projectVersion');
    return normalizeSecurityAuditRecord({
      eventId: text(row, 'eventId'),
      requestId: text(row, 'requestId'),
      operationId: text(row, 'operationId'),
      projectId: nullableText(row, 'projectId'),
      subject:
        subjectType === null || subjectId === null
          ? null
          : { type: subjectType, id: subjectId },
      authenticationId: nullableText(row, 'authenticationId'),
      outcome: text(row, 'outcome'),
      reasons: JSON.parse(text(row, 'reasonsJson')),
      fence:
        projectVersion === null
          ? null
          : {
              projectVersion,
              bindingVersion: nullableInteger(row, 'bindingVersion'),
            },
      occurredAtMs: integer(row, 'occurredAtMs'),
    } as SecurityAuditRecord);
  } catch (error) {
    if (error instanceof PluginPackageInstallProposalUnavailableError) {
      throw error;
    }
    throw new PluginPackageInstallProposalUnavailableError();
  }
}

function storageError(error: unknown): Error {
  if (
    error instanceof PluginPackageInstallProposalConflictError ||
    error instanceof PluginPackageInstallProposalUnavailableError
  ) {
    return error;
  }
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  ) {
    return new PluginPackageInstallProposalConflictError();
  }
  return new PluginPackageInstallProposalUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export class LocalSqlitePluginPackageInstallProposalRepository
  implements PluginPackageInstallProposalRepository
{
  readonly #authority: LocalSqliteOperationAuthority;
  readonly #client: DatabaseSync;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.#authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
    this.#client = this.#authority.client;
  }

  #enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    return this.#authority.enqueue(
      async () => {
        try {
          return await work();
        } catch (error) {
          throw storageError(error);
        }
      },
      () => new PluginPackageInstallProposalUnavailableError(),
    );
  }

  #proposal(actionRef: string): Readonly<PluginPackageInstallProposal> | null {
    return findLocalPluginPackageInstallProposal(this.#client, actionRef);
  }

  #audit(eventId: string): Readonly<SecurityAuditRecord> | null {
    const row = this.#client
      .prepare(
        `SELECT "event_id" AS "eventId", "request_id" AS "requestId",
                "operation_id" AS "operationId", "project_id" AS "projectId",
                "subject_type" AS "subjectType", "subject_id" AS "subjectId",
                "authentication_id" AS "authenticationId",
                "outcome" AS "outcome", "reasons_json" AS "reasonsJson",
                "fence_project_version" AS "projectVersion",
                "fence_binding_version" AS "bindingVersion",
                "occurred_at_ms" AS "occurredAtMs"
         FROM "QingLong3SecurityAuditEvents"
         WHERE "event_id" = ?`,
      )
      .get(eventId) as Row | undefined;
    return row ? parseAudit(row) : null;
  }

  findProposalByActionRef(
    actionRef: string,
  ): Promise<Readonly<PluginPackageInstallProposal> | null> {
    return this.#enqueue(() => this.#proposal(actionRef));
  }

  createProposal(
    command: CreatePluginPackageInstallProposalCommand,
  ): Promise<Readonly<CreatePluginPackageInstallProposalResult>> {
    const proposal = normalizePluginPackageInstallProposal(command.proposal);
    const audit = normalizeSecurityAuditRecord(command.audit);
    return this.#enqueue(() => {
      this.#client.exec('BEGIN IMMEDIATE');
      try {
        if (
          audit.requestId !== proposal.actionRef ||
          audit.operationId !== 'plugin_package.propose' ||
          audit.projectId !== proposal.projectId ||
          audit.subject?.type !== proposal.proposedBy.type ||
          audit.subject.id !== proposal.proposedBy.id ||
          audit.authenticationId === null ||
          audit.outcome !== 'allowed' ||
          !same(audit.reasons, ['package_proposal']) ||
          audit.fence?.projectVersion !==
            proposal.proposalFence.projectVersion ||
          audit.fence.bindingVersion !==
            proposal.proposalFence.bindingVersion ||
          audit.occurredAtMs !== proposal.createdAtMs
        ) {
          throw new PluginPackageInstallProposalConflictError();
        }
        const existing = this.#proposal(proposal.actionRef);
        if (existing) {
          const existingAudit = this.#audit(audit.eventId);
          if (
            !same(existing, proposal) ||
            !existingAudit ||
            !same(existingAudit, audit)
          ) {
            throw new PluginPackageInstallProposalConflictError();
          }
          this.#client.exec('COMMIT');
          return Object.freeze({
            status: 'existing' as const,
            proposal,
          });
        }
        const fence = this.#client
          .prepare(
            `SELECT project."status" AS "status",
                    project."version" AS "projectVersion",
                    (
                      SELECT max(binding."version")
                      FROM "QingLong3ProjectRoleBindings" AS binding
                      WHERE binding."project_id" = project."id"
                        AND binding."subject_type" = ?
                        AND binding."subject_id" = ?
                    ) AS "bindingVersion"
             FROM "QingLong3Projects" AS project
             WHERE project."id" = ?`,
          )
          .get(
            proposal.proposedBy.type,
            proposal.proposedBy.id,
            proposal.projectId,
          ) as Row | undefined;
        if (
          !fence ||
          fence.status !== 'active' ||
          integer(fence, 'projectVersion') !==
            proposal.proposalFence.projectVersion ||
          nullableInteger(fence, 'bindingVersion') !==
            proposal.proposalFence.bindingVersion
        ) {
          throw new PluginPackageInstallProposalConflictError();
        }
        this.#client
          .prepare(
            `INSERT INTO "QingLong3PluginPackageInstallProposals" (
               "action_ref", "project_id", "action_type", "permission",
               "action_digest", "preview_digest", "proposed_by_type",
               "proposed_by_id", "fence_project_version",
               "fence_binding_version", "created_at_ms", "proposal_json",
               "proposal_digest"
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            proposal.actionRef,
            proposal.projectId,
            proposal.actionType,
            proposal.permission,
            proposal.actionDigest,
            proposal.previewDigest,
            proposal.proposedBy.type,
            proposal.proposedBy.id,
            proposal.proposalFence.projectVersion,
            proposal.proposalFence.bindingVersion,
            proposal.createdAtMs,
            JSON.stringify(proposal),
            proposal.proposalDigest,
          );
        this.#client
          .prepare(
            `INSERT INTO "QingLong3SecurityAuditEvents" (
               "event_id", "request_id", "operation_id", "project_id",
               "subject_type", "subject_id", "authentication_id", "outcome",
               "reasons_json", "fence_project_version",
               "fence_binding_version", "occurred_at_ms"
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            audit.eventId,
            audit.requestId,
            audit.operationId,
            audit.projectId,
            audit.subject?.type ?? null,
            audit.subject?.id ?? null,
            audit.authenticationId,
            audit.outcome,
            JSON.stringify(audit.reasons),
            audit.fence?.projectVersion ?? null,
            audit.fence?.bindingVersion ?? null,
            audit.occurredAtMs,
          );
        this.#client.exec('COMMIT');
        return Object.freeze({ status: 'created' as const, proposal });
      } catch (error) {
        if (this.#client.isTransaction) this.#client.exec('ROLLBACK');
        throw error;
      }
    });
  }
}
