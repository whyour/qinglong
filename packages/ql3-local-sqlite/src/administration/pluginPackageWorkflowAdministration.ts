import type { ApiCredentialRepository } from '@qinglong/runtime-core/api-credential';
import type { LocalOwnerPepperRepository } from '@qinglong/runtime-core/local-owner-pepper';
import type { PluginPackageAutomationPublicationRepository } from '@qinglong/runtime-core/plugin-package-automation-publication';
import type { PluginPackageMaterializedRevisionRepository } from '@qinglong/runtime-core/plugin-package-resource-materialization';
import {
  PluginPackageWorkflowAdministrationAuthorizationFenceConflictError,
  PluginPackageWorkflowAdministrationMutationConflictError,
  PluginPackageWorkflowCancellationNotFoundError,
  PLUGIN_PACKAGE_WORKFLOW_RUN_EVENT_LIST_SCHEMA,
  PLUGIN_PACKAGE_WORKFLOW_RUN_INSPECTION_SCHEMA,
  PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_SCHEMA,
  PLUGIN_PACKAGE_WORKFLOW_STEP_RUN_LIST_SCHEMA,
  normalizeAuthorizedPluginPackageWorkflowAdmission,
  normalizeAuthorizedPluginPackageWorkflowCancellation,
  normalizeAuthorizedPluginPackageWorkflowRunEventList,
  normalizeAuthorizedPluginPackageWorkflowRunInspection,
  normalizeAuthorizedPluginPackageWorkflowRunList,
  normalizeAuthorizedPluginPackageWorkflowStepRunList,
  normalizePluginPackageWorkflowCancellationResult,
  normalizePluginPackageWorkflowRunEventListResult,
  normalizePluginPackageWorkflowRunInspectionResult,
  normalizePluginPackageWorkflowRunListResult,
  normalizePluginPackageWorkflowStepRunListResult,
  type AuthorizedPluginPackageWorkflowAdmission,
  type AuthorizedPluginPackageWorkflowCancellation,
  type AuthorizedPluginPackageWorkflowRunEventList,
  type AuthorizedPluginPackageWorkflowRunInspection,
  type AuthorizedPluginPackageWorkflowRunList,
  type AuthorizedPluginPackageWorkflowStepRunList,
  type PluginPackageWorkflowAdministrationRepository,
  type PluginPackageWorkflowCancellationRepository,
  type PluginPackageWorkflowCancellationResult,
  type PluginPackageWorkflowRunEventListRepository,
  type PluginPackageWorkflowRunEventListResult,
  type PluginPackageWorkflowRunInspectionRepository,
  type PluginPackageWorkflowRunInspectionResult,
  type PluginPackageWorkflowRunListRepository,
  type PluginPackageWorkflowRunListResult,
  type PluginPackageWorkflowStepRunListRepository,
  type PluginPackageWorkflowStepRunListResult,
} from '@qinglong/runtime-core/plugin-package-workflow-administration';
import {
  RUN_STATUSES,
  STEP_RUN_STATUSES,
  type RunCancellationReason,
  type RunStatus,
  type StepRunStatus,
} from '@qinglong/runtime-core';
import type { ProjectPolicyRepository } from '@qinglong/runtime-core/project-policy';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import type { SecurityAuditSink } from '@qinglong/runtime-core/security-audit';

import { LocalSqliteApiCredentialRepository } from '../security/apiCredentialRepository';
import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '../storage/config';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteOwnerPepperRepository } from '../local-owner/ownerPepperRepository';
import {
  confirmLocalSqliteAuthenticatedUserCredentialFence,
  LocalSqliteAuthenticatedManagementFenceError,
  type LocalSqliteAuthenticatedUserCredentialFence,
} from './packageManagement';
import { LocalSqlitePluginPackageAutomationPublicationRepository } from '../plugin-package/pluginPackageAutomationPublicationRepository';
import { LocalSqlitePluginPackageMaterializedRevisionRepository } from '../plugin-package/pluginPackageMaterializedRevisionRepository';
import { LocalSqlitePluginPackageWorkflowAdmissionRepository } from '../plugin-package/workflow/pluginPackageWorkflowAdmissionRepository';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../readiness/readiness';
import {
  LOCAL_ROLE_BINDING_SELECT,
  insertLocalSecurityAudit,
  localRoleBindingFromRow,
  localSecurityAuditFromRow,
  sameSecurityAuditSemantic,
} from '../security/securityPersistence';
import { LocalSqliteSecurityAuthorityStore } from '../security/securityAuthorityStore';

type Row = Record<string, unknown>;

const AUDIT_SELECT = `
  "event_id" AS "eventId",
  "request_id" AS "requestId",
  "operation_id" AS "operationId",
  "project_id" AS "auditProjectId",
  "subject_type" AS "subjectType",
  "subject_id" AS "subjectId",
  "authentication_id" AS "authenticationId",
  "outcome" AS "outcome",
  "reasons_json" AS "reasonsJson",
  "fence_project_version" AS "fenceProjectVersion",
  "fence_binding_version" AS "fenceBindingVersion",
  "occurred_at_ms" AS "occurredAtMs"`;
const RUN_CANCELLATION_REASONS = new Set([
  'user',
  'policy',
  'shutdown',
  'reconcile',
  'timeout',
]);
const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

export interface LocalSqlitePluginPackageWorkflowAdministrationDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly apiCredentials: ApiCredentialRepository;
  readonly ownerPepper: Pick<LocalOwnerPepperRepository, 'resolveKey'>;
  readonly projectPolicy: ProjectPolicyRepository;
  readonly automationPublications: Pick<
    PluginPackageAutomationPublicationRepository,
    'findCurrent'
  >;
  readonly materializedRevisions: Pick<
    PluginPackageMaterializedRevisionRepository,
    'find'
  >;
  readonly workflowAdministration: PluginPackageWorkflowAdministrationRepository &
    PluginPackageWorkflowCancellationRepository &
    PluginPackageWorkflowRunInspectionRepository &
    PluginPackageWorkflowRunListRepository &
    PluginPackageWorkflowStepRunListRepository &
    PluginPackageWorkflowRunEventListRepository;
  readonly securityAudit: SecurityAuditSink;
  activateUserCredentialFence(
    fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  ): void;
  close(): Promise<void>;
}

function integer(row: Row | undefined, key: string): number {
  const value = row?.[key];
  if (!Number.isSafeInteger(value)) {
    throw new PluginPackageWorkflowAdministrationAuthorizationFenceConflictError();
  }
  return value as number;
}

function sameCredentialFence(
  left: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  right: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
): boolean {
  return (
    left.credentialId === right.credentialId &&
    left.credentialVersion === right.credentialVersion &&
    left.pepperKeyId === right.pepperKeyId &&
    left.materialDigest === right.materialDigest &&
    left.subjectType === right.subjectType &&
    left.subjectId === right.subjectId &&
    left.secretDigest === right.secretDigest &&
    left.notBeforeAtMs === right.notBeforeAtMs &&
    left.expiresAtMs === right.expiresAtMs
  );
}

function rowText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new PluginPackageWorkflowAdministrationMutationConflictError();
  }
  return value;
}

function rowInteger(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PluginPackageWorkflowAdministrationMutationConflictError();
  }
  return value as number;
}

function rowOptionalInteger(row: Row, key: string): number | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : rowInteger(row, key);
}

function rowOptionalText(row: Row, key: string): string | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : rowText(row, key);
}

function rowRunStatus(row: Row): RunStatus {
  const value = rowText(row, 'runStatus') as RunStatus;
  if (!RUN_STATUSES.includes(value)) {
    throw new PluginPackageWorkflowAdministrationMutationConflictError();
  }
  return value;
}

function cancellationEventPayload(
  cancellation: Readonly<AuthorizedPluginPackageWorkflowCancellation>,
): string {
  return JSON.stringify({
    reason: 'user',
    mutation_id: cancellation.mutationId,
    policy_fence: {
      project_version: cancellation.fence.projectVersion,
      binding_version: cancellation.fence.bindingVersion,
    },
  });
}

function cancellationResult(
  status: PluginPackageWorkflowCancellationResult['status'],
  cancellation: Readonly<AuthorizedPluginPackageWorkflowCancellation>,
  workflowId: string,
  run: Row,
): Readonly<PluginPackageWorkflowCancellationResult> {
  const cancelRequestedAtMs = rowOptionalInteger(run, 'cancelRequestedAtMs');
  const cancelReason = rowOptionalText(run, 'cancelReason');
  if (
    (cancelRequestedAtMs === undefined) !== (cancelReason === undefined) ||
    (cancelReason !== undefined && !RUN_CANCELLATION_REASONS.has(cancelReason))
  ) {
    throw new PluginPackageWorkflowAdministrationMutationConflictError();
  }
  return normalizePluginPackageWorkflowCancellationResult({
    status,
    projectId: cancellation.projectId,
    packageName: cancellation.packageName,
    workflowId,
    runId: cancellation.runId,
    runStatus: rowRunStatus(run),
    runVersion: rowInteger(run, 'runVersion'),
    eventSequence: rowInteger(run, 'eventSequence'),
    ...(cancelRequestedAtMs === undefined
      ? {}
      : {
          cancelRequestedAtMs,
          cancelReason: cancelReason as NonNullable<
            PluginPackageWorkflowCancellationResult['cancelReason']
          >,
        }),
  });
}

class LocalSqliteAuthorizedPluginPackageWorkflowAdmissionRepository
  implements
    PluginPackageWorkflowAdministrationRepository,
    PluginPackageWorkflowCancellationRepository,
    PluginPackageWorkflowRunInspectionRepository,
    PluginPackageWorkflowRunListRepository,
    PluginPackageWorkflowStepRunListRepository,
    PluginPackageWorkflowRunEventListRepository
{
  constructor(
    private readonly authority: LocalSqliteOperationAuthority,
    private readonly admissions: LocalSqlitePluginPackageWorkflowAdmissionRepository,
    private readonly beforeMutation: (actor: Readonly<SecuritySubject>) => void,
  ) {}

  private confirmAuthorization(
    projectId: string,
    actor: Readonly<SecuritySubject>,
    fence: Readonly<SecurityPolicyFence>,
  ): void {
    this.beforeMutation(actor);
    const client = this.authority.client;
    const project = client
      .prepare(
        `SELECT "status" AS "status", "version" AS "version"
         FROM "QingLong3Projects" WHERE "id" = ?`,
      )
      .get(projectId) as Row | undefined;
    const bindingRow = client
      .prepare(
        `SELECT ${LOCAL_ROLE_BINDING_SELECT}
         FROM "QingLong3ProjectRoleBindings"
         WHERE "project_id" = ? AND "subject_type" = ?
           AND "subject_id" = ?
         ORDER BY "version" DESC LIMIT 1`,
      )
      .get(projectId, actor.type, actor.id) as Row | undefined;
    if (
      !project ||
      project.status !== 'active' ||
      integer(project, 'version') !== fence.projectVersion ||
      !bindingRow
    ) {
      throw new PluginPackageWorkflowAdministrationAuthorizationFenceConflictError();
    }
    const binding = localRoleBindingFromRow(bindingRow);
    if (
      binding.version !== fence.bindingVersion ||
      binding.state !== 'active'
    ) {
      throw new PluginPackageWorkflowAdministrationAuthorizationFenceConflictError();
    }
  }

  findPlanByPlanId(planId: string) {
    return this.admissions.findPlanByPlanId(planId);
  }

  admitAuthorized(input: AuthorizedPluginPackageWorkflowAdmission) {
    const admission = normalizeAuthorizedPluginPackageWorkflowAdmission(input);
    return this.admissions.admit(admission.plan, ({ replay }) => {
      this.confirmAuthorization(
        admission.plan.target.projectId,
        admission.actor,
        admission.fence,
      );
      const auditRow = this.authority.client
        .prepare(
          `SELECT ${AUDIT_SELECT}
           FROM "QingLong3SecurityAuditEvents"
           WHERE "event_id" = ?`,
        )
        .get(admission.audit.eventId) as Row | undefined;
      if (replay) {
        if (
          !auditRow ||
          !sameSecurityAuditSemantic(
            localSecurityAuditFromRow(auditRow),
            admission.audit,
          )
        ) {
          throw new PluginPackageWorkflowAdministrationMutationConflictError();
        }
        return;
      }
      if (auditRow) {
        throw new PluginPackageWorkflowAdministrationMutationConflictError();
      }
      insertLocalSecurityAudit(this.authority.client, admission.audit);
    });
  }

  requestUserCancellation(
    input: AuthorizedPluginPackageWorkflowCancellation,
  ): Promise<Readonly<PluginPackageWorkflowCancellationResult>> {
    const cancellation =
      normalizeAuthorizedPluginPackageWorkflowCancellation(input);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        let began = false;
        try {
          client.exec('BEGIN IMMEDIATE');
          began = true;
          this.confirmAuthorization(
            cancellation.projectId,
            cancellation.actor,
            cancellation.fence,
          );
          const admissionRows = client
            .prepare(
              `SELECT workflow_id AS "workflowId"
               FROM "QingLong3PluginPackageWorkflowAdmissions"
               WHERE run_id = ? AND project_id = ? AND package_name = ?
               LIMIT 2`,
            )
            .all(
              cancellation.runId,
              cancellation.projectId,
              cancellation.packageName,
            ) as Row[];
          const run = client
            .prepare(
              `SELECT project_id AS "projectId", status AS "runStatus",
                      version AS "runVersion",
                      event_sequence AS "eventSequence",
                      cancel_requested_at_ms AS "cancelRequestedAtMs",
                      cancel_reason AS "cancelReason"
               FROM "Runs" WHERE id = ?`,
            )
            .get(cancellation.runId) as Row | undefined;
          if (
            admissionRows.length !== 1 ||
            !run ||
            run.projectId !== cancellation.projectId
          ) {
            throw new PluginPackageWorkflowCancellationNotFoundError();
          }
          const workflowId = rowText(admissionRows[0]!, 'workflowId');
          const auditRow = client
            .prepare(
              `SELECT ${AUDIT_SELECT}
               FROM "QingLong3SecurityAuditEvents"
               WHERE "event_id" = ?`,
            )
            .get(cancellation.audit.eventId) as Row | undefined;
          const storedAudit = auditRow
            ? localSecurityAuditFromRow(auditRow)
            : undefined;
          if (
            storedAudit &&
            !sameSecurityAuditSemantic(storedAudit, cancellation.audit)
          ) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          const dedupeKey = `workflow-user-cancel:${cancellation.mutationId}`;
          const existingEvent = client
            .prepare(
              `SELECT id, type, actor_type AS "actorType",
                      actor_id AS "actorId", payload,
                      created_at_ms AS "createdAtMs"
               FROM "RunEvents"
               WHERE run_id = ? AND dedupe_key = ?
               LIMIT 2`,
            )
            .get(cancellation.runId, dedupeKey) as Row | undefined;
          if (existingEvent) {
            if (
              !storedAudit ||
              existingEvent.id !== cancellation.runEventId ||
              existingEvent.type !== 'run.cancel_requested' ||
              existingEvent.actorType !== cancellation.actor.type ||
              existingEvent.actorId !== cancellation.actor.id ||
              existingEvent.payload !==
                cancellationEventPayload(cancellation) ||
              existingEvent.createdAtMs !== storedAudit.occurredAtMs
            ) {
              throw new PluginPackageWorkflowAdministrationMutationConflictError();
            }
            const result = cancellationResult(
              'existing',
              cancellation,
              workflowId,
              run,
            );
            client.exec('COMMIT');
            began = false;
            return result;
          }
          if (auditRow) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          const runStatus = rowRunStatus(run);
          const terminal = TERMINAL_RUN_STATUSES.has(runStatus);
          const cancelRequestedAtMs = rowOptionalInteger(
            run,
            'cancelRequestedAtMs',
          );
          const cancelReason = rowOptionalText(run, 'cancelReason');
          if (
            (cancelRequestedAtMs === undefined) !==
              (cancelReason === undefined) ||
            (cancelReason !== undefined &&
              !RUN_CANCELLATION_REASONS.has(cancelReason))
          ) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          if (terminal || cancelRequestedAtMs !== undefined) {
            insertLocalSecurityAudit(client, cancellation.audit);
            const result = cancellationResult(
              terminal ? 'already_terminal' : 'already_requested',
              cancellation,
              workflowId,
              run,
            );
            client.exec('COMMIT');
            began = false;
            return result;
          }
          const runVersion = rowInteger(run, 'runVersion');
          const eventSequence = rowInteger(run, 'eventSequence');
          if (runVersion >= 2_147_483_647 || eventSequence >= 2_147_483_647) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          const updated = client
            .prepare(
              `UPDATE "Runs"
               SET cancel_requested_at_ms = ?, cancel_reason = 'user',
                   version = ?, event_sequence = ?
               WHERE id = ? AND version = ?
                 AND cancel_requested_at_ms IS NULL
               RETURNING project_id AS "projectId", status AS "runStatus",
                         version AS "runVersion",
                         event_sequence AS "eventSequence",
                         cancel_requested_at_ms AS "cancelRequestedAtMs",
                         cancel_reason AS "cancelReason"`,
            )
            .get(
              cancellation.audit.occurredAtMs,
              runVersion + 1,
              eventSequence + 1,
              cancellation.runId,
              runVersion,
            ) as Row | undefined;
          if (!updated) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          client
            .prepare(
              `INSERT INTO "RunEvents" (
                 id, run_id, sequence, type, dedupe_key,
                 actor_type, actor_id, attempt_id, step_run_id,
                 payload, created_at_ms
               ) VALUES (?, ?, ?, 'run.cancel_requested', ?, ?, ?,
                         NULL, NULL, ?, ?)`,
            )
            .run(
              cancellation.runEventId,
              cancellation.runId,
              eventSequence + 1,
              dedupeKey,
              cancellation.actor.type,
              cancellation.actor.id,
              cancellationEventPayload(cancellation),
              cancellation.audit.occurredAtMs,
            );
          insertLocalSecurityAudit(client, cancellation.audit);
          const result = cancellationResult(
            'accepted',
            cancellation,
            workflowId,
            updated,
          );
          client.exec('COMMIT');
          began = false;
          return result;
        } catch (error) {
          if (began && client.isTransaction) {
            try {
              client.exec('ROLLBACK');
            } catch {
              // Preserve the authority or durable-state failure.
            }
          }
          if (
            error instanceof
              PluginPackageWorkflowAdministrationAuthorizationFenceConflictError ||
            error instanceof
              PluginPackageWorkflowAdministrationMutationConflictError ||
            error instanceof PluginPackageWorkflowCancellationNotFoundError ||
            error instanceof LocalSqliteAuthenticatedManagementFenceError
          ) {
            throw error;
          }
          throw new PluginPackageWorkflowAdministrationMutationConflictError();
        }
      },
      () => new PluginPackageWorkflowAdministrationMutationConflictError(),
    );
  }

  inspectRunAuthorized(
    input: AuthorizedPluginPackageWorkflowRunInspection,
  ): Promise<Readonly<PluginPackageWorkflowRunInspectionResult>> {
    const inspection =
      normalizeAuthorizedPluginPackageWorkflowRunInspection(input);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        let began = false;
        try {
          client.exec('BEGIN IMMEDIATE');
          began = true;
          this.confirmAuthorization(
            inspection.projectId,
            inspection.actor,
            inspection.fence,
          );
          const auditRow = client
            .prepare(
              `SELECT ${AUDIT_SELECT}
               FROM "QingLong3SecurityAuditEvents"
               WHERE "event_id" = ?`,
            )
            .get(inspection.audit.eventId) as Row | undefined;
          if (
            auditRow &&
            !sameSecurityAuditSemantic(
              localSecurityAuditFromRow(auditRow),
              inspection.audit,
            )
          ) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          const rows = client
            .prepare(
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
               FROM "QingLong3PluginPackageWorkflowAdmissions" AS admission
               JOIN "Runs" AS run
                 ON run.id = admission.run_id
                AND run.project_id = admission.project_id
               WHERE admission.run_id = ?
                 AND admission.project_id = ?
                 AND admission.package_name = ?
                 AND admission.workflow_id = ?
               LIMIT 2`,
            )
            .all(
              inspection.runId,
              inspection.projectId,
              inspection.packageName,
              inspection.workflowId,
            ) as Row[];
          if (rows.length === 0) {
            if (!auditRow) insertLocalSecurityAudit(client, inspection.audit);
            const result = normalizePluginPackageWorkflowRunInspectionResult({
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
            client.exec('COMMIT');
            began = false;
            return result;
          }
          if (rows.length !== 1) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          const row = rows[0]!;
          if (rowText(row, 'workflowId') !== inspection.workflowId) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          const stepCount = rowInteger(row, 'stepCount');
          if (stepCount < 1 || stepCount > 128) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          const statusRows = client
            .prepare(
              `SELECT status AS "stepStatus", COUNT(*) AS "statusCount"
               FROM "StepRuns"
               WHERE run_id = ?
               GROUP BY status
               ORDER BY status`,
            )
            .all(inspection.runId) as Row[];
          const stepStatusCounts = Object.fromEntries(
            STEP_RUN_STATUSES.map((status) => [status, 0]),
          ) as Record<StepRunStatus, number>;
          const observedStatuses = new Set<StepRunStatus>();
          for (const statusRow of statusRows) {
            const status = rowText(statusRow, 'stepStatus') as StepRunStatus;
            if (
              !STEP_RUN_STATUSES.includes(status) ||
              observedStatuses.has(status)
            ) {
              throw new PluginPackageWorkflowAdministrationMutationConflictError();
            }
            observedStatuses.add(status);
            stepStatusCounts[status] = rowInteger(statusRow, 'statusCount');
          }
          if (
            Object.values(stepStatusCounts).reduce(
              (total, count) => total + count,
              0,
            ) !== stepCount
          ) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          const cancelRequestedAtMs = rowOptionalInteger(
            row,
            'cancelRequestedAtMs',
          );
          const cancelReason = rowOptionalText(row, 'cancelReason');
          if (
            (cancelRequestedAtMs === undefined) !==
              (cancelReason === undefined) ||
            (cancelReason !== undefined &&
              !RUN_CANCELLATION_REASONS.has(cancelReason))
          ) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          const result = normalizePluginPackageWorkflowRunInspectionResult({
            schema: PLUGIN_PACKAGE_WORKFLOW_RUN_INSPECTION_SCHEMA,
            found: true,
            projectId: inspection.projectId,
            packageName: inspection.packageName,
            workflowId: inspection.workflowId,
            runId: inspection.runId,
            run: {
              status: rowRunStatus(row),
              version: rowInteger(row, 'runVersion'),
              eventSequence: rowInteger(row, 'eventSequence'),
              createdAtMs: rowInteger(row, 'createdAtMs'),
              queuedAtMs: rowOptionalInteger(row, 'queuedAtMs') ?? null,
              startedAtMs: rowOptionalInteger(row, 'startedAtMs') ?? null,
              finishedAtMs: rowOptionalInteger(row, 'finishedAtMs') ?? null,
              cancelRequestedAtMs: cancelRequestedAtMs ?? null,
              cancelReason:
                (cancelReason as RunCancellationReason | undefined) ?? null,
            },
            stepCount,
            stepStatusCounts,
          });
          if (!auditRow) insertLocalSecurityAudit(client, inspection.audit);
          client.exec('COMMIT');
          began = false;
          return result;
        } catch (error) {
          if (began && client.isTransaction) {
            try {
              client.exec('ROLLBACK');
            } catch {
              // Preserve the authority or durable-state failure.
            }
          }
          if (
            error instanceof
              PluginPackageWorkflowAdministrationAuthorizationFenceConflictError ||
            error instanceof
              PluginPackageWorkflowAdministrationMutationConflictError ||
            error instanceof LocalSqliteAuthenticatedManagementFenceError
          ) {
            throw error;
          }
          throw new PluginPackageWorkflowAdministrationMutationConflictError();
        }
      },
      () => new PluginPackageWorkflowAdministrationMutationConflictError(),
    );
  }

  listRunsAuthorized(
    input: AuthorizedPluginPackageWorkflowRunList,
  ): Promise<Readonly<PluginPackageWorkflowRunListResult>> {
    const query = normalizeAuthorizedPluginPackageWorkflowRunList(input);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        let began = false;
        try {
          client.exec('BEGIN IMMEDIATE');
          began = true;
          this.confirmAuthorization(query.projectId, query.actor, query.fence);
          const auditRow = client
            .prepare(
              `SELECT ${AUDIT_SELECT}
               FROM "QingLong3SecurityAuditEvents"
               WHERE "event_id" = ?`,
            )
            .get(query.audit.eventId) as Row | undefined;
          if (
            auditRow &&
            !sameSecurityAuditSemantic(
              localSecurityAuditFromRow(auditRow),
              query.audit,
            )
          ) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          const rows = client
            .prepare(
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
               FROM "QingLong3PluginPackageWorkflowAdmissions" AS admission
               JOIN "Runs" AS run
                 ON run.id = admission.run_id
                AND run.project_id = admission.project_id
               WHERE admission.project_id = ?
                 AND admission.package_name = ?
                 AND admission.workflow_id = ?
                 AND (? IS NULL OR admission.admitted_at_ms < ? OR
                      (admission.admitted_at_ms = ? AND admission.run_id < ?))
               ORDER BY admission.admitted_at_ms DESC, admission.run_id DESC
               LIMIT ?`,
            )
            .all(
              query.projectId,
              query.packageName,
              query.workflowId,
              query.after?.runId ?? null,
              query.after?.admittedAtMs ?? 0,
              query.after?.admittedAtMs ?? 0,
              query.after?.runId ?? '',
              query.limit + 1,
            ) as Row[];
          const truncated = rows.length > query.limit;
          const runs = rows.slice(0, query.limit).map((row) => {
            const cancelRequestedAtMs =
              rowOptionalInteger(row, 'cancelRequestedAtMs') ?? null;
            const cancelReason =
              (rowOptionalText(row, 'cancelReason') as
                | RunCancellationReason
                | undefined) ?? null;
            return {
              runId: rowText(row, 'runId'),
              status: rowRunStatus(row),
              version: rowInteger(row, 'runVersion'),
              eventSequence: rowInteger(row, 'eventSequence'),
              stepCount: rowInteger(row, 'stepCount'),
              admittedAtMs: rowInteger(row, 'admittedAtMs'),
              queuedAtMs: rowOptionalInteger(row, 'queuedAtMs') ?? null,
              startedAtMs: rowOptionalInteger(row, 'startedAtMs') ?? null,
              finishedAtMs: rowOptionalInteger(row, 'finishedAtMs') ?? null,
              cancelRequestedAtMs,
              cancelReason,
            };
          });
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
          if (!auditRow) insertLocalSecurityAudit(client, query.audit);
          client.exec('COMMIT');
          began = false;
          return result;
        } catch (error) {
          if (began && client.isTransaction) {
            try {
              client.exec('ROLLBACK');
            } catch {
              // Preserve the authority or durable-state failure.
            }
          }
          if (
            error instanceof
              PluginPackageWorkflowAdministrationAuthorizationFenceConflictError ||
            error instanceof
              PluginPackageWorkflowAdministrationMutationConflictError ||
            error instanceof LocalSqliteAuthenticatedManagementFenceError
          ) {
            throw error;
          }
          throw new PluginPackageWorkflowAdministrationMutationConflictError();
        }
      },
      () => new PluginPackageWorkflowAdministrationMutationConflictError(),
    );
  }

  listStepRunsAuthorized(
    input: AuthorizedPluginPackageWorkflowStepRunList,
  ): Promise<Readonly<PluginPackageWorkflowStepRunListResult>> {
    const query = normalizeAuthorizedPluginPackageWorkflowStepRunList(input);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        let began = false;
        try {
          client.exec('BEGIN IMMEDIATE');
          began = true;
          this.confirmAuthorization(query.projectId, query.actor, query.fence);
          const auditRow = client
            .prepare(
              `SELECT ${AUDIT_SELECT}
               FROM "QingLong3SecurityAuditEvents"
               WHERE "event_id" = ?`,
            )
            .get(query.audit.eventId) as Row | undefined;
          if (
            auditRow &&
            !sameSecurityAuditSemantic(
              localSecurityAuditFromRow(auditRow),
              query.audit,
            )
          ) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          const targets = client
            .prepare(
              `SELECT admission.step_count AS "stepCount",
                      (SELECT COUNT(*) FROM "StepRuns" AS observed
                       WHERE observed.run_id = admission.run_id) AS "observedStepCount"
               FROM "QingLong3PluginPackageWorkflowAdmissions" AS admission
               JOIN "Runs" AS run
                 ON run.id = admission.run_id
                AND run.project_id = admission.project_id
               WHERE admission.run_id = ?
                 AND admission.project_id = ?
                 AND admission.package_name = ?
                 AND admission.workflow_id = ?
               LIMIT 2`,
            )
            .all(
              query.runId,
              query.projectId,
              query.packageName,
              query.workflowId,
            ) as Row[];
          if (targets.length === 0) {
            if (!auditRow) insertLocalSecurityAudit(client, query.audit);
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
            client.exec('COMMIT');
            began = false;
            return missing;
          }
          if (
            targets.length !== 1 ||
            rowInteger(targets[0]!, 'stepCount') !==
              rowInteger(targets[0]!, 'observedStepCount')
          ) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          const rows = client
            .prepare(
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
               FROM "StepRuns"
               WHERE run_id = ?
                 AND (? IS NULL OR step_key > ? OR
                      (step_key = ? AND id > ?))
               ORDER BY step_key, id
               LIMIT ?`,
            )
            .all(
              query.runId,
              query.after?.id ?? null,
              query.after?.stepKey ?? '',
              query.after?.stepKey ?? '',
              query.after?.id ?? '',
              query.limit + 1,
            ) as Row[];
          const truncated = rows.length > query.limit;
          const stepRuns = rows.slice(0, query.limit).map((row) => {
            const required = rowInteger(row, 'required');
            if (required !== 0 && required !== 1) {
              throw new PluginPackageWorkflowAdministrationMutationConflictError();
            }
            return {
              id: rowText(row, 'id'),
              parentStepRunId: rowOptionalText(row, 'parentStepRunId') ?? null,
              stepKey: rowText(row, 'stepKey'),
              kind: rowText(row, 'kind') as 'task',
              required: required === 1,
              status: rowText(row, 'status') as StepRunStatus,
              version: rowInteger(row, 'version'),
              attemptCount: rowInteger(row, 'attemptCount'),
              readyAtMs: rowOptionalInteger(row, 'readyAtMs') ?? null,
              startedAtMs: rowOptionalInteger(row, 'startedAtMs') ?? null,
              finishedAtMs: rowOptionalInteger(row, 'finishedAtMs') ?? null,
              resultCode: rowOptionalText(row, 'resultCode') ?? null,
              createdAtMs: rowInteger(row, 'createdAtMs'),
              updatedAtMs: rowInteger(row, 'updatedAtMs'),
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
            next:
              truncated && last ? { stepKey: last.stepKey, id: last.id } : null,
          });
          if (!auditRow) insertLocalSecurityAudit(client, query.audit);
          client.exec('COMMIT');
          began = false;
          return result;
        } catch (error) {
          if (began && client.isTransaction) {
            try {
              client.exec('ROLLBACK');
            } catch {
              // Preserve the authority or durable-state failure.
            }
          }
          if (
            error instanceof
              PluginPackageWorkflowAdministrationAuthorizationFenceConflictError ||
            error instanceof
              PluginPackageWorkflowAdministrationMutationConflictError ||
            error instanceof LocalSqliteAuthenticatedManagementFenceError
          ) {
            throw error;
          }
          throw new PluginPackageWorkflowAdministrationMutationConflictError();
        }
      },
      () => new PluginPackageWorkflowAdministrationMutationConflictError(),
    );
  }

  listRunEventsAuthorized(
    input: AuthorizedPluginPackageWorkflowRunEventList,
  ): Promise<Readonly<PluginPackageWorkflowRunEventListResult>> {
    const query = normalizeAuthorizedPluginPackageWorkflowRunEventList(input);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        let began = false;
        try {
          client.exec('BEGIN IMMEDIATE');
          began = true;
          this.confirmAuthorization(query.projectId, query.actor, query.fence);
          const auditRow = client
            .prepare(
              `SELECT ${AUDIT_SELECT}
               FROM "QingLong3SecurityAuditEvents"
               WHERE "event_id" = ?`,
            )
            .get(query.audit.eventId) as Row | undefined;
          if (
            auditRow &&
            !sameSecurityAuditSemantic(
              localSecurityAuditFromRow(auditRow),
              query.audit,
            )
          ) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          const targets = client
            .prepare(
              `SELECT run.event_sequence AS "headSequence"
               FROM "QingLong3PluginPackageWorkflowAdmissions" AS admission
               JOIN "Runs" AS run
                 ON run.id = admission.run_id
                AND run.project_id = admission.project_id
               WHERE admission.run_id = ?
                 AND admission.project_id = ?
                 AND admission.package_name = ?
                 AND admission.workflow_id = ?
               LIMIT 2`,
            )
            .all(
              query.runId,
              query.projectId,
              query.packageName,
              query.workflowId,
            ) as Row[];
          if (targets.length === 0) {
            if (!auditRow) insertLocalSecurityAudit(client, query.audit);
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
            client.exec('COMMIT');
            began = false;
            return missing;
          }
          if (targets.length !== 1) {
            throw new PluginPackageWorkflowAdministrationMutationConflictError();
          }
          const headSequence = rowInteger(targets[0]!, 'headSequence');
          const rows = client
            .prepare(
              `SELECT id AS "id",
                      sequence AS "sequence",
                      type AS "type",
                      step_run_id AS "stepRunId",
                      created_at_ms AS "createdAtMs"
               FROM "RunEvents"
               WHERE run_id = ? AND sequence > ?
               ORDER BY sequence, id
               LIMIT ?`,
            )
            .all(query.runId, query.afterSequence, query.limit + 1) as Row[];
          const truncated = rows.length > query.limit;
          const events = rows.slice(0, query.limit).map((row) => ({
            id: rowText(row, 'id'),
            sequence: rowInteger(row, 'sequence'),
            type: rowText(row, 'type'),
            stepRunId: rowOptionalText(row, 'stepRunId') ?? null,
            createdAtMs: rowInteger(row, 'createdAtMs'),
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
          if (!auditRow) insertLocalSecurityAudit(client, query.audit);
          client.exec('COMMIT');
          began = false;
          return result;
        } catch (error) {
          if (began && client.isTransaction) {
            try {
              client.exec('ROLLBACK');
            } catch {
              // Preserve the authority or durable-state failure.
            }
          }
          if (
            error instanceof
              PluginPackageWorkflowAdministrationAuthorizationFenceConflictError ||
            error instanceof
              PluginPackageWorkflowAdministrationMutationConflictError ||
            error instanceof LocalSqliteAuthenticatedManagementFenceError
          ) {
            throw error;
          }
          throw new PluginPackageWorkflowAdministrationMutationConflictError();
        }
      },
      () => new PluginPackageWorkflowAdministrationMutationConflictError(),
    );
  }
}

export async function openLocalSqlitePluginPackageWorkflowAdministrationDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqlitePluginPackageWorkflowAdministrationDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    const securityAuthority = new LocalSqliteSecurityAuthorityStore(authority);
    const automationPublications =
      new LocalSqlitePluginPackageAutomationPublicationRepository(authority);
    const materializedRevisions =
      new LocalSqlitePluginPackageMaterializedRevisionRepository(authority);
    const admissions = new LocalSqlitePluginPackageWorkflowAdmissionRepository(
      authority,
    );
    let activeFence:
      | Readonly<LocalSqliteAuthenticatedUserCredentialFence>
      | undefined;
    const projectPolicy: ProjectPolicyRepository = Object.freeze({
      resolve: (
        ...[projectId, subject]: Parameters<ProjectPolicyRepository['resolve']>
      ) => securityAuthority.resolve(projectId, subject),
      append: (...[command]: Parameters<ProjectPolicyRepository['append']>) =>
        securityAuthority.append(command),
    });
    const workflowAdministration =
      new LocalSqliteAuthorizedPluginPackageWorkflowAdmissionRepository(
        authority,
        admissions,
        (actor) => {
          if (
            !activeFence ||
            actor.type !== activeFence.subjectType ||
            actor.id !== activeFence.subjectId
          ) {
            throw new LocalSqliteAuthenticatedManagementFenceError();
          }
          confirmLocalSqliteAuthenticatedUserCredentialFence(
            authority,
            activeFence,
          );
        },
      );
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      apiCredentials: new LocalSqliteApiCredentialRepository(authority),
      ownerPepper: new LocalSqliteOwnerPepperRepository(authority),
      projectPolicy,
      automationPublications,
      materializedRevisions,
      workflowAdministration,
      securityAudit: securityAuthority,
      activateUserCredentialFence(
        fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
      ) {
        confirmLocalSqliteAuthenticatedUserCredentialFence(authority, fence);
        if (activeFence && !sameCredentialFence(activeFence, fence)) {
          throw new LocalSqliteAuthenticatedManagementFenceError();
        }
        activeFence = Object.freeze({ ...fence });
      },
      close() {
        if (closePromise) return closePromise;
        closePromise = authority.close();
        return closePromise;
      },
    });
  } catch (error) {
    if (client.isOpen) client.close();
    throw error;
  }
}
