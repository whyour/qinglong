import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  approvedActionDispatchDigest,
  normalizeApprovedActionDispatchRecord,
  type ApprovedActionDispatchRecord,
} from '@qinglong/runtime-core/approved-action';
import {
  InvalidPluginPackageAutomationPublicationError,
  PluginPackageAutomationPublicationConflictError,
  PluginPackageAutomationPublicationUnavailableError,
  createPluginPackageAutomationLifecyclePublication,
} from '@qinglong/runtime-core/plugin-package-automation-publication';
import {
  InvalidPluginPackageLifecycleError,
  MAX_PLUGIN_PACKAGE_LIFECYCLE_TASKS,
  PLUGIN_PACKAGE_LIFECYCLE_ACTIONS,
  PluginPackageLifecycleConflictError,
  PluginPackageLifecycleUnavailableError,
  assertPluginPackageLifecycleReceiptMatchesEvent,
  createPluginPackageLifecycleImpact,
  createPluginPackageLifecycleReceipt,
  normalizePluginPackageLifecycleEvent,
  normalizePluginPackageLifecycleReceipt,
  pluginPackageLifecycleReferenceGraphDigest,
  pluginPackageLifecycleTaskMutationId,
  type PluginPackageLifecycleAction,
  type PluginPackageLifecycleBlockingReference,
  type PluginPackageLifecycleEvent,
  type PluginPackageLifecycleHead,
  type PluginPackageLifecycleImpact,
  type PluginPackageLifecycleReceipt,
  type PluginPackageLifecycleRepository,
  type PluginPackageLifecycleTaskTransition,
} from '@qinglong/runtime-core/plugin-package-lifecycle';
import {
  normalizePluginPackageInstallRecord,
  type PluginPackageInstallRecord,
} from '@qinglong/runtime-core/plugin-package-install';
import {
  normalizePluginPackageMaterializedRevision,
  type PluginPackageMaterializedRevision,
} from '@qinglong/runtime-core/plugin-package-resource-materialization';
import {
  createProjectToolDefinitionSnapshot,
  normalizeProjectToolDefinitionSnapshot,
  projectToolDefinitionSnapshotContribution,
  type ProjectToolDefinitionSnapshot,
  type ProjectToolDefinitionSnapshotContribution,
} from '@qinglong/runtime-core/project-tool-definition-snapshot';
import {
  createTaskDefinitionRecord,
  normalizeTaskDefinitionRecord,
  type TaskDefinitionRecord,
} from '@qinglong/runtime-core/task-definition';
import {
  TaskSpecSemanticRegistry,
  createBuiltInTaskSpecSemanticRegistry,
} from '@qinglong/runtime-core/task-spec-semantic';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqlitePluginPackageAutomationPublicationRepository } from './pluginPackageAutomationPublicationRepository';

type Row = Record<string, unknown>;

export const EDGE_PLUGIN_PACKAGE_LIFECYCLE_ACTIVE_SOURCE_LIMIT = 4;
export const STANDALONE_PLUGIN_PACKAGE_LIFECYCLE_ACTIVE_SOURCE_LIMIT = 16;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizePlanTarget(
  action: PluginPackageLifecycleAction,
  projectId: string,
  packageName: string,
): Readonly<{
  action: PluginPackageLifecycleAction;
  projectId: string;
  packageName: string;
}> {
  if (
    typeof action !== 'string' ||
    !PLUGIN_PACKAGE_LIFECYCLE_ACTIONS.includes(action)
  ) {
    throw new InvalidPluginPackageLifecycleError('action is invalid');
  }
  if (
    typeof projectId !== 'string' ||
    projectId.length < 1 ||
    Buffer.byteLength(projectId, 'utf8') > 128 ||
    projectId.includes('\0')
  ) {
    throw new InvalidPluginPackageLifecycleError('projectId is invalid');
  }
  if (
    typeof packageName !== 'string' ||
    !PACKAGE_NAME_PATTERN.test(packageName)
  ) {
    throw new InvalidPluginPackageLifecycleError('packageName is invalid');
  }
  return Object.freeze({ action, projectId, packageName });
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new PluginPackageLifecycleUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PluginPackageLifecycleUnavailableError();
  }
  return value as number;
}

function json(row: Row, key: string): unknown {
  try {
    return JSON.parse(text(row, key));
  } catch {
    throw new PluginPackageLifecycleUnavailableError();
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackageAutomationPublicationError ||
    error instanceof PluginPackageAutomationPublicationConflictError
  ) {
    return new PluginPackageLifecycleConflictError(
      'Workflow/Prompt publication does not match lifecycle state',
    );
  }
  if (error instanceof PluginPackageAutomationPublicationUnavailableError) {
    return new PluginPackageLifecycleUnavailableError({ cause: error });
  }
  if (
    error instanceof InvalidPluginPackageLifecycleError ||
    error instanceof PluginPackageLifecycleConflictError ||
    error instanceof PluginPackageLifecycleUnavailableError
  ) {
    return error;
  }
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  ) {
    return new PluginPackageLifecycleConflictError(
      'durable lifecycle identity is already bound',
    );
  }
  return new PluginPackageLifecycleUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

function taskRecord(row: Row): Readonly<TaskDefinitionRecord> {
  try {
    return normalizeTaskDefinitionRecord({
      projectId: text(row, 'projectId'),
      taskId: text(row, 'taskId'),
      revision: integer(row, 'revision'),
      mutationId: text(row, 'mutationId'),
      name: text(row, 'name'),
      ...(row.description === null
        ? {}
        : { description: text(row, 'description') }),
      kind: text(row, 'kind') as TaskDefinitionRecord['kind'],
      spec: json(row, 'specJson') as TaskDefinitionRecord['spec'],
      labels: json(row, 'labelsJson') as TaskDefinitionRecord['labels'],
      enabled: integer(row, 'enabled') === 1,
      contentDigest: text(row, 'contentDigest'),
      createdAtMs: integer(row, 'createdAtMs'),
      updatedAtMs: integer(row, 'updatedAtMs'),
    });
  } catch (error) {
    if (error instanceof PluginPackageLifecycleUnavailableError) throw error;
    throw new PluginPackageLifecycleUnavailableError();
  }
}

export class LocalSqlitePluginPackageLifecycleRepository
  implements PluginPackageLifecycleRepository
{
  readonly #authority: LocalSqliteOperationAuthority;
  readonly #registry: TaskSpecSemanticRegistry;
  readonly #activeSourceLimit: number;

  constructor(
    authority: LocalSqliteOperationAuthority | DatabaseSync,
    options: Readonly<{
      registry?: TaskSpecSemanticRegistry;
      activeSourceLimit?: number;
    }> = {},
  ) {
    const registry =
      options.registry ?? createBuiltInTaskSpecSemanticRegistry();
    const activeSourceLimit =
      options.activeSourceLimit ??
      STANDALONE_PLUGIN_PACKAGE_LIFECYCLE_ACTIVE_SOURCE_LIMIT;
    if (!(registry instanceof TaskSpecSemanticRegistry)) {
      throw new TypeError('TaskSpec semantic registry is invalid');
    }
    if (
      !Number.isSafeInteger(activeSourceLimit) ||
      activeSourceLimit < 1 ||
      activeSourceLimit >
        STANDALONE_PLUGIN_PACKAGE_LIFECYCLE_ACTIVE_SOURCE_LIMIT
    ) {
      throw new RangeError('active source limit is invalid');
    }
    this.#authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
    this.#registry = registry;
    this.#activeSourceLimit = activeSourceLimit;
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
      () => new PluginPackageLifecycleUnavailableError(),
    );
  }

  #currentInstall(
    projectId: string,
    packageName: string,
  ): Readonly<PluginPackageInstallRecord> {
    const row = this.#authority.client
      .prepare(
        `SELECT install.record_json AS "recordJson"
         FROM "QingLong3PluginPackageInstallHeads" AS head
         JOIN "QingLong3PluginPackageInstalls" AS install
           ON install.installation_id = head.installation_id
         WHERE head.project_id = ? AND head.package_name = ?`,
      )
      .get(projectId, packageName) as Row | undefined;
    if (!row) {
      throw new PluginPackageLifecycleConflictError(
        'current Package installation is absent',
      );
    }
    try {
      const record = normalizePluginPackageInstallRecord(
        json(row, 'recordJson') as PluginPackageInstallRecord,
      );
      if (
        record.state !== 'active' ||
        record.activeLockDigest !== record.lockDigest
      ) {
        throw new PluginPackageLifecycleConflictError(
          'current Package installation is not active',
        );
      }
      return record;
    } catch (error) {
      if (error instanceof PluginPackageLifecycleConflictError) throw error;
      throw new PluginPackageLifecycleUnavailableError();
    }
  }

  #materialized(
    record: Readonly<PluginPackageInstallRecord>,
  ): Readonly<PluginPackageMaterializedRevision> {
    const row = this.#authority.client
      .prepare(
        `SELECT revision_json AS "revisionJson"
         FROM "QingLong3PluginPackageMaterializedRevisions"
         WHERE project_id = ? AND package_name = ? AND generation = ?
           AND lock_digest = ?`,
      )
      .get(
        record.projectId,
        record.packageName,
        record.targetGeneration,
        record.lockDigest,
      ) as Row | undefined;
    if (!row) {
      throw new PluginPackageLifecycleConflictError(
        'materialized Package revision is absent',
      );
    }
    try {
      return normalizePluginPackageMaterializedRevision(
        json(row, 'revisionJson') as PluginPackageMaterializedRevision,
        this.#registry,
      );
    } catch {
      throw new PluginPackageLifecycleUnavailableError();
    }
  }

  #storedHead(
    projectId: string,
    packageName: string,
  ): Readonly<PluginPackageLifecycleHead> | null {
    const row = this.#authority.client
      .prepare(
        `SELECT head.project_id AS "projectId",
                head.package_name AS "packageName",
                head.installation_id AS "installationId",
                head.lock_digest AS "lockDigest",
                head.install_record_digest AS "installRecordDigest",
                head.version, head.disposition,
                head.event_digest AS "eventDigest",
                head.updated_at_ms AS "updatedAtMs",
                receipt.receipt_json AS "receiptJson"
         FROM "QingLong3PluginPackageLifecycleHeads" AS head
         JOIN "QingLong3PluginPackageLifecycleReceipts" AS receipt
           ON receipt.event_digest = head.event_digest
         WHERE head.project_id = ? AND head.package_name = ?`,
      )
      .get(projectId, packageName) as Row | undefined;
    if (!row) return null;
    try {
      const lifecycle = normalizePluginPackageLifecycleReceipt(
        json(row, 'receiptJson') as PluginPackageLifecycleReceipt,
      ).lifecycle;
      if (
        lifecycle.projectId !== text(row, 'projectId') ||
        lifecycle.packageName !== text(row, 'packageName') ||
        lifecycle.installationId !== text(row, 'installationId') ||
        lifecycle.lockDigest !== text(row, 'lockDigest') ||
        lifecycle.installRecordDigest !== text(row, 'installRecordDigest') ||
        lifecycle.version !== integer(row, 'version') ||
        lifecycle.disposition !== text(row, 'disposition') ||
        lifecycle.eventDigest !== text(row, 'eventDigest') ||
        lifecycle.updatedAtMs !== integer(row, 'updatedAtMs')
      ) {
        throw new PluginPackageLifecycleUnavailableError();
      }
      return lifecycle;
    } catch {
      throw new PluginPackageLifecycleUnavailableError();
    }
  }

  #event(
    eventDigest: string,
  ): Readonly<PluginPackageLifecycleEvent> | null {
    const row = this.#authority.client
      .prepare(
        `SELECT event_json AS "eventJson"
         FROM "QingLong3PluginPackageLifecycleEvents"
         WHERE event_digest = ?`,
      )
      .get(eventDigest) as Row | undefined;
    if (!row) return null;
    try {
      return normalizePluginPackageLifecycleEvent(
        json(row, 'eventJson') as PluginPackageLifecycleEvent,
      );
    } catch {
      throw new PluginPackageLifecycleUnavailableError();
    }
  }

  #receipt(
    event: Readonly<PluginPackageLifecycleEvent>,
  ): Readonly<PluginPackageLifecycleReceipt> | null {
    const row = this.#authority.client
      .prepare(
        `SELECT receipt_json AS "receiptJson"
         FROM "QingLong3PluginPackageLifecycleReceipts"
         WHERE event_digest = ?`,
      )
      .get(event.eventDigest) as Row | undefined;
    if (!row) return null;
    try {
      const receipt = normalizePluginPackageLifecycleReceipt(
        json(row, 'receiptJson') as PluginPackageLifecycleReceipt,
      );
      assertPluginPackageLifecycleReceiptMatchesEvent(event, receipt);
      const taskRows = this.#authority.client
        .prepare(
          `SELECT task_id AS "taskId",
                  previous_revision AS "previousRevision",
                  current_revision AS "currentRevision",
                  previous_content_digest AS "previousContentDigest",
                  current_content_digest AS "currentContentDigest",
                  previous_enabled AS "previousEnabled",
                  current_enabled AS "currentEnabled"
           FROM "QingLong3PluginPackageLifecycleTasks"
           WHERE event_digest = ?
           ORDER BY task_id COLLATE BINARY`,
        )
        .all(event.eventDigest) as Row[];
      const storedTransitions = taskRows.map((taskRow) => ({
        taskId: text(taskRow, 'taskId'),
        previousRevision: integer(taskRow, 'previousRevision'),
        currentRevision: integer(taskRow, 'currentRevision'),
        previousContentDigest: text(taskRow, 'previousContentDigest'),
        currentContentDigest: text(taskRow, 'currentContentDigest'),
        previousEnabled: integer(taskRow, 'previousEnabled') === 1,
        currentEnabled: integer(taskRow, 'currentEnabled') === 1,
      }));
      const snapshot = this.#authority.client
        .prepare(
          `SELECT snapshot_digest AS "snapshotDigest",
                  (
                    SELECT COUNT(*)
                    FROM "QingLong3ProjectToolDefinitionSnapshotSources"
                    WHERE project_id = snapshot.project_id
                      AND active_vector_digest =
                        snapshot.active_vector_digest
                  ) AS "sourceCount"
           FROM "QingLong3ProjectToolDefinitionSnapshots" AS snapshot
           WHERE project_id = ? AND active_vector_digest = ?`,
        )
        .get(
          receipt.target.projectId,
          receipt.capability.currentActiveVectorDigest,
        ) as Row | undefined;
      if (
        !same(storedTransitions, receipt.capability.taskTransitions) ||
        !snapshot ||
        text(snapshot, 'snapshotDigest') !==
          receipt.capability.currentToolSnapshotDigest ||
        integer(snapshot, 'sourceCount') !==
          receipt.capability.retainedSourceCount
      ) {
        throw new PluginPackageLifecycleUnavailableError();
      }
      return receipt;
    } catch {
      throw new PluginPackageLifecycleUnavailableError();
    }
  }

  #assertDispatch(event: Readonly<PluginPackageLifecycleEvent>): void {
    const row = this.#authority.client
      .prepare(
        `SELECT dispatch_json AS "dispatchJson",
                dispatch_digest AS "dispatchDigest"
         FROM "QingLong3ApprovedActionDispatches"
         WHERE dispatch_id = ?`,
      )
      .get(event.dispatchId) as Row | undefined;
    if (!row) {
      throw new PluginPackageLifecycleConflictError(
        'approved action dispatch is absent',
      );
    }
    try {
      const dispatch = normalizeApprovedActionDispatchRecord(
        json(row, 'dispatchJson') as ApprovedActionDispatchRecord,
      );
      if (
        approvedActionDispatchDigest(dispatch) !==
          text(row, 'dispatchDigest') ||
        dispatch.projectId !== event.impact.target.projectId ||
        dispatch.action.permission !== 'package.manage' ||
        dispatch.action.actionType !==
          `plugin_package.lifecycle.${event.impact.action}` ||
        dispatch.action.actionDigest !== event.actionDigest ||
        dispatch.action.previewDigest !== event.impact.impactDigest ||
        dispatch.requestedBy.type !== event.requestedBy.type ||
        dispatch.requestedBy.id !== event.requestedBy.id ||
        dispatch.approvedBy.type !== event.approvedBy.type ||
        dispatch.approvedBy.id !== event.approvedBy.id ||
        event.occurredAtMs < dispatch.approvedAtMs ||
        event.occurredAtMs > dispatch.expiresAtMs
      ) {
        throw new PluginPackageLifecycleConflictError(
          'approved action dispatch does not authorize lifecycle event',
        );
      }
    } catch (error) {
      if (error instanceof PluginPackageLifecycleConflictError) throw error;
      throw new PluginPackageLifecycleUnavailableError();
    }
  }

  #contributions(
    projectId: string,
  ): readonly Readonly<ProjectToolDefinitionSnapshotContribution>[] {
    const rows = this.#authority.client
      .prepare(
        `SELECT revision.revision_json AS "revisionJson"
         FROM "QingLong3PluginPackageInstallHeads" AS head
         JOIN "QingLong3PluginPackageInstalls" AS head_install
           ON head_install.installation_id = head.installation_id
         JOIN "QingLong3PluginPackageInstalls" AS active_install
           ON active_install.project_id = head.project_id
          AND active_install.package_name = head.package_name
          AND active_install.lock_digest = head_install.active_lock_digest
         JOIN "QingLong3PluginPackageMaterializedRevisions" AS revision
           ON revision.project_id = active_install.project_id
          AND revision.package_name = active_install.package_name
          AND revision.generation = active_install.target_generation
          AND revision.lock_digest = active_install.lock_digest
         LEFT JOIN "QingLong3PluginPackageQuarantineEvents" AS quarantine
           ON quarantine.project_id = active_install.project_id
          AND quarantine.package_name = active_install.package_name
          AND quarantine.installation_id = active_install.installation_id
          AND quarantine.lock_digest = active_install.lock_digest
         LEFT JOIN "QingLong3PluginPackageLifecycleHeads" AS lifecycle
           ON lifecycle.project_id = active_install.project_id
          AND lifecycle.package_name = active_install.package_name
          AND lifecycle.installation_id = active_install.installation_id
          AND lifecycle.lock_digest = active_install.lock_digest
          AND lifecycle.install_record_digest = active_install.record_digest
         WHERE head.project_id = ?
           AND active_install.state = 'active'
           AND quarantine.event_digest IS NULL
           AND (
             lifecycle.event_digest IS NULL OR lifecycle.disposition = 'active'
           )
         ORDER BY head.package_name COLLATE BINARY
         LIMIT ?`,
      )
      .all(projectId, this.#activeSourceLimit + 1) as Row[];
    if (rows.length > this.#activeSourceLimit) {
      throw new PluginPackageLifecycleConflictError(
        'active Package sources exceed the local Profile limit',
      );
    }
    try {
      return Object.freeze(
        rows.map((row) =>
          projectToolDefinitionSnapshotContribution(
            json(row, 'revisionJson') as never,
            this.#registry,
          ),
        ),
      );
    } catch (error) {
      if (error instanceof PluginPackageLifecycleConflictError) throw error;
      throw new PluginPackageLifecycleUnavailableError();
    }
  }

  #currentSnapshot(
    projectId: string,
    contributions: readonly Readonly<ProjectToolDefinitionSnapshotContribution>[],
  ): Readonly<ProjectToolDefinitionSnapshot> {
    const expected = createProjectToolDefinitionSnapshot({
      projectId,
      contributions,
    });
    const row = this.#authority.client
      .prepare(
        `SELECT snapshot_json AS "snapshotJson"
         FROM "QingLong3ProjectToolDefinitionSnapshots"
         WHERE project_id = ? AND active_vector_digest = ?
           AND snapshot_digest = ?`,
      )
      .get(
        projectId,
        expected.activeVectorDigest,
        expected.snapshotDigest,
      ) as Row | undefined;
    if (!row) {
      throw new PluginPackageLifecycleConflictError(
        'current Tool snapshot is not durably published',
      );
    }
    try {
      const stored = normalizeProjectToolDefinitionSnapshot(
        json(row, 'snapshotJson') as ProjectToolDefinitionSnapshot,
      );
      if (!same(stored, expected)) {
        throw new PluginPackageLifecycleUnavailableError();
      }
      return stored;
    } catch (error) {
      if (error instanceof PluginPackageLifecycleUnavailableError) throw error;
      throw new PluginPackageLifecycleUnavailableError();
    }
  }

  #ownedTasks(
    record: Readonly<PluginPackageInstallRecord>,
  ): readonly Readonly<TaskDefinitionRecord>[] {
    const rows = this.#authority.client
      .prepare(
        `SELECT head.project_id AS "projectId", head.task_id AS "taskId",
                revision.revision AS "revision",
                revision.mutation_id AS "mutationId",
                revision.name AS "name",
                revision.description AS "description",
                revision.kind AS "kind", revision.spec_json AS "specJson",
                revision.labels_json AS "labelsJson",
                revision.enabled AS "enabled",
                revision.content_digest AS "contentDigest",
                head.created_at_ms AS "createdAtMs",
                revision.created_at_ms AS "updatedAtMs"
         FROM "QingLong3PluginPackageTaskOwnerships" AS ownership
         JOIN "QingLong3TaskDefinitions" AS head
           ON head.project_id = ownership.project_id
          AND head.task_id = ownership.task_id
         JOIN "QingLong3TaskDefinitionRevisions" AS revision
           ON revision.project_id = head.project_id
          AND revision.task_id = head.task_id
          AND revision.revision = head.current_revision
         WHERE ownership.project_id = ? AND ownership.package_name = ?
         ORDER BY ownership.task_id COLLATE BINARY
         LIMIT ?`,
      )
      .all(
        record.projectId,
        record.packageName,
        MAX_PLUGIN_PACKAGE_LIFECYCLE_TASKS + 1,
      ) as Row[];
    if (rows.length > MAX_PLUGIN_PACKAGE_LIFECYCLE_TASKS) {
      throw new PluginPackageLifecycleConflictError(
        'owned Tasks exceed the lifecycle limit',
      );
    }
    return Object.freeze(rows.map(taskRecord));
  }

  #blockingReferences(
    record: Readonly<PluginPackageInstallRecord>,
  ): readonly Readonly<PluginPackageLifecycleBlockingReference>[] {
    const rows = this.#authority.client
      .prepare(
        `SELECT run.id AS "runId", run.status, run.version,
                run.event_sequence AS "eventSequence",
                run.task_id AS "taskId", run.task_revision AS "taskRevision"
         FROM "Runs" AS run
         JOIN "QingLong3PluginPackageTaskOwnerships" AS ownership
           ON ownership.project_id = run.project_id
          AND ownership.task_id = run.task_id
         WHERE ownership.project_id = ? AND ownership.package_name = ?
           AND run.status NOT IN (
             'succeeded','failed','cancelled','timed_out','quarantined'
           )
         ORDER BY run.id
         LIMIT ?`,
      )
      .all(
        record.projectId,
        record.packageName,
        MAX_PLUGIN_PACKAGE_LIFECYCLE_TASKS + 1,
      ) as Row[];
    if (rows.length > MAX_PLUGIN_PACKAGE_LIFECYCLE_TASKS) {
      throw new PluginPackageLifecycleConflictError(
        'execution recovery references exceed the lifecycle limit',
      );
    }
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          kind: 'execution_recovery' as const,
          ownerId: text(row, 'runId'),
          referenceDigest: createHash('sha256')
            .update(
              'qinglong/plugin-package-lifecycle-execution-reference@v1\0',
            )
            .update(
              JSON.stringify({
                runId: text(row, 'runId'),
                status: text(row, 'status'),
                version: integer(row, 'version'),
                eventSequence: integer(row, 'eventSequence'),
                taskId: text(row, 'taskId'),
                taskRevision: text(row, 'taskRevision'),
              }),
            )
            .digest('hex'),
        }),
      ),
    );
  }

  #computeImpact(
    action: PluginPackageLifecycleAction,
    projectId: string,
    packageName: string,
  ): Readonly<PluginPackageLifecycleImpact> {
    ({ action, projectId, packageName } = normalizePlanTarget(
      action,
      projectId,
      packageName,
    ));
    const record = this.#currentInstall(projectId, packageName);
    const revision = this.#materialized(record);
    const head = this.#storedHead(projectId, packageName);
    const exactHead =
      head &&
      head.installationId === record.installationId &&
      head.lockDigest === record.lockDigest &&
      head.installRecordDigest === record.recordDigest
        ? head
        : null;
    const expected = exactHead
      ? {
          disposition: exactHead.disposition,
          version: exactHead.version,
          eventDigest: exactHead.eventDigest,
        }
      : { disposition: 'active' as const, version: 0, eventDigest: null };
    const contributions = this.#contributions(projectId);
    const targetContributions = contributions.filter(
      ({ generation }) =>
        generation.installationId === record.installationId &&
        generation.lockDigest === record.lockDigest,
    );
    if (
      (action === 'disable' && targetContributions.length !== 1) ||
      (action !== 'disable' && targetContributions.length !== 0)
    ) {
      throw new PluginPackageLifecycleConflictError(
        'current Tool source does not match lifecycle disposition',
      );
    }
    if (
      action === 'enable' &&
      contributions.length >= this.#activeSourceLimit
    ) {
      throw new PluginPackageLifecycleConflictError(
        'enabling Package would exceed the local Profile source limit',
      );
    }
    if (
      action === 'enable' &&
      this.#authority.client
        .prepare(
          `SELECT 1
           FROM "QingLong3PluginPackageQuarantineEvents"
           WHERE project_id = ? AND package_name = ?
             AND installation_id = ? AND lock_digest = ?
           LIMIT 1`,
        )
        .get(
          record.projectId,
          record.packageName,
          record.installationId,
          record.lockDigest,
        )
    ) {
      throw new PluginPackageLifecycleConflictError(
        'quarantined Package cannot be enabled',
      );
    }
    const snapshot = this.#currentSnapshot(projectId, contributions);
    const ownedTasks = this.#ownedTasks(record);
    let taskIds: readonly string[];
    if (action === 'disable') {
      taskIds = ownedTasks
        .filter((task) => task.enabled)
        .map((task) => task.taskId);
    } else if (action === 'enable') {
      if (!exactHead || exactHead.disposition !== 'disabled') {
        taskIds = [];
      } else {
        const priorEvent = this.#event(exactHead.eventDigest);
        const priorReceipt = priorEvent ? this.#receipt(priorEvent) : null;
        if (!priorReceipt || priorReceipt.action !== 'disable') {
          throw new PluginPackageLifecycleUnavailableError();
        }
        taskIds = priorReceipt.capability.taskTransitions.map(
          (task) => task.taskId,
        );
        if (
          taskIds.some((taskId) => {
            const current = ownedTasks.find((task) => task.taskId === taskId);
            const previous = priorReceipt.capability.taskTransitions.find(
              (task) => task.taskId === taskId,
            )!;
            return (
              !current ||
              current.enabled ||
              current.revision !== previous.currentRevision ||
              current.contentDigest !== previous.currentContentDigest
            );
          })
        ) {
          throw new PluginPackageLifecycleConflictError(
            'disabled Package Tasks advanced before enable',
          );
        }
      }
    } else {
      taskIds = [];
    }
    const resourceCounts = {
      tasks: revision.resources.filter(({ kind }) => kind === 'task').length,
      tools: revision.resources.filter(({ kind }) => kind === 'tool').length,
      workflows: revision.resources.filter(({ kind }) => kind === 'workflow')
        .length,
      prompts: revision.resources.filter(({ kind }) => kind === 'prompt')
        .length,
    };
    const blockingReferences = this.#blockingReferences(record);
    const graph = {
      target: {
        projectId: record.projectId,
        packageName: record.packageName,
        installationId: record.installationId,
        lockDigest: record.lockDigest,
        installVersion: record.version,
        installRecordDigest: record.recordDigest,
      },
      generationDigest: revision.generation.generationDigest,
      materializedRevisionDigest: revision.revisionDigest,
      taskIds,
      resourceCounts,
      blockingReferences,
    };
    return createPluginPackageLifecycleImpact({
      action,
      ...graph,
      expected,
      currentToolSnapshotDigest: snapshot.snapshotDigest,
      referenceGraphDigest:
        pluginPackageLifecycleReferenceGraphDigest(graph),
    });
  }

  plan(
    action: PluginPackageLifecycleAction,
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageLifecycleImpact>> {
    return this.#enqueue(() => {
      const client = this.#authority.client;
      client.exec('BEGIN');
      try {
        const impact = this.#computeImpact(action, projectId, packageName);
        client.exec('COMMIT');
        return impact;
      } catch (error) {
        if (client.isTransaction) client.exec('ROLLBACK');
        throw error;
      }
    });
  }

  findHead(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageLifecycleHead> | null> {
    return this.#enqueue(() => this.#storedHead(projectId, packageName));
  }

  findByEventDigest(
    eventDigest: string,
  ): Promise<Readonly<PluginPackageLifecycleReceipt> | null> {
    return this.#enqueue(() => {
      const event = this.#event(eventDigest);
      if (!event) return null;
      const receipt = this.#receipt(event);
      if (!receipt) throw new PluginPackageLifecycleUnavailableError();
      return receipt;
    });
  }

  #appendTask(
    event: Readonly<PluginPackageLifecycleEvent>,
    current: Readonly<TaskDefinitionRecord>,
    enabled: boolean,
    committedAtMs: number,
  ): Readonly<PluginPackageLifecycleTaskTransition> {
    const next = createTaskDefinitionRecord(
      {
        projectId: current.projectId,
        taskId: current.taskId,
        expectedRevision: current.revision,
        mutationId: pluginPackageLifecycleTaskMutationId(
          event.eventDigest,
          current.taskId,
        ),
        name: current.name,
        ...(current.description === undefined
          ? {}
          : { description: current.description }),
        kind: current.kind,
        spec: current.spec,
        labels: current.labels,
        enabled,
        occurredAtMs: committedAtMs,
      },
      current.createdAtMs,
    );
    this.#authority.client
      .prepare(
        `INSERT INTO "QingLong3TaskDefinitionRevisions" (
           project_id, task_id, revision, mutation_id, name, description,
           kind, spec_json, labels_json, enabled, content_digest, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        next.projectId,
        next.taskId,
        next.revision,
        next.mutationId,
        next.name,
        next.description ?? null,
        next.kind,
        JSON.stringify(next.spec),
        JSON.stringify(next.labels),
        next.enabled ? 1 : 0,
        next.contentDigest,
        next.updatedAtMs,
      );
    const update = this.#authority.client
      .prepare(
        `UPDATE "QingLong3TaskDefinitions"
         SET current_revision = ?, updated_at_ms = ?
         WHERE project_id = ? AND task_id = ? AND current_revision = ?`,
      )
      .run(
        next.revision,
        next.updatedAtMs,
        next.projectId,
        next.taskId,
        current.revision,
      );
    if (update.changes !== 1) {
      throw new PluginPackageLifecycleConflictError(
        'TaskDefinition head changed during lifecycle transition',
      );
    }
    return Object.freeze({
      taskId: current.taskId,
      previousRevision: current.revision,
      currentRevision: next.revision,
      previousContentDigest: current.contentDigest,
      currentContentDigest: next.contentDigest,
      previousEnabled: current.enabled,
      currentEnabled: next.enabled,
    });
  }

  #publishSnapshot(
    snapshot: Readonly<ProjectToolDefinitionSnapshot>,
    committedAtMs: number,
  ): void {
    const snapshotJson = JSON.stringify(snapshot);
    const insert = this.#authority.client
      .prepare(
        `INSERT INTO "QingLong3ProjectToolDefinitionSnapshots" (
           project_id, active_vector_digest, definitions_digest,
           snapshot_digest, snapshot_json, committed_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, active_vector_digest) DO NOTHING`,
      )
      .run(
        snapshot.projectId,
        snapshot.activeVectorDigest,
        snapshot.definitionsDigest,
        snapshot.snapshotDigest,
        snapshotJson,
        committedAtMs,
      );
    if (insert.changes === 1) {
      const statement = this.#authority.client.prepare(
        `INSERT INTO "QingLong3ProjectToolDefinitionSnapshotSources" (
           project_id, active_vector_digest, package_name, installation_id,
           generation, generation_digest, lock_digest, revision_digest
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const source of snapshot.sources) {
        statement.run(
          snapshot.projectId,
          snapshot.activeVectorDigest,
          source.packageName,
          source.installationId,
          source.generation,
          source.generationDigest,
          source.lockDigest,
          source.revisionDigest,
        );
      }
    }
    const stored = this.#authority.client
      .prepare(
        `SELECT snapshot_json AS "snapshotJson"
         FROM "QingLong3ProjectToolDefinitionSnapshots"
         WHERE project_id = ? AND active_vector_digest = ?`,
      )
      .get(snapshot.projectId, snapshot.activeVectorDigest) as Row | undefined;
    if (!stored || text(stored, 'snapshotJson') !== snapshotJson) {
      throw new PluginPackageLifecycleConflictError(
        'active vector is bound to another Tool snapshot',
      );
    }
  }

  #publishAutomationLifecycle(
    event: Readonly<PluginPackageLifecycleEvent>,
    record: Readonly<PluginPackageInstallRecord>,
    committedAtMs: number,
  ): void {
    if (
      event.impact.resourceCounts.workflows === 0 &&
      event.impact.resourceCounts.prompts === 0
    ) {
      return;
    }
    const publications =
      new LocalSqlitePluginPackageAutomationPublicationRepository(
        this.#authority,
      );
    const current = publications.findCurrentInTransaction(
      record.projectId,
      record.packageName,
    );
    if (
      !current ||
      current.target.projectId !== record.projectId ||
      current.target.packageName !== record.packageName ||
      current.target.installationId !== record.installationId ||
      current.target.lockDigest !== record.lockDigest ||
      current.target.generationDigest !== event.impact.generationDigest ||
      current.target.materializedRevisionDigest !==
        event.impact.materializedRevisionDigest
    ) {
      throw new PluginPackageLifecycleConflictError(
        'Workflow/Prompt publication does not match the active Package generation',
      );
    }
    const expectedState =
      event.impact.action === 'disable' ? 'active' : 'withdrawn';
    if (current.state !== expectedState) {
      throw new PluginPackageLifecycleConflictError(
        'Workflow/Prompt publication state does not match lifecycle disposition',
      );
    }
    if (event.impact.action === 'uninstall') return;
    publications.publishInTransaction(
      createPluginPackageAutomationLifecyclePublication({
        previous: current,
        state:
          event.impact.action === 'disable' ? 'withdrawn' : 'active',
        lifecycleEventDigest: event.eventDigest,
        publishedAtMs: committedAtMs,
      }),
    );
  }

  transition(
    eventValue: Readonly<PluginPackageLifecycleEvent>,
    confirmAuthorization: () => void | Promise<void>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackageLifecycleReceipt>;
    }>
  > {
    const event = normalizePluginPackageLifecycleEvent(eventValue);
    if (typeof confirmAuthorization !== 'function') {
      throw new InvalidPluginPackageLifecycleError(
        'confirmAuthorization is invalid',
      );
    }
    return this.#enqueue(async () => {
      const client = this.#authority.client;
      client.exec('BEGIN IMMEDIATE');
      try {
        await confirmAuthorization();
        this.#assertDispatch(event);
        const existing = this.#event(event.eventDigest);
        if (existing) {
          if (!same(existing, event)) {
            throw new PluginPackageLifecycleConflictError(
              'event digest is bound to another lifecycle event',
            );
          }
          const receipt = this.#receipt(existing);
          if (!receipt) throw new PluginPackageLifecycleUnavailableError();
          await confirmAuthorization();
          client.exec('COMMIT');
          return Object.freeze({ status: 'existing' as const, receipt });
        }
        const currentImpact = this.#computeImpact(
          event.impact.action,
          event.impact.target.projectId,
          event.impact.target.packageName,
        );
        if (!same(currentImpact, event.impact)) {
          throw new PluginPackageLifecycleConflictError(
            'approved lifecycle impact is stale',
          );
        }
        const record = this.#currentInstall(
          event.impact.target.projectId,
          event.impact.target.packageName,
        );
        if (
          event.impact.action === 'enable' &&
          client
            .prepare(
              `SELECT 1
               FROM "QingLong3PluginPackageQuarantineEvents"
               WHERE project_id = ? AND package_name = ?
                 AND installation_id = ? AND lock_digest = ?
               LIMIT 1`,
            )
            .get(
              record.projectId,
              record.packageName,
              record.installationId,
              record.lockDigest,
            )
        ) {
          throw new PluginPackageLifecycleConflictError(
            'quarantined Package cannot be enabled',
          );
        }
        const now = client
          .prepare(
            `SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS "nowMs"`,
          )
          .get() as Row;
        const committedAtMs = Math.max(
          integer(now, 'nowMs'),
          event.occurredAtMs,
        );
        const previousContributions = this.#contributions(record.projectId);
        const previousSnapshot = this.#currentSnapshot(
          record.projectId,
          previousContributions,
        );
        let nextContributions = previousContributions;
        if (event.impact.action === 'disable') {
          nextContributions = Object.freeze(
            previousContributions.filter(
              ({ generation }) =>
                generation.installationId !== record.installationId ||
                generation.lockDigest !== record.lockDigest,
            ),
          );
        } else if (event.impact.action === 'enable') {
          const revision = this.#materialized(record);
          nextContributions = Object.freeze([
            ...previousContributions,
            projectToolDefinitionSnapshotContribution(
              revision,
              this.#registry,
            ),
          ].sort((left, right) =>
            left.generation.packageName.localeCompare(
              right.generation.packageName,
            ),
          ));
        }
        const nextSnapshot =
          event.impact.action === 'uninstall'
            ? previousSnapshot
            : createProjectToolDefinitionSnapshot({
                projectId: record.projectId,
                contributions: nextContributions,
              });
        const taskById = new Map(
          this.#ownedTasks(record).map((task) => [task.taskId, task]),
        );
        const taskTransitions =
          event.impact.action === 'uninstall'
            ? []
            : event.impact.taskIds.map((taskId) => {
                const task = taskById.get(taskId);
                if (!task) {
                  throw new PluginPackageLifecycleConflictError(
                    'approved Package Task is absent',
                  );
                }
                return this.#appendTask(
                  event,
                  task,
                  event.impact.action === 'enable',
                  committedAtMs,
                );
              });
        if (event.impact.action !== 'uninstall') {
          this.#publishSnapshot(nextSnapshot, committedAtMs);
        }
        const lifecycle = Object.freeze({
          projectId: record.projectId,
          packageName: record.packageName,
          installationId: record.installationId,
          lockDigest: record.lockDigest,
          installRecordDigest: record.recordDigest,
          version: event.impact.expected.version + 1,
          disposition:
            event.impact.action === 'enable'
              ? ('active' as const)
              : event.impact.action === 'disable'
              ? ('disabled' as const)
              : ('uninstalled' as const),
          eventDigest: event.eventDigest,
          updatedAtMs: committedAtMs,
        });
        const receipt = createPluginPackageLifecycleReceipt({
          eventDigest: event.eventDigest,
          action: event.impact.action,
          target: event.impact.target,
          lifecycle,
          capability: {
            status:
              event.impact.action === 'enable'
                ? 'restored'
                : event.impact.action === 'disable'
                ? 'withdrawn'
                : 'retired',
            taskTransitions,
            previousActiveVectorDigest: previousSnapshot.activeVectorDigest,
            currentActiveVectorDigest: nextSnapshot.activeVectorDigest,
            currentToolSnapshotDigest: nextSnapshot.snapshotDigest,
            retainedSourceCount: nextSnapshot.sources.length,
          },
          committedAtMs,
        });
        this.#insert(event, receipt);
        this.#publishAutomationLifecycle(event, record, committedAtMs);
        await confirmAuthorization();
        client.exec('COMMIT');
        return Object.freeze({ status: 'created' as const, receipt });
      } catch (error) {
        if (client.isTransaction) client.exec('ROLLBACK');
        throw error;
      }
    });
  }

  #insert(
    event: Readonly<PluginPackageLifecycleEvent>,
    receipt: Readonly<PluginPackageLifecycleReceipt>,
  ): void {
    const impact = event.impact;
    const update = this.#authority.client
      .prepare(
        `INSERT INTO "QingLong3PluginPackageLifecycleEvents" (
           event_digest, mutation_id, dispatch_id, approved_action_type,
           action, project_id, package_name, installation_id, lock_digest,
           install_version, install_record_digest, expected_version,
           expected_disposition, expected_event_digest, generation_digest,
           materialized_revision_digest, current_tool_snapshot_digest,
           reference_graph_digest, impact_digest, action_digest,
           requested_by_type, requested_by_id, approved_by_type,
           approved_by_id, authorization_mode, occurred_at_ms, event_json
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        event.eventDigest,
        event.mutationId,
        event.dispatchId,
        `plugin_package.lifecycle.${impact.action}`,
        impact.action,
        impact.target.projectId,
        impact.target.packageName,
        impact.target.installationId,
        impact.target.lockDigest,
        impact.target.installVersion,
        impact.target.installRecordDigest,
        impact.expected.version,
        impact.expected.disposition,
        impact.expected.eventDigest,
        impact.generationDigest,
        impact.materializedRevisionDigest,
        impact.currentToolSnapshotDigest,
        impact.referenceGraphDigest,
        impact.impactDigest,
        event.actionDigest,
        event.requestedBy.type,
        event.requestedBy.id,
        event.approvedBy.type,
        event.approvedBy.id,
        event.authorizationMode,
        event.occurredAtMs,
        JSON.stringify(event),
      );
    const capability = receipt.capability;
    this.#authority.client
      .prepare(
        `INSERT INTO "QingLong3PluginPackageLifecycleReceipts" (
           event_digest, receipt_digest, project_id, action,
           capability_status, task_count, previous_active_vector_digest,
           current_active_vector_digest, current_tool_snapshot_digest,
           retained_source_count, committed_at_ms, receipt_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.eventDigest,
        receipt.receiptDigest,
        receipt.target.projectId,
        receipt.action,
        capability.status,
        capability.taskTransitions.length,
        capability.previousActiveVectorDigest,
        capability.currentActiveVectorDigest,
        capability.currentToolSnapshotDigest,
        capability.retainedSourceCount,
        receipt.committedAtMs,
        JSON.stringify(receipt),
      );
    const insertTask = this.#authority.client.prepare(
      `INSERT INTO "QingLong3PluginPackageLifecycleTasks" (
         event_digest, project_id, task_id, previous_revision,
         current_revision, previous_content_digest, current_content_digest,
         previous_enabled, current_enabled
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const task of capability.taskTransitions) {
      insertTask.run(
        receipt.eventDigest,
        receipt.target.projectId,
        task.taskId,
        task.previousRevision,
        task.currentRevision,
        task.previousContentDigest,
        task.currentContentDigest,
        task.previousEnabled ? 1 : 0,
        task.currentEnabled ? 1 : 0,
      );
    }
    this.#authority.client
      .prepare(
        `INSERT INTO "QingLong3PluginPackageLifecycleHeads" (
           project_id, package_name, installation_id, lock_digest,
           install_record_digest, version, disposition, event_digest,
           updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, package_name) DO UPDATE SET
           installation_id = excluded.installation_id,
           lock_digest = excluded.lock_digest,
           install_record_digest = excluded.install_record_digest,
           version = excluded.version,
           disposition = excluded.disposition,
           event_digest = excluded.event_digest,
           updated_at_ms = excluded.updated_at_ms
         WHERE (
           "QingLong3PluginPackageLifecycleHeads".installation_id =
             excluded.installation_id
           AND "QingLong3PluginPackageLifecycleHeads".lock_digest =
             excluded.lock_digest
           AND "QingLong3PluginPackageLifecycleHeads".version =
             excluded.version - 1
           AND "QingLong3PluginPackageLifecycleHeads".event_digest =
             ?
         ) OR (
           excluded.version = 1 AND (
             "QingLong3PluginPackageLifecycleHeads".installation_id <>
               excluded.installation_id OR
             "QingLong3PluginPackageLifecycleHeads".lock_digest <>
               excluded.lock_digest
           )
         )`,
      )
      .run(
        receipt.lifecycle.projectId,
        receipt.lifecycle.packageName,
        receipt.lifecycle.installationId,
        receipt.lifecycle.lockDigest,
        receipt.lifecycle.installRecordDigest,
        receipt.lifecycle.version,
        receipt.lifecycle.disposition,
        receipt.lifecycle.eventDigest,
        receipt.lifecycle.updatedAtMs,
        event.impact.expected.eventDigest,
      );
    if (update.changes !== 1) {
      throw new PluginPackageLifecycleConflictError(
        'lifecycle head changed during transition',
      );
    }
  }
}
