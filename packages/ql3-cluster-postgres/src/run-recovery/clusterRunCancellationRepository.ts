// PostgreSQL authority adapter for cluster run cancellation requests.
import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  ClusterRunCancellationFenceRejectedError,
  ClusterRunCancellationNotFoundError,
  ClusterRunCancellationUnavailableError,
  InvalidClusterRunCancellationError,
  normalizeClusterRunCancellationCommand,
  normalizeClusterRunCancellationResult,
  type ClusterRunCancellationAllowedRole,
  type ClusterRunCancellationCommand,
  type ClusterRunCancellationRepository,
  type ClusterRunCancellationResult,
} from '@qinglong/runtime-core/cluster-run-cancellation';
import { RUN_STATUSES, type RunStatus } from '@qinglong/runtime-core';

type Row = Record<string, unknown>;

const ALLOWED_ROLES = new Set<ClusterRunCancellationAllowedRole>([
  'owner',
  'admin',
  'operator',
]);
const TERMINAL = new Set<RunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
const CANCEL_REASONS = new Set([
  'user',
  'policy',
  'shutdown',
  'reconcile',
  'timeout',
]);

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new TypeError(`PostgreSQL Run cancellation ${key} is invalid`);
  }
  return value;
}

function integer(row: Row, key: string): number {
  const raw = row[key];
  const value = typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw)
    ? Number(raw)
    : raw;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(`PostgreSQL Run cancellation ${key} is invalid`);
  }
  return value;
}

function optionalInteger(row: Row, key: string): number | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : integer(row, key);
}

function optionalText(row: Row, key: string): string | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : text(row, key);
}

function runStatus(row: Row): RunStatus {
  const value = text(row, 'runStatus') as RunStatus;
  if (!RUN_STATUSES.includes(value)) {
    throw new TypeError('PostgreSQL Run cancellation status is invalid');
  }
  return value;
}

function cancellationResult(
  status: ClusterRunCancellationResult['status'],
  command: Readonly<ClusterRunCancellationCommand>,
  row: Row,
): Readonly<ClusterRunCancellationResult> {
  const cancelRequestedAtMs = optionalInteger(row, 'cancelRequestedAtMs');
  const cancelReason = optionalText(row, 'cancelReason');
  if (
    (cancelRequestedAtMs === undefined) !== (cancelReason === undefined) ||
    (cancelReason !== undefined && !CANCEL_REASONS.has(cancelReason))
  ) {
    throw new TypeError('PostgreSQL Run cancellation intent is invalid');
  }
  return normalizeClusterRunCancellationResult({
    status,
    projectId: command.projectId,
    runId: command.runId,
    runStatus: runStatus(row),
    runVersion: integer(row, 'runVersion'),
    eventSequence: integer(row, 'eventSequence'),
    ...(cancelRequestedAtMs === undefined
      ? {}
      : {
          cancelRequestedAtMs,
          cancelReason: cancelReason as NonNullable<
            ClusterRunCancellationResult['cancelReason']
          >,
        }),
  });
}

async function begin(client: PostgresClient): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
    '5000ms',
  ]);
  await client.query(`SELECT set_config('lock_timeout', $1, true)`, ['1000ms']);
  await client.query(
    `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
    ['10000ms'],
  );
}

async function databaseNow(client: PostgresClient): Promise<number> {
  const result = await client.query<Row>(`
    SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS "nowMs"
  `);
  if (result.rows.length !== 1) {
    throw new TypeError('PostgreSQL Run cancellation clock is invalid');
  }
  return integer(result.rows[0]!, 'nowMs');
}

async function rollback(client: PostgresClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the primary transaction failure.
  }
}

export class PostgresClusterRunCancellationRepository
  implements ClusterRunCancellationRepository {
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL Run cancellation pool is invalid');
    }
  }

  async requestUserCancellation(
    value: Readonly<ClusterRunCancellationCommand>,
  ): Promise<Readonly<ClusterRunCancellationResult>> {
    const command = normalizeClusterRunCancellationCommand(value);
    return this.transaction(async (client) => {
      const project = await client.query<Row>(`
        SELECT status AS "projectStatus", version AS "projectVersion"
        FROM "ql3"."projects" WHERE id = $1 FOR UPDATE
      `, [command.projectId]);
      if (project.rows.length === 0) {
        throw new ClusterRunCancellationNotFoundError();
      }
      if (project.rows.length !== 1) {
        throw new TypeError('PostgreSQL Run cancellation Project is invalid');
      }
      const binding = await client.query<Row>(`
        SELECT version AS "bindingVersion", state AS "bindingState",
               role AS "bindingRole"
        FROM "ql3"."project_role_bindings"
        WHERE project_id = $1 AND subject_type = $2 AND subject_id = $3
        ORDER BY version DESC LIMIT 1
      `, [
        command.projectId,
        command.subject.type,
        command.subject.id,
      ]);
      const currentProject = project.rows[0]!;
      const currentBinding = binding.rows[0];
      if (
        text(currentProject, 'projectStatus') !== 'active' ||
        integer(currentProject, 'projectVersion') !==
          command.policyFence.projectVersion ||
        !currentBinding ||
        integer(currentBinding, 'bindingVersion') !==
          command.policyFence.bindingVersion ||
        text(currentBinding, 'bindingState') !== 'active' ||
        !ALLOWED_ROLES.has(
          text(currentBinding, 'bindingRole') as ClusterRunCancellationAllowedRole,
        )
      ) {
        throw new ClusterRunCancellationFenceRejectedError(
          'authorization_changed',
        );
      }

      const run = await client.query<Row>(`
        SELECT project_id AS "projectId", status AS "runStatus",
               version AS "runVersion", event_sequence AS "eventSequence",
               cancel_requested_at_ms AS "cancelRequestedAtMs",
               cancel_reason AS "cancelReason"
        FROM "ql3"."runs" WHERE id = $1 FOR UPDATE
      `, [command.runId]);
      if (run.rows.length === 0 || run.rows[0]?.projectId !== command.projectId) {
        throw new ClusterRunCancellationNotFoundError();
      }
      if (run.rows.length !== 1) {
        throw new TypeError('PostgreSQL Run cancellation Run is invalid');
      }
      if (command.workflowTarget) {
        const admission = await client.query<Row>(`
          SELECT project_id AS "projectId", package_name AS "packageName",
                 workflow_id AS "workflowId"
          FROM "ql3"."plugin_package_workflow_admissions"
          WHERE run_id = $1
        `, [command.runId]);
        const target = admission.rows[0];
        if (
          admission.rows.length !== 1 ||
          !target ||
          text(target, 'projectId') !== command.projectId ||
          text(target, 'packageName') !== command.workflowTarget.packageName ||
          text(target, 'workflowId') !== command.workflowTarget.workflowId
        ) {
          throw new ClusterRunCancellationNotFoundError();
        }
      }
      const current = run.rows[0]!;
      const currentStatus = runStatus(current);
      if (TERMINAL.has(currentStatus)) {
        return cancellationResult('already_terminal', command, current);
      }
      if (optionalInteger(current, 'cancelRequestedAtMs') !== undefined) {
        return cancellationResult('already_requested', command, current);
      }
      if (optionalText(current, 'cancelReason') !== undefined) {
        throw new TypeError('PostgreSQL Run cancellation intent is invalid');
      }

      const runVersion = integer(current, 'runVersion');
      const eventSequence = integer(current, 'eventSequence');
      if (runVersion >= 2_147_483_647 || eventSequence >= 2_147_483_647) {
        throw new TypeError('PostgreSQL Run cancellation counter overflowed');
      }
      const observedAtMs = await databaseNow(client);
      const updated = await client.query<Row>(`
        UPDATE "ql3"."runs"
        SET cancel_requested_at_ms = $2, cancel_reason = 'user',
            version = $3, event_sequence = $4
        WHERE id = $1 AND version = $5 AND cancel_requested_at_ms IS NULL
        RETURNING project_id AS "projectId", status AS "runStatus",
                  version AS "runVersion", event_sequence AS "eventSequence",
                  cancel_requested_at_ms AS "cancelRequestedAtMs",
                  cancel_reason AS "cancelReason"
      `, [
        command.runId,
        observedAtMs,
        runVersion + 1,
        eventSequence + 1,
        runVersion,
      ]);
      if (updated.rows.length !== 1) {
        throw new ClusterRunCancellationFenceRejectedError('state_mismatch');
      }
      await client.query(`
        INSERT INTO "ql3"."run_events" (
          id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
          attempt_id, step_run_id, payload, created_at_ms
        ) VALUES ($1, $2, $3, 'run.cancel_requested', $4, $5, $6,
          NULL, NULL, $7::jsonb, $8)
      `, [
        command.eventId,
        command.runId,
        eventSequence + 1,
        `user-cancel:${command.mutationId}`,
        command.subject.type,
        command.subject.id,
        JSON.stringify({
          reason: 'user',
          mutation_id: command.mutationId,
          policy_fence: {
            project_version: command.policyFence.projectVersion,
            binding_version: command.policyFence.bindingVersion,
          },
        }),
        observedAtMs,
      ]);
      return cancellationResult('accepted', command, updated.rows[0]!);
    });
  }

  private async transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new ClusterRunCancellationUnavailableError({ cause: error });
    }
    try {
      await begin(client);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollback(client);
      if (
        error instanceof InvalidClusterRunCancellationError ||
        error instanceof ClusterRunCancellationNotFoundError ||
        error instanceof ClusterRunCancellationFenceRejectedError
      ) {
        throw error;
      }
      throw new ClusterRunCancellationUnavailableError({ cause: error });
    } finally {
      client.release();
    }
  }
}
