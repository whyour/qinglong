import type { DatabaseSync } from 'node:sqlite';

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
  toolExecutionResultKeyBinding,
  toolExecutionCompletionRecord,
  type CommitToolExecutionCompletionResult,
  type ToolExecutionCompletionCommand,
  type ToolExecutionCompletionRecord,
  type ToolExecutionCompletionRepository,
  type ToolExecutionResultKeyBinding,
  type ToolExecutionResultArtifact,
} from '@qinglong/runtime-core/tool-execution-completion';
import {
  normalizeToolResultKeyCatalogRecord,
  requireActiveToolResultKey,
  toolResultKeyCatalogFence,
  type ToolResultKeyCatalogRecord,
} from '@qinglong/runtime-core/tool-result-key-catalog';
import type { StepRunMutation } from '@qinglong/runtime-core/step-run';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
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
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function requiredInteger(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw unavailable();
  }
  return value as number;
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    throw new InvalidToolExecutionCompletionError(`${label} is invalid`);
  }
  return value;
}

function sqliteConstraint(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const number = (error as { errcode?: unknown }).errcode;
  return (
    (typeof code === 'string' && code.startsWith('ERR_SQLITE_CONSTRAINT')) ||
    (typeof number === 'number' && (number & 0xff) === 19)
  );
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidToolExecutionCompletionError ||
    error instanceof ToolExecutionCompletionConflictError ||
    error instanceof ToolExecutionCompletionUnavailableError
  ) {
    return error;
  }
  return sqliteConstraint(error)
    ? new ToolExecutionCompletionConflictError()
    : unavailable(error);
}

function parseJson(row: Row, key: string, maximumBytes: number): unknown {
  const json = requiredText(row, key);
  if (Buffer.byteLength(json, 'utf8') > maximumBytes) throw unavailable();
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw unavailable();
  }
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
      parseJson(
        row,
        'completionJson',
        MAX_TOOL_EXECUTION_COMPLETION_JSON_BYTES,
      ) as ToolExecutionCompletionRecord,
    );
    artifact = normalizeToolExecutionResultArtifact(
      parseJson(
        row,
        'artifactJson',
        MAX_TOOL_EXECUTION_RESULT_ARTIFACT_JSON_BYTES,
      ) as ToolExecutionResultArtifact,
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
    const catalogJson = parseJson(row, 'catalogJson', 64 * 1024);
    catalog = normalizeToolResultKeyCatalogRecord(
      catalogJson as ToolResultKeyCatalogRecord,
    );
  } catch {
    throw unavailable();
  }
  if (
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
    completion.runEventId !== requiredText(row, 'joinedRunEventId') ||
    JSON.stringify(completion) !== requiredText(row, 'completionJson') ||
    JSON.stringify(artifact) !== requiredText(row, 'artifactJson')
  ) {
    throw unavailable();
  }
  return Object.freeze({ artifact, binding, completion });
}

function updateStepRun(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  const step = mutation.stepRun;
  const result = client
    .prepare(
      `UPDATE "StepRuns"
       SET "status" = ?, "version" = ?, "attempt_count" = ?,
           "output_ref" = ?, "approval_request_id" = ?, "ready_at_ms" = ?,
           "started_at_ms" = ?, "finished_at_ms" = ?, "result_code" = ?,
           "error_summary" = ?, "updated_at_ms" = ?,
           "last_mutation_id" = ?, "step_run_digest" = ?,
           "step_run_json" = ?
       WHERE "id" = ? AND "run_id" = ? AND "version" = ?
         AND "step_run_digest" = ? AND "status" = ?`,
    )
    .run(
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
    );
  if (result.changes !== 1) {
    throw new ToolExecutionCompletionConflictError();
  }
}

function updateRun(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  const result = client
    .prepare(
      `UPDATE "Runs"
       SET "version" = "version" + 1,
           "event_sequence" = "event_sequence" + 1
       WHERE "id" = ? AND "version" = ? AND "event_sequence" = ?`,
    )
    .run(
      mutation.runId,
      mutation.expectedRunVersion,
      mutation.expectedRunEventSequence,
    );
  if (result.changes !== 1) {
    throw new ToolExecutionCompletionConflictError();
  }
}

function insertRunEvent(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  const event = mutation.event;
  client
    .prepare(
      `INSERT INTO "RunEvents" (
         "id", "run_id", "sequence", "type", "dedupe_key", "actor_type",
         "actor_id", "attempt_id", "step_run_id", "payload", "created_at_ms"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      event.id,
      event.runId,
      event.sequence,
      event.type,
      event.dedupeKey!,
      event.actorType,
      event.actorId ?? null,
      mutation.stepRun.id,
      JSON.stringify(event.payload),
      event.createdAtMs,
    );
}

function insertMutation(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  client
    .prepare(
      `INSERT INTO "StepRunMutations" (
         "mutation_id", "mutation_digest", "run_id", "step_run_id",
         "step_run_digest", "event_id", "event_sequence",
         "run_version", "step_run_json", "committed_at_ms"
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?,
         CAST(unixepoch('subsec') * 1000 AS INTEGER)
       )`,
    )
    .run(
      mutation.mutationId,
      mutation.mutationDigest,
      mutation.runId,
      mutation.stepRun.id,
      mutation.stepRun.stepRunDigest,
      mutation.event.id,
      mutation.event.sequence,
      mutation.expectedRunVersion + 1,
      JSON.stringify(mutation.stepRun),
    );
}

function insertCompletion(
  client: DatabaseSync,
  completion: Readonly<ToolExecutionCompletionRecord>,
  artifact: Readonly<ToolExecutionResultArtifact>,
): void {
  client
    .prepare(
      `INSERT INTO "ToolExecutionCompletions" (
         start_id, artifact_id, project_id, run_id, step_run_id,
         started_step_run_version, completed_step_run_version,
         barrier_digest, adapter_digest, output_digest,
         execution_result_digest, artifact_digest, key_id, algorithm,
         plaintext_bytes, step_run_mutation_id, step_run_mutation_digest,
         completed_step_run_digest, run_event_id, completed_at_ms,
         completion_digest, artifact_json, completion_json
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?
       )`,
    )
    .run(
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
    );
}

function resultKeyBindingForCurrentCatalog(
  client: DatabaseSync,
  command: Readonly<ToolExecutionCompletionCommand>,
): Readonly<ToolExecutionResultKeyBinding> {
  const rows = client
    .prepare(
      `SELECT catalog_json AS "catalogJson"
       FROM "ToolResultKeyCatalogGenerations"
       WHERE authority = 'trusted-tool-results'
       ORDER BY generation DESC
       LIMIT 2`,
    )
    .all() as Row[];
  if (rows.length < 1) {
    throw new ToolExecutionCompletionConflictError();
  }
  let catalog: Readonly<ToolResultKeyCatalogRecord>;
  try {
    catalog = normalizeToolResultKeyCatalogRecord(
      parseJson(
        rows[0]!,
        'catalogJson',
        64 * 1024,
      ) as ToolResultKeyCatalogRecord,
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

function insertResultKeyBinding(
  client: DatabaseSync,
  binding: Readonly<ToolExecutionResultKeyBinding>,
): void {
  client
    .prepare(
      `INSERT INTO "ToolExecutionResultKeyBindings" (
         start_id, artifact_id, artifact_digest, catalog_authority,
         catalog_generation, catalog_digest, key_id, material_proof,
         binding_digest
       ) VALUES (?, ?, ?, 'trusted-tool-results', ?, ?, ?, ?, ?)`,
    )
    .run(
      binding.startId,
      binding.artifactId,
      binding.artifactDigest,
      binding.catalogGeneration,
      binding.catalogDigest,
      binding.keyId,
      binding.materialProof,
      binding.bindingDigest,
    );
}

export class LocalSqliteToolExecutionCompletionRepository
  implements ToolExecutionCompletionRepository
{
  private readonly authority: LocalSqliteOperationAuthority;
  private readonly client: DatabaseSync;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
    this.client = this.authority.client;
  }

  private enqueue<T>(work: () => T): Promise<T> {
    return this.authority.enqueue(async () => {
      try {
        return work();
      } catch (error) {
        throw mapStorageError(error);
      }
    }, unavailable);
  }

  private findRows(where: string, values: readonly string[]): readonly Row[] {
    return this.client
      .prepare(
        `SELECT ${COMPLETION_SELECT}
         FROM "ToolExecutionCompletions" AS completion
         JOIN "ToolExecutionStartBarriers" AS barrier
           ON barrier.start_id = completion.start_id
         JOIN "StepRunMutations" AS mutation
           ON mutation.mutation_id = completion.step_run_mutation_id
         JOIN "RunEvents" AS event
           ON event.id = completion.run_event_id
         LEFT JOIN "ToolExecutionResultKeyBindings" AS binding
           ON binding.start_id = completion.start_id
          AND binding.artifact_id = completion.artifact_id
         LEFT JOIN "ToolResultKeyCatalogGenerations" AS catalog
           ON catalog.authority = binding.catalog_authority
          AND catalog.generation = binding.catalog_generation
          AND catalog.catalog_digest = binding.catalog_digest
         WHERE ${where}
         LIMIT 2`,
      )
      .all(...values) as Row[];
  }

  findByStartId(
    startIdValue: string,
  ): Promise<Readonly<ToolExecutionCompletionRecord> | null> {
    const startId = identity(startIdValue, 'start id');
    return this.enqueue(() => {
      const rows = this.findRows('completion.start_id = ?', [startId]);
      if (rows.length > 1) throw unavailable();
      return rows[0] ? valuesFromRow(rows[0]).completion : null;
    });
  }

  findResultArtifact(
    artifactIdValue: string,
  ): Promise<Readonly<ToolExecutionResultArtifact> | null> {
    const artifactId = identity(artifactIdValue, 'result Artifact id');
    return this.enqueue(() => {
      const rows = this.findRows('completion.artifact_id = ?', [artifactId]);
      if (rows.length > 1) throw unavailable();
      return rows[0] ? valuesFromRow(rows[0]).artifact : null;
    });
  }

  commit(
    commandValue: ToolExecutionCompletionCommand,
  ): Promise<Readonly<CommitToolExecutionCompletionResult>> {
    const command = normalizeToolExecutionCompletionCommand(commandValue);
    const completion = toolExecutionCompletionRecord(command);
    return this.enqueue(() => {
      let began = false;
      try {
        this.client.exec('BEGIN IMMEDIATE');
        began = true;
        const existing = this.findRows(
          `completion.start_id = ?
           OR completion.artifact_id = ?
           OR completion.step_run_mutation_id = ?
           OR completion.run_event_id = ?`,
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
          this.client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing' as const,
            completion: stored.completion,
          });
        }

        const failureConflict = this.client
          .prepare(
            `SELECT 1
             FROM "ToolExecutionFailureCompletions"
             WHERE start_id = ? OR step_run_mutation_id = ?
               OR run_event_id = ?
               OR (
                 run_id = ? AND step_run_id = ?
                 AND completed_step_run_version = ?
               )
             LIMIT 1`,
          )
          .get(
            completion.startId,
            completion.stepRunMutationId,
            completion.runEventId,
            completion.runId,
            completion.stepRunId,
            completion.completedStepRunVersion,
          );
        if (failureConflict) {
          throw new ToolExecutionCompletionConflictError();
        }

        const mutation = command.stepRunMutation;
        const resultKeyBinding = resultKeyBindingForCurrentCatalog(
          this.client,
          command,
        );
        const current = this.client
          .prepare(
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
             FROM "ToolExecutionStartBarriers" AS barrier
             JOIN "StepRunMutations" AS start_mutation
               ON start_mutation.mutation_id = barrier.step_run_mutation_id
             JOIN "StepRuns" AS step
               ON step.id = barrier.step_run_id
              AND step.run_id = barrier.run_id
             JOIN "Runs" AS run ON run.id = barrier.run_id
             WHERE barrier.start_id = ?
             LIMIT 2`,
          )
          .all(completion.startId) as Row[];
        const row = current[0];
        if (
          current.length !== 1 ||
          !row ||
          requiredText(row, 'barrierJson') !==
            JSON.stringify(command.barrier) ||
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

        updateStepRun(this.client, mutation);
        updateRun(this.client, mutation);
        insertRunEvent(this.client, mutation);
        insertMutation(this.client, mutation);
        insertCompletion(this.client, completion, command.resultArtifact);
        insertResultKeyBinding(this.client, resultKeyBinding);
        this.client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'created' as const,
          completion,
        });
      } catch (error) {
        if (began && this.client.isTransaction) {
          try {
            this.client.exec('ROLLBACK');
          } catch {
            // Preserve the original failure; shared authority owns close.
          }
        }
        throw error;
      }
    });
  }
}
