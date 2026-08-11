// PostgreSQL Plugin Package publisher revocation proposal authority.
import type {
  PostgresClient,
  PostgresPool,
} from '@qinglong/runtime-core';
import {
  approvalRequestDigest,
  normalizeApprovalRequestRecord,
  type ApprovalRequestRecord,
} from '@qinglong/runtime-core/approved-action';
import {
  PluginPackagePublisherRevocationProposalConflictError,
  PluginPackagePublisherRevocationProposalUnavailableError,
  normalizePluginPackagePublisherRevocationProposal,
  type CreatePluginPackagePublisherRevocationProposalCommand,
  type CreatePluginPackagePublisherRevocationProposalResult,
  type PluginPackagePublisherRevocationProposal,
  type PluginPackagePublisherRevocationProposalRepository,
} from '@qinglong/runtime-core/plugin-package-publisher-revocation-proposal';
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
// Must stay byte-for-byte compatible with publisher provenance mutations.
const SIGNER_ADVISORY_LOCK_SEED = 774635229;

async function publisherSignerLock(
  queryable: Queryable,
  publisher: string,
  keyId: string,
): Promise<void> {
  await queryable.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`,
    [JSON.stringify([publisher, keyId]), SIGNER_ADVISORY_LOCK_SEED],
  );
}

function unavailable(
  cause?: unknown,
): PluginPackagePublisherRevocationProposalUnavailableError {
  return new PluginPackagePublisherRevocationProposalUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
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

function mappedError(error: unknown): Error {
  if (
    error instanceof PluginPackagePublisherRevocationProposalConflictError ||
    error instanceof PluginPackagePublisherRevocationProposalUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackagePublisherRevocationProposalConflictError();
  }
  return unavailable(error);
}

function parseProposal(
  row: Row,
): Readonly<PluginPackagePublisherRevocationProposal> {
  try {
    const proposal = normalizePluginPackagePublisherRevocationProposal(
      postgresRequiredJsonObject(
        row.proposalJson,
        unavailable,
      ) as unknown as PluginPackagePublisherRevocationProposal,
    );
    if (
      proposal.proposalDigest !==
      postgresRequiredString(row.proposalDigest, unavailable)
    ) {
      throw unavailable();
    }
    return proposal;
  } catch (error) {
    if (
      error instanceof
      PluginPackagePublisherRevocationProposalUnavailableError
    ) {
      throw error;
    }
    throw unavailable(error);
  }
}

function parseApprovalRequest(
  row: Row,
): Readonly<ApprovalRequestRecord> {
  try {
    const request = normalizeApprovalRequestRecord(
      postgresRequiredJsonObject(
        row.requestJson,
        unavailable,
      ) as unknown as ApprovalRequestRecord,
    );
    if (
      approvalRequestDigest(request) !==
      postgresRequiredString(row.requestDigest, unavailable)
    ) {
      throw unavailable();
    }
    return request;
  } catch (error) {
    if (
      error instanceof
      PluginPackagePublisherRevocationProposalUnavailableError
    ) {
      throw error;
    }
    throw unavailable(error);
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
    if (
      error instanceof
      PluginPackagePublisherRevocationProposalUnavailableError
    ) {
      throw error;
    }
    throw unavailable(error);
  }
}

async function proposalByActionRef(
  queryable: Queryable,
  actionRef: string,
): Promise<Readonly<PluginPackagePublisherRevocationProposal> | null> {
  const result = await queryable.query<Row>(
    `SELECT proposal_json AS "proposalJson",
            proposal_digest AS "proposalDigest"
     FROM "ql3"."plugin_package_publisher_revocation_proposals"
     WHERE action_ref = $1
     LIMIT 2`,
    [actionRef],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseProposal(result.rows[0]!);
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

export function findPostgresPluginPackagePublisherRevocationProposal(
  queryable: Queryable,
  actionRef: string,
): Promise<Readonly<PluginPackagePublisherRevocationProposal> | null> {
  return proposalByActionRef(queryable, actionRef);
}

export class PostgresPluginPackagePublisherRevocationProposalRepository
  implements PluginPackagePublisherRevocationProposalRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL publisher revocation proposal pool is invalid',
      );
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
  ): Promise<Readonly<PluginPackagePublisherRevocationProposal> | null> {
    try {
      return await proposalByActionRef(this.pool, actionRef);
    } catch (error) {
      throw mappedError(error);
    }
  }

  async listApprovedRequests(
    limitValue: number,
  ): Promise<readonly Readonly<ApprovalRequestRecord>[]> {
    if (
      !Number.isSafeInteger(limitValue) ||
      limitValue < 1 ||
      limitValue > 64
    ) {
      throw new TypeError(
        'publisher revocation approval page limit is invalid',
      );
    }
    try {
      const result = await this.pool.query<Row>(
        `SELECT request.request_json AS "requestJson",
                request.request_digest AS "requestDigest"
         FROM "ql3"."approval_requests" AS request
         JOIN "ql3"."plugin_package_publisher_revocation_proposals"
           AS proposal
           ON proposal.action_ref = request.action_ref
         WHERE request.state = 'approved'
           AND request.action_type =
             'plugin_package.publisher_key.revoke'
         ORDER BY request.updated_at_ms, request.request_id
         LIMIT $1`,
        [limitValue],
      );
      if (result.rows.length > limitValue) throw unavailable();
      return Object.freeze(result.rows.map(parseApprovalRequest));
    } catch (error) {
      throw mappedError(error);
    }
  }

  createProposal(
    command: CreatePluginPackagePublisherRevocationProposalCommand,
  ): Promise<
    Readonly<CreatePluginPackagePublisherRevocationProposalResult>
  > {
    const proposal = normalizePluginPackagePublisherRevocationProposal(
      command.proposal,
    );
    const audit = normalizeSecurityAuditRecord(command.audit);
    if (
      audit.requestId !== proposal.actionRef ||
      audit.operationId !==
        'plugin_package.publisher_revocation.propose' ||
      audit.projectId !== proposal.projectId ||
      audit.subject?.type !== proposal.proposedBy.type ||
      audit.subject.id !== proposal.proposedBy.id ||
      audit.authenticationId === null ||
      audit.outcome !== 'allowed' ||
      !same(audit.reasons, ['publisher_revocation_proposal']) ||
      audit.fence?.projectVersion !==
        proposal.proposalFence.projectVersion ||
      audit.fence.bindingVersion !==
        proposal.proposalFence.bindingVersion ||
      audit.occurredAtMs !== proposal.createdAtMs
    ) {
      throw new PluginPackagePublisherRevocationProposalConflictError();
    }
    return this.#transaction(async (client) => {
      const existing = await proposalByActionRef(
        client,
        proposal.actionRef,
      );
      if (existing) {
        const existingAudit = await auditById(client, audit.eventId);
        if (
          !same(existing, proposal) ||
          !existingAudit ||
          !same(existingAudit, audit)
        ) {
          throw new PluginPackagePublisherRevocationProposalConflictError();
        }
        return Object.freeze({
          status: 'existing' as const,
          proposal,
        });
      }
      await publisherSignerLock(
        client,
        proposal.actionInput.publisher,
        proposal.actionInput.keyId,
      );
      const trust = await client.query<Row>(
        `SELECT generation,
                effective_trust_digest AS "effectiveTrustDigest"
         FROM "ql3"."plugin_package_publisher_trust_heads"
         WHERE authority_id = $1
         LIMIT 2`,
        [proposal.actionInput.trustAuthorityId],
      );
      if (
        trust.rows.length !== 1 ||
        postgresRequiredInteger(
          trust.rows[0]!.generation,
          unavailable,
        ) !== proposal.actionInput.trustGeneration ||
        postgresRequiredString(
          trust.rows[0]!.effectiveTrustDigest,
          unavailable,
        ) !== proposal.actionInput.previousTrustDigest
      ) {
        throw new PluginPackagePublisherRevocationProposalConflictError();
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
        throw new PluginPackagePublisherRevocationProposalConflictError();
      }
      const action = proposal.actionInput;
      const inserted = await client.query(
        `INSERT INTO
           "ql3"."plugin_package_publisher_revocation_proposals" (
             action_ref, project_id, authority_id, trust_generation,
             publisher, key_id, previous_trust_digest,
             current_trust_digest, action_type, permission, action_digest,
             preview_digest, authorization_mode, reason_code,
             proposed_by_type, proposed_by_id, proposer_assurance,
             fence_project_version, fence_binding_version, created_at_ms,
             proposal_json, proposal_digest
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22
           )`,
        [
          proposal.actionRef,
          proposal.projectId,
          action.trustAuthorityId,
          action.trustGeneration,
          action.publisher,
          action.keyId,
          action.previousTrustDigest,
          action.currentTrustDigest,
          proposal.actionType,
          proposal.permission,
          proposal.actionDigest,
          proposal.previewDigest,
          action.authorizationMode,
          action.reasonCode,
          proposal.proposedBy.type,
          proposal.proposedBy.id,
          proposal.proposerAssurance,
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
