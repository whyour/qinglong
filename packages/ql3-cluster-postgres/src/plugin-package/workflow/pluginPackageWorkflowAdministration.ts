// PostgreSQL authorization authority for Plugin Package Workflow admission.
import {
  RUN_CANCELLATION_REASONS,
  RUN_STATUSES,
  type PostgresClient,
  type PostgresPool,
  type RunCancellationReason,
  type RunStatus,
} from '@qinglong/runtime-core';
import {
  InvalidPluginPackageWorkflowAdministrationMutationError,
  PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_SCHEMA,
  PLUGIN_PACKAGE_WORKFLOW_RUN_INSPECTION_SCHEMA,
  PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_SCHEMA,
  PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_SCHEMA,
  PluginPackageWorkflowAdministrationAuthorizationFenceConflictError,
  PluginPackageWorkflowAdministrationMutationConflictError,
  normalizeAuthorizedPluginPackageWorkflowRunEventList,
  normalizeAuthorizedPluginPackageWorkflowRunInspection,
  normalizeAuthorizedPluginPackageWorkflowRunList,
  normalizeAuthorizedPluginPackageWorkflowStepRunList,
  normalizeAuthorizedPluginPackageWorkflowAdmission,
  normalizePluginPackageWorkflowRunEventListResult,
  normalizePluginPackageWorkflowRunInspectionResult,
  normalizePluginPackageWorkflowRunListResult,
  normalizePluginPackageWorkflowStepRunListResult,
  type AuthorizedPluginPackageWorkflowAdmission,
  type AuthorizedPluginPackageWorkflowRunEventList,
  type AuthorizedPluginPackageWorkflowRunInspection,
  type AuthorizedPluginPackageWorkflowRunList,
  type AuthorizedPluginPackageWorkflowStepRunList,
  type PluginPackageWorkflowAdministrationRepository,
  type PluginPackageWorkflowRunEventListRepository,
  type PluginPackageWorkflowRunEventListResult,
  type PluginPackageWorkflowRunInspectionRepository,
  type PluginPackageWorkflowRunInspectionResult,
  type PluginPackageWorkflowRunListRepository,
  type PluginPackageWorkflowRunListResult,
  type PluginPackageWorkflowStepRunListItem,
  type PluginPackageWorkflowStepRunListRepository,
  type PluginPackageWorkflowStepRunListResult,
} from '@qinglong/runtime-core/plugin-package-workflow-administration';
import type { PluginPackageWorkflowExecutionPlan } from '@qinglong/runtime-core/plugin-package-workflow-execution-plan';
import {
  STEP_RUN_STATUSES,
  type StepRunStatus,
} from '@qinglong/runtime-core/step-run';

import { PostgresPluginPackageWorkflowAdmissionRepository } from './pluginPackageWorkflowAdmissionRepository';
import {
  configureAdministrationTransaction,
  insertAdministrationAudit,
  requiredInteger,
  requiredString,
  rollbackAdministrationTransaction,
} from '../../repository/administrationSupport';

type Row = Record<string, unknown>;

const API_CREDENTIAL_AUTHENTICATION =
  /^api_credential:([A-Za-z0-9][A-Za-z0-9._:-]{0,63}):([1-9]\d*)$/;

interface WorkflowAuthorizationContext {
  readonly projectId: string;
  readonly actor: AuthorizedPluginPackageWorkflowAdmission['actor'];
  readonly fence: AuthorizedPluginPackageWorkflowAdmission['fence'];
  readonly audit: AuthorizedPluginPackageWorkflowAdmission['audit'];
}

function integer(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function nullableInteger(row: Row, name: string): number | null {
  if (row[name] === null) return null;
  return requiredInteger(row, name);
}

function nullableString(row: Row, name: string): string | null {
  if (row[name] === null) return null;
  return requiredString(row, name);
}

function mutationConflict(): never {
  throw new PluginPackageWorkflowAdministrationMutationConflictError();
}

function fenceConflict(): never {
  throw new PluginPackageWorkflowAdministrationAuthorizationFenceConflictError();
}

async function confirmCredential(
  client: PostgresClient,
  authorization: Readonly<WorkflowAuthorizationContext>,
): Promise<void> {
  const match = API_CREDENTIAL_AUTHENTICATION.exec(
    authorization.audit.authenticationId ?? '',
  );
  const credentialVersion = integer(match?.[2]);
  if (!match || credentialVersion === null || credentialVersion < 1) {
    return fenceConflict();
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `ql3-api-credential:${match[1]}`,
  ]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `ql3-identity:${authorization.actor.type}:${authorization.actor.id}`,
  ]);
  const result = await client.query<Row>(
    `SELECT credential.version,
            credential.state,
            credential.subject_type AS "subjectType",
            credential.subject_id AS "subjectId",
            credential.not_before_at_ms AS "notBeforeAtMs",
            credential.expires_at_ms AS "expiresAtMs",
            subject.status AS "subjectStatus",
            floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
              AS "nowMs"
     FROM "ql3"."api_credentials" AS credential
     JOIN "ql3"."identity_subjects" AS subject
       ON subject.subject_type = credential.subject_type
      AND subject.subject_id = credential.subject_id
     WHERE credential.credential_id = $1
     ORDER BY credential.version DESC
     LIMIT 1`,
    [match[1]],
  );
  const row = result.rows.length === 1 ? result.rows[0]! : null;
  const nowMs = integer(row?.nowMs);
  if (
    !row ||
    result.rows.length !== 1 ||
    integer(row.version) !== credentialVersion ||
    row.state !== 'active' ||
    row.subjectStatus !== 'active' ||
    row.subjectType !== authorization.actor.type ||
    row.subjectId !== authorization.actor.id ||
    nowMs === null ||
    (integer(row.notBeforeAtMs) ?? Number.MAX_SAFE_INTEGER) > nowMs ||
    (integer(row.expiresAtMs) ?? -1) <= nowMs
  ) {
    return fenceConflict();
  }
}

async function confirmProjectPolicyFence(
  client: PostgresClient,
  authorization: Readonly<WorkflowAuthorizationContext>,
): Promise<void> {
  const project = await client.query<Row>(
    `SELECT status, version
     FROM "ql3"."projects"
     WHERE id = $1
     LIMIT 1
     FOR SHARE`,
    [authorization.projectId],
  );
  const projectRow = project.rows.length === 1 ? project.rows[0]! : null;
  if (
    !projectRow ||
    projectRow.status !== 'active' ||
    integer(projectRow.version) !== authorization.fence.projectVersion
  ) {
    return fenceConflict();
  }
  const binding = await client.query<Row>(
    `SELECT version, state
     FROM "ql3"."project_role_bindings"
     WHERE project_id = $1
       AND subject_type = $2
       AND subject_id = $3
     ORDER BY version DESC
     LIMIT 1`,
    [authorization.projectId, authorization.actor.type, authorization.actor.id],
  );
  const bindingRow = binding.rows.length === 1 ? binding.rows[0]! : null;
  if (
    !bindingRow ||
    bindingRow.state !== 'active' ||
    integer(bindingRow.version) !== authorization.fence.bindingVersion
  ) {
    return fenceConflict();
  }
}

async function insertAtomicAudit(
  client: PostgresClient,
  admission: Readonly<AuthorizedPluginPackageWorkflowAdmission>,
  replay: boolean,
): Promise<void> {
  if (replay) return;
  const audit = admission.audit;
  await client.query(
    `INSERT INTO "ql3"."security_audit_events" (
       event_id, request_id, operation_id, project_id,
       subject_type, subject_id, authentication_id, outcome, reasons,
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
}

/**
 * Adds API credential, Project Policy fence and mutation-audit checks to the
 * PostgreSQL Workflow admission transaction used by cluster-control.
 */
export class PostgresAuthorizedPluginPackageWorkflowAdmissionRepository
  implements PluginPackageWorkflowAdministrationRepository
{
  private readonly admissions: PostgresPluginPackageWorkflowAdmissionRepository;

  constructor(pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'PostgreSQL pool is invalid',
      );
    }
    this.admissions = new PostgresPluginPackageWorkflowAdmissionRepository(
      pool,
    );
  }

  findPlanByPlanId(
    planId: string,
  ): Promise<Readonly<PluginPackageWorkflowExecutionPlan> | null> {
    return this.admissions.findPlanByPlanId(planId);
  }

  async admitAuthorized(input: AuthorizedPluginPackageWorkflowAdmission) {
    const admission = normalizeAuthorizedPluginPackageWorkflowAdmission(input);
    const authorization = Object.freeze({
      projectId: admission.plan.target.projectId,
      actor: admission.actor,
      fence: admission.fence,
      audit: admission.audit,
    });
    return this.admissions.admit(admission.plan, async ({ client, replay }) => {
      await confirmCredential(client, authorization);
      await confirmProjectPolicyFence(client, authorization);
      await insertAtomicAudit(client, admission, replay);
    });
  }
}

/**
 * Reads the low-sensitive Package-bound Workflow Run projection from one
 * serializable PostgreSQL snapshot after revalidating the credential and the
 * latest Project Policy fence. It deliberately does not expose plan, task,
 * attempt, executor, error, input/output or Secret material.
 */
export class PostgresAuthorizedPluginPackageWorkflowRunInspectionRepository
  implements PluginPackageWorkflowRunInspectionRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'PostgreSQL pool is invalid',
      );
    }
  }

  async inspectRunAuthorized(
    input: AuthorizedPluginPackageWorkflowRunInspection,
  ): Promise<Readonly<PluginPackageWorkflowRunInspectionResult>> {
    const inspection =
      normalizeAuthorizedPluginPackageWorkflowRunInspection(input);
    let client: PostgresClient | undefined;
    let began = false;
    try {
      client = await this.pool.connect();
      await configureAdministrationTransaction(client);
      began = true;
      await confirmCredential(client, inspection);
      await confirmProjectPolicyFence(client, inspection);

      const targetRows = await client.query<Row>(
        `SELECT admission.workflow_id AS "workflowId",
                admission.step_count AS "stepCount",
                run.status AS "runStatus",
                run.version AS "runVersion",
                run.event_sequence AS "eventSequence",
                run.created_at_ms AS "createdAtMs",
                run.queued_at_ms AS "queuedAtMs",
                run.started_at_ms AS "startedAtMs",
                run.finished_at_ms AS "finishedAtMs",
                run.cancel_requested_at_ms AS "cancelRequestedAtMs",
                run.cancel_reason AS "cancelReason"
         FROM "ql3"."plugin_package_workflow_admissions" AS admission
         JOIN "ql3"."runs" AS run
           ON run.id = admission.run_id
          AND run.project_id = admission.project_id
         WHERE admission.run_id = $1
           AND admission.project_id = $2
           AND admission.package_name = $3
           AND admission.workflow_id = $4
         LIMIT 2`,
        [
          inspection.runId,
          inspection.projectId,
          inspection.packageName,
          inspection.workflowId,
        ],
      );
      if (targetRows.rows.length === 0) {
        await insertAdministrationAudit(client, inspection.audit);
        const missing = normalizePluginPackageWorkflowRunInspectionResult({
          schema: PLUGIN_PACKAGE_WORKFLOW_RUN_INSPECTION_SCHEMA,
          found: false,
          projectId: inspection.projectId,
          packageName: inspection.packageName,
          workflowId: inspection.workflowId,
          runId: inspection.runId,
          run: null,
          stepCount: null,
          stepStatusCounts: null,
        });
        await client.query('COMMIT');
        began = false;
        return missing;
      }
      if (targetRows.rows.length !== 1) mutationConflict();
      const row = targetRows.rows[0]!;
      if (requiredString(row, 'workflowId') !== inspection.workflowId) {
        mutationConflict();
      }
      const stepCount = requiredInteger(row, 'stepCount');
      if (stepCount < 1 || stepCount > 128) mutationConflict();

      const statusRows = await client.query<Row>(
        `SELECT status AS "stepStatus", COUNT(*) AS "statusCount"
         FROM "ql3"."step_runs"
         WHERE run_id = $1
         GROUP BY status
         ORDER BY status`,
        [inspection.runId],
      );
      const stepStatusCounts = Object.fromEntries(
        STEP_RUN_STATUSES.map((status) => [status, 0]),
      ) as Record<StepRunStatus, number>;
      const observedStatuses = new Set<StepRunStatus>();
      for (const statusRow of statusRows.rows) {
        const status = requiredString(statusRow, 'stepStatus') as StepRunStatus;
        if (
          !STEP_RUN_STATUSES.includes(status) ||
          observedStatuses.has(status)
        ) {
          mutationConflict();
        }
        observedStatuses.add(status);
        stepStatusCounts[status] = requiredInteger(statusRow, 'statusCount');
      }
      if (
        Object.values(stepStatusCounts).reduce(
          (total, count) => total + count,
          0,
        ) !== stepCount
      ) {
        mutationConflict();
      }

      const runStatus = requiredString(row, 'runStatus') as RunStatus;
      const cancelReason = nullableString(
        row,
        'cancelReason',
      ) as RunCancellationReason | null;
      if (
        !RUN_STATUSES.includes(runStatus) ||
        (cancelReason !== null &&
          !RUN_CANCELLATION_REASONS.includes(cancelReason))
      ) {
        mutationConflict();
      }
      const result = normalizePluginPackageWorkflowRunInspectionResult({
        schema: PLUGIN_PACKAGE_WORKFLOW_RUN_INSPECTION_SCHEMA,
        found: true,
        projectId: inspection.projectId,
        packageName: inspection.packageName,
        workflowId: inspection.workflowId,
        runId: inspection.runId,
        run: {
          status: runStatus,
          version: requiredInteger(row, 'runVersion'),
          eventSequence: requiredInteger(row, 'eventSequence'),
          createdAtMs: requiredInteger(row, 'createdAtMs'),
          queuedAtMs: nullableInteger(row, 'queuedAtMs'),
          startedAtMs: nullableInteger(row, 'startedAtMs'),
          finishedAtMs: nullableInteger(row, 'finishedAtMs'),
          cancelRequestedAtMs: nullableInteger(row, 'cancelRequestedAtMs'),
          cancelReason,
        },
        stepCount,
        stepStatusCounts,
      });
      await insertAdministrationAudit(client, inspection.audit);
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (client && began) await rollbackAdministrationTransaction(client);
      if (
        error instanceof
          PluginPackageWorkflowAdministrationAuthorizationFenceConflictError ||
        error instanceof
          PluginPackageWorkflowAdministrationMutationConflictError ||
        error instanceof InvalidPluginPackageWorkflowAdministrationMutationError
      ) {
        throw error;
      }
      throw new PluginPackageWorkflowAdministrationMutationConflictError();
    } finally {
      client?.release();
    }
  }
}

/**
 * Lists one newest-first, low-sensitive Workflow Run history page from a
 * serializable authorization snapshot. The dedicated target/time index keeps
 * the query bounded even when a Package owns many other Workflows.
 */
export class PostgresAuthorizedPluginPackageWorkflowRunListRepository
  implements PluginPackageWorkflowRunListRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'PostgreSQL pool is invalid',
      );
    }
  }

  async listRunsAuthorized(
    input: AuthorizedPluginPackageWorkflowRunList,
  ): Promise<Readonly<PluginPackageWorkflowRunListResult>> {
    const query = normalizeAuthorizedPluginPackageWorkflowRunList(input);
    let client: PostgresClient | undefined;
    let began = false;
    try {
      client = await this.pool.connect();
      await configureAdministrationTransaction(client);
      began = true;
      await confirmCredential(client, query);
      await confirmProjectPolicyFence(client, query);

      const page = await client.query<Row>(
        `SELECT admission.run_id AS "runId",
                admission.step_count AS "stepCount",
                admission.admitted_at_ms AS "admittedAtMs",
                run.status AS "runStatus",
                run.version AS "runVersion",
                run.event_sequence AS "eventSequence",
                run.queued_at_ms AS "queuedAtMs",
                run.started_at_ms AS "startedAtMs",
                run.finished_at_ms AS "finishedAtMs",
                run.cancel_requested_at_ms AS "cancelRequestedAtMs",
                run.cancel_reason AS "cancelReason"
         FROM "ql3"."plugin_package_workflow_admissions" AS admission
         JOIN "ql3"."runs" AS run
           ON run.id = admission.run_id
          AND run.project_id = admission.project_id
         WHERE admission.project_id = $1
           AND admission.package_name = $2
           AND admission.workflow_id = $3
           AND ($4::bigint IS NULL OR admission.admitted_at_ms < $4 OR
                (admission.admitted_at_ms = $4 AND admission.run_id < $5))
         ORDER BY admission.admitted_at_ms DESC, admission.run_id DESC
         LIMIT $6`,
        [
          query.projectId,
          query.packageName,
          query.workflowId,
          query.after?.admittedAtMs ?? null,
          query.after?.runId ?? null,
          query.limit + 1,
        ],
      );
      const truncated = page.rows.length > query.limit;
      const runs = page.rows.slice(0, query.limit).map((row) => ({
        runId: requiredString(row, 'runId'),
        status: requiredString(row, 'runStatus') as RunStatus,
        version: requiredInteger(row, 'runVersion'),
        eventSequence: requiredInteger(row, 'eventSequence'),
        stepCount: requiredInteger(row, 'stepCount'),
        admittedAtMs: requiredInteger(row, 'admittedAtMs'),
        queuedAtMs: nullableInteger(row, 'queuedAtMs'),
        startedAtMs: nullableInteger(row, 'startedAtMs'),
        finishedAtMs: nullableInteger(row, 'finishedAtMs'),
        cancelRequestedAtMs: nullableInteger(row, 'cancelRequestedAtMs'),
        cancelReason: nullableString(
          row,
          'cancelReason',
        ) as RunCancellationReason | null,
      }));
      const last = runs.at(-1);
      const result = normalizePluginPackageWorkflowRunListResult({
        schema: PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_SCHEMA,
        projectId: query.projectId,
        packageName: query.packageName,
        workflowId: query.workflowId,
        after: query.after,
        runs,
        truncated,
        next:
          truncated && last
            ? { admittedAtMs: last.admittedAtMs, runId: last.runId }
            : null,
      });
      await insertAdministrationAudit(client, query.audit);
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (client && began) await rollbackAdministrationTransaction(client);
      if (
        error instanceof
          PluginPackageWorkflowAdministrationAuthorizationFenceConflictError ||
        error instanceof
          PluginPackageWorkflowAdministrationMutationConflictError ||
        error instanceof InvalidPluginPackageWorkflowAdministrationMutationError
      ) {
        throw error;
      }
      throw new PluginPackageWorkflowAdministrationMutationConflictError();
    } finally {
      client?.release();
    }
  }
}

/**
 * Lists one bounded low-sensitive StepRun page behind the exact Package-bound
 * Workflow target and current authorization fence. The runtime role only
 * appends the allowed audit and never receives audit read authority.
 */
export class PostgresAuthorizedPluginPackageWorkflowStepRunListRepository
  implements PluginPackageWorkflowStepRunListRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'PostgreSQL pool is invalid',
      );
    }
  }

  async listStepRunsAuthorized(
    input: AuthorizedPluginPackageWorkflowStepRunList,
  ): Promise<Readonly<PluginPackageWorkflowStepRunListResult>> {
    const query = normalizeAuthorizedPluginPackageWorkflowStepRunList(input);
    let client: PostgresClient | undefined;
    let began = false;
    try {
      client = await this.pool.connect();
      await configureAdministrationTransaction(client);
      began = true;
      await confirmCredential(client, query);
      await confirmProjectPolicyFence(client, query);

      const targets = await client.query<Row>(
        `SELECT admission.step_count AS "stepCount",
                (SELECT COUNT(*) FROM "ql3"."step_runs" AS observed
                 WHERE observed.run_id = admission.run_id) AS "observedStepCount"
         FROM "ql3"."plugin_package_workflow_admissions" AS admission
         JOIN "ql3"."runs" AS run
           ON run.id = admission.run_id
          AND run.project_id = admission.project_id
         WHERE admission.run_id = $1
           AND admission.project_id = $2
           AND admission.package_name = $3
           AND admission.workflow_id = $4
         LIMIT 2`,
        [query.runId, query.projectId, query.packageName, query.workflowId],
      );
      if (targets.rows.length === 0) {
        await insertAdministrationAudit(client, query.audit);
        const missing = normalizePluginPackageWorkflowStepRunListResult({
          schema: PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_SCHEMA,
          found: false,
          projectId: query.projectId,
          packageName: query.packageName,
          workflowId: query.workflowId,
          runId: query.runId,
          stepRuns: [],
          truncated: false,
          next: null,
        });
        await client.query('COMMIT');
        began = false;
        return missing;
      }
      if (
        targets.rows.length !== 1 ||
        requiredInteger(targets.rows[0]!, 'stepCount') !==
          requiredInteger(targets.rows[0]!, 'observedStepCount')
      ) {
        mutationConflict();
      }

      const page = await client.query<Row>(
        `SELECT id AS "id",
                parent_step_run_id AS "parentStepRunId",
                step_key AS "stepKey",
                kind AS "kind",
                required AS "required",
                status AS "status",
                version AS "version",
                attempt_count AS "attemptCount",
                ready_at_ms AS "readyAtMs",
                started_at_ms AS "startedAtMs",
                finished_at_ms AS "finishedAtMs",
                result_code AS "resultCode",
                created_at_ms AS "createdAtMs",
                updated_at_ms AS "updatedAtMs"
         FROM "ql3"."step_runs"
         WHERE run_id = $1
           AND ($2::varchar IS NULL OR step_key > $3 OR
                (step_key = $3 AND id > $2))
         ORDER BY step_key, id
         LIMIT $4`,
        [
          query.runId,
          query.after?.id ?? null,
          query.after?.stepKey ?? '',
          query.limit + 1,
        ],
      );
      const truncated = page.rows.length > query.limit;
      const stepRuns = page.rows.slice(0, query.limit).map((row) => {
        if (typeof row.required !== 'boolean') mutationConflict();
        return {
          id: requiredString(row, 'id'),
          parentStepRunId: nullableString(row, 'parentStepRunId'),
          stepKey: requiredString(row, 'stepKey'),
          kind: requiredString(
            row,
            'kind',
          ) as PluginPackageWorkflowStepRunListItem['kind'],
          required: row.required,
          status: requiredString(row, 'status') as StepRunStatus,
          version: requiredInteger(row, 'version'),
          attemptCount: requiredInteger(row, 'attemptCount'),
          readyAtMs: nullableInteger(row, 'readyAtMs'),
          startedAtMs: nullableInteger(row, 'startedAtMs'),
          finishedAtMs: nullableInteger(row, 'finishedAtMs'),
          resultCode: nullableString(row, 'resultCode'),
          createdAtMs: requiredInteger(row, 'createdAtMs'),
          updatedAtMs: requiredInteger(row, 'updatedAtMs'),
        };
      });
      const last = stepRuns.at(-1);
      const result = normalizePluginPackageWorkflowStepRunListResult({
        schema: PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_SCHEMA,
        found: true,
        projectId: query.projectId,
        packageName: query.packageName,
        workflowId: query.workflowId,
        runId: query.runId,
        stepRuns,
        truncated,
        next: truncated && last ? { stepKey: last.stepKey, id: last.id } : null,
      });
      await insertAdministrationAudit(client, query.audit);
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (client && began) await rollbackAdministrationTransaction(client);
      if (
        error instanceof
          PluginPackageWorkflowAdministrationAuthorizationFenceConflictError ||
        error instanceof
          PluginPackageWorkflowAdministrationMutationConflictError ||
        error instanceof InvalidPluginPackageWorkflowAdministrationMutationError
      ) {
        throw error;
      }
      throw new PluginPackageWorkflowAdministrationMutationConflictError();
    } finally {
      client?.release();
    }
  }
}

/**
 * Lists one bounded content-free RunEvent page behind the exact Package-bound
 * Workflow target and current authorization fence.
 */
export class PostgresAuthorizedPluginPackageWorkflowRunEventListRepository
  implements PluginPackageWorkflowRunEventListRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new InvalidPluginPackageWorkflowAdministrationMutationError(
        'PostgreSQL pool is invalid',
      );
    }
  }

  async listRunEventsAuthorized(
    input: AuthorizedPluginPackageWorkflowRunEventList,
  ): Promise<Readonly<PluginPackageWorkflowRunEventListResult>> {
    const query = normalizeAuthorizedPluginPackageWorkflowRunEventList(input);
    let client: PostgresClient | undefined;
    let began = false;
    try {
      client = await this.pool.connect();
      await configureAdministrationTransaction(client);
      began = true;
      await confirmCredential(client, query);
      await confirmProjectPolicyFence(client, query);

      const targets = await client.query<Row>(
        `SELECT run.event_sequence AS "headSequence"
         FROM "ql3"."plugin_package_workflow_admissions" AS admission
         JOIN "ql3"."runs" AS run
           ON run.id = admission.run_id
          AND run.project_id = admission.project_id
         WHERE admission.run_id = $1
           AND admission.project_id = $2
           AND admission.package_name = $3
           AND admission.workflow_id = $4
         LIMIT 2`,
        [query.runId, query.projectId, query.packageName, query.workflowId],
      );
      if (targets.rows.length === 0) {
        await insertAdministrationAudit(client, query.audit);
        const missing = normalizePluginPackageWorkflowRunEventListResult({
          schema: PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_SCHEMA,
          found: false,
          projectId: query.projectId,
          packageName: query.packageName,
          workflowId: query.workflowId,
          runId: query.runId,
          afterSequence: query.afterSequence,
          headSequence: null,
          events: [],
          truncated: false,
          nextAfterSequence: null,
        });
        await client.query('COMMIT');
        began = false;
        return missing;
      }
      if (targets.rows.length !== 1) mutationConflict();
      const headSequence = requiredInteger(targets.rows[0]!, 'headSequence');
      const page = await client.query<Row>(
        `SELECT id AS "id",
                sequence AS "sequence",
                type AS "type",
                step_run_id AS "stepRunId",
                created_at_ms AS "createdAtMs"
         FROM "ql3"."run_events"
         WHERE run_id = $1 AND sequence > $2
         ORDER BY sequence, id
         LIMIT $3`,
        [query.runId, query.afterSequence, query.limit + 1],
      );
      const truncated = page.rows.length > query.limit;
      const events = page.rows.slice(0, query.limit).map((row) => ({
        id: requiredString(row, 'id'),
        sequence: requiredInteger(row, 'sequence'),
        type: requiredString(row, 'type'),
        stepRunId: nullableString(row, 'stepRunId'),
        createdAtMs: requiredInteger(row, 'createdAtMs'),
      }));
      const lastSequence = events.at(-1)?.sequence ?? null;
      const result = normalizePluginPackageWorkflowRunEventListResult({
        schema: PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_SCHEMA,
        found: true,
        projectId: query.projectId,
        packageName: query.packageName,
        workflowId: query.workflowId,
        runId: query.runId,
        afterSequence: query.afterSequence,
        headSequence,
        events,
        truncated,
        nextAfterSequence: truncated ? lastSequence : null,
      });
      await insertAdministrationAudit(client, query.audit);
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (client && began) await rollbackAdministrationTransaction(client);
      if (
        error instanceof
          PluginPackageWorkflowAdministrationAuthorizationFenceConflictError ||
        error instanceof
          PluginPackageWorkflowAdministrationMutationConflictError ||
        error instanceof InvalidPluginPackageWorkflowAdministrationMutationError
      ) {
        throw error;
      }
      throw new PluginPackageWorkflowAdministrationMutationConflictError();
    } finally {
      client?.release();
    }
  }
}
