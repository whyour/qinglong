import type { DatabaseSync } from 'node:sqlite';

import {
  InvalidPluginPackageQuarantineError,
  MAX_PLUGIN_PACKAGE_QUARANTINE_TASK_WITHDRAWALS,
  PluginPackageQuarantineConflictError,
  PluginPackageQuarantineUnavailableError,
  assertPluginPackageWithdrawalMatchesEvent,
  createPluginPackageWithdrawalReceipt,
  normalizePluginPackageQuarantineEvent,
  normalizePluginPackageWithdrawalReceipt,
  pluginPackageQuarantineTaskMutationId,
  type PluginPackageQuarantineEvent,
  type PluginPackageQuarantineRepository,
  type PluginPackageQuarantineTarget,
  type PluginPackageQuarantineTaskWithdrawal,
  type PluginPackageWithdrawalReceipt,
} from '@qinglong/runtime-core/plugin-package-quarantine';
import {
  normalizePluginPackageInstallRecord,
  type PluginPackageInstallRecord,
} from '@qinglong/runtime-core/plugin-package-install';
import {
  createProjectToolDefinitionSnapshot,
  normalizeProjectToolDefinitionSnapshot,
  projectToolDefinitionActiveVectorDigest,
  projectToolDefinitionSnapshotContribution,
  type ProjectToolDefinitionSnapshot,
  type ProjectToolDefinitionSnapshotContribution,
  type ProjectToolDefinitionSnapshotSource,
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

type Row = Record<string, unknown>;

export const EDGE_PLUGIN_PACKAGE_QUARANTINE_ACTIVE_SOURCE_LIMIT = 4;
export const STANDALONE_PLUGIN_PACKAGE_QUARANTINE_ACTIVE_SOURCE_LIMIT = 16;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new PluginPackageQuarantineUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PluginPackageQuarantineUnavailableError();
  }
  return value as number;
}

function json(row: Row, key: string): unknown {
  try {
    return JSON.parse(text(row, key));
  } catch {
    throw new PluginPackageQuarantineUnavailableError();
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackageQuarantineError ||
    error instanceof PluginPackageQuarantineConflictError ||
    error instanceof PluginPackageQuarantineUnavailableError
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
    return new PluginPackageQuarantineConflictError(
      'durable quarantine identity is already bound',
    );
  }
  return new PluginPackageQuarantineUnavailableError({
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
    if (error instanceof PluginPackageQuarantineUnavailableError) throw error;
    throw new PluginPackageQuarantineUnavailableError();
  }
}

function activeSource(
  contribution: Readonly<ProjectToolDefinitionSnapshotContribution>,
): Readonly<ProjectToolDefinitionSnapshotSource> {
  return Object.freeze({
    installationId: contribution.generation.installationId,
    packageName: contribution.generation.packageName,
    generation: contribution.generation.generation,
    generationDigest: contribution.generation.generationDigest,
    lockDigest: contribution.generation.lockDigest,
    revisionDigest: contribution.revisionDigest,
  });
}

export class LocalSqlitePluginPackageQuarantineRepository
  implements PluginPackageQuarantineRepository
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
      STANDALONE_PLUGIN_PACKAGE_QUARANTINE_ACTIVE_SOURCE_LIMIT;
    if (!(registry instanceof TaskSpecSemanticRegistry)) {
      throw new TypeError('TaskSpec semantic registry is invalid');
    }
    if (
      !Number.isSafeInteger(activeSourceLimit) ||
      activeSourceLimit < 1 ||
      activeSourceLimit >
        STANDALONE_PLUGIN_PACKAGE_QUARANTINE_ACTIVE_SOURCE_LIMIT
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
      () => new PluginPackageQuarantineUnavailableError(),
    );
  }

  #eventByDigest(
    eventDigest: string,
  ): Readonly<PluginPackageQuarantineEvent> | null {
    const row = this.#authority.client
      .prepare(
        `SELECT event_json AS "eventJson"
         FROM "QingLong3PluginPackageQuarantineEvents"
         WHERE event_digest = ?`,
      )
      .get(eventDigest) as Row | undefined;
    if (!row) return null;
    try {
      return normalizePluginPackageQuarantineEvent(
        json(row, 'eventJson') as PluginPackageQuarantineEvent,
      );
    } catch (error) {
      if (error instanceof PluginPackageQuarantineUnavailableError) throw error;
      throw new PluginPackageQuarantineUnavailableError();
    }
  }

  #receiptByEvent(
    event: Readonly<PluginPackageQuarantineEvent>,
  ): Readonly<PluginPackageWithdrawalReceipt> | null {
    const row = this.#authority.client
      .prepare(
        `SELECT receipt_json AS "receiptJson"
         FROM "QingLong3PluginPackageWithdrawalReceipts"
         WHERE event_digest = ?`,
      )
      .get(event.eventDigest) as Row | undefined;
    if (!row) return null;
    try {
      const receipt = normalizePluginPackageWithdrawalReceipt(
        json(row, 'receiptJson') as PluginPackageWithdrawalReceipt,
      );
      assertPluginPackageWithdrawalMatchesEvent(event, receipt);
      this.#assertReceiptRelations(receipt);
      return receipt;
    } catch (error) {
      if (error instanceof PluginPackageQuarantineUnavailableError) throw error;
      throw new PluginPackageQuarantineUnavailableError();
    }
  }

  #assertReceiptRelations(
    receipt: Readonly<PluginPackageWithdrawalReceipt>,
  ): void {
    const rows = this.#authority.client
      .prepare(
        `SELECT item.project_id AS "projectId",
                item.task_id AS "taskId",
                item.previous_revision AS "previousRevision",
                item.disabled_revision AS "disabledRevision",
                item.previous_content_digest AS "previousContentDigest",
                item.disabled_content_digest AS "disabledContentDigest",
                previous.content_digest AS "storedPreviousContentDigest",
                disabled.content_digest AS "storedDisabledContentDigest"
         FROM "QingLong3PluginPackageWithdrawalTasks" AS item
         JOIN "QingLong3TaskDefinitionRevisions" AS previous
           ON previous.project_id = item.project_id
          AND previous.task_id = item.task_id
          AND previous.revision = item.previous_revision
         JOIN "QingLong3TaskDefinitionRevisions" AS disabled
           ON disabled.project_id = item.project_id
          AND disabled.task_id = item.task_id
          AND disabled.revision = item.disabled_revision
         WHERE item.event_digest = ?
         ORDER BY item.task_id COLLATE BINARY`,
      )
      .all(receipt.eventDigest) as Row[];
    const withdrawals = rows.map((row) =>
      Object.freeze({
        taskId: text(row, 'taskId'),
        previousRevision: integer(row, 'previousRevision'),
        disabledRevision: integer(row, 'disabledRevision'),
        previousContentDigest: text(row, 'previousContentDigest'),
        disabledContentDigest: text(row, 'disabledContentDigest'),
      }),
    );
    if (
      rows.some(
        (row) =>
          text(row, 'projectId') !== receipt.target.projectId ||
          text(row, 'previousContentDigest') !==
            text(row, 'storedPreviousContentDigest') ||
          text(row, 'disabledContentDigest') !==
            text(row, 'storedDisabledContentDigest'),
      ) ||
      !same(withdrawals, receipt.capability.taskWithdrawals)
    ) {
      throw new PluginPackageQuarantineUnavailableError();
    }
    if (receipt.capability.status === 'not_active') return;
    const snapshotRow = this.#authority.client
      .prepare(
        `SELECT snapshot_json AS "snapshotJson"
         FROM "QingLong3ProjectToolDefinitionSnapshots"
         WHERE project_id = ? AND active_vector_digest = ?
           AND snapshot_digest = ?`,
      )
      .get(
        receipt.target.projectId,
        receipt.capability.currentActiveVectorDigest,
        receipt.capability.currentToolSnapshotDigest,
      ) as Row | undefined;
    if (!snapshotRow) {
      throw new PluginPackageQuarantineUnavailableError();
    }
    try {
      const snapshot = normalizeProjectToolDefinitionSnapshot(
        json(snapshotRow, 'snapshotJson') as ProjectToolDefinitionSnapshot,
      );
      if (
        snapshot.sources.length !== receipt.capability.retainedSourceCount ||
        snapshot.sources.some(
          (source) =>
            source.packageName === receipt.target.packageName &&
            source.lockDigest === receipt.target.lockDigest,
        )
      ) {
        throw new PluginPackageQuarantineUnavailableError();
      }
    } catch (error) {
      if (error instanceof PluginPackageQuarantineUnavailableError) throw error;
      throw new PluginPackageQuarantineUnavailableError();
    }
  }

  #findStored(
    eventDigest: string,
  ): Readonly<PluginPackageWithdrawalReceipt> | null {
    const event = this.#eventByDigest(eventDigest);
    if (!event) return null;
    const receipt = this.#receiptByEvent(event);
    if (!receipt) {
      throw new PluginPackageQuarantineUnavailableError();
    }
    return receipt;
  }

  findTargetsByLockDigest(
    lockDigest: string,
  ): Promise<readonly Readonly<PluginPackageQuarantineTarget>[]> {
    if (typeof lockDigest !== 'string' || !/^[0-9a-f]{64}$/.test(lockDigest)) {
      throw new InvalidPluginPackageQuarantineError('lockDigest is invalid');
    }
    return this.#enqueue(() => {
      const rows = this.#authority.client
        .prepare(
          `SELECT record_json AS "recordJson"
           FROM "QingLong3PluginPackageInstalls"
           WHERE lock_digest = ?
             AND state IN ('queued','staged','activating','active')
           ORDER BY project_id, package_name, installation_id
           LIMIT ?`,
        )
        .all(lockDigest, this.#activeSourceLimit + 1) as Row[];
      if (rows.length > this.#activeSourceLimit) {
        throw new PluginPackageQuarantineConflictError(
          'matching install targets exceed the local Profile limit',
        );
      }
      try {
        return Object.freeze(
          rows.map((row) => {
            const record = normalizePluginPackageInstallRecord(
              json(row, 'recordJson') as PluginPackageInstallRecord,
            );
            return Object.freeze({
              projectId: record.projectId,
              packageName: record.packageName,
              installationId: record.installationId,
              lockDigest: record.lockDigest,
              installState:
                record.state as PluginPackageQuarantineTarget['installState'],
              installVersion: record.version,
              installRecordDigest: record.recordDigest,
              activeLockDigest: record.activeLockDigest,
            });
          }),
        );
      } catch (error) {
        if (
          error instanceof PluginPackageQuarantineConflictError ||
          error instanceof PluginPackageQuarantineUnavailableError
        ) {
          throw error;
        }
        throw new PluginPackageQuarantineUnavailableError();
      }
    });
  }

  findByEventDigest(
    eventDigest: string,
  ): Promise<Readonly<PluginPackageWithdrawalReceipt> | null> {
    if (
      typeof eventDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(eventDigest)
    ) {
      throw new InvalidPluginPackageQuarantineError('eventDigest is invalid');
    }
    return this.#enqueue(() => this.#findStored(eventDigest));
  }

  #install(
    event: Readonly<PluginPackageQuarantineEvent>,
  ): Readonly<PluginPackageInstallRecord> {
    const row = this.#authority.client
      .prepare(
        `SELECT record_json AS "recordJson"
         FROM "QingLong3PluginPackageInstalls"
         WHERE installation_id = ?`,
      )
      .get(event.target.installationId) as Row | undefined;
    if (!row) {
      throw new PluginPackageQuarantineConflictError(
        'target install is absent',
      );
    }
    let record: Readonly<PluginPackageInstallRecord>;
    try {
      record = normalizePluginPackageInstallRecord(
        json(row, 'recordJson') as PluginPackageInstallRecord,
      );
    } catch (error) {
      if (error instanceof PluginPackageQuarantineUnavailableError) throw error;
      throw new PluginPackageQuarantineUnavailableError();
    }
    if (
      record.projectId !== event.target.projectId ||
      record.packageName !== event.target.packageName ||
      record.lockDigest !== event.target.lockDigest ||
      record.state !== event.target.installState ||
      record.version !== event.target.installVersion ||
      record.recordDigest !== event.target.installRecordDigest ||
      record.activeLockDigest !== event.target.activeLockDigest
    ) {
      throw new PluginPackageQuarantineConflictError(
        'target install advanced or drifted',
      );
    }
    return record;
  }

  #activeContributions(
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
         WHERE head.project_id = ?
           AND head_install.active_lock_digest IS NOT NULL
           AND active_install.state = 'active'
           AND quarantine.event_digest IS NULL
         ORDER BY head.package_name COLLATE BINARY
         LIMIT ?`,
      )
      .all(projectId, this.#activeSourceLimit + 1) as Row[];
    if (rows.length > this.#activeSourceLimit) {
      throw new PluginPackageQuarantineConflictError(
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
      if (error instanceof PluginPackageQuarantineUnavailableError) throw error;
      throw new PluginPackageQuarantineUnavailableError();
    }
  }

  #enabledOwnedTasks(
    event: Readonly<PluginPackageQuarantineEvent>,
  ): readonly Readonly<TaskDefinitionRecord>[] {
    const rows = this.#authority.client
      .prepare(
        `SELECT head.project_id AS "projectId",
                head.task_id AS "taskId",
                revision.revision AS "revision",
                revision.mutation_id AS "mutationId",
                revision.name AS "name",
                revision.description AS "description",
                revision.kind AS "kind",
                revision.spec_json AS "specJson",
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
         WHERE ownership.project_id = ?
           AND ownership.package_name = ?
           AND revision.enabled = 1
         ORDER BY ownership.task_id COLLATE BINARY
         LIMIT ?`,
      )
      .all(
        event.target.projectId,
        event.target.packageName,
        MAX_PLUGIN_PACKAGE_QUARANTINE_TASK_WITHDRAWALS + 1,
      ) as Row[];
    if (rows.length > MAX_PLUGIN_PACKAGE_QUARANTINE_TASK_WITHDRAWALS) {
      throw new PluginPackageQuarantineConflictError(
        'owned Tasks exceed the quarantine withdrawal limit',
      );
    }
    return Object.freeze(rows.map(taskRecord));
  }

  #appendDisabledTask(
    event: Readonly<PluginPackageQuarantineEvent>,
    current: Readonly<TaskDefinitionRecord>,
    committedAtMs: number,
  ): Readonly<PluginPackageQuarantineTaskWithdrawal> {
    const disabled = createTaskDefinitionRecord(
      {
        projectId: current.projectId,
        taskId: current.taskId,
        expectedRevision: current.revision,
        mutationId: pluginPackageQuarantineTaskMutationId(
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
        enabled: false,
        occurredAtMs: committedAtMs,
      },
      current.createdAtMs,
    );
    this.#authority.client
      .prepare(
        `INSERT INTO "QingLong3TaskDefinitionRevisions" (
           project_id, task_id, revision, mutation_id, name, description,
           kind, spec_json, labels_json, enabled, content_digest, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        disabled.projectId,
        disabled.taskId,
        disabled.revision,
        disabled.mutationId,
        disabled.name,
        disabled.description ?? null,
        disabled.kind,
        JSON.stringify(disabled.spec),
        JSON.stringify(disabled.labels),
        disabled.contentDigest,
        disabled.updatedAtMs,
      );
    const update = this.#authority.client
      .prepare(
        `UPDATE "QingLong3TaskDefinitions"
         SET current_revision = ?, updated_at_ms = ?
         WHERE project_id = ? AND task_id = ? AND current_revision = ?`,
      )
      .run(
        disabled.revision,
        disabled.updatedAtMs,
        disabled.projectId,
        disabled.taskId,
        current.revision,
      );
    if (update.changes !== 1) {
      throw new PluginPackageQuarantineConflictError(
        'TaskDefinition head changed during quarantine',
      );
    }
    return Object.freeze({
      taskId: current.taskId,
      previousRevision: current.revision,
      disabledRevision: disabled.revision,
      previousContentDigest: current.contentDigest,
      disabledContentDigest: disabled.contentDigest,
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
      const insertSource = this.#authority.client.prepare(
        `INSERT INTO "QingLong3ProjectToolDefinitionSnapshotSources" (
           project_id, active_vector_digest, package_name, installation_id,
           generation, generation_digest, lock_digest, revision_digest
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const source of snapshot.sources) {
        insertSource.run(
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
      throw new PluginPackageQuarantineConflictError(
        'active vector is bound to another Tool snapshot',
      );
    }
  }

  #insertEvent(event: Readonly<PluginPackageQuarantineEvent>): void {
    this.#authority.client
      .prepare(
        `INSERT INTO "QingLong3PluginPackageQuarantineEvents" (
           event_digest, mutation_id, revocation_receipt_digest, impact_digest,
           project_id, package_name, installation_id, lock_digest,
           install_state, install_version, install_record_digest,
           active_lock_digest, proposer_type, proposer_id, confirmer_type,
           confirmer_id, authorization_mode, reason_code, occurred_at_ms,
           event_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventDigest,
        event.mutationId,
        event.revocationReceiptDigest,
        event.impactDigest,
        event.target.projectId,
        event.target.packageName,
        event.target.installationId,
        event.target.lockDigest,
        event.target.installState,
        event.target.installVersion,
        event.target.installRecordDigest,
        event.target.activeLockDigest,
        event.proposer.type,
        event.proposer.id,
        event.confirmer.type,
        event.confirmer.id,
        event.authorizationMode,
        event.reasonCode,
        event.occurredAtMs,
        JSON.stringify(event),
      );
  }

  #insertReceipt(receipt: Readonly<PluginPackageWithdrawalReceipt>): void {
    const capability = receipt.capability;
    this.#authority.client
      .prepare(
        `INSERT INTO "QingLong3PluginPackageWithdrawalReceipts" (
           event_digest, receipt_digest, project_id, capability_status,
           task_count, previous_active_vector_digest,
           current_active_vector_digest, current_tool_snapshot_digest,
           retained_source_count, committed_at_ms, receipt_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.eventDigest,
        receipt.receiptDigest,
        receipt.target.projectId,
        capability.status,
        capability.taskWithdrawals.length,
        capability.previousActiveVectorDigest,
        capability.currentActiveVectorDigest,
        capability.currentToolSnapshotDigest,
        capability.retainedSourceCount,
        receipt.committedAtMs,
        JSON.stringify(receipt),
      );
    const insertTask = this.#authority.client.prepare(
      `INSERT INTO "QingLong3PluginPackageWithdrawalTasks" (
         event_digest, project_id, task_id, previous_revision,
         disabled_revision, previous_content_digest, disabled_content_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const task of capability.taskWithdrawals) {
      insertTask.run(
        receipt.eventDigest,
        receipt.target.projectId,
        task.taskId,
        task.previousRevision,
        task.disabledRevision,
        task.previousContentDigest,
        task.disabledContentDigest,
      );
    }
  }

  quarantine(
    eventValue: Readonly<PluginPackageQuarantineEvent>,
    confirmAuthorization: () => void | Promise<void>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackageWithdrawalReceipt>;
    }>
  > {
    const event = normalizePluginPackageQuarantineEvent(eventValue);
    if (typeof confirmAuthorization !== 'function') {
      throw new InvalidPluginPackageQuarantineError(
        'confirmAuthorization is invalid',
      );
    }
    return this.#enqueue(async () => {
      const client = this.#authority.client;
      client.exec('BEGIN IMMEDIATE');
      try {
        await confirmAuthorization();
        const existingEvent = this.#eventByDigest(event.eventDigest);
        if (existingEvent) {
          if (!same(existingEvent, event)) {
            throw new PluginPackageQuarantineConflictError(
              'event digest is bound to another quarantine',
            );
          }
          const receipt = this.#receiptByEvent(existingEvent);
          if (!receipt) {
            throw new PluginPackageQuarantineUnavailableError();
          }
          await confirmAuthorization();
          client.exec('COMMIT');
          return Object.freeze({
            status: 'existing' as const,
            receipt,
          });
        }
        const targetEvent = client
          .prepare(
            `SELECT event_digest AS "eventDigest"
             FROM "QingLong3PluginPackageQuarantineEvents"
             WHERE project_id = ? AND package_name = ?
               AND installation_id = ? AND lock_digest = ?`,
          )
          .get(
            event.target.projectId,
            event.target.packageName,
            event.target.installationId,
            event.target.lockDigest,
          ) as Row | undefined;
        if (targetEvent) {
          throw new PluginPackageQuarantineConflictError(
            'target lock is already quarantined by another event',
          );
        }
        this.#install(event);
        const clock = client
          .prepare(
            `SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS "nowMs"`,
          )
          .get() as Row;
        const committedAtMs = Math.max(
          integer(clock, 'nowMs'),
          event.occurredAtMs,
        );
        if (event.target.installState !== 'active') {
          this.#insertEvent(event);
          const receipt = createPluginPackageWithdrawalReceipt({
            eventDigest: event.eventDigest,
            target: event.target,
            capability: {
              status: 'not_active',
              taskWithdrawals: [],
              previousActiveVectorDigest: null,
              currentActiveVectorDigest: null,
              currentToolSnapshotDigest: null,
              retainedSourceCount: 0,
            },
            committedAtMs,
          });
          this.#insertReceipt(receipt);
          await confirmAuthorization();
          client.exec('COMMIT');
          return Object.freeze({
            status: 'created' as const,
            receipt,
          });
        }

        const previousContributions = this.#activeContributions(
          event.target.projectId,
        );
        const targetIndex = previousContributions.findIndex(
          ({ generation }) =>
            generation.packageName === event.target.packageName &&
            generation.installationId === event.target.installationId &&
            generation.lockDigest === event.target.lockDigest,
        );
        if (targetIndex < 0) {
          throw new PluginPackageQuarantineConflictError(
            'active target is not a complete Tool source',
          );
        }
        const previousSources = Object.freeze(
          previousContributions.map(activeSource),
        );
        const retainedContributions = Object.freeze(
          previousContributions.filter((_, index) => index !== targetIndex),
        );
        const snapshot = createProjectToolDefinitionSnapshot({
          projectId: event.target.projectId,
          contributions: retainedContributions,
        });
        const tasks = this.#enabledOwnedTasks(event);
        const taskWithdrawals = Object.freeze(
          tasks.map((task) =>
            this.#appendDisabledTask(event, task, committedAtMs),
          ),
        );
        this.#insertEvent(event);
        this.#publishSnapshot(snapshot, committedAtMs);
        const receipt = createPluginPackageWithdrawalReceipt({
          eventDigest: event.eventDigest,
          target: event.target,
          capability: {
            status: 'withdrawn',
            taskWithdrawals,
            previousActiveVectorDigest: projectToolDefinitionActiveVectorDigest(
              event.target.projectId,
              previousSources,
            ),
            currentActiveVectorDigest: snapshot.activeVectorDigest,
            currentToolSnapshotDigest: snapshot.snapshotDigest,
            retainedSourceCount: snapshot.sources.length,
          },
          committedAtMs,
        });
        this.#insertReceipt(receipt);
        await confirmAuthorization();
        client.exec('COMMIT');
        return Object.freeze({
          status: 'created' as const,
          receipt,
        });
      } catch (error) {
        if (client.isTransaction) client.exec('ROLLBACK');
        throw error;
      }
    });
  }
}
