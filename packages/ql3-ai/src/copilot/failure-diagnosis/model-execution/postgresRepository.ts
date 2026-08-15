import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';

import { PostgresModelInvocationRepository } from '../../../model-invocation/postgres-model-invocation-repository/repository';
import { completeWithAtomicOutputOperation } from '../../../model-invocation/postgres-model-invocation-repository/completionOperations';
import {
  normalizeModelInvocationCompletionRecord,
  type ModelInvocationCompletionCommand,
  type ModelInvocationCompletionRecord,
} from '../../../model-invocation/modelInvocation';
import { normalizeCopilotFailureDiagnosisExecutionPlan } from '../admission/plan';
import type { CopilotFailureDiagnosisExecutionPlan } from '../admission/contracts';
import {
  assertCopilotFailureDiagnosisOutputCompletionBinding,
  type CommitCopilotFailureDiagnosisOutputResult,
  type CopilotFailureDiagnosisOutputCompletionRepository,
} from './completion';
import {
  CopilotFailureDiagnosisOutputArtifactConflictError,
  CopilotFailureDiagnosisOutputArtifactUnavailableError,
  copilotFailureDiagnosisOutputArtifactIdentity,
  normalizeCopilotFailureDiagnosisOutputArtifact,
  type CopilotFailureDiagnosisOutputArtifact,
} from './outputArtifact';
import {
  CopilotFailureDiagnosisFinalizationConflictError,
  CopilotFailureDiagnosisFinalizationUnavailableError,
  CopilotFailureDiagnosisModelExecutionInProgressError,
  CopilotFailureDiagnosisModelResolutionRequiredError,
  createCopilotFailureDiagnosisFinalizationReceipt,
  normalizeCopilotFailureDiagnosisFinalizationReceipt,
  type CopilotFailureDiagnosisFinalizationReceipt,
  type CopilotFailureDiagnosisFinalizationRepository,
  type CopilotFailureDiagnosisFinalOutcome,
} from './finalization';

const TABLE = '"ql3_ai"."copilot_failure_diagnosis_model_outputs"';
const FINALIZATION_TABLE = '"ql3_ai"."copilot_failure_diagnosis_finalizations"';

interface OutputRow extends Record<string, unknown> {
  readonly artifactJson: unknown;
}

function integer(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new CopilotFailureDiagnosisFinalizationConflictError();
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      throw new CopilotFailureDiagnosisFinalizationConflictError();
    }
  }
  throw new CopilotFailureDiagnosisFinalizationConflictError();
}

function string(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CopilotFailureDiagnosisFinalizationConflictError();
  }
  return value;
}

function unavailable(cause?: unknown): never {
  throw new CopilotFailureDiagnosisOutputArtifactUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function parse(
  row: OutputRow,
): Readonly<CopilotFailureDiagnosisOutputArtifact> {
  try {
    return normalizeCopilotFailureDiagnosisOutputArtifact(
      row.artifactJson as CopilotFailureDiagnosisOutputArtifact,
    );
  } catch (cause) {
    return unavailable(cause);
  }
}

async function read(
  queryable: Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>,
  artifactId: string,
): Promise<Readonly<CopilotFailureDiagnosisOutputArtifact> | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(artifactId)) {
    throw new CopilotFailureDiagnosisOutputArtifactConflictError();
  }
  try {
    const result = await queryable.query<OutputRow>(
      `SELECT artifact_json AS "artifactJson"
         FROM ${TABLE}
        WHERE artifact_id = $1`,
      [artifactId],
    );
    if (result.rows.length > 1) {
      throw new CopilotFailureDiagnosisOutputArtifactConflictError();
    }
    return result.rows[0] ? parse(result.rows[0]) : null;
  } catch (cause) {
    if (cause instanceof CopilotFailureDiagnosisOutputArtifactConflictError) {
      throw cause;
    }
    return unavailable(cause);
  }
}

async function put(
  client: PostgresClient,
  artifactValue: CopilotFailureDiagnosisOutputArtifact,
): Promise<Readonly<CopilotFailureDiagnosisOutputArtifact>> {
  const artifact =
    normalizeCopilotFailureDiagnosisOutputArtifact(artifactValue);
  const existing = await read(client, artifact.artifactId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(artifact)) {
      throw new CopilotFailureDiagnosisOutputArtifactConflictError();
    }
    return existing;
  }
  try {
    await client.query(
      `INSERT INTO ${TABLE} (
         artifact_id, request_id, plan_digest, tool_completion_digest,
         project_id, run_id, step_run_id, invocation_id, provider, model,
         egress_evidence_digest, content_digest, output_bytes, key_id,
         algorithm, sealed_at_ms, artifact_digest, artifact_json
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18::jsonb
       )`,
      [
        artifact.artifactId,
        artifact.requestId,
        artifact.planDigest,
        artifact.toolCompletionDigest,
        artifact.projectId,
        artifact.runId,
        artifact.stepRunId,
        artifact.invocationId,
        artifact.provider,
        artifact.model,
        artifact.egressEvidenceDigest,
        artifact.contentDigest,
        artifact.outputBytes,
        artifact.keyId,
        artifact.algorithm,
        artifact.sealedAtMs,
        artifact.artifactDigest,
        JSON.stringify(artifact),
      ],
    );
    return artifact;
  } catch (cause) {
    return unavailable(cause);
  }
}

export class PostgresCopilotFailureDiagnosisModelRepository
  extends PostgresModelInvocationRepository
  implements
    CopilotFailureDiagnosisOutputCompletionRepository,
    CopilotFailureDiagnosisFinalizationRepository
{
  readonly #pool: PostgresPool;

  constructor(pool: PostgresPool) {
    super(pool);
    this.#pool = pool;
  }

  findCopilotFailureDiagnosisOutput(
    artifactId: string,
  ): Promise<Readonly<CopilotFailureDiagnosisOutputArtifact> | null> {
    return read(this.#pool, artifactId);
  }

  async completeWithCopilotFailureDiagnosisOutput(
    commandValue: Readonly<ModelInvocationCompletionCommand>,
    artifactValue: Readonly<CopilotFailureDiagnosisOutputArtifact>,
  ): Promise<Readonly<CommitCopilotFailureDiagnosisOutputResult>> {
    const binding = assertCopilotFailureDiagnosisOutputCompletionBinding(
      commandValue,
      artifactValue,
    );
    const result = await completeWithAtomicOutputOperation(
      this.#pool,
      commandValue,
      {
        artifact: binding.artifact,
        reference: binding.reference,
        read: (client) => read(client, binding.artifact.artifactId),
        put: (client) => put(client, binding.artifact),
        matches: (stored) =>
          JSON.stringify(stored) === JSON.stringify(binding.artifact),
      },
    );
    return Object.freeze({
      status: result.status,
      reference: result.reference,
    });
  }

  async findFinalization(
    requestId: string,
  ): Promise<Readonly<CopilotFailureDiagnosisFinalizationReceipt> | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) {
      throw new CopilotFailureDiagnosisFinalizationConflictError();
    }
    try {
      const result = await this.#pool.query<Record<string, unknown>>(
        `SELECT request_id AS "requestId", plan_digest AS "planDigest",
                run_id AS "runId", model_step_run_id AS "modelStepRunId",
                invocation_id AS "invocationId",
                completion_digest AS "completionDigest", outcome,
                output_artifact_id AS "outputArtifactId",
                final_run_version AS "finalRunVersion",
                final_run_event_sequence AS "finalRunEventSequence",
                run_event_id AS "runEventId",
                finalized_at_ms AS "finalizedAtMs",
                receipt_digest AS "receiptDigest",
                receipt_json AS "receiptJson"
           FROM ${FINALIZATION_TABLE}
          WHERE request_id = $1`,
        [requestId],
      );
      if (result.rows.length > 1) {
        throw new CopilotFailureDiagnosisFinalizationConflictError();
      }
      if (!result.rows[0]) return null;
      const row = result.rows[0];
      const receipt = normalizeCopilotFailureDiagnosisFinalizationReceipt(
        object(
          row.receiptJson,
        ) as unknown as CopilotFailureDiagnosisFinalizationReceipt,
      );
      if (
        receipt.requestId !== string(row.requestId) ||
        receipt.planDigest !== string(row.planDigest) ||
        receipt.runId !== string(row.runId) ||
        receipt.modelStepRunId !== string(row.modelStepRunId) ||
        receipt.invocationId !== string(row.invocationId) ||
        receipt.completionDigest !== string(row.completionDigest) ||
        receipt.outcome !== string(row.outcome) ||
        receipt.outputArtifactId !== row.outputArtifactId ||
        receipt.finalRunVersion !== integer(row.finalRunVersion) ||
        receipt.finalRunEventSequence !== integer(row.finalRunEventSequence) ||
        receipt.runEventId !== string(row.runEventId) ||
        receipt.finalizedAtMs !== integer(row.finalizedAtMs) ||
        receipt.receiptDigest !== string(row.receiptDigest)
      ) {
        throw new CopilotFailureDiagnosisFinalizationConflictError();
      }
      const durable = await this.#pool.query<Record<string, unknown>>(
        `SELECT run.status AS "runStatus", run.version AS "runVersion",
                run.event_sequence AS "runEventSequence",
                run.finished_at_ms AS "finishedAtMs",
                run.output_ref AS "outputRef",
                step.status AS "stepStatus",
                event.type AS "eventType", event.dedupe_key AS "dedupeKey",
                event.step_run_id AS "eventStepRunId",
                event.payload, event.created_at_ms AS "eventCreatedAtMs",
                completion.completion_digest AS "completionDigest",
                completion.outcome AS "completionOutcome",
                resolution.decision AS "resolutionDecision",
                resolution.resolved_at_ms AS "resolvedAtMs"
           FROM "ql3"."runs" AS run
           JOIN "ql3"."step_runs" AS step
             ON step.run_id = run.id AND step.id = $1
           JOIN "ql3"."run_events" AS event
             ON event.run_id = run.id AND event.id = $2
           JOIN "ql3_ai"."model_invocation_completions" AS completion
             ON completion.invocation_id = $3
           LEFT JOIN "ql3_ai"."model_invocation_resolutions" AS resolution
             ON resolution.invocation_id = completion.invocation_id
          WHERE run.id = $4`,
        [
          receipt.modelStepRunId,
          receipt.runEventId,
          receipt.invocationId,
          receipt.runId,
        ],
      );
      if (durable.rows.length !== 1) {
        throw new CopilotFailureDiagnosisFinalizationConflictError();
      }
      const proof = durable.rows[0]!;
      const payload = object(proof.payload);
      if (
        string(proof.runStatus) !== receipt.outcome ||
        integer(proof.runVersion) !== receipt.finalRunVersion ||
        integer(proof.runEventSequence) !== receipt.finalRunEventSequence ||
        integer(proof.finishedAtMs) !== receipt.finalizedAtMs ||
        proof.outputRef !== receipt.outputArtifactId ||
        string(proof.stepStatus) !== receipt.outcome ||
        string(proof.eventType) !== `copilot.diagnosis.${receipt.outcome}` ||
        string(proof.dedupeKey) !== receipt.runEventId ||
        string(proof.eventStepRunId) !== receipt.modelStepRunId ||
        integer(proof.eventCreatedAtMs) !== receipt.finalizedAtMs ||
        string(proof.completionDigest) !== receipt.completionDigest ||
        !(
          string(proof.completionOutcome) === receipt.outcome ||
          (string(proof.completionOutcome) === 'outcome_unknown' &&
            ((proof.resolutionDecision === 'fail' &&
              receipt.outcome === 'failed') ||
              (proof.resolutionDecision === 'cancel' &&
                receipt.outcome === 'cancelled')) &&
            integer(proof.resolvedAtMs) === receipt.finalizedAtMs)
        ) ||
        payload.requestId !== receipt.requestId ||
        payload.planDigest !== receipt.planDigest ||
        payload.invocationId !== receipt.invocationId ||
        payload.completionDigest !== receipt.completionDigest ||
        payload.outcome !== receipt.outcome ||
        payload.outputArtifactId !== receipt.outputArtifactId
      ) {
        throw new CopilotFailureDiagnosisFinalizationConflictError();
      }
      return receipt;
    } catch (cause) {
      if (cause instanceof CopilotFailureDiagnosisFinalizationConflictError) {
        throw cause;
      }
      throw new CopilotFailureDiagnosisFinalizationUnavailableError({ cause });
    }
  }

  async finalize(requestId: string): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<CopilotFailureDiagnosisFinalizationReceipt>;
    }>
  > {
    const existing = await this.findFinalization(requestId);
    if (existing) {
      return Object.freeze({ status: 'existing' as const, receipt: existing });
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let client: PostgresClient;
      try {
        client = await this.#pool.connect();
      } catch (cause) {
        throw new CopilotFailureDiagnosisFinalizationUnavailableError({
          cause,
        });
      }
      let began = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        began = true;
        await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
          '5s',
        ]);
        await client.query(`SELECT set_config('lock_timeout', $1, true)`, [
          '2s',
        ]);
        const result = await this.#finalizeInTransaction(client, requestId);
        await client.query('COMMIT');
        began = false;
        return result;
      } catch (cause) {
        if (began) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // Preserve the original failure.
          }
        }
        const state =
          cause && typeof cause === 'object' && 'code' in cause
            ? String(cause.code)
            : '';
        if ((state === '40001' || state === '40P01') && attempt < 2) {
          continue;
        }
        const recovered = await this.findFinalization(requestId);
        if (recovered) {
          return Object.freeze({
            status: 'existing' as const,
            receipt: recovered,
          });
        }
        if (
          cause instanceof CopilotFailureDiagnosisFinalizationConflictError ||
          cause instanceof
            CopilotFailureDiagnosisModelExecutionInProgressError ||
          cause instanceof
            CopilotFailureDiagnosisModelResolutionRequiredError ||
          cause instanceof CopilotFailureDiagnosisFinalizationUnavailableError
        ) {
          throw cause;
        }
        throw new CopilotFailureDiagnosisFinalizationUnavailableError({
          cause,
        });
      } finally {
        client.release();
      }
    }
    throw new CopilotFailureDiagnosisFinalizationUnavailableError();
  }

  async #finalizeInTransaction(
    client: PostgresClient,
    requestId: string,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<CopilotFailureDiagnosisFinalizationReceipt>;
    }>
  > {
    const admission = await client.query<Record<string, unknown>>(
      `SELECT plan_json AS "planJson"
         FROM "ql3_ai"."copilot_failure_diagnosis_admissions"
        WHERE request_id = $1`,
      [requestId],
    );
    if (admission.rows.length !== 1) {
      throw new CopilotFailureDiagnosisFinalizationConflictError();
    }
    const plan = normalizeCopilotFailureDiagnosisExecutionPlan(
      object(
        admission.rows[0]!.planJson,
      ) as unknown as CopilotFailureDiagnosisExecutionPlan,
    );
    const durable = await client.query<Record<string, unknown>>(
      `SELECT run.status AS "runStatus", run.version AS "runVersion",
              run.event_sequence AS "runEventSequence",
              step.status AS "stepStatus",
              step.step_run_digest AS "stepRunDigest",
              completion.record_json AS "completionJson",
              resolution.decision AS "resolutionDecision",
              resolution.completion_digest AS "resolutionCompletionDigest",
              resolution.resolved_at_ms AS "resolvedAtMs",
              resolution_mutation.step_run_digest AS "resolutionStepRunDigest"
         FROM "ql3"."runs" AS run
         JOIN "ql3"."step_runs" AS step
           ON step.run_id = run.id AND step.id = $1
         LEFT JOIN "ql3_ai"."model_invocation_completions" AS completion
           ON completion.invocation_id = $2
         LEFT JOIN "ql3_ai"."model_invocation_resolutions" AS resolution
           ON resolution.invocation_id = $2
         LEFT JOIN "ql3"."step_run_mutations" AS resolution_mutation
           ON resolution_mutation.mutation_id = resolution.mutation_id
        WHERE run.id = $3
        FOR UPDATE OF run, step`,
      [plan.modelStepRunId, plan.modelInvocationId, plan.runId],
    );
    if (durable.rows.length !== 1) {
      throw new CopilotFailureDiagnosisFinalizationConflictError();
    }
    const row = durable.rows[0]!;
    if (row.completionJson === null || row.completionJson === undefined) {
      throw new CopilotFailureDiagnosisModelExecutionInProgressError();
    }
    const completion = normalizeModelInvocationCompletionRecord(
      object(row.completionJson) as unknown as ModelInvocationCompletionRecord,
    );
    if (
      completion.invocationId !== plan.modelInvocationId ||
      completion.projectId !== plan.projectId ||
      completion.runId !== plan.runId ||
      completion.stepRunId !== plan.modelStepRunId ||
      completion.traceId !== plan.traceId ||
      string(row.runStatus) !== 'running' ||
      (completion.outcome !== 'outcome_unknown' &&
        string(row.stepRunDigest) !== completion.completedStepRunDigest)
    ) {
      throw new CopilotFailureDiagnosisFinalizationConflictError();
    }
    let outcome: CopilotFailureDiagnosisFinalOutcome;
    let finalizedAtMs = completion.completedAtMs;
    if (completion.outcome === 'outcome_unknown') {
      if (
        row.resolutionDecision === null ||
        row.resolutionDecision === undefined
      ) {
        throw new CopilotFailureDiagnosisModelResolutionRequiredError();
      }
      if (row.resolutionDecision === 'retry') {
        throw new CopilotFailureDiagnosisModelExecutionInProgressError();
      }
      if (
        row.resolutionDecision !== 'fail' &&
        row.resolutionDecision !== 'cancel'
      ) {
        throw new CopilotFailureDiagnosisFinalizationConflictError();
      }
      if (
        string(row.resolutionCompletionDigest) !==
          completion.completionDigest ||
        string(row.resolutionStepRunDigest) !== string(row.stepRunDigest)
      ) {
        throw new CopilotFailureDiagnosisFinalizationConflictError();
      }
      outcome = row.resolutionDecision === 'fail' ? 'failed' : 'cancelled';
      finalizedAtMs = integer(row.resolvedAtMs);
    } else {
      outcome = completion.outcome;
    }
    if (string(row.stepStatus) !== outcome) {
      throw new CopilotFailureDiagnosisFinalizationConflictError();
    }
    const output =
      outcome === 'succeeded'
        ? await read(
            client,
            copilotFailureDiagnosisOutputArtifactIdentity(
              plan.modelInvocationId,
            ),
          )
        : null;
    if (
      (outcome === 'succeeded' &&
        (!output ||
          output.requestId !== plan.requestId ||
          output.planDigest !== plan.planDigest ||
          output.invocationId !== completion.invocationId ||
          output.outputBytes !== completion.outputBytes)) ||
      (outcome !== 'succeeded' && output !== null)
    ) {
      throw new CopilotFailureDiagnosisFinalizationConflictError();
    }
    const runVersion = integer(row.runVersion);
    const eventSequence = integer(row.runEventSequence);
    if (runVersion !== eventSequence) {
      throw new CopilotFailureDiagnosisFinalizationConflictError();
    }
    const receipt = createCopilotFailureDiagnosisFinalizationReceipt({
      requestId: plan.requestId,
      planDigest: plan.planDigest,
      runId: plan.runId,
      modelStepRunId: plan.modelStepRunId,
      invocationId: plan.modelInvocationId,
      completionDigest: completion.completionDigest,
      outcome,
      outputArtifactId: output?.artifactId ?? null,
      finalRunVersion: runVersion + 1,
      finalRunEventSequence: eventSequence + 1,
      finalizedAtMs,
    });
    const failure =
      outcome === 'succeeded'
        ? { code: null, summary: null }
        : outcome === 'cancelled'
        ? {
            code: 'COPILOT_FAILURE_DIAGNOSIS_CANCELLED',
            summary: 'Copilot failure diagnosis was cancelled',
          }
        : outcome === 'timed_out'
        ? {
            code: 'COPILOT_FAILURE_DIAGNOSIS_TIMED_OUT',
            summary: 'Copilot failure diagnosis timed out',
          }
        : {
            code: 'COPILOT_FAILURE_DIAGNOSIS_FAILED',
            summary: 'Copilot failure diagnosis failed',
          };
    const updated = await client.query(
      `UPDATE "ql3"."runs"
          SET status = $1, version = $2, event_sequence = $3,
              output_ref = $4, finished_at_ms = $5,
              error_code = $6, error_summary = $7
        WHERE id = $8 AND status = 'running'
          AND version = $9 AND event_sequence = $10`,
      [
        outcome,
        receipt.finalRunVersion,
        receipt.finalRunEventSequence,
        receipt.outputArtifactId,
        receipt.finalizedAtMs,
        failure.code,
        failure.summary,
        receipt.runId,
        runVersion,
        eventSequence,
      ],
    );
    if ((updated.rowCount ?? updated.rows.length) !== 1) {
      throw new CopilotFailureDiagnosisFinalizationConflictError();
    }
    const payload = JSON.stringify({
      requestId: receipt.requestId,
      planDigest: receipt.planDigest,
      invocationId: receipt.invocationId,
      completionDigest: receipt.completionDigest,
      outcome: receipt.outcome,
      outputArtifactId: receipt.outputArtifactId,
    });
    await client.query(
      `INSERT INTO "ql3"."run_events" (
         id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
         attempt_id, step_run_id, payload, created_at_ms
       ) VALUES ($1, $2, $3, $4, $1, 'system', NULL, NULL, $5, $6::jsonb, $7)`,
      [
        receipt.runEventId,
        receipt.runId,
        receipt.finalRunEventSequence,
        `copilot.diagnosis.${receipt.outcome}`,
        plan.modelStepRunId,
        payload,
        receipt.finalizedAtMs,
      ],
    );
    await client.query(
      `INSERT INTO ${FINALIZATION_TABLE} (
         request_id, plan_digest, run_id, model_step_run_id, invocation_id,
         completion_digest,
         outcome, output_artifact_id, final_run_version,
         final_run_event_sequence, run_event_id, finalized_at_ms,
         receipt_digest, receipt_json
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14::jsonb
       )`,
      [
        receipt.requestId,
        receipt.planDigest,
        receipt.runId,
        receipt.modelStepRunId,
        receipt.invocationId,
        receipt.completionDigest,
        receipt.outcome,
        receipt.outputArtifactId,
        receipt.finalRunVersion,
        receipt.finalRunEventSequence,
        receipt.runEventId,
        receipt.finalizedAtMs,
        receipt.receiptDigest,
        JSON.stringify(receipt),
      ],
    );
    return Object.freeze({ status: 'created' as const, receipt });
  }
}
