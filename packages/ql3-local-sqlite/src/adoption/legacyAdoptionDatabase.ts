import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  createTaskDefinitionRecord,
  normalizeAppendTaskDefinitionRevisionCommand,
  type TaskDefinitionSpec,
} from '@qinglong/runtime-core/task-definition';
import {
  BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
  createBuiltInTaskSpecSemanticRegistry,
} from '@qinglong/runtime-core/task-spec-semantic';
import {
  BUILT_IN_CRON_TRIGGER_SPEC_SCHEMA,
  createBuiltInTriggerSpecSemanticRegistry,
  createTriggerRecord,
  normalizeAppendTriggerRevisionCommand,
  type TriggerSpec,
} from '@qinglong/runtime-core/trigger';
import {
  normalizeProjectPolicySubject,
  type ProjectPolicyRepository,
} from '@qinglong/runtime-core/project-policy';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';

import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '../storage/config';
import { LocalSqliteDispatchDefinitionStore } from '../task-definition/dispatchDefinitionStore';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../readiness/readiness';
import { LocalSqliteSecurityAuthorityStore } from '../security/securityAuthorityStore';

export const MAX_LOCAL_LEGACY_ADOPTION_TASKS = 100_000;
export const MAX_LOCAL_LEGACY_ADOPTION_TRIGGERS = 500_000;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface LocalLegacyAdoptionCandidate {
  readonly rowOrdinal: number;
  readonly sourceDigest: string;
  readonly task: Readonly<{
    taskId: string;
    name: string;
    kind: 'command';
    spec: TaskDefinitionSpec;
    labels: Readonly<Record<string, string>>;
    enabled: boolean;
  }>;
  readonly triggers: readonly Readonly<{
    triggerId: string;
    spec: TriggerSpec;
    enabled: boolean;
  }>[];
}

export interface PublishLocalLegacyAdoptionCommand {
  readonly mutationId: string;
  readonly decisionId: string;
  readonly projectId: string;
  readonly profile: LocalSqliteProfile;
  readonly planDigest: string;
  readonly inventoryDigest: string;
  readonly decisionDigest: string;
  readonly receiptDigest: string;
  readonly authorizationFileDigest: string;
  readonly rowCount: number;
  readonly skippedCount: number;
  readonly subject: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
  readonly candidates: Iterable<LocalLegacyAdoptionCandidate>;
  readonly confirmExternalAuthority: () => void | Promise<void>;
  readonly createdAtMs: number;
}

export interface LocalLegacyAdoptionRecord {
  readonly mutationId: string;
  readonly decisionId: string;
  readonly projectId: string;
  readonly profile: LocalSqliteProfile;
  readonly planDigest: string;
  readonly inventoryDigest: string;
  readonly decisionDigest: string;
  readonly receiptDigest: string;
  readonly authorizationFileDigest: string;
  readonly publicationDigest: string;
  readonly rowCount: number;
  readonly adoptedTaskCount: number;
  readonly adoptedTriggerCount: number;
  readonly skippedCount: number;
  readonly auditEventId: string;
  readonly createdAtMs: number;
}

export interface PublishLocalLegacyAdoptionResult {
  readonly status: 'inserted' | 'existing';
  readonly adoption: LocalLegacyAdoptionRecord;
}

export class LocalLegacyAdoptionConflictError extends Error {
  readonly code = 'LOCAL_LEGACY_ADOPTION_CONFLICT';
  constructor() {
    super('Local legacy adoption conflicts with durable state');
    this.name = 'LocalLegacyAdoptionConflictError';
  }
}

export class LocalLegacyAdoptionAuthorizationFenceConflictError extends Error {
  readonly code = 'LOCAL_LEGACY_ADOPTION_AUTHORIZATION_FENCE_CONFLICT';
  constructor() {
    super('Local legacy adoption authorization fence changed');
    this.name = 'LocalLegacyAdoptionAuthorizationFenceConflictError';
  }
}

export class LocalLegacyAdoptionUnavailableError extends Error {
  readonly code = 'LOCAL_LEGACY_ADOPTION_UNAVAILABLE';
  constructor(readonly cause?: unknown) {
    super('Local legacy adoption storage is unavailable');
    this.name = 'LocalLegacyAdoptionUnavailableError';
  }
}

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string')
    throw new LocalLegacyAdoptionUnavailableError();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) {
    throw new LocalLegacyAdoptionUnavailableError();
  }
  return value as number;
}

function adoptionRecord(row: Row): LocalLegacyAdoptionRecord {
  const profile = text(row, 'profile');
  if (profile !== 'edge' && profile !== 'standalone') {
    throw new LocalLegacyAdoptionUnavailableError();
  }
  return Object.freeze({
    mutationId: text(row, 'mutationId'),
    decisionId: text(row, 'decisionId'),
    projectId: text(row, 'projectId'),
    profile,
    planDigest: text(row, 'planDigest'),
    inventoryDigest: text(row, 'inventoryDigest'),
    decisionDigest: text(row, 'decisionDigest'),
    receiptDigest: text(row, 'receiptDigest'),
    authorizationFileDigest: text(row, 'authorizationFileDigest'),
    publicationDigest: text(row, 'publicationDigest'),
    rowCount: integer(row, 'rowCount'),
    adoptedTaskCount: integer(row, 'adoptedTaskCount'),
    adoptedTriggerCount: integer(row, 'adoptedTriggerCount'),
    skippedCount: integer(row, 'skippedCount'),
    auditEventId: text(row, 'auditEventId'),
    createdAtMs: integer(row, 'createdAtMs'),
  });
}

function deterministicMutationId(
  batchMutationId: string,
  identity: string,
): string {
  const bytes = createHash('sha256')
    .update('qinglong3.legacy-adoption-mutation.v1\0')
    .update(batchMutationId)
    .update('\0')
    .update(identity)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function exactReplay(
  existing: LocalLegacyAdoptionRecord,
  command: PublishLocalLegacyAdoptionCommand,
): boolean {
  return (
    existing.mutationId === command.mutationId &&
    existing.decisionId === command.decisionId &&
    existing.projectId === command.projectId &&
    existing.profile === command.profile &&
    existing.planDigest === command.planDigest &&
    existing.inventoryDigest === command.inventoryDigest &&
    existing.decisionDigest === command.decisionDigest &&
    existing.receiptDigest === command.receiptDigest &&
    existing.authorizationFileDigest === command.authorizationFileDigest &&
    existing.rowCount === command.rowCount &&
    existing.skippedCount === command.skippedCount &&
    existing.auditEventId === command.audit.eventId &&
    existing.createdAtMs === command.createdAtMs
  );
}

function assertCommand(command: PublishLocalLegacyAdoptionCommand): void {
  if (
    !command ||
    typeof command !== 'object' ||
    !UUID_V4_PATTERN.test(command.mutationId) ||
    !UUID_V7_PATTERN.test(command.decisionId) ||
    (command.profile !== 'edge' && command.profile !== 'standalone') ||
    ![
      command.planDigest,
      command.inventoryDigest,
      command.decisionDigest,
      command.receiptDigest,
      command.authorizationFileDigest,
    ].every((digest) => DIGEST_PATTERN.test(digest)) ||
    !Number.isSafeInteger(command.rowCount) ||
    command.rowCount < 0 ||
    command.rowCount > MAX_LOCAL_LEGACY_ADOPTION_TASKS ||
    !Number.isSafeInteger(command.skippedCount) ||
    command.skippedCount < 0 ||
    command.skippedCount > command.rowCount ||
    !Number.isSafeInteger(command.createdAtMs) ||
    command.createdAtMs < 0 ||
    !command.candidates ||
    typeof command.candidates[Symbol.iterator] !== 'function' ||
    typeof command.confirmExternalAuthority !== 'function'
  ) {
    throw new LocalLegacyAdoptionConflictError();
  }
}

function insertAudit(client: DatabaseSync, audit: SecurityAuditRecord): void {
  client
    .prepare(
      `INSERT INTO "QingLong3SecurityAuditEvents" (
         "event_id", "request_id", "operation_id", "project_id",
         "subject_type", "subject_id", "authentication_id", "outcome",
         "reasons_json", "fence_project_version", "fence_binding_version",
         "occurred_at_ms"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

const LEDGER_SELECT = `
  "mutation_id" AS "mutationId", "decision_id" AS "decisionId",
  "project_id" AS "projectId", "profile" AS "profile",
  "plan_digest" AS "planDigest", "inventory_digest" AS "inventoryDigest",
  "decision_digest" AS "decisionDigest", "receipt_digest" AS "receiptDigest",
  "authorization_file_digest" AS "authorizationFileDigest",
  "publication_digest" AS "publicationDigest", "row_count" AS "rowCount",
  "adopted_task_count" AS "adoptedTaskCount",
  "adopted_trigger_count" AS "adoptedTriggerCount",
  "skipped_count" AS "skippedCount", "audit_event_id" AS "auditEventId",
  "created_at_ms" AS "createdAtMs"`;

export class LocalSqliteLegacyAdoptionPublisher {
  constructor(private readonly authority: LocalSqliteOperationAuthority) {}

  publish(
    input: PublishLocalLegacyAdoptionCommand,
  ): Promise<PublishLocalLegacyAdoptionResult> {
    assertCommand(input);
    const subject = normalizeProjectPolicySubject(input.subject);
    const audit = normalizeSecurityAuditRecord(input.audit);
    const fence = input.fence;
    if (
      !fence ||
      !Number.isSafeInteger(fence.projectVersion) ||
      fence.projectVersion < 1 ||
      !Number.isSafeInteger(fence.bindingVersion) ||
      (fence.bindingVersion as number) < 1 ||
      audit.eventId !== input.mutationId ||
      audit.operationId !== 'task.adopt' ||
      audit.projectId !== input.projectId ||
      audit.subject?.type !== subject.type ||
      audit.subject?.id !== subject.id ||
      audit.outcome !== 'allowed' ||
      audit.fence?.projectVersion !== fence.projectVersion ||
      audit.fence.bindingVersion !== fence.bindingVersion ||
      audit.occurredAtMs !== input.createdAtMs
    ) {
      return Promise.reject(new LocalLegacyAdoptionConflictError());
    }
    return import(
      '@qinglong/runtime-core/task-definition-execution-compiler'
    ).then(({ compileLocalCommandTaskDefinition }) =>
      this.authority.enqueue(
        async () => {
          const client = this.authority.client;
          let began = false;
          try {
            client.exec('BEGIN IMMEDIATE');
            began = true;
            const replayRows = client
              .prepare(
                `SELECT ${LEDGER_SELECT}
                 FROM "QingLong3LegacyAdoptions"
                 WHERE "mutation_id" = ? OR "decision_id" = ? LIMIT 2`,
              )
              .all(input.mutationId, input.decisionId) as Row[];
            if (replayRows.length > 0) {
              if (replayRows.length !== 1) {
                throw new LocalLegacyAdoptionConflictError();
              }
              const existing = adoptionRecord(replayRows[0] as Row);
              if (!exactReplay(existing, input)) {
                throw new LocalLegacyAdoptionConflictError();
              }
              await input.confirmExternalAuthority();
              client.exec('COMMIT');
              began = false;
              return Object.freeze({
                status: 'existing' as const,
                adoption: existing,
              });
            }

            const project = client
              .prepare(
                `SELECT "version", "status" FROM "QingLong3Projects"
                 WHERE "id" = ? LIMIT 1`,
              )
              .get(input.projectId) as Row | undefined;
            if (
              !project ||
              integer(project, 'version') !== fence.projectVersion ||
              text(project, 'status') !== 'active'
            ) {
              throw new LocalLegacyAdoptionAuthorizationFenceConflictError();
            }
            const binding = client
              .prepare(
                `SELECT "version", "state", "role"
                 FROM "QingLong3ProjectRoleBindings"
                 WHERE "project_id" = ? AND "subject_type" = ?
                   AND "subject_id" = ?
                 ORDER BY "version" DESC LIMIT 1`,
              )
              .get(input.projectId, subject.type, subject.id) as
              | Row
              | undefined;
            if (
              !binding ||
              integer(binding, 'version') !== fence.bindingVersion ||
              text(binding, 'state') !== 'active' ||
              !['owner', 'admin'].includes(text(binding, 'role'))
            ) {
              throw new LocalLegacyAdoptionAuthorizationFenceConflictError();
            }

            const taskRegistry = createBuiltInTaskSpecSemanticRegistry();
            const triggerRegistry = createBuiltInTriggerSpecSemanticRegistry();
            const dispatch = new LocalSqliteDispatchDefinitionStore(client);
            const publication = createHash('sha256')
              .update('qinglong3.legacy-adoption-publication.v1\0')
              .update(input.mutationId);
            let adoptedTaskCount = 0;
            let adoptedTriggerCount = 0;
            let previousRowOrdinal = 0;
            for (const candidate of input.candidates) {
              adoptedTaskCount += 1;
              if (
                adoptedTaskCount > MAX_LOCAL_LEGACY_ADOPTION_TASKS ||
                !candidate ||
                typeof candidate !== 'object' ||
                !Number.isSafeInteger(candidate.rowOrdinal) ||
                candidate.rowOrdinal <= previousRowOrdinal ||
                candidate.rowOrdinal > input.rowCount ||
                !DIGEST_PATTERN.test(candidate.sourceDigest) ||
                candidate.task.kind !== 'command'
              ) {
                throw new LocalLegacyAdoptionConflictError();
              }
              previousRowOrdinal = candidate.rowOrdinal;
              const taskCommand = normalizeAppendTaskDefinitionRevisionCommand({
                projectId: input.projectId,
                taskId: candidate.task.taskId,
                expectedRevision: null,
                mutationId: deterministicMutationId(
                  input.mutationId,
                  `task:${candidate.rowOrdinal}`,
                ),
                name: candidate.task.name,
                kind: candidate.task.kind,
                spec: candidate.task.spec,
                labels: candidate.task.labels,
                enabled: candidate.task.enabled,
                occurredAtMs: input.createdAtMs,
              });
              const task = createTaskDefinitionRecord(
                {
                  ...taskCommand,
                  spec: taskRegistry.normalize({
                    projectId: input.projectId,
                    taskId: taskCommand.taskId,
                    kind: taskCommand.kind,
                    spec: taskCommand.spec,
                  }),
                },
                input.createdAtMs,
              );
              if (
                task.spec.schema !== BUILT_IN_COMMAND_TASK_SPEC_SCHEMA ||
                client
                  .prepare(
                    `SELECT 1 FROM "QingLong3TaskDefinitions"
                     WHERE "project_id" = ? AND "task_id" = ?`,
                  )
                  .get(task.projectId, task.taskId)
              ) {
                throw new LocalLegacyAdoptionConflictError();
              }
              client
                .prepare(
                  `INSERT INTO "QingLong3TaskDefinitions" (
                     "project_id", "task_id", "current_revision",
                     "created_at_ms", "updated_at_ms"
                   ) VALUES (?, ?, 1, ?, ?)`,
                )
                .run(
                  task.projectId,
                  task.taskId,
                  task.createdAtMs,
                  task.updatedAtMs,
                );
              client
                .prepare(
                  `INSERT INTO "QingLong3TaskDefinitionRevisions" (
                     "project_id", "task_id", "revision", "mutation_id",
                     "name", "description", "kind", "spec_json", "labels_json",
                     "enabled", "content_digest", "created_at_ms"
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  task.projectId,
                  task.taskId,
                  task.revision,
                  task.mutationId,
                  task.name,
                  task.description ?? null,
                  task.kind,
                  JSON.stringify(task.spec),
                  JSON.stringify(task.labels),
                  task.enabled ? 1 : 0,
                  task.contentDigest,
                  task.updatedAtMs,
                );
              if (task.enabled) {
                dispatch.appendPlan(
                  compileLocalCommandTaskDefinition(task, taskRegistry),
                );
              }
              publication
                .update('\0task\0')
                .update(String(candidate.rowOrdinal))
                .update('\0')
                .update(candidate.sourceDigest)
                .update('\0')
                .update(task.contentDigest);

              for (const [
                triggerIndex,
                value,
              ] of candidate.triggers.entries()) {
                adoptedTriggerCount += 1;
                if (
                  adoptedTriggerCount > MAX_LOCAL_LEGACY_ADOPTION_TRIGGERS ||
                  (value.enabled && !task.enabled)
                ) {
                  throw new LocalLegacyAdoptionConflictError();
                }
                const triggerCommand = normalizeAppendTriggerRevisionCommand({
                  projectId: input.projectId,
                  triggerId: value.triggerId,
                  expectedRevision: null,
                  mutationId: deterministicMutationId(
                    input.mutationId,
                    `trigger:${candidate.rowOrdinal}:${triggerIndex + 1}`,
                  ),
                  taskId: task.taskId,
                  taskRevision: task.revision,
                  taskContentDigest: task.contentDigest,
                  spec: value.spec,
                  enabled: value.enabled,
                  occurredAtMs: input.createdAtMs,
                });
                const trigger = createTriggerRecord(
                  {
                    ...triggerCommand,
                    spec: triggerRegistry.normalize({
                      projectId: input.projectId,
                      triggerId: triggerCommand.triggerId,
                      taskId: task.taskId,
                      taskRevision: task.revision,
                      spec: triggerCommand.spec,
                    }),
                  },
                  input.createdAtMs,
                );
                if (
                  client
                    .prepare(
                      `SELECT 1 FROM "QingLong3Triggers"
                       WHERE "project_id" = ? AND "trigger_id" = ?`,
                    )
                    .get(trigger.projectId, trigger.triggerId)
                ) {
                  throw new LocalLegacyAdoptionConflictError();
                }
                client
                  .prepare(
                    `INSERT INTO "QingLong3Triggers" (
                       "project_id", "trigger_id", "task_id", "current_revision",
                       "created_at_ms", "updated_at_ms"
                     ) VALUES (?, ?, ?, 1, ?, ?)`,
                  )
                  .run(
                    trigger.projectId,
                    trigger.triggerId,
                    trigger.taskId,
                    trigger.createdAtMs,
                    trigger.updatedAtMs,
                  );
                client
                  .prepare(
                    `INSERT INTO "QingLong3TriggerRevisions" (
                       "project_id", "trigger_id", "revision", "mutation_id",
                       "task_id", "task_revision", "task_content_digest",
                       "spec_json", "enabled", "content_digest", "created_at_ms"
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .run(
                    trigger.projectId,
                    trigger.triggerId,
                    trigger.revision,
                    trigger.mutationId,
                    trigger.taskId,
                    trigger.taskRevision,
                    trigger.taskContentDigest,
                    JSON.stringify(trigger.spec),
                    trigger.enabled ? 1 : 0,
                    trigger.contentDigest,
                    trigger.updatedAtMs,
                  );
                const scheduleConfig = trigger.spec.config as Readonly<{
                  expression?: unknown;
                  timezone?: unknown;
                }>;
                if (
                  trigger.spec.schema !== BUILT_IN_CRON_TRIGGER_SPEC_SCHEMA ||
                  typeof scheduleConfig.expression !== 'string' ||
                  typeof scheduleConfig.timezone !== 'string'
                ) {
                  throw new LocalLegacyAdoptionConflictError();
                }
                client
                  .prepare(
                    `INSERT INTO "QingLong3LocalTriggerSchedules" (
                     "project_id", "trigger_id", "trigger_revision",
                       "next_fire_at_ms", "last_scheduled_at_ms",
                       "state_version", "updated_at_ms"
                     ) VALUES (?, ?, ?, NULL, NULL, 0, ?)`,
                  )
                  .run(
                    trigger.projectId,
                    trigger.triggerId,
                    trigger.revision,
                    trigger.updatedAtMs,
                  );
                publication.update('\0trigger\0').update(trigger.contentDigest);
              }
            }
            if (adoptedTaskCount + input.skippedCount !== input.rowCount) {
              throw new LocalLegacyAdoptionConflictError();
            }
            const publicationDigest = publication.digest('hex');
            insertAudit(client, audit);
            client
              .prepare(
                `INSERT INTO "QingLong3LegacyAdoptions" (
                   "mutation_id", "decision_id", "project_id", "profile",
                   "plan_digest", "inventory_digest", "decision_digest",
                   "receipt_digest", "authorization_file_digest",
                   "publication_digest", "row_count", "adopted_task_count",
                   "adopted_trigger_count", "skipped_count", "audit_event_id",
                   "created_at_ms"
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                input.mutationId,
                input.decisionId,
                input.projectId,
                input.profile,
                input.planDigest,
                input.inventoryDigest,
                input.decisionDigest,
                input.receiptDigest,
                input.authorizationFileDigest,
                publicationDigest,
                input.rowCount,
                adoptedTaskCount,
                adoptedTriggerCount,
                input.skippedCount,
                audit.eventId,
                input.createdAtMs,
              );
            const stored = adoptionRecord(
              client
                .prepare(
                  `SELECT ${LEDGER_SELECT} FROM "QingLong3LegacyAdoptions"
                   WHERE "mutation_id" = ?`,
                )
                .get(input.mutationId) as Row,
            );
            await input.confirmExternalAuthority();
            client.exec('COMMIT');
            began = false;
            return Object.freeze({
              status: 'inserted' as const,
              adoption: stored,
            });
          } catch (error) {
            if (began && client.isTransaction) {
              try {
                client.exec('ROLLBACK');
              } catch {
                // Preserve the original failure.
              }
            }
            if (
              error instanceof LocalLegacyAdoptionConflictError ||
              error instanceof
                LocalLegacyAdoptionAuthorizationFenceConflictError ||
              error instanceof LocalLegacyAdoptionUnavailableError
            ) {
              throw error;
            }
            if (
              error &&
              typeof error === 'object' &&
              'code' in error &&
              typeof error.code === 'string' &&
              error.code.startsWith('SQLITE_CONSTRAINT')
            ) {
              throw new LocalLegacyAdoptionConflictError();
            }
            throw new LocalLegacyAdoptionUnavailableError(error);
          }
        },
        () => new LocalLegacyAdoptionUnavailableError(),
      ),
    );
  }
}

export interface LocalSqliteAdoptionDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly projectPolicy: ProjectPolicyRepository;
  readonly securityAudit: SecurityAuditSink;
  readonly publisher: LocalSqliteLegacyAdoptionPublisher;
  close(): Promise<void>;
}

/** Short-lived reviewed adoption authority; long-lived Profile hosts must not import it. */
export async function openLocalSqliteAdoptionDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteAdoptionDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    const securityAuthority = new LocalSqliteSecurityAuthorityStore(authority);
    const projectPolicy: ProjectPolicyRepository = Object.freeze({
      resolve: (
        ...[projectId, subject]: Parameters<ProjectPolicyRepository['resolve']>
      ) => securityAuthority.resolve(projectId, subject),
      append: (...[command]: Parameters<ProjectPolicyRepository['append']>) =>
        securityAuthority.append(command),
    });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      projectPolicy,
      securityAudit: securityAuthority,
      publisher: new LocalSqliteLegacyAdoptionPublisher(authority),
      close() {
        if (closePromise) return closePromise;
        closePromise = authority.close();
        return closePromise;
      },
    });
  } catch (error) {
    client.close();
    throw error;
  }
}
