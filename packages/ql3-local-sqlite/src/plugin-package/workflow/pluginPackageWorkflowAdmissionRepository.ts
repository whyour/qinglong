import type { DatabaseSync } from 'node:sqlite';

import {
  normalizePluginPackageAutomationPublication,
  type PluginPackageAutomationPublication,
} from '@qinglong/runtime-core/plugin-package-automation-publication';
import {
  InvalidPluginPackageWorkflowAdministrationMutationError,
  PluginPackageWorkflowAdministrationAuthorizationFenceConflictError,
  PluginPackageWorkflowAdministrationMutationConflictError,
} from '@qinglong/runtime-core/plugin-package-workflow-administration';
import {
  createPluginPackageWorkflowAdmissionBundle,
  InvalidPluginPackageWorkflowExecutionPlanError,
  normalizePluginPackageWorkflowAdmissionReceipt,
  normalizePluginPackageWorkflowExecutionPlan,
  pluginPackageWorkflowDefinitionDigest,
  PluginPackageWorkflowAdmissionConflictError,
  PluginPackageWorkflowAdmissionNotAllowedError,
  PluginPackageWorkflowAdmissionUnavailableError,
  type PluginPackageWorkflowAdmissionBundle,
  type PluginPackageWorkflowAdmissionReceipt,
  type PluginPackageWorkflowAdmissionRepository,
  type PluginPackageWorkflowExecutionPlan,
} from '@qinglong/runtime-core/plugin-package-workflow-execution-plan';
import {
  normalizeStepRunRecord,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';

import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';

type Row = Record<string, unknown>;

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKFLOW_RUN_STATUSES = new Set([
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    throw new InvalidPluginPackageWorkflowExecutionPlanError(
      `${label} is invalid`,
    );
  }
  return value;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new PluginPackageWorkflowAdmissionUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PluginPackageWorkflowAdmissionUnavailableError();
  }
  return value as number;
}

function sqliteConstraint(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const errcode = (error as { errcode?: unknown }).errcode;
  return (
    (typeof code === 'string' &&
      (code === 'ERR_SQLITE_CONSTRAINT' ||
        code.startsWith('SQLITE_CONSTRAINT') ||
        code.startsWith('ERR_SQLITE_CONSTRAINT'))) ||
    (typeof errcode === 'number' && (errcode & 0xff) === 19)
  );
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackageWorkflowAdministrationMutationError ||
    error instanceof
      PluginPackageWorkflowAdministrationAuthorizationFenceConflictError ||
    error instanceof PluginPackageWorkflowAdministrationMutationConflictError ||
    error instanceof InvalidPluginPackageWorkflowExecutionPlanError ||
    error instanceof PluginPackageWorkflowAdmissionConflictError ||
    error instanceof PluginPackageWorkflowAdmissionNotAllowedError ||
    error instanceof PluginPackageWorkflowAdmissionUnavailableError
  ) {
    return error;
  }
  if (sqliteConstraint(error)) {
    return new PluginPackageWorkflowAdmissionConflictError(
      'durable Run, plan, StepRun, event, or receipt identity changed',
    );
  }
  return new PluginPackageWorkflowAdmissionUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export interface LocalSqlitePluginPackageWorkflowAdmissionTransactionContext {
  readonly replay: boolean;
  readonly plan: Readonly<PluginPackageWorkflowExecutionPlan>;
  readonly receipt: Readonly<PluginPackageWorkflowAdmissionReceipt>;
}

export type LocalSqlitePluginPackageWorkflowAdmissionTransactionGuard = (
  context: Readonly<LocalSqlitePluginPackageWorkflowAdmissionTransactionContext>,
) => void;

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function exactArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function insertRun(
  client: DatabaseSync,
  bundle: Readonly<PluginPackageWorkflowAdmissionBundle>,
): void {
  const run = bundle.run;
  client
    .prepare(
      `INSERT INTO "Runs" (
         id, project_id, task_id, task_revision, task_snapshot_ref,
         trigger_type, execution_origin, execution_owner, request_id,
         status, version, event_sequence, priority, idempotency_key,
         created_at_ms, started_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run.id,
      run.projectId,
      run.taskId,
      run.taskRevision,
      run.taskSnapshotRef ?? null,
      run.triggerType,
      run.executionOrigin,
      run.executionOwner,
      run.requestId ?? null,
      run.status,
      run.version,
      run.eventSequence,
      run.priority,
      run.idempotencyKey ?? null,
      run.createdAtMs,
      run.startedAtMs ?? null,
    );
}

function insertAdmissionEvent(
  client: DatabaseSync,
  bundle: Readonly<PluginPackageWorkflowAdmissionBundle>,
): void {
  const event = bundle.admissionEvent;
  client
    .prepare(
      `INSERT INTO "RunEvents" (
         id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
         attempt_id, step_run_id, payload, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(
      event.id,
      event.runId,
      event.sequence,
      event.type,
      event.dedupeKey ?? null,
      event.actorType,
      event.actorId ?? null,
      canonicalJson(event.payload),
      event.createdAtMs,
    );
}

function insertStepEvidence(
  client: DatabaseSync,
  bundle: Readonly<PluginPackageWorkflowAdmissionBundle>,
): void {
  for (const mutation of bundle.stepMutations) {
    const stepRun = mutation.stepRun;
    const event = mutation.event;
    client
      .prepare(
        `INSERT INTO "StepRuns" (
           id, run_id, parent_step_run_id, step_key, kind, definition_ref,
           definition_digest, required, status, version, attempt_count,
           input_ref, output_ref, approval_request_id, ready_at_ms,
           started_at_ms, finished_at_ms, result_code, error_summary,
           created_at_ms, updated_at_ms, last_mutation_id, step_run_digest,
           step_run_json
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?
         )`,
      )
      .run(
        stepRun.id,
        stepRun.runId,
        stepRun.parentStepRunId,
        stepRun.stepKey,
        stepRun.kind,
        stepRun.definitionRef,
        stepRun.definitionDigest,
        stepRun.required ? 1 : 0,
        stepRun.status,
        stepRun.version,
        stepRun.attemptCount,
        stepRun.inputRef,
        stepRun.outputRef,
        stepRun.approvalRequestId,
        stepRun.readyAtMs,
        stepRun.startedAtMs,
        stepRun.finishedAtMs,
        stepRun.resultCode,
        stepRun.errorSummary,
        stepRun.createdAtMs,
        stepRun.updatedAtMs,
        stepRun.lastMutationId,
        stepRun.stepRunDigest,
        canonicalJson(stepRun),
      );
    client
      .prepare(
        `INSERT INTO "RunEvents" (
           id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
           attempt_id, step_run_id, payload, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.runId,
        event.sequence,
        event.type,
        event.dedupeKey ?? null,
        event.actorType,
        event.actorId ?? null,
        stepRun.id,
        canonicalJson(event.payload),
        event.createdAtMs,
      );
    client
      .prepare(
        `INSERT INTO "StepRunMutations" (
           mutation_id, mutation_digest, run_id, step_run_id,
           step_run_digest, event_id, event_sequence, run_version,
           step_run_json, committed_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mutation.mutationId,
        mutation.mutationDigest,
        mutation.runId,
        stepRun.id,
        stepRun.stepRunDigest,
        event.id,
        event.sequence,
        mutation.expectedRunVersion + 1,
        canonicalJson(stepRun),
        bundle.receipt.admittedAtMs,
      );
  }
}

function insertAdmission(
  client: DatabaseSync,
  bundle: Readonly<PluginPackageWorkflowAdmissionBundle>,
): void {
  const { plan, receipt } = bundle;
  const target = plan.target;
  client
    .prepare(
      `INSERT INTO "QingLong3PluginPackageWorkflowAdmissions" (
         plan_digest, plan_id, run_id, project_id, package_name,
         installation_id, lock_digest, generation, generation_digest,
         materialized_revision_digest, publication_digest, workflow_id,
         workflow_definition_digest, step_count, admitted_at_ms,
         final_run_version, final_run_event_sequence, receipt_digest,
         plan_json, receipt_json
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`,
    )
    .run(
      plan.planDigest,
      plan.planId,
      plan.runId,
      target.projectId,
      target.packageName,
      target.installationId,
      target.lockDigest,
      target.generation,
      target.generationDigest,
      target.materializedRevisionDigest,
      target.publicationDigest,
      target.workflowId,
      target.workflowDefinitionDigest,
      plan.steps.length,
      receipt.admittedAtMs,
      receipt.finalRunVersion,
      receipt.finalRunEventSequence,
      receipt.receiptDigest,
      canonicalJson(plan),
      canonicalJson(receipt),
    );
  for (const step of plan.steps) {
    const mutation = bundle.stepMutations.find(
      (candidate) => candidate.stepRun.stepKey === step.stepKey,
    );
    if (!mutation) {
      throw new PluginPackageWorkflowAdmissionUnavailableError();
    }
    client
      .prepare(
        `INSERT INTO "QingLong3PluginPackageWorkflowAdmissionSteps" (
           plan_digest, run_id, step_key, step_run_id, task_id,
           task_definition_ref, task_definition_digest, needs_json,
           initial_status, mutation_id, event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.planDigest,
        plan.runId,
        step.stepKey,
        step.stepRunId,
        step.taskId,
        step.taskDefinitionRef,
        step.taskDefinitionDigest,
        canonicalJson(step.needs),
        step.initialStatus,
        mutation.mutationId,
        mutation.event.id,
      );
  }
}

export class LocalSqlitePluginPackageWorkflowAdmissionRepository
  implements PluginPackageWorkflowAdmissionRepository
{
  readonly #authority: LocalSqliteOperationAuthority;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.#authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
  }

  #enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    return this.#authority.enqueue(
      async () => {
        try {
          return await work();
        } catch (error) {
          throw mapStorageError(error);
        }
      },
      () => new PluginPackageWorkflowAdmissionUnavailableError(),
    );
  }

  #select(where: string, value: string): Row | undefined {
    return this.#authority.client
      .prepare(
        `SELECT
           plan_digest AS "planDigest", plan_id AS "planId",
           run_id AS "runId", project_id AS "projectId",
           package_name AS "packageName",
           installation_id AS "installationId",
           lock_digest AS "lockDigest", generation,
           generation_digest AS "generationDigest",
           materialized_revision_digest AS "materializedRevisionDigest",
           publication_digest AS "publicationDigest",
           workflow_id AS "workflowId",
           workflow_definition_digest AS "workflowDefinitionDigest",
           step_count AS "stepCount", admitted_at_ms AS "admittedAtMs",
           final_run_version AS "finalRunVersion",
           final_run_event_sequence AS "finalRunEventSequence",
           receipt_digest AS "receiptDigest", plan_json AS "planJson",
           receipt_json AS "receiptJson"
         FROM "QingLong3PluginPackageWorkflowAdmissions"
         WHERE ${where} LIMIT 2`,
      )
      .get(value) as Row | undefined;
  }

  #parse(row: Row): Readonly<{
    plan: Readonly<PluginPackageWorkflowExecutionPlan>;
    receipt: Readonly<PluginPackageWorkflowAdmissionReceipt>;
    bundle: Readonly<PluginPackageWorkflowAdmissionBundle>;
  }> {
    try {
      const plan = normalizePluginPackageWorkflowExecutionPlan(
        JSON.parse(text(row, 'planJson')) as PluginPackageWorkflowExecutionPlan,
      );
      const receipt = normalizePluginPackageWorkflowAdmissionReceipt(
        JSON.parse(
          text(row, 'receiptJson'),
        ) as PluginPackageWorkflowAdmissionReceipt,
      );
      const bundle = createPluginPackageWorkflowAdmissionBundle(plan);
      if (
        plan.planDigest !== text(row, 'planDigest') ||
        plan.planId !== text(row, 'planId') ||
        plan.runId !== text(row, 'runId') ||
        plan.target.projectId !== text(row, 'projectId') ||
        plan.target.packageName !== text(row, 'packageName') ||
        plan.target.installationId !== text(row, 'installationId') ||
        plan.target.lockDigest !== text(row, 'lockDigest') ||
        plan.target.generation !== integer(row, 'generation') ||
        plan.target.generationDigest !== text(row, 'generationDigest') ||
        plan.target.materializedRevisionDigest !==
          text(row, 'materializedRevisionDigest') ||
        plan.target.publicationDigest !== text(row, 'publicationDigest') ||
        plan.target.workflowId !== text(row, 'workflowId') ||
        plan.target.workflowDefinitionDigest !==
          text(row, 'workflowDefinitionDigest') ||
        plan.steps.length !== integer(row, 'stepCount') ||
        receipt.admittedAtMs !== integer(row, 'admittedAtMs') ||
        receipt.finalRunVersion !== integer(row, 'finalRunVersion') ||
        receipt.finalRunEventSequence !==
          integer(row, 'finalRunEventSequence') ||
        receipt.receiptDigest !== text(row, 'receiptDigest') ||
        canonicalJson(bundle.receipt) !== canonicalJson(receipt)
      ) {
        throw new PluginPackageWorkflowAdmissionUnavailableError();
      }
      this.#assertStoredEvidence(bundle);
      return Object.freeze({ plan, receipt, bundle });
    } catch (error) {
      if (error instanceof PluginPackageWorkflowAdmissionUnavailableError) {
        throw error;
      }
      throw new PluginPackageWorkflowAdmissionUnavailableError();
    }
  }

  #assertStoredEvidence(
    bundle: Readonly<PluginPackageWorkflowAdmissionBundle>,
  ): void {
    const run = bundle.run;
    const storedRun = this.#authority.client
      .prepare(
        `SELECT project_id AS "projectId", task_id AS "taskId",
                task_revision AS "taskRevision",
                task_snapshot_ref AS "taskSnapshotRef",
                trigger_type AS "triggerType",
                execution_origin AS "executionOrigin",
                execution_owner AS "executionOwner",
                request_id AS "requestId", status, version,
                event_sequence AS "eventSequence", priority,
                idempotency_key AS "idempotencyKey",
                created_at_ms AS "createdAtMs",
                started_at_ms AS "startedAtMs"
         FROM "Runs" WHERE id = ?`,
      )
      .get(run.id) as Row | undefined;
    const storedRunVersion = storedRun ? integer(storedRun, 'version') : -1;
    const storedEventSequence = storedRun
      ? integer(storedRun, 'eventSequence')
      : -1;
    if (
      !storedRun ||
      text(storedRun, 'projectId') !== run.projectId ||
      text(storedRun, 'taskId') !== run.taskId ||
      text(storedRun, 'taskRevision') !== run.taskRevision ||
      text(storedRun, 'taskSnapshotRef') !== run.taskSnapshotRef ||
      text(storedRun, 'triggerType') !== run.triggerType ||
      text(storedRun, 'executionOrigin') !== run.executionOrigin ||
      text(storedRun, 'executionOwner') !== run.executionOwner ||
      text(storedRun, 'requestId') !== run.requestId ||
      !WORKFLOW_RUN_STATUSES.has(text(storedRun, 'status')) ||
      storedRunVersion < run.version ||
      storedEventSequence < run.eventSequence ||
      storedRunVersion !== storedEventSequence ||
      integer(storedRun, 'priority') !== run.priority ||
      text(storedRun, 'idempotencyKey') !== run.idempotencyKey ||
      integer(storedRun, 'createdAtMs') !== run.createdAtMs ||
      integer(storedRun, 'startedAtMs') !== run.startedAtMs
    ) {
      throw new PluginPackageWorkflowAdmissionUnavailableError();
    }
    const events = this.#authority.client
      .prepare(
        `SELECT id, sequence, type, dedupe_key AS "dedupeKey",
                actor_type AS "actorType", actor_id AS "actorId",
                step_run_id AS "stepRunId", payload,
                created_at_ms AS "createdAtMs"
         FROM "RunEvents"
         WHERE run_id = ? AND sequence <= ?
         ORDER BY sequence`,
      )
      .all(run.id, bundle.receipt.finalRunEventSequence) as Row[];
    const expectedEvents = [
      bundle.admissionEvent,
      ...bundle.stepMutations.map(({ event }) => event),
    ];
    if (
      events.length !== expectedEvents.length ||
      events.some((row, index) => {
        const event = expectedEvents[index]!;
        return (
          text(row, 'id') !== event.id ||
          integer(row, 'sequence') !== event.sequence ||
          text(row, 'type') !== event.type ||
          text(row, 'dedupeKey') !== event.dedupeKey ||
          text(row, 'actorType') !== event.actorType ||
          (row.actorId === null ? undefined : row.actorId) !== event.actorId ||
          (row.stepRunId === null ? undefined : row.stepRunId) !==
            event.stepRunId ||
          text(row, 'payload') !== canonicalJson(event.payload) ||
          integer(row, 'createdAtMs') !== event.createdAtMs
        );
      })
    ) {
      throw new PluginPackageWorkflowAdmissionUnavailableError();
    }
    for (const mutation of bundle.stepMutations) {
      const row = this.#authority.client
        .prepare(
          `SELECT
             step.step_key AS "stepKey", step.step_run_id AS "stepRunId",
             step.task_id AS "taskId",
             step.task_definition_ref AS "taskDefinitionRef",
             step.task_definition_digest AS "taskDefinitionDigest",
             step.needs_json AS "needsJson",
             step.initial_status AS "initialStatus",
             step.mutation_id AS "mutationId", step.event_id AS "eventId",
             runtime.step_key AS "currentStepKey",
             runtime.kind AS "currentKind",
             runtime.definition_ref AS "currentDefinitionRef",
             runtime.definition_digest AS "currentDefinitionDigest",
             runtime.required AS "currentRequired",
             runtime.status AS "currentStatus",
             runtime.version AS "currentVersion",
             runtime.last_mutation_id AS "currentLastMutationId",
             runtime.step_run_digest AS "currentStepRunDigest",
             runtime.step_run_json AS "currentStepRunJson",
             mutation.mutation_digest AS "mutationDigest",
             mutation.event_sequence AS "eventSequence",
             mutation.run_version AS "runVersion",
             mutation.step_run_digest AS "initialStepRunDigest",
             mutation.step_run_json AS "initialStepRunJson"
           FROM "QingLong3PluginPackageWorkflowAdmissionSteps" AS step
           JOIN "StepRuns" AS runtime
             ON runtime.run_id = step.run_id
            AND runtime.id = step.step_run_id
           JOIN "StepRunMutations" AS mutation
             ON mutation.mutation_id = step.mutation_id
           WHERE step.plan_digest = ? AND step.step_key = ?`,
        )
        .get(bundle.plan.planDigest, mutation.stepRun.stepKey) as
        | Row
        | undefined;
      const planStep = bundle.plan.steps.find(
        ({ stepKey }) => stepKey === mutation.stepRun.stepKey,
      );
      let currentStepRun: Readonly<StepRunRecord> | null = null;
      if (row) {
        try {
          currentStepRun = normalizeStepRunRecord(
            JSON.parse(text(row, 'currentStepRunJson')) as StepRunRecord,
          );
        } catch {
          throw new PluginPackageWorkflowAdmissionUnavailableError();
        }
      }
      if (
        !row ||
        !planStep ||
        !currentStepRun ||
        text(row, 'stepRunId') !== mutation.stepRun.id ||
        text(row, 'taskId') !== planStep.taskId ||
        text(row, 'taskDefinitionRef') !== planStep.taskDefinitionRef ||
        text(row, 'taskDefinitionDigest') !== planStep.taskDefinitionDigest ||
        text(row, 'needsJson') !== canonicalJson(planStep.needs) ||
        text(row, 'initialStatus') !== planStep.initialStatus ||
        text(row, 'mutationId') !== mutation.mutationId ||
        text(row, 'eventId') !== mutation.event.id ||
        text(row, 'mutationDigest') !== mutation.mutationDigest ||
        integer(row, 'eventSequence') !== mutation.event.sequence ||
        integer(row, 'runVersion') !== mutation.expectedRunVersion + 1 ||
        text(row, 'initialStepRunDigest') !== mutation.stepRun.stepRunDigest ||
        text(row, 'initialStepRunJson') !== canonicalJson(mutation.stepRun) ||
        currentStepRun.id !== mutation.stepRun.id ||
        currentStepRun.runId !== mutation.runId ||
        currentStepRun.stepKey !== planStep.stepKey ||
        currentStepRun.kind !== 'task' ||
        currentStepRun.definitionRef !== planStep.taskDefinitionRef ||
        currentStepRun.definitionDigest !== planStep.taskDefinitionDigest ||
        currentStepRun.required !== planStep.required ||
        currentStepRun.version < mutation.stepRun.version ||
        text(row, 'currentStepKey') !== currentStepRun.stepKey ||
        text(row, 'currentKind') !== currentStepRun.kind ||
        text(row, 'currentDefinitionRef') !== currentStepRun.definitionRef ||
        text(row, 'currentDefinitionDigest') !==
          currentStepRun.definitionDigest ||
        integer(row, 'currentRequired') !== (currentStepRun.required ? 1 : 0) ||
        text(row, 'currentStatus') !== currentStepRun.status ||
        integer(row, 'currentVersion') !== currentStepRun.version ||
        text(row, 'currentLastMutationId') !== currentStepRun.lastMutationId ||
        text(row, 'currentStepRunDigest') !== currentStepRun.stepRunDigest
      ) {
        throw new PluginPackageWorkflowAdmissionUnavailableError();
      }
    }
  }

  #find(
    where: string,
    value: string,
  ): Readonly<{
    plan: Readonly<PluginPackageWorkflowExecutionPlan>;
    receipt: Readonly<PluginPackageWorkflowAdmissionReceipt>;
    bundle: Readonly<PluginPackageWorkflowAdmissionBundle>;
  }> | null {
    const row = this.#select(where, value);
    return row ? this.#parse(row) : null;
  }

  #assertCurrentTarget(
    plan: Readonly<PluginPackageWorkflowExecutionPlan>,
  ): void {
    const guard = this.#authority.client
      .prepare(
        `SELECT publication.publication_json AS "publicationJson"
         FROM "QingLong3PluginPackageAutomationPublicationHeads" AS head
         JOIN "QingLong3PluginPackageAutomationPublications" AS publication
           ON publication.publication_digest = head.publication_digest
         JOIN "QingLong3PluginPackageInstallHeads" AS install_head
           ON install_head.project_id = publication.project_id
          AND install_head.package_name = publication.package_name
          AND install_head.installation_id = publication.installation_id
         JOIN "QingLong3PluginPackageInstalls" AS install
           ON install.installation_id = install_head.installation_id
          AND install.lock_digest = publication.lock_digest
         LEFT JOIN "QingLong3PluginPackageLifecycleHeads" AS lifecycle
           ON lifecycle.project_id = publication.project_id
          AND lifecycle.package_name = publication.package_name
         WHERE head.project_id = ?
           AND head.package_name = ?
           AND head.publication_digest = ?
           AND publication.state = 'active'
           AND install.state = 'active'
           AND install.active_lock_digest = publication.lock_digest
           AND (
             lifecycle.event_digest IS NULL OR
             lifecycle.disposition = 'active'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM "QingLong3PluginPackageQuarantineEvents" AS quarantine
             WHERE quarantine.project_id = publication.project_id
               AND quarantine.package_name = publication.package_name
               AND quarantine.installation_id = publication.installation_id
               AND quarantine.lock_digest = publication.lock_digest
           )`,
      )
      .get(
        plan.target.projectId,
        plan.target.packageName,
        plan.target.publicationDigest,
      ) as Row | undefined;
    if (!guard) throw new PluginPackageWorkflowAdmissionNotAllowedError();

    let publication: Readonly<PluginPackageAutomationPublication>;
    try {
      publication = normalizePluginPackageAutomationPublication(
        JSON.parse(
          text(guard, 'publicationJson'),
        ) as PluginPackageAutomationPublication,
      );
    } catch {
      throw new PluginPackageWorkflowAdmissionUnavailableError();
    }
    const target = plan.target;
    const workflow = publication.definitions.workflows.find(
      ({ id }) => id === target.workflowId,
    );
    if (
      publication.publicationDigest !== target.publicationDigest ||
      publication.target.projectId !== target.projectId ||
      publication.target.packageName !== target.packageName ||
      publication.target.installationId !== target.installationId ||
      publication.target.lockDigest !== target.lockDigest ||
      publication.target.generation !== target.generation ||
      publication.target.generationDigest !== target.generationDigest ||
      publication.target.materializedRevisionDigest !==
        target.materializedRevisionDigest ||
      publication.state !== 'active' ||
      !workflow ||
      !workflow.enabled ||
      pluginPackageWorkflowDefinitionDigest(workflow) !==
        target.workflowDefinitionDigest ||
      workflow.steps.length !== plan.steps.length
    ) {
      throw new PluginPackageWorkflowAdmissionConflictError(
        'the exact Workflow publication drifted',
      );
    }

    const revision = this.#authority.client
      .prepare(
        `SELECT revision_json AS "revisionJson"
         FROM "QingLong3PluginPackageMaterializedRevisions"
         WHERE generation_digest = ?
           AND project_id = ?
           AND package_name = ?
           AND generation = ?
           AND lock_digest = ?
           AND revision_digest = ?`,
      )
      .get(
        target.generationDigest,
        target.projectId,
        target.packageName,
        target.generation,
        target.lockDigest,
        target.materializedRevisionDigest,
      ) as Row | undefined;
    if (!revision) {
      throw new PluginPackageWorkflowAdmissionConflictError(
        'the exact materialized revision is absent',
      );
    }
    let resources: unknown;
    try {
      const parsed = JSON.parse(text(revision, 'revisionJson')) as {
        resources?: unknown;
      };
      resources = parsed.resources;
    } catch {
      throw new PluginPackageWorkflowAdmissionUnavailableError();
    }
    if (!Array.isArray(resources)) {
      throw new PluginPackageWorkflowAdmissionUnavailableError();
    }
    for (const step of plan.steps) {
      const workflowStep = workflow.steps.find(({ id }) => id === step.stepKey);
      const matches = resources.filter((resource) => {
        if (!resource || typeof resource !== 'object') return false;
        const candidate = resource as {
          kind?: unknown;
          sourceDigest?: unknown;
          value?: {
            id?: unknown;
            enabled?: unknown;
          };
        };
        return (
          candidate.kind === 'task' &&
          candidate.sourceDigest === step.taskDefinitionDigest &&
          candidate.value?.id === step.taskId &&
          candidate.value.enabled === true
        );
      });
      if (
        !workflowStep ||
        workflowStep.task !== step.taskId ||
        !exactArray(workflowStep.needs, step.needs) ||
        step.initialStatus !==
          (workflowStep.needs.length === 0 ? 'ready' : 'pending') ||
        step.taskDefinitionRef !==
          `plugin-package:${target.materializedRevisionDigest}:task:${step.taskId}` ||
        matches.length !== 1
      ) {
        throw new PluginPackageWorkflowAdmissionConflictError(
          'the exact Workflow step or Task evidence drifted',
        );
      }
    }
  }

  findByPlanId(
    planIdValue: string,
  ): Promise<Readonly<PluginPackageWorkflowAdmissionReceipt> | null> {
    const planId = identity(planIdValue, 'planId');
    return this.#enqueue(
      () => this.#find('plan_id = ?', planId)?.receipt ?? null,
    );
  }

  findByRunId(
    runIdValue: string,
  ): Promise<Readonly<PluginPackageWorkflowAdmissionReceipt> | null> {
    const runId = identity(runIdValue, 'runId');
    return this.#enqueue(
      () => this.#find('run_id = ?', runId)?.receipt ?? null,
    );
  }

  findPlanByPlanId(
    planIdValue: string,
  ): Promise<Readonly<PluginPackageWorkflowExecutionPlan> | null> {
    const planId = identity(planIdValue, 'planId');
    return this.#enqueue(() => this.#find('plan_id = ?', planId)?.plan ?? null);
  }

  admit(
    planValue: Readonly<PluginPackageWorkflowExecutionPlan>,
    transactionGuard?: LocalSqlitePluginPackageWorkflowAdmissionTransactionGuard,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackageWorkflowAdmissionReceipt>;
    }>
  > {
    if (
      transactionGuard !== undefined &&
      typeof transactionGuard !== 'function'
    ) {
      return Promise.reject(
        new InvalidPluginPackageWorkflowExecutionPlanError(
          'transaction guard is invalid',
        ),
      );
    }
    const plan = normalizePluginPackageWorkflowExecutionPlan(planValue);
    const bundle = createPluginPackageWorkflowAdmissionBundle(plan);
    return this.#enqueue(() => {
      let began = false;
      try {
        this.#authority.client.exec('BEGIN IMMEDIATE');
        began = true;
        const existing = this.#find('plan_id = ?', plan.planId);
        if (existing) {
          if (
            existing.plan.planDigest !== plan.planDigest ||
            canonicalJson(existing.plan) !== canonicalJson(plan)
          ) {
            throw new PluginPackageWorkflowAdmissionConflictError(
              'planId is already bound to another plan',
            );
          }
          transactionGuard?.(
            Object.freeze({
              replay: true,
              plan: existing.plan,
              receipt: existing.receipt,
            }),
          );
          this.#authority.client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing' as const,
            receipt: existing.receipt,
          });
        }
        transactionGuard?.(
          Object.freeze({
            replay: false,
            plan,
            receipt: bundle.receipt,
          }),
        );
        this.#assertCurrentTarget(plan);
        insertRun(this.#authority.client, bundle);
        insertAdmissionEvent(this.#authority.client, bundle);
        insertStepEvidence(this.#authority.client, bundle);
        insertAdmission(this.#authority.client, bundle);
        this.#authority.client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'created' as const,
          receipt: bundle.receipt,
        });
      } finally {
        if (began) {
          try {
            this.#authority.client.exec('ROLLBACK');
          } catch {
            // Preserve the original fail-closed error.
          }
        }
      }
    });
  }
}
