// PostgreSQL Plugin Package publisher trust-transition proposal authority.
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
  createPluginPackagePublisherTrustOverlapAdditionSnapshot,
  createPluginPackagePublisherTrustRetirementSnapshot,
  normalizePluginPackagePublisherTrustSnapshot,
  type PluginPackagePublisherTrustSnapshot,
} from '@qinglong/runtime-core/plugin-package-publisher-trust';
import {
  PluginPackagePublisherTrustTransitionConflictError,
  PluginPackagePublisherTrustTransitionUnavailableError,
  normalizePluginPackagePublisherTrustTransitionProposal,
  type CreatePluginPackagePublisherTrustTransitionProposalCommand,
  type CreatePluginPackagePublisherTrustTransitionProposalResult,
  type PluginPackagePublisherTrustTransitionProposal,
  type PluginPackagePublisherTrustTransitionProposalRepository,
} from '@qinglong/runtime-core/plugin-package-publisher-trust-transition-proposal';
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

// Must stay byte-for-byte compatible with provenance and revocation mutations.
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
): PluginPackagePublisherTrustTransitionUnavailableError {
  return new PluginPackagePublisherTrustTransitionUnavailableError({
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
    error instanceof PluginPackagePublisherTrustTransitionConflictError ||
    error instanceof PluginPackagePublisherTrustTransitionUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackagePublisherTrustTransitionConflictError();
  }
  return unavailable(error);
}

function parseProposal(
  row: Row,
): Readonly<PluginPackagePublisherTrustTransitionProposal> {
  try {
    const proposal = normalizePluginPackagePublisherTrustTransitionProposal(
      postgresRequiredJsonObject(
        row.proposalJson,
        unavailable,
      ) as unknown as PluginPackagePublisherTrustTransitionProposal,
    );
    if (
      proposal.proposalDigest !==
      postgresRequiredString(row.proposalDigest, unavailable)
    ) {
      throw unavailable();
    }
    return proposal;
  } catch (error) {
    if (error instanceof PluginPackagePublisherTrustTransitionUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

function parseSnapshot(
  row: Row,
): Readonly<PluginPackagePublisherTrustSnapshot> {
  try {
    const snapshot = normalizePluginPackagePublisherTrustSnapshot(
      postgresRequiredJsonObject(
        row.snapshotJson,
        unavailable,
      ) as unknown as PluginPackagePublisherTrustSnapshot,
    );
    if (
      snapshot.snapshotDigest !==
      postgresRequiredString(row.snapshotDigest, unavailable)
    ) {
      throw unavailable();
    }
    return snapshot;
  } catch (error) {
    if (error instanceof PluginPackagePublisherTrustTransitionUnavailableError) {
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
    if (error instanceof PluginPackagePublisherTrustTransitionUnavailableError) {
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
    if (error instanceof PluginPackagePublisherTrustTransitionUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

async function proposalByActionRef(
  queryable: Queryable,
  actionRef: string,
): Promise<Readonly<PluginPackagePublisherTrustTransitionProposal> | null> {
  const result = await queryable.query<Row>(
    `SELECT proposal_json AS "proposalJson",
            proposal_digest AS "proposalDigest"
     FROM "ql3"."plugin_package_publisher_trust_transition_proposals"
     WHERE action_ref = $1
     LIMIT 2`,
    [actionRef],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseProposal(result.rows[0]!);
}

async function snapshotByDigest(
  queryable: Queryable,
  snapshotDigest: string,
): Promise<Readonly<PluginPackagePublisherTrustSnapshot> | null> {
  const result = await queryable.query<Row>(
    `SELECT snapshot_json AS "snapshotJson",
            snapshot_digest AS "snapshotDigest"
     FROM "ql3"."plugin_package_publisher_trust_snapshots"
     WHERE snapshot_digest = $1
     LIMIT 2`,
    [snapshotDigest],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseSnapshot(result.rows[0]!);
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

export function findPostgresPluginPackagePublisherTrustTransitionProposal(
  queryable: Queryable,
  actionRef: string,
): Promise<Readonly<PluginPackagePublisherTrustTransitionProposal> | null> {
  return proposalByActionRef(queryable, actionRef);
}

export class PostgresPluginPackagePublisherTrustTransitionProposalRepository
  implements PluginPackagePublisherTrustTransitionProposalRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL publisher trust transition proposal pool is invalid',
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
  ): Promise<Readonly<PluginPackagePublisherTrustTransitionProposal> | null> {
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
        'publisher trust transition approval page limit is invalid',
      );
    }
    try {
      const result = await this.pool.query<Row>(
        `SELECT request.request_json AS "requestJson",
                request.request_digest AS "requestDigest"
         FROM "ql3"."approval_requests" AS request
         JOIN "ql3"."plugin_package_publisher_trust_transition_proposals"
           AS proposal
           ON proposal.action_ref = request.action_ref
         WHERE request.state = 'approved'
           AND request.request_json ->> 'decisionMode' =
             'separation_of_duty'
           AND request.action_type IN (
             'plugin_package.publisher_key.overlap_add',
             'plugin_package.publisher_key.safe_retire'
           )
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
    command: CreatePluginPackagePublisherTrustTransitionProposalCommand,
  ): Promise<
    Readonly<CreatePluginPackagePublisherTrustTransitionProposalResult>
  > {
    const proposal =
      normalizePluginPackagePublisherTrustTransitionProposal(
        command.proposal,
      );
    const candidateSnapshot =
      normalizePluginPackagePublisherTrustSnapshot(
        command.candidateSnapshot,
      );
    const audit = normalizeSecurityAuditRecord(command.audit);
    if (
      candidateSnapshot.snapshotDigest !==
        proposal.actionInput.currentTrustDigest ||
      audit.requestId !== proposal.actionRef ||
      audit.operationId !==
        'plugin_package.publisher_trust_transition.propose' ||
      audit.projectId !== proposal.projectId ||
      audit.subject?.type !== proposal.proposedBy.type ||
      audit.subject.id !== proposal.proposedBy.id ||
      audit.authenticationId === null ||
      audit.outcome !== 'allowed' ||
      !same(audit.reasons, ['publisher_trust_transition_proposal']) ||
      audit.fence?.projectVersion !==
        proposal.proposalFence.projectVersion ||
      audit.fence.bindingVersion !==
        proposal.proposalFence.bindingVersion ||
      audit.occurredAtMs !== proposal.createdAtMs
    ) {
      throw new PluginPackagePublisherTrustTransitionConflictError();
    }
    return this.#transaction(async (client) => {
      const existing = await proposalByActionRef(
        client,
        proposal.actionRef,
      );
      if (existing) {
        const [existingAudit, existingCandidate] = await Promise.all([
          auditById(client, audit.eventId),
          snapshotByDigest(client, candidateSnapshot.snapshotDigest),
        ]);
        if (
          !same(existing, proposal) ||
          !existingAudit ||
          !same(existingAudit, audit) ||
          !existingCandidate ||
          !same(existingCandidate, candidateSnapshot)
        ) {
          throw new PluginPackagePublisherTrustTransitionConflictError();
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
        `SELECT head.generation,
                head.effective_trust_digest AS "effectiveTrustDigest",
                snapshot.snapshot_json AS "snapshotJson",
                snapshot.snapshot_digest AS "snapshotDigest"
         FROM "ql3"."plugin_package_publisher_trust_heads" AS head
         JOIN "ql3"."plugin_package_publisher_trust_snapshots" AS snapshot
           ON snapshot.snapshot_digest = head.effective_trust_digest
         WHERE head.authority_id = $1
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
        throw new PluginPackagePublisherTrustTransitionConflictError();
      }
      const effectiveSnapshot = parseSnapshot(trust.rows[0]!);
      let expectedCandidate: Readonly<PluginPackagePublisherTrustSnapshot>;
      try {
        expectedCandidate =
          proposal.actionInput.mode === 'overlap_add'
            ? createPluginPackagePublisherTrustOverlapAdditionSnapshot(
                effectiveSnapshot,
                candidateSnapshot,
                proposal.actionInput.publisher,
                proposal.actionInput.keyId,
                proposal.createdAtMs,
              )
            : createPluginPackagePublisherTrustRetirementSnapshot(
                effectiveSnapshot,
                proposal.actionInput.publisher,
                proposal.actionInput.keyId,
                proposal.createdAtMs,
              );
      } catch {
        throw new PluginPackagePublisherTrustTransitionConflictError();
      }
      if (!same(expectedCandidate, candidateSnapshot)) {
        throw new PluginPackagePublisherTrustTransitionConflictError();
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
        throw new PluginPackagePublisherTrustTransitionConflictError();
      }
      const snapshotInsert = await client.query(
        `INSERT INTO "ql3"."plugin_package_publisher_trust_snapshots" (
           snapshot_digest, key_count, observed_by, observed_at_ms,
           snapshot_json
         ) VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (snapshot_digest) DO NOTHING`,
        [
          candidateSnapshot.snapshotDigest,
          candidateSnapshot.keys.length,
          'cluster-package-manager',
          proposal.createdAtMs,
          JSON.stringify(candidateSnapshot),
        ],
      );
      if (
        snapshotInsert.rowCount !== 0 &&
        snapshotInsert.rowCount !== 1
      ) {
        throw unavailable();
      }
      const storedCandidate = await snapshotByDigest(
        client,
        candidateSnapshot.snapshotDigest,
      );
      if (!storedCandidate || !same(storedCandidate, candidateSnapshot)) {
        throw new PluginPackagePublisherTrustTransitionConflictError();
      }
      const action = proposal.actionInput;
      const inserted = await client.query(
        `INSERT INTO
           "ql3"."plugin_package_publisher_trust_transition_proposals" (
             action_ref, project_id, authority_id, trust_generation, mode,
             publisher, key_id, previous_trust_digest,
             current_trust_digest, action_type, permission, action_digest,
             preview_digest, proposed_by_type, proposed_by_id,
             proposer_assurance, fence_project_version,
             fence_binding_version, created_at_ms, proposal_json,
             proposal_digest
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $19, $20::jsonb, $21
           )`,
        [
          proposal.actionRef,
          proposal.projectId,
          action.trustAuthorityId,
          action.trustGeneration,
          action.mode,
          action.publisher,
          action.keyId,
          action.previousTrustDigest,
          action.currentTrustDigest,
          proposal.actionType,
          proposal.permission,
          proposal.actionDigest,
          proposal.previewDigest,
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
