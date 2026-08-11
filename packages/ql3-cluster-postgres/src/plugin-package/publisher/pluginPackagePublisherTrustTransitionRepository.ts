// PostgreSQL Plugin Package publisher trust-transition execution authority.
import type {
  PostgresClient,
  PostgresPool,
} from '@qinglong/runtime-core';
import {
  approvalRequestDigest,
  approvedActionDispatchDigest,
  normalizeApprovalRequestRecord,
  normalizeApprovedActionDispatchRecord,
  type ApprovalRequestRecord,
  type ApprovedActionDispatchRecord,
} from '@qinglong/runtime-core/approved-action';
import {
  advancePluginPackagePublisherTrustHead,
  createPluginPackagePublisherTrustOverlapAdditionSnapshot,
  createPluginPackagePublisherTrustRetirementSnapshot,
  normalizePluginPackagePublisherTrustHead,
  normalizePluginPackagePublisherTrustSnapshot,
  type PluginPackagePublisherTrustHead,
  type PluginPackagePublisherTrustSnapshot,
} from '@qinglong/runtime-core/plugin-package-publisher-trust';
import {
  PluginPackagePublisherTrustTransitionConflictError,
  PluginPackagePublisherTrustTransitionUnavailableError,
  normalizePluginPackagePublisherTrustTransitionProposal,
  normalizePluginPackagePublisherTrustTransitionReceipt,
  resolvePluginPackagePublisherTrustTransitionProposal,
  type PluginPackagePublisherTrustTransitionProposal,
  type PluginPackagePublisherTrustTransitionReceipt,
} from '@qinglong/runtime-core/plugin-package-publisher-trust-transition-proposal';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

const SIGNER_ADVISORY_LOCK_SEED = 774635229;

export interface ApplyPostgresPluginPackagePublisherTrustTransitionInput {
  readonly dispatch: ApprovedActionDispatchRecord;
  readonly executedAtMs: number;
}

export interface ApplyPostgresPluginPackagePublisherTrustTransitionResult {
  readonly status: 'created' | 'existing';
  readonly receipt: Readonly<PluginPackagePublisherTrustTransitionReceipt>;
  readonly head: Readonly<PluginPackagePublisherTrustHead>;
}

function unavailable(
  cause?: unknown,
): PluginPackagePublisherTrustTransitionUnavailableError {
  return new PluginPackagePublisherTrustTransitionUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function mappedError(error: unknown): Error {
  if (
    error instanceof PluginPackagePublisherTrustTransitionConflictError ||
    error instanceof PluginPackagePublisherTrustTransitionUnavailableError ||
    error instanceof TypeError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackagePublisherTrustTransitionConflictError();
  }
  return unavailable(error);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError('publisher trust transition execution time is invalid');
  }
  return value as number;
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

function parseDispatch(
  row: Row,
): Readonly<ApprovedActionDispatchRecord> {
  try {
    const dispatch = normalizeApprovedActionDispatchRecord(
      postgresRequiredJsonObject(
        row.dispatchJson,
        unavailable,
      ) as unknown as ApprovedActionDispatchRecord,
    );
    if (
      approvedActionDispatchDigest(dispatch) !==
      postgresRequiredString(row.dispatchDigest, unavailable)
    ) {
      throw unavailable();
    }
    return dispatch;
  } catch (error) {
    if (error instanceof PluginPackagePublisherTrustTransitionUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

function parseApproval(
  row: Row,
): Readonly<ApprovalRequestRecord> {
  try {
    const approval = normalizeApprovalRequestRecord(
      postgresRequiredJsonObject(
        row.approvalJson,
        unavailable,
      ) as unknown as ApprovalRequestRecord,
    );
    if (
      approvalRequestDigest(approval) !==
      postgresRequiredString(row.approvalDigest, unavailable)
    ) {
      throw unavailable();
    }
    return approval;
  } catch (error) {
    if (error instanceof PluginPackagePublisherTrustTransitionUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

function parseHead(row: Row): Readonly<PluginPackagePublisherTrustHead> {
  try {
    const head = normalizePluginPackagePublisherTrustHead(
      postgresRequiredJsonObject(
        row.headJson,
        unavailable,
      ) as unknown as PluginPackagePublisherTrustHead,
    );
    if (
      head.headDigest !== postgresRequiredString(row.headDigest, unavailable)
    ) {
      throw unavailable();
    }
    return head;
  } catch (error) {
    if (error instanceof PluginPackagePublisherTrustTransitionUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

function parseSnapshot(
  row: Row,
  jsonKey: string,
  digestKey: string,
): Readonly<PluginPackagePublisherTrustSnapshot> {
  try {
    const snapshot = normalizePluginPackagePublisherTrustSnapshot(
      postgresRequiredJsonObject(
        row[jsonKey],
        unavailable,
      ) as unknown as PluginPackagePublisherTrustSnapshot,
    );
    if (
      snapshot.snapshotDigest !==
      postgresRequiredString(row[digestKey], unavailable)
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

function parseReceipt(
  row: Row,
): Readonly<PluginPackagePublisherTrustTransitionReceipt> {
  try {
    const receipt = normalizePluginPackagePublisherTrustTransitionReceipt(
      postgresRequiredJsonObject(
        row.receiptJson,
        unavailable,
      ) as unknown as PluginPackagePublisherTrustTransitionReceipt,
    );
    if (
      receipt.receiptDigest !==
      postgresRequiredString(row.receiptDigest, unavailable)
    ) {
      throw unavailable();
    }
    return receipt;
  } catch (error) {
    if (error instanceof PluginPackagePublisherTrustTransitionUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

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

export class PostgresPluginPackagePublisherTrustTransitionRepository {
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL publisher trust transition pool is invalid',
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

  applyApprovedTransition(
    input: ApplyPostgresPluginPackagePublisherTrustTransitionInput,
  ): Promise<
    Readonly<ApplyPostgresPluginPackagePublisherTrustTransitionResult>
  > {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 2 ||
      !Object.hasOwn(input, 'dispatch') ||
      !Object.hasOwn(input, 'executedAtMs')
    ) {
      throw new TypeError('publisher trust transition execution is invalid');
    }
    const dispatch = normalizeApprovedActionDispatchRecord(input.dispatch);
    const executedAtMs = timestamp(input.executedAtMs);
    return this.#transaction(async (client) => {
      const authority = await client.query<Row>(
        `SELECT proposal.proposal_json AS "proposalJson",
                proposal.proposal_digest AS "proposalDigest",
                dispatch.dispatch_json AS "dispatchJson",
                dispatch.dispatch_digest AS "dispatchDigest",
                request.request_json AS "approvalJson",
                request.request_digest AS "approvalDigest"
         FROM "ql3"."approved_action_dispatches" AS dispatch
         JOIN "ql3"."plugin_package_publisher_trust_transition_proposals"
           AS proposal
           ON proposal.action_ref = dispatch.action_ref
         JOIN "ql3"."approval_requests" AS request
           ON request.dispatch_id = dispatch.dispatch_id
         WHERE dispatch.dispatch_id = $1
         LIMIT 2`,
        [dispatch.id],
      );
      if (authority.rows.length !== 1) {
        throw new PluginPackagePublisherTrustTransitionConflictError();
      }
      const proposal = parseProposal(authority.rows[0]!);
      const durableDispatch = parseDispatch(authority.rows[0]!);
      const approval = parseApproval(authority.rows[0]!);
      if (
        !same(durableDispatch, dispatch) ||
        approval.state !== 'consumed' ||
        approval.version !== 3 ||
        approval.decisionMode !== 'separation_of_duty' ||
        approval.decision !== 'approved' ||
        approval.id !== durableDispatch.approvalRequestId ||
        approval.dispatchId !== durableDispatch.id ||
        approval.projectId !== durableDispatch.projectId ||
        !same(approval.action, durableDispatch.action) ||
        !same(approval.requestedBy, durableDispatch.requestedBy) ||
        !same(approval.consumedBy, durableDispatch.consumedBy) ||
        !same(approval.decidedBy, durableDispatch.approvedBy) ||
        approval.decisionAuthenticationId !==
          durableDispatch.approvalAuthenticationId ||
        approval.decisionAssurance !==
          durableDispatch.approvalAssurance ||
        approval.decidedAtMs !== durableDispatch.approvedAtMs ||
        approval.expiresAtMs !== durableDispatch.expiresAtMs ||
        !same(approval.decisionFence, durableDispatch.approvalFence) ||
        approval.consumedAtMs !== durableDispatch.createdAtMs
      ) {
        throw new PluginPackagePublisherTrustTransitionConflictError();
      }
      await publisherSignerLock(
        client,
        proposal.actionInput.publisher,
        proposal.actionInput.keyId,
      );
      const existingReceipt = await client.query<Row>(
        `SELECT receipt_json AS "receiptJson",
                receipt_digest AS "receiptDigest"
         FROM "ql3"."plugin_package_publisher_trust_transition_receipts"
         WHERE mutation_id = $1 OR proposal_digest = $2
         ORDER BY receipt_digest
         LIMIT 2`,
        [dispatch.id, proposal.proposalDigest],
      );
      if (existingReceipt.rows.length > 0) {
        if (existingReceipt.rows.length !== 1) {
          throw new PluginPackagePublisherTrustTransitionConflictError();
        }
        const receipt = parseReceipt(existingReceipt.rows[0]!);
        const expected = resolvePluginPackagePublisherTrustTransitionProposal(
          proposal,
          dispatch,
          executedAtMs,
          proposal.actionInput.mode === 'safe_retire' ? 0 : null,
        );
        if (!same(receipt, expected)) {
          throw new PluginPackagePublisherTrustTransitionConflictError();
        }
        const current = await client.query<Row>(
          `SELECT head_json AS "headJson", head_digest AS "headDigest"
           FROM "ql3"."plugin_package_publisher_trust_heads"
           WHERE authority_id = $1
           LIMIT 2`,
          [receipt.trustAuthorityId],
        );
        if (current.rows.length !== 1) throw unavailable();
        const head = parseHead(current.rows[0]!);
        if (
          head.generation !== receipt.currentGeneration ||
          head.effectiveTrustDigest !== receipt.currentTrustDigest
        ) {
          throw new PluginPackagePublisherTrustTransitionConflictError();
        }
        return Object.freeze({
          status: 'existing' as const,
          receipt,
          head,
        });
      }
      const trust = await client.query<Row>(
        `SELECT head.head_json AS "headJson",
                head.head_digest AS "headDigest",
                effective.snapshot_json AS "effectiveSnapshotJson",
                effective.snapshot_digest AS "effectiveSnapshotDigest",
                candidate.snapshot_json AS "candidateSnapshotJson",
                candidate.snapshot_digest AS "candidateSnapshotDigest"
         FROM "ql3"."plugin_package_publisher_trust_heads" AS head
         JOIN "ql3"."plugin_package_publisher_trust_snapshots" AS effective
           ON effective.snapshot_digest = head.effective_trust_digest
         JOIN "ql3"."plugin_package_publisher_trust_snapshots" AS candidate
           ON candidate.snapshot_digest = $2
         WHERE head.authority_id = $1
         LIMIT 2
         FOR UPDATE OF head`,
        [
          proposal.actionInput.trustAuthorityId,
          proposal.actionInput.currentTrustDigest,
        ],
      );
      if (trust.rows.length !== 1) {
        throw new PluginPackagePublisherTrustTransitionConflictError();
      }
      const head = parseHead(trust.rows[0]!);
      const effectiveSnapshot = parseSnapshot(
        trust.rows[0]!,
        'effectiveSnapshotJson',
        'effectiveSnapshotDigest',
      );
      const candidateSnapshot = parseSnapshot(
        trust.rows[0]!,
        'candidateSnapshotJson',
        'candidateSnapshotDigest',
      );
      if (
        head.generation !== proposal.actionInput.trustGeneration ||
        head.effectiveTrustDigest !==
          proposal.actionInput.previousTrustDigest ||
        effectiveSnapshot.snapshotDigest !==
          proposal.actionInput.previousTrustDigest ||
        candidateSnapshot.snapshotDigest !==
          proposal.actionInput.currentTrustDigest
      ) {
        throw new PluginPackagePublisherTrustTransitionConflictError();
      }
      let expectedCandidate: Readonly<PluginPackagePublisherTrustSnapshot>;
      try {
        expectedCandidate =
          proposal.actionInput.mode === 'overlap_add'
            ? createPluginPackagePublisherTrustOverlapAdditionSnapshot(
                effectiveSnapshot,
                candidateSnapshot,
                proposal.actionInput.publisher,
                proposal.actionInput.keyId,
                executedAtMs,
              )
            : createPluginPackagePublisherTrustRetirementSnapshot(
                effectiveSnapshot,
                proposal.actionInput.publisher,
                proposal.actionInput.keyId,
                executedAtMs,
              );
      } catch {
        throw new PluginPackagePublisherTrustTransitionConflictError();
      }
      if (!same(expectedCandidate, candidateSnapshot)) {
        throw new PluginPackagePublisherTrustTransitionConflictError();
      }
      let retirementMatchingInstallations: 0 | null = null;
      if (proposal.actionInput.mode === 'safe_retire') {
        const matching = await client.query<Row>(
          `SELECT provenance.installation_id AS "installationId"
           FROM "ql3"."plugin_package_publisher_provenance" AS provenance
           JOIN "ql3"."plugin_package_install_heads" AS head
             ON head.project_id = provenance.project_id
            AND head.package_name = provenance.package_name
            AND head.installation_id = provenance.installation_id
           JOIN "ql3"."plugin_package_installs" AS install
             ON install.installation_id = provenance.installation_id
           WHERE provenance.publisher = $1 AND provenance.key_id = $2
             AND install.state IN ('staged', 'activating', 'active')
           LIMIT 1`,
          [proposal.actionInput.publisher, proposal.actionInput.keyId],
        );
        if (matching.rows.length !== 0) {
          throw new PluginPackagePublisherTrustTransitionConflictError();
        }
        retirementMatchingInstallations = 0;
      }
      const receipt = resolvePluginPackagePublisherTrustTransitionProposal(
        proposal,
        dispatch,
        executedAtMs,
        retirementMatchingInstallations,
      );
      const nextHead = advancePluginPackagePublisherTrustHead(
        head,
        candidateSnapshot,
        executedAtMs,
      );
      const headUpdate = await client.query(
        `UPDATE "ql3"."plugin_package_publisher_trust_heads"
         SET generation = $2, effective_trust_digest = $3,
             updated_at_ms = $4, head_digest = $5, head_json = $6::jsonb
         WHERE authority_id = $1 AND generation = $7
           AND effective_trust_digest = $8 AND head_digest = $9`,
        [
          nextHead.authorityId,
          nextHead.generation,
          nextHead.effectiveTrustDigest,
          nextHead.updatedAtMs,
          nextHead.headDigest,
          JSON.stringify(nextHead),
          head.generation,
          head.effectiveTrustDigest,
          head.headDigest,
        ],
      );
      if (headUpdate.rowCount !== 1) {
        throw new PluginPackagePublisherTrustTransitionConflictError();
      }
      const receiptInsert = await client.query(
        `INSERT INTO
           "ql3"."plugin_package_publisher_trust_transition_receipts" (
             mutation_id, proposal_digest, authority_id,
             previous_generation, current_generation, mode, publisher,
             key_id, previous_trust_digest, current_trust_digest,
             proposer_type, proposer_id, confirmer_type, confirmer_id,
             retirement_matching_installations, executed_at_ms,
             receipt_json, receipt_digest
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17::jsonb, $18
           )`,
        [
          receipt.mutationId,
          receipt.proposalDigest,
          receipt.trustAuthorityId,
          receipt.previousGeneration,
          receipt.currentGeneration,
          receipt.mode,
          receipt.publisher,
          receipt.keyId,
          receipt.previousTrustDigest,
          receipt.currentTrustDigest,
          receipt.proposer.type,
          receipt.proposer.id,
          receipt.confirmer.type,
          receipt.confirmer.id,
          receipt.retirementMatchingInstallations,
          receipt.executedAtMs,
          JSON.stringify(receipt),
          receipt.receiptDigest,
        ],
      );
      if (receiptInsert.rowCount !== 1) throw unavailable();
      return Object.freeze({
        status: 'created' as const,
        receipt,
        head: nextHead,
      });
    });
  }
}
