import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryable,
} from '@qinglong/runtime-core';
import {
  InvalidToolExecutionCompletionError,
  MAX_TOOL_EXECUTION_COMPLETION_JSON_BYTES,
  MAX_TOOL_EXECUTION_RESULT_ARTIFACT_JSON_BYTES,
  ToolExecutionCompletionConflictError,
  ToolExecutionCompletionUnavailableError,
  normalizeToolExecutionCompletionCommand,
  normalizeToolExecutionCompletionRecord,
  normalizeToolExecutionResultKeyBinding,
  normalizeToolExecutionResultArtifact,
  toolExecutionCompletionRecord,
  toolExecutionResultKeyBinding,
  type CommitToolExecutionCompletionResult,
  type ToolExecutionCompletionCommand,
  type ToolExecutionCompletionRecord,
  type ToolExecutionCompletionRepository,
  type ToolExecutionResultArtifact,
  type ToolExecutionResultKeyBinding,
} from '@qinglong/runtime-core/tool-execution-completion';
import {
  normalizeToolResultKeyCatalogRecord,
  requireActiveToolResultKey,
  toolResultKeyCatalogFence,
  type ToolResultKeyCatalogRecord,
} from '@qinglong/runtime-core/tool-result-key-catalog';
import type { StepRunMutation } from '@qinglong/runtime-core/step-run';
import { normalizeToolExecutionStartBarrierRecord } from '@qinglong/runtime-core/tool-execution-start-barrier';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresQueryable, 'query'>;

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
const CATALOG_TRANSACTION_LOCK = 'SELECT pg_advisory_xact_lock(190397473, 3)';
const COMPLETION_SELECT = `
  completion.completion_json AS "completionJson",
  completion.artifact_json AS "artifactJson",
  completion.start_id AS "storedStartId",
  completion.artifact_id AS "storedArtifactId",
  completion.project_id AS "storedProjectId",
  completion.run_id AS "storedRunId",
  completion.step_run_id AS "storedStepRunId",
  completion.started_step_run_version AS "storedStartedStepRunVersion",
  completion.completed_step_run_version AS "storedCompletedStepRunVersion",
  completion.barrier_digest AS "storedBarrierDigest",
  completion.adapter_digest AS "storedAdapterDigest",
  completion.output_digest AS "storedOutputDigest",
  completion.execution_result_digest AS "storedExecutionResultDigest",
  completion.artifact_digest AS "storedArtifactDigest",
  completion.key_id AS "storedKeyId",
  completion.algorithm AS "storedAlgorithm",
  completion.plaintext_bytes AS "storedPlaintextBytes",
  completion.step_run_mutation_id AS "storedMutationId",
  completion.step_run_mutation_digest AS "storedMutationDigest",
  completion.completed_step_run_digest AS "storedCompletedStepRunDigest",
  completion.run_event_id AS "storedRunEventId",
  completion.completed_at_ms AS "storedCompletedAtMs",
  completion.completion_digest AS "storedCompletionDigest",
  binding.artifact_digest AS "bindingArtifactDigest",
  binding.catalog_generation AS "bindingCatalogGeneration",
  binding.catalog_digest AS "bindingCatalogDigest",
  binding.key_id AS "bindingKeyId",
  binding.material_proof AS "bindingMaterialProof",
  binding.binding_digest AS "bindingDigest",
  catalog.catalog_json AS "catalogJson",
  barrier.barrier_digest AS "joinedBarrierDigest",
  mutation.mutation_digest AS "joinedMutationDigest",
  mutation.step_run_digest AS "joinedCompletedStepRunDigest",
  event.id AS "joinedRunEventId"
`;

function unavailable(cause?: unknown): ToolExecutionCompletionUnavailableError {
  return new ToolExecutionCompletionUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function requiredText(row: Row, key: string): string {
  return postgresRequiredString(row[key], unavailable);
}

function requiredInteger(row: Row, key: string): number {
  return postgresRequiredInteger(row[key], unavailable);
}

function requiredJson(row: Row, key: string): Record<string, unknown> {
  return postgresRequiredJsonObject(row[key], unavailable);
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    throw new InvalidToolExecutionCompletionError(`${label} is invalid`);
  }
  return value;
}

function constraintError(error: unknown): boolean {
  const state = postgresSqlState(error);
  return state === '23503' || state === '23505' || state === '23514';
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidToolExecutionCompletionError ||
    error instanceof ToolExecutionCompletionConflictError ||
    error instanceof ToolExecutionCompletionUnavailableError
  ) {
    return error;
  }
  return constraintError(error)
    ? new ToolExecutionCompletionConflictError()
    : unavailable(error);
}

function valuesFromRow(row: Row): Readonly<{
  artifact: Readonly<ToolExecutionResultArtifact>;
  binding: Readonly<ToolExecutionResultKeyBinding>;
  completion: Readonly<ToolExecutionCompletionRecord>;
}> {
  let completion: Readonly<ToolExecutionCompletionRecord>;
  let artifact: Readonly<ToolExecutionResultArtifact>;
  let binding: Readonly<ToolExecutionResultKeyBinding>;
  let catalog: Readonly<ToolResultKeyCatalogRecord>;
  try {
    completion = normalizeToolExecutionCompletionRecord(
      requiredJson(
        row,
        'completionJson',
      ) as unknown as ToolExecutionCompletionRecord,
    );
    artifact = normalizeToolExecutionResultArtifact(
      requiredJson(
        row,
        'artifactJson',
      ) as unknown as ToolExecutionResultArtifact,
    );
    binding = normalizeToolExecutionResultKeyBinding({
      schema: 'qinglong/tool-execution-result-key-binding@v1',
      startId: completion.startId,
      artifactId: artifact.artifactId,
      artifactDigest: requiredText(row, 'bindingArtifactDigest'),
      catalogGeneration: requiredInteger(row, 'bindingCatalogGeneration'),
      catalogDigest: requiredText(row, 'bindingCatalogDigest'),
      keyId: requiredText(row, 'bindingKeyId'),
      materialProof: requiredText(row, 'bindingMaterialProof'),
      bindingDigest: requiredText(row, 'bindingDigest'),
    });
    catalog = normalizeToolResultKeyCatalogRecord(
      requiredJson(row, 'catalogJson') as unknown as ToolResultKeyCatalogRecord,
    );
  } catch {
    throw unavailable();
  }
  if (
    Buffer.byteLength(JSON.stringify(completion), 'utf8') >
      MAX_TOOL_EXECUTION_COMPLETION_JSON_BYTES ||
    Buffer.byteLength(JSON.stringify(artifact), 'utf8') >
      MAX_TOOL_EXECUTION_RESULT_ARTIFACT_JSON_BYTES ||
    completion.startId !== requiredText(row, 'storedStartId') ||
    completion.resultArtifact.artifactId !==
      requiredText(row, 'storedArtifactId') ||
    completion.projectId !== requiredText(row, 'storedProjectId') ||
    completion.runId !== requiredText(row, 'storedRunId') ||
    completion.stepRunId !== requiredText(row, 'storedStepRunId') ||
    completion.startedStepRunVersion !==
      requiredInteger(row, 'storedStartedStepRunVersion') ||
    completion.completedStepRunVersion !==
      requiredInteger(row, 'storedCompletedStepRunVersion') ||
    completion.barrierDigest !== requiredText(row, 'storedBarrierDigest') ||
    completion.adapterDigest !== requiredText(row, 'storedAdapterDigest') ||
    completion.resultArtifact.outputDigest !==
      requiredText(row, 'storedOutputDigest') ||
    completion.resultArtifact.executionResultDigest !==
      requiredText(row, 'storedExecutionResultDigest') ||
    completion.resultArtifact.artifactDigest !==
      requiredText(row, 'storedArtifactDigest') ||
    completion.stepRunMutationId !== requiredText(row, 'storedMutationId') ||
    completion.stepRunMutationDigest !==
      requiredText(row, 'storedMutationDigest') ||
    completion.completedStepRunDigest !==
      requiredText(row, 'storedCompletedStepRunDigest') ||
    completion.runEventId !== requiredText(row, 'storedRunEventId') ||
    completion.completedAtMs !== requiredInteger(row, 'storedCompletedAtMs') ||
    completion.completionDigest !==
      requiredText(row, 'storedCompletionDigest') ||
    artifact.artifactId !== completion.resultArtifact.artifactId ||
    artifact.artifactDigest !== completion.resultArtifact.artifactDigest ||
    artifact.projectId !== completion.projectId ||
    artifact.startId !== completion.startId ||
    artifact.runId !== completion.runId ||
    artifact.stepRunId !== completion.stepRunId ||
    artifact.barrierDigest !== completion.barrierDigest ||
    artifact.adapterDigest !== completion.adapterDigest ||
    artifact.outputDigest !== completion.resultArtifact.outputDigest ||
    artifact.executionResultDigest !==
      completion.resultArtifact.executionResultDigest ||
    artifact.keyId !== requiredText(row, 'storedKeyId') ||
    artifact.algorithm !== requiredText(row, 'storedAlgorithm') ||
    artifact.plaintextBytes !== requiredInteger(row, 'storedPlaintextBytes') ||
    artifact.sealedAtMs !== completion.completedAtMs ||
    binding.startId !== completion.startId ||
    binding.artifactId !== artifact.artifactId ||
    binding.artifactDigest !== artifact.artifactDigest ||
    binding.catalogGeneration !== catalog.generation ||
    binding.catalogDigest !== catalog.catalogDigest ||
    binding.keyId !== artifact.keyId ||
    catalog.activeKeyId !== binding.keyId ||
    requireActiveToolResultKey(catalog).materialProof !==
      binding.materialProof ||
    completion.barrierDigest !== requiredText(row, 'joinedBarrierDigest') ||
    completion.stepRunMutationDigest !==
      requiredText(row, 'joinedMutationDigest') ||
    completion.completedStepRunDigest !==
      requiredText(row, 'joinedCompletedStepRunDigest') ||
    completion.runEventId !== requiredText(row, 'joinedRunEventId')
  ) {
    throw unavailable();
  }
  return Object.freeze({ artifact, binding, completion });
}

async function findRows(
  queryable: Queryable,
  where: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT ${COMPLETION_SELECT}
     FROM "ql3"."tool_execution_completions" AS completion
     JOIN "ql3"."tool_execution_start_barriers" AS barrier
       ON barrier.start_id = completion.start_id
     JOIN "ql3"."step_run_mutations" AS mutation
       ON mutation.mutation_id = completion.step_run_mutation_id
     JOIN "ql3"."run_events" AS event
       ON event.id = completion.run_event_id
     LEFT JOIN "ql3"."tool_execution_result_key_bindings" AS binding
       ON binding.start_id = completion.start_id
     LEFT JOIN "ql3"."tool_result_key_catalog_generations" AS catalog
       ON catalog.authority = binding.catalog_authority
      AND catalog.generation = binding.catalog_generation
     WHERE ${where}
     LIMIT 2`,
    values,
  );
  return result.rows;
}

async function updateStepRun(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
  const step = mutation.stepRun;
  const result = await client.query(
    `UPDATE "ql3"."step_runs"
     SET status = $1, version = $2, attempt_count = $3,
         output_ref = $4, approval_request_id = $5, ready_at_ms = $6,
         started_at_ms = $7, finished_at_ms = $8, result_code = $9,
         error_summary = $10, updated_at_ms = $11,
         last_mutation_id = $12, step_run_digest = $13,
         step_run_json = $14::jsonb
     WHERE id = $15 AND run_id = $16 AND version = $17
       AND step_run_digest = $18 AND status = $19`,
    [
      step.status,
      step.version,
      step.attemptCount,
      step.outputRef,
      step.approvalRequestId,
      step.readyAtMs,
      step.startedAtMs,
      step.finishedAtMs,
      step.resultCode,
      step.errorSummary,
      step.updatedAtMs,
      step.lastMutationId,
      step.stepRunDigest,
      JSON.stringify(step),
      step.id,
      step.runId,
      mutation.expectedStepRunVersion,
      mutation.expectedStepRunDigest,
      mutation.previousStatus,
    ],
  );
  if (result.rowCount !== 1) {
    throw new ToolExecutionCompletionConflictError();
  }
}

async function updateRun(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
  const result = await client.query(
    `UPDATE "ql3"."runs"
     SET version = version + 1, event_sequence = event_sequence + 1
     WHERE id = $1 AND version = $2 AND event_sequence = $3`,
    [
      mutation.runId,
      mutation.expectedRunVersion,
      mutation.expectedRunEventSequence,
    ],
  );
  if (result.rowCount !== 1) {
    throw new ToolExecutionCompletionConflictError();
  }
}

async function insertRunEvent(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
  const event = mutation.event;
  await client.query(
    `INSERT INTO "ql3"."run_events" (
       id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
       attempt_id, step_run_id, payload, created_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, NULL, $8, $9::jsonb, $10
     )`,
    [
      event.id,
      event.runId,
      event.sequence,
      event.type,
      event.dedupeKey,
      event.actorType,
      event.actorId ?? null,
      mutation.stepRun.id,
      JSON.stringify(event.payload),
      event.createdAtMs,
    ],
  );
}

async function insertMutation(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3"."step_run_mutations" (
       mutation_id, mutation_digest, run_id, step_run_id,
       step_run_digest, event_id, event_sequence, run_version,
       step_run_json, committed_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
       floor(
         extract(epoch FROM transaction_timestamp()) * 1000
       )::bigint
     )`,
    [
      mutation.mutationId,
      mutation.mutationDigest,
      mutation.runId,
      mutation.stepRun.id,
      mutation.stepRun.stepRunDigest,
      mutation.event.id,
      mutation.event.sequence,
      mutation.expectedRunVersion + 1,
      JSON.stringify(mutation.stepRun),
    ],
  );
}

async function insertCompletion(
  client: PostgresClient,
  completion: Readonly<ToolExecutionCompletionRecord>,
  artifact: Readonly<ToolExecutionResultArtifact>,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3"."tool_execution_completions" (
       start_id, artifact_id, project_id, run_id, step_run_id,
       started_step_run_version, completed_step_run_version,
       barrier_digest, adapter_digest, output_digest,
       execution_result_digest, artifact_digest, key_id, algorithm,
       plaintext_bytes, step_run_mutation_id, step_run_mutation_digest,
       completed_step_run_digest, run_event_id, completed_at_ms,
       completion_digest, artifact_json, completion_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23::jsonb
     )`,
    [
      completion.startId,
      artifact.artifactId,
      completion.projectId,
      completion.runId,
      completion.stepRunId,
      completion.startedStepRunVersion,
      completion.completedStepRunVersion,
      completion.barrierDigest,
      completion.adapterDigest,
      completion.resultArtifact.outputDigest,
      completion.resultArtifact.executionResultDigest,
      artifact.artifactDigest,
      artifact.keyId,
      artifact.algorithm,
      artifact.plaintextBytes,
      completion.stepRunMutationId,
      completion.stepRunMutationDigest,
      completion.completedStepRunDigest,
      completion.runEventId,
      completion.completedAtMs,
      completion.completionDigest,
      JSON.stringify(artifact),
      JSON.stringify(completion),
    ],
  );
}

async function resultKeyBindingForCurrentCatalog(
  client: PostgresClient,
  command: Readonly<ToolExecutionCompletionCommand>,
): Promise<Readonly<ToolExecutionResultKeyBinding>> {
  const result = await client.query<Row>(
    `SELECT catalog_json AS "catalogJson"
     FROM "ql3"."tool_result_key_catalog_generations"
     WHERE authority = 'trusted-tool-results'
     ORDER BY generation DESC
     LIMIT 1`,
  );
  if (result.rows.length !== 1) {
    throw new ToolExecutionCompletionConflictError();
  }
  let catalog: Readonly<ToolResultKeyCatalogRecord>;
  try {
    catalog = normalizeToolResultKeyCatalogRecord(
      requiredJson(
        result.rows[0]!,
        'catalogJson',
      ) as unknown as ToolResultKeyCatalogRecord,
    );
  } catch {
    throw unavailable();
  }
  const active = requireActiveToolResultKey(catalog);
  if (
    JSON.stringify(toolResultKeyCatalogFence(catalog, active)) !==
    JSON.stringify(command.resultKeyCatalogFence)
  ) {
    throw new ToolExecutionCompletionConflictError();
  }
  return toolExecutionResultKeyBinding(command);
}

async function insertResultKeyBinding(
  client: PostgresClient,
  binding: Readonly<ToolExecutionResultKeyBinding>,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3"."tool_execution_result_key_bindings" (
       start_id, artifact_id, artifact_digest, catalog_authority,
       catalog_generation, catalog_digest, key_id, material_proof,
       binding_digest
     ) VALUES (
       $1, $2, $3, 'trusted-tool-results', $4, $5, $6, $7, $8
     )`,
    [
      binding.startId,
      binding.artifactId,
      binding.artifactDigest,
      binding.catalogGeneration,
      binding.catalogDigest,
      binding.keyId,
      binding.materialProof,
      binding.bindingDigest,
    ],
  );
}

export class PostgresToolExecutionCompletionRepository
  implements ToolExecutionCompletionRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw unavailable();
    }
  }

  async findByStartId(
    startIdValue: string,
  ): Promise<Readonly<ToolExecutionCompletionRecord> | null> {
    const startId = identity(startIdValue, 'start id');
    try {
      const rows = await findRows(this.pool, 'completion.start_id = $1', [
        startId,
      ]);
      if (rows.length > 1) throw unavailable();
      return rows[0] ? valuesFromRow(rows[0]).completion : null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findResultArtifact(
    artifactIdValue: string,
  ): Promise<Readonly<ToolExecutionResultArtifact> | null> {
    const artifactId = identity(artifactIdValue, 'result Artifact id');
    try {
      const rows = await findRows(this.pool, 'completion.artifact_id = $1', [
        artifactId,
      ]);
      if (rows.length > 1) throw unavailable();
      return rows[0] ? valuesFromRow(rows[0]).artifact : null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async commit(
    commandValue: ToolExecutionCompletionCommand,
  ): Promise<Readonly<CommitToolExecutionCompletionResult>> {
    const command = normalizeToolExecutionCompletionCommand(commandValue);
    const completion = toolExecutionCompletionRecord(command);
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        throw unavailable(error);
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        await client.query(CATALOG_TRANSACTION_LOCK);
        const existing = await findRows(
          client,
          `completion.start_id = $1
           OR completion.artifact_id = $2
           OR completion.step_run_mutation_id = $3
           OR completion.run_event_id = $4`,
          [
            completion.startId,
            completion.resultArtifact.artifactId,
            completion.stepRunMutationId,
            completion.runEventId,
          ],
        );
        if (existing.length > 1) {
          throw new ToolExecutionCompletionConflictError();
        }
        if (existing[0]) {
          const stored = valuesFromRow(existing[0]);
          if (
            JSON.stringify(stored.completion) !== JSON.stringify(completion) ||
            JSON.stringify(stored.artifact) !==
              JSON.stringify(command.resultArtifact) ||
            JSON.stringify(stored.binding) !==
              JSON.stringify(toolExecutionResultKeyBinding(command))
          ) {
            throw new ToolExecutionCompletionConflictError();
          }
          await client.query('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing',
            completion: stored.completion,
          });
        }

        const failureConflict = await client.query(
          `SELECT 1
           FROM "ql3"."tool_execution_failure_completions"
           WHERE start_id = $1 OR step_run_mutation_id = $2
             OR run_event_id = $3
             OR (
               run_id = $4 AND step_run_id = $5
               AND completed_step_run_version = $6
             )
           LIMIT 1`,
          [
            completion.startId,
            completion.stepRunMutationId,
            completion.runEventId,
            completion.runId,
            completion.stepRunId,
            completion.completedStepRunVersion,
          ],
        );
        if (failureConflict.rows.length > 0) {
          throw new ToolExecutionCompletionConflictError();
        }

        const mutation = command.stepRunMutation;
        const resultKeyBinding = await resultKeyBindingForCurrentCatalog(
          client,
          command,
        );
        const current = await client.query<Row>(
          `SELECT
             barrier.barrier_json AS "barrierJson",
             start_mutation.run_version AS "startedRunVersion",
             start_mutation.event_sequence AS "startedEventSequence",
             step.kind AS "stepKind", step.status AS "stepStatus",
             step.version AS "stepVersion",
             step.step_run_digest AS "stepDigest",
             run.project_id AS "projectId", run.status AS "runStatus",
             run.version AS "runVersion",
             run.event_sequence AS "runEventSequence"
           FROM "ql3"."tool_execution_start_barriers" AS barrier
           JOIN "ql3"."step_run_mutations" AS start_mutation
             ON start_mutation.mutation_id = barrier.step_run_mutation_id
           JOIN "ql3"."step_runs" AS step
             ON step.id = barrier.step_run_id
            AND step.run_id = barrier.run_id
           JOIN "ql3"."runs" AS run ON run.id = barrier.run_id
           WHERE barrier.start_id = $1
           LIMIT 2
           FOR UPDATE OF step, run`,
          [completion.startId],
        );
        const row = current.rows[0];
        let storedBarrier;
        try {
          storedBarrier = row
            ? normalizeToolExecutionStartBarrierRecord(
                requiredJson(
                  row,
                  'barrierJson',
                ) as unknown as ToolExecutionCompletionCommand['barrier'],
              )
            : null;
        } catch {
          throw unavailable();
        }
        if (
          current.rows.length !== 1 ||
          !row ||
          !storedBarrier ||
          JSON.stringify(storedBarrier) !== JSON.stringify(command.barrier) ||
          requiredInteger(row, 'startedRunVersion') !==
            mutation.expectedRunVersion ||
          requiredInteger(row, 'startedEventSequence') !==
            mutation.expectedRunEventSequence ||
          requiredText(row, 'stepKind') !== 'tool' ||
          requiredText(row, 'stepStatus') !== 'running' ||
          requiredInteger(row, 'stepVersion') !==
            mutation.expectedStepRunVersion ||
          requiredText(row, 'stepDigest') !== mutation.expectedStepRunDigest ||
          requiredText(row, 'projectId') !== completion.projectId ||
          requiredInteger(row, 'runVersion') !== mutation.expectedRunVersion ||
          requiredInteger(row, 'runEventSequence') !==
            mutation.expectedRunEventSequence ||
          TERMINAL_RUN_STATUSES.has(requiredText(row, 'runStatus'))
        ) {
          throw new ToolExecutionCompletionConflictError();
        }

        await updateStepRun(client, mutation);
        await updateRun(client, mutation);
        await insertRunEvent(client, mutation);
        await insertMutation(client, mutation);
        await insertCompletion(client, completion, command.resultArtifact);
        await insertResultKeyBinding(client, resultKeyBinding);
        await client.query('COMMIT');
        began = false;
        return Object.freeze({ status: 'created', completion });
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
        throw mapStorageError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }
}
