// PostgreSQL review proposal authority for Plugin Package installation.
import type {
  PostgresClient,
  PostgresPool,
} from '@qinglong/runtime-core';
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

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredBoolean,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

function unavailable(): PluginPackageInstallProposalUnavailableError {
  return new PluginPackageInstallProposalUnavailableError();
}

function nullableString(value: unknown): string | null {
  return value === null ? null : postgresRequiredString(value, unavailable);
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : postgresRequiredInteger(value, unavailable);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseProposal(row: Row): Readonly<PluginPackageInstallProposal> {
  try {
    const proposal = normalizePluginPackageInstallProposal(
      postgresRequiredJsonObject(
        row.proposalJson,
        unavailable,
      ) as unknown as PluginPackageInstallProposal,
    );
    if (
      proposal.proposalDigest !==
      postgresRequiredString(row.proposalDigest, unavailable)
    ) {
      throw unavailable();
    }
    return proposal;
  } catch (error) {
    if (error instanceof PluginPackageInstallProposalUnavailableError) {
      throw error;
    }
    throw unavailable();
  }
}

function parseAudit(row: Row): Readonly<SecurityAuditRecord> {
  try {
    const subjectType = nullableString(row.subjectType);
    const subjectId = nullableString(row.subjectId);
    const projectVersion = nullableInteger(row.projectVersion);
    if (!Array.isArray(row.reasons)) throw unavailable();
    return normalizeSecurityAuditRecord({
      eventId: postgresRequiredString(row.eventId, unavailable),
      requestId: postgresRequiredString(row.requestId, unavailable),
      operationId: postgresRequiredString(row.operationId, unavailable),
      projectId: nullableString(row.projectId),
      subject:
        subjectType === null || subjectId === null
          ? null
          : { type: subjectType, id: subjectId },
      authenticationId: nullableString(row.authenticationId),
      outcome: postgresRequiredString(row.outcome, unavailable),
      reasons: row.reasons,
      fence:
        projectVersion === null
          ? null
          : {
              projectVersion,
              bindingVersion: nullableInteger(row.bindingVersion),
            },
      occurredAtMs: postgresRequiredInteger(row.occurredAtMs, unavailable),
    } as SecurityAuditRecord);
  } catch (error) {
    if (error instanceof PluginPackageInstallProposalUnavailableError) {
      throw error;
    }
    throw unavailable();
  }
}

function mappedError(error: unknown): Error {
  if (
    error instanceof PluginPackageInstallProposalConflictError ||
    error instanceof PluginPackageInstallProposalUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackageInstallProposalConflictError();
  }
  return new PluginPackageInstallProposalUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

async function proposalByActionRef(
  queryable: Queryable,
  actionRef: string,
): Promise<Readonly<PluginPackageInstallProposal> | null> {
  const result = await queryable.query<Row>(
    `SELECT proposal_json AS "proposalJson",
            proposal_digest AS "proposalDigest"
     FROM "ql3"."plugin_package_install_proposals"
     WHERE action_ref = $1
     LIMIT 2`,
    [actionRef],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseProposal(result.rows[0]!);
}

export function findPostgresPluginPackageInstallProposal(
  queryable: Queryable,
  actionRef: string,
): Promise<Readonly<PluginPackageInstallProposal> | null> {
  return proposalByActionRef(queryable, actionRef);
}

async function auditById(
  queryable: Queryable,
  eventId: string,
): Promise<Readonly<SecurityAuditRecord> | null> {
  const result = await queryable.query<Row>(
    `SELECT event_id AS "eventId", request_id AS "requestId",
            operation_id AS "operationId", project_id AS "projectId",
            subject_type AS "subjectType", subject_id AS "subjectId",
            authentication_id AS "authenticationId", outcome,
            reasons, project_version AS "projectVersion",
            binding_version AS "bindingVersion",
            occurred_at_ms AS "occurredAtMs"
     FROM "ql3"."security_audit_events"
     WHERE event_id = $1
     LIMIT 2`,
    [eventId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseAudit(result.rows[0]!);
}

export class PostgresPluginPackageInstallProposalRepository
  implements PluginPackageInstallProposalRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError('PostgreSQL Package proposal pool is invalid');
    }
  }

  async #transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        throw mappedError(error);
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const result = await work(client);
        await client.query('COMMIT');
        began = false;
        return result;
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          state &&
          POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) &&
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        throw mappedError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }

  async findProposalByActionRef(
    actionRef: string,
  ): Promise<Readonly<PluginPackageInstallProposal> | null> {
    try {
      return await proposalByActionRef(this.pool, actionRef);
    } catch (error) {
      throw mappedError(error);
    }
  }

  createProposal(
    command: CreatePluginPackageInstallProposalCommand,
  ): Promise<Readonly<CreatePluginPackageInstallProposalResult>> {
    const proposal = normalizePluginPackageInstallProposal(command.proposal);
    const audit = normalizeSecurityAuditRecord(command.audit);
    if (
      audit.requestId !== proposal.actionRef ||
      audit.operationId !== 'plugin_package.propose' ||
      audit.projectId !== proposal.projectId ||
      audit.subject?.type !== proposal.proposedBy.type ||
      audit.subject.id !== proposal.proposedBy.id ||
      audit.authenticationId === null ||
      audit.outcome !== 'allowed' ||
      !same(audit.reasons, ['package_proposal']) ||
      audit.fence?.projectVersion !== proposal.proposalFence.projectVersion ||
      audit.fence.bindingVersion !== proposal.proposalFence.bindingVersion ||
      audit.occurredAtMs !== proposal.createdAtMs
    ) {
      throw new PluginPackageInstallProposalConflictError();
    }
    return this.#transaction(async (client) => {
      const existing = await proposalByActionRef(client, proposal.actionRef);
      if (existing) {
        const existingAudit = await auditById(client, audit.eventId);
        if (
          !same(existing, proposal) ||
          !existingAudit ||
          !same(existingAudit, audit)
        ) {
          throw new PluginPackageInstallProposalConflictError();
        }
        return Object.freeze({
          status: 'existing' as const,
          proposal,
        });
      }
      const fence = await client.query<Row>(
        `SELECT "ql3"."lock_approval_policy_fence"(
           $1::varchar, $2::varchar, $3::varchar, $4::integer, $5::integer
         ) AS "matches"`,
        [
          proposal.projectId,
          proposal.proposedBy.type,
          proposal.proposedBy.id,
          proposal.proposalFence.projectVersion,
          proposal.proposalFence.bindingVersion,
        ],
      );
      if (
        fence.rows.length !== 1 ||
        !postgresRequiredBoolean(fence.rows[0]!.matches, unavailable)
      ) {
        throw new PluginPackageInstallProposalConflictError();
      }
      const inserted = await client.query(
        `INSERT INTO "ql3"."plugin_package_install_proposals" (
           action_ref, project_id, action_type, permission, action_digest,
           preview_digest, proposed_by_type, proposed_by_id,
           fence_project_version, fence_binding_version, created_at_ms,
           proposal_json, proposal_digest
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13
         )`,
        [
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
        ],
      );
      if (inserted.rowCount !== 1) throw unavailable();
      const auditInserted = await client.query(
        `INSERT INTO "ql3"."security_audit_events" (
           event_id, request_id, operation_id, project_id, subject_type,
           subject_id, authentication_id, outcome, reasons,
           project_version, binding_version, occurred_at_ms
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12
         )`,
        [
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
        ],
      );
      if (auditInserted.rowCount !== 1) throw unavailable();
      return Object.freeze({ status: 'created' as const, proposal });
    });
  }
}
