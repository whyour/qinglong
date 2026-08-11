// PostgreSQL adapter owned by the Plugin Package lifecycle capability.
import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryable,
} from '@qinglong/runtime-core';
import {
  InvalidPluginPackageQuarantineError,
  MAX_PLUGIN_PACKAGE_QUARANTINE_RETAINED_SOURCES,
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

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredBoolean,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../../repository/definitionRepositorySupport';
import { isPostgresAvailabilityError } from '../../connection/pool';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresQueryable, 'query'>;

export const CLUSTER_PLUGIN_PACKAGE_QUARANTINE_TARGET_LIMIT = 128;

function unavailable(
  cause?: unknown,
): PluginPackageQuarantineUnavailableError {
  return new PluginPackageQuarantineUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
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
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackageQuarantineConflictError(
      'durable quarantine identity or target state conflicts',
    );
  }
  return unavailable(error);
}

function recordJson(row: Row, key: string): Readonly<Record<string, unknown>> {
  return postgresRequiredJsonObject(row[key], unavailable);
}

function integer(row: Row, key: string): number {
  const value = postgresRequiredInteger(row[key], unavailable);
  if (value < 0) throw unavailable();
  return value;
}

function text(row: Row, key: string): string {
  return postgresRequiredString(row[key], unavailable);
}

function taskRecord(row: Row): Readonly<TaskDefinitionRecord> {
  try {
    const description = row.description;
    if (description !== null && typeof description !== 'string') {
      throw unavailable();
    }
    return normalizeTaskDefinitionRecord({
      projectId: text(row, 'projectId'),
      taskId: text(row, 'taskId'),
      revision: integer(row, 'revision'),
      mutationId: text(row, 'mutationId'),
      name: text(row, 'name'),
      ...(description === null ? {} : { description }),
      kind: text(row, 'kind') as TaskDefinitionRecord['kind'],
      spec: recordJson(
        row,
        'specJson',
      ) as unknown as TaskDefinitionRecord['spec'],
      labels: recordJson(row, 'labelsJson') as TaskDefinitionRecord['labels'],
      enabled: postgresRequiredBoolean(row.enabled, unavailable),
      contentDigest: text(row, 'contentDigest'),
      createdAtMs: integer(row, 'createdAtMs'),
      updatedAtMs: integer(row, 'updatedAtMs'),
    });
  } catch (error) {
    if (error instanceof PluginPackageQuarantineUnavailableError) throw error;
    throw unavailable(error);
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

export class PostgresPluginPackageQuarantineRepository
  implements PluginPackageQuarantineRepository
{
  readonly #registry: TaskSpecSemanticRegistry;

  constructor(
    private readonly pool: PostgresPool,
    options: Readonly<{ registry?: TaskSpecSemanticRegistry }> = {},
  ) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL Plugin Package quarantine repository is invalid',
      );
    }
    const registry =
      options.registry ?? createBuiltInTaskSpecSemanticRegistry();
    if (!(registry instanceof TaskSpecSemanticRegistry)) {
      throw new TypeError('TaskSpec semantic registry is invalid');
    }
    this.#registry = registry;
  }

  async #eventByDigest(
    queryable: Queryable,
    eventDigest: string,
  ): Promise<Readonly<PluginPackageQuarantineEvent> | null> {
    const result = await queryable.query<Row>(
      `SELECT event_json AS "eventJson"
       FROM "ql3"."plugin_package_quarantine_events"
       WHERE event_digest = $1
       LIMIT 2`,
      [eventDigest],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw unavailable();
    try {
      return normalizePluginPackageQuarantineEvent(
        recordJson(result.rows[0]!, 'eventJson') as unknown as
          PluginPackageQuarantineEvent,
      );
    } catch (error) {
      if (error instanceof PluginPackageQuarantineUnavailableError) {
        throw error;
      }
      throw unavailable(error);
    }
  }

  async #receiptByEvent(
    queryable: Queryable,
    event: Readonly<PluginPackageQuarantineEvent>,
  ): Promise<Readonly<PluginPackageWithdrawalReceipt> | null> {
    const result = await queryable.query<Row>(
      `SELECT receipt_json AS "receiptJson"
       FROM "ql3"."plugin_package_withdrawal_receipts"
       WHERE event_digest = $1
       LIMIT 2`,
      [event.eventDigest],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw unavailable();
    try {
      const receipt = normalizePluginPackageWithdrawalReceipt(
        recordJson(result.rows[0]!, 'receiptJson') as unknown as
          PluginPackageWithdrawalReceipt,
      );
      assertPluginPackageWithdrawalMatchesEvent(event, receipt);
      await this.#assertReceiptRelations(queryable, receipt);
      return receipt;
    } catch (error) {
      if (error instanceof PluginPackageQuarantineUnavailableError) {
        throw error;
      }
      throw unavailable(error);
    }
  }

  async #assertReceiptRelations(
    queryable: Queryable,
    receipt: Readonly<PluginPackageWithdrawalReceipt>,
  ): Promise<void> {
    const tasks = await queryable.query<Row>(
      `SELECT
         item.project_id AS "projectId",
         item.task_id AS "taskId",
         item.previous_revision AS "previousRevision",
         item.disabled_revision AS "disabledRevision",
         item.previous_content_digest AS "previousContentDigest",
         item.disabled_content_digest AS "disabledContentDigest",
         previous.content_digest AS "storedPreviousContentDigest",
         disabled.content_digest AS "storedDisabledContentDigest"
       FROM "ql3"."plugin_package_withdrawal_tasks" AS item
       JOIN "ql3"."task_definition_revisions" AS previous
         ON previous.project_id = item.project_id
        AND previous.task_id = item.task_id
        AND previous.revision = item.previous_revision
       JOIN "ql3"."task_definition_revisions" AS disabled
         ON disabled.project_id = item.project_id
        AND disabled.task_id = item.task_id
        AND disabled.revision = item.disabled_revision
       WHERE item.event_digest = $1
       ORDER BY item.task_id`,
      [receipt.eventDigest],
    );
    const withdrawals = Object.freeze(
      tasks.rows.map((row) =>
        Object.freeze({
          taskId: text(row, 'taskId'),
          previousRevision: integer(row, 'previousRevision'),
          disabledRevision: integer(row, 'disabledRevision'),
          previousContentDigest: text(row, 'previousContentDigest'),
          disabledContentDigest: text(row, 'disabledContentDigest'),
        }),
      ),
    );
    if (
      tasks.rows.some(
        (row) =>
          text(row, 'projectId') !== receipt.target.projectId ||
          text(row, 'previousContentDigest') !==
            text(row, 'storedPreviousContentDigest') ||
          text(row, 'disabledContentDigest') !==
            text(row, 'storedDisabledContentDigest'),
      ) ||
      !same(withdrawals, receipt.capability.taskWithdrawals)
    ) {
      throw unavailable();
    }
    if (receipt.capability.status === 'not_active') return;
    const snapshots = await queryable.query<Row>(
      `SELECT snapshot_json AS "snapshotJson"
       FROM "ql3"."project_tool_definition_snapshots"
       WHERE project_id = $1 AND active_vector_digest = $2
         AND snapshot_digest = $3
       LIMIT 2`,
      [
        receipt.target.projectId,
        receipt.capability.currentActiveVectorDigest,
        receipt.capability.currentToolSnapshotDigest,
      ],
    );
    if (snapshots.rows.length !== 1) throw unavailable();
    try {
      const snapshot = normalizeProjectToolDefinitionSnapshot(
        recordJson(snapshots.rows[0]!, 'snapshotJson') as unknown as
          ProjectToolDefinitionSnapshot,
      );
      if (
        snapshot.sources.length !== receipt.capability.retainedSourceCount ||
        snapshot.sources.some(
          (source) =>
            source.packageName === receipt.target.packageName &&
            source.installationId === receipt.target.installationId &&
            source.lockDigest === receipt.target.lockDigest,
        )
      ) {
        throw unavailable();
      }
    } catch (error) {
      if (error instanceof PluginPackageQuarantineUnavailableError) {
        throw error;
      }
      throw unavailable(error);
    }
  }

  async #findStored(
    queryable: Queryable,
    eventDigest: string,
  ): Promise<Readonly<PluginPackageWithdrawalReceipt> | null> {
    const event = await this.#eventByDigest(queryable, eventDigest);
    if (!event) return null;
    const receipt = await this.#receiptByEvent(queryable, event);
    if (!receipt) throw unavailable();
    return receipt;
  }

  async findTargetsByLockDigest(
    lockDigest: string,
  ): Promise<readonly Readonly<PluginPackageQuarantineTarget>[]> {
    if (typeof lockDigest !== 'string' || !/^[0-9a-f]{64}$/.test(lockDigest)) {
      throw new InvalidPluginPackageQuarantineError('lockDigest is invalid');
    }
    try {
      const result = await this.pool.query<Row>(
        `SELECT record_json AS "recordJson"
         FROM "ql3"."plugin_package_installs"
         WHERE lock_digest = $1
           AND state IN ('queued', 'staged', 'activating', 'active')
         ORDER BY project_id, package_name, installation_id
         LIMIT $2`,
        [lockDigest, CLUSTER_PLUGIN_PACKAGE_QUARANTINE_TARGET_LIMIT + 1],
      );
      if (
        result.rows.length > CLUSTER_PLUGIN_PACKAGE_QUARANTINE_TARGET_LIMIT
      ) {
        throw new PluginPackageQuarantineConflictError(
          'matching install targets exceed the Cluster limit',
        );
      }
      return Object.freeze(
        result.rows.map((row) => {
          const record = normalizePluginPackageInstallRecord(
            recordJson(row, 'recordJson') as unknown as
              PluginPackageInstallRecord,
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
      throw mapStorageError(error);
    }
  }

  async findByEventDigest(
    eventDigest: string,
  ): Promise<Readonly<PluginPackageWithdrawalReceipt> | null> {
    if (
      typeof eventDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(eventDigest)
    ) {
      throw new InvalidPluginPackageQuarantineError('eventDigest is invalid');
    }
    try {
      return await this.#findStored(this.pool, eventDigest);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async #install(
    queryable: Queryable,
    event: Readonly<PluginPackageQuarantineEvent>,
  ): Promise<Readonly<PluginPackageInstallRecord>> {
    const result = await queryable.query<Row>(
      `SELECT record_json AS "recordJson"
       FROM "ql3"."plugin_package_installs"
       WHERE installation_id = $1
       LIMIT 2`,
      [event.target.installationId],
    );
    if (result.rows.length !== 1) {
      throw new PluginPackageQuarantineConflictError(
        'target install is absent',
      );
    }
    let record: Readonly<PluginPackageInstallRecord>;
    try {
      record = normalizePluginPackageInstallRecord(
        recordJson(result.rows[0]!, 'recordJson') as unknown as
          PluginPackageInstallRecord,
      );
    } catch (error) {
      if (error instanceof PluginPackageQuarantineUnavailableError) {
        throw error;
      }
      throw unavailable(error);
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

  async #activeContributions(
    queryable: Queryable,
    projectId: string,
  ): Promise<
    readonly Readonly<ProjectToolDefinitionSnapshotContribution>[]
  > {
    const result = await queryable.query<Row>(
      `SELECT revision.revision_json AS "revisionJson"
       FROM "ql3"."plugin_package_install_heads" AS head
       JOIN "ql3"."plugin_package_installs" AS head_install
         ON head_install.installation_id = head.installation_id
       JOIN "ql3"."plugin_package_installs" AS active_install
         ON active_install.project_id = head.project_id
        AND active_install.package_name = head.package_name
        AND active_install.lock_digest = head_install.active_lock_digest
       JOIN "ql3"."plugin_package_materialized_revisions" AS revision
         ON revision.project_id = active_install.project_id
        AND revision.package_name = active_install.package_name
        AND revision.generation = active_install.target_generation
        AND revision.lock_digest = active_install.lock_digest
       LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
         ON quarantine.project_id = active_install.project_id
        AND quarantine.package_name = active_install.package_name
        AND quarantine.installation_id = active_install.installation_id
        AND quarantine.lock_digest = active_install.lock_digest
       WHERE head.project_id = $1
         AND head_install.active_lock_digest IS NOT NULL
         AND active_install.state = 'active'
         AND quarantine.event_digest IS NULL
       ORDER BY head.package_name
       LIMIT $2`,
      [projectId, MAX_PLUGIN_PACKAGE_QUARANTINE_RETAINED_SOURCES + 2],
    );
    if (
      result.rows.length >
      MAX_PLUGIN_PACKAGE_QUARANTINE_RETAINED_SOURCES + 1
    ) {
      throw new PluginPackageQuarantineConflictError(
        'active Package sources exceed the Cluster quarantine limit',
      );
    }
    try {
      return Object.freeze(
        result.rows.map((row) =>
          projectToolDefinitionSnapshotContribution(
            recordJson(row, 'revisionJson') as never,
            this.#registry,
          ),
        ),
      );
    } catch (error) {
      if (error instanceof PluginPackageQuarantineUnavailableError) {
        throw error;
      }
      throw unavailable(error);
    }
  }

  async #enabledOwnedTasks(
    queryable: Queryable,
    event: Readonly<PluginPackageQuarantineEvent>,
  ): Promise<readonly Readonly<TaskDefinitionRecord>[]> {
    const result = await queryable.query<Row>(
      `SELECT
         head.project_id AS "projectId",
         head.task_id AS "taskId",
         revision.revision,
         revision.mutation_id::text AS "mutationId",
         revision.name,
         revision.description,
         revision.kind,
         revision.spec_json AS "specJson",
         revision.labels_json AS "labelsJson",
         revision.enabled,
         revision.content_digest AS "contentDigest",
         head.created_at_ms AS "createdAtMs",
         revision.created_at_ms AS "updatedAtMs"
       FROM "ql3"."plugin_package_task_ownerships" AS ownership
       JOIN "ql3"."task_definitions" AS head
         ON head.project_id = ownership.project_id
        AND head.task_id = ownership.task_id
       JOIN "ql3"."task_definition_revisions" AS revision
         ON revision.project_id = head.project_id
        AND revision.task_id = head.task_id
        AND revision.revision = head.current_revision
       WHERE ownership.project_id = $1
         AND ownership.package_name = $2
         AND revision.enabled = true
       ORDER BY ownership.task_id
       LIMIT $3`,
      [
        event.target.projectId,
        event.target.packageName,
        MAX_PLUGIN_PACKAGE_QUARANTINE_TASK_WITHDRAWALS + 1,
      ],
    );
    if (
      result.rows.length > MAX_PLUGIN_PACKAGE_QUARANTINE_TASK_WITHDRAWALS
    ) {
      throw new PluginPackageQuarantineConflictError(
        'owned Tasks exceed the quarantine withdrawal limit',
      );
    }
    return Object.freeze(result.rows.map(taskRecord));
  }

  #disabledTask(
    event: Readonly<PluginPackageQuarantineEvent>,
    current: Readonly<TaskDefinitionRecord>,
    committedAtMs: number,
  ): Readonly<{
    disabled: Readonly<TaskDefinitionRecord>;
    withdrawal: Readonly<PluginPackageQuarantineTaskWithdrawal>;
  }> {
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
    return Object.freeze({
      disabled,
      withdrawal: Object.freeze({
        taskId: current.taskId,
        previousRevision: current.revision,
        disabledRevision: disabled.revision,
        previousContentDigest: current.contentDigest,
        disabledContentDigest: disabled.contentDigest,
      }),
    });
  }

  async #databaseNowMs(queryable: Queryable): Promise<number> {
    const result = await queryable.query<Row>(
      `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
         AS "nowMs"`,
    );
    if (result.rows.length !== 1) throw unavailable();
    return integer(result.rows[0]!, 'nowMs');
  }

  async #commit(
    client: PostgresClient,
    event: Readonly<PluginPackageQuarantineEvent>,
  ): Promise<
    Readonly<{
      created: boolean;
      receipt: Readonly<PluginPackageWithdrawalReceipt>;
    }>
  > {
    const existingEvent = await this.#eventByDigest(client, event.eventDigest);
    if (existingEvent) {
      if (!same(existingEvent, event)) {
        throw new PluginPackageQuarantineConflictError(
          'event digest is bound to another quarantine',
        );
      }
      const existingReceipt = await this.#receiptByEvent(
        client,
        existingEvent,
      );
      if (!existingReceipt) throw unavailable();
      return Object.freeze({ created: false, receipt: existingReceipt });
    }
    await this.#install(client, event);
    const committedAtMs = Math.max(
      await this.#databaseNowMs(client),
      event.occurredAtMs,
    );
    let snapshot: Readonly<ProjectToolDefinitionSnapshot> | null = null;
    let taskWrites: readonly Readonly<{
      disabled: Readonly<TaskDefinitionRecord>;
      withdrawal: Readonly<PluginPackageQuarantineTaskWithdrawal>;
    }>[] = Object.freeze([]);
    let receipt: Readonly<PluginPackageWithdrawalReceipt>;

    if (event.target.installState !== 'active') {
      receipt = createPluginPackageWithdrawalReceipt({
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
    } else {
      const previousContributions = await this.#activeContributions(
        client,
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
      snapshot = createProjectToolDefinitionSnapshot({
        projectId: event.target.projectId,
        contributions: retainedContributions,
      });
      const tasks = await this.#enabledOwnedTasks(client, event);
      taskWrites = Object.freeze(
        tasks.map((task) => this.#disabledTask(event, task, committedAtMs)),
      );
      receipt = createPluginPackageWithdrawalReceipt({
        eventDigest: event.eventDigest,
        target: event.target,
        capability: {
          status: 'withdrawn',
          taskWithdrawals: taskWrites.map(({ withdrawal }) => withdrawal),
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
    }

    const committed = await client.query<Row>(
      `SELECT "ql3"."commit_plugin_package_quarantine"(
         $1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb
       ) AS "created"`,
      [
        JSON.stringify(event),
        JSON.stringify(receipt),
        JSON.stringify(taskWrites),
        JSON.stringify(snapshot),
      ],
    );
    if (
      committed.rows.length !== 1 ||
      typeof committed.rows[0]?.created !== 'boolean'
    ) {
      throw unavailable();
    }
    const stored = await this.#findStored(client, event.eventDigest);
    if (!stored || !same(stored, receipt)) throw unavailable();
    return Object.freeze({
      created: committed.rows[0].created,
      receipt: stored,
    });
  }

  async quarantine(
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

    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        if (attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS) continue;
        throw unavailable(error);
      }
      let began = false;
      let authorizationFailure = false;
      const authorize = async (): Promise<void> => {
        try {
          await confirmAuthorization();
        } catch (error) {
          authorizationFailure = true;
          throw error;
        }
      };
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        await authorize();
        const result = await this.#commit(client, event);
        await authorize();
        await client.query('COMMIT');
        began = false;
        return Object.freeze({
          status: result.created ? 'created' : 'existing',
          receipt: result.receipt,
        });
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        if (authorizationFailure) throw error;
        const state = postgresSqlState(error);
        if (
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS &&
          (isPostgresAvailabilityError(error) ||
            !state ||
            POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) ||
            state.startsWith('08'))
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
